use crate::database::manager::DatabaseManager;
use crate::mcp::{tool_definitions, validate_read_only_mcp_query, MCP_PROTOCOL_VERSION};
use crate::mcp_security::{authorize_mcp_access, McpPermission, McpTokenGrant};
use crate::storage::connection_storage::ConnectionStorage;
use crate::storage::mcp_storage::{McpAuditEvent, McpStorage};
use anyhow::{anyhow, Result};
use axum::{
    extract::DefaultBodyLimit,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use chrono::Utc;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::sync::{Arc, Mutex};
use std::time::{Duration as StdDuration, Instant};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::time::{timeout, Duration};

const LOCAL_HOST: &str = "127.0.0.1";
const MAX_RESULT_ROWS: usize = 100;
const MAX_RESULT_BYTES: usize = 768 * 1024;
const MAX_SCHEMA_TABLES: usize = 500;
const MAX_ACTIVITY_EVENTS: usize = 100;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const HANDSHAKE_FILE: &str = "mcp-local.json";
const REQUESTS_PER_MINUTE: usize = 60;
const MAX_REQUEST_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpLocalServerStatus {
    pub enabled: bool,
    pub host: String,
    pub port: Option<u16>,
    pub endpoint: Option<String>,
    pub handshake_path: String,
}

struct RunningMcpLocalServer {
    port: u16,
    shutdown: oneshot::Sender<()>,
}

#[derive(Clone)]
pub struct McpLocalServer {
    running: Arc<Mutex<Option<RunningMcpLocalServer>>>,
}

impl Default for McpLocalServer {
    fn default() -> Self {
        Self {
            running: Arc::new(Mutex::new(None)),
        }
    }
}

#[derive(Clone)]
struct LocalMcpState {
    connection_storage: ConnectionStorage,
    mcp_storage: McpStorage,
    rate_limiter: McpRateLimiter,
}

#[derive(Clone, Default)]
struct McpRateLimiter {
    hits_by_token: Arc<Mutex<HashMap<String, VecDeque<Instant>>>>,
}

impl McpRateLimiter {
    fn allow(&self, token_id: &str) -> bool {
        let Ok(mut hits_by_token) = self.hits_by_token.lock() else {
            return false;
        };
        let hits = hits_by_token.entry(token_id.to_string()).or_default();
        let cutoff = Instant::now() - StdDuration::from_secs(60);
        while hits.front().is_some_and(|hit| *hit < cutoff) {
            hits.pop_front();
        }
        if hits.len() >= REQUESTS_PER_MINUTE {
            return false;
        }
        hits.push_back(Instant::now());
        true
    }
}

impl McpLocalServer {
    pub async fn start(
        &self,
        connection_storage: ConnectionStorage,
        mcp_storage: McpStorage,
    ) -> Result<McpLocalServerStatus> {
        if let Some(status) = self.current_status()? {
            return Ok(status);
        }

        let listener = TcpListener::bind((LOCAL_HOST, 0)).await?;
        let port = listener.local_addr()?.port();
        let state = LocalMcpState {
            connection_storage,
            mcp_storage,
            rate_limiter: McpRateLimiter::default(),
        };
        let app = Router::new()
            .route("/health", get(local_health))
            .route("/mcp", post(local_mcp))
            .layer(DefaultBodyLimit::max(MAX_REQUEST_BYTES))
            .with_state(state);
        let (shutdown, shutdown_receiver) = oneshot::channel();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = shutdown_receiver.await;
                })
                .await;
        });

        let mut running = self
            .running
            .lock()
            .map_err(|_| anyhow!("Local MCP server lock is unavailable."))?;
        if let Some(running) = running.as_ref() {
            return Ok(enabled_status(running.port));
        }
        *running = Some(RunningMcpLocalServer { port, shutdown });
        drop(running);
        let status = self
            .current_status()?
            .ok_or_else(|| anyhow!("Local MCP server failed to start."))?;
        write_handshake(&status)?;
        Ok(status)
    }

    pub fn stop(&self) -> Result<McpLocalServerStatus> {
        let running = self
            .running
            .lock()
            .map_err(|_| anyhow!("Local MCP server lock is unavailable."))?
            .take();
        if let Some(running) = running {
            let _ = running.shutdown.send(());
        }
        remove_handshake()?;
        Ok(disabled_status())
    }

    pub fn current_status(&self) -> Result<Option<McpLocalServerStatus>> {
        let running = self
            .running
            .lock()
            .map_err(|_| anyhow!("Local MCP server lock is unavailable."))?;
        Ok(running.as_ref().map(|running| enabled_status(running.port)))
    }
}

