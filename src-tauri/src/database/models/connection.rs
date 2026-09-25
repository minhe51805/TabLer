use crate::mcp_security::ExternalAccessPolicy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DatabaseType {
    MySQL,
    MariaDB,
    PostgreSQL,
    CockroachDB,
    Greenplum,
    Redshift,
    SQLite,
    DuckDB,
    Cassandra,
    Snowflake,
    MSSQL,
    Redis,
    MongoDB,
    Vertica,
    ClickHouse,
    BigQuery,
    LibSQL,
    #[serde(rename = "cloudflare_d1", alias = "cloudflared1")]
    CloudflareD1,
    OpenSearch,
    Elasticsearch,
    Oracle,
    Spanner,
    DynamoDB,
    Trino,
    Typesense,
    SurrealDB,
    Weaviate,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionConfig {
    pub id: String,
    pub name: String,
    pub db_type: DatabaseType,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub database: Option<String>,
    /// For SQLite: path to the .db file
    pub file_path: Option<String>,
    pub use_ssl: bool,
    /// Fine-grained SSL mode. If None, falls back to `use_ssl`.
    pub ssl_mode: Option<SslMode>,
    /// Path to CA certificate file.
    pub ssl_ca_cert_path: Option<String>,
    /// Path to client certificate file.
    pub ssl_client_cert_path: Option<String>,
    /// Path to client key file.
    pub ssl_client_key_path: Option<String>,
    /// Skip hostname verification.
    pub ssl_skip_host_verification: Option<bool>,
    pub color: Option<String>,
    #[serde(default)]
    pub additional_fields: HashMap<String, String>,
    /// Shell command to execute locally before connecting.
    pub pre_connect_script: Option<String>,
    /// SQL commands to execute after connecting.
    #[serde(default, alias = "startupCommands")]
    pub startup_commands: Option<String>,
    /// Per-connection wall-clock ceiling for query execution, in seconds.
    /// `None` keeps the classified defaults (read-only vs mutating); a set
    /// value is clamped to 1s–600s by `config::resolve_connection_query_timeout`.
    #[serde(default)]
    pub query_timeout_seconds: Option<u64>,
    /// Per-connection read-only pin: when true, every write path (SQL editor,
    /// inline edits, structure changes, imports, restores) is rejected at the
    /// earliest command guard before any statement reaches the driver.
    #[serde(default)]
    pub read_only: bool,
    /// SSH connection config
    pub ssh_config: Option<crate::ssh::ssh_tunnel::SshConfig>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SslMode {
    Disable,
    Prefer,
    Require,
    #[serde(alias = "verifyca")]
    VerifyCa,
    #[serde(alias = "verifyfull")]
    VerifyFull,
}

impl Default for ConnectionConfig {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            db_type: DatabaseType::PostgreSQL,
            host: None,
            port: None,
            username: None,
            password: None,
            database: None,
            file_path: None,
            use_ssl: false,
            ssl_mode: None,
            ssl_ca_cert_path: None,
            ssl_client_cert_path: None,
            ssl_client_key_path: None,
            ssl_skip_host_verification: None,
            color: None,
            additional_fields: HashMap::new(),
            pre_connect_script: None,
            startup_commands: None,
            query_timeout_seconds: None,
            read_only: false,
            ssh_config: None,
        }
    }
}

impl ConnectionConfig {
    /// External integrations are denied until the connection owner explicitly opts in.
    /// This is kept in `additional_fields` for backward-compatible saved profiles.
    pub fn external_access_policy(&self) -> ExternalAccessPolicy {
        match self
            .additional_fields
            .get("external_access")
            .or_else(|| self.additional_fields.get("externalAccess"))
            .map(String::as_str)
        {
            Some("readOnly") | Some("readonly") | Some("read_only") => {
                ExternalAccessPolicy::ReadOnly
            }
            Some("readWrite") | Some("readwrite") | Some("read_write") => {
                ExternalAccessPolicy::ReadWrite
            }
            _ => ExternalAccessPolicy::Blocked,
        }
    }

    pub fn set_external_access_policy(&mut self, policy: ExternalAccessPolicy) {
        self.additional_fields.insert(
            "external_access".to_string(),
            match policy {
                ExternalAccessPolicy::Blocked => "blocked",
                ExternalAccessPolicy::ReadOnly => "readOnly",
                ExternalAccessPolicy::ReadWrite => "readWrite",
            }
            .to_string(),
        );
    }

    /// Optional per-connection pool-size override for server engines
    /// (Postgres/MySQL). Stored in `additional_fields` (same backward-compatible
    /// mechanism as `external_access`) so it never changes the persisted
    /// connection schema. A blank, zero, negative, or unparseable value is
    /// treated as unset, so `config::resolve_pool_max_connections` falls back to
    /// the compiled `POOL_MAX_CONNECTIONS` default.
    pub fn pool_max_connections(&self) -> Option<u32> {
        self.additional_fields
            .get("pool_max_connections")
            .or_else(|| self.additional_fields.get("poolMaxConnections"))
            .map(|value| value.trim())
            .and_then(|value| value.parse::<u32>().ok())
    }

    /// Resolve effective SSL mode: explicit `ssl_mode` takes precedence, else falls back to `use_ssl`.
    pub fn effective_ssl_mode(&self) -> SslMode {
        match self.ssl_mode {
            Some(mode) => mode,
            None if self.use_ssl => SslMode::Require,
            None => SslMode::Disable,
        }
    }

