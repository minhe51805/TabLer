use crate::database::manager::DatabaseManager;
use crate::database::models::{
    ColumnDetail, LookupValue, QueryResult, SchemaObjectInfo, TableCellUpdateRequest, TableInfo,
    TableRowDeleteRequest, TableRowInsertRequest, TableStructure,
};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::State;
use tokio::time::{timeout, Duration};

const TABLE_QUERY_TIMEOUT: Duration = Duration::from_secs(120);
const TABLE_METADATA_TIMEOUT: Duration = Duration::from_secs(60);

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
pub fn cancel_csv_import(
    operation_id: String,
    cancellation_state: State<'_, CsvImportCancellationState>,
) -> bool {
    cancellation_state.cancel(&operation_id)
}
