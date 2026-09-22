//! Shared import types and the streaming INSERT sink used by every format.
//!
//! `execute_import` verifies driver capability, optionally creates the target
//! table, then streams bounded parameterized INSERT batches with progress
//! events and cooperative cancellation.

use super::{DEFAULT_BATCH_SIZE, PROGRESS_ROW_STRIDE};
use crate::commands::table::CsvImportCancellationState;
use crate::database::manager::DatabaseManager;
use crate::database::models::{DatabaseType, QueryParameter, QueryParameterType};
use crate::database::parameterized_query::{
    compile_parameterized_query, placeholder_style_for_database,
};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportColumnMapping {
    /// Zero-based CSV column index.
    pub source_index: usize,
    /// Target column name in the database table.
    pub target_column: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub inserted_rows: usize,
    pub batches: usize,
    pub table_created: bool,
    /// True when the run stopped early because cancel_csv_import was called.
    pub cancelled: bool,
}

pub(super) fn quote_qualified_for(
    database_type: DatabaseType,
    qualified: &str,
) -> Result<String, String> {
    crate::commands::search::quote_qualified_identifier(database_type, qualified)
        .map_err(|error| error.to_string())
}

/// Builds one multi-row parameterized INSERT; cell values travel as named
/// bindings (`:r{row}c{col}`) compiled to engine placeholders, never into text.
/// Each mapping picks its source cell by `source_index`.
pub fn build_insert_batch(
    database_type: DatabaseType,
    table_sql: &str,
    mappings: &[ImportColumnMapping],
    rows: &[Vec<String>],
    batch_start: usize,
) -> Result<(String, Vec<QueryParameter>), String> {
    if rows.is_empty() {
        return Err("No rows in this batch.".to_string());
    }
    let column_sqls: Vec<String> = mappings
        .iter()
        .map(|mapping| quote_qualified_for(database_type, &mapping.target_column))
        .collect::<Result<Vec<String>, String>>()?;
    let mut parameters = Vec::new();
    let mut values_sql = Vec::with_capacity(rows.len());
    for (row_offset, record) in rows.iter().enumerate() {
        let placeholders: Vec<String> = mappings
            .iter()
            .enumerate()
            .map(|(map_index, mapping)| {
                let value = record
                    .get(mapping.source_index)
                    .cloned()
                    .unwrap_or_default();
                parameters.push(QueryParameter {
                    name: format!("r{}c{}", batch_start + row_offset, map_index),
                    value: serde_json::Value::String(value),
                    data_type: QueryParameterType::Text,
                });
                format!(":r{}c{}", batch_start + row_offset, map_index)
            })
            .collect();
        values_sql.push(format!("({})", placeholders.join(", ")));
    }
    Ok((
        format!(
            "INSERT INTO {table_sql} ({}) VALUES {}",
            column_sqls.join(", "),
            values_sql.join(", ")
        ),
        parameters,
    ))
}