pub fn disabled_status() -> McpLocalServerStatus {
    McpLocalServerStatus {
        enabled: false,
        host: LOCAL_HOST.to_string(),
        port: None,
        endpoint: None,
        handshake_path: handshake_path().display().to_string(),
    }
}

fn enabled_status(port: u16) -> McpLocalServerStatus {
    McpLocalServerStatus {
        enabled: true,
        host: LOCAL_HOST.to_string(),
        port: Some(port),
        endpoint: Some(format!("http://{LOCAL_HOST}:{port}/mcp")),
        handshake_path: handshake_path().display().to_string(),
    }
}

fn handshake_path() -> std::path::PathBuf {
    crate::utils::paths::resolve_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join(HANDSHAKE_FILE)
}

fn write_handshake(status: &McpLocalServerStatus) -> Result<()> {
    let handshake = json!({
        "version": 1,
        "transport": "streamable-http",
        "host": status.host,
        "port": status.port,
        "endpoint": status.endpoint,
        "authentication": "Bearer token issued by TableR",
        "updatedAt": Utc::now().to_rfc3339(),
    });
    fs::write(handshake_path(), serde_json::to_vec_pretty(&handshake)?)?;
    Ok(())
}

fn remove_handshake() -> Result<()> {
    let path = handshake_path();
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}

async fn local_health() -> impl IntoResponse {
    Json(json!({ "ok": true, "transport": "streamable-http" }))
}

async fn local_mcp(
    State(state): State<LocalMcpState>,
    headers: HeaderMap,
    Json(request): Json<Value>,
) -> impl IntoResponse {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let method = match request.get("method").and_then(Value::as_str) {
        Some(method) => method,
        None => {
            return json_rpc_error(
                StatusCode::BAD_REQUEST,
                id,
                -32600,
                "Request method is required.",
            )
        }
    };

    if method == "initialize" {
        return Json(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": { "tools": {}, "resources": {} },
                "serverInfo": { "name": "tabler-mcp-local", "version": env!("CARGO_PKG_VERSION") }
            }
        }))
        .into_response();
    }
    if method == "notifications/initialized" {
        return StatusCode::NO_CONTENT.into_response();
    }

    let params = request.get("params").cloned().unwrap_or(Value::Null);
    let connection_id = match connection_id_from_request(method, &params) {
        Ok(connection_id) => connection_id,
        Err(error) => return json_rpc_error(StatusCode::BAD_REQUEST, id, -32602, &error),
    };
    let grant = match authorize_request(&state, &headers, &connection_id) {
        Ok(grant) => grant,
        Err((status, error)) => return json_rpc_error(status, id, -32001, &error),
    };
    if !state.rate_limiter.allow(&grant.id) {
        let _ = state.mcp_storage.append_audit(audit_event(
            Some(grant.id),
            "rate_limit",
            method,
            Some(connection_id),
            "denied",
        ));
        return json_rpc_error(
            StatusCode::TOO_MANY_REQUESTS,
            id,
            -32029,
            "MCP request limit reached. Try again in a minute.",
        );
    }

    let mut outcome = match method {
        "tools/list" => Ok(json!({ "tools": local_tool_definitions() })),
        "tools/call" => execute_tool(&state, &connection_id, &params).await,
        "resources/list" => Ok(json!({ "resources": local_resources(&connection_id) })),
        "resources/read" => read_resource(&state, &connection_id, &params).await,
        _ => Err(anyhow!("Method '{method}' is not supported.")),
    };
    if outcome.is_ok() {
        let latest_grant = state.mcp_storage.find_token_by_id(&grant.id);
        let connection_policy = state
            .connection_storage
            .load_connection_by_id(&connection_id)
            .map(|config| config.external_access_policy());
        let still_authorized = latest_grant
            .ok()
            .flatten()
            .zip(connection_policy.ok())
            .is_some_and(|(latest, policy)| {
                authorize_mcp_access(
                    &latest,
                    &connection_id,
                    policy,
                    McpPermission::ReadOnly,
                    Utc::now(),
                )
                .is_ok()
            });
        if !still_authorized {
            outcome = Err(anyhow!(
                "MCP authorization was revoked before the request completed."
            ));
        }
    }
    let _ = state.mcp_storage.append_audit(audit_event(
        Some(grant.id.clone()),
        if method.starts_with("resources/") {
            "resource"
        } else {
            "tool"
        },
        method,
        Some(connection_id),
        if outcome.is_ok() { "success" } else { "error" },
    ));
    if outcome.is_ok() {
        let _ = state.mcp_storage.mark_token_used(&grant.id);
    }
    match outcome {
        Ok(result) => Json(json!({ "jsonrpc": "2.0", "id": id, "result": result })).into_response(),
        Err(error) => json_rpc_error(StatusCode::BAD_REQUEST, id, -32602, &error.to_string()),
    }
}

