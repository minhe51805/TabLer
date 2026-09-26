//! Rewind commands — capture a pre-image of the rows a grid write is about to
//! touch, then replay the inverse operation on restore.
//!
//! Capture is best-effort: an engine without `select_rows_by_keys` simply
//! produces no checkpoint (the write proceeds — rewind is a convenience, not a
//! gate). Restore is strict: it goes through the same capability checks,
//! safe-mode gate and `ensure_rows_affected` verification as the original
//! write commands.
use crate::commands::safe_mode::SafeModeState;
use crate::database::capabilities::DriverCapability;
use crate::database::manager::DatabaseManager;
use crate::database::models::{
    QueryResult, RowKeyValue, TableCellUpdateRequest, TableRowDeleteRequest, TableRowInsertRequest,
};
use crate::storage::checkpoint_store::{
    self, CheckpointKind, RewindCheckpoint, RewindCheckpointInfo, StoredRow,
};
use std::sync::Arc;
use tauri::State;

/// Capture the rows matching `selectors` before a write and persist an
/// encrypted checkpoint. Failures are logged and swallowed — a missing
/// checkpoint must never block the write it was guarding.
pub(crate) async fn capture_rewind_checkpoint(
    driver: &Arc<dyn crate::database::driver::DatabaseDriver>,
    connection_id: &str,
    table: &str,
    database: Option<&str>,
    kind: CheckpointKind,
    selectors: Vec<Vec<RowKeyValue>>,
    changed_columns: Vec<String>,
) {
    if selectors.is_empty() {
        return;
    }
    let results = match driver
        .select_rows_by_keys(table, database, &selectors)
        .await
    {
        Ok(results) => results,
        Err(error) => {
            eprintln!("[tabler] rewind capture skipped for {connection_id}/{table}: {error}");
            return;
        }
    };

    let rows = stored_rows_from_results(selectors, results);
    if rows.is_empty() {
        // Nothing matched — the write will hit the affected-rows guard anyway;
        // an empty checkpoint would restore nothing.
        return;
    }

    if let Err(error) = checkpoint_store::save_checkpoint(
        connection_id,
        table,
        database,
        kind,
        changed_columns,
        rows,
    ) {
        eprintln!("[tabler] rewind checkpoint write failed: {error}");
    }
}

/// Zips each selector with the rows it fetched, tagging every captured row
/// with the (column, value) pairs the driver returned. Extraction keeps the
/// selector↔result pairing testable — a misaligned zip silently restores the
/// wrong pre-image.
fn stored_rows_from_results(
    selectors: Vec<Vec<RowKeyValue>>,
    results: Vec<QueryResult>,
) -> Vec<StoredRow> {
    let mut rows = Vec::new();
    for (selector, result) in selectors.into_iter().zip(results) {
        let column_names: Vec<String> = result
            .columns
            .iter()
            .map(|column| column.name.clone())
            .collect();
        for row in result.rows {
            let values: Vec<(String, serde_json::Value)> =
                column_names.iter().cloned().zip(row).collect();
            rows.push(StoredRow {
                selector: selector.clone(),
                values,
            });
        }
    }
    rows
}

/// Refusals that can be decided from the checkpoint alone, in precedence
/// order — the same order `restore_rewind_checkpoint` has always applied:
/// a foreign payload reports mismatch before anything else is inspected.
fn early_rewind_refusal(checkpoint: &RewindCheckpoint, connection_id: &str) -> Option<RefusalCode> {
    if checkpoint.connection_id != connection_id {
        return Some(RefusalCode::ConnectionMismatch);
    }
    if checkpoint.rows.is_empty() {
        return Some(RefusalCode::EmptyCheckpoint);
    }
    let age_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
        .saturating_sub(checkpoint.created_at_ms);
    if age_ms > crate::storage::checkpoint_store::CHECKPOINT_TTL_MS {
        return Some(RefusalCode::CheckpointExpired);
    }
    None
}

