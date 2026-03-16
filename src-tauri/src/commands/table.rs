use crate::database::manager::DatabaseManager;
use crate::database::models::{QueryResult, TableCellUpdateRequest, TableInfo, TableStructure};
use tauri::State;

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
    driver
        .list_tables(database.as_deref())
        .await
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
    driver
        .get_table_structure(&table, database.as_deref())
        .await
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
    driver
        .get_table_data(
            &table,
            database.as_deref(),
            offset,
            limit,
            order_by.as_deref(),
            order_dir.as_deref(),
            filter.as_deref(),
        )
        .await
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
    driver
        .count_rows(&table, database.as_deref())
        .await
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
    driver
        .update_table_cell(&request)
        .await
        .map_err(|e| e.to_string())
}
