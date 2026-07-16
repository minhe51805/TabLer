use crate::database::manager::DatabaseManager;
use crate::mcp_security::{authorize_mcp_access, McpPermission};
use crate::storage::connection_storage::ConnectionStorage;
use crate::storage::mcp_storage::{McpAuditEvent, McpStorage};
use crate::utils::sql::split_sql_statements;
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

pub(crate) const MCP_PROTOCOL_VERSION: &str = "2024-11-05";

fn strip_leading_sql_noise(statement: &str) -> &str {
    let mut remaining = statement.trim_start();
    loop {
        if let Some(after_line_comment) = remaining.strip_prefix("--") {
            let Some((_, next_line)) = after_line_comment.split_once('\n') else {
                return "";
            };
            remaining = next_line.trim_start();
            continue;
        }
        if let Some(after_block_comment) = remaining.strip_prefix("/*") {
            let Some(block_end) = after_block_comment.find("*/") else {
                return "";
            };
            remaining = after_block_comment[block_end + 2..].trim_start();
            continue;
        }
        return remaining;
    }
}

/// MCP intentionally accepts exactly one inspection query and never a mutation.
pub fn validate_read_only_mcp_query(sql: &str) -> Result<String> {
    let statements = split_sql_statements(sql)
        .into_iter()
        .filter(|statement| !statement.trim().is_empty())
        .collect::<Vec<_>>();
    if statements.len() != 1 {
        return Err(anyhow!(
            "MCP read_query requires exactly one SQL statement."
        ));
    }

    let statement = statements[0].trim();
    let normalized = strip_leading_sql_noise(statement)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_uppercase();
    if normalized.is_empty() {
        return Err(anyhow!(
            "MCP read_query requires a non-empty SQL statement."
        ));
    }
    if normalized.starts_with("PRAGMA") && normalized.contains('=') {
        return Err(anyhow!("MCP only permits read-only PRAGMA statements."));
    }
    if [
        "INSERT", "UPDATE", "DELETE", "MERGE", "ALTER", "CREATE", "DROP", "TRUNCATE",
    ]
    .iter()
    .any(|keyword| normalized.contains(keyword))
    {
        return Err(anyhow!("MCP does not permit mutating CTE statements."));
    }
    if !["SELECT", "WITH", "SHOW", "DESCRIBE", "EXPLAIN", "PRAGMA"]
        .iter()
        .any(|prefix| normalized.starts_with(prefix))
    {
        return Err(anyhow!("MCP is read-only. Only inspection SQL is allowed."));
    }
    Ok(statement.to_string())
}

pub(crate) fn tool_definitions() -> Value {
    json!([
        {
            "name": "list_tables",
            "description": "List tables visible to the configured TableR connection. Read-only.",
            "inputSchema": { "type": "object", "properties": { "database": { "type": "string" } } }
        },
        {
            "name": "get_table_schema",
            "description": "Read column, index, and foreign-key metadata for one table. Read-only.",
            "inputSchema": { "type": "object", "properties": { "table": { "type": "string" }, "database": { "type": "string" } }, "required": ["table"] }
        },
        {
            "name": "read_query",
            "description": "Execute one read-only SQL inspection query. Writes and session changes are blocked.",
            "inputSchema": { "type": "object", "properties": { "sql": { "type": "string" } }, "required": ["sql"] }
        }
    ])
}

fn emit(response: Value) -> Result<()> {
    let mut stdout = io::stdout().lock();
    writeln!(stdout, "{}", serde_json::to_string(&response)?)?;
    stdout.flush()?;
    Ok(())
}

fn response(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error_response(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message.into() } })
}

fn text_result(value: impl serde::Serialize) -> Result<Value> {
    Ok(json!({ "content": [{ "type": "text", "text": serde_json::to_string_pretty(&value)? }] }))
}

fn configured_connection_id() -> Result<String> {
    let mut args = std::env::args().skip(1);
    while let Some(argument) = args.next() {
        if argument == "--connection" {
            return args
                .next()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| anyhow!("--connection requires a saved TableR connection ID"));
        }
    }
    std::env::var("TABLER_MCP_CONNECTION_ID")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            anyhow!("Set TABLER_MCP_CONNECTION_ID or pass --connection <saved-connection-id>")
        })
}

fn configured_token() -> Result<String> {
    let mut args = std::env::args().skip(1);
    while let Some(argument) = args.next() {
        if argument == "--token" {
            return args
                .next()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| anyhow!("--token requires an MCP token"));
        }
    }
    std::env::var("TABLER_MCP_TOKEN")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow!("Set TABLER_MCP_TOKEN or pass --token <MCP-token>"))
}

fn audit_event(
    token_id: Option<String>,
    category: &str,
    action: &str,
    connection_id: Option<String>,
    outcome: &str,
) -> McpAuditEvent {
    McpAuditEvent {
        id: String::new(),
        at: String::new(),
        token_id,
        category: category.to_string(),
        action: action.to_string(),
        connection_id,
        outcome: outcome.to_string(),
        detail: None,
    }
}