/// Inverse of an Update checkpoint: one cell update per (row × changed
/// column), restoring the captured value — or NULL when the captured row had
/// no value recorded for that column.
fn build_update_restore_requests(checkpoint: &RewindCheckpoint) -> Vec<TableCellUpdateRequest> {
    let table = checkpoint.table.as_str();
    let database = checkpoint.database.as_deref();
    let mut updates = Vec::new();
    for row in &checkpoint.rows {
        for column in &checkpoint.changed_columns {
            let value = row
                .values
                .iter()
                .find(|(name, _)| name == column)
                .map(|(_, value)| value.clone())
                .unwrap_or(serde_json::Value::Null);
            updates.push(TableCellUpdateRequest {
                table: table.to_string(),
                database: database.map(str::to_string),
                target_column: column.clone(),
                value,
                primary_keys: row.selector.clone(),
            });
        }
    }
    updates
}

/// Inverse of a Delete checkpoint: re-insert every captured row verbatim.
fn build_insert_restore_requests(checkpoint: &RewindCheckpoint) -> Vec<TableRowInsertRequest> {
    checkpoint
        .rows
        .iter()
        .map(|row| TableRowInsertRequest {
            table: checkpoint.table.clone(),
            database: checkpoint.database.clone(),
            values: row.values.clone(),
        })
        .collect()
}

/// Inverse of an Insert checkpoint: delete the inserted rows by their
/// captured PK selectors.
fn build_delete_restore_request(checkpoint: &RewindCheckpoint) -> TableRowDeleteRequest {
    TableRowDeleteRequest {
        table: checkpoint.table.clone(),
        database: checkpoint.database.clone(),
        rows: checkpoint
            .rows
            .iter()
            .map(|row| row.selector.clone())
            .collect(),
    }
}

#[tauri::command]
pub async fn list_rewind_checkpoints(
    connection_id: String,
) -> Result<Vec<RewindCheckpointInfo>, String> {
    checkpoint_store::list_checkpoints(&connection_id)
}

#[tauri::command]
pub async fn delete_rewind_checkpoint(
    connection_id: String,
    checkpoint_id: String,
) -> Result<bool, String> {
    checkpoint_store::delete_checkpoint(&connection_id, &checkpoint_id)
}

/// Structured refusal — TablePro's `RewindRefusal` equivalent. A restore can
/// be denied before it touches the database; the reason tells the user which
/// guardrail stopped it (and whether the checkpoint survives).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RefusalCode {
    /// The engine cannot run the inverse write (missing capability).
    CapabilityMissing,
    /// Safe Mode / read-only policy forbids mutations on this connection.
    SafeModeBlocked,
    /// The connection itself is flagged read-only by the manager.
    ConnectionReadOnly,
    /// The checkpoint is older than `CHECKPOINT_TTL_MS` — its pre-image is
    /// too stale to trust over live rows.
    CheckpointExpired,
    /// The checkpoint belongs to another connection (should not happen — AAD
    /// binds blobs, but a foreign file may have been copied in).
    ConnectionMismatch,
    /// The payload decoded but has no rows to replay.
    EmptyCheckpoint,
    /// The inverse write ran but touched fewer rows than the checkpoint
    /// recorded — live data drifted. The checkpoint is KEPT so the user can
    /// reconcile manually instead of pretending the restore happened.
    RowDriftDetected,
}

/// Structured outcome of a restore attempt — `restored` is only set when the
/// inverse write fully verified. `refusals` is empty on success.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RewindRestoreOutcome {
    pub restored: Option<u64>,
    pub refusals: Vec<RefusalCode>,
}

impl RewindRestoreOutcome {
    fn ok(restored: u64) -> Self {
        Self {
            restored: Some(restored),
            refusals: Vec::new(),
        }
    }
    fn refused(code: RefusalCode) -> Self {
        Self {
            restored: None,
            refusals: vec![code],
        }
    }
}

/// Pre-flight checks shared by restore; returns `Some(code)` on the first
/// refusal, `None` when the restore may proceed.
async fn rewind_refusal_reason(
    db_manager: &DatabaseManager,
    connection_id: &str,
    capability: DriverCapability,
) -> Option<RefusalCode> {
    if db_manager
        .assert_write_allowed(connection_id)
        .await
        .is_err()
    {
        return Some(RefusalCode::ConnectionReadOnly);
    }
    if db_manager
        .require_capability(connection_id, capability)
        .await
        .is_err()
    {
        return Some(RefusalCode::CapabilityMissing);
    }
    None
}

