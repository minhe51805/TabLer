use super::MongoDbDriver;
use crate::database::models::*;
use anyhow::{Context, Result};
use mongodb::bson::{doc, Bson, Document};
use mongodb::Cursor;
use serde_json::{json, Value as JsonValue};
use std::sync::atomic::Ordering;

/// Profiler sampling helpers. MongoDB has no SQL, so the live trace and Top
/// Queries tabs cannot reuse the shared probe-`sql` path; these map MongoDB's
/// native diagnostics (`$currentOp`, `system.profile`) onto the same canonical
/// column contract the SQL engines emit, so the frontend renders both alike.
impl MongoDbDriver {
    /// Build the `$currentOp` pipeline. `all_users` toggles cluster-wide
    /// visibility (needs the `inprog` privilege / an Atlas tier that allows it)
    /// versus only the connected user's own operations.
    pub(super) fn current_op_pipeline(all_users: bool) -> Vec<Document> {
        vec![
            doc! { "$currentOp": {
                "allUsers": all_users,
                "idleConnections": false,
                "idleSessions": false
            } },
            doc! { "$match": { "active": true } },
        ]
    }

    /// True when a `$currentOp` failure is the deployment rejecting the
    /// `allUsers` argument (shared Atlas tiers surface Atlas error code 8000
    /// "arg=allUsers isn't allowed in this atlas tier"), which we recover from
    /// by sampling only the current user's operations. Matched case-insensitively
    /// so a future change to the message's casing does not silently disable the
    /// fallback and bring the per-poll error back.
    pub(super) fn is_all_users_rejected(error: &mongodb::error::Error) -> bool {
        error.to_string().to_ascii_lowercase().contains("allusers")
    }

    /// Open a `$currentOp` cursor on `admin`, preferring cluster-wide
    /// visibility. If the deployment rejects `allUsers`, cache that and retry
    /// scoped to the current user's own operations so the live trace keeps
    /// working (with a narrower scope) instead of erroring out on every poll.
    pub(super) async fn current_op_cursor(&self) -> Result<Cursor<Document>> {
        let admin = self.client.database("admin");
        if self.current_op_all_users.load(Ordering::Relaxed) {
            match admin.aggregate(Self::current_op_pipeline(true)).await {
                Ok(cursor) => return Ok(cursor),
                Err(error) if Self::is_all_users_rejected(&error) => {
                    // Downgrade once: this deployment only allows own-op sampling.
                    self.current_op_all_users.store(false, Ordering::Relaxed);
                }
                Err(error) => {
                    return Err(error)
                        .context("Failed to sample MongoDB active operations via $currentOp");
                }
            }
        }
        admin
            .aggregate(Self::current_op_pipeline(false))
            .await
            .context("Failed to sample MongoDB active operations via $currentOp")
    }

    /// Report whether database profiling is active for `database`. MongoDB's
    /// `{ profile: -1 }` command returns `{ was: <level> }` where level 0 means
    /// profiling is off (so `system.profile` is never populated) and 1/2 record
    /// slow/all operations. Returns `false` only when we can confirm it is off;
    /// if the status cannot be read we assume it is on so we never show a
    /// misleading "profiling disabled" hint on a transient error.
    pub(super) async fn profiling_enabled(&self, database: &str) -> bool {
        match self
            .client
            .database(database)
            .run_command(doc! { "profile": -1 })
            .await
        {
            Ok(status) => Self::bson_to_i64(status.get("was")) != 0,
            Err(_) => true,
        }
    }

    /// Build the canonical column metadata for a profiler result. The exact
    /// per-column type is irrelevant to the profiler tables (they read by name),
    /// so a single permissive descriptor keeps this contract in one place.
    pub(super) fn profiler_column_info(names: &[&str]) -> Vec<ColumnInfo> {
        names
            .iter()
            .map(|name| ColumnInfo {
                name: (*name).to_string(),
                data_type: "mixed".to_string(),
                is_nullable: true,
                is_primary_key: false,
                max_length: None,
                default_value: None,
            })
            .collect()
    }

    /// Wrap canonical rows in the same `QueryResult` shape the SQL probes return.
    pub(super) fn canonical_result(
        column_names: &[&str],
        rows: Vec<Vec<JsonValue>>,
        query: String,
        elapsed: u128,
        truncated: bool,
    ) -> QueryResult {
        QueryResult {
            columns: Self::profiler_column_info(column_names),
            rows,
            affected_rows: 0,
            execution_time_ms: elapsed,
            query,
            sandboxed: false,
            truncated,
        }
    }

    /// True when a `$currentOp` document describes an aggregation that itself
    /// runs `$currentOp` — i.e. the profiler's own sampler — so it can be
    /// excluded from the trace it produces.
    pub(super) fn command_is_current_op(command: &Document) -> bool {
        command
            .get_array("pipeline")
            .ok()
            .and_then(|stages| stages.first())
            .and_then(|stage| stage.as_document())
            .map(|stage| stage.contains_key("$currentOp"))
            .unwrap_or(false)
    }

