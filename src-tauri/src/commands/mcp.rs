use crate::mcp_local::{disabled_status, McpLocalServer, McpLocalServerStatus};
use crate::mcp_security::{ExternalAccessPolicy, McpPermission};
use crate::storage::connection_storage::ConnectionStorage;
use crate::storage::mcp_storage::{McpAuditEvent, McpStorage, McpTokenSummary};
use tauri::State;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedMcpToken {
    pub token: String,
    pub summary: McpTokenSummary,
}

#[tauri::command]
pub fn list_mcp_tokens(mcp_storage: State<'_, McpStorage>) -> Result<Vec<McpTokenSummary>, String> {
    mcp_storage
        .list_token_summaries()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn create_mcp_token(
    name: String,
    permission: McpPermission,
    connection_allowlist: Option<Vec<String>>,
    expires_at: Option<String>,
    mcp_storage: State<'_, McpStorage>,
) -> Result<CreatedMcpToken, String> {
    let (grant, token) = mcp_storage
        .create_token(name, permission, connection_allowlist, expires_at)
        .map_err(|error| error.to_string())?;
    Ok(CreatedMcpToken {
        token,
        summary: McpTokenSummary::from(&grant),
    })
}

#[tauri::command]
pub fn revoke_mcp_token(
    token_id: String,
    mcp_storage: State<'_, McpStorage>,
) -> Result<(), String> {
    mcp_storage
        .revoke_token(&token_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_mcp_audit_events(
    limit: Option<usize>,
    mcp_storage: State<'_, McpStorage>,
) -> Result<Vec<McpAuditEvent>, String> {
    mcp_storage
        .list_audit(limit.unwrap_or(100))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_mcp_connection_policy(
    connection_id: String,
    connection_storage: State<'_, ConnectionStorage>,
) -> Result<ExternalAccessPolicy, String> {
    connection_storage
        .load_connection_by_id(&connection_id)
        .map(|connection| connection.external_access_policy())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn set_mcp_connection_policy(
    connection_id: String,
    policy: ExternalAccessPolicy,
    connection_storage: State<'_, ConnectionStorage>,
) -> Result<(), String> {
    let mut connection = connection_storage
        .load_connection_by_id(&connection_id)
        .map_err(|error| error.to_string())?;
    connection.set_external_access_policy(policy);
    connection_storage
        .save_connection(&connection)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn start_mcp_local_server(
    server: State<'_, McpLocalServer>,
    connection_storage: State<'_, ConnectionStorage>,
    mcp_storage: State<'_, McpStorage>,
) -> Result<McpLocalServerStatus, String> {
    server
        .start(
            connection_storage.inner().clone(),
            mcp_storage.inner().clone(),
        )
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn stop_mcp_local_server(
    server: State<'_, McpLocalServer>,
) -> Result<McpLocalServerStatus, String> {
    server.stop().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_mcp_local_server_status(
    server: State<'_, McpLocalServer>,
) -> Result<McpLocalServerStatus, String> {
    server
        .current_status()
        .map_err(|error| error.to_string())
        .map(|status| status.unwrap_or_else(disabled_status))
}
