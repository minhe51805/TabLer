use crate::database::capabilities::DriverCapability;
use crate::database::manager::DatabaseManager;
use crate::database::models::QueryParameter;
use crate::database::models::QueryResult;
use crate::database::parameterized_query::{compile_parameterized_query, PlaceholderStyle};
use crate::utils::sql::{classify_sql, split_sql_statements, SqlSafetyDecision, SqlStatementKind};
use std::collections::HashMap;
use tauri::State;
use tokio::sync::Mutex;
use tokio::time::{timeout, Duration};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const READ_ONLY_QUERY_TIMEOUT: Duration = Duration::from_secs(180);
const MUTATING_QUERY_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Default)]
pub struct QueryCancellationState {
    active: Mutex<HashMap<String, CancellationToken>>,
}

impl QueryCancellationState {
    async fn register(&self, request_id: &str, token: CancellationToken) {
        if let Some(previous) = self
            .active
            .lock()
            .await
            .insert(request_id.to_string(), token)
        {
            previous.cancel();
        }
    }

    async fn finish(&self, request_id: &str) {
        self.active.lock().await.remove(request_id);
    }

    async fn cancel(&self, request_id: &str) -> bool {
        let token = self.active.lock().await.get(request_id).cloned();
        if let Some(token) = token {
            token.cancel();
            true
        } else {
            false
        }
    }
}

fn format_query_connection_error(error: impl std::fmt::Display) -> String {
    let normalized = error.to_string().to_ascii_lowercase();
    if normalized.contains("not found") || normalized.contains("connect first") {
        "The selected connection is not active. Please reconnect and try again.".to_string()
    } else {
        "The database connection is not available right now. Please reconnect and try again."
            .to_string()
    }
}

fn format_query_runtime_error(error: impl std::fmt::Display) -> String {
    let raw_message = error.to_string();
    let compact_message = raw_message.split_whitespace().collect::<Vec<_>>().join(" ");
    let normalized = compact_message.to_ascii_lowercase();

    if normalized.contains("permission") || normalized.contains("access denied") {
        return "The current connection does not have permission to run this statement."
            .to_string();
    }

    if normalized.contains("authentication")
        || normalized.contains("password")
        || normalized.contains("auth failed")
    {
        return "Database authentication failed. Please verify the connection settings."
            .to_string();
    }

    if normalized.contains("refused")
        || normalized.contains("broken pipe")
        || normalized.contains("connection reset")
        || normalized.contains("connection closed")
        || normalized.contains("not connected")
    {
        return "The database connection is no longer available. Please reconnect and try again."
            .to_string();
    }

    if normalized.contains("syntax")
        || normalized.contains("parse")
        || normalized.contains("parser")
        || normalized.contains("unexpected")
        || normalized.contains("unrecognized token")
        || normalized.contains("unterminated")
        || normalized.contains("near ")
    {
        return format!("SQL syntax error: {}", compact_message);
    }

    if normalized.contains("does not exist")
        || normalized.contains("unknown table")
        || normalized.contains("unknown column")
        || normalized.contains("no such table")
        || normalized.contains("no such column")
        || normalized.contains("invalid object name")
        || normalized.contains("invalid column")
        || normalized.contains("column not found")
        || normalized.contains("relation ")
    {
        return format!("Database object error: {}", compact_message);
    }

    if normalized.contains("ambiguous")
        || normalized.contains("duplicate column")
        || normalized.contains("duplicate alias")
        || normalized.contains("more than one row")
    {
        return format!("Query structure error: {}", compact_message);
    }

    if compact_message.is_empty() {
        "Query execution failed. Please review the SQL and connection state.".to_string()
    } else {
        format!("Query execution failed: {}", compact_message)
    }
}

fn validate_sandbox_statement(statement: &str) -> Result<(), String> {
    let decision = classify_sql(statement);
    if let Some(error) = decision.parse_error {
        return Err(format!("Sandbox gateway could not parse SQL: {error}"));
    }
    if decision.statements.len() != 1 {
        return Err(
            "Sandbox gateway requires exactly one SQL statement per execution item.".to_string(),
        );
    }
    let statement = &decision.statements[0];
    if matches!(
        statement.kind,
        SqlStatementKind::Session | SqlStatementKind::Transaction | SqlStatementKind::Unknown
    ) {
        return Err(
            "Sandbox gateway blocks session-control and access-control statements such as USE, ATTACH, SET search_path, transaction commands, and GRANT/REVOKE."
                .to_string(),
        );
    }

    Ok(())
}