/// Shared import sink for every format. Given a lazy row iterator (each item is
/// `(positional string cells, byte offset)`), it verifies driver capability,
/// optionally creates the target table, then streams bounded INSERT batches
/// with progress events and cooperative cancellation.
#[allow(clippy::too_many_arguments)]
pub(super) async fn execute_import<I>(
    connection_id: &str,
    table: &str,
    mappings: &[ImportColumnMapping],
    create_table: bool,
    batch_size: Option<usize>,
    operation_id: Option<String>,
    app: &AppHandle,
    cancellation_state: &CsvImportCancellationState,
    db_manager: &DatabaseManager,
    total_bytes: u64,
    rows: I,
) -> Result<ImportSummary, String>
where
    I: Iterator<Item = Result<(Vec<String>, u64), String>> + Send,
{
    db_manager.assert_write_allowed(connection_id).await?;
    if mappings.is_empty() {
        return Err("Import requires at least one column mapping.".to_string());
    }
    let database_type = db_manager
        .connection_database_type(connection_id)
        .await
        .map_err(|error| error.to_string())?;
    db_manager
        .require_capability(
            connection_id,
            crate::database::capabilities::DriverCapability::PreparedParameters,
        )
        .await
        .map_err(|error| error.to_string())?;
    let driver = db_manager
        .get_driver(connection_id)
        .await
        .map_err(|error| error.to_string())?;

    // Register with the shared cancellation state so cancel_csv_import can
    // stop this import; callers without an operation id get a local flag.
    let (cancelled, registered_operation_id) = match operation_id.as_deref() {
        Some(id) if !id.trim().is_empty() => (cancellation_state.start(id)?, Some(id.to_string())),
        _ => (Arc::new(AtomicBool::new(false)), None),
    };

    let table_sql = quote_qualified_for(database_type, table)?;

    let mut table_created = false;
    if create_table {
        let defs: Vec<String> = mappings
            .iter()
            .map(|mapping| {
                let name_sql = quote_qualified_for(database_type, &mapping.target_column)?;
                Ok(format!("{name_sql} TEXT"))
            })
            .collect::<Result<Vec<String>, String>>()?;
        let create_sql = format!("CREATE TABLE {table_sql} ({})", defs.join(", "));
        driver
            .execute_query(&create_sql)
            .await
            .map_err(|error| format!("Create table failed: {error}"))?;
        table_created = true;
    }

    let batch = batch_size.unwrap_or(DEFAULT_BATCH_SIZE).clamp(1, 1_000);
    let style = placeholder_style_for_database(database_type);
    // Consume the row iterator: memory holds one batch at a time, so file size
    // no longer decides memory use. The loop runs inside one async block so the
    // cancellation slot is ALWAYS released afterwards.
    let import_outcome = async {
        let mut pending: Vec<Vec<String>> = Vec::with_capacity(batch);
        let mut inserted_rows = 0usize;
        let mut batches = 0usize;
        let mut batch_index = 0usize;
        let mut next_progress_at = PROGRESS_ROW_STRIDE;
        let mut was_cancelled = false;
        #[allow(unused_assignments)]
        let mut last_byte = 0u64;

        for row in rows {
            if cancelled.load(Ordering::Relaxed) {
                was_cancelled = true;
                break;
            }
            let (cells, byte) = row?;
            last_byte = byte;
            pending.push(cells);
            if pending.len() < batch {
                continue;
            }
            let (sql, parameters) =
                build_insert_batch(database_type, &table_sql, mappings, &pending, batch_index)?;
            let compiled = compile_parameterized_query(&sql, &parameters, style)
                .map_err(|error| error.to_string())?;
            driver
                .execute_parameterized_query(&compiled.sql, &compiled.parameters)
                .await
                .map_err(|error| format!("Import batch {batch_index} failed: {error}"))?;
            inserted_rows += pending.len();
            batches += 1;
            batch_index += 1;
            pending.clear();

            if (inserted_rows as u64) >= next_progress_at {
                next_progress_at = inserted_rows as u64 + PROGRESS_ROW_STRIDE;
                let _ = app.emit(
                    "csv-import-progress",
                    serde_json::json!({
                        "operationId": registered_operation_id,
                        "processedRows": inserted_rows as u64,
                        "processedBytes": last_byte,
                        "totalBytes": total_bytes,
                    }),
                );
            }
        }

        if was_cancelled {
            return Ok(ImportSummary {
                inserted_rows,
                batches,
                table_created,
                cancelled: true,
            });
        }

        // Final partial batch.
        if !pending.is_empty() {
            let (sql, parameters) =
                build_insert_batch(database_type, &table_sql, mappings, &pending, batch_index)?;
            let compiled = compile_parameterized_query(&sql, &parameters, style)
                .map_err(|error| error.to_string())?;
            driver
                .execute_parameterized_query(&compiled.sql, &compiled.parameters)
                .await
                .map_err(|error| format!("Import batch {batch_index} failed: {error}"))?;
            inserted_rows += pending.len();
            batches += 1;
        }

        let _ = app.emit(
            "csv-import-progress",
            serde_json::json!({
                "operationId": registered_operation_id,
                "processedRows": inserted_rows as u64,
                "processedBytes": total_bytes,
                "totalBytes": total_bytes,
            }),
        );

        Ok(ImportSummary {
            inserted_rows,
            batches,
            table_created,
            cancelled: false,
        })
    }
    .await;

    if let Some(id) = registered_operation_id.as_deref() {
        cancellation_state.finish(id);
    }
    import_outcome
}
