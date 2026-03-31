use crate::database::manager::DatabaseManager;
use crate::database::models::{
    ColumnDetail, LookupValue, QueryResult, SchemaObjectInfo, TableCellUpdateRequest, TableInfo,
    TableRowDeleteRequest, TableRowInsertRequest, TableStructure,
};
use tauri::State;
use tokio::time::{timeout, Duration};

const TABLE_QUERY_TIMEOUT: Duration = Duration::from_secs(120);
const TABLE_METADATA_TIMEOUT: Duration = Duration::from_secs(60);

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
    timeout(TABLE_METADATA_TIMEOUT, driver.list_tables(database.as_deref()))
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
    timeout(TABLE_METADATA_TIMEOUT, driver.count_rows(&table, database.as_deref()))
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
    timeout(TABLE_QUERY_TIMEOUT, driver.execute_structure_statements(&statements))
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
