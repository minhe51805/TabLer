use crate::database::manager::DatabaseManager;
use crate::database::models::QueryResult;
use tauri::State;

#[tauri::command]
pub async fn execute_query(
    connection_id: String,
    sql: String,
    db_manager: State<'_, DatabaseManager>,
) -> Result<QueryResult, String> {
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(|e| e.to_string())?;
    driver.execute_query(&sql).await.map_err(|e| e.to_string())
}
