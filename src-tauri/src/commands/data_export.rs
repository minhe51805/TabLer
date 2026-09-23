use crate::database::capabilities::DriverCapability;
use crate::database::manager::DatabaseManager;
use crate::database::models::QueryResult;
use futures_util::TryStreamExt;
use rfd::FileDialog;
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, Emitter, State};
use tokio::io::AsyncWriteExt;
use tokio::time::{timeout, Duration};
use uuid::Uuid;

const EXPORT_BATCH_SIZE: u64 = 1_000;
const EXPORT_BATCH_TIMEOUT: Duration = Duration::from_secs(5 * 60);

#[derive(Default)]
pub struct TableExportCancellationState {
    exports: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl TableExportCancellationState {
    fn start(&self, operation_id: &str) -> Result<Arc<AtomicBool>, String> {
        if operation_id.trim().is_empty() {
            return Err("Export operation identifier is required.".to_string());
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        self.exports
            .lock()
            .map_err(|_| "Export cancellation state is unavailable.".to_string())?
            .insert(operation_id.to_string(), cancelled.clone());
        Ok(cancelled)
    }

    fn finish(&self, operation_id: &str) {
        if let Ok(mut exports) = self.exports.lock() {
            exports.remove(operation_id);
        }
    }

    fn cancel(&self, operation_id: &str) -> bool {
        let Ok(exports) = self.exports.lock() else {
            return false;
        };
        let Some(cancelled) = exports.get(operation_id) else {
            return false;
        };
        cancelled.store(true, Ordering::Relaxed);
        true
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDataExportRequest {
    table: String,
    database: Option<String>,
    format: String,
    order_by: Option<String>,
    order_dir: Option<String>,
    filter: Option<String>,
    /// When true, an existing destination file is replaced. When false/absent
    /// and the picked path exists, the command fails with
    /// `TABLER_EXPORT_FILE_EXISTS` so the UI can show an overwrite-confirm
    /// dialog and retry with this flag set.
    #[serde(default)]
    overwrite: bool,
}

/// Error prefix the frontend matches to trigger its overwrite-confirm flow.
pub const EXPORT_FILE_EXISTS_CODE: &str = "TABLER_EXPORT_FILE_EXISTS";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDataExportResult {
    file_path: String,
    format: String,
    row_count: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkTableExportRequest {
    /// Qualified or bare table names to export, in selection order.
    tables: Vec<String>,
    database: Option<String>,
    format: String,
    /// Directory the frontend picked once for the whole batch.
    directory: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkTableExportFailure {
    table: String,
    error: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkTableExportResult {
    /// One entry per successfully written file.
    exported: Vec<TableDataExportResult>,
    /// Tables that failed; the batch continues past individual failures.
    failed: Vec<BulkTableExportFailure>,
    cancelled: bool,
}

/// Bulk export: streams every selected table into one chosen directory using
/// the same batching/serialization path as `export_table_data`, but skips the
/// per-file save dialog. Existing files are never overwritten — a `-N` suffix
/// is appended instead, matching the single-export "pick a new name" rule.
#[tauri::command]
pub async fn export_tables_to_directory(
    connection_id: String,
    request: BulkTableExportRequest,
    operation_id: String,
    app: AppHandle,
    db_manager: State<'_, DatabaseManager>,
    cancellation_state: State<'_, TableExportCancellationState>,
) -> Result<BulkTableExportResult, String> {
    db_manager
        .require_capability(&connection_id, DriverCapability::DataExport)
        .await
        .map_err(|e| e.to_string())?;
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(|e| e.to_string())?;
    let (format, extension) = match request.format.as_str() {
        "csv" => ("csv", "csv"),
        "jsonl" => ("jsonl", "jsonl"),
        _ => return Err("Table export format must be 'csv' or 'jsonl'.".to_string()),
    };
    if request.tables.is_empty() {
        return Err("Select at least one table to export.".to_string());
    }
    let directory = PathBuf::from(request.directory.trim());
    if !directory.is_dir() {
        return Err("Choose an existing directory for the bulk export.".to_string());
    }

    let cancelled = cancellation_state.start(&operation_id)?;
    let mut exported = Vec::new();
    let mut failed = Vec::new();
    let mut was_cancelled = false;

    for table in &request.tables {
        if cancelled.load(Ordering::Relaxed) {
            was_cancelled = true;
            break;
        }
        let target_path = unique_export_path(&directory, table, extension);
        let temporary_path = temporary_export_path(&target_path);
        let table_request = TableDataExportRequest {
            table: table.clone(),
            database: request.database.clone(),
            format: format.to_string(),
            order_by: None,
            order_dir: None,
            filter: None,
            // unique_export_path already picked a non-clobbering name.
            overwrite: true,
        };
        let result = stream_table_export(
            &*driver,
            &table_request,
            format,
            &temporary_path,
            &operation_id,
            &app,
            cancelled.clone(),
        )
        .await;
        match result {
            Ok(row_count) => match tokio::fs::rename(&temporary_path, &target_path).await {
                Ok(()) => exported.push(TableDataExportResult {
                    file_path: target_path.to_string_lossy().to_string(),
                    format: format.to_string(),
                    row_count,
                }),
                Err(e) => {
                    let _ = tokio::fs::remove_file(&temporary_path).await;
                    failed.push(BulkTableExportFailure {
                        table: table.clone(),
                        error: format!("Failed to publish completed export: {e}"),
                    });
                }
            },
            Err(error) => {
                let _ = tokio::fs::remove_file(&temporary_path).await;
                if cancelled.load(Ordering::Relaxed) {
                    was_cancelled = true;
                    break;
                }
                failed.push(BulkTableExportFailure {
                    table: table.clone(),
                    error,
                });
            }
        }
    }

    cancellation_state.finish(&operation_id);
    Ok(BulkTableExportResult {
        exported,
        failed,
        cancelled: was_cancelled,
    })
}

/// Pick a non-clobbering filename inside `directory` for one exported table.
fn unique_export_path(directory: &Path, table: &str, extension: &str) -> PathBuf {
    let base = safe_filename(table);
    for attempt in 0_u32..1000 {
        let file_name = if attempt == 0 {
            format!("{base}.{extension}")
        } else {
            format!("{base}-{attempt}.{extension}")
        };
        let candidate = directory.join(file_name);
        if !candidate.exists() {
            return candidate;
        }
    }
    // Practically unreachable; fall back to a uuid-suffixed name.
    directory.join(format!("{base}-{}.{}", Uuid::new_v4(), extension))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TableExportProgress {
    operation_id: String,
    exported_rows: u64,
    /// 1-based index of the batch just written, so the UI can show progress
    /// even before the first row count is meaningful.
    batch: u64,
}

#[tauri::command]
pub async fn export_table_data(
    connection_id: String,
    request: TableDataExportRequest,
    operation_id: String,
    app: AppHandle,
    db_manager: State<'_, DatabaseManager>,
    cancellation_state: State<'_, TableExportCancellationState>,
) -> Result<TableDataExportResult, String> {
    db_manager
        .require_capability(&connection_id, DriverCapability::DataExport)
        .await
        .map_err(|e| e.to_string())?;
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(|e| e.to_string())?;
    let (format, extension) = match request.format.as_str() {
        "csv" => ("csv", "csv"),
        "jsonl" => ("jsonl", "jsonl"),
        _ => return Err("Table export format must be 'csv' or 'jsonl'.".to_string()),
    };
    let target_path = FileDialog::new()
        .set_file_name(format!("{}.{}", safe_filename(&request.table), extension))
        .add_filter(
            if format == "csv" { "CSV" } else { "JSON Lines" },
            &[extension],
        )
        .save_file()
        .ok_or_else(|| "No export destination selected.".to_string())?;
    if target_path.exists() && !request.overwrite {
        return Err(format!(
            "{EXPORT_FILE_EXISTS_CODE}: '{}' already exists. Confirm overwrite to replace it.",
            target_path.display()
        ));
    }
    let temporary_path = temporary_export_path(&target_path);
    let cancelled = cancellation_state.start(&operation_id)?;
    let result = stream_table_export(
        &*driver,
        &request,
        format,
        &temporary_path,
        &operation_id,
        &app,
        cancelled,
    )
    .await;
    cancellation_state.finish(&operation_id);

    match result {
        Ok(row_count) => {
            tokio::fs::rename(&temporary_path, &target_path)
                .await
                .map_err(|e| format!("Failed to publish completed export: {e}"))?;
            Ok(TableDataExportResult {
                file_path: target_path.to_string_lossy().to_string(),
                format: format.to_string(),
                row_count,
            })
        }
        Err(error) => {
            let _ = tokio::fs::remove_file(&temporary_path).await;
            Err(error)
        }
    }
}

#[tauri::command]
pub fn cancel_table_export(
    operation_id: String,
    cancellation_state: State<'_, TableExportCancellationState>,
) -> bool {
    cancellation_state.cancel(&operation_id)
}

async fn stream_table_export(
    driver: &dyn crate::database::driver::DatabaseDriver,
    request: &TableDataExportRequest,
    format: &str,
    temporary_path: &Path,
    operation_id: &str,
    app: &AppHandle,
    cancelled: Arc<AtomicBool>,
) -> Result<u64, String> {
    let mut file = tokio::fs::File::create(temporary_path)
        .await
        .map_err(|e| format!("Failed to create temporary export file: {e}"))?;
    let mut wrote_header = false;
    let mut exported_rows = 0_u64;
    let mut batch_index = 0_u64;
    // Unordered offset paging can skip or duplicate rows under concurrent
    // writes, so exports always page over a stable ORDER BY: the caller's
    // sort column, else the primary key, else the first column — for drivers
    // whose paging honours ORDER BY (SQL engines + MongoDB's sort). Drivers
    // with their own deterministic paging (Cassandra page state, OpenSearch
    // scroll, Redis keyspace scans) keep their native order.
    let order_by = match request.order_by.as_deref() {
        Some(order_by) => Some(order_by.to_string()),
        None => stable_export_order_column(driver, request).await,
    };
    let mut batches = driver.export_table_rows(
        &request.table,
        request.database.as_deref(),
        EXPORT_BATCH_SIZE,
        order_by.as_deref(),
        request.order_dir.as_deref(),
        request.filter.as_deref(),
    );

    while let Some(batch) = timeout(EXPORT_BATCH_TIMEOUT, batches.try_next())
        .await
        .map_err(|_| "Loading the next export batch timed out after 5 minutes.".to_string())?
        .map_err(|e| e.to_string())?
    {
        if cancelled.load(Ordering::Relaxed) {
            return Err("Table export cancelled; incomplete output was removed.".to_string());
        }
        if batch.rows.is_empty() {
            continue;
        }
        let bytes = if format == "csv" {
            serialize_csv_batch(&batch, !wrote_header)?
        } else {
            serialize_jsonl_batch(&batch)?
        };
        file.write_all(&bytes)
            .await
            .map_err(|e| format!("Failed to write export batch: {e}"))?;
        wrote_header = true;
        exported_rows += batch.rows.len() as u64;
        batch_index += 1;
        let _ = app.emit(
            "table-export-progress",
            TableExportProgress {
                operation_id: operation_id.to_string(),
                exported_rows,
                batch: batch_index,
            },
        );
    }
    file.flush()
        .await
        .map_err(|e| format!("Failed to flush export file: {e}"))?;
    file.sync_all()
        .await
        .map_err(|e| format!("Failed to sync export file: {e}"))?;
    Ok(exported_rows)
}

/// Picks the column an unordered export should page over: the primary key
/// when the table has one, else the first column. Only drivers whose paging
/// honours an ORDER BY/sort get one — Cassandra (page-state paging),
/// OpenSearch (scroll), and Redis (keyspace scans) keep their native order.
/// Structure lookup failures degrade to unordered paging rather than
/// failing the export.
async fn stable_export_order_column(
    driver: &dyn crate::database::driver::DatabaseDriver,
    request: &TableDataExportRequest,
) -> Option<String> {
    let column = match driver.driver_name() {
        "MongoDB" => "_id".to_string(),
        "MySQL" | "MariaDB" | "PostgreSQL" | "CockroachDB" | "Greenplum" | "Redshift"
        | "SQLite" | "LibSQL" | "DuckDB" | "SQL Server" | "Snowflake" | "BigQuery"
        | "ClickHouse" | "Vertica" | "Cloudflare D1" => {
            let structure = driver
                .get_table_structure(&request.table, request.database.as_deref())
                .await
                .ok()?;
            structure
                .columns
                .iter()
                .find(|column| column.is_primary_key)
                .or_else(|| structure.columns.first())
                .map(|column| column.name.clone())?
        }
        _ => return None,
    };
    Some(column)
}

/// Serializes one batch of rows as CSV text. NULL cells are written as the
/// unquoted `\N` marker (Postgres COPY convention) so they round-trip
/// through the CSV importer, which decodes `\N` back to NULL; a literal `\N`
/// string is escaped to `\\N`. Empty strings stay empty strings.
fn serialize_csv_batch(result: &QueryResult, include_header: bool) -> Result<Vec<u8>, String> {
    let mut output = String::new();
    if include_header {
        for (index, column) in result.columns.iter().enumerate() {
            if index > 0 {
                output.push(',');
            }
            output.push_str(&csv_escape(&column.name));
        }
        output.push('\n');
    }
    for row in &result.rows {
        for (index, value) in row.iter().enumerate() {
            if index > 0 {
                output.push(',');
            }
            output.push_str(&csv_cell(value));
        }
        output.push('\n');
    }
    Ok(output.into_bytes())
}

fn serialize_jsonl_batch(result: &QueryResult) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    for row in &result.rows {
        let mut object = JsonMap::new();
        for (index, column) in result.columns.iter().enumerate() {
            object.insert(
                column.name.clone(),
                row.get(index).cloned().unwrap_or(JsonValue::Null),
            );
        }
        serde_json::to_writer(&mut output, &object)
            .map_err(|e| format!("Failed to serialize JSONL row: {e}"))?;
        output.push(b'\n');
    }
    Ok(output)
}

/// Renders one cell for CSV export. `JsonValue::Null` becomes the `\N`
/// marker so NULL and "" stay distinguishable; strings that already look
/// like the marker (`\N`, `\\N`, …) gain one more leading backslash, which
/// the importer's `decode_csv_cell` strips again.
fn csv_cell(value: &JsonValue) -> String {
    match value {
        JsonValue::Null => "\\N".to_string(),
        JsonValue::String(value) => {
            if value.len() >= 2
                && value.ends_with('N')
                && value[..value.len() - 1].chars().all(|ch| ch == '\\')
            {
                csv_escape(&format!("\\{value}"))
            } else {
                csv_escape(value)
            }
        }
        _ => csv_escape(&value.to_string()),
    }
}

/// RFC 4180 quoting: quote only when the value contains a comma, quote, or
/// line break; embedded quotes double.
fn csv_escape(value: &str) -> String {
    if value.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

fn temporary_export_path(target_path: &Path) -> PathBuf {
    let file_name = target_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("export");
    target_path.with_file_name(format!(".{file_name}.{}.part", Uuid::new_v4()))
}

fn safe_filename(value: &str) -> String {
    let safe = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    if safe.is_empty() {
        "table".to_string()
    } else {
        safe
    }
}

#[cfg(test)]
mod tests {
    use super::{serialize_csv_batch, serialize_jsonl_batch, temporary_export_path};
    use crate::database::models::{ColumnInfo, QueryResult};
    use serde_json::json;
    use std::path::Path;

    fn fixture() -> QueryResult {
        QueryResult {
            columns: vec![ColumnInfo {
                name: "name".into(),
                data_type: "TEXT".into(),
                is_nullable: false,
                is_primary_key: false,
                max_length: None,
                default_value: None,
            }],
            rows: vec![vec![json!("Ada, Lovelace")]],
            affected_rows: 0,
            execution_time_ms: 0,
            query: String::new(),
            sandboxed: false,
            truncated: false,
        }
    }

    #[test]
    fn serializes_bounded_csv_and_jsonl_batches() {
        let csv = String::from_utf8(serialize_csv_batch(&fixture(), true).unwrap()).unwrap();
        assert!(csv.contains("\"Ada, Lovelace\""));
        let jsonl = String::from_utf8(serialize_jsonl_batch(&fixture()).unwrap()).unwrap();
        assert_eq!(jsonl.trim(), r#"{"name":"Ada, Lovelace"}"#);
    }

    #[test]
    fn temporary_output_stays_beside_the_destination() {
        let temporary = temporary_export_path(Path::new("C:/exports/users.csv"));
        assert_eq!(temporary.parent(), Some(Path::new("C:/exports")));
        assert!(temporary.to_string_lossy().ends_with(".part"));
    }
}
