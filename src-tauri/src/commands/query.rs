use crate::commands::safe_mode::SafeModeState;
use crate::database::capabilities::{
    agent_sql_read_unsupported_error, agent_sql_write_preview_unsupported_error, DriverCapability,
};
use crate::database::manager::DatabaseManager;
use crate::database::models::QueryParameter;
use crate::database::models::QueryResult;
use crate::database::parameterized_query::{
    compile_parameterized_query, placeholder_style_for_database,
};
use crate::error::AppError;
use crate::utils::sql::{
    classify_sql_with_dialect, split_sql_statements, SqlSafetyDecision, SqlStatementKind,
};
use std::collections::HashMap;
use tauri::{Emitter, State};
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

fn validate_sandbox_statement(
    statement: &str,
    database_type: Option<crate::database::models::DatabaseType>,
) -> Result<(), String> {
    let decision = classify_sql_with_dialect(statement, database_type);
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

fn validate_sandbox_batch(
    statements: &[String],
    require_read_only: bool,
    database_type: Option<crate::database::models::DatabaseType>,
) -> Result<(), String> {
    if statements.is_empty() {
        return Err("Sandbox execution requires at least one SQL statement."
            .to_string()
            .into());
    }
    for statement in statements {
        validate_sandbox_statement(statement, database_type)?;
    }
    if require_read_only {
        let combined = statements.join(";\n");
        let decision = classify_sql_with_dialect(&combined, database_type);
        if decision.parse_error.is_some() || !decision.read_only {
            return Err("This execution boundary only permits read-only SQL."
                .to_string()
                .into());
        }
    }
    Ok(())
}

fn timeout_for_statements<'a>(
    statements: impl Iterator<Item = &'a str>,
    database_type: Option<crate::database::models::DatabaseType>,
) -> Duration {
    let sql = statements.collect::<Vec<_>>().join(";\n");
    if classify_sql_with_dialect(&sql, database_type).read_only {
        READ_ONLY_QUERY_TIMEOUT
    } else {
        MUTATING_QUERY_TIMEOUT
    }
}

#[tauri::command]
pub fn classify_sql_safety(sql: String, database_type: Option<String>) -> SqlSafetyDecision {
    let parsed_type = database_type
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| crate::commands::schema_diff::parse_dialect(value).ok());
    classify_sql_with_dialect(&sql, parsed_type)
}

#[tauri::command]
pub async fn execute_query(
    connection_id: String,
    sql: String,
    request_id: Option<String>,
    safe_mode_approved_by_user: Option<bool>,
    db_manager: State<'_, DatabaseManager>,
    cancellation_state: State<'_, QueryCancellationState>,
    safe_mode: State<'_, SafeModeState>,
) -> Result<QueryResult, AppError> {
    safe_mode
        .assert_sql_allowed_with_approval(
            &connection_id,
            &sql,
            safe_mode_approved_by_user.unwrap_or(false),
        )
        .await?;
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
    let db_type = db_manager
        .connection_database_type(&connection_id)
        .await
        .ok();
    let timeout_window = timeout_for_statements(statements.iter().map(String::as_str), db_type);
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
    let exec = async {
        if let Some(ref id) = request_id {
            driver.execute_query_for_request(id, &sql).await
        } else {
            driver.execute_query(&sql).await
        }
    };
    let result = tokio::select! {
        _ = cancellation_token.cancelled() => Err("Query cancelled.".to_string()),
        result = timeout(timeout_window, exec) => result
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
    connection_id: Option<String>,
    db_manager: State<'_, DatabaseManager>,
    cancellation_state: State<'_, QueryCancellationState>,
) -> Result<bool, AppError> {
    let request_id = request_id.trim();
    if request_id.is_empty() {
        return Err("Request ID cannot be empty.".to_string().into());
    }
    let token_cancelled = cancellation_state.cancel(request_id).await;
    let mut server_cancelled = false;
    if let Some(connection_id) = connection_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if let Ok(driver) = db_manager.get_driver(connection_id).await {
            server_cancelled = driver
                .cancel_query_request(request_id)
                .await
                .unwrap_or(false);
        }
    }
    Ok(token_cancelled || server_cancelled)
}

