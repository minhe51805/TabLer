use crate::commands::safe_mode::SafeModeState;
use crate::database::capabilities::{
    agent_sql_read_unsupported_error, agent_sql_write_preview_unsupported_error, DriverCapability,
};
use crate::database::manager::DatabaseManager;
use crate::database::models::DatabaseType;
use crate::database::models::QueryParameter;
use crate::database::models::QueryResult;
use crate::database::parameterized_query::{
    compile_parameterized_query, placeholder_style_for_database,
};
use crate::error::AppError;
use crate::utils::sql::{classify_sql_with_dialect, split_sql_statements, SqlSafetyDecision};
use tauri::{Emitter, State};
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

// Query timeouts (D5) and sandbox caps (D10) are centralized in `crate::config`.
// Timeouts are resolved at call time via `read_only_query_timeout()` /
// `mutating_query_timeout()` so an operator env override can raise them without
// changing the compiled defaults (180s read / 60s mutating).
//
// Sandbox result caps for AI-agent reads (defense-in-depth alongside the query
// timeout). The agent works from SAMPLES, so a run past either ceiling is
// truncated and flagged `truncated` so the model knows it did not see the full
// set. Human paths (SQL editor, metrics) pass `None` and are never capped here.
use crate::config::{SANDBOX_AGENT_MAX_RESULT_BYTES, SANDBOX_AGENT_MAX_ROWS};

mod cancellation;
mod errors;
mod sandbox;
#[cfg(test)]
mod tests;

