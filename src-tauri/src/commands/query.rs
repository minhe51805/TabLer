use crate::database::manager::DatabaseManager;
use crate::database::models::QueryResult;
use tauri::State;

fn is_sandbox_safe_statement(statement: &str) -> bool {
    let normalized = statement.trim_start().to_uppercase();
    [
        "SELECT",
        "WITH",
        "EXPLAIN",
        "SHOW",
        "DESCRIBE",
        "PRAGMA",
        "INSERT",
        "UPDATE",
        "DELETE",
    ]
    .iter()
    .any(|prefix| normalized.starts_with(prefix))
}

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

#[tauri::command]
pub async fn execute_sandboxed_query(
    connection_id: String,
    statements: Vec<String>,
    db_manager: State<'_, DatabaseManager>,
) -> Result<QueryResult, String> {
    if statements.is_empty() {
        return Err("Sandbox execution requires at least one SQL statement.".to_string());
    }

    for statement in &statements {
        if !is_sandbox_safe_statement(statement) {
            return Err(
                "Sandbox mode only allows SELECT, WITH, EXPLAIN, SHOW, DESCRIBE, PRAGMA, INSERT, UPDATE, and DELETE statements."
                    .to_string(),
            );
        }
    }

    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(|e| e.to_string())?;
    driver
        .execute_sandboxed(&statements)
        .await
        .map_err(|e| e.to_string())
}
