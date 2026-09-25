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
    RowKeyValue, TableCellUpdateRequest, TableRowDeleteRequest, TableRowInsertRequest,
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

/// Replay the inverse of a checkpointed write. The checkpoint file is consumed
/// on success — a failed restore keeps it so the user can retry.
#[tauri::command]
pub async fn restore_rewind_checkpoint(
    connection_id: String,
    checkpoint_id: String,
    db_manager: State<'_, DatabaseManager>,
    safe_mode: State<'_, SafeModeState>,
) -> Result<u64, String> {
    let checkpoint: RewindCheckpoint =
        checkpoint_store::load_checkpoint(&connection_id, &checkpoint_id)?;
    if checkpoint.connection_id != connection_id {
        return Err("Checkpoint belongs to a different connection.".to_string());
    }
    if checkpoint.rows.is_empty() {
        return Err("Checkpoint contains no rows to restore.".to_string());
    }

    db_manager.assert_write_allowed(&connection_id).await?;
    let database_type = db_manager
        .connection_database_type(&connection_id)
        .await
        .ok();
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(|e| e.to_string())?;
    let table = checkpoint.table.as_str();
    let database = checkpoint.database.as_deref();

    let restored = match checkpoint.kind {
        // Restore = set the changed columns back to their captured values.
        CheckpointKind::Update => {
            safe_mode
                .ensure_mutation_allowed(&connection_id, "UPDATE t SET c = NULL", database_type)
                .await?;
            db_manager
                .require_capability(&connection_id, DriverCapability::AtomicEditQueue)
                .await
                .map_err(|e| e.to_string())?;
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
            let expected = updates.len() as u64;
            let affected = driver
                .apply_table_updates_atomically(&updates)
                .await
                .map_err(|e| e.to_string())?;
            crate::commands::table::ensure_rows_affected(
                "The rewind restore",
                expected,
                affected,
                "Some rows changed since the checkpoint was captured — reload the table and retry.",
            )?
        }
        // Restore = re-insert the captured rows.
        CheckpointKind::Delete => {
            safe_mode
                .ensure_mutation_allowed(
                    &connection_id,
                    "INSERT INTO t (c) VALUES (NULL)",
                    database_type,
                )
                .await?;
            db_manager
                .require_capability(&connection_id, DriverCapability::AtomicCsvImport)
                .await
                .map_err(|e| e.to_string())?;
            let requests: Vec<TableRowInsertRequest> = checkpoint
                .rows
                .iter()
                .map(|row| TableRowInsertRequest {
                    table: table.to_string(),
                    database: database.map(str::to_string),
                    values: row.values.clone(),
                })
                .collect();
            let expected = requests.len() as u64;
            let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let affected = driver
                .insert_table_rows_atomically(&requests, cancelled)
                .await
                .map_err(|e| e.to_string())?;
            crate::commands::table::ensure_rows_affected(
                "The rewind restore",
                expected,
                affected,
                "Some rows could not be re-inserted — check for conflicts with rows added since the delete.",
            )?
        }
        // Restore = delete the rows the original write inserted, by their
        // captured PK selectors.
        CheckpointKind::Insert => {
            safe_mode
                .ensure_mutation_allowed(&connection_id, "DELETE FROM t", database_type)
                .await?;
            db_manager
                .require_capability(&connection_id, DriverCapability::InlineEdit)
                .await
                .map_err(|e| e.to_string())?;
            let request = TableRowDeleteRequest {
                table: table.to_string(),
                database: database.map(str::to_string),
                rows: checkpoint
                    .rows
                    .iter()
                    .map(|row| row.selector.clone())
                    .collect(),
            };
            let expected = request.rows.len() as u64;
            let affected = driver
                .delete_table_rows(&request)
                .await
                .map_err(|e| e.to_string())?;
            crate::commands::table::ensure_rows_affected(
                "The rewind restore",
                expected,
                affected,
                "Some inserted rows are already gone or changed — verify the table contents.",
            )?
        }
    };

    // The checkpoint served its purpose; remove it so a second restore does
    // not replay stale values over newer data.
    checkpoint_store::delete_checkpoint(&connection_id, &checkpoint_id)?;
    Ok(restored)
}