pub async fn run_stdio_server() -> Result<()> {
    let connection_id = configured_connection_id()?;
    let supplied_token = configured_token()?;
    let storage = ConnectionStorage::new()?;
    let config = storage.load_connection_by_id(&connection_id)?;
    let mcp_storage = McpStorage::new()?;
    let grant = mcp_storage
        .find_token(&supplied_token)?
        .ok_or_else(|| anyhow!("MCP authentication failed."))?;
    if let Err(error) = authorize_mcp_access(
        &grant,
        &connection_id,
        config.external_access_policy(),
        McpPermission::ReadOnly,
        chrono::Utc::now(),
    ) {
        let _ = mcp_storage.append_audit(audit_event(
            Some(grant.id.clone()),
            "auth",
            "stdio.connect",
            Some(connection_id.clone()),
            "denied",
        ));
        return Err(anyhow!(error));
    }
    mcp_storage.mark_token_used(&grant.id)?;
    let _ = mcp_storage.append_audit(audit_event(
        Some(grant.id.clone()),
        "auth",
        "stdio.connect",
        Some(connection_id.clone()),
        "success",
    ));
    let database = config.database.clone();
    let manager = DatabaseManager::new();
    manager.connect(&config).await?;

    eprintln!(
        "TableR MCP connected to '{}'. Scoped read-only tools are enabled.",
        config.name
    );
    for line in io::stdin().lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(error) => {
                emit(error_response(
                    Value::Null,
                    -32700,
                    format!("Parse error: {error}"),
                ))?;
                continue;
            }
        };
        let id = request.get("id").cloned();
        let Some(method) = request.get("method").and_then(Value::as_str) else {
            if let Some(id) = id {
                emit(error_response(id, -32600, "Request method is required."))?;
            }
            continue;
        };

        let outcome = match method {
            "initialize" => Ok(json!({
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "tabler-mcp", "version": env!("CARGO_PKG_VERSION") }
            })),
            "notifications/initialized" => continue,
            "tools/list" => Ok(json!({ "tools": tool_definitions() })),
            "tools/call" => {
                let params = request.get("params").cloned().unwrap_or(Value::Null);
                let name = params
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow!("Tool name is required."))?;
                let arguments = params
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let driver = manager.get_driver(&connection_id).await?;
                let tool_result = match name {
                    "list_tables" => {
                        let requested_database = arguments
                            .get("database")
                            .and_then(Value::as_str)
                            .or(database.as_deref());
                        text_result(driver.list_tables(requested_database).await?)
                    }
                    "get_table_schema" => {
                        let table = arguments
                            .get("table")
                            .and_then(Value::as_str)
                            .filter(|value| !value.trim().is_empty())
                            .ok_or_else(|| anyhow!("table is required."))?;
                        let requested_database = arguments
                            .get("database")
                            .and_then(Value::as_str)
                            .or(database.as_deref());
                        text_result(
                            driver
                                .get_table_structure(table, requested_database)
                                .await?,
                        )
                    }
                    "read_query" => {
                        let sql = arguments
                            .get("sql")
                            .and_then(Value::as_str)
                            .ok_or_else(|| anyhow!("sql is required."))?;
                        let statement = validate_read_only_mcp_query(sql)?;
                        text_result(driver.execute_query(&statement).await?)
                    }
                    _ => Err(anyhow!("Unknown read-only MCP tool '{name}'.")),
                };
                let _ = mcp_storage.append_audit(audit_event(
                    Some(grant.id.clone()),
                    "tool",
                    name,
                    Some(connection_id.clone()),
                    if tool_result.is_ok() {
                        "success"
                    } else {
                        "error"
                    },
                ));
                if tool_result.is_ok() {
                    let _ = mcp_storage.mark_token_used(&grant.id);
                }
                tool_result
            }
            _ => Err(anyhow!("Method '{method}' is not supported.")),
        };

        if let Some(id) = id {
            match outcome {
                Ok(result) => emit(response(id, result))?,
                Err(error) => emit(error_response(id, -32602, error.to_string()))?,
            }
        }
    }
    let _ = manager.disconnect(&connection_id).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_read_only_mcp_query;

    #[test]
    fn mcp_rejects_writes_and_multi_statement_queries() {
        assert!(validate_read_only_mcp_query("SELECT * FROM users").is_ok());
        assert!(validate_read_only_mcp_query(
            "WITH changed AS (DELETE FROM users RETURNING id) SELECT * FROM changed"
        )
        .is_err());
        assert!(validate_read_only_mcp_query("EXPLAIN INSERT INTO users VALUES (1)").is_err());
        assert!(validate_read_only_mcp_query("SELECT 1; DELETE FROM users").is_err());
    }
}
