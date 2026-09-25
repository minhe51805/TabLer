//! Google Cloud Spanner driver over the REST API (`spanner.googleapis.com`).
//!
//! Auth is a Google OAuth2 access token carried in the connection password
//! field and sent as `Authorization: Bearer <token>`. The host field carries
//! the instance resource path `projects/<p>/instances/<i>`; the database field
//! carries the database id. Queries run through lazily-created Spanner
//! sessions (`POST {database}/sessions` then `POST {session}:executeSql`).
//! Deleting the session aborts its in-flight statements, which is how
//! `cancel_query_request` reaches the server.
//!
//! Only the GoogleSQL dialect is supported (backtick identifiers,
//! `@param` binds, `INFORMATION_SCHEMA` in GoogleSQL shape).

use super::driver::DatabaseDriver;
use super::models::*;
use super::query_cancel::{request_cancel, CancelLookup, CancelScopeGuard, QueryCancelRegistry};
use super::query_common::{statement_returns_rows, MAX_QUERY_RESULT_ROWS};
use super::safety::{
    normalize_order_dir, quote_bigquery_identifier, quote_bigquery_order_by,
    sanitize_bigquery_filter_clause,
};
use crate::utils::sql::split_sql_statements;
use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use reqwest::{Client, RequestBuilder};
use serde_json::{json, Map, Value as JsonValue};
use std::collections::HashSet;
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Instant;
use tokio::sync::RwLock as AsyncRwLock;

const SPANNER_API_BASE: &str = "https://spanner.googleapis.com";
/// `updateDatabaseDdl` returns a long-running operation; poll it briefly so
/// schema edits report success/failure instead of "operation started".
const DDL_POLL_ATTEMPTS: u32 = 120;
const DDL_POLL_INTERVAL_MS: u64 = 1_000;

/// Marker error for HTTP 404 `Session not found` responses so the execute
/// path can recreate the session once and retry instead of failing.
#[derive(Debug)]
struct SessionNotFound;

impl fmt::Display for SessionNotFound {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Spanner session not found")
    }
}

impl std::error::Error for SessionNotFound {}

fn is_session_not_found(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| cause.is::<SessionNotFound>())
}

/// Live Spanner session bound to the database path it was created on.
struct SpannerSession {
    database_path: String,
    name: String,
}

/// An open read-write transaction: the session it was begun on, the
/// transaction id, and the database path it is bound to.
struct SpannerTxn {
    session_name: String,
    transaction_id: String,
    database_path: String,
}

/// Positional `@pN` binds accumulated while building one statement.
#[derive(Default)]
struct SpannerBinds {
    params: Map<String, JsonValue>,
    param_types: Map<String, JsonValue>,
    next_index: usize,
}

impl SpannerBinds {
    /// Bind `value` as `@pN` and return the placeholder text for the SQL.
    fn push(&mut self, value: &JsonValue) -> Result<String> {
        self.next_index += 1;
        let name = format!("p{}", self.next_index);
        let (bound, code) = SpannerDriver::spanner_bind_value(value)?;
        self.params.insert(name.clone(), bound);
        self.param_types
            .insert(name.clone(), json!({ "code": code }));
        Ok(format!("@{name}"))
    }

    fn is_empty(&self) -> bool {
        self.params.is_empty()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StatementKind {
    Query,
    Dml,
    Ddl,
    Other,
}

pub struct SpannerDriver {
    client: Client,
    base_url: String,
    access_token: String,
    /// `projects/<p>/instances/<i>` from the host field.
    instance_path: String,
    /// `projects/<p>/instances/<i>/databases/<d>` for the current database.
    database_path: RwLock<String>,
    current_db: Arc<RwLock<Option<String>>>,
    /// Lazily-created session; `None` until the first query or after a
    /// cancel/disconnect deletes it server-side.
    session: AsyncRwLock<Option<SpannerSession>>,
    /// request_id → running-query scope so `cancel_query_request` can delete
    /// the session while a statement is in flight.
    cancel_registry: RwLock<QueryCancelRegistry>,
}

impl SpannerDriver {
    pub async fn connect(config: &ConnectionConfig) -> Result<Self> {
        let access_token = config
            .password
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .context("Spanner requires a Google OAuth2 access token in the password field")?
            .to_string();
        let instance_path = config
            .host
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .context("Spanner host must be the instance path projects/<p>/instances/<i>")?;
        let database = config
            .database
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .context("Spanner database name is required")?;
        let instance_path = instance_path.trim_matches('/').to_string();
        if !instance_path.starts_with("projects/") || !instance_path.contains("/instances/") {
            return Err(anyhow!(
                "Spanner host must be the instance path projects/<p>/instances/<i>"
            ));
        }
        let database_path = format!("{instance_path}/databases/{}", database.trim());
        // Standard emulator override: SPANNER_EMULATOR_HOST points the REST
        // calls at a local emulator instead of spanner.googleapis.com.
        let base_url = std::env::var("SPANNER_EMULATOR_HOST")
            .ok()
            .map(|value| value.trim().trim_end_matches('/').to_string())
            .filter(|value| !value.is_empty())
            .map(|value| {
                if value.starts_with("http://") || value.starts_with("https://") {
                    value
                } else {
                    format!("http://{value}")
                }
            })
            .unwrap_or_else(|| SPANNER_API_BASE.to_string());

        Ok(Self {
            client: Client::builder()
                .build()
                .context("Failed to initialize Spanner HTTP client")?,
            base_url,
            access_token,
            instance_path,
            database_path: RwLock::new(database_path),
            current_db: Arc::new(RwLock::new(Some(database.to_string()))),
            session: AsyncRwLock::new(None),
            cancel_registry: RwLock::new(QueryCancelRegistry::new()),
        })
    }

    fn sessions_url(base_url: &str, database_path: &str) -> String {
        format!("{base_url}/v1/{database_path}/sessions")
    }

    fn execute_sql_url(base_url: &str, session_name: &str) -> String {
        format!("{base_url}/v1/{session_name}:executeSql")
    }

    fn update_ddl_url(base_url: &str, database_path: &str) -> String {
        format!("{base_url}/v1/{database_path}/ddl")
    }

    fn databases_url(base_url: &str, instance_path: &str) -> String {
        format!("{base_url}/v1/{instance_path}/databases")
    }

    fn session_delete_url(base_url: &str, session_name: &str) -> String {
        format!("{base_url}/v1/{session_name}")
    }

    fn operation_url(base_url: &str, operation_name: &str) -> String {
        format!("{base_url}/v1/{operation_name}")
    }

    fn database_url(base_url: &str, database_path: &str) -> String {
        format!("{base_url}/v1/{database_path}")
    }

    fn begin_transaction_url(base_url: &str, session_name: &str) -> String {
        format!("{base_url}/v1/{session_name}:beginTransaction")
    }

    fn commit_url(base_url: &str, session_name: &str) -> String {
        format!("{base_url}/v1/{session_name}:commit")
    }

    fn rollback_url(base_url: &str, session_name: &str) -> String {
        format!("{base_url}/v1/{session_name}:rollback")
    }

    fn current_database_path(&self) -> Result<String> {
        self.database_path
            .read()
            .map(|guard| guard.clone())
            .map_err(|_| anyhow!("Failed to access Spanner database state"))
    }

    /// Resolve the database path for one call: `None` uses the current
    /// database, an override builds `…/databases/<name>` after validation.
    fn database_path_for(&self, database: Option<&str>) -> Result<String> {
        match database.map(str::trim).filter(|value| !value.is_empty()) {
            Some(name) => {
                Self::validate_database_name(name)?;
                Ok(format!("{}/databases/{name}", self.instance_path))
            }
            None => self.current_database_path(),
        }
    }

    /// Spanner database ids become URL path segments; reject anything that
    /// could escape the resource path or break the request.
    fn validate_database_name(name: &str) -> Result<()> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err(anyhow!("Spanner database name cannot be empty"));
        }
        if trimmed
            .chars()
            .any(|ch| matches!(ch, '/' | '\\' | '\0' | '\r' | '\n' | '\t' | ' '))
        {
            return Err(anyhow!("Spanner database name contains invalid characters"));
        }
        Ok(())
    }

    /// Send one authenticated request and decode the JSON body. Non-2xx
    /// responses surface the Spanner `error.message` payload; a 404 whose body
    /// reports a missing session maps to [`SessionNotFound`] so callers can
    /// recreate and retry.
    async fn send_checked(&self, request: RequestBuilder) -> Result<JsonValue> {
        let response = request
            .bearer_auth(&self.access_token)
            .send()
            .await
            .context("Failed to reach Spanner endpoint")?;
        let status = response.status();
        let body = response
            .text()
            .await
            .context("Failed to read Spanner response")?;

        if !status.is_success() {
            let message = serde_json::from_str::<JsonValue>(&body)
                .ok()
                .and_then(|value| {
                    value
                        .get("error")
                        .and_then(|error| error.get("message"))
                        .and_then(|message| message.as_str())
                        .map(str::to_string)
                })
                .unwrap_or_else(|| body.trim().to_string());
            if status.as_u16() == 404 && message.to_ascii_lowercase().contains("session not found")
            {
                return Err(SessionNotFound.into());
            }
            bail!(
                "Spanner request failed with status {}: {}",
                status.as_u16(),
                message
            );
        }

        if body.trim().is_empty() {
            return Ok(JsonValue::Null);
        }
        serde_json::from_str(&body).context("Failed to parse Spanner JSON response")
    }

    /// Return the stored session for `database_path`, creating one when absent
    /// or bound to a different database.
    async fn ensure_session(&self, database_path: &str) -> Result<String> {
        {
            let guard = self.session.read().await;
            if let Some(session) = guard.as_ref() {
                if session.database_path == database_path {
                    return Ok(session.name.clone());
                }
            }
        }

        let mut guard = self.session.write().await;
        if let Some(session) = guard.as_ref() {
            if session.database_path == database_path {
                return Ok(session.name.clone());
            }
        }

        let url = Self::sessions_url(&self.base_url, database_path);
        let response = self
            .send_checked(self.client.post(&url).json(&json!({})))
            .await
            .context("Failed to create Spanner session")?;
        let name = response
            .get("name")
            .and_then(|value| value.as_str())
            .map(str::to_string)
            .context("Spanner session response did not include a session name")?;
        *guard = Some(SpannerSession {
            database_path: database_path.to_string(),
            name: name.clone(),
        });
        Ok(name)
    }

    /// Clear the stored session only when it still holds `expected`, so a
    /// retry never drops a session another caller just created.
    async fn drop_session_if(&self, expected: &str) {
        let mut guard = self.session.write().await;
        if guard
            .as_ref()
            .is_some_and(|session| session.name == expected)
        {
            *guard = None;
        }
    }

    /// DELETE the stored session. Returns whether a session existed; a
    /// server-side 404 is treated as already gone.
    async fn delete_session(&self) -> Result<bool> {
        let session = self.session.write().await.take();
        let Some(session) = session else {
            return Ok(false);
        };
        let result = self
            .send_checked(
                self.client
                    .delete(Self::session_delete_url(&self.base_url, &session.name)),
            )
            .await;
        match result {
            Ok(_) => Ok(true),
            Err(error) if is_session_not_found(&error) => Ok(true),
            Err(error) => Err(error).context("Failed to delete Spanner session"),
        }
    }

    /// Build the `executeSql` request body. `transaction` overrides the
    /// default single-use read-write selector DML statements get; `query_mode`
    /// maps to the REST `queryMode` field (`PLAN`/`PROFILE` for EXPLAIN).
    fn execute_sql_body(
        sql: &str,
        binds: Option<&SpannerBinds>,
        transaction: Option<JsonValue>,
        query_mode: Option<&str>,
    ) -> JsonValue {
        let mut body = json!({ "sql": sql });
        if let Some(transaction) = transaction {
            body["transaction"] = transaction;
        } else if Self::statement_kind(sql) == StatementKind::Dml {
            // DML must run inside a read-write transaction; singleUse commits
            // the statement on success.
            body["transaction"] = json!({ "singleUse": { "readWrite": {} } });
        }
        if let Some(binds) = binds.filter(|binds| !binds.is_empty()) {
            body["params"] = JsonValue::Object(binds.params.clone());
            body["paramTypes"] = JsonValue::Object(binds.param_types.clone());
        }
        if let Some(query_mode) = query_mode {
            body["queryMode"] = json!(query_mode);
        }
        body
    }