fn validate_sandbox_batch(statements: &[String], require_read_only: bool) -> Result<(), String> {
    if statements.is_empty() {
        return Err("Sandbox execution requires at least one SQL statement.".to_string());
    }
    for statement in statements {
        validate_sandbox_statement(statement)?;
    }
    if require_read_only {
        let combined = statements.join(";\n");
        let decision = classify_sql(&combined);
        if decision.parse_error.is_some() || !decision.read_only {
            return Err("This execution boundary only permits read-only SQL.".to_string());
        }
    }
    Ok(())
}

fn timeout_for_statements<'a>(statements: impl Iterator<Item = &'a str>) -> Duration {
    let sql = statements.collect::<Vec<_>>().join(";\n");
    if classify_sql(&sql).read_only {
        READ_ONLY_QUERY_TIMEOUT
    } else {
        MUTATING_QUERY_TIMEOUT
    }
}

#[tauri::command]
pub fn classify_sql_safety(sql: String) -> SqlSafetyDecision {
    classify_sql(&sql)
}

#[tauri::command]
pub async fn execute_query(
    connection_id: String,
    sql: String,
    request_id: Option<String>,
    db_manager: State<'_, DatabaseManager>,
    cancellation_state: State<'_, QueryCancellationState>,
) -> Result<QueryResult, String> {
    let operation_id = Uuid::new_v4();
    db_manager
        .require_capability(&connection_id, DriverCapability::Query)
        .await
        .map_err(|error| error.to_string())?;
    log::info!(
        "operation_id={} operation=query.execute status=started connection_id={} statement_count={}",
        operation_id,
        connection_id,
        split_sql_statements(&sql).len()
    );
    let driver = db_manager.get_driver(&connection_id).await.map_err(|e| {
        let formatted = format_query_connection_error(e);
        log::error!(
            "operation_id={} operation=query.execute status=failed stage=connection error={}",
            operation_id,
            formatted
        );
        formatted
    })?;
    let statements = split_sql_statements(&sql);
    let timeout_window = timeout_for_statements(statements.iter().map(String::as_str));
    let request_id = request_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let cancellation_token = CancellationToken::new();
    if let Some(request_id) = request_id.as_deref() {
        cancellation_state
            .register(request_id, cancellation_token.clone())
            .await;
    }
    let result = tokio::select! {
        _ = cancellation_token.cancelled() => Err("Query cancelled.".to_string()),
        result = timeout(timeout_window, driver.execute_query(&sql)) => result
            .map_err(|_| {
            let err_msg = format!(
                "Query timed out after {} seconds.",
                timeout_window.as_secs()
            );
            log::error!(
                "operation_id={} operation=query.execute status=failed stage=timeout error={}",
                operation_id,
                err_msg
            );
            err_msg
        })
        .and_then(|result| result.map_err(|e| {
            let formatted = format_query_runtime_error(e);
            log::error!(
                "operation_id={} operation=query.execute status=failed stage=runtime error={}",
                operation_id,
                formatted
            );
            formatted
        })),
    };
    if let Some(request_id) = request_id.as_deref() {
        cancellation_state.finish(request_id).await;
    }
    let result = result?;
    log::info!(
        "operation_id={} operation=query.execute status=succeeded columns={} rows={}",
        operation_id,
        result.columns.len(),
        result.rows.len()
    );
    Ok(result)
}

#[tauri::command]
pub async fn cancel_query(
    request_id: String,
    cancellation_state: State<'_, QueryCancellationState>,
) -> Result<bool, String> {
    let request_id = request_id.trim();
    if request_id.is_empty() {
        return Err("Request ID cannot be empty.".to_string());
    }
    Ok(cancellation_state.cancel(request_id).await)
}

#[tauri::command]
pub async fn execute_parameterized_query(
    connection_id: String,
    sql: String,
    parameters: Vec<QueryParameter>,
    db_manager: State<'_, DatabaseManager>,
) -> Result<QueryResult, String> {
    let operation_id = Uuid::new_v4();
    db_manager
        .require_capability(&connection_id, DriverCapability::PreparedParameters)
        .await
        .map_err(|error| error.to_string())?;
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(format_query_connection_error)?;
    let style = match driver.driver_name() {
        "postgresql" | "greenplum" | "cockroachdb" | "redshift" | "vertica" => {
            PlaceholderStyle::DollarNumber
        }
        "mssql" => PlaceholderStyle::AtNumber,
        _ => PlaceholderStyle::QuestionMark,
    };
    let compiled = compile_parameterized_query(&sql, &parameters, style)
        .map_err(format_query_runtime_error)?;
    log::info!(
        "operation_id={} operation=query.execute_parameterized status=started connection_id={} parameter_count={}",
        operation_id,
        connection_id,
        parameters.len()
    );
    if split_sql_statements(&compiled.sql).len() != 1 {
        return Err("Prepared parameters only support one SQL statement at a time.".to_string());
    }
    let result = timeout(
        Duration::from_secs(30),
        driver.execute_parameterized_query(&compiled.sql, &compiled.parameters),
    )
    .await
    .map_err(|_| "Parameterized query timed out after 30 seconds.".to_string())?
    .map_err(format_query_runtime_error)?;
    log::info!(
        "operation_id={} operation=query.execute_parameterized status=succeeded columns={} rows={}",
        operation_id,
        result.columns.len(),
        result.rows.len()
    );
    Ok(result)
}