/// Progressive result delivery for large read queries (roadmap Phase 3B).
///
/// The driver materializes the full result once (all drivers are fetch-all
/// today); this command then emits `query-row-batch` events so the frontend
/// can render rows progressively instead of blocking on one giant payload.
/// Cancellation between chunks rides the existing `cancel_query` registry.
/// Read-only is pinned: this boundary exists for browsing large results.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn execute_query_progressive(
    connection_id: String,
    sql: String,
    chunk_size: Option<usize>,
    request_id: Option<String>,
    safe_mode_approved_by_user: Option<bool>,
    app_handle: tauri::AppHandle,
    db_manager: State<'_, DatabaseManager>,
    cancellation_state: State<'_, QueryCancellationState>,
    safe_mode: State<'_, SafeModeState>,
) -> Result<QueryResult, AppError> {
    safe_mode
        .assert_sql_allowed_with_approval(
            &connection_id,
            &sql,
            safe_mode_approved_by_user.unwrap_or(false),
        )
        .await?;
    let database_type = db_manager
        .connection_database_type(&connection_id)
        .await
        .map_err(|error| error.to_string())?;
    if let Some(message) = agent_sql_read_unsupported_error(database_type) {
        return Err(AppError::Query(message));
    }
    validate_sandbox_batch(std::slice::from_ref(&sql), true, Some(database_type))?;
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(format_query_connection_error)?;

    let request_id = request_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let cancellation_token = CancellationToken::new();
    if let Some(ref id) = request_id {
        cancellation_state
            .register(id, cancellation_token.clone())
            .await;
    }
    let exec = async {
        if let Some(ref id) = request_id {
            driver.execute_query_for_request(id, &sql).await
        } else {
            driver.execute_query(&sql).await
        }
    };
    let result = timeout(READ_ONLY_QUERY_TIMEOUT, exec).await;
    let mut result = match result {
        Ok(inner) => inner.map_err(format_query_runtime_error)?,
        Err(_) => {
            if let Some(ref id) = request_id {
                cancellation_state.finish(id).await;
            }
            return Err(AppError::Query("Progressive query timed out.".to_string()));
        }
    };

    // Emit bounded row batches so the UI appends progressively. The
    // cancellation entry stays registered until emission ends so
    // `cancel_query` can still stop a slow consumer mid-stream.
    let chunk_size = chunk_size.unwrap_or(500).clamp(50, 5_000);
    let total_rows = result.rows.len();
    for (batch_index, chunk) in chunk_rows(total_rows, chunk_size).into_iter().enumerate() {
        if cancellation_token.is_cancelled() {
            result.truncated = true;
            break;
        }
        let _ = app_handle.emit(
            "query-row-batch",
            serde_json::json!({
                "connectionId": connection_id,
                "columns": if batch_index == 0 { result.columns.clone() } else { Vec::new() },
                "rows": &result.rows[chunk.0..chunk.1],
                "offset": chunk.0,
                "totalRows": total_rows,
                "done": chunk.1 >= total_rows,
            }),
        );
    }
    if let Some(ref id) = request_id {
        cancellation_state.finish(id).await;
    }
    Ok(result)
}