    /// One `executeSql` call against an already-resolved session, returning
    /// the raw `ResultSet` JSON.
    async fn execute_sql_request(
        &self,
        session_name: &str,
        sql: &str,
        binds: Option<&SpannerBinds>,
        transaction: Option<JsonValue>,
        query_mode: Option<&str>,
    ) -> Result<JsonValue> {
        let body = Self::execute_sql_body(sql, binds, transaction, query_mode);
        self.send_checked(
            self.client
                .post(Self::execute_sql_url(&self.base_url, session_name))
                .json(&body),
        )
        .await
    }

    /// One `executeSql` call against an already-resolved session.
    async fn execute_sql_on(
        &self,
        session_name: &str,
        sql: &str,
        binds: Option<&SpannerBinds>,
        row_cap: usize,
    ) -> Result<QueryResult> {
        let started = Instant::now();
        let response = self
            .execute_sql_request(session_name, sql, binds, None, None)
            .await?;
        Ok(Self::result_from_execute_sql(
            response,
            started.elapsed().as_millis(),
            sql.to_string(),
            row_cap,
        ))
    }

    /// `executeSql` with one session-not-found retry: the stored session is
    /// dropped, recreated, and the statement sent once more. When the cancel
    /// flag is set the session was deleted by `cancel_query_request`, so the
    /// query must not be resurrected.
    async fn execute_sql_with_retry(
        &self,
        sql: &str,
        binds: Option<&SpannerBinds>,
        database: Option<&str>,
        cancel_flag: Option<&AtomicBool>,
        row_cap: usize,
    ) -> Result<QueryResult> {
        let database_path = self.database_path_for(database)?;
        let session_name = self.ensure_session(&database_path).await?;
        match self
            .execute_sql_on(&session_name, sql, binds, row_cap)
            .await
        {
            Ok(result) => Ok(result),
            Err(error) if is_session_not_found(&error) => {
                if cancel_flag.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
                    return Err(anyhow!("Query cancelled."));
                }
                self.drop_session_if(&session_name).await;
                let session_name = self.ensure_session(&database_path).await?;
                if cancel_flag.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
                    return Err(anyhow!("Query cancelled."));
                }
                self.execute_sql_on(&session_name, sql, binds, row_cap)
                    .await
            }
            Err(error) => Err(error),
        }
    }

    async fn execute_sql(
        &self,
        sql: &str,
        binds: Option<&SpannerBinds>,
        database: Option<&str>,
    ) -> Result<QueryResult> {
        self.execute_sql_with_retry(sql, binds, database, None, MAX_QUERY_RESULT_ROWS)
            .await
    }

    /// Run DDL through `updateDatabaseDdl` and poll the returned operation
    /// until it resolves so callers see the real outcome.
    async fn execute_ddl(&self, statements: &[String]) -> Result<()> {
        let database_path = self.current_database_path()?;
        let url = Self::update_ddl_url(&self.base_url, &database_path);
        let response = self
            .send_checked(
                self.client
                    .post(&url)
                    .json(&json!({ "statements": statements })),
            )
            .await
            .context("Spanner DDL request failed")?;

        let Some(operation_name) = response
            .get("name")
            .and_then(|value| value.as_str())
            .map(str::to_string)
        else {
            // Synchronous completion (no operation handle): nothing to poll.
            return Ok(());
        };

        for attempt in 0..DDL_POLL_ATTEMPTS {
            if attempt > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(DDL_POLL_INTERVAL_MS)).await;
            }
            let operation = self
                .send_checked(
                    self.client
                        .get(Self::operation_url(&self.base_url, &operation_name)),
                )
                .await
                .context("Failed to poll Spanner DDL operation")?;
            if operation
                .get("done")
                .and_then(|value| value.as_bool())
                .unwrap_or(false)
            {
                if let Some(error) = operation.get("error") {
                    let message = error
                        .get("message")
                        .and_then(|value| value.as_str())
                        .unwrap_or("unknown error");
                    bail!("Spanner DDL operation failed: {message}");
                }
                return Ok(());
            }
        }
        bail!("Spanner DDL operation did not finish within the polling window")
    }

    /// `POST {session}:beginTransaction` with `readWrite` options; returns the
    /// transaction id.
    async fn begin_txn_on(&self, session_name: &str) -> Result<String> {
        let response = self
            .send_checked(
                self.client
                    .post(Self::begin_transaction_url(&self.base_url, session_name))
                    .json(&json!({ "options": { "readWrite": {} } })),
            )
            .await
            .context("Failed to begin Spanner transaction")?;
        response
            .get("id")
            .and_then(|value| value.as_str())
            .map(str::to_string)
            .context("Spanner beginTransaction response did not include a transaction id")
    }

    /// Begin a read-write transaction on the current (or overridden)
    /// database, recreating the session once when the stored one is stale —
    /// same retry contract as the execute path.
    async fn begin_read_write_txn(&self, database: Option<&str>) -> Result<SpannerTxn> {
        let database_path = self.database_path_for(database)?;
        let session_name = self.ensure_session(&database_path).await?;
        let transaction_id = match self.begin_txn_on(&session_name).await {
            Ok(id) => id,
            Err(error) if is_session_not_found(&error) => {
                self.drop_session_if(&session_name).await;
                let session_name = self.ensure_session(&database_path).await?;
                return Ok(SpannerTxn {
                    transaction_id: self.begin_txn_on(&session_name).await?,
                    session_name,
                    database_path,
                });
            }
            Err(error) => return Err(error),
        };
        Ok(SpannerTxn {
            transaction_id,
            session_name,
            database_path,
        })
    }

    /// One `executeSql` call pinned to an open transaction.
    async fn execute_sql_in_txn(
        &self,
        txn: &SpannerTxn,
        sql: &str,
        binds: Option<&SpannerBinds>,
    ) -> Result<QueryResult> {
        let started = Instant::now();
        let response = self
            .execute_sql_request(
                &txn.session_name,
                sql,
                binds,
                Some(json!({ "id": txn.transaction_id })),
                None,
            )
            .await?;
        Ok(Self::result_from_execute_sql(
            response,
            started.elapsed().as_millis(),
            sql.to_string(),
            MAX_QUERY_RESULT_ROWS,
        ))
    }

    /// `POST {session}:commit` for the transaction. The response's
    /// `commitTimestamp` is not needed by callers.
    async fn commit_txn(&self, txn: &SpannerTxn) -> Result<()> {
        self.send_checked(
            self.client
                .post(Self::commit_url(&self.base_url, &txn.session_name))
                .json(&json!({ "transactionId": txn.transaction_id })),
        )
        .await
        .context("Failed to commit Spanner transaction")?;
        Ok(())
    }

    /// `POST {session}:rollback`; rollback failures are logged, never raised,
    /// so the original error stays the one the caller sees.
    async fn rollback_txn(&self, txn: &SpannerTxn) {
        if let Err(error) = self
            .send_checked(
                self.client
                    .post(Self::rollback_url(&self.base_url, &txn.session_name))
                    .json(&json!({ "transactionId": txn.transaction_id })),
            )
            .await
        {
            log::warn!("Spanner transaction rollback failed: {error:#}");
        }
    }

    /// Strip a leading `EXPLAIN`/`EXPLAIN ANALYZE` prefix (comments and
    /// whitespace tolerated) so the inner statement can run with
    /// `queryMode=PLAN`/`PROFILE`. Returns `(inner_sql, analyze)` or `None`
    /// when the statement is not an EXPLAIN.
    fn strip_explain_prefix(sql: &str) -> Option<(&str, bool)> {
        let mut rest = sql.trim_start();
        loop {
            if let Some(after) = rest.strip_prefix("--") {
                rest = after.split_once('\n').map(|(_, tail)| tail).unwrap_or("");
                rest = rest.trim_start();
                continue;
            }
            if let Some(after) = rest.strip_prefix('#') {
                rest = after.split_once('\n').map(|(_, tail)| tail).unwrap_or("");
                rest = rest.trim_start();
                continue;
            }
            if let Some(after) = rest.strip_prefix("/*") {
                rest = match after.find("*/") {
                    Some(end) => &after[end + 2..],
                    None => "",
                };
                rest = rest.trim_start();
                continue;
            }
            break;
        }
        let head = rest.get(..7)?;
        if !head.eq_ignore_ascii_case("EXPLAIN") {
            return None;
        }
        let after = &rest[7..];
        if !after.starts_with(|ch: char| ch.is_whitespace() || ch == '(') {
            return None;
        }
        let mut inner = after.trim_start();
        let mut analyze = false;
        // Tolerate a Postgres-style option list: EXPLAIN (ANALYZE, COSTS) …
        if let Some(options) = inner.strip_prefix('(') {
            if let Some(close) = options.find(')') {
                if options[..close]
                    .split(|ch: char| !(ch.is_alphanumeric() || ch == '_'))
                    .any(|word| word.eq_ignore_ascii_case("ANALYZE"))
                {
                    analyze = true;
                }
                inner = options[close + 1..].trim_start();
            }
        }
        if let Some(head) = inner.get(..7) {
            if head.eq_ignore_ascii_case("ANALYZE") {
                let tail = &inner[7..];
                if tail.starts_with(|ch: char| ch.is_whitespace()) {
                    analyze = true;
                    inner = tail.trim_start();
                }
            }
        }
        if inner.is_empty() {
            return None;
        }
        Some((inner, analyze))
    }

    /// Run an `EXPLAIN` statement: Spanner has no EXPLAIN keyword — the plan
    /// comes from `executeSql` with `queryMode=PLAN` (or `PROFILE` for
    /// `EXPLAIN ANALYZE`, which also executes). The plan lands in
    /// `stats.queryPlan` and is returned as a single-row JSON result.
    async fn execute_explain(
        &self,
        inner_sql: &str,
        analyze: bool,
        cancel_flag: Option<&AtomicBool>,
    ) -> Result<QueryResult> {
        let database_path = self.current_database_path()?;
        let session_name = self.ensure_session(&database_path).await?;
        let query_mode = if analyze { "PROFILE" } else { "PLAN" };
        let started = Instant::now();
        let response = match self
            .execute_sql_request(&session_name, inner_sql, None, None, Some(query_mode))
            .await
        {
            Ok(response) => response,
            Err(error) if is_session_not_found(&error) => {
                if cancel_flag.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
                    return Err(anyhow!("Query cancelled."));
                }
                self.drop_session_if(&session_name).await;
                let session_name = self.ensure_session(&database_path).await?;
                if cancel_flag.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
                    return Err(anyhow!("Query cancelled."));
                }
                self.execute_sql_request(&session_name, inner_sql, None, None, Some(query_mode))
                    .await?
            }
            Err(error) => return Err(error),
        };
        Ok(Self::explain_result_from_execute_sql(
            response,
            started.elapsed().as_millis(),
            inner_sql,
        ))
    }

    /// Shape a `PLAN`/`PROFILE` `executeSql` response into a single-row
    /// `QueryResult`: the `stats` object carries `queryPlan` (and
    /// `queryStats` under PROFILE) and is serialized as the plan cell.
    fn explain_result_from_execute_sql(
        response: JsonValue,
        elapsed_ms: u128,
        query: &str,
    ) -> QueryResult {
        let stats = response.get("stats").cloned().unwrap_or_else(|| json!({}));
        let plan_text = serde_json::to_string_pretty(&stats).unwrap_or_else(|_| stats.to_string());
        QueryResult {
            columns: vec![ColumnInfo {
                name: "query_plan".to_string(),
                data_type: "JSON".to_string(),
                is_nullable: true,
                is_primary_key: false,
                max_length: None,
                default_value: None,
            }],
            rows: vec![vec![JsonValue::String(plan_text)]],
            affected_rows: 0,
            execution_time_ms: elapsed_ms,
            query: query.to_string(),
            sandboxed: false,
            truncated: false,
        }
    }

    /// Build the UPDATE DML for one cell edit; shared by `update_table_cell`
    /// and the atomic edit queue.
    fn build_cell_update(request: &TableCellUpdateRequest) -> Result<(String, SpannerBinds)> {
        if request.primary_keys.is_empty() {
            return Err(anyhow!(
                "Inline update requires at least one primary key column"
            ));
        }

        let mut binds = SpannerBinds::default();
        let target = quote_bigquery_order_by(&request.target_column)?;
        let set_value = if request.value.is_null() {
            "NULL".to_string()
        } else {
            binds.push(&request.value)?
        };

        let mut conditions = Vec::new();
        for primary_key in &request.primary_keys {
            let column = quote_bigquery_order_by(&primary_key.column)?;
            if primary_key.value.is_null() {
                conditions.push(format!("{column} IS NULL"));
            } else {
                conditions.push(format!("{column} = {}", binds.push(&primary_key.value)?));
            }
        }

        let sql = format!(
            "UPDATE {} SET {target} = {set_value} WHERE {}",
            Self::qualify_table_name(&request.table)?,
            conditions.join(" AND ")
        );
        Ok((sql, binds))
    }

    /// Build the INSERT DML for one row; shared by `insert_table_row` and the
    /// atomic CSV import paths.
    fn build_row_insert(request: &TableRowInsertRequest) -> Result<(String, SpannerBinds)> {
        if request.values.is_empty() {
            return Err(anyhow!("Insert requires at least one column value"));
        }

        let mut binds = SpannerBinds::default();
        let mut columns = Vec::new();
        let mut values = Vec::new();
        for (column, value) in &request.values {
            columns.push(quote_bigquery_identifier(column)?);
            if value.is_null() {
                values.push("NULL".to_string());
            } else {
                values.push(binds.push(value)?);
            }
        }

        let sql = format!(
            "INSERT INTO {} ({}) VALUES ({})",
            Self::qualify_table_name(&request.table)?,
            columns.join(", "),
            values.join(", ")
        );
        Ok((sql, binds))
    }

    fn statement_kind(sql: &str) -> StatementKind {
        if statement_returns_rows(sql, &["SELECT", "WITH"]) {
            return StatementKind::Query;
        }
        if statement_returns_rows(sql, &["INSERT", "UPDATE", "DELETE"]) {
            return StatementKind::Dml;
        }
        if statement_returns_rows(
            sql,
            &[
                "CREATE", "ALTER", "DROP", "RENAME", "GRANT", "REVOKE", "ANALYZE",
            ],
        ) {
            return StatementKind::Ddl;
        }
        StatementKind::Other
    }

    /// Map one `executeSql` response to a `QueryResult`: row values are
    /// converted through the declared Spanner type codes, DML row counts come
    /// from `stats.rowCountExact`/`rowCountLowerBound`.
    fn result_from_execute_sql(
        response: JsonValue,
        elapsed_ms: u128,
        query: String,
        row_cap: usize,
    ) -> QueryResult {
        let fields = response
            .get("metadata")
            .and_then(|metadata| metadata.get("rowType"))
            .and_then(|row_type| row_type.get("fields"))
            .and_then(|fields| fields.as_array())
            .cloned()
            .unwrap_or_default();

        let columns = fields
            .iter()
            .map(|field| ColumnInfo {
                name: field
                    .get("name")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string(),
                data_type: Self::spanner_type_name(field.get("type")),
                is_nullable: true,
                is_primary_key: false,
                max_length: None,
                default_value: None,
            })
            .collect::<Vec<_>>();

        let mut truncated = false;
        let mut rows = Vec::new();
        if let Some(raw_rows) = response.get("rows").and_then(|rows| rows.as_array()) {
            for raw_row in raw_rows {
                if rows.len() >= row_cap {
                    truncated = true;
                    break;
                }
                let values = raw_row.as_array().cloned().unwrap_or_default();
                rows.push(
                    values
                        .iter()
                        .enumerate()
                        .map(|(index, value)| {
                            Self::spanner_value_to_json(
                                value,
                                fields.get(index).and_then(|field| field.get("type")),
                            )
                        })
                        .collect::<Vec<_>>(),
                );
            }
        }

        let affected_rows = response
            .get("stats")
            .and_then(|stats| {
                stats
                    .get("rowCountExact")
                    .or_else(|| stats.get("rowCountLowerBound"))
            })
            .and_then(Self::json_to_u64)
            .unwrap_or(0);

        QueryResult {
            columns,
            rows,
            affected_rows,
            execution_time_ms: elapsed_ms,
            query,
            sandboxed: false,
            truncated,
        }
    }

    fn json_to_u64(value: &JsonValue) -> Option<u64> {
        value
            .as_u64()
            .or_else(|| value.as_i64().and_then(|raw| u64::try_from(raw).ok()))
            .or_else(|| value.as_str().and_then(|raw| raw.parse::<u64>().ok()))
    }

    /// Convert one wire value using its declared Spanner type code. INT64 and
    /// NUMERIC arrive as strings (precision-safe); FLOAT64/FLOAT32 may arrive
    /// as numbers or the strings "NaN"/"Infinity"/"-Infinity".
    fn spanner_value_to_json(value: &JsonValue, type_info: Option<&JsonValue>) -> JsonValue {
        if value.is_null() {
            return JsonValue::Null;
        }
        let code = type_info
            .and_then(|info| info.get("code"))
            .and_then(|code| code.as_str())
            .unwrap_or_default();

        match code {
            "INT64" => value
                .as_str()
                .and_then(|raw| raw.parse::<i64>().ok())
                .map(JsonValue::from)
                .unwrap_or_else(|| value.clone()),
            "FLOAT64" | "FLOAT32" => {
                if let Some(number) = value.as_f64() {
                    JsonValue::from(number)
                } else if let Some(raw) = value.as_str() {
                    match raw.parse::<f64>() {
                        Ok(parsed) if parsed.is_finite() => JsonValue::from(parsed),
                        // Keep non-finite sentinels ("NaN", "Infinity") as
                        // strings — serde_json cannot represent them.
                        _ => value.clone(),
                    }
                } else {
                    value.clone()
                }
            }
            "BOOL" => value
                .as_bool()
                .map(JsonValue::from)
                .unwrap_or_else(|| value.clone()),
            "ARRAY" => {
                let element_type = type_info.and_then(|info| info.get("arrayElementType"));
                match value.as_array() {
                    Some(elements) => JsonValue::Array(
                        elements
                            .iter()
                            .map(|element| Self::spanner_value_to_json(element, element_type))
                            .collect(),
                    ),
                    None => value.clone(),
                }
            }
            "STRUCT" => {
                let fields = type_info
                    .and_then(|info| info.get("structType"))
                    .and_then(|struct_type| struct_type.get("fields"))
                    .and_then(|fields| fields.as_array());
                match (value.as_array(), fields) {
                    (Some(values), Some(fields)) => {
                        let mut object = Map::new();
                        for (index, item) in values.iter().enumerate() {
                            let field = fields.get(index);
                            let name = field
                                .and_then(|field| field.get("name"))
                                .and_then(|name| name.as_str())
                                .map(str::to_string)
                                .unwrap_or_else(|| format!("field_{}", index + 1));
                            object.insert(
                                name,
                                Self::spanner_value_to_json(
                                    item,
                                    field.and_then(|field| field.get("type")),
                                ),
                            );
                        }
                        JsonValue::Object(object)
                    }
                    _ => value.clone(),
                }
            }
            // STRING, JSON, BYTES (base64), DATE, TIMESTAMP, NUMERIC and
            // unknown codes pass through unchanged.
            _ => value.clone(),
        }
    }

    /// Render a Spanner type descriptor for column metadata, e.g.
    /// `ARRAY<INT64>` or `STRUCT<a:STRING,b:BOOL>`.
    fn spanner_type_name(type_info: Option<&JsonValue>) -> String {
        let Some(type_info) = type_info else {
            return "UNKNOWN".to_string();
        };
        let code = type_info
            .get("code")
            .and_then(|code| code.as_str())
            .unwrap_or("UNKNOWN");
        match code {
            "ARRAY" => format!(
                "ARRAY<{}>",
                Self::spanner_type_name(type_info.get("arrayElementType"))
            ),
            "STRUCT" => {
                let fields = type_info
                    .get("structType")
                    .and_then(|struct_type| struct_type.get("fields"))
                    .and_then(|fields| fields.as_array())
                    .map(|fields| {
                        fields
                            .iter()
                            .map(|field| {
                                let name = field
                                    .get("name")
                                    .and_then(|name| name.as_str())
                                    .unwrap_or_default();
                                let inner = Self::spanner_type_name(field.get("type"));
                                if name.is_empty() {
                                    inner
                                } else {
                                    format!("{name}:{inner}")
                                }
                            })
                            .collect::<Vec<_>>()
                            .join(",")
                    })
                    .unwrap_or_default();
                format!("STRUCT<{fields}>")
            }
            _ => code.to_string(),
        }
    }

    /// Spanner binds INT64 and NUMERIC parameters as strings; JSON parameters
    /// carry the serialized document.
    fn spanner_param_binding(parameter: &QueryParameter) -> Result<(JsonValue, &'static str)> {
        match &parameter.value {
            JsonValue::Null => {
                let code = match parameter.data_type {
                    QueryParameterType::Integer => "INT64",
                    QueryParameterType::Decimal => "FLOAT64",
                    QueryParameterType::Boolean => "BOOL",
                    QueryParameterType::Json => "JSON",
                    QueryParameterType::Text | QueryParameterType::Null => "STRING",
                };
                Ok((JsonValue::Null, code))
            }
            JsonValue::Bool(value) => Ok((JsonValue::Bool(*value), "BOOL")),
            JsonValue::Number(value) => {
                if value.as_i64().is_some() || value.as_u64().is_some() {
                    Ok((JsonValue::String(value.to_string()), "INT64"))
                } else {
                    Ok((JsonValue::Number(value.clone()), "FLOAT64"))
                }
            }
            JsonValue::String(value) => {
                if parameter.data_type == QueryParameterType::Json {
                    Ok((JsonValue::String(value.clone()), "JSON"))
                } else {
                    Ok((JsonValue::String(value.clone()), "STRING"))
                }
            }
            JsonValue::Array(_) | JsonValue::Object(_)
                if parameter.data_type == QueryParameterType::Json =>
            {
                Ok((
                    JsonValue::String(serde_json::to_string(&parameter.value)?),
                    "JSON",
                ))
            }
            _ => Err(anyhow!(
                "Spanner parameters only support string, number, boolean, JSON, and null values"
            )),
        }
    }

    /// Bind a raw JSON value for driver-built DML (`@pN` placeholders).
    /// Structured values travel as JSON documents; null is never bound here —
    /// callers emit a literal `NULL` so the column type resolves it.
    fn spanner_bind_value(value: &JsonValue) -> Result<(JsonValue, &'static str)> {
        match value {
            JsonValue::Null => Err(anyhow!(
                "Spanner null values must be written as a literal NULL"
            )),
            JsonValue::Bool(value) => Ok((JsonValue::Bool(*value), "BOOL")),
            JsonValue::Number(value) => {
                if value.as_i64().is_some() || value.as_u64().is_some() {
                    Ok((JsonValue::String(value.to_string()), "INT64"))
                } else {
                    Ok((JsonValue::Number(value.clone()), "FLOAT64"))
                }
            }
            JsonValue::String(value) => Ok((JsonValue::String(value.clone()), "STRING")),
            JsonValue::Array(_) | JsonValue::Object(_) => {
                Ok((JsonValue::String(serde_json::to_string(value)?), "JSON"))
            }
        }
    }

    /// Rewrite positional `?` markers (outside literals and comments) to
    /// Spanner `@pN` named parameters and build the `params`/`paramTypes`
    /// maps. `parameters` is ordered to match marker positions.
    fn rewrite_spanner_placeholders(
        sql: &str,
        parameters: &[QueryParameter],
    ) -> Result<(String, SpannerBinds)> {
        let chars = sql.chars().collect::<Vec<_>>();
        let mut output = String::with_capacity(sql.len());
        let mut binds = SpannerBinds::default();
        let mut index = 0;
        let mut state = SpannerScanState::Normal;

        while index < chars.len() {
            let current = chars[index];
            match state {
                SpannerScanState::Normal => {
                    if current == '-' && chars.get(index + 1) == Some(&'-') {
                        output.push_str("--");
                        index += 2;
                        state = SpannerScanState::LineComment;
                        continue;
                    }
                    if current == '#' {
                        output.push(current);
                        index += 1;
                        state = SpannerScanState::LineComment;
                        continue;
                    }
                    if current == '/' && chars.get(index + 1) == Some(&'*') {
                        output.push_str("/*");
                        index += 2;
                        state = SpannerScanState::BlockComment;
                        continue;
                    }
                    if current == '\'' {
                        output.push(current);
                        index += 1;
                        state = SpannerScanState::SingleQuote;
                        continue;
                    }
                    if current == '"' {
                        output.push(current);
                        index += 1;
                        state = SpannerScanState::DoubleQuote;
                        continue;
                    }
                    if current == '`' {
                        output.push(current);
                        index += 1;
                        state = SpannerScanState::BacktickQuote;
                        continue;
                    }
                    if current == '?' {
                        let position = binds.next_index + 1;
                        let parameter = parameters.get(position - 1).ok_or_else(|| {
                            anyhow!(
                                "Spanner query has {position} '?' markers but only {} parameters were supplied",
                                parameters.len()
                            )
                        })?;
                        let (bound, code) = Self::spanner_param_binding(parameter)?;
                        binds.next_index = position;
                        let name = format!("p{position}");
                        binds.params.insert(name.clone(), bound);
                        binds
                            .param_types
                            .insert(name.clone(), json!({ "code": code }));
                        output.push_str(&format!("@{name}"));
                        index += 1;
                        continue;
                    }
                    output.push(current);
                    index += 1;
                }
                SpannerScanState::LineComment => {
                    output.push(current);
                    index += 1;
                    if current == '\n' {
                        state = SpannerScanState::Normal;
                    }
                }
                SpannerScanState::BlockComment => {
                    output.push(current);
                    if current == '*' && chars.get(index + 1) == Some(&'/') {
                        output.push('/');
                        index += 2;
                        state = SpannerScanState::Normal;
                    } else {
                        index += 1;
                    }
                }
                SpannerScanState::SingleQuote => {
                    output.push(current);
                    if current == '\\' && index + 1 < chars.len() {
                        output.push(chars[index + 1]);
                        index += 2;
                    } else if current == '\'' && chars.get(index + 1) == Some(&'\'') {
                        output.push('\'');
                        index += 2;
                    } else {
                        index += 1;
                        if current == '\'' {
                            state = SpannerScanState::Normal;
                        }
                    }
                }
                SpannerScanState::DoubleQuote => {
                    output.push(current);
                    if current == '\\' && index + 1 < chars.len() {
                        output.push(chars[index + 1]);
                        index += 2;
                    } else if current == '"' && chars.get(index + 1) == Some(&'"') {
                        output.push('"');
                        index += 2;
                    } else {
                        index += 1;
                        if current == '"' {
                            state = SpannerScanState::Normal;
                        }
                    }
                }
                SpannerScanState::BacktickQuote => {
                    output.push(current);
                    index += 1;
                    if current == '`' {
                        state = SpannerScanState::Normal;
                    }
                }
            }
        }

        if binds.next_index != parameters.len() {
            bail!(
                "Spanner query has {} '?' markers but {} parameters were supplied",
                binds.next_index,
                parameters.len()
            );
        }
        Ok((output, binds))
    }

    /// Quote a possibly schema-qualified table name (`schema.table`) with
    /// backticks; every segment is validated first.
    fn qualify_table_name(table: &str) -> Result<String> {
        let parts = table
            .split('.')
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>();
        match parts.as_slice() {
            [] => Err(anyhow!("Table name cannot be empty")),
            [_, _, _, ..] => Err(anyhow!("Only schema.table names are supported for Spanner")),
            _ => parts
                .iter()
                .map(|part| quote_bigquery_identifier(part))
                .collect::<Result<Vec<_>>>()
                .map(|quoted| quoted.join(".")),
        }
    }

    /// Split `schema.table` into `(schema, table)`; unqualified names get the
    /// default empty schema.
    fn split_table_reference(table: &str) -> Result<(String, String)> {
        let parts = table
            .split('.')
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>();
        match parts.as_slice() {
            [name] => Ok((String::new(), (*name).to_string())),
            [schema, name] => Ok(((*schema).to_string(), (*name).to_string())),
            _ => Err(anyhow!("Only schema.table names are supported for Spanner")),
        }
    }

    fn scalar_i64(result: &QueryResult) -> Result<i64> {
        let value = result
            .rows
            .first()
            .and_then(|row| row.first())
            .ok_or_else(|| anyhow!("Expected a scalar value"))?;

        value
            .as_i64()
            .or_else(|| value.as_u64().and_then(|raw| i64::try_from(raw).ok()))
            .or_else(|| value.as_f64().map(|raw| raw as i64))
            .or_else(|| value.as_str().and_then(|raw| raw.parse::<i64>().ok()))
            .ok_or_else(|| anyhow!("Expected a numeric scalar value"))
    }

    fn label_expression(display_columns: &[&str], referenced_column: &str) -> Result<String> {
        if display_columns.is_empty() {
            return Ok(format!(
                "CAST({} AS STRING)",
                quote_bigquery_order_by(referenced_column)?
            ));
        }

        let parts = display_columns
            .iter()
            .map(|column| {
                Ok(format!(
                    "COALESCE(CAST({} AS STRING), '')",
                    quote_bigquery_order_by(column)?
                ))
            })
            .collect::<Result<Vec<_>>>()?;

        if parts.len() == 1 {
            Ok(parts[0].clone())
        } else {
            let mut concat_parts = Vec::with_capacity(parts.len() * 2 - 1);
            for (index, part) in parts.into_iter().enumerate() {
                if index > 0 {
                    concat_parts.push("' '".to_string());
                }
                concat_parts.push(part);
            }
            Ok(format!("CONCAT({})", concat_parts.join(", ")))
        }
    }

    /// Shared body of `execute_query`/`execute_query_for_request`: split the
    /// script, batch consecutive DDL into one `updateDatabaseDdl` call, run
    /// DML inside a single-use read-write transaction, and return the last
    /// row-producing result with the total affected count.
    async fn execute_query_inner(
        &self,
        sql: &str,
        cancel_flag: Option<Arc<AtomicBool>>,
    ) -> Result<QueryResult> {
        let started = Instant::now();
        let statements = split_sql_statements(sql)
            .into_iter()
            .filter(|statement| !statement.trim().is_empty())
            .collect::<Vec<_>>();

        if statements.len() <= 1 {
            let statement = statements.first().map(String::as_str).unwrap_or(sql);
            // Spanner has no EXPLAIN keyword: route `EXPLAIN <sql>` through
            // executeSql with queryMode=PLAN (PROFILE for EXPLAIN ANALYZE).
            if let Some((inner, analyze)) = Self::strip_explain_prefix(statement) {
                return self
                    .execute_explain(inner, analyze, cancel_flag.as_deref())
                    .await;
            }
            if Self::statement_kind(statement) == StatementKind::Ddl {
                self.execute_ddl(&[statement.to_string()]).await?;
                return Ok(QueryResult {
                    columns: Vec::new(),
                    rows: Vec::new(),
                    affected_rows: 0,
                    execution_time_ms: started.elapsed().as_millis(),
                    query: sql.to_string(),
                    sandboxed: false,
                    truncated: false,
                });
            }
            return self
                .execute_sql_with_retry(
                    statement,
                    None,
                    None,
                    cancel_flag.as_deref(),
                    MAX_QUERY_RESULT_ROWS,
                )
                .await;
        }

        let mut total_affected = 0u64;
        let mut last_result = None;
        let mut ddl_batch: Vec<String> = Vec::new();

        for statement in &statements {
            match Self::statement_kind(statement) {
                StatementKind::Ddl => ddl_batch.push(statement.clone()),
                kind => {
                    if let Some((inner, analyze)) = Self::strip_explain_prefix(statement) {
                        if !ddl_batch.is_empty() {
                            self.execute_ddl(&ddl_batch).await?;
                            ddl_batch.clear();
                        }
                        last_result = Some(
                            self.execute_explain(inner, analyze, cancel_flag.as_deref())
                                .await?,
                        );
                        continue;
                    }
                    if !ddl_batch.is_empty() {
                        self.execute_ddl(&ddl_batch).await?;
                        ddl_batch.clear();
                    }
                    let result = self
                        .execute_sql_with_retry(
                            statement,
                            None,
                            None,
                            cancel_flag.as_deref(),
                            MAX_QUERY_RESULT_ROWS,
                        )
                        .await?;
                    total_affected += result.affected_rows;
                    if kind == StatementKind::Query || !result.rows.is_empty() {
                        last_result = Some(result);
                    }
                }
            }
        }
        if !ddl_batch.is_empty() {
            self.execute_ddl(&ddl_batch).await?;
        }

        let elapsed = started.elapsed().as_millis();
        if let Some(mut result) = last_result {
            result.execution_time_ms = elapsed;
            result.affected_rows = total_affected;
            return Ok(result);
        }

        Ok(QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            affected_rows: total_affected,
            execution_time_ms: elapsed,
            query: sql.to_string(),
            sandboxed: false,
            truncated: false,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SpannerScanState {
    Normal,
    LineComment,
    BlockComment,
    SingleQuote,
    DoubleQuote,
    BacktickQuote,
}

#[async_trait]
impl DatabaseDriver for SpannerDriver {
    async fn ping(&self) -> Result<()> {
        self.execute_sql("SELECT 1", None, None)
            .await
            .context("Spanner ping failed")?;
        Ok(())
    }

    async fn disconnect(&self) -> Result<()> {
        if let Err(error) = self.delete_session().await {
            log::warn!("Failed to delete Spanner session on disconnect: {error:#}");
        }
        Ok(())
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        let mut databases = Vec::new();
        let mut page_token = None::<String>;

        loop {
            let mut request = self
                .client
                .get(Self::databases_url(&self.base_url, &self.instance_path));
            if let Some(token) = page_token.as_deref().filter(|value| !value.is_empty()) {
                request = request.query(&[("pageToken", token)]);
            }
            let response = self.send_checked(request).await?;

            if let Some(items) = response.get("databases").and_then(|v| v.as_array()) {
                for item in items {
                    if let Some(name) = item.get("name").and_then(|v| v.as_str()) {
                        let short = name.rsplit('/').next().unwrap_or(name).to_string();
                        databases.push(DatabaseInfo {
                            name: short,
                            size: None,
                        });
                    }
                }
            }

            match response
                .get("nextPageToken")
                .and_then(|v| v.as_str())
                .filter(|v| !v.is_empty())
            {
                Some(token) => page_token = Some(token.to_string()),
                None => break,
            }
        }

        databases.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(databases)
    }

    async fn list_tables(&self, database: Option<&str>) -> Result<Vec<TableInfo>> {
        let sql = "SELECT TABLE_NAME, TABLE_TYPE \
                   FROM INFORMATION_SCHEMA.TABLES \
                   WHERE TABLE_TYPE = 'BASE TABLE' \
                   ORDER BY TABLE_NAME";
        let result = self.execute_sql(sql, None, database).await?;
        let schema = database
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| self.current_database());

        Ok(result
            .rows
            .iter()
            .map(|row| TableInfo {
                create_date: None,
                name: row
                    .first()
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string(),
                schema: schema.clone(),
                table_type: row
                    .get(1)
                    .and_then(|value| value.as_str())
                    .unwrap_or("BASE TABLE")
                    .to_string(),
                row_count: None,
                engine: Some("Spanner".to_string()),
            })
            .collect())
    }

    async fn list_schema_objects(&self, database: Option<&str>) -> Result<Vec<SchemaObjectInfo>> {
        let sql = "SELECT TABLE_NAME, VIEW_DEFINITION \
                   FROM INFORMATION_SCHEMA.VIEWS \
                   ORDER BY TABLE_NAME";
        let result = self.execute_sql(sql, None, database).await?;
        let schema = database
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| self.current_database());

        Ok(result
            .rows
            .iter()
            .map(|row| SchemaObjectInfo {
                create_date: None,
                name: row
                    .first()
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string(),
                schema: schema.clone(),
                object_type: "VIEW".to_string(),
                related_table: None,
                definition: row
                    .get(1)
                    .and_then(|value| value.as_str())
                    .map(str::to_string),
            })
            .collect())
    }

    async fn get_table_structure(
        &self,
        table: &str,
        database: Option<&str>,
    ) -> Result<TableStructure> {
        let (schema, table_name) = Self::split_table_reference(table)?;
        let mut binds = SpannerBinds::default();
        let schema_param = binds.push(&JsonValue::String(schema.clone()))?;
        let table_param = binds.push(&JsonValue::String(table_name.clone()))?;

        let column_sql = format!(
            "SELECT COLUMN_NAME, SPANNER_TYPE, IS_NULLABLE, IS_GENERATED, \
                    GENERATION_EXPRESSION, COLUMN_DEFAULT \
             FROM INFORMATION_SCHEMA.COLUMNS \
             WHERE TABLE_SCHEMA = {schema_param} AND TABLE_NAME = {table_param} \
             ORDER BY ORDINAL_POSITION"
        );
        let column_result = self
            .execute_sql(&column_sql, Some(&binds), database)
            .await?;

        let pk_sql = format!(
            "SELECT COLUMN_NAME \
             FROM INFORMATION_SCHEMA.INDEX_COLUMNS \
             WHERE TABLE_SCHEMA = {schema_param} AND TABLE_NAME = {table_param} \
               AND INDEX_NAME = 'PRIMARY_KEY' \
             ORDER BY ORDINAL_POSITION"
        );
        let pk_result = self.execute_sql(&pk_sql, Some(&binds), database).await?;
        let pk_columns: HashSet<String> = pk_result
            .rows
            .iter()
            .filter_map(|row| row.first().and_then(|value| value.as_str()))
            .map(str::to_string)
            .collect();

        let columns = column_result
            .rows
            .iter()
            .map(|row| {
                let name = row
                    .first()
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string();
                let is_generated = row
                    .get(3)
                    .and_then(|value| value.as_str())
                    .is_some_and(|value| value.eq_ignore_ascii_case("ALWAYS"));
                let generation = row
                    .get(4)
                    .and_then(|value| value.as_str())
                    .filter(|value| !value.is_empty());
                ColumnDetail {
                    is_primary_key: pk_columns.contains(&name),
                    name,
                    data_type: row
                        .get(1)
                        .and_then(|value| value.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    is_nullable: row
                        .get(2)
                        .and_then(|value| value.as_str())
                        .is_some_and(|value| value.eq_ignore_ascii_case("YES")),
                    default_value: row
                        .get(5)
                        .and_then(|value| value.as_str())
                        .filter(|value| !value.is_empty())
                        .map(str::to_string),
                    extra: if is_generated {
                        Some(match generation {
                            Some(expression) => {
                                format!("GENERATED ALWAYS AS ({expression})")
                            }
                            None => "GENERATED ALWAYS".to_string(),
                        })
                    } else {
                        None
                    },
                    column_type: None,
                    comment: None,
                }
            })
            .collect::<Vec<_>>();

        let index_sql = format!(
            "SELECT i.INDEX_NAME, i.IS_UNIQUE, i.INDEX_TYPE, c.COLUMN_NAME \
             FROM INFORMATION_SCHEMA.INDEXES i \
             JOIN INFORMATION_SCHEMA.INDEX_COLUMNS c \
               ON c.TABLE_SCHEMA = i.TABLE_SCHEMA \
              AND c.TABLE_NAME = i.TABLE_NAME \
              AND c.INDEX_NAME = i.INDEX_NAME \
             WHERE i.TABLE_SCHEMA = {schema_param} AND i.TABLE_NAME = {table_param} \
               AND i.INDEX_TYPE != 'PRIMARY_KEY' \
             ORDER BY i.INDEX_NAME, c.ORDINAL_POSITION"
        );
        let index_result = self.execute_sql(&index_sql, Some(&binds), database).await?;
        let mut indexes: Vec<IndexInfo> = Vec::new();
        for row in &index_result.rows {
            let name = row
                .first()
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string();
            let column = row
                .get(3)
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string();
            if let Some(existing) = indexes.iter_mut().find(|index| index.name == name) {
                existing.columns.push(column);
            } else {
                indexes.push(IndexInfo {
                    name,
                    columns: vec![column],
                    is_unique: row
                        .get(1)
                        .and_then(|value| value.as_bool())
                        .unwrap_or(false),
                    index_type: row
                        .get(2)
                        .and_then(|value| value.as_str())
                        .map(str::to_string),
                });
            }
        }

        let fk_sql = format!(
            "SELECT rc.CONSTRAINT_NAME, kcu.COLUMN_NAME, kcu2.TABLE_NAME, \
                    kcu2.COLUMN_NAME, rc.UPDATE_RULE, rc.DELETE_RULE \
             FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc \
             JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu \
               ON kcu.CONSTRAINT_CATALOG = rc.CONSTRAINT_CATALOG \
              AND kcu.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA \
              AND kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME \
             JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu2 \
               ON kcu2.CONSTRAINT_CATALOG = rc.UNIQUE_CONSTRAINT_CATALOG \
              AND kcu2.CONSTRAINT_SCHEMA = rc.UNIQUE_CONSTRAINT_SCHEMA \
              AND kcu2.CONSTRAINT_NAME = rc.UNIQUE_CONSTRAINT_NAME \
              AND kcu2.ORDINAL_POSITION = kcu.POSITION_IN_UNIQUE_CONSTRAINT \
             WHERE kcu.TABLE_SCHEMA = {schema_param} AND kcu.TABLE_NAME = {table_param} \
             ORDER BY rc.CONSTRAINT_NAME, kcu.ORDINAL_POSITION"
        );
        let fk_result = self.execute_sql(&fk_sql, Some(&binds), database).await?;
        let foreign_keys = fk_result
            .rows
            .iter()
            .map(|row| ForeignKeyInfo {
                name: row
                    .first()
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string(),
                column: row
                    .get(1)
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string(),
                referenced_table: row
                    .get(2)
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string(),
                referenced_column: row
                    .get(3)
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string(),
                on_update: row
                    .get(4)
                    .and_then(|value| value.as_str())
                    .map(str::to_string),
                on_delete: row
                    .get(5)
                    .and_then(|value| value.as_str())
                    .map(str::to_string),
            })
            .collect();

        let object_sql = format!(
            "SELECT TABLE_TYPE \
             FROM INFORMATION_SCHEMA.TABLES \
             WHERE TABLE_SCHEMA = {schema_param} AND TABLE_NAME = {table_param} \
             LIMIT 1"
        );
        let object_result = self
            .execute_sql(&object_sql, Some(&binds), database)
            .await?;
        let object_type = object_result
            .rows
            .first()
            .and_then(|row| row.first())
            .and_then(|value| value.as_str())
            .map(str::to_string);

        let view_definition = if object_type.as_deref() == Some("VIEW") {
            let view_sql = format!(
                "SELECT VIEW_DEFINITION \
                 FROM INFORMATION_SCHEMA.VIEWS \
                 WHERE TABLE_SCHEMA = {schema_param} AND TABLE_NAME = {table_param} \
                 LIMIT 1"
            );
            self.execute_sql(&view_sql, Some(&binds), database)
                .await?
                .rows
                .first()
                .and_then(|row| row.first())
                .and_then(|value| value.as_str())
                .map(str::to_string)
        } else {
            None
        };

        Ok(TableStructure {
            columns,
            indexes,
            foreign_keys,
            triggers: Vec::new(),
            view_definition,
            object_type,
        })
    }

    async fn execute_query(&self, sql: &str) -> Result<QueryResult> {
        self.execute_query_inner(sql, None).await
    }

    /// Request-scoped execution: the query runs on the shared session so
    /// `cancel_query_request` can DELETE it and abort the in-flight call.
    async fn execute_query_for_request(&self, request_id: &str, sql: &str) -> Result<QueryResult> {
        if request_id.trim().is_empty() {
            return self.execute_query(sql).await;
        }
        let guard = CancelScopeGuard::begin(&self.cancel_registry, request_id);
        // The session is the kill target, not a backend id — registering a
        // marker only resolves the pending-cancel race.
        if guard.register_backend(0) {
            return Err(anyhow!("Query cancelled."));
        }
        let flag = guard.cancel_flag();
        let result = self.execute_query_inner(sql, flag).await;
        drop(guard);
        result
    }

    /// Spanner aborts in-flight `executeSql` calls when their session is
    /// deleted; the stored session is cleared so the next query recreates it.
    async fn cancel_query_request(&self, request_id: &str) -> Result<bool> {
        match request_cancel(&self.cancel_registry, request_id) {
            CancelLookup::NotRunning => Ok(false),
            CancelLookup::Pending => Ok(true),
            CancelLookup::Backend(_) => self.delete_session().await,
        }
    }

    async fn execute_parameterized_query(
        &self,
        sql: &str,
        parameters: &[QueryParameter],
    ) -> Result<QueryResult> {
        let (rewritten, binds) = Self::rewrite_spanner_placeholders(sql, parameters)?;
        self.execute_sql(&rewritten, Some(&binds), None).await
    }

    async fn execute_parameterized_query_for_request(
        &self,
        request_id: &str,
        sql: &str,
        parameters: &[QueryParameter],
    ) -> Result<QueryResult> {
        if request_id.trim().is_empty() {
            return self.execute_parameterized_query(sql, parameters).await;
        }
        let guard = CancelScopeGuard::begin(&self.cancel_registry, request_id);
        if guard.register_backend(0) {
            return Err(anyhow!("Query cancelled."));
        }
        let flag = guard.cancel_flag();
        let (rewritten, binds) = Self::rewrite_spanner_placeholders(sql, parameters)?;
        let result = self
            .execute_sql_with_retry(
                &rewritten,
                Some(&binds),
                None,
                flag.as_deref(),
                MAX_QUERY_RESULT_ROWS,
            )
            .await;
        drop(guard);
        result
    }

    async fn get_table_data(
        &self,
        table: &str,
        database: Option<&str>,
        offset: u64,
        limit: u64,
        order_by: Option<&str>,
        order_dir: Option<&str>,
        filter: Option<&str>,
    ) -> Result<QueryResult> {
        let mut sql = format!("SELECT * FROM {}", Self::qualify_table_name(table)?);

        if let Some(filter_clause) = sanitize_bigquery_filter_clause(filter)? {
            sql.push_str(&format!(" WHERE {filter_clause}"));
        }

        if let Some(order_column) = order_by {
            let direction = normalize_order_dir(order_dir)?;
            sql.push_str(&format!(
                " ORDER BY {} {}",
                quote_bigquery_order_by(order_column)?,
                direction
            ));
        }

        sql.push_str(&format!(" LIMIT {limit} OFFSET {offset}"));
        // Page directly through executeSql: the caller's LIMIT bounds the
        // page, so the interactive row cap must not truncate it.
        self.execute_sql_with_retry(&sql, None, database, None, usize::MAX)
            .await
    }

    async fn count_rows(&self, table: &str, database: Option<&str>) -> Result<i64> {
        let sql = format!(
            "SELECT COUNT(*) AS count FROM {}",
            Self::qualify_table_name(table)?
        );
        let result = self.execute_sql(&sql, None, database).await?;
        Self::scalar_i64(&result)
    }

    async fn count_null_values(
        &self,
        table: &str,
        database: Option<&str>,
        column: &str,
    ) -> Result<i64> {
        let sql = format!(
            "SELECT COUNT(*) AS count FROM {} WHERE {} IS NULL",
            Self::qualify_table_name(table)?,
            quote_bigquery_order_by(column)?,
        );
        let result = self.execute_sql(&sql, None, database).await?;
        Self::scalar_i64(&result)
    }

    async fn update_table_cell(&self, request: &TableCellUpdateRequest) -> Result<u64> {
        let (sql, binds) = Self::build_cell_update(request)?;
        let result = self
            .execute_sql(&sql, Some(&binds), request.database.as_deref())
            .await?;
        Ok(result.affected_rows)
    }

    /// Apply the queued cell edits inside one read-write transaction: every
    /// UPDATE is pinned to the same transaction id and the batch commits only
    /// when all statements succeed — any failure rolls the whole queue back.
    async fn apply_table_updates_atomically(
        &self,
        updates: &[TableCellUpdateRequest],
    ) -> Result<u64> {
        if updates.is_empty() {
            return Ok(0);
        }
        let txn = self
            .begin_read_write_txn(updates[0].database.as_deref())
            .await?;
        let work = async {
            let mut affected_rows = 0u64;
            for request in updates {
                if self.database_path_for(request.database.as_deref())? != txn.database_path {
                    bail!("Spanner transactions cannot span databases");
                }
                let (sql, binds) = Self::build_cell_update(request)?;
                let result = self.execute_sql_in_txn(&txn, &sql, Some(&binds)).await?;
                if result.affected_rows == 0 {
                    bail!("An edit queue row no longer matches its primary-key selector");
                }
                affected_rows += result.affected_rows;
            }
            Ok::<u64, anyhow::Error>(affected_rows)
        }
        .await;
        match work {
            Ok(affected_rows) => {
                self.commit_txn(&txn).await?;
                Ok(affected_rows)
            }
            Err(error) => {
                self.rollback_txn(&txn).await;
                Err(error)
            }
        }
    }

    async fn delete_table_rows(&self, request: &TableRowDeleteRequest) -> Result<u64> {
        if request.rows.is_empty() {
            return Err(anyhow!("Deleting rows requires at least one selected row"));
        }

        let mut binds = SpannerBinds::default();
        let mut predicates = Vec::new();
        for row_keys in &request.rows {
            if row_keys.is_empty() {
                return Err(anyhow!(
                    "Each deleted row must include at least one primary key value"
                ));
            }
            let mut conditions = Vec::new();
            for primary_key in row_keys {
                let column = quote_bigquery_order_by(&primary_key.column)?;
                if primary_key.value.is_null() {
                    conditions.push(format!("{column} IS NULL"));
                } else {
                    conditions.push(format!("{column} = {}", binds.push(&primary_key.value)?));
                }
            }
            predicates.push(format!("({})", conditions.join(" AND ")));
        }

        let sql = format!(
            "DELETE FROM {} WHERE {}",
            Self::qualify_table_name(&request.table)?,
            predicates.join(" OR ")
        );
        let result = self
            .execute_sql(&sql, Some(&binds), request.database.as_deref())
            .await?;
        Ok(result.affected_rows)
    }

    async fn insert_table_row(&self, request: &TableRowInsertRequest) -> Result<u64> {
        let (sql, binds) = Self::build_row_insert(request)?;
        let result = self
            .execute_sql(&sql, Some(&binds), request.database.as_deref())
            .await?;
        Ok(result.affected_rows.max(1))
    }

    /// Insert a buffered CSV batch inside one read-write transaction. The
    /// cancel flag is honoured between statements; a set flag or any failed
    /// insert rolls every row back.
    async fn insert_table_rows_atomically(
        &self,
        requests: &[TableRowInsertRequest],
        cancelled: Arc<AtomicBool>,
    ) -> Result<u64> {
        if requests.is_empty() {
            return Err(anyhow!("CSV import requires at least one row"));
        }
        let txn = self
            .begin_read_write_txn(requests[0].database.as_deref())
            .await?;
        let work = async {
            let mut affected_rows = 0u64;
            for request in requests {
                if cancelled.load(Ordering::Relaxed) {
                    bail!("CSV import cancelled; all rows were rolled back");
                }
                if self.database_path_for(request.database.as_deref())? != txn.database_path {
                    bail!("Spanner transactions cannot span databases");
                }
                let (sql, binds) = Self::build_row_insert(request)?;
                let result = self.execute_sql_in_txn(&txn, &sql, Some(&binds)).await?;
                affected_rows += result.affected_rows.max(1);
            }
            Ok::<u64, anyhow::Error>(affected_rows)
        }
        .await;
        match work {
            Ok(affected_rows) => {
                self.commit_txn(&txn).await?;
                Ok(affected_rows)
            }
            Err(error) => {
                self.rollback_txn(&txn).await;
                Err(error)
            }
        }
    }

    /// Consume the CSV row channel inside one read-write transaction. A parse
    /// error, a set cancel flag, or an empty stream rolls every inserted row
    /// back; the transaction commits only after the channel closes cleanly.
    async fn insert_table_row_stream_atomically(
        &self,
        mut rows: tokio::sync::mpsc::Receiver<crate::database::models::CsvImportRow>,
        cancelled: Arc<AtomicBool>,
    ) -> Result<u64> {
        let txn = self.begin_read_write_txn(None).await?;
        let work = async {
            let mut affected_rows = 0u64;
            while let Some(request) = rows.recv().await {
                if cancelled.load(Ordering::Relaxed) {
                    bail!("CSV import cancelled; all rows were rolled back");
                }
                let request = request.map_err(anyhow::Error::msg)?;
                if self.database_path_for(request.database.as_deref())? != txn.database_path {
                    bail!("Spanner transactions cannot span databases");
                }
                let (sql, binds) = Self::build_row_insert(&request)?;
                let result = self.execute_sql_in_txn(&txn, &sql, Some(&binds)).await?;
                affected_rows += result.affected_rows.max(1);
            }
            if affected_rows == 0 {
                bail!("CSV import did not contain any data rows");
            }
            Ok::<u64, anyhow::Error>(affected_rows)
        }
        .await;
        match work {
            Ok(affected_rows) => {
                self.commit_txn(&txn).await?;
                Ok(affected_rows)
            }
            Err(error) => {
                self.rollback_txn(&txn).await;
                Err(error)
            }
        }
    }

    /// Run reviewed statements inside one read-write transaction and ALWAYS
    /// roll back, returning each statement's result as the preview. DDL is
    /// rejected up front: Spanner schema changes go through
    /// `updateDatabaseDdl`, which a transaction cannot undo.
    async fn preview_write_transaction(&self, statements: &[String]) -> Result<Vec<QueryResult>> {
        if statements
            .iter()
            .any(|statement| Self::statement_kind(statement) == StatementKind::Ddl)
        {
            return Err(anyhow!(
                "Spanner write preview cannot include DDL: schema changes cannot be rolled back"
            ));
        }
        let txn = self.begin_read_write_txn(None).await?;
        let work = async {
            let mut results = Vec::with_capacity(statements.len());
            for statement in statements {
                let mut result = self.execute_sql_in_txn(&txn, statement, None).await?;
                result.sandboxed = true;
                results.push(result);
            }
            Ok::<Vec<QueryResult>, anyhow::Error>(results)
        }
        .await;
        self.rollback_txn(&txn).await;
        work
    }

    /// Reviewed schema edits go straight to `updateDatabaseDdl` in one batch
    /// (the API accepts a statement list); non-DDL statements fall back to
    /// the regular execute path.
    async fn execute_structure_statements(&self, statements: &[String]) -> Result<u64> {
        let mut total_affected = 0u64;
        let mut ddl_batch: Vec<String> = Vec::new();
        for statement in statements {
            if Self::statement_kind(statement) == StatementKind::Ddl {
                ddl_batch.push(statement.clone());
                continue;
            }
            if !ddl_batch.is_empty() {
                self.execute_ddl(&ddl_batch).await?;
                ddl_batch.clear();
            }
            total_affected += self.execute_query(statement).await?.affected_rows;
        }
        if !ddl_batch.is_empty() {
            self.execute_ddl(&ddl_batch).await?;
        }
        Ok(total_affected)
    }

    async fn use_database(&self, database: &str) -> Result<()> {
        let trimmed = database.trim();
        Self::validate_database_name(trimmed)?;

        let new_path = format!("{}/databases/{trimmed}", self.instance_path);
        // Verify the database exists before switching so typos fail here
        // instead of on the next query.
        self.send_checked(
            self.client
                .get(Self::database_url(&self.base_url, &new_path)),
        )
        .await
        .with_context(|| format!("Failed to switch to Spanner database {trimmed}"))?;

        {
            let mut path = self
                .database_path
                .write()
                .map_err(|_| anyhow!("Failed to access Spanner database state"))?;
            *path = new_path;
        }
        {
            let mut current = self
                .current_db
                .write()
                .map_err(|_| anyhow!("Failed to access Spanner database state"))?;
            *current = Some(trimmed.to_string());
        }
        // The stored session is bound to the old database path; drop it so the
        // next query creates a session on the new database.
        *self.session.write().await = None;
        Ok(())
    }

    async fn get_foreign_key_lookup_values(
        &self,
        referenced_table: &str,
        referenced_column: &str,
        display_columns: &[&str],
        search: Option<&str>,
        limit: u32,
    ) -> Result<Vec<LookupValue>> {
        let value_expr = quote_bigquery_order_by(referenced_column)?;
        let label_expr = Self::label_expression(display_columns, referenced_column)?;
        let mut binds = SpannerBinds::default();

        let mut sql = format!(
            "SELECT {value_expr} AS value, {label_expr} AS label FROM {}",
            Self::qualify_table_name(referenced_table)?
        );

        if let Some(search_term) = search.map(str::trim).filter(|value| !value.is_empty()) {
            let pattern = binds.push(&JsonValue::String(format!("%{search_term}%")))?;
            sql.push_str(&format!(
                " WHERE CAST({value_expr} AS STRING) LIKE {pattern}"
            ));
        }

        sql.push_str(&format!(" ORDER BY {value_expr} LIMIT {}", limit.max(1)));

        let result = self.execute_sql(&sql, Some(&binds), None).await?;
        Ok(result
            .rows
            .into_iter()
            .map(|row| {
                let value = row.first().cloned().unwrap_or(JsonValue::Null);
                let label = row.get(1).cloned().unwrap_or_else(|| value.clone());
                LookupValue {
                    value,
                    label: match label {
                        JsonValue::String(text) => text,
                        other => serde_json::to_string(&other).unwrap_or_default(),
                    },
                }
            })
            .collect())
    }

    fn current_database(&self) -> Option<String> {
        self.current_db.read().ok()?.clone()
    }

    fn driver_name(&self) -> &str {
        "spanner"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parameter(value: JsonValue, data_type: QueryParameterType) -> QueryParameter {
        QueryParameter {
            name: "p".to_string(),
            value,
            data_type,
        }
    }

    #[test]
    fn maps_spanner_scalar_type_codes_to_json_values() {
        let int64 = json!({ "code": "INT64" });
        assert_eq!(
            SpannerDriver::spanner_value_to_json(&json!("42"), Some(&int64)),
            json!(42)
        );
        // INT64 beyond f64 precision stays exact.
        assert_eq!(
            SpannerDriver::spanner_value_to_json(&json!("9223372036854775807"), Some(&int64)),
            json!(9223372036854775807_i64)
        );

        let float64 = json!({ "code": "FLOAT64" });
        assert_eq!(
            SpannerDriver::spanner_value_to_json(&json!(1.5), Some(&float64)),
            json!(1.5)
        );
        assert_eq!(
            SpannerDriver::spanner_value_to_json(&json!("2.25"), Some(&float64)),
            json!(2.25)
        );
        // Non-finite sentinels cannot be JSON numbers — keep the string.
        assert_eq!(
            SpannerDriver::spanner_value_to_json(&json!("NaN"), Some(&float64)),
            json!("NaN")
        );

        let boolean = json!({ "code": "BOOL" });
        assert_eq!(
            SpannerDriver::spanner_value_to_json(&json!(true), Some(&boolean)),
            json!(true)
        );

        let string = json!({ "code": "STRING" });
        assert_eq!(
            SpannerDriver::spanner_value_to_json(&json!("abc"), Some(&string)),
            json!("abc")
        );

        // NULL maps to Null regardless of the declared type.
        assert_eq!(
            SpannerDriver::spanner_value_to_json(&JsonValue::Null, Some(&int64)),
            JsonValue::Null
        );
    }

    #[test]
    fn maps_spanner_array_and_struct_type_codes() {
        let array_of_int = json!({
            "code": "ARRAY",
            "arrayElementType": { "code": "INT64" }
        });
        assert_eq!(
            SpannerDriver::spanner_value_to_json(&json!(["1", "2", null]), Some(&array_of_int)),
            json!([1, 2, null])
        );

        let struct_type = json!({
            "code": "STRUCT",
            "structType": {
                "fields": [
                    { "name": "id", "type": { "code": "INT64" } },
                    { "name": "label", "type": { "code": "STRING" } }
                ]
            }
        });
        assert_eq!(
            SpannerDriver::spanner_value_to_json(&json!(["7", "seven"]), Some(&struct_type)),
            json!({ "id": 7, "label": "seven" })
        );

        // Unnamed struct fields fall back to positional names.
        let anonymous_struct = json!({
            "code": "STRUCT",
            "structType": {
                "fields": [
                    { "type": { "code": "BOOL" } },
                    { "type": { "code": "STRING" } }
                ]
            }
        });
        assert_eq!(
            SpannerDriver::spanner_value_to_json(&json!([true, "x"]), Some(&anonymous_struct)),
            json!({ "field_1": true, "field_2": "x" })
        );
    }

    #[test]
    fn renders_spanner_type_names() {
        assert_eq!(
            SpannerDriver::spanner_type_name(Some(&json!({ "code": "STRING" }))),
            "STRING"
        );
        assert_eq!(
            SpannerDriver::spanner_type_name(Some(&json!({
                "code": "ARRAY",
                "arrayElementType": { "code": "INT64" }
            }))),
            "ARRAY<INT64>"
        );
        assert_eq!(
            SpannerDriver::spanner_type_name(Some(&json!({
                "code": "STRUCT",
                "structType": {
                    "fields": [
                        { "name": "a", "type": { "code": "STRING" } },
                        { "type": { "code": "BOOL" } }
                    ]
                }
            }))),
            "STRUCT<a:STRING,BOOL>"
        );
        assert_eq!(SpannerDriver::spanner_type_name(None), "UNKNOWN");
    }

    #[test]
    fn maps_query_parameters_to_spanner_param_types() {
        let (value, code) =
            SpannerDriver::spanner_param_binding(&parameter(json!("hi"), QueryParameterType::Text))
                .expect("string param");
        assert_eq!((value, code), (json!("hi"), "STRING"));

        let (value, code) = SpannerDriver::spanner_param_binding(&parameter(
            json!(42),
            QueryParameterType::Integer,
        ))
        .expect("integer param");
        // INT64 binds travel as strings.
        assert_eq!((value, code), (json!("42"), "INT64"));

        let (value, code) = SpannerDriver::spanner_param_binding(&parameter(
            json!(1.5),
            QueryParameterType::Decimal,
        ))
        .expect("decimal param");
        assert_eq!((value, code), (json!(1.5), "FLOAT64"));

        let (value, code) = SpannerDriver::spanner_param_binding(&parameter(
            json!(true),
            QueryParameterType::Boolean,
        ))
        .expect("bool param");
        assert_eq!((value, code), (json!(true), "BOOL"));

        // Null takes its type from the declared hint, defaulting to STRING.
        let (value, code) = SpannerDriver::spanner_param_binding(&parameter(
            JsonValue::Null,
            QueryParameterType::Integer,
        ))
        .expect("null int param");
        assert_eq!((value, code), (JsonValue::Null, "INT64"));
        let (value, code) = SpannerDriver::spanner_param_binding(&parameter(
            JsonValue::Null,
            QueryParameterType::Null,
        ))
        .expect("null default param");
        assert_eq!((value, code), (JsonValue::Null, "STRING"));

        // JSON-typed strings and documents bind as JSON.
        let (_, code) = SpannerDriver::spanner_param_binding(&parameter(
            json!("{\"a\":1}"),
            QueryParameterType::Json,
        ))
        .expect("json string param");
        assert_eq!(code, "JSON");
        let (value, code) = SpannerDriver::spanner_param_binding(&parameter(
            json!({ "a": 1 }),
            QueryParameterType::Json,
        ))
        .expect("json object param");
        assert_eq!((value, code), (json!("{\"a\":1}"), "JSON"));

        // Structured values without a JSON hint are rejected.
        assert!(SpannerDriver::spanner_param_binding(&parameter(
            json!([1, 2]),
            QueryParameterType::Text,
        ))
        .is_err());
    }

    #[test]
    fn builds_spanner_urls_from_resource_paths() {
        let base = "https://spanner.googleapis.com";
        let database_path = "projects/p/instances/i/databases/d";
        assert_eq!(
            SpannerDriver::sessions_url(base, database_path),
            "https://spanner.googleapis.com/v1/projects/p/instances/i/databases/d/sessions"
        );
        let session = "projects/p/instances/i/databases/d/sessions/sess-1";
        assert_eq!(
            SpannerDriver::execute_sql_url(base, session),
            "https://spanner.googleapis.com/v1/projects/p/instances/i/databases/d/sessions/sess-1:executeSql"
        );
        assert_eq!(
            SpannerDriver::session_delete_url(base, session),
            "https://spanner.googleapis.com/v1/projects/p/instances/i/databases/d/sessions/sess-1"
        );
        assert_eq!(
            SpannerDriver::databases_url(base, "projects/p/instances/i"),
            "https://spanner.googleapis.com/v1/projects/p/instances/i/databases"
        );
        assert_eq!(
            SpannerDriver::update_ddl_url(base, database_path),
            "https://spanner.googleapis.com/v1/projects/p/instances/i/databases/d/ddl"
        );
    }

    #[test]
    fn rewrites_question_mark_placeholders_to_named_params() {
        let (sql, binds) = SpannerDriver::rewrite_spanner_placeholders(
            "SELECT * FROM t WHERE a = ? AND b = ? -- ? ignored\nAND c = '?'",
            &[
                parameter(json!(1), QueryParameterType::Integer),
                parameter(json!("x"), QueryParameterType::Text),
            ],
        )
        .expect("rewrite");
        assert_eq!(
            sql,
            "SELECT * FROM t WHERE a = @p1 AND b = @p2 -- ? ignored\nAND c = '?'"
        );
        assert_eq!(binds.params.get("p1"), Some(&json!("1")));
        assert_eq!(binds.params.get("p2"), Some(&json!("x")));
        assert_eq!(
            binds.param_types.get("p1"),
            Some(&json!({ "code": "INT64" }))
        );
        assert_eq!(
            binds.param_types.get("p2"),
            Some(&json!({ "code": "STRING" }))
        );
    }

    #[test]
    fn rejects_mismatched_placeholder_counts() {
        assert!(SpannerDriver::rewrite_spanner_placeholders(
            "SELECT ?",
            &[
                parameter(json!(1), QueryParameterType::Integer),
                parameter(json!(2), QueryParameterType::Integer),
            ],
        )
        .is_err());
        assert!(SpannerDriver::rewrite_spanner_placeholders(
            "SELECT ?, ?",
            &[parameter(json!(1), QueryParameterType::Integer),]
        )
        .is_err());
    }

    #[test]
    fn parses_information_schema_rows_into_query_result() {
        let response = json!({
            "metadata": {
                "rowType": {
                    "fields": [
                        { "name": "TABLE_NAME", "type": { "code": "STRING" } },
                        { "name": "TABLE_TYPE", "type": { "code": "STRING" } }
                    ]
                }
            },
            "rows": [["Singers", "BASE TABLE"], ["Albums", "BASE TABLE"]]
        });
        let result = SpannerDriver::result_from_execute_sql(
            response,
            0,
            "SELECT TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES".to_string(),
            MAX_QUERY_RESULT_ROWS,
        );
        assert_eq!(result.columns.len(), 2);
        assert_eq!(result.columns[0].name, "TABLE_NAME");
        assert_eq!(result.columns[0].data_type, "STRING");
        assert_eq!(
            result.rows,
            vec![
                vec![json!("Singers"), json!("BASE TABLE")],
                vec![json!("Albums"), json!("BASE TABLE")],
            ]
        );
        assert!(!result.truncated);
    }

    #[test]
    fn parses_dml_stats_and_truncates_at_row_cap() {
        let response = json!({
            "stats": { "rowCountExact": "3" }
        });
        let result = SpannerDriver::result_from_execute_sql(
            response,
            0,
            "DELETE FROM t WHERE x".to_string(),
            MAX_QUERY_RESULT_ROWS,
        );
        assert_eq!(result.affected_rows, 3);
        assert!(result.columns.is_empty());

        let response = json!({
            "metadata": {
                "rowType": {
                    "fields": [{ "name": "n", "type": { "code": "INT64" } }]
                }
            },
            "rows": [["1"], ["2"], ["3"]]
        });
        let result =
            SpannerDriver::result_from_execute_sql(response, 0, "SELECT n FROM t".to_string(), 2);
        assert_eq!(result.rows.len(), 2);
        assert!(result.truncated);
    }

    #[test]
    fn classifies_statement_kinds() {
        assert_eq!(
            SpannerDriver::statement_kind("SELECT 1"),
            StatementKind::Query
        );
        assert_eq!(
            SpannerDriver::statement_kind("-- c\nWITH x AS (SELECT 1) SELECT * FROM x"),
            StatementKind::Query
        );
        assert_eq!(
            SpannerDriver::statement_kind("UPDATE t SET a = 1"),
            StatementKind::Dml
        );
        assert_eq!(
            SpannerDriver::statement_kind("CREATE TABLE t (id INT64) PRIMARY KEY(id)"),
            StatementKind::Ddl
        );
        assert_eq!(
            SpannerDriver::statement_kind("DROP INDEX idx"),
            StatementKind::Ddl
        );
    }

    #[test]
    fn quotes_and_splits_table_names() {
        assert_eq!(
            SpannerDriver::qualify_table_name("Singers").expect("table"),
            "`Singers`"
        );
        assert_eq!(
            SpannerDriver::qualify_table_name("sch.Singers").expect("qualified"),
            "`sch`.`Singers`"
        );
        assert!(SpannerDriver::qualify_table_name("a.b.c").is_err());
        assert_eq!(
            SpannerDriver::split_table_reference("sch.t").expect("split"),
            ("sch".to_string(), "t".to_string())
        );
        assert_eq!(
            SpannerDriver::split_table_reference("t").expect("split"),
            (String::new(), "t".to_string())
        );
    }

    #[test]
    fn validates_database_names() {
        assert!(SpannerDriver::validate_database_name("my-db_1").is_ok());
        assert!(SpannerDriver::validate_database_name("").is_err());
        assert!(SpannerDriver::validate_database_name("a/b").is_err());
        assert!(SpannerDriver::validate_database_name("a b").is_err());
    }

    #[test]
    fn builds_transaction_urls() {
        let base = "https://spanner.googleapis.com";
        let session = "projects/p/instances/i/databases/d/sessions/sess-1";
        assert_eq!(
            SpannerDriver::begin_transaction_url(base, session),
            "https://spanner.googleapis.com/v1/projects/p/instances/i/databases/d/sessions/sess-1:beginTransaction"
        );
        assert_eq!(
            SpannerDriver::commit_url(base, session),
            "https://spanner.googleapis.com/v1/projects/p/instances/i/databases/d/sessions/sess-1:commit"
        );
        assert_eq!(
            SpannerDriver::rollback_url(base, session),
            "https://spanner.googleapis.com/v1/projects/p/instances/i/databases/d/sessions/sess-1:rollback"
        );
    }

    #[test]
    fn builds_execute_sql_body_with_transaction_and_query_mode() {
        // DML without an explicit transaction gets the single-use selector.
        let body = SpannerDriver::execute_sql_body("UPDATE t SET a = @p1", None, None, None);
        assert_eq!(
            body["transaction"],
            json!({ "singleUse": { "readWrite": {} } })
        );
        assert!(body.get("queryMode").is_none());

        // An open transaction id overrides the single-use selector.
        let body = SpannerDriver::execute_sql_body(
            "UPDATE t SET a = @p1",
            None,
            Some(json!({ "id": "txn-9" })),
            None,
        );
        assert_eq!(body["transaction"], json!({ "id": "txn-9" }));

        // EXPLAIN maps to queryMode=PLAN; binds ride along as params.
        let mut binds = SpannerBinds::default();
        binds.push(&json!("x")).expect("bind");
        let body = SpannerDriver::execute_sql_body(
            "SELECT * FROM t WHERE a = @p1",
            Some(&binds),
            None,
            Some("PLAN"),
        );
        assert_eq!(body["queryMode"], json!("PLAN"));
        assert_eq!(body["params"], json!({ "p1": "x" }));
        assert_eq!(body["paramTypes"], json!({ "p1": { "code": "STRING" } }));
        assert!(body.get("transaction").is_none());
    }

    #[test]
    fn strips_explain_prefixes() {
        assert_eq!(
            SpannerDriver::strip_explain_prefix("EXPLAIN SELECT 1"),
            Some(("SELECT 1", false))
        );
        assert_eq!(
            SpannerDriver::strip_explain_prefix("explain analyze select 1"),
            Some(("select 1", true))
        );
        assert_eq!(
            SpannerDriver::strip_explain_prefix("EXPLAIN (ANALYZE, COSTS) SELECT 1"),
            Some(("SELECT 1", true))
        );
        assert_eq!(
            SpannerDriver::strip_explain_prefix("-- note\nEXPLAIN SELECT 1"),
            Some(("SELECT 1", false))
        );
        assert_eq!(
            SpannerDriver::strip_explain_prefix("/* c */ EXPLAIN SELECT 1"),
            Some(("SELECT 1", false))
        );
        // Not an EXPLAIN: plain statements and look-alike identifiers pass through.
        assert_eq!(SpannerDriver::strip_explain_prefix("SELECT 1"), None);
        assert_eq!(
            SpannerDriver::strip_explain_prefix("EXPLAINS SELECT 1"),
            None
        );
        assert_eq!(SpannerDriver::strip_explain_prefix("EXPLAIN"), None);
    }

    #[test]
    fn maps_plan_response_to_single_row_result() {
        let response = json!({
            "stats": {
                "queryPlan": {
                    "planNodes": [
                        { "index": 0, "kind": "RELATIONAL", "displayName": "Table Scan" }
                    ]
                }
            }
        });
        let result = SpannerDriver::explain_result_from_execute_sql(response, 5, "SELECT * FROM t");
        assert_eq!(result.columns.len(), 1);
        assert_eq!(result.columns[0].name, "query_plan");
        assert_eq!(result.rows.len(), 1);
        let plan_text = result.rows[0][0].as_str().expect("plan text");
        let plan: JsonValue = serde_json::from_str(plan_text).expect("plan parses as JSON");
        assert_eq!(
            plan["queryPlan"]["planNodes"][0]["displayName"],
            json!("Table Scan")
        );
        assert_eq!(result.execution_time_ms, 5);
    }

    #[test]
    fn builds_cell_update_and_row_insert_dml() {
        let update = TableCellUpdateRequest {
            table: "Singers".to_string(),
            database: None,
            target_column: "Name".to_string(),
            value: json!("Ada"),
            primary_keys: vec![
                RowKeyValue {
                    column: "Id".to_string(),
                    value: json!(7),
                },
                RowKeyValue {
                    column: "Suffix".to_string(),
                    value: JsonValue::Null,
                },
            ],
        };
        let (sql, binds) = SpannerDriver::build_cell_update(&update).expect("update dml");
        assert_eq!(
            sql,
            "UPDATE `Singers` SET `Name` = @p1 WHERE `Id` = @p2 AND `Suffix` IS NULL"
        );
        assert_eq!(binds.params.get("p1"), Some(&json!("Ada")));
        assert_eq!(binds.params.get("p2"), Some(&json!("7")));

        let insert = TableRowInsertRequest {
            table: "Singers".to_string(),
            database: None,
            values: vec![
                ("Id".to_string(), json!(7)),
                ("Name".to_string(), JsonValue::Null),
            ],
        };
        let (sql, binds) = SpannerDriver::build_row_insert(&insert).expect("insert dml");
        assert_eq!(
            sql,
            "INSERT INTO `Singers` (`Id`, `Name`) VALUES (@p1, NULL)"
        );
        assert_eq!(binds.params.len(), 1);

        // Missing primary keys / values are rejected before any network call.
        let mut bad_update = update.clone();
        bad_update.primary_keys.clear();
        assert!(SpannerDriver::build_cell_update(&bad_update).is_err());
        let bad_insert = TableRowInsertRequest {
            table: "Singers".to_string(),
            database: None,
            values: Vec::new(),
        };
        assert!(SpannerDriver::build_row_insert(&bad_insert).is_err());
    }

    // -- Transaction lifecycle tests against a canned REST server ------------

    /// Minimal HTTP/1.1 server: serves `responses` in order, one per
    /// connection, and records every request line + body for assertions.
    fn serve_canned(responses: Vec<(u16, String)>) -> (String, Arc<std::sync::Mutex<Vec<String>>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let requests = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let sink = Arc::clone(&requests);
        std::thread::spawn(move || {
            use std::io::{Read, Write};
            for (status, payload) in responses {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                let mut buffer = Vec::new();
                let mut chunk = [0u8; 8192];
                let header_end = loop {
                    let Ok(read) = stream.read(&mut chunk) else {
                        return;
                    };
                    if read == 0 {
                        return;
                    }
                    buffer.extend_from_slice(&chunk[..read]);
                    if let Some(position) =
                        buffer.windows(4).position(|window| window == b"\r\n\r\n")
                    {
                        break position + 4;
                    }
                    if buffer.len() > 1 << 20 {
                        return;
                    }
                };
                let header_text = String::from_utf8_lossy(&buffer[..header_end]).to_string();
                let content_length = header_text
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        if name.trim().eq_ignore_ascii_case("content-length") {
                            value.trim().parse::<usize>().ok()
                        } else {
                            None
                        }
                    })
                    .unwrap_or(0);
                while buffer.len() < header_end + content_length {
                    let Ok(read) = stream.read(&mut chunk) else {
                        return;
                    };
                    if read == 0 {
                        break;
                    }
                    buffer.extend_from_slice(&chunk[..read]);
                }
                let request_line = header_text.lines().next().unwrap_or("").to_string();
                let body = String::from_utf8_lossy(&buffer[header_end..]).to_string();
                sink.lock()
                    .expect("requests lock")
                    .push(format!("{request_line}\n{body}"));
                let reason = if status == 200 { "OK" } else { "ERROR" };
                let response = format!(
                    "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                    payload.len()
                );
                if stream.write_all(response.as_bytes()).is_err() {
                    return;
                }
            }
        });
        (format!("http://127.0.0.1:{port}"), requests)
    }

    fn canned_driver(base_url: String) -> SpannerDriver {
        SpannerDriver {
            client: Client::new(),
            base_url,
            access_token: "test-token".to_string(),
            instance_path: "projects/p/instances/i".to_string(),
            database_path: RwLock::new("projects/p/instances/i/databases/d".to_string()),
            current_db: Arc::new(RwLock::new(Some("d".to_string()))),
            session: AsyncRwLock::new(None),
            cancel_registry: RwLock::new(QueryCancelRegistry::new()),
        }
    }

    fn session_ok() -> (u16, String) {
        (
            200,
            r#"{"name":"projects/p/instances/i/databases/d/sessions/s1"}"#.to_string(),
        )
    }

    fn begin_ok() -> (u16, String) {
        (200, r#"{"id":"txn-1"}"#.to_string())
    }

    fn empty_ok() -> (u16, String) {
        (200, "{}".to_string())
    }

    fn dml_ok(count: u64) -> (u16, String) {
        (200, format!(r#"{{"stats":{{"rowCountExact":"{count}"}}}}"#))
    }

    fn request_lines(requests: &Arc<std::sync::Mutex<Vec<String>>>) -> Vec<String> {
        requests
            .lock()
            .expect("requests lock")
            .iter()
            .map(|entry| entry.lines().next().unwrap_or("").to_string())
            .collect()
    }

    fn request_bodies(requests: &Arc<std::sync::Mutex<Vec<String>>>) -> Vec<String> {
        requests
            .lock()
            .expect("requests lock")
            .iter()
            .map(|entry| {
                entry
                    .split_once('\n')
                    .map(|(_, body)| body)
                    .unwrap_or("")
                    .to_string()
            })
            .collect()
    }

    fn cell_update(id: i64, name: &str) -> TableCellUpdateRequest {
        TableCellUpdateRequest {
            table: "Singers".to_string(),
            database: None,
            target_column: "Name".to_string(),
            value: json!(name),
            primary_keys: vec![RowKeyValue {
                column: "Id".to_string(),
                value: json!(id),
            }],
        }
    }

    fn row_insert(id: i64) -> TableRowInsertRequest {
        TableRowInsertRequest {
            table: "Singers".to_string(),
            database: None,
            values: vec![("Id".to_string(), json!(id))],
        }
    }

    #[tokio::test]
    async fn atomic_updates_commit_in_one_transaction() {
        let (base_url, requests) = serve_canned(vec![
            session_ok(),
            begin_ok(),
            dml_ok(1),
            dml_ok(1),
            empty_ok(),
        ]);
        let driver = canned_driver(base_url);
        let affected = driver
            .apply_table_updates_atomically(&[cell_update(1, "a"), cell_update(2, "b")])
            .await
            .expect("atomic updates");
        assert_eq!(affected, 2);

        let lines = request_lines(&requests);
        assert_eq!(lines.len(), 5);
        assert!(lines[1].contains(":beginTransaction"));
        assert!(lines[2].contains(":executeSql"));
        assert!(lines[3].contains(":executeSql"));
        assert!(lines[4].contains(":commit"));

        let bodies = request_bodies(&requests);
        // Both UPDATEs are pinned to the begun transaction, not singleUse.
        assert!(bodies[2].contains(r#""id":"txn-1""#));
        assert!(bodies[3].contains(r#""id":"txn-1""#));
        assert!(bodies[4].contains(r#""transactionId":"txn-1""#));
    }

    #[tokio::test]
    async fn atomic_updates_roll_back_on_zero_match() {
        let (base_url, requests) =
            serve_canned(vec![session_ok(), begin_ok(), dml_ok(0), empty_ok()]);
        let driver = canned_driver(base_url);
        let error = driver
            .apply_table_updates_atomically(&[cell_update(1, "a")])
            .await
            .expect_err("zero-row match must fail");
        assert!(error.to_string().contains("primary-key selector"));

        let lines = request_lines(&requests);
        assert_eq!(lines.len(), 4);
        assert!(lines[3].contains(":rollback"));
    }

    #[tokio::test]
    async fn atomic_updates_roll_back_on_statement_error() {
        let (base_url, requests) = serve_canned(vec![
            session_ok(),
            begin_ok(),
            (400, r#"{"error":{"message":"bad dml"}}"#.to_string()),
            empty_ok(),
        ]);
        let driver = canned_driver(base_url);
        let error = driver
            .apply_table_updates_atomically(&[cell_update(1, "a")])
            .await
            .expect_err("statement failure must fail the batch");
        assert!(error.to_string().contains("bad dml"));

        let lines = request_lines(&requests);
        assert_eq!(lines.len(), 4);
        assert!(lines[3].contains(":rollback"));
    }

    #[tokio::test]
    async fn atomic_inserts_roll_back_when_cancelled() {
        let (base_url, requests) = serve_canned(vec![session_ok(), begin_ok(), empty_ok()]);
        let driver = canned_driver(base_url);
        // Flag already set: the check between statements aborts before the
        // first INSERT executes and the transaction rolls back.
        let cancelled = Arc::new(AtomicBool::new(true));
        let error = driver
            .insert_table_rows_atomically(&[row_insert(1), row_insert(2)], cancelled)
            .await
            .expect_err("cancelled import must fail");
        assert!(error.to_string().contains("cancelled"));

        let lines = request_lines(&requests);
        assert_eq!(lines.len(), 3);
        assert!(lines[2].contains(":rollback"));
    }

    #[tokio::test]
    async fn streamed_import_rolls_back_on_parse_error() {
        let (base_url, requests) =
            serve_canned(vec![session_ok(), begin_ok(), dml_ok(1), empty_ok()]);
        let driver = canned_driver(base_url);
        let (sender, receiver) = tokio::sync::mpsc::channel(4);
        sender.send(Ok(row_insert(1))).await.expect("send row");
        sender
            .send(Err("bad csv row".to_string()))
            .await
            .expect("send error");
        drop(sender);

        let error = driver
            .insert_table_row_stream_atomically(receiver, Arc::new(AtomicBool::new(false)))
            .await
            .expect_err("parse error must fail the import");
        assert!(error.to_string().contains("bad csv row"));

        let lines = request_lines(&requests);
        assert_eq!(lines.len(), 4);
        assert!(lines[3].contains(":rollback"));
    }

    #[tokio::test]
    async fn streamed_import_rolls_back_on_empty_stream() {
        let (base_url, requests) = serve_canned(vec![session_ok(), begin_ok(), empty_ok()]);
        let driver = canned_driver(base_url);
        let (sender, receiver) = tokio::sync::mpsc::channel(4);
        drop(sender);
        let error = driver
            .insert_table_row_stream_atomically(receiver, Arc::new(AtomicBool::new(false)))
            .await
            .expect_err("empty stream must fail");
        assert!(error.to_string().contains("did not contain any data rows"));

        let lines = request_lines(&requests);
        assert_eq!(lines.len(), 3);
        assert!(lines[2].contains(":rollback"));
    }

    #[tokio::test]
    async fn preview_write_always_rolls_back() {
        let (base_url, requests) =
            serve_canned(vec![session_ok(), begin_ok(), dml_ok(2), empty_ok()]);
        let driver = canned_driver(base_url);
        let results = driver
            .preview_write_transaction(&["UPDATE Singers SET Name = 'x' WHERE Id = 1".to_string()])
            .await
            .expect("preview");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].affected_rows, 2);

        let lines = request_lines(&requests);
        assert_eq!(lines.len(), 4);
        assert!(lines[3].contains(":rollback"));
        assert!(lines.iter().all(|line| !line.contains(":commit")));
    }

    #[tokio::test]
    async fn preview_write_rejects_ddl() {
        let driver = canned_driver("http://127.0.0.1:1".to_string());
        let error = driver
            .preview_write_transaction(&["CREATE TABLE t (id INT64) PRIMARY KEY(id)".to_string()])
            .await
            .expect_err("DDL preview must be rejected");
        assert!(error.to_string().contains("cannot be rolled back"));
    }

    #[tokio::test]
    async fn explain_uses_plan_query_mode() {
        let (base_url, requests) = serve_canned(vec![
            session_ok(),
            (
                200,
                r#"{"stats":{"queryPlan":{"planNodes":[{"index":0,"displayName":"Table Scan"}]}}}"#
                    .to_string(),
            ),
        ]);
        let driver = canned_driver(base_url);
        let result = driver
            .execute_query("EXPLAIN SELECT * FROM Singers")
            .await
            .expect("explain");
        assert_eq!(result.columns[0].name, "query_plan");
        let plan_text = result.rows[0][0].as_str().expect("plan text");
        assert!(plan_text.contains("Table Scan"));

        let bodies = request_bodies(&requests);
        assert!(bodies[1].contains(r#""queryMode":"PLAN""#));
        // The EXPLAIN keyword is stripped — Spanner never sees it.
        assert!(bodies[1].contains(r#""sql":"SELECT * FROM Singers""#));
    }
}