#[tauri::command]
pub async fn execute_sandboxed_query(
    connection_id: String,
    statements: Vec<String>,
    require_read_only: Option<bool>,
    db_manager: State<'_, DatabaseManager>,
) -> Result<QueryResult, String> {
    let operation_id = Uuid::new_v4();
    db_manager
        .require_capability(&connection_id, DriverCapability::Query)
        .await
        .map_err(|error| error.to_string())?;
    log::info!(
        "operation_id={} operation=query.execute_sandboxed status=started connection_id={} statements_count={}",
        operation_id,
        connection_id,
        statements.len()
    );
    if let Err(error) = validate_sandbox_batch(&statements, require_read_only.unwrap_or(false)) {
        log::error!(
            "operation_id={} operation=query.execute_sandboxed status=failed stage=validation error={}",
            operation_id,
            error
        );
        return Err(error);
    }

    let driver = db_manager.get_driver(&connection_id).await.map_err(|e| {
        let formatted = format_query_connection_error(e);
        log::error!(
            "operation_id={} operation=query.execute_sandboxed status=failed stage=connection error={}",
            operation_id,
            formatted
        );
        formatted
    })?;
    let timeout_window = timeout_for_statements(statements.iter().map(String::as_str));
    let combined_query = statements.join(";\n");
    let mut result = timeout(timeout_window, driver.execute_query(&combined_query))
        .await
        .map_err(|_| {
            let err_msg = format!(
                "Sandbox query timed out after {} seconds.",
                timeout_window.as_secs()
            );
            log::error!(
                "operation_id={} operation=query.execute_sandboxed status=failed stage=timeout error={}",
                operation_id,
                err_msg
            );
            err_msg
        })?
        .map_err(|e| {
            let formatted = format_query_runtime_error(e);
            log::error!(
                "operation_id={} operation=query.execute_sandboxed status=failed stage=runtime error={}",
                operation_id,
                formatted
            );
            formatted
        })?;
    result.sandboxed = true;
    log::info!(
        "operation_id={} operation=query.execute_sandboxed status=succeeded columns={} rows={}",
        operation_id,
        result.columns.len(),
        result.rows.len()
    );
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::{validate_sandbox_batch, validate_sandbox_statement, QueryCancellationState};
    use tokio_util::sync::CancellationToken;

    #[test]
    fn sandbox_uses_canonical_classifier_for_edge_cases() {
        assert!(validate_sandbox_statement("-- inspect\nSELECT 1").is_ok());
        assert!(validate_sandbox_statement(
            "WITH changed AS (DELETE FROM users RETURNING id) SELECT * FROM changed"
        )
        .is_ok());
        assert!(validate_sandbox_statement("SET search_path TO public").is_err());
        assert!(validate_sandbox_statement("SELECT 1; SELECT 2").is_err());
        assert!(validate_sandbox_statement("-- no executable SQL").is_err());
    }

    #[test]
    fn read_only_sandbox_rejects_mutating_ctes() {
        let mutating = vec![
            "WITH changed AS (DELETE FROM users RETURNING id) SELECT * FROM changed".to_string(),
        ];
        assert!(validate_sandbox_batch(&mutating, true).is_err());
        assert!(validate_sandbox_batch(&mutating, false).is_ok());
    }

    #[tokio::test]
    async fn cancellation_registry_replaces_and_cancels_active_requests() {
        let state = QueryCancellationState::default();
        let first = CancellationToken::new();
        let second = CancellationToken::new();

        state.register("query-1", first.clone()).await;
        state.register("query-1", second.clone()).await;
        assert!(first.is_cancelled());
        assert!(!second.is_cancelled());

        assert!(state.cancel("query-1").await);
        assert!(second.is_cancelled());
        state.finish("query-1").await;
        assert!(!state.cancel("query-1").await);
    }
}