/// Replay the inverse of a checkpointed write. The checkpoint file is consumed
/// on success — refusals keep it so the user can retry after fixing the cause.
#[tauri::command]
pub async fn restore_rewind_checkpoint(
    connection_id: String,
    checkpoint_id: String,
    db_manager: State<'_, DatabaseManager>,
    safe_mode: State<'_, SafeModeState>,
) -> Result<RewindRestoreOutcome, String> {
    let checkpoint: RewindCheckpoint =
        checkpoint_store::load_checkpoint(&connection_id, &checkpoint_id)?;
    if let Some(code) = early_rewind_refusal(&checkpoint, &connection_id) {
        return Ok(RewindRestoreOutcome::refused(code));
    }

    let database_type = db_manager
        .connection_database_type(&connection_id)
        .await
        .ok();
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(|e| e.to_string())?;

    let restored = match checkpoint.kind {
        // Restore = set the changed columns back to their captured values.
        CheckpointKind::Update => {
            if let Some(code) = rewind_refusal_reason(
                db_manager.inner(),
                &connection_id,
                DriverCapability::AtomicEditQueue,
            )
            .await
            {
                return Ok(RewindRestoreOutcome::refused(code));
            }
            if safe_mode
                .ensure_mutation_allowed(&connection_id, "UPDATE t SET c = NULL", database_type)
                .await
                .is_err()
            {
                return Ok(RewindRestoreOutcome::refused(RefusalCode::SafeModeBlocked));
            }
            let updates = build_update_restore_requests(&checkpoint);
            let expected = updates.len() as u64;
            let affected = driver
                .apply_table_updates_atomically(&updates)
                .await
                .map_err(|e| e.to_string())?;
            match crate::commands::table::ensure_rows_affected(
                "The rewind restore",
                expected,
                affected,
                "Some rows changed since the checkpoint was captured.",
            ) {
                Ok(count) => count,
                Err(_) => return Ok(RewindRestoreOutcome::refused(RefusalCode::RowDriftDetected)),
            }
        }
        // Restore = re-insert the captured rows.
        CheckpointKind::Delete => {
            if let Some(code) = rewind_refusal_reason(
                db_manager.inner(),
                &connection_id,
                DriverCapability::AtomicCsvImport,
            )
            .await
            {
                return Ok(RewindRestoreOutcome::refused(code));
            }
            if safe_mode
                .ensure_mutation_allowed(
                    &connection_id,
                    "INSERT INTO t (c) VALUES (NULL)",
                    database_type,
                )
                .await
                .is_err()
            {
                return Ok(RewindRestoreOutcome::refused(RefusalCode::SafeModeBlocked));
            }
            let requests = build_insert_restore_requests(&checkpoint);
            let expected = requests.len() as u64;
            let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let affected = driver
                .insert_table_rows_atomically(&requests, cancelled)
                .await
                .map_err(|e| e.to_string())?;
            match crate::commands::table::ensure_rows_affected(
                "The rewind restore",
                expected,
                affected,
                "Some rows could not be re-inserted.",
            ) {
                Ok(count) => count,
                Err(_) => return Ok(RewindRestoreOutcome::refused(RefusalCode::RowDriftDetected)),
            }
        }
        // Restore = delete the rows the original write inserted, by their
        // captured PK selectors.
        CheckpointKind::Insert => {
            if let Some(code) = rewind_refusal_reason(
                db_manager.inner(),
                &connection_id,
                DriverCapability::InlineEdit,
            )
            .await
            {
                return Ok(RewindRestoreOutcome::refused(code));
            }
            if safe_mode
                .ensure_mutation_allowed(&connection_id, "DELETE FROM t", database_type)
                .await
                .is_err()
            {
                return Ok(RewindRestoreOutcome::refused(RefusalCode::SafeModeBlocked));
            }
            let request = build_delete_restore_request(&checkpoint);
            let expected = request.rows.len() as u64;
            let affected = driver
                .delete_table_rows(&request)
                .await
                .map_err(|e| e.to_string())?;
            match crate::commands::table::ensure_rows_affected(
                "The rewind restore",
                expected,
                affected,
                "Some inserted rows are already gone or changed.",
            ) {
                Ok(count) => count,
                Err(_) => return Ok(RewindRestoreOutcome::refused(RefusalCode::RowDriftDetected)),
            }
        }
    };
    // The checkpoint served its purpose; remove it so a second restore does
    // not replay stale values over newer data.
    checkpoint_store::delete_checkpoint(&connection_id, &checkpoint_id)?;
    Ok(RewindRestoreOutcome::ok(restored))
}

