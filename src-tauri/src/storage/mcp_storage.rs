use crate::mcp_security::{generate_mcp_token, token_matches, McpPermission, McpTokenGrant};
use crate::storage::file_storage::{read_json_vec_with_backup, write_json_atomically};
use anyhow::{anyhow, Result};
use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

const MCP_TOKEN_FILE: &str = "mcp_tokens.json";
const MCP_AUDIT_FILE: &str = "mcp_audit.json";
const AUDIT_RETENTION_DAYS: i64 = 90;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpAuditEvent {
    pub id: String,
    pub at: String,
    pub token_id: Option<String>,
    pub category: String,
    pub action: String,
    pub connection_id: Option<String>,
    pub outcome: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTokenSummary {
    pub id: String,
    pub name: String,
    pub prefix: String,
    pub permission: McpPermission,
    pub connection_allowlist: Option<Vec<String>>,
    pub expires_at: Option<String>,
    pub is_active: bool,
    pub created_at: String,
    pub last_used_at: Option<String>,
}

impl From<&McpTokenGrant> for McpTokenSummary {
    fn from(grant: &McpTokenGrant) -> Self {
        Self {
            id: grant.id.clone(),
            name: grant.name.clone(),
            prefix: grant.prefix.clone(),
            permission: grant.permission,
            connection_allowlist: grant.connection_allowlist.clone(),
            expires_at: grant.expires_at.clone(),
            is_active: grant.is_active,
            created_at: grant.created_at.clone(),
            last_used_at: grant.last_used_at.clone(),
        }
    }
}

#[derive(Clone)]
pub struct McpStorage {
    token_path: PathBuf,
    audit_path: PathBuf,
    write_guard: Arc<Mutex<()>>,
}

impl McpStorage {
    pub fn new() -> Result<Self> {
        let data_dir = crate::utils::paths::resolve_data_dir()?;
        fs::create_dir_all(&data_dir)?;
        Ok(Self {
            token_path: data_dir.join(MCP_TOKEN_FILE),
            audit_path: data_dir.join(MCP_AUDIT_FILE),
            write_guard: Arc::new(Mutex::new(())),
        })
    }

    pub fn list_tokens(&self) -> Result<Vec<McpTokenGrant>> {
        read_json_vec_with_backup(&self.token_path, "Failed to read MCP tokens")
    }

    pub fn list_token_summaries(&self) -> Result<Vec<McpTokenSummary>> {
        let mut summaries = self
            .list_tokens()?
            .iter()
            .map(McpTokenSummary::from)
            .collect::<Vec<_>>();
        summaries.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        Ok(summaries)
    }

    pub fn find_token(&self, plaintext: &str) -> Result<Option<McpTokenGrant>> {
        if plaintext.trim().is_empty() {
            return Ok(None);
        }
        Ok(self
            .list_tokens()?
            .into_iter()
            .find(|grant| token_matches(grant, plaintext)))
    }

    pub fn create_token(
        &self,
        name: String,
        permission: McpPermission,
        connection_allowlist: Option<Vec<String>>,
        expires_at: Option<String>,
    ) -> Result<(McpTokenGrant, String)> {
        let name = name.trim();
        if name.is_empty() || name.len() > 120 {
            return Err(anyhow!(
                "MCP token name must be between 1 and 120 characters."
            ));
        }
        if let Some(expires_at) = expires_at.as_deref() {
            let parsed = chrono::DateTime::parse_from_rfc3339(expires_at)
                .map_err(|_| anyhow!("MCP token expiration must be an RFC3339 timestamp."))?;
            if parsed.with_timezone(&Utc) <= Utc::now() {
                return Err(anyhow!("MCP token expiration must be in the future."));
            }
        }

        let _guard = self
            .write_guard
            .lock()
            .map_err(|_| anyhow!("MCP storage lock is unavailable."))?;
        let (plaintext, salt, token_hash) = generate_mcp_token();
        let now = Utc::now().to_rfc3339();
        let grant = McpTokenGrant {
            id: Uuid::new_v4().to_string(),
            name: name.to_string(),
            prefix: plaintext.chars().take(11).collect(),
            token_hash,
            salt,
            permission,
            connection_allowlist: connection_allowlist.map(normalize_allowlist),
            expires_at,
            is_active: true,
            created_at: now,
            last_used_at: None,
        };
        let mut tokens: Vec<McpTokenGrant> =
            read_json_vec_with_backup(&self.token_path, "Failed to read MCP tokens")?;
        tokens.push(grant.clone());
        self.persist_tokens(&tokens)?;
        Ok((grant, plaintext))
    }

    pub fn revoke_token(&self, token_id: &str) -> Result<()> {
        let _guard = self
            .write_guard
            .lock()
            .map_err(|_| anyhow!("MCP storage lock is unavailable."))?;
        let mut tokens: Vec<McpTokenGrant> =
            read_json_vec_with_backup(&self.token_path, "Failed to read MCP tokens")?;
        let token = tokens
            .iter_mut()
            .find(|token| token.id == token_id)
            .ok_or_else(|| anyhow!("MCP token was not found."))?;
        token.is_active = false;
        self.persist_tokens(&tokens)
    }

    pub fn mark_token_used(&self, token_id: &str) -> Result<()> {
        let _guard = self
            .write_guard
            .lock()
            .map_err(|_| anyhow!("MCP storage lock is unavailable."))?;
        let mut tokens: Vec<McpTokenGrant> =
            read_json_vec_with_backup(&self.token_path, "Failed to read MCP tokens")?;
        if let Some(token) = tokens.iter_mut().find(|token| token.id == token_id) {
            token.last_used_at = Some(Utc::now().to_rfc3339());
            self.persist_tokens(&tokens)?;
        }
        Ok(())
    }

    pub fn append_audit(&self, mut event: McpAuditEvent) -> Result<()> {
        let _guard = self
            .write_guard
            .lock()
            .map_err(|_| anyhow!("MCP storage lock is unavailable."))?;
        event.id = if event.id.is_empty() {
            Uuid::new_v4().to_string()
        } else {
            event.id
        };
        event.at = if event.at.is_empty() {
            Utc::now().to_rfc3339()
        } else {
            event.at
        };
        event.detail = event
            .detail
            .map(redact_audit_detail)
            .filter(|detail| !detail.is_empty());
        let cutoff = Utc::now() - Duration::days(AUDIT_RETENTION_DAYS);
        let mut events: Vec<McpAuditEvent> =
            read_json_vec_with_backup(&self.audit_path, "Failed to read MCP audit log")?;
        events.retain(|entry: &McpAuditEvent| {
            chrono::DateTime::parse_from_rfc3339(&entry.at)
                .map(|at| at.with_timezone(&Utc) >= cutoff)
                .unwrap_or(false)
        });
        events.push(event);
        write_json_atomically(&self.audit_path, &serde_json::to_string_pretty(&events)?)
    }

    pub fn list_audit(&self, limit: usize) -> Result<Vec<McpAuditEvent>> {
        let mut events: Vec<McpAuditEvent> =
            read_json_vec_with_backup(&self.audit_path, "Failed to read MCP audit log")?;
        events.sort_by(|left, right| right.at.cmp(&left.at));
        events.truncate(limit.min(1_000));
        Ok(events)
    }

    fn persist_tokens(&self, tokens: &[McpTokenGrant]) -> Result<()> {
        write_json_atomically(&self.token_path, &serde_json::to_string_pretty(tokens)?)
    }
}

fn normalize_allowlist(allowlist: Vec<String>) -> Vec<String> {
    let mut normalized = allowlist
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    normalized.sort();
    normalized.dedup();
    normalized
}

fn redact_audit_detail(detail: String) -> String {
    let compact = detail.split_whitespace().collect::<Vec<_>>().join(" ");
    let lower = compact.to_ascii_lowercase();
    if ["password", "token", "authorization", "secret", "api_key"]
        .iter()
        .any(|needle| lower.contains(needle))
    {
        "[REDACTED]".to_string()
    } else {
        compact.chars().take(240).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::{normalize_allowlist, redact_audit_detail};

    #[test]
    fn token_allowlists_are_normalized() {
        assert_eq!(
            normalize_allowlist(vec![
                " connection-2 ".to_string(),
                "connection-1".to_string(),
                "connection-2".to_string()
            ]),
            vec!["connection-1".to_string(), "connection-2".to_string()],
        );
    }

    #[test]
    fn audit_details_never_keep_secret_like_content() {
        assert_eq!(
            redact_audit_detail("authorization: Bearer abc".to_string()),
            "[REDACTED]"
        );
        assert_eq!(
            redact_audit_detail("read query completed".to_string()),
            "read query completed"
        );
    }
}
