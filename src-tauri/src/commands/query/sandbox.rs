use crate::database::models::QueryResult;
use crate::utils::sql::{classify_sql_with_dialect, detect_dangerous_capability, SqlStatementKind};
use tokio::time::Duration;

/// Cheap upper-bound estimate of a row's JSON footprint — avoids serializing the
/// whole result set just to measure it.
fn estimate_row_bytes(row: &[serde_json::Value]) -> usize {
    row.iter()
        .map(|value| match value {
            serde_json::Value::Null => 4,
            serde_json::Value::Bool(_) => 5,
            serde_json::Value::Number(_) => 8,
            serde_json::Value::String(text) => text.len() + 2,
            other => other.to_string().len(),
        })
        .sum::<usize>()
        + row.len()
}

/// Truncates a sandbox result in place to at most `max_rows` and roughly
/// `max_bytes` of row JSON, flagging `truncated` when it drops anything. Always
/// keeps at least one row when the input is non-empty so the agent still sees
/// the result shape.
pub(super) fn cap_sandbox_result(result: &mut QueryResult, max_rows: usize, max_bytes: usize) {
    if result.rows.len() > max_rows {
        result.rows.truncate(max_rows);
        result.truncated = true;
    }
    let mut running_bytes = 0usize;
    let mut keep = result.rows.len();
    for (index, row) in result.rows.iter().enumerate() {
        running_bytes = running_bytes.saturating_add(estimate_row_bytes(row));
        if running_bytes > max_bytes {
            keep = index.max(1);
            break;
        }
    }
    if keep < result.rows.len() {
        result.rows.truncate(keep);
        result.truncated = true;
    }
}

/// Structured audit record for a statement the sandbox refused to run. Kept on a
/// dedicated `operation=sandbox.denied` line (separate from runtime/connection
/// errors) so a security review can grep every rejected attempt with its reason.
/// The SQL text itself is deliberately NOT logged — it may carry sensitive
/// literals — only the classification reason and coarse counts.
pub(super) fn log_sandbox_denial(connection_id: &str, statements_count: usize, reason: &str) {
    log::warn!(
        "operation=sandbox.denied connection_id={} statements_count={} reason={}",
        connection_id,
        statements_count,
        reason
    );
}

pub(super) fn validate_sandbox_statement(
    statement: &str,
    database_type: Option<crate::database::models::DatabaseType>,
) -> Result<(), String> {
    // Fail-closed capability guard FIRST: filesystem/network/OS-command SQL
    // (pg_read_file, DuckDB read_csv, INTO OUTFILE, COPY ... TO PROGRAM, …)
    // exfiltrates data or runs code even when it parses as a plain read, so it
    // must never cross the sandbox boundary regardless of statement kind.
    if let Some(reason) = detect_dangerous_capability(statement, database_type) {
        return Err(format!(
            "Sandbox gateway blocks SQL that {reason}. This filesystem/network/OS capability is not allowed inside the sandbox."
        ));
    }
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

pub(super) fn validate_sandbox_batch(
    statements: &[String],
    require_read_only: bool,
    database_type: Option<crate::database::models::DatabaseType>,
) -> Result<(), String> {
    if statements.is_empty() {
        return Err("Sandbox execution requires at least one SQL statement.".to_string());
    }
    for statement in statements {
        validate_sandbox_statement(statement, database_type)?;
    }
    if require_read_only {
        let combined = statements.join(";\n");
        let decision = classify_sql_with_dialect(&combined, database_type);
        if decision.parse_error.is_some() || !decision.read_only {
            return Err("This execution boundary only permits read-only SQL.".to_string());
        }
    }
    Ok(())
}

pub(super) fn timeout_for_statements<'a>(
    statements: impl Iterator<Item = &'a str>,
    database_type: Option<crate::database::models::DatabaseType>,
) -> Duration {
    let sql = statements.collect::<Vec<_>>().join(";\n");
    if classify_sql_with_dialect(&sql, database_type).read_only {
        crate::config::read_only_query_timeout()
    } else {
        crate::config::mutating_query_timeout()
    }
}