#[cfg(test)]
mod tests {
    use super::{
        build_delete_restore_request, build_insert_restore_requests, build_update_restore_requests,
        early_rewind_refusal, stored_rows_from_results, RefusalCode, RewindRestoreOutcome,
    };
    use crate::database::models::{ColumnInfo, QueryResult, RowKeyValue};
    use crate::storage::checkpoint_store::{
        CheckpointKind, RewindCheckpoint, StoredRow, CHECKPOINT_TTL_MS,
    };
    use serde_json::json;

    fn key(column: &str, value: serde_json::Value) -> RowKeyValue {
        RowKeyValue {
            column: column.to_string(),
            value,
        }
    }

    fn query_result(columns: &[&str], rows: Vec<Vec<serde_json::Value>>) -> QueryResult {
        QueryResult {
            columns: columns
                .iter()
                .map(|name| ColumnInfo {
                    name: (*name).to_string(),
                    data_type: "text".to_string(),
                    is_nullable: true,
                    is_primary_key: false,
                    max_length: None,
                    default_value: None,
                })
                .collect(),
            rows,
            affected_rows: 0,
            execution_time_ms: 0,
            query: String::new(),
            sandboxed: false,
            truncated: false,
        }
    }

    fn make_checkpoint(kind: CheckpointKind, rows: Vec<StoredRow>) -> RewindCheckpoint {
        RewindCheckpoint {
            id: "cp1".to_string(),
            connection_id: "conn1".to_string(),
            table: "users".to_string(),
            database: Some("app".to_string()),
            kind,
            changed_columns: Vec::new(),
            rows,
            created_at_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
        }
    }

    #[test]
    fn capture_zips_each_selector_with_its_own_result_rows() {
        let selectors = vec![vec![key("id", json!(1))], vec![key("id", json!(2))]];
        let results = vec![
            query_result(
                &["id", "name"],
                vec![vec![json!(1), json!("a")], vec![json!(1), json!("b")]],
            ),
            query_result(&["id", "name"], vec![vec![json!(2), json!("c")]]),
        ];
        let stored = stored_rows_from_results(selectors, results);
        assert_eq!(stored.len(), 3);
        // The first selector's two rows keep its PK; the second selector's
        // row keeps the second PK — a misaligned zip would swap them.
        assert_eq!(stored[0].selector[0].value, json!(1));
        assert_eq!(stored[0].values[0], ("id".to_string(), json!(1)));
        assert_eq!(stored[1].values[1], ("name".to_string(), json!("b")));
        assert_eq!(stored[2].selector[0].value, json!(2));
        assert_eq!(stored[2].values[1], ("name".to_string(), json!("c")));
    }