/// Contiguous `(start, end)` boundaries for `total` rows in `chunk_size` steps.
fn chunk_rows(total: usize, chunk_size: usize) -> Vec<(usize, usize)> {
    let step = chunk_size.max(1);
    (0..total)
        .step_by(step)
        .map(|start| (start, (start + step).min(total)))
        .collect()
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn execute_parameterized_query(
    connection_id: String,
    sql: String,
    parameters: Vec<QueryParameter>,
    request_id: Option<String>,
    safe_mode_approved_by_user: Option<bool>,
    db_manager: State<'_, DatabaseManager>,
    cancellation_state: State<'_, QueryCancellationState>,
    safe_mode: State<'_, SafeModeState>,
) -> Result<QueryResult, AppError> {
    safe_mode
        .assert_sql_allowed_with_approval(
            &connection_id,
            &sql,
            safe_mode_approved_by_user.unwrap_or(false),
        )
        .await?;
    let operation_id = Uuid::new_v4();
    db_manager
        .require_capability(&connection_id, DriverCapability::PreparedParameters)
        .await
        .map_err(|error| error.to_string())?;
    let database_type = db_manager
        .connection_database_type(&connection_id)
        .await
        .map_err(format_query_connection_error)?;
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(format_query_connection_error)?;
    let style = placeholder_style_for_database(database_type);
    let compiled = compile_parameterized_query(&sql, &parameters, style)
        .map_err(format_query_runtime_error)?;
    log::info!(
        "operation_id={} operation=query.execute_parameterized status=started connection_id={} parameter_count={}",
        operation_id,
        connection_id,
        parameters.len()
    );
    if split_sql_statements(&compiled.sql).len() != 1 {
        return Err(
            "Prepared parameters only support one SQL statement at a time."
                .to_string()
                .into(),
        );
    }
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
    let timeout_window =
        timeout_for_statements(std::iter::once(compiled.sql.as_str()), Some(database_type));
    let exec = async {
        if let Some(ref id) = request_id {
            driver
                .execute_parameterized_query_for_request(id, &compiled.sql, &compiled.parameters)
                .await
        } else {
            driver
                .execute_parameterized_query(&compiled.sql, &compiled.parameters)
                .await
        }
    };
    let result = tokio::select! {
        _ = cancellation_token.cancelled() => Err("Query cancelled.".to_string()),
        result = timeout(timeout_window, exec) => result
            .map_err(|_| format!(
                "Parameterized query timed out after {} seconds.",
                timeout_window.as_secs()
            ))
            .and_then(|result| result.map_err(format_query_runtime_error)),
    };
    if let Some(request_id) = request_id.as_deref() {
        cancellation_state.finish(request_id).await;
    }
    let result = result?;
    log::info!(
        "operation_id={} operation=query.execute_parameterized status=succeeded columns={} rows={}",
        operation_id,
        result.columns.len(),
        result.rows.len()
    );
    Ok(result)
}

/// Result of a write preview: per-statement outcomes plus the guarantee flag.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewWriteResult {
    pub results: Vec<QueryResult>,
    pub rolled_back: bool,
}

const MAX_PREVIEW_STATEMENTS: usize = 10;

