use crate::database::manager::DatabaseManager;
use crate::database::models::QueryResult;
use tauri::State;
use tokio::time::{timeout, Duration};

const READ_ONLY_QUERY_TIMEOUT: Duration = Duration::from_secs(180);
const MUTATING_QUERY_TIMEOUT: Duration = Duration::from_secs(60);

const SANDBOX_ALLOWED_PREFIXES: [&str; 8] = [
    "SELECT",
    "WITH",
    "EXPLAIN",
    "SHOW",
    "DESCRIBE",
    "PRAGMA",
    "INSERT",
    "UPDATE",
];

fn strip_leading_sql_noise(statement: &str) -> Result<&str, String> {
    let mut remaining = statement;

    loop {
        remaining = remaining.trim_start_matches(char::is_whitespace);

        if let Some(after_line_comment) = remaining.strip_prefix("--") {
            if let Some((_, next_line)) = after_line_comment.split_once('\n') {
                remaining = next_line;
                continue;
            }
            return Err("Sandbox mode does not allow comment-only statements.".to_string());
        }

        if let Some(after_block_comment) = remaining.strip_prefix("/*") {
            if let Some(block_end) = after_block_comment.find("*/") {
                remaining = &after_block_comment[block_end + 2..];
                continue;
            }
            return Err("Sandbox mode found an unterminated block comment.".to_string());
        }

        return Ok(remaining);
    }
}

fn validate_sandbox_statement(statement: &str) -> Result<(), String> {
    let normalized = strip_leading_sql_noise(statement)?.to_ascii_uppercase();
    if normalized.is_empty() {
        return Err("Sandbox mode requires a non-empty SQL statement.".to_string());
    }

    if normalized.starts_with("PRAGMA") && normalized.contains('=') {
        return Err("Sandbox mode only allows read-only PRAGMA statements.".to_string());
    }

    if SANDBOX_ALLOWED_PREFIXES
        .iter()
        .any(|prefix| normalized.starts_with(prefix))
        || normalized.starts_with("DELETE")
    {
        return Ok(());
    }

    Err(
        "Sandbox mode only allows SELECT, WITH, EXPLAIN, SHOW, DESCRIBE, read-only PRAGMA, INSERT, UPDATE, and DELETE statements."
            .to_string(),
    )
}

fn is_likely_read_only_statement(statement: &str) -> bool {
    let Ok(normalized) = strip_leading_sql_noise(statement).map(|value| value.to_ascii_uppercase()) else {
        return false;
    };

    if normalized.is_empty() {
        return false;
    }

    if normalized.starts_with("PRAGMA") {
        return !normalized.contains('=');
    }

    normalized.starts_with("SELECT")
        || normalized.starts_with("SHOW")
        || normalized.starts_with("EXPLAIN")
        || normalized.starts_with("DESCRIBE")
}

fn timeout_for_statements<'a>(statements: impl Iterator<Item = &'a str>) -> Duration {
    if statements
        .filter(|statement| !statement.trim().is_empty())
        .all(is_likely_read_only_statement)
    {
        READ_ONLY_QUERY_TIMEOUT
    } else {
        MUTATING_QUERY_TIMEOUT
    }
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
    let timeout_window = timeout_for_statements(sql.split(';'));
    timeout(timeout_window, driver.execute_query(&sql))
        .await
        .map_err(|_| format!("Query timed out after {} seconds.", timeout_window.as_secs()))?
        .map_err(|e| e.to_string())
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
        validate_sandbox_statement(statement)?;
    }

    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(|e| e.to_string())?;
    let timeout_window = timeout_for_statements(statements.iter().map(String::as_str));
    timeout(timeout_window, driver.execute_sandboxed(&statements))
        .await
        .map_err(|_| format!("Sandbox query timed out after {} seconds.", timeout_window.as_secs()))?
        .map_err(|e| e.to_string())
}