    #[test]
    fn update_restore_emits_one_update_per_row_and_changed_column() {
        let mut checkpoint = make_checkpoint(
            CheckpointKind::Update,
            vec![
                StoredRow {
                    selector: vec![key("id", json!(1))],
                    values: vec![
                        ("name".to_string(), json!("a")),
                        ("email".to_string(), json!("a@x")),
                    ],
                },
                StoredRow {
                    selector: vec![key("id", json!(2))],
                    // This row never captured "email" — restore must write NULL,
                    // not skip the cell or borrow the other row's value.
                    values: vec![("name".to_string(), json!("c"))],
                },
            ],
        );
        checkpoint.changed_columns = vec!["name".to_string(), "email".to_string()];

        let updates = build_update_restore_requests(&checkpoint);
        assert_eq!(updates.len(), 4);
        assert_eq!(updates[0].target_column, "name");
        assert_eq!(updates[0].value, json!("a"));
        assert_eq!(updates[0].primary_keys[0].column, "id");
        assert_eq!(updates[1].target_column, "email");
        assert_eq!(updates[1].value, json!("a@x"));
        assert_eq!(updates[2].value, json!("c"));
        assert_eq!(updates[3].target_column, "email");
        assert_eq!(updates[3].value, serde_json::Value::Null);
        assert_eq!(updates[3].primary_keys[0].value, json!(2));
        assert_eq!(updates[3].table, "users");
        assert_eq!(updates[3].database.as_deref(), Some("app"));
    }

    #[test]
    fn delete_restore_reinserts_rows_and_insert_restore_deletes_by_selector() {
        let checkpoint = make_checkpoint(
            CheckpointKind::Delete,
            vec![
                StoredRow {
                    selector: vec![key("id", json!(1))],
                    values: vec![("name".to_string(), json!("a"))],
                },
                StoredRow {
                    selector: vec![key("id", json!(2))],
                    values: vec![("name".to_string(), json!("b"))],
                },
            ],
        );

        let inserts = build_insert_restore_requests(&checkpoint);
        assert_eq!(inserts.len(), 2);
        assert_eq!(inserts[1].values[0], ("name".to_string(), json!("b")));
        assert_eq!(inserts[1].table, "users");

        let delete = build_delete_restore_request(&checkpoint);
        assert_eq!(delete.rows.len(), 2);
        assert_eq!(delete.rows[0][0].value, json!(1));
        assert_eq!(delete.rows[1][0].value, json!(2));
    }

    #[test]
    fn early_refusals_follow_mismatch_then_empty_then_expired() {
        let row = StoredRow {
            selector: vec![key("id", json!(1))],
            values: vec![],
        };

        // Foreign connection always wins, even over an empty payload.
        let mut checkpoint = make_checkpoint(CheckpointKind::Update, vec![]);
        checkpoint.connection_id = "other".to_string();
        assert_eq!(
            early_rewind_refusal(&checkpoint, "conn1"),
            Some(RefusalCode::ConnectionMismatch)
        );

        // Empty beats expired: a checkpoint that is BOTH reports empty.
        let mut checkpoint = make_checkpoint(CheckpointKind::Update, vec![]);
        checkpoint.created_at_ms = 0;
        assert_eq!(
            early_rewind_refusal(&checkpoint, "conn1"),
            Some(RefusalCode::EmptyCheckpoint)
        );

        // A row-bearing but ancient checkpoint is expired.
        let mut checkpoint = make_checkpoint(CheckpointKind::Update, vec![row.clone()]);
        checkpoint.created_at_ms = 0;
        assert_eq!(
            early_rewind_refusal(&checkpoint, "conn1"),
            Some(RefusalCode::CheckpointExpired)
        );

        // Fresh, row-bearing, same-connection → no early refusal.
        let checkpoint = make_checkpoint(CheckpointKind::Update, vec![row]);
        assert_eq!(early_rewind_refusal(&checkpoint, "conn1"), None);

        // Boundary: exactly TTL old is still within the window.
        let mut checkpoint = make_checkpoint(
            CheckpointKind::Update,
            vec![StoredRow {
                selector: vec![key("id", json!(1))],
                values: vec![],
            }],
        );
        checkpoint.created_at_ms = checkpoint.created_at_ms.saturating_sub(CHECKPOINT_TTL_MS);
        assert_eq!(early_rewind_refusal(&checkpoint, "conn1"), None);
    }

    #[test]
    fn refused_outcome_carries_no_restore_count() {
        let outcome = RewindRestoreOutcome::refused(RefusalCode::SafeModeBlocked);
        assert!(outcome.restored.is_none());
        assert_eq!(outcome.refusals, vec![RefusalCode::SafeModeBlocked]);
    }
}