    /// Resolve environment variable references in all string fields.
    /// Supports $VAR, ${VAR}, and %VAR% syntax.
    /// If an env var is not set, the reference is left as-is.
    pub fn resolve_env_vars(&mut self) {
        fn resolve_string(s: Option<String>) -> Option<String> {
            s.map(|v| resolve_env_in_string(&v))
        }

        self.host = resolve_string(self.host.take());
        self.username = resolve_string(self.username.take());
        self.password = resolve_string(self.password.take());
        self.database = resolve_string(self.database.take());
        self.file_path = resolve_string(self.file_path.take());
        self.ssl_ca_cert_path = resolve_string(self.ssl_ca_cert_path.take());
        self.ssl_client_cert_path = resolve_string(self.ssl_client_cert_path.take());
        self.ssl_client_key_path = resolve_string(self.ssl_client_key_path.take());
        self.color = resolve_string(self.color.take());
        self.pre_connect_script = resolve_string(self.pre_connect_script.take());
        self.startup_commands = resolve_string(self.startup_commands.take());

        // Resolve env vars in additional_fields values
        let resolved_additional: std::collections::HashMap<String, String> = self
            .additional_fields
            .drain()
            .map(|(k, v)| (k, resolve_env_in_string(&v)))
            .collect();
        self.additional_fields = resolved_additional;
    }
}

/// Resolve env var references in a single string.
/// Supports $VAR, ${VAR}, and %VAR% syntax.
fn resolve_env_in_string(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let chars: Vec<char> = s.chars().collect();
    let len = chars.len();
    let mut i = 0;

    while i < len {
        let c = chars[i];

        if c == '$' && i + 1 < len {
            let next = chars[i + 1];

            // ${VAR} — braced form
            if next == '{' {
                if let Some(end) = chars[i + 2..].iter().position(|&ch| ch == '}') {
                    let var_name: String = chars[i + 2..i + 2 + end].iter().collect();
                    if let Ok(val) = std::env::var(&var_name) {
                        result.push_str(&val);
                    } else {
                        // Not set: leave the reference as-is
                        result.push('$');
                        result.push('{');
                        result.push_str(&var_name);
                        result.push('}');
                    }
                    i += 2 + end + 1;
                    continue;
                }
            }

            // $VAR — bare form (ASCII word characters only)
            let start = i + 1;
            let mut end = start;
            while end < len && chars[end].is_ascii_alphanumeric() || chars[end] == '_' {
                end += 1;
            }
            if end > start {
                let var_name: String = chars[start..end].iter().collect();
                if let Ok(val) = std::env::var(&var_name) {
                    result.push_str(&val);
                } else {
                    result.push('$');
                    result.push_str(&var_name);
                }
                i = end;
                continue;
            }

            result.push(c);
            i += 1;
        } else if c == '%' {
            // %VAR% — Windows-style
            let start = i + 1;
            let mut end = start;
            while end < len
                && chars[end] != '%'
                && (chars[end].is_ascii_alphanumeric() || chars[end] == '_')
            {
                end += 1;
            }
            if end < len && chars[end] == '%' && end > start {
                let var_name: String = chars[start..end].iter().collect();
                if let Ok(val) = std::env::var(&var_name) {
                    result.push_str(&val);
                } else {
                    result.push('%');
                    result.push_str(&var_name);
                    result.push('%');
                }
                i = end + 1;
                continue;
            }

            result.push(c);
            i += 1;
        } else {
            result.push(c);
            i += 1;
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::{ConnectionConfig, DatabaseType, SslMode};
    use crate::mcp_security::ExternalAccessPolicy;

    #[test]
    fn external_access_is_blocked_until_a_connection_opts_in() {
        let mut config = ConnectionConfig::default();
        assert_eq!(
            config.external_access_policy(),
            ExternalAccessPolicy::Blocked
        );
        config.set_external_access_policy(ExternalAccessPolicy::ReadOnly);
        assert_eq!(
            config.external_access_policy(),
            ExternalAccessPolicy::ReadOnly
        );
        config.set_external_access_policy(ExternalAccessPolicy::ReadWrite);
        assert_eq!(
            config.external_access_policy(),
            ExternalAccessPolicy::ReadWrite
        );
    }

    #[test]
    fn database_type_serializes_lowercase() {
        assert_eq!(
            serde_json::to_string(&DatabaseType::PostgreSQL).unwrap(),
            "\"postgresql\""
        );
        assert_eq!(
            serde_json::to_string(&DatabaseType::CloudflareD1).unwrap(),
            "\"cloudflare_d1\""
        );
        assert_eq!(
            serde_json::from_str::<DatabaseType>("\"cloudflared1\"").unwrap(),
            DatabaseType::CloudflareD1
        );
        assert_eq!(
            serde_json::from_str::<DatabaseType>("\"cloudflare_d1\"").unwrap(),
            DatabaseType::CloudflareD1
        );
    }

    #[test]
    fn accepts_frontend_camel_case_startup_commands_and_ssl_mode() {
        let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "c1",
            "name": "local",
            "db_type": "postgresql",
            "use_ssl": true,
            "ssl_mode": "verify_ca",
            "startupCommands": "SET timezone TO 'UTC'",
            "additional_fields": {}
        }))
        .unwrap();
        assert_eq!(
            config.startup_commands.as_deref(),
            Some("SET timezone TO 'UTC'")
        );
        assert_eq!(config.ssl_mode, Some(SslMode::VerifyCa));

        let legacy: SslMode = serde_json::from_str("\"verifyca\"").unwrap();
        assert_eq!(legacy, SslMode::VerifyCa);
    }
}