/// Runs the agent's proposed mutating statements inside one transaction and
/// ALWAYS rolls back, so the caller sees affected rows without persisting
/// anything. The human still applies real changes through the approval flow.
/// Safe Mode is asserted without an approval flag: this is an agent path, and
/// autonomous paths must never write through a guard tier — even temporarily.
/// Levels 1-2 therefore refuse previews of blocked writes (nothing persists,
/// so the human loses nothing); level 3+ previews pass for confirmable DML.
#[tauri::command]
pub async fn preview_write_transaction(
    connection_id: String,
    statements: Vec<String>,
    db_manager: State<'_, DatabaseManager>,
    safe_mode: State<'_, SafeModeState>,
) -> Result<PreviewWriteResult, AppError> {
    safe_mode
        .assert_sql_allowed(&connection_id, &statements.join(";\n"))
        .await?;
    db_manager
        .require_capability(&connection_id, DriverCapability::Query)
        .await
        .map_err(|error| error.to_string())?;
    let database_type = db_manager
        .connection_database_type(&connection_id)
        .await
        .map_err(|error| error.to_string())?;
    if let Some(message) = agent_sql_write_preview_unsupported_error(database_type) {
        return Err(message.into());
    }

    if statements.is_empty() || statements.len() > MAX_PREVIEW_STATEMENTS {
        return Err(AppError::from(format!(
            "Write preview accepts between 1 and {MAX_PREVIEW_STATEMENTS} statements."
        )));
    }
    let db_type = db_manager
        .connection_database_type(&connection_id)
        .await
        .ok();
    validate_sandbox_batch(&statements, false, db_type)?;
    let has_mutating = statements
        .iter()
        .any(|statement| !classify_sql_with_dialect(statement, db_type).read_only);
    if !has_mutating {
        return Err(AppError::from(
            "Write preview requires at least one data- or schema-changing statement.".to_string(),
        ));
    }

    let operation_id = Uuid::new_v4();
    log::info!(
        "operation_id={operation_id} operation=query.preview_write status=started connection_id={} statements_count={}",
        connection_id,
        statements.len()
    );

    let timeout_window = timeout_for_statements(statements.iter().map(String::as_str), db_type);
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(format_query_connection_error)?;

    let preview = timeout(timeout_window, driver.preview_write_transaction(&statements))
        .await
        .map_err(|_| {
            format!(
                "Write preview timed out after {} seconds.",
                timeout_window.as_secs()
            )
        })?
        .map_err(|error| {
            let formatted = format_query_runtime_error(error);
            log::error!(
                "operation_id={operation_id} operation=query.preview_write status=failed error={formatted}"
            );
            formatted
        })?;

    log::info!(
        "operation_id={operation_id} operation=query.preview_write status=rolled_back statements_count={}",
        preview.len()
    );
    Ok(PreviewWriteResult {
        results: preview,
        rolled_back: true,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn execute_sandboxed_query(
    connection_id: String,
    statements: Vec<String>,
    require_read_only: Option<bool>,
    request_id: Option<String>,
    safe_mode_approved_by_user: Option<bool>,
    db_manager: State<'_, DatabaseManager>,
    cancellation_state: State<'_, QueryCancellationState>,
    safe_mode: State<'_, SafeModeState>,
) -> Result<QueryResult, AppError> {
    safe_mode
        .assert_sql_allowed_with_approval(
            &connection_id,
            &statements.join(";\n"),
            safe_mode_approved_by_user.unwrap_or(false),
        )
        .await?;
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
    let db_type = db_manager
        .connection_database_type(&connection_id)
        .await
        .ok();
    if let Err(error) =
        validate_sandbox_batch(&statements, require_read_only.unwrap_or(false), db_type)
    {
        log::error!(
            "operation_id={} operation=query.execute_sandboxed status=failed stage=validation error={}",
            operation_id,
            error
        );
        return Err(AppError::from(error));
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
    let timeout_window = timeout_for_statements(statements.iter().map(String::as_str), db_type);
    let combined_query = statements.join(";\n");
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
    let exec = async {
        if let Some(ref id) = request_id {
            driver.execute_query_for_request(id, &combined_query).await
        } else {
            driver.execute_query(&combined_query).await
        }
    };
    let result = tokio::select! {
        _ = cancellation_token.cancelled() => Err("Query cancelled.".to_string()),
        result = timeout(timeout_window, exec) => result
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
            })
            .and_then(|result| result.map_err(|e| {
                let formatted = format_query_runtime_error(e);
                log::error!(
                    "operation_id={} operation=query.execute_sandboxed status=failed stage=runtime error={}",
                    operation_id,
                    formatted
                );
                formatted
            })),
    };
    if let Some(request_id) = request_id.as_deref() {
        cancellation_state.finish(request_id).await;
    }
    let mut result = result?;
    result.sandboxed = true;
    log::info!(
        "operation_id={} operation=query.execute_sandboxed status=succeeded columns={} rows={}",
        operation_id,
        result.columns.len(),
        result.rows.len()
    );
    Ok(result)
}

/// Read-only + prepared-parameters boundary for the AI agent's
/// `run_parameterized_sql` / `find_value` tools (MỚI-2/MỚI-3).
///
/// Combines both agent guarantees in one command: the read-only pin from
/// [`execute_agent_readonly_query`] (no caller-lowerable flag, mutations and
/// session SQL rejected before the driver is involved) and the parameter
/// compilation of [`execute_parameterized_query`] (named `:name` bindings are
/// compiled to engine placeholders and never spliced into the SQL text).
#[tauri::command]
pub async fn execute_agent_parameterized_query(
    connection_id: String,
    sql: String,
    parameters: Vec<QueryParameter>,
    request_id: Option<String>,
    db_manager: State<'_, DatabaseManager>,
    cancellation_state: State<'_, QueryCancellationState>,
    safe_mode: State<'_, SafeModeState>,
) -> Result<QueryResult, AppError> {
    let database_type = db_manager
        .connection_database_type(&connection_id)
        .await
        .map_err(|error| error.to_string())?;
    if let Some(message) = agent_sql_read_unsupported_error(database_type) {
        return Err(message.into());
    }
    db_manager
        .require_capability(&connection_id, DriverCapability::PreparedParameters)
        .await
        .map_err(|error| error.to_string())?;
    // Same read-only pin `execute_agent_readonly_query` hard-codes: there is
    // no caller argument that can lower this boundary.
    validate_sandbox_batch(std::slice::from_ref(&sql), true, Some(database_type))?;
    let style = placeholder_style_for_database(database_type);
    let compiled =
        compile_parameterized_query(&sql, &parameters, style).map_err(|error| error.to_string())?;
    if split_sql_statements(&compiled.sql).len() != 1 {
        return Err(
            "The agent parameterized tool accepts exactly one SQL statement."
                .to_string()
                .into(),
        );
    }
    execute_parameterized_query(
        connection_id,
        compiled.sql,
        compiled.parameters,
        request_id,
        // Agent tool path: never carries human approval.
        None,
        db_manager,
        cancellation_state,
        safe_mode,
    )
    .await
}

/// Read-only execution boundary for the AI agent's `run_readonly_sql` tool.
///
/// Unlike [`execute_sandboxed_query`], read-only enforcement is pinned
/// server-side and cannot be lowered by the caller: there is no
/// `require_read_only` flag to pass. Any mutating, session-control, or
/// access-control statement is rejected by `validate_sandbox_batch` before it
/// ever reaches the driver. This keeps the agent read tool safe even if a
/// frontend caller forgets (or is manipulated) to request read-only mode.
#[tauri::command]
pub async fn execute_agent_readonly_query(
    connection_id: String,
    statements: Vec<String>,
    request_id: Option<String>,
    db_manager: State<'_, DatabaseManager>,
    cancellation_state: State<'_, QueryCancellationState>,
    safe_mode: State<'_, SafeModeState>,
) -> Result<QueryResult, AppError> {
    let database_type = db_manager
        .connection_database_type(&connection_id)
        .await
        .map_err(|error| error.to_string())?;
    if let Some(message) = agent_sql_read_unsupported_error(database_type) {
        return Err(message.into());
    }
    // Pin is local to this command: callers have no `require_read_only` argument
    // they could flip. Fail here first so a future change to the shared
    // sandbox helper cannot silently lower the agent boundary.
    validate_sandbox_batch(&statements, true, Some(database_type))?;
    execute_sandboxed_query(
        connection_id,
        statements,
        Some(true),
        request_id,
        // Agent tool path: never carries human approval.
        None,
        db_manager,
        cancellation_state,
        safe_mode,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::{
        timeout_for_statements, validate_sandbox_batch, validate_sandbox_statement,
        QueryCancellationState, MUTATING_QUERY_TIMEOUT, READ_ONLY_QUERY_TIMEOUT,
    };
    use tokio_util::sync::CancellationToken;

    #[test]
    fn sandbox_uses_canonical_classifier_for_edge_cases() {
        assert!(validate_sandbox_statement("-- inspect\nSELECT 1", None).is_ok());
        assert!(validate_sandbox_statement(
            "WITH changed AS (DELETE FROM users RETURNING id) SELECT * FROM changed",
            None
        )
        .is_ok());
        assert!(validate_sandbox_statement("SET search_path TO public", None).is_err());
        assert!(validate_sandbox_statement("SELECT 1; SELECT 2", None).is_err());
        assert!(validate_sandbox_statement("-- no executable SQL", None).is_err());
    }

    #[test]
    fn mysql_server_commands_classify_readonly_under_mysql_dialect() {
        use crate::database::models::DatabaseType;
        // SHOW FULL PROCESSLIST fails the generic parser; the MySQL dialect
        // (plus the read-only server-command fallback) must classify it as a
        // read so the process-list preset works on MySQL/MariaDB.
        let decision = validate_sandbox_batch(
            &["SHOW FULL PROCESSLIST".to_string()],
            true,
            Some(DatabaseType::MySQL),
        );
        assert!(
            decision.is_ok(),
            "mysql process-list preset must pass: {decision:?}"
        );
        assert!(
            validate_sandbox_batch(&["SHOW FULL PROCESSLIST".to_string()], true, None).is_err()
        );
        // The fallback must not widen the boundary to mutations.
        assert!(validate_sandbox_batch(
            &["UPDATE users SET name = 'x'".to_string()],
            true,
            Some(DatabaseType::MySQL),
        )
        .is_err());
    }

    #[test]
    fn read_only_sandbox_rejects_mutating_ctes() {
        let mutating = vec![
            "WITH changed AS (DELETE FROM users RETURNING id) SELECT * FROM changed".to_string(),
        ];
        assert!(validate_sandbox_batch(&mutating, true, None).is_err());
        assert!(validate_sandbox_batch(&mutating, false, None).is_ok());
    }

    #[test]
    fn agent_readonly_boundary_blocks_mutations_and_allows_reads() {
        // `execute_agent_readonly_query` pins require_read_only = true, so the
        // shared batch validator must accept plain reads while rejecting every
        // mutating or schema-changing statement regardless of caller intent.
        assert!(validate_sandbox_batch(&["SELECT 1".to_string()], true, None).is_ok());
        assert!(validate_sandbox_batch(&["EXPLAIN SELECT 1".to_string()], true, None).is_ok());
        assert!(
            validate_sandbox_batch(&["UPDATE users SET name = 'x'".to_string()], true, None)
                .is_err()
        );
        assert!(validate_sandbox_batch(&["DELETE FROM users".to_string()], true, None).is_err());
        assert!(validate_sandbox_batch(&["DROP TABLE users".to_string()], true, None).is_err());
        assert!(validate_sandbox_batch(
            &["INSERT INTO users(name) VALUES('x')".to_string()],
            true,
            None
        )
        .is_err());
    }

    #[test]
    fn agent_parameterized_boundary_blocks_mutations_and_keeps_placeholders() {
        // The agent parameterized boundary pins read-only exactly like
        // `execute_agent_readonly_query`; placeholders must not slip past the
        // guard, and mutations are rejected before compilation.
        assert!(validate_sandbox_batch(
            &["SELECT * FROM users WHERE name = :name".to_string()],
            true,
            None,
        )
        .is_ok());
        assert!(
            validate_sandbox_batch(&["UPDATE users SET name = :name".to_string()], true, None)
                .is_err()
        );
        assert!(validate_sandbox_batch(
            &["DELETE FROM users WHERE id = :id".to_string()],
            true,
            None
        )
        .is_err());
        assert!(validate_sandbox_batch(
            &["SELECT 1; DELETE FROM users WHERE id = :id".to_string()],
            true,
            None
        )
        .is_err());
    }

    #[test]
    fn chunk_rows_covers_all_rows_with_bounded_batches() {
        use super::chunk_rows;
        assert!(chunk_rows(0, 500).is_empty());
        assert_eq!(chunk_rows(5, 500), vec![(0, 5)]);
        assert_eq!(
            chunk_rows(1_100, 500),
            vec![(0, 500), (500, 1_000), (1_000, 1_100)]
        );
        // chunk_size is sanitized by the caller, but the helper stays safe anyway.
        assert_eq!(chunk_rows(3, 0), vec![(0, 1), (1, 2), (2, 3)]);
    }

    #[tokio::test]
    async fn agent_readonly_command_rejects_mutating_sql_that_looks_harmless() {
        // Same pin `execute_agent_readonly_query` hard-codes. These statements
        // start like reads (WITH/SELECT-shaped) or look like "just SQL", but
        // the boundary must still refuse them before a driver is involved.
        let rejected = [
            "UPDATE users SET name = 'x'",
            "DELETE FROM users",
            "DROP TABLE users",
            "ALTER TABLE users ADD COLUMN x INT",
            "INSERT INTO users(name) VALUES('x')",
            "TRUNCATE TABLE users",
            "CREATE TABLE x (id INT)",
            "WITH changed AS (DELETE FROM users RETURNING id) SELECT * FROM changed",
            "SELECT 1; DELETE FROM users",
        ];
        for sql in rejected {
            assert!(
                validate_sandbox_batch(&[sql.to_string()], true, None).is_err(),
                "agent read-only boundary must reject {sql}"
            );
        }
        assert!(validate_sandbox_batch(&["SELECT 1".to_string()], true, None).is_ok());
        assert!(validate_sandbox_batch(
            &["WITH x AS (SELECT 1) SELECT * FROM x".to_string()],
            true,
            None
        )
        .is_ok());
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

    #[test]
    fn timeout_uses_read_only_window_only_for_read_batches() {
        assert_eq!(
            timeout_for_statements(["SELECT 1"].into_iter(), None),
            READ_ONLY_QUERY_TIMEOUT
        );
        assert_eq!(
            timeout_for_statements(["SELECT 1", "SELECT 2"].into_iter(), None),
            READ_ONLY_QUERY_TIMEOUT
        );
        assert_eq!(
            timeout_for_statements(["UPDATE users SET name = 'x'"].into_iter(), None),
            MUTATING_QUERY_TIMEOUT
        );
        assert_eq!(
            timeout_for_statements(["SELECT 1", "DELETE FROM users"].into_iter(), None),
            MUTATING_QUERY_TIMEOUT
        );
        assert_eq!(
            timeout_for_statements(
                ["WITH changed AS (DELETE FROM users RETURNING id) SELECT * FROM changed"]
                    .into_iter(),
                None
            ),
            MUTATING_QUERY_TIMEOUT
        );
    }
}