fn connection_id_from_request(method: &str, params: &Value) -> Result<String, String> {
    let candidate = if method == "tools/call" {
        params
            .get("arguments")
            .and_then(|arguments| arguments.get("connectionId"))
            .and_then(Value::as_str)
    } else {
        params.get("connectionId").and_then(Value::as_str)
    };
    candidate
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| "connectionId is required for external MCP access.".to_string())
}

fn authorize_request(
    state: &LocalMcpState,
    headers: &HeaderMap,
    connection_id: &str,
) -> std::result::Result<McpTokenGrant, (StatusCode, String)> {
    let token = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| !value.trim().is_empty());
    let Some(token) = token else {
        let _ = state.mcp_storage.append_audit(audit_event(
            None,
            "auth",
            "http.request",
            Some(connection_id.to_string()),
            "denied",
        ));
        return Err((
            StatusCode::UNAUTHORIZED,
            "Bearer token is required.".to_string(),
        ));
    };
    let grant = match state.mcp_storage.find_token(token) {
        Ok(Some(grant)) => grant,
        Ok(None) | Err(_) => {
            let _ = state.mcp_storage.append_audit(audit_event(
                None,
                "auth",
                "http.request",
                Some(connection_id.to_string()),
                "denied",
            ));
            return Err((
                StatusCode::UNAUTHORIZED,
                "MCP authentication failed.".to_string(),
            ));
        }
    };
    let config = match state
        .connection_storage
        .load_connection_by_id(connection_id)
    {
        Ok(config) => config,
        Err(_) => {
            let _ = state.mcp_storage.append_audit(audit_event(
                Some(grant.id.clone()),
                "auth",
                "http.request",
                Some(connection_id.to_string()),
                "denied",
            ));
            return Err((
                StatusCode::NOT_FOUND,
                "Saved connection was not found.".to_string(),
            ));
        }
    };
    if let Err(error) = authorize_mcp_access(
        &grant,
        connection_id,
        config.external_access_policy(),
        McpPermission::ReadOnly,
        Utc::now(),
    ) {
        let _ = state.mcp_storage.append_audit(audit_event(
            Some(grant.id.clone()),
            "auth",
            "http.request",
            Some(connection_id.to_string()),
            "denied",
        ));
        return Err((StatusCode::FORBIDDEN, error.to_string()));
    }
    let _ = state.mcp_storage.append_audit(audit_event(
        Some(grant.id.clone()),
        "auth",
        "http.request",
        Some(connection_id.to_string()),
        "success",
    ));
    Ok(grant)
}