    /// Stringify a scalar BSON value (opid can be an int, long, or string).
    pub(super) fn bson_scalar_to_string(value: &Bson) -> String {
        match value {
            Bson::String(text) => text.clone(),
            Bson::Int32(number) => number.to_string(),
            Bson::Int64(number) => number.to_string(),
            Bson::Double(number) => number.to_string(),
            other => Self::bson_to_json(other.clone()).to_string(),
        }
    }

    /// Compact JSON rendering of a BSON document, used for the statement text.
    pub(super) fn document_to_compact_json(document: &Document) -> String {
        Self::bson_to_json(Bson::Document(document.clone())).to_string()
    }

    pub(super) fn bson_to_i64(value: Option<&Bson>) -> i64 {
        match value {
            Some(Bson::Int32(number)) => i64::from(*number),
            Some(Bson::Int64(number)) => *number,
            Some(Bson::Double(number)) => *number as i64,
            _ => 0,
        }
    }

    pub(super) fn bson_to_f64(value: Option<&Bson>) -> f64 {
        match value {
            Some(Bson::Int32(number)) => f64::from(*number),
            Some(Bson::Int64(number)) => *number as f64,
            Some(Bson::Double(number)) => *number,
            _ => 0.0,
        }
    }

    pub(super) fn round2(value: f64) -> f64 {
        (value * 100.0).round() / 100.0
    }

    /// Map one `$currentOp` document to a canonical live-trace row, or drop it
    /// (returns `None`) when it is the profiler's own sampler.
    pub(super) fn current_op_to_row(op: Document) -> Option<Vec<JsonValue>> {
        if let Ok(command) = op.get_document("command") {
            if command.contains_key("currentOp") || Self::command_is_current_op(command) {
                return None;
            }
        }

        let session_id = op
            .get("opid")
            .map(Self::bson_scalar_to_string)
            .or_else(|| op.get_str("desc").ok().map(str::to_string))
            .unwrap_or_default();
        let ns = op.get_str("ns").unwrap_or("").to_string();
        let db_name = ns.split('.').next().unwrap_or("").to_string();
        let username = op
            .get_array("effectiveUsers")
            .ok()
            .and_then(|users| users.first())
            .and_then(|user| user.as_document())
            .and_then(|user| user.get_str("user").ok())
            .unwrap_or("")
            .to_string();
        let application = op.get_str("appName").unwrap_or("").to_string();
        let client_addr = op
            .get_str("client")
            .or_else(|_| op.get_str("client_s"))
            .unwrap_or("")
            .to_string();
        let op_type = op.get_str("op").unwrap_or("").to_string();
        let wait_event = if op.get_bool("waitingForLock").unwrap_or(false) {
            "waiting_for_lock".to_string()
        } else {
            String::new()
        };
        let micros_running = Self::bson_to_i64(op.get("microsecs_running"));
        let duration_ms = if micros_running > 0 {
            micros_running / 1000
        } else {
            Self::bson_to_i64(op.get("secs_running")) * 1000
        };
        let query_text = match op.get_document("command") {
            Ok(command) => Self::document_to_compact_json(command),
            Err(_) => format!("{op_type} {ns}").trim().to_string(),
        };

        Some(vec![
            json!(session_id),
            json!(db_name),
            json!(username),
            json!(application),
            json!(client_addr),
            json!(op_type),
            json!(wait_event),
            json!(duration_ms),
            json!(query_text),
        ])
    }

    /// Map one `system.profile` aggregation group to a canonical top-queries row,
    /// dropping internal `.system.` namespaces.
    pub(super) fn profile_group_to_row(group: Document) -> Option<Vec<JsonValue>> {
        let id = group.get_document("_id").ok();
        let op_type = id
            .and_then(|doc| doc.get_str("op").ok())
            .unwrap_or("")
            .to_string();
        let ns = id
            .and_then(|doc| doc.get_str("ns").ok())
            .unwrap_or("")
            .to_string();
        if ns.contains(".system.") {
            return None;
        }
        let calls = Self::bson_to_i64(group.get("calls"));
        let total_ms = Self::bson_to_f64(group.get("total_ms"));
        let rows = Self::bson_to_i64(group.get("rows"));
        let mean_ms = if calls > 0 {
            total_ms / calls as f64
        } else {
            0.0
        };
        let query_text = format!("{op_type} {ns}").trim().to_string();

        Some(vec![
            json!(query_text),
            json!(calls),
            json!(Self::round2(total_ms)),
            json!(Self::round2(mean_ms)),
            json!(rows),
        ])
    }
}
