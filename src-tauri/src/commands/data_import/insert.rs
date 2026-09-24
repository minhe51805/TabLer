//! Shared import types and the streaming INSERT sink used by every format.
//!
//! `execute_import` verifies driver capability, optionally creates the target
//! table, then streams bounded parameterized INSERT batches with progress
//! events and cooperative cancellation.
//!
//! Batch atomicity: every batch is sent as ONE multi-row `INSERT ... VALUES
//! (...), (...)` statement, so each batch is atomic on every engine that
//! implements `execute_parameterized_query` (all of them are SQL drivers —
//! a single DML statement is atomic by definition). No explicit transaction
//! wrapper is needed; a failed batch either lands completely or not at all,
//! and the summary reports exactly which rows made it.

use super::{DEFAULT_BATCH_SIZE, PROGRESS_ROW_STRIDE};
use crate::commands::table::CsvImportCancellationState;
use crate::database::manager::DatabaseManager;
use crate::database::models::{DatabaseType, QueryParameter, QueryParameterType};
use crate::database::parameterized_query::{
    compile_parameterized_query, placeholder_style_for_database,
};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

/// Row-level parse/validation failures are recorded in the rejected-row
/// report and skipped; beyond this many the file is almost certainly not the
/// format the user picked, so the import aborts instead of silently dropping
/// a large share of the input.
const MAX_REJECTED_ROWS: usize = 10_000;

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
    /// Rows the driver confirmed inserted (falls back to the batch size when
    /// a driver does not report affected rows).
    pub inserted_rows: usize,
    pub batches: usize,
    pub table_created: bool,
    /// True when the run stopped early because cancel_csv_import was called.
    pub cancelled: bool,
    /// Rows skipped because they could not be parsed; details are in the
    /// rejected-row report when `rejection_report` is set.
    pub rejected_rows: usize,
    /// Rows read from the file but never inserted (the failed batch plus
    /// everything after it when the run aborted early).
    pub failed_rows: usize,
    /// Set when the run stopped before consuming the whole file: the batch
    /// error, a row-parse abort, or a cancellation. Absent on a clean finish.
    pub error: Option<String>,
    /// Path of the `.tabler-rejected.csv` report, when one was written.
    pub rejection_report: Option<String>,
    /// Non-fatal problems worth surfacing (e.g. the rejection report could
    /// not be written to a read-only directory).
    pub warnings: Vec<String>,
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
/// Each mapping picks its source cell by `source_index`. `None` cells bind as
/// SQL NULL (the CSV `\N` marker), `Some` cells bind as text.
pub fn build_insert_batch(
    database_type: DatabaseType,
    table_sql: &str,
    mappings: &[ImportColumnMapping],
    rows: &[Vec<Option<String>>],
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
                let cell = record.get(mapping.source_index).cloned().flatten();
                // NULL cells bind with the Null parameter type — Text would
                // reject a non-string value at bind time.
                let (value, data_type) = match cell {
                    Some(text) => (serde_json::Value::String(text), QueryParameterType::Text),
                    None => (serde_json::Value::Null, QueryParameterType::Null),
                };
                parameters.push(QueryParameter {
                    name: format!("r{}c{}", batch_start + row_offset, map_index),
                    value,
                    data_type,
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

/// CREATE TABLE for the import target. Engines that support it get
/// `IF NOT EXISTS` so re-running an import appends instead of erroring;
/// MSSQL lacks the clause, so existence is checked via `list_tables` first
/// and a plain CREATE is emitted only when the table is missing.
fn create_table_sql(database_type: DatabaseType, table_sql: &str, defs: &[String]) -> String {
    let if_not_exists = match database_type {
        // MSSQL and Oracle (pre-23c) lack IF NOT EXISTS; existence is checked
        // via `list_tables` first and a plain CREATE is emitted when missing.
        DatabaseType::MSSQL | DatabaseType::Oracle => "",
        _ => "IF NOT EXISTS ",
    };
    format!(
        "CREATE TABLE {if_not_exists}{table_sql} ({})",
        defs.join(", ")
    )
}

/// True when `table` (possibly `schema.name`) already shows up in the
/// driver's table list. Used for MSSQL, which has no IF NOT EXISTS, and as a
/// cheap short-circuit everywhere else.
async fn table_already_exists(
    driver: &dyn crate::database::driver::DatabaseDriver,
    table: &str,
) -> bool {
    let bare = table
        .rsplit('.')
        .next()
        .map(str::trim)
        .unwrap_or_default()
        .trim_matches(|ch| ch == '"' || ch == '`' || ch == '[' || ch == ']');
    if bare.is_empty() {
        return false;
    }
    match driver.list_tables(None).await {
        Ok(tables) => tables
            .iter()
            .any(|info| info.name.eq_ignore_ascii_case(bare)),
        Err(_) => false,
    }
}

/// Lazily opened rejected-row report writer. A write failure never aborts
/// the import — it is recorded as a summary warning instead, so a read-only
/// source directory cannot silently lose the report.
struct RejectionReport {
    writer: Option<csv::Writer<std::fs::File>>,
    path: Option<std::path::PathBuf>,
    disabled: bool,
}

impl RejectionReport {
    fn new(path: Option<std::path::PathBuf>) -> Self {
        Self {
            writer: None,
            path,
            disabled: false,
        }
    }

    /// Records one rejected row; returns a warning when the report could not
    /// be written (the rejection itself is still counted by the caller).
    fn record(&mut self, source_row: usize, reason: &str) -> Option<String> {
        if self.disabled {
            return None;
        }
        let Some(path) = self.path.clone() else {
            self.disabled = true;
            return None;
        };
        if self.writer.is_none() {
            match csv::Writer::from_path(&path) {
                Ok(mut writer) => {
                    if let Err(error) = writer.write_record(["source_row", "reason"]) {
                        self.disabled = true;
                        return Some(format!(
                            "Rejected-row report '{}' could not be written: {error}",
                            path.display()
                        ));
                    }
                    self.writer = Some(writer);
                }
                Err(error) => {
                    self.disabled = true;
                    return Some(format!(
                        "Rejected-row report '{}' could not be created: {error}",
                        path.display()
                    ));
                }
            }
        }
        let writer = self.writer.as_mut()?;
        if let Err(error) = writer.write_record([source_row.to_string(), reason.to_string()]) {
            self.disabled = true;
            return Some(format!(
                "Rejected-row report '{}' could not be written: {error}",
                path.display()
            ));
        }
        if let Err(error) = writer.flush() {
            self.disabled = true;
            return Some(format!(
                "Rejected-row report '{}' could not be written: {error}",
                path.display()
            ));
        }
        None
    }

    fn report_path(&self) -> Option<String> {
        if self.writer.is_some() {
            self.path
                .as_ref()
                .map(|path| path.to_string_lossy().to_string())
        } else {
            None
        }
    }
}

/// Shared import sink for every format. Given a lazy row iterator (each item is
/// `(positional cells, byte offset)` where `None` cells bind as SQL NULL), it
/// verifies driver capability, optionally creates the target table, then
/// streams bounded INSERT batches with progress events and cooperative
/// cancellation.
///
/// The returned summary always describes the real end state: `error` is set
/// when the run stopped before consuming the file, `rejected_rows` counts
/// skipped malformed rows, and `failed_rows` counts rows that were read but
/// never inserted. `rejection_path` points at the `.tabler-rejected.csv`
/// report written next to the source file.
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
    rejection_path: Option<&Path>,
    rows: I,
) -> Result<ImportSummary, String>
where
    I: Iterator<Item = Result<(Vec<Option<String>>, u64), String>> + Send,
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
        // IF NOT EXISTS keeps a re-run from erroring on most engines; MSSQL
        // lacks the clause, so it checks the catalog first and skips CREATE.
        let exists = table_already_exists(&*driver, table).await;
        if !exists || database_type != DatabaseType::MSSQL {
            let create_sql = create_table_sql(database_type, &table_sql, &defs);
            driver
                .execute_query(&create_sql)
                .await
                .map_err(|error| format!("Create table failed: {error}"))?;
            table_created = !exists;
        }
    }

    let batch = batch_size.unwrap_or(DEFAULT_BATCH_SIZE).clamp(1, 1_000);
    let style = placeholder_style_for_database(database_type);
    let rejection_path = rejection_path.map(|path| path.to_path_buf());
    // Consume the row iterator: memory holds one batch at a time, so file size
    // no longer decides memory use. The loop runs inside one async block so the
    // cancellation slot is ALWAYS released afterwards.
    let import_outcome = async {
        let mut pending: Vec<Vec<Option<String>>> = Vec::with_capacity(batch);
        let mut inserted_rows = 0usize;
        let mut rejected_rows = 0usize;
        let mut consumed_rows = 0usize;
        let mut batches = 0usize;
        let mut batch_index = 0usize;
        let mut next_progress_at = PROGRESS_ROW_STRIDE;
        let mut was_cancelled = false;
        let mut abort_error: Option<String> = None;
        let mut warnings: Vec<String> = Vec::new();
        let mut report = RejectionReport::new(rejection_path);
        #[allow(unused_assignments)]
        let mut last_byte = 0u64;
        let mut source_row = 0usize;

        for row in rows {
            if cancelled.load(Ordering::Relaxed) {
                was_cancelled = true;
                break;
            }
            source_row += 1;
            let (cells, byte) = match row {
                Ok(parsed) => parsed,
                Err(error) => {
                    // Malformed source row: record it in the rejection report
                    // and skip it rather than aborting the whole file.
                    rejected_rows += 1;
                    if let Some(warning) = report.record(source_row, &error) {
                        warnings.push(warning);
                    }
                    if rejected_rows >= MAX_REJECTED_ROWS {
                        abort_error = Some(format!(
                            "Import aborted after {MAX_REJECTED_ROWS} rejected rows; the file does not look like the selected format."
                        ));
                        break;
                    }
                    continue;
                }
            };
            last_byte = byte;
            consumed_rows += 1;
            pending.push(cells);
            if pending.len() < batch {
                continue;
            }
            match flush_batch(
                &*driver,
                database_type,
                &table_sql,
                mappings,
                &mut pending,
                batch_index,
                style,
            )
            .await
            {
                Ok(inserted) => {
                    inserted_rows += inserted;
                    batches += 1;
                    batch_index += 1;
                }
                Err(error) => {
                    abort_error = Some(error);
                    break;
                }
            }

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

        // Final partial batch — only when the loop finished cleanly.
        if abort_error.is_none() && !was_cancelled && !pending.is_empty() {
            match flush_batch(
                &*driver,
                database_type,
                &table_sql,
                mappings,
                &mut pending,
                batch_index,
                style,
            )
            .await
            {
                Ok(inserted) => {
                    inserted_rows += inserted;
                    batches += 1;
                }
                Err(error) => {
                    abort_error = Some(error);
                }
            }
        }

        // Rows read but never inserted: the failed batch plus whatever was
        // still buffered when the run stopped.
        let failed_rows = consumed_rows.saturating_sub(inserted_rows + rejected_rows);
        if was_cancelled && abort_error.is_none() {
            abort_error = Some("Import cancelled by user.".to_string());
        }

        let _ = app.emit(
            "csv-import-progress",
            serde_json::json!({
                "operationId": registered_operation_id,
                "processedRows": inserted_rows as u64,
                "processedBytes": if abort_error.is_some() { last_byte } else { total_bytes },
                "totalBytes": total_bytes,
            }),
        );

        Ok(ImportSummary {
            inserted_rows,
            batches,
            table_created,
            cancelled: was_cancelled,
            rejected_rows,
            failed_rows,
            error: abort_error,
            rejection_report: report.report_path(),
            warnings,
        })
    }
    .await;

    if let Some(id) = registered_operation_id.as_deref() {
        cancellation_state.finish(id);
    }
    import_outcome
}

/// Sends one buffered batch as a single multi-row INSERT (atomic per batch)
/// and returns how many rows the driver reported inserted. Drivers that do
/// not report affected rows fall back to the batch size.
async fn flush_batch(
    driver: &dyn crate::database::driver::DatabaseDriver,
    database_type: DatabaseType,
    table_sql: &str,
    mappings: &[ImportColumnMapping],
    pending: &mut Vec<Vec<Option<String>>>,
    batch_index: usize,
    style: crate::database::parameterized_query::PlaceholderStyle,
) -> Result<usize, String> {
    let attempted = pending.len();
    let (sql, parameters) =
        build_insert_batch(database_type, table_sql, mappings, pending, batch_index)?;
    let compiled =
        compile_parameterized_query(&sql, &parameters, style).map_err(|error| error.to_string())?;
    let result = driver
        .execute_parameterized_query(&compiled.sql, &compiled.parameters)
        .await
        .map_err(|error| format!("Import batch {batch_index} failed: {error}"))?;
    pending.clear();
    let reported = usize::try_from(result.affected_rows).unwrap_or(usize::MAX);
    Ok(if reported == 0 { attempted } else { reported })
}