async fn execute_tool(state: &LocalMcpState, connection_id: &str, params: &Value) -> Result<Value> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("Tool name is required."))?;
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let config = state
        .connection_storage
        .load_connection_by_id(connection_id)?;
    let manager = DatabaseManager::new();
    timeout(REQUEST_TIMEOUT, manager.connect(&config)).await??;
    let database = config.database.as_deref();
    let result = async {
        let driver = manager.get_driver(connection_id).await?;
        match name {
            "list_tables" => {
                let requested_database = arguments
                    .get("database")
                    .and_then(Value::as_str)
                    .or(database);
                let mut tables =
                    timeout(REQUEST_TIMEOUT, driver.list_tables(requested_database)).await??;
                tables.truncate(MAX_SCHEMA_TABLES);
                text_result(tables)
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
                    .or(database);
                text_result(
                    timeout(
                        REQUEST_TIMEOUT,
                        driver.get_table_structure(table, requested_database),
                    )
                    .await??,
                )
            }
            "read_query" => {
                let sql = arguments
                    .get("sql")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow!("sql is required."))?;
                if sql.len() > 12_000 {
                    return Err(anyhow!(
                        "External MCP query exceeds the 12 KB request limit."
                    ));
                }
                let statement = validate_read_only_mcp_query(sql)?;
                let query_result =
                    timeout(REQUEST_TIMEOUT, driver.execute_query(&statement)).await??;
                text_result(bounded_query_result(query_result))
            }
            _ => Err(anyhow!("Unknown read-only MCP tool '{name}'.")),
        }
    }
    .await;
    let _ = manager.disconnect(connection_id).await;
    result
}

async fn read_resource(
    state: &LocalMcpState,
    connection_id: &str,
    params: &Value,
) -> Result<Value> {
    let uri = params
        .get("uri")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("Resource uri is required."))?;
    let (_, resource_name) = parse_resource_uri(uri)?;
    let expected_prefix = format!("tabler://connection/{connection_id}/");
    if !uri.starts_with(&expected_prefix) {
        return Err(anyhow!(
            "Resource does not belong to the requested connection."
        ));
    }
    match resource_name {
        "activity" => {
            let events = state.mcp_storage.list_audit(MAX_ACTIVITY_EVENTS)?;
            Ok(json!({
                "contents": [{
                    "uri": uri,
                    "mimeType": "application/json",
                    "text": bounded_json_text(&events)?
                }]
            }))
        }
        "schema" => {
            let config = state
                .connection_storage
                .load_connection_by_id(connection_id)?;
            let manager = DatabaseManager::new();
            timeout(REQUEST_TIMEOUT, manager.connect(&config)).await??;
            let result = async {
                let driver = manager.get_driver(connection_id).await?;
                let mut tables = timeout(
                    REQUEST_TIMEOUT,
                    driver.list_tables(config.database.as_deref()),
                )
                .await??;
                tables.truncate(MAX_SCHEMA_TABLES);
                Ok::<_, anyhow::Error>(json!({
                    "contents": [{
                        "uri": uri,
                        "mimeType": "application/json",
                        "text": bounded_json_text(&tables)?
                    }]
                }))
            }
            .await;
            let _ = manager.disconnect(connection_id).await;
            result
        }
        "history" => {
            let history = crate::query_history::QueryHistoryStorage::new()
                .map_err(anyhow::Error::msg)?
                .get_entries(Some(connection_id), None, 50)
                .map_err(anyhow::Error::msg)?;
            let metadata = history
                .into_iter()
                .map(|entry| {
                    json!({
                        "id": entry.id,
                        "executedAt": entry.executed_at,
                        "durationMs": entry.duration_ms,
                        "rowCount": entry.row_count,
                        "hasError": entry.error.is_some(),
                        "database": entry.database,
                    })
                })
                .collect::<Vec<_>>();
            Ok(json!({
                "contents": [{
                    "uri": uri,
                    "mimeType": "application/json",
                    "text": bounded_json_text(&metadata)?
                }]
            }))
        }
        _ => Err(anyhow!("Unknown TableR MCP resource.")),
    }
}

