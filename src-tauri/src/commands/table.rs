use crate::database::capabilities::DriverCapability;
use crate::database::manager::DatabaseManager;
use crate::database::models::{
    ColumnDetail, CsvFileImportRequest, LookupValue, QueryResult, SchemaObjectInfo,
    TableCellUpdateRequest, TableInfo, TableRowDeleteRequest, TableRowInsertRequest,
    TableStructure,
};
use serde::Serialize;
use serde_json::{Number as JsonNumber, Value as JsonValue};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;
use tokio::time::{timeout, Duration};

const TABLE_QUERY_TIMEOUT: Duration = Duration::from_secs(120);
const TABLE_METADATA_TIMEOUT: Duration = Duration::from_secs(60);
const CSV_FILE_IMPORT_TIMEOUT: Duration = Duration::from_secs(30 * 60);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CsvImportProgress {
    operation_id: String,
    processed_rows: u64,
    processed_bytes: u64,
    total_bytes: u64,
}

#[derive(Default)]
pub struct CsvImportCancellationState {
    imports: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl CsvImportCancellationState {
    fn start(&self, operation_id: &str) -> Result<Arc<AtomicBool>, String> {
        if operation_id.trim().is_empty() {
            return Err("CSV import operation identifier is required.".to_string());
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        self.imports
            .lock()
            .map_err(|_| "CSV import cancellation state is unavailable.".to_string())?
            .insert(operation_id.to_string(), cancelled.clone());
        Ok(cancelled)
    }

    fn finish(&self, operation_id: &str) {
        if let Ok(mut imports) = self.imports.lock() {
            imports.remove(operation_id);
        }
    }

    fn cancel(&self, operation_id: &str) -> bool {
        let Ok(imports) = self.imports.lock() else {
            return false;
        };
        let Some(cancelled) = imports.get(operation_id) else {
            return false;
        };
        cancelled.store(true, Ordering::Relaxed);
        true
    }
}

#[tauri::command]
pub async fn list_tables(
    connection_id: String,
    database: Option<String>,
    db_manager: State<'_, DatabaseManager>,
) -> Result<Vec<TableInfo>, String> {
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(|e| e.to_string())?;
    timeout(
        TABLE_METADATA_TIMEOUT,
        driver.list_tables(database.as_deref()),
    )
    .await
    .map_err(|_| "Listing tables timed out after 60 seconds.".to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_table_structure(
    connection_id: String,
    table: String,
    database: Option<String>,
    db_manager: State<'_, DatabaseManager>,
) -> Result<TableStructure, String> {
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(|e| e.to_string())?;
    timeout(
        TABLE_METADATA_TIMEOUT,
        driver.get_table_structure(&table, database.as_deref()),
    )
    .await
    .map_err(|_| "Loading table structure timed out after 60 seconds.".to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_table_columns_preview(
    connection_id: String,
    table: String,
    database: Option<String>,
    db_manager: State<'_, DatabaseManager>,
) -> Result<Vec<ColumnDetail>, String> {
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(|e| e.to_string())?;
    timeout(
        TABLE_METADATA_TIMEOUT,
        driver.get_table_columns_preview(&table, database.as_deref()),
    )
    .await
    .map_err(|_| "Loading table columns timed out after 60 seconds.".to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_schema_objects(
    connection_id: String,
    database: Option<String>,
    db_manager: State<'_, DatabaseManager>,
) -> Result<Vec<SchemaObjectInfo>, String> {
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(|e| e.to_string())?;
    timeout(
        TABLE_METADATA_TIMEOUT,
        driver.list_schema_objects(database.as_deref()),
    )
    .await
    .map_err(|_| "Listing schema objects timed out after 60 seconds.".to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_table_data(
    connection_id: String,
    table: String,
    database: Option<String>,
    offset: u64,
    limit: u64,
    order_by: Option<String>,
    order_dir: Option<String>,
    filter: Option<String>,
    db_manager: State<'_, DatabaseManager>,
) -> Result<QueryResult, String> {
    db_manager
        .require_capability(&connection_id, DriverCapability::Query)
        .await
        .map_err(|e| e.to_string())?;
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(|e| e.to_string())?;
    timeout(
        TABLE_QUERY_TIMEOUT,
        driver.get_table_data(
            &table,
            database.as_deref(),
            offset,
            limit,
            order_by.as_deref(),
            order_dir.as_deref(),
            filter.as_deref(),
        ),
    )
    .await
    .map_err(|_| "Loading table data timed out after 120 seconds.".to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn count_table_rows(
    connection_id: String,
    table: String,
    database: Option<String>,
    db_manager: State<'_, DatabaseManager>,
) -> Result<i64, String> {
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(|e| e.to_string())?;
    timeout(
        TABLE_METADATA_TIMEOUT,
        driver.count_rows(&table, database.as_deref()),
    )
    .await
    .map_err(|_| "Counting table rows timed out after 60 seconds.".to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn count_table_null_values(
    connection_id: String,
    table: String,
    column: String,
    database: Option<String>,
    db_manager: State<'_, DatabaseManager>,
) -> Result<i64, String> {
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(|e| e.to_string())?;
    timeout(
        TABLE_METADATA_TIMEOUT,
        driver.count_null_values(&table, database.as_deref(), &column),
    )
    .await
    .map_err(|_| "Counting NULL values timed out after 60 seconds.".to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_table_cell(
    connection_id: String,
    request: TableCellUpdateRequest,
    db_manager: State<'_, DatabaseManager>,
) -> Result<u64, String> {
    db_manager
        .require_capability(&connection_id, DriverCapability::InlineEdit)
        .await
        .map_err(|e| e.to_string())?;
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(|e| e.to_string())?;
    timeout(TABLE_QUERY_TIMEOUT, driver.update_table_cell(&request))
        .await
        .map_err(|_| "Inline update timed out after 120 seconds.".to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn apply_table_updates_atomically(
    connection_id: String,
    updates: Vec<TableCellUpdateRequest>,
    db_manager: State<'_, DatabaseManager>,
) -> Result<u64, String> {
    if updates.is_empty() {
        return Ok(0);
    }
    db_manager
        .require_capability(&connection_id, DriverCapability::AtomicEditQueue)
        .await
        .map_err(|e| e.to_string())?;
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(|e| e.to_string())?;
    timeout(
        TABLE_QUERY_TIMEOUT,
        driver.apply_table_updates_atomically(&updates),
    )
    .await
    .map_err(|_| "Applying the edit queue timed out after 120 seconds.".to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_table_rows(
    connection_id: String,
    request: TableRowDeleteRequest,
    db_manager: State<'_, DatabaseManager>,
) -> Result<u64, String> {
    db_manager
        .require_capability(&connection_id, DriverCapability::InlineEdit)
        .await
        .map_err(|e| e.to_string())?;
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(|e| e.to_string())?;
    timeout(TABLE_QUERY_TIMEOUT, driver.delete_table_rows(&request))
        .await
        .map_err(|_| "Row deletion timed out after 120 seconds.".to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn insert_table_row(
    connection_id: String,
    request: TableRowInsertRequest,
    db_manager: State<'_, DatabaseManager>,
) -> Result<u64, String> {
    db_manager
        .require_capability(&connection_id, DriverCapability::InlineEdit)
        .await
        .map_err(|e| e.to_string())?;
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(|e| e.to_string())?;
    timeout(TABLE_QUERY_TIMEOUT, driver.insert_table_row(&request))
        .await
        .map_err(|_| "Row insertion timed out after 120 seconds.".to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn execute_structure_statements(
    connection_id: String,
    statements: Vec<String>,
    db_manager: State<'_, DatabaseManager>,
) -> Result<u64, String> {
    db_manager
        .require_capability(&connection_id, DriverCapability::SchemaEdit)
        .await
        .map_err(|e| e.to_string())?;
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(|e| e.to_string())?;
    timeout(
        TABLE_QUERY_TIMEOUT,
        driver.execute_structure_statements(&statements),
    )
    .await
    .map_err(|_| "Applying structure changes timed out after 120 seconds.".to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_foreign_key_lookup_values(
    connection_id: String,
    referenced_table: String,
    referenced_column: String,
    search: Option<String>,
    limit: Option<u32>,
    display_columns: Option<Vec<String>>,
    db_manager: State<'_, DatabaseManager>,
) -> Result<Vec<LookupValue>, String> {
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(|e| e.to_string())?;
    let disp_cols: Vec<&str> = display_columns
        .as_ref()
        .map(|v| v.iter().map(|s| s.as_str()).collect())
        .unwrap_or_default();
    timeout(
        TABLE_METADATA_TIMEOUT,
        driver.get_foreign_key_lookup_values(
            &referenced_table,
            &referenced_column,
            &disp_cols,
            search.as_deref(),
            limit.unwrap_or(1000),
        ),
    )
    .await
    .map_err(|_| "Loading FK lookup values timed out after 60 seconds.".to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn insert_table_rows_atomically(
    connection_id: String,
    requests: Vec<TableRowInsertRequest>,
    operation_id: String,
    db_manager: State<'_, DatabaseManager>,
    cancellation_state: State<'_, CsvImportCancellationState>,
) -> Result<u64, String> {
    if requests.is_empty() {
        return Err("CSV import requires at least one row.".to_string());
    }
    db_manager
        .require_capability(&connection_id, DriverCapability::AtomicCsvImport)
        .await
        .map_err(|e| e.to_string())?;
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(|e| e.to_string())?;
    let cancelled = cancellation_state.start(&operation_id)?;
    let result = match timeout(
        TABLE_QUERY_TIMEOUT,
        driver.insert_table_rows_atomically(&requests, cancelled),
    )
    .await
    {
        Ok(result) => result.map_err(|e| e.to_string()),
        Err(_) => Err("CSV import timed out after 120 seconds.".to_string()),
    };
    cancellation_state.finish(&operation_id);
    result
}

#[tauri::command]
pub async fn import_csv_file_atomically(
    connection_id: String,
    request: CsvFileImportRequest,
    operation_id: String,
    app: AppHandle,
    db_manager: State<'_, DatabaseManager>,
    cancellation_state: State<'_, CsvImportCancellationState>,
) -> Result<u64, String> {
    if request.mappings.is_empty() {
        return Err("CSV import requires at least one mapped column.".to_string());
    }
    db_manager
        .require_capability(&connection_id, DriverCapability::AtomicCsvImport)
        .await
        .map_err(|e| e.to_string())?;
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(|e| e.to_string())?;
    let structure = timeout(
        TABLE_METADATA_TIMEOUT,
        driver.get_table_structure(&request.table, request.database.as_deref()),
    )
    .await
    .map_err(|_| "Loading CSV target metadata timed out after 60 seconds.".to_string())?
    .map_err(|e| e.to_string())?;
    let target_columns = validate_csv_mappings(&request, &structure.columns)?;
    let file_path = canonical_csv_path(&request.file_path)?;
    let total_bytes = fs::metadata(&file_path)
        .map_err(|e| format!("Failed to inspect CSV file: {e}"))?
        .len();
    let delimiter = match request.delimiter.as_str() {
        "csv" => b',',
        "tsv" => b'\t',
        _ => return Err("CSV delimiter must be 'csv' or 'tsv'.".to_string()),
    };

    let cancelled = cancellation_state.start(&operation_id)?;
    let parser_cancelled = cancelled.clone();
    let parser_operation_id = operation_id.clone();
    let parser_table = request.table.clone();
    let parser_database = request.database.clone();
    let mappings = request.mappings.clone();
    let has_headers = request.has_headers;
    let (sender, receiver) = mpsc::channel(128);
    let parser = tokio::task::spawn_blocking(move || {
        stream_csv_rows(
            &file_path,
            delimiter,
            has_headers,
            &parser_table,
            parser_database,
            &mappings,
            &target_columns,
            total_bytes,
            &parser_operation_id,
            &app,
            parser_cancelled,
            sender,
        )
    });

    let import_result = match timeout(
        CSV_FILE_IMPORT_TIMEOUT,
        driver.insert_table_row_stream_atomically(receiver, cancelled.clone()),
    )
    .await
    {
        Ok(result) => result.map_err(|e| e.to_string()),
        Err(_) => {
            cancelled.store(true, Ordering::Relaxed);
            Err("CSV import timed out after 30 minutes; all rows were rolled back.".to_string())
        }
    };
    let parser_result = parser
        .await
        .map_err(|_| "CSV parser stopped unexpectedly.".to_string())?;
    cancellation_state.finish(&operation_id);
    parser_result?;
    import_result
}

fn canonical_csv_path(raw_path: &str) -> Result<PathBuf, String> {
    let path = fs::canonicalize(raw_path).map_err(|e| format!("CSV file is unavailable: {e}"))?;
    if !path.is_file() {
        return Err("CSV import source must be a file.".to_string());
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "csv" | "tsv" | "txt") {
        return Err("CSV import accepts only .csv, .tsv, or .txt files.".to_string());
    }
    Ok(path)
}

fn validate_csv_mappings(
    request: &CsvFileImportRequest,
    columns: &[ColumnDetail],
) -> Result<HashMap<String, ColumnDetail>, String> {
    let available = columns
        .iter()
        .map(|column| (column.name.clone(), column.clone()))
        .collect::<HashMap<_, _>>();
    let mut targets = HashMap::new();
    for mapping in &request.mappings {
        let column = available.get(&mapping.target_column).ok_or_else(|| {
            format!(
                "CSV target column '{}' does not exist.",
                mapping.target_column
            )
        })?;
        if targets
            .insert(mapping.target_column.clone(), column.clone())
            .is_some()
        {
            return Err(format!(
                "CSV target column '{}' is mapped more than once.",
                mapping.target_column
            ));
        }
    }
    Ok(targets)
}

#[allow(clippy::too_many_arguments)]
fn stream_csv_rows(
    file_path: &Path,
    delimiter: u8,
    has_headers: bool,
    table: &str,
    database: Option<String>,
    mappings: &[crate::database::models::CsvColumnMapping],
    columns: &HashMap<String, ColumnDetail>,
    total_bytes: u64,
    operation_id: &str,
    app: &AppHandle,
    cancelled: Arc<AtomicBool>,
    sender: mpsc::Sender<crate::database::models::CsvImportRow>,
) -> Result<(), String> {
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .has_headers(has_headers)
        .flexible(true)
        .from_path(file_path)
        .map_err(|e| format!("Failed to open CSV file: {e}"))?;
    let rejection_path = file_path.with_extension("tabler-rejected.csv");
    let mut processed_rows = 0_u64;

    for (record_index, record) in reader.records().enumerate() {
        if cancelled.load(Ordering::Relaxed) {
            return Err("CSV import cancelled; all rows were rolled back.".to_string());
        }
        let record = match record {
            Ok(record) => record,
            Err(error) => {
                let message = format!("CSV row {} could not be parsed: {error}", record_index + 1);
                write_csv_rejection(&rejection_path, record_index + 1, &message)?;
                let _ = sender.blocking_send(Err(format!(
                    "{message}. Rejected-row report: {}",
                    rejection_path.display()
                )));
                return Ok(());
            }
        };
        let mut values = Vec::with_capacity(mappings.len());
        for mapping in mappings {
            let raw = record.get(mapping.source_index).unwrap_or_default();
            let column = columns.get(&mapping.target_column).ok_or_else(|| {
                format!(
                    "CSV target column '{}' is no longer available.",
                    mapping.target_column
                )
            })?;
            let value = match parse_csv_value(raw, column) {
                Ok(value) => value,
                Err(reason) => {
                    let message = format!(
                        "CSV row {}, column '{}': {reason}",
                        record_index + 1,
                        mapping.target_column
                    );
                    write_csv_rejection(&rejection_path, record_index + 1, &message)?;
                    let _ = sender.blocking_send(Err(format!(
                        "{message}. Rejected-row report: {}",
                        rejection_path.display()
                    )));
                    return Ok(());
                }
            };
            values.push((mapping.target_column.clone(), value));
        }
        if sender
            .blocking_send(Ok(TableRowInsertRequest {
                table: table.to_string(),
                database: database.clone(),
                values,
            }))
            .is_err()
        {
            return Ok(());
        }
        processed_rows += 1;
        if processed_rows % 250 == 0 {
            let processed_bytes = record
                .position()
                .map(|position| position.byte())
                .unwrap_or(0);
            let _ = app.emit(
                "csv-import-progress",
                CsvImportProgress {
                    operation_id: operation_id.to_string(),
                    processed_rows,
                    processed_bytes,
                    total_bytes,
                },
            );
        }
    }
    let _ = app.emit(
        "csv-import-progress",
        CsvImportProgress {
            operation_id: operation_id.to_string(),
            processed_rows,
            processed_bytes: total_bytes,
            total_bytes,
        },
    );
    Ok(())
}

fn parse_csv_value(raw: &str, column: &ColumnDetail) -> Result<JsonValue, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return if column.is_nullable || column.default_value.is_some() {
            Ok(JsonValue::Null)
        } else {
            Err("a required value is empty".to_string())
        };
    }
    let data_type = column
        .column_type
        .as_deref()
        .unwrap_or(&column.data_type)
        .to_ascii_lowercase();
    if data_type.contains("bool") {
        return match trimmed.to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" => Ok(JsonValue::Bool(true)),
            "false" | "0" | "no" => Ok(JsonValue::Bool(false)),
            _ => Err("expected a boolean value".to_string()),
        };
    }
    if data_type.contains("int") || data_type.contains("serial") {
        return trimmed
            .parse::<i64>()
            .map(JsonNumber::from)
            .map(JsonValue::Number)
            .map_err(|_| "expected an integer value".to_string());
    }
    if ["numeric", "decimal", "float", "double", "real", "money"]
        .iter()
        .any(|kind| data_type.contains(kind))
    {
        let value = trimmed
            .parse::<f64>()
            .map_err(|_| "expected a numeric value".to_string())?;
        return JsonNumber::from_f64(value)
            .map(JsonValue::Number)
            .ok_or_else(|| "numeric value is not finite".to_string());
    }
    if data_type.contains("json") {
        return serde_json::from_str(trimmed).map_err(|_| "expected valid JSON".to_string());
    }
    Ok(JsonValue::String(raw.to_string()))
}

fn write_csv_rejection(path: &Path, source_row: usize, reason: &str) -> Result<(), String> {
    let mut writer = csv::Writer::from_path(path)
        .map_err(|e| format!("Failed to create rejected-row report: {e}"))?;
    writer
        .write_record(["source_row", "reason"])
        .and_then(|_| writer.write_record([source_row.to_string(), reason.to_string()]))
        .map_err(|e| format!("Failed to write rejected-row report: {e}"))?;
    writer
        .flush()
        .map_err(|e| format!("Failed to write rejected-row report: {e}"))
}

#[tauri::command]
pub fn cancel_csv_import(
    operation_id: String,
    cancellation_state: State<'_, CsvImportCancellationState>,
) -> bool {
    cancellation_state.cancel(&operation_id)
}

#[cfg(test)]
mod csv_tests {
    use super::parse_csv_value;
    use crate::database::models::ColumnDetail;
    use serde_json::json;

    fn column(data_type: &str, nullable: bool) -> ColumnDetail {
        ColumnDetail {
            name: "value".into(),
            data_type: data_type.into(),
            is_nullable: nullable,
            is_primary_key: false,
            default_value: None,
            extra: None,
            column_type: None,
            comment: None,
        }
    }

    #[test]
    fn parses_typed_csv_values_without_guessing_strings() {
        assert_eq!(
            parse_csv_value("42", &column("INTEGER", false)).unwrap(),
            json!(42)
        );
        assert_eq!(
            parse_csv_value("true", &column("BOOLEAN", false)).unwrap(),
            json!(true)
        );
        assert_eq!(
            parse_csv_value("{\"ok\":true}", &column("JSON", false)).unwrap(),
            json!({"ok": true})
        );
    }

    #[test]
    fn rejects_empty_required_values() {
        assert!(parse_csv_value("", &column("TEXT", false)).is_err());
        assert_eq!(
            parse_csv_value("", &column("TEXT", true)).unwrap(),
            json!(null)
        );
    }
}
