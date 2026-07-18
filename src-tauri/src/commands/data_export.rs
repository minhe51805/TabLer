use crate::database::capabilities::DriverCapability;
use crate::database::manager::DatabaseManager;
use crate::database::models::QueryResult;
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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDataExportResult {
    file_path: String,
    format: String,
    row_count: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TableExportProgress {
    operation_id: String,
    exported_rows: u64,
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
    if target_path.exists() {
        return Err(
            "Choose a new export filename so TableR can publish it atomically.".to_string(),
        );
    }
    let temporary_path = temporary_export_path(&target_path);
    let cancelled = cancellation_state.start(&operation_id)?;
    let result = stream_table_export(
        &**driver,
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
    let mut offset = 0_u64;
    let mut wrote_header = false;

    loop {
        if cancelled.load(Ordering::Relaxed) {
            return Err("Table export cancelled; incomplete output was removed.".to_string());
        }
        let batch = timeout(
            EXPORT_BATCH_TIMEOUT,
            driver.get_table_data(
                &request.table,
                request.database.as_deref(),
                offset,
                EXPORT_BATCH_SIZE,
                request.order_by.as_deref(),
                request.order_dir.as_deref(),
                request.filter.as_deref(),
            ),
        )
        .await
        .map_err(|_| "Loading the next export batch timed out after 5 minutes.".to_string())?
        .map_err(|e| e.to_string())?;
        if batch.rows.is_empty() {
            break;
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
        offset += batch.rows.len() as u64;
        let _ = app.emit(
            "table-export-progress",
            TableExportProgress {
                operation_id: operation_id.to_string(),
                exported_rows: offset,
            },
        );
        if batch.rows.len() < EXPORT_BATCH_SIZE as usize {
            break;
        }
    }
    file.flush()
        .await
        .map_err(|e| format!("Failed to flush export file: {e}"))?;
    file.sync_all()
        .await
        .map_err(|e| format!("Failed to sync export file: {e}"))?;
    Ok(offset)
}

fn serialize_csv_batch(result: &QueryResult, include_header: bool) -> Result<Vec<u8>, String> {
    let mut writer = csv::Writer::from_writer(Vec::new());
    if include_header {
        writer
            .write_record(result.columns.iter().map(|column| column.name.as_str()))
            .map_err(|e| format!("Failed to serialize CSV header: {e}"))?;
    }
    for row in &result.rows {
        writer
            .write_record(row.iter().map(csv_cell))
            .map_err(|e| format!("Failed to serialize CSV row: {e}"))?;
    }
    writer
        .into_inner()
        .map_err(|e| format!("Failed to finish CSV batch: {e}"))
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

fn csv_cell(value: &JsonValue) -> String {
    match value {
        JsonValue::Null => String::new(),
        JsonValue::String(value) => value.clone(),
        _ => value.to_string(),
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