fn local_tool_definitions() -> Vec<Value> {
    tool_definitions()
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|mut tool| {
            if let Some(properties) = tool
                .get_mut("inputSchema")
                .and_then(|schema| schema.get_mut("properties"))
                .and_then(Value::as_object_mut)
            {
                properties.insert(
                    "connectionId".to_string(),
                    json!({ "type": "string", "description": "Saved TableR connection ID." }),
                );
            }
            if let Some(required) = tool
                .get_mut("inputSchema")
                .and_then(|schema| schema.get_mut("required"))
                .and_then(Value::as_array_mut)
            {
                required.push(Value::String("connectionId".to_string()));
            }
            tool
        })
        .collect()
}

fn local_resources(connection_id: &str) -> Vec<Value> {
    vec![
        json!({
            "uri": format!("tabler://connection/{connection_id}/schema"),
            "name": "Connection schema",
            "description": "Bounded table metadata for the approved connection.",
            "mimeType": "application/json"
        }),
        json!({
            "uri": format!("tabler://connection/{connection_id}/activity"),
            "name": "MCP activity",
            "description": "Recent redacted MCP security activity.",
            "mimeType": "application/json"
        }),
        json!({
            "uri": format!("tabler://connection/{connection_id}/history"),
            "name": "Query history metadata",
            "description": "The latest 50 query history metadata records without SQL text or values.",
            "mimeType": "application/json"
        }),
    ]
}

fn bounded_query_result(
    mut result: crate::database::models::QueryResult,
) -> crate::database::models::QueryResult {
    result.rows.truncate(MAX_RESULT_ROWS);
    result.query = "[external MCP read query]".to_string();
    while !result.rows.is_empty()
        && serde_json::to_vec(&result)
            .map(|payload| payload.len() > MAX_RESULT_BYTES)
            .unwrap_or(true)
    {
        result.rows.pop();
        result.truncated = true;
    }
    result
}

fn parse_resource_uri(uri: &str) -> Result<(&str, &str)> {
    let rest = uri
        .strip_prefix("tabler://connection/")
        .ok_or_else(|| anyhow!("Unsupported resource uri."))?;
    rest.rsplit_once('/')
        .filter(|(connection_id, resource)| {
            !connection_id.is_empty() && matches!(*resource, "schema" | "activity" | "history")
        })
        .ok_or_else(|| anyhow!("Unsupported resource uri."))
}

fn text_result(value: impl serde::Serialize) -> Result<Value> {
    let text = bounded_json_text(&value)?;
    Ok(json!({ "content": [{ "type": "text", "text": text }] }))
}

fn bounded_json_text(value: &impl serde::Serialize) -> Result<String> {
    let text = serde_json::to_string_pretty(value)?;
    if text.len() > MAX_RESULT_BYTES {
        return Err(anyhow!(
            "External MCP response exceeds the {} KB payload limit.",
            MAX_RESULT_BYTES / 1024
        ));
    }
    Ok(text)
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

fn json_rpc_error(
    status: StatusCode,
    id: Value,
    code: i64,
    message: &str,
) -> axum::response::Response {
    (
        status,
        Json(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::{
        bounded_json_text, parse_resource_uri, McpRateLimiter, MAX_RESULT_BYTES,
        REQUESTS_PER_MINUTE,
    };

    #[test]
    fn resource_uris_are_limited_to_known_connection_resources() {
        assert_eq!(
            parse_resource_uri("tabler://connection/connection-1/schema").unwrap(),
            ("connection-1", "schema")
        );
        assert_eq!(
            parse_resource_uri("tabler://connection/connection-1/history").unwrap(),
            ("connection-1", "history")
        );
        assert!(parse_resource_uri("tabler://connection/connection-1/rows").is_err());
        assert!(parse_resource_uri("https://example.test/schema").is_err());
    }

    #[test]
    fn rate_limit_is_scoped_per_token() {
        let limiter = McpRateLimiter::default();
        for _ in 0..REQUESTS_PER_MINUTE {
            assert!(limiter.allow("token-a"));
        }
        assert!(!limiter.allow("token-a"));
        assert!(limiter.allow("token-b"));
    }

    #[test]
    fn external_payloads_have_a_hard_byte_cap() {
        assert!(bounded_json_text(&"x".repeat(MAX_RESULT_BYTES)).is_err());
    }
}