pub use cancellation::QueryCancellationState;
use errors::{format_query_connection_error, format_query_runtime_error};
use sandbox::{
    cap_sandbox_result, log_sandbox_denial, reject_dangerous_capability, timeout_for_statements,
    validate_sandbox_batch,
};
/// Per-connection read-only pin for SQL-executing commands: when the live
/// session was opened with `ConnectionConfig::read_only`, any batch that does
/// not classify as fully read-only is rejected before the driver is touched.
/// Unparseable SQL fails closed (the classifier reports `read_only = false`
/// on parse errors), so a read-only connection can never smuggle a statement
/// past the guard by being unclassifiable.
async fn assert_connection_writable_sql(
    db_manager: &DatabaseManager,
    connection_id: &str,
    sql: &str,
) -> Result<(), AppError> {
    if !db_manager.is_read_only(connection_id).await {
        return Ok(());
    }
    let db_type = db_manager
        .connection_database_type(connection_id)
        .await
        .ok();
    if classify_sql_with_dialect(sql, db_type).read_only {
        return Ok(());
    }
    db_manager
        .assert_write_allowed(connection_id)
        .await
        .map_err(AppError::from)
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
#[allow(clippy::too_many_arguments)]
pub async fn execute_query(
    connection_id: String,
    sql: String,
    request_id: Option<String>,
    // Optional per-query wall-clock override (roadmap Phase 3D backend perf).
    // `None`/`0` keep the classified default (180s read / 60s mutating); any
    // positive value is clamped to 1s–600s by `config::resolve_query_timeout`.
    timeout_ms: Option<u64>,
    safe_mode_approved_by_user: Option<bool>,
    db_manager: State<'_, DatabaseManager>,
    cancellation_state: State<'_, QueryCancellationState>,
    safe_mode: State<'_, SafeModeState>,
) -> Result<QueryResult, AppError> {
    assert_connection_writable_sql(db_manager.inner(), &connection_id, &sql).await?;
    // The connection's real dialect drives both Safe Mode classification and
    // the capability gate — a MySQL `SHOW` must not read as unparseable.
    let db_type = db_manager
        .connection_database_type(&connection_id)
        .await
        .ok();
    safe_mode
        .assert_sql_allowed_with_approval(
            &connection_id,
            &sql,
            db_type,
            safe_mode_approved_by_user.unwrap_or(false),
        )
        .await?;
    // Human-typed SQL gets the same filesystem/network/OS capability gate as
    // the sandbox path — pg_read_file is just as dangerous from the editor.
    reject_dangerous_capability(&sql, db_type)?;
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
    // Per-connection `query_timeout_seconds` replaces the classified default
    // window; an explicit per-query `timeout_ms` still wins over both.
    let connection_timeout = db_manager.connection_query_timeout(&connection_id).await;
    let timeout_window = crate::config::resolve_query_timeout(
        timeout_ms,
        crate::config::resolve_connection_query_timeout(
            connection_timeout,
            timeout_for_statements(statements.iter().map(String::as_str), db_type),
        ),
    );
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
    let Some(connection_id) = connection_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        // No connection context: only the local token could be signalled.
        return Ok(token_cancelled);
    };
    // The caller asked for a server-side cancel: report whether it was
    // actually DELIVERED. A driver lookup or KILL failure is surfaced as an
    // error — folding it into `false` would claim "nothing to cancel" while
    // the server keeps running the statement.
    let driver = db_manager
        .get_driver(connection_id)
        .await
        .map_err(|error| format!("Cancel could not reach the connection's driver: {error}"))?;
    let server_cancelled = driver
        .cancel_query_request(request_id)
        .await
        .map_err(|error| format!("Server-side cancel failed: {error}"))?;
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
    let database_type = db_manager
        .connection_database_type(&connection_id)
        .await
        .map_err(|error| error.to_string())?;
    safe_mode
        .assert_sql_allowed_with_approval(
            &connection_id,
            &sql,
            Some(database_type),
            safe_mode_approved_by_user.unwrap_or(false),
        )
        .await?;
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
    if let Some(id) = &request_id {
        cancellation_state
            .register(id, cancellation_token.clone())
            .await;
    }
    let exec = async {
        if let Some(id) = &request_id {
            driver.execute_query_for_request(id, &sql).await
        } else {
            driver.execute_query(&sql).await
        }
    };
    // The cancel token must win during the FETCH phase too — a cancelled
    // progressive query cannot wait for the full result before noticing.
    let result = tokio::select! {
        _ = cancellation_token.cancelled() => {
            if let Some(id) = &request_id {
                cancellation_state.finish(id).await;
            }
            return Err(AppError::Query("Query cancelled.".to_string()));
        }
        result = timeout(
            crate::config::resolve_connection_query_timeout(
                db_manager.connection_query_timeout(&connection_id).await,
                crate::config::read_only_query_timeout(),
            ),
            exec,
        ) => result,
    };
    let mut result = match result {
        Ok(inner) => inner.map_err(format_query_runtime_error)?,
        Err(_) => {
            if let Some(id) = &request_id {
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
    assert_connection_writable_sql(db_manager.inner(), &connection_id, &sql).await?;
    let database_type = db_manager
        .connection_database_type(&connection_id)
        .await
        .map_err(format_query_connection_error)?;
    safe_mode
        .assert_sql_allowed_with_approval(
            &connection_id,
            &sql,
            Some(database_type),
            safe_mode_approved_by_user.unwrap_or(false),
        )
        .await?;
    let operation_id = Uuid::new_v4();
    db_manager
        .require_capability(&connection_id, DriverCapability::PreparedParameters)
        .await
        .map_err(|error| error.to_string())?;
    // Same filesystem/network/OS capability gate as the sandbox path.
    reject_dangerous_capability(&sql, Some(database_type))?;
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
    let timeout_window = crate::config::resolve_connection_query_timeout(
        db_manager.connection_query_timeout(&connection_id).await,
        timeout_for_statements(std::iter::once(compiled.sql.as_str()), Some(database_type)),
    );
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
    db_manager
        .assert_write_allowed(&connection_id)
        .await
        .map_err(AppError::from)?;
    let database_type = db_manager
        .connection_database_type(&connection_id)
        .await
        .map_err(|error| error.to_string())?;
    safe_mode
        .assert_sql_allowed(&connection_id, &statements.join(";\n"), Some(database_type))
        .await?;
    db_manager
        .require_capability(&connection_id, DriverCapability::Query)
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
    let db_type = Some(database_type);
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
    // AI-agent reads pass a ceiling so an unbounded SELECT can never pull the
    // whole table into the model; human paths (editor, metrics) omit it.
    max_rows: Option<usize>,
    db_manager: State<'_, DatabaseManager>,
    cancellation_state: State<'_, QueryCancellationState>,
    safe_mode: State<'_, SafeModeState>,
) -> Result<QueryResult, AppError> {
    assert_connection_writable_sql(db_manager.inner(), &connection_id, &statements.join(";\n"))
        .await?;
    let db_type = db_manager
        .connection_database_type(&connection_id)
        .await
        .ok();
    safe_mode
        .assert_sql_allowed_with_approval(
            &connection_id,
            &statements.join(";\n"),
            db_type,
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
    if let Err(error) =
        validate_sandbox_batch(&statements, require_read_only.unwrap_or(false), db_type)
    {
        log::error!(
            "operation_id={} operation=query.execute_sandboxed status=failed stage=validation error={}",
            operation_id,
            error
        );
        log_sandbox_denial(&connection_id, statements.len(), &error);
        return Err(AppError::from(error));
    }

    run_sandboxed_statements(
        &connection_id,
        &statements,
        request_id,
        max_rows,
        db_manager.inner(),
        cancellation_state.inner(),
        "query.execute_sandboxed",
    )
    .await
}

/// Shared tail of the sandboxed execution path: resolve the driver, run the
/// combined statements under the classified timeout with cancellation, and
/// apply the agent result cap. Callers own their own validation and Safe Mode
/// policy — this helper only executes what it is given.
async fn run_sandboxed_statements(
    connection_id: &str,
    statements: &[String],
    request_id: Option<String>,
    max_rows: Option<usize>,
    db_manager: &DatabaseManager,
    cancellation_state: &QueryCancellationState,
    operation: &str,
) -> Result<QueryResult, AppError> {
    let operation_id = Uuid::new_v4();
    let db_type = db_manager
        .connection_database_type(connection_id)
        .await
        .ok();
    let driver = db_manager.get_driver(connection_id).await.map_err(|e| {
        let formatted = format_query_connection_error(e);
        log::error!(
            "operation_id={operation_id} operation={operation} status=failed stage=connection error={formatted}"
        );
        formatted
    })?;
    let timeout_window = crate::config::resolve_connection_query_timeout(
        db_manager.connection_query_timeout(connection_id).await,
        timeout_for_statements(statements.iter().map(String::as_str), db_type),
    );
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
        if let Some(id) = request_id.as_deref() {
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
                    "operation_id={operation_id} operation={operation} status=failed stage=timeout error={err_msg}"
                );
                err_msg
            })
            .and_then(|result| result.map_err(|e| {
                let formatted = format_query_runtime_error(e);
                log::error!(
                    "operation_id={operation_id} operation={operation} status=failed stage=runtime error={formatted}"
                );
                formatted
            })),
    };
    if let Some(request_id) = request_id.as_deref() {
        cancellation_state.finish(request_id).await;
    }
    let mut result = result?;
    result.sandboxed = true;
    if let Some(max_rows) = max_rows {
        cap_sandbox_result(&mut result, max_rows, SANDBOX_AGENT_MAX_RESULT_BYTES);
    }
    log::info!(
        "operation_id={operation_id} operation={operation} status=succeeded columns={} rows={} truncated={}",
        result.columns.len(),
        result.rows.len(),
        result.truncated
    );
    Ok(result)
}

/// Non-executing EXPLAIN boundary for the agent's write-proposal dry-run.
///
/// `execute_agent_readonly_query` deliberately refuses `EXPLAIN <write>` (a
/// read-only surface must not plan writes) and `execute_sandboxed_query`
/// inherits the Safe Mode write block — yet a mutating `edit_query_sql`
/// proposal needs its plan (or its syntax error) on the review card BEFORE the
/// user accepts. This command fills that gap: it wraps the statement as
/// `EXPLAIN <stmt>` server-side so the wrapped statement is planned, never
/// executed — `EXPLAIN ANALYZE` cannot be constructed here. Safe Mode is not
/// consulted because nothing mutates; the proposal itself still goes through
/// the normal guarded path when the user runs it.
#[tauri::command]
pub async fn explain_agent_statement(
    connection_id: String,
    sql: String,
    db_manager: State<'_, DatabaseManager>,
    cancellation_state: State<'_, QueryCancellationState>,
) -> Result<QueryResult, AppError> {
    let database_type = db_manager
        .connection_database_type(&connection_id)
        .await
        .map_err(|error| error.to_string())?;
    if let Some(message) = agent_sql_read_unsupported_error(database_type) {
        return Err(message.into());
    }
    // Same input validation as the sandbox: capability probes and
    // session/transaction control are refused before the driver is involved.
    // Read-only is NOT required — planning a write is the whole point.
    let statements = [sql];
    if let Err(error) = validate_sandbox_batch(&statements, false, Some(database_type)) {
        log_sandbox_denial(&connection_id, statements.len(), &error);
        return Err(error.into());
    }
    let explain_sql = match database_type {
        // SQLite-family engines expose a readable plan through EXPLAIN QUERY
        // PLAN; a bare EXPLAIN dumps the bytecode program instead.
        DatabaseType::SQLite | DatabaseType::LibSQL | DatabaseType::CloudflareD1 => {
            format!("EXPLAIN QUERY PLAN {}", statements[0])
        }
        // Oracle plans go through EXPLAIN PLAN FOR + PLAN_TABLE; the agent
        // explain path stays a single statement, so emit the canonical form.
        DatabaseType::Oracle => format!("EXPLAIN PLAN FOR {}", statements[0]),
        _ => format!("EXPLAIN {}", statements[0]),
    };
    run_sandboxed_statements(
        &connection_id,
        &[explain_sql],
        None,
        Some(SANDBOX_AGENT_MAX_ROWS),
        db_manager.inner(),
        cancellation_state.inner(),
        "query.explain_agent_statement",
    )
    .await
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
    if let Err(error) =
        validate_sandbox_batch(std::slice::from_ref(&sql), true, Some(database_type))
    {
        log_sandbox_denial(&connection_id, 1, &error);
        return Err(error.into());
    }
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
    if let Err(error) = validate_sandbox_batch(&statements, true, Some(database_type)) {
        log_sandbox_denial(&connection_id, statements.len(), &error);
        return Err(error.into());
    }
    execute_sandboxed_query(
        connection_id,
        statements,
        Some(true),
        request_id,
        // Agent tool path: never carries human approval.
        None,
        // AI reads are capped so an unbounded SELECT returns a flagged sample.
        Some(SANDBOX_AGENT_MAX_ROWS),
        db_manager,
        cancellation_state,
        safe_mode,
    )
    .await
}
