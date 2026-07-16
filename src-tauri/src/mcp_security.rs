use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum McpPermission {
    ReadOnly,
    ReadWrite,
    Admin,
}

impl McpPermission {
    pub fn allows(self, requested: Self) -> bool {
        self >= requested
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ExternalAccessPolicy {
    Blocked,
    ReadOnly,
    ReadWrite,
}

impl ExternalAccessPolicy {
    pub fn effective_permission(self, token_permission: McpPermission) -> Option<McpPermission> {
        match self {
            Self::Blocked => None,
            Self::ReadOnly => Some(McpPermission::ReadOnly),
            Self::ReadWrite => Some(token_permission.min(McpPermission::ReadWrite)),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpTokenGrant {
    pub id: String,
    pub name: String,
    pub prefix: String,
    pub token_hash: String,
    pub salt: String,
    pub permission: McpPermission,
    pub connection_allowlist: Option<Vec<String>>,
    pub expires_at: Option<String>,
    pub is_active: bool,
    pub created_at: String,
    pub last_used_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpAuthorizationError {
    Revoked,
    Expired,
    ConnectionNotAllowed,
    ConnectionBlocked,
    InsufficientPermission,
}

impl std::fmt::Display for McpAuthorizationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            Self::Revoked => "MCP token is revoked or inactive.",
            Self::Expired => "MCP token has expired.",
            Self::ConnectionNotAllowed => "MCP token is not allowed to access this connection.",
            Self::ConnectionBlocked => "This connection blocks external MCP access.",
            Self::InsufficientPermission => "MCP token does not have the required permission.",
        };
        formatter.write_str(message)
    }
}

pub fn generate_mcp_token() -> (String, String, String) {
    let mut token_bytes = [0_u8; 32];
    let mut salt_bytes = [0_u8; 16];
    rand::thread_rng().fill_bytes(&mut token_bytes);
    rand::thread_rng().fill_bytes(&mut salt_bytes);

    let token = format!("tr_{}", URL_SAFE_NO_PAD.encode(token_bytes));
    let salt = URL_SAFE_NO_PAD.encode(salt_bytes);
    let token_hash = hash_token(&salt, &token);
    (token, salt, token_hash)
}

pub fn hash_token(salt: &str, token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(salt.as_bytes());
    hasher.update(b":");
    hasher.update(token.as_bytes());
    URL_SAFE_NO_PAD.encode(hasher.finalize())
}

pub fn token_matches(grant: &McpTokenGrant, token: &str) -> bool {
    constant_time_eq(
        grant.token_hash.as_bytes(),
        hash_token(&grant.salt, token).as_bytes(),
    )
}

pub fn authorize_mcp_access(
    grant: &McpTokenGrant,
    connection_id: &str,
    connection_policy: ExternalAccessPolicy,
    requested_permission: McpPermission,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<McpPermission, McpAuthorizationError> {
    if !grant.is_active {
        return Err(McpAuthorizationError::Revoked);
    }
    if let Some(expires_at) = grant.expires_at.as_deref() {
        if chrono::DateTime::parse_from_rfc3339(expires_at)
            .map(|expires_at| expires_at.with_timezone(&chrono::Utc) <= now)
            .unwrap_or(true)
        {
            return Err(McpAuthorizationError::Expired);
        }
    }
    if let Some(allowlist) = grant.connection_allowlist.as_ref() {
        if !allowlist.iter().any(|id| id == connection_id) {
            return Err(McpAuthorizationError::ConnectionNotAllowed);
        }
    }

    let Some(effective_permission) = connection_policy.effective_permission(grant.permission)
    else {
        return Err(McpAuthorizationError::ConnectionBlocked);
    };
    if !effective_permission.allows(requested_permission) {
        return Err(McpAuthorizationError::InsufficientPermission);
    }
    Ok(effective_permission)
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

#[cfg(test)]
mod tests {
    use super::{
        authorize_mcp_access, generate_mcp_token, token_matches, ExternalAccessPolicy,
        McpAuthorizationError, McpPermission, McpTokenGrant,
    };
    use chrono::{Duration, Utc};

    fn grant(permission: McpPermission) -> McpTokenGrant {
        let (token, salt, token_hash) = generate_mcp_token();
        McpTokenGrant {
            id: "token-1".to_string(),
            name: "test".to_string(),
            prefix: token[..10].to_string(),
            token_hash,
            salt,
            permission,
            connection_allowlist: Some(vec!["connection-1".to_string()]),
            expires_at: None,
            is_active: true,
            created_at: Utc::now().to_rfc3339(),
            last_used_at: None,
        }
    }

    #[test]
    fn token_hash_never_requires_persisting_plaintext() {
        let (token, salt, token_hash) = generate_mcp_token();
        let grant = McpTokenGrant {
            id: "token-1".to_string(),
            name: "test".to_string(),
            prefix: token[..10].to_string(),
            token_hash,
            salt,
            permission: McpPermission::ReadOnly,
            connection_allowlist: None,
            expires_at: None,
            is_active: true,
            created_at: Utc::now().to_rfc3339(),
            last_used_at: None,
        };
        assert!(token_matches(&grant, &token));
        assert!(!token_matches(&grant, "tr_not-the-issued-token"));
    }

    #[test]
    fn authorization_uses_the_stricter_token_and_connection_policy() {
        let grant = grant(McpPermission::Admin);
        let now = Utc::now();
        assert_eq!(
            authorize_mcp_access(
                &grant,
                "connection-1",
                ExternalAccessPolicy::ReadOnly,
                McpPermission::ReadOnly,
                now,
            ),
            Ok(McpPermission::ReadOnly),
        );
        assert_eq!(
            authorize_mcp_access(
                &grant,
                "connection-1",
                ExternalAccessPolicy::ReadOnly,
                McpPermission::ReadWrite,
                now,
            ),
            Err(McpAuthorizationError::InsufficientPermission),
        );
    }

    #[test]
    fn authorization_rejects_allowlist_expiry_and_revocation() {
        let now = Utc::now();
        let mut grant = grant(McpPermission::ReadWrite);
        assert_eq!(
            authorize_mcp_access(
                &grant,
                "other-connection",
                ExternalAccessPolicy::ReadWrite,
                McpPermission::ReadOnly,
                now,
            ),
            Err(McpAuthorizationError::ConnectionNotAllowed),
        );
        grant.expires_at = Some((now - Duration::seconds(1)).to_rfc3339());
        assert_eq!(
            authorize_mcp_access(
                &grant,
                "connection-1",
                ExternalAccessPolicy::ReadWrite,
                McpPermission::ReadOnly,
                now,
            ),
            Err(McpAuthorizationError::Expired),
        );
        grant.expires_at = None;
        grant.is_active = false;
        assert_eq!(
            authorize_mcp_access(
                &grant,
                "connection-1",
                ExternalAccessPolicy::ReadWrite,
                McpPermission::ReadOnly,
                now,
            ),
            Err(McpAuthorizationError::Revoked),
        );
    }
}
