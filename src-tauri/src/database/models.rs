use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use uuid::Uuid;

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
    CloudflareD1,
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
    /// SQL commands to execute after connecting.
    pub startup_commands: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SslMode {
    Disable,
    Prefer,
    Require,
    VerifyCa,
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
            startup_commands: None,
        }
    }
}

impl ConnectionConfig {
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
            while end < len && chars[end] != '%' && (chars[end].is_ascii_alphanumeric() || chars[end] == '_') {
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ParsedConnectionUrl {
    pub db_type: DatabaseType,
    pub host: String,
    pub port: Option<u16>,
    pub username: String,
    pub password: String,
    pub database: String,
    pub use_ssl: bool,
}

impl ParsedConnectionUrl {
    /// Parse a full connection URL (e.g., postgresql://<user>:<credential>@host:5432/db?sslmode=require)
    pub fn parse(url: &str) -> Result<Self, String> {
        let url = url.trim();
        if url.is_empty() {
            return Err("Connection URL cannot be empty".to_string());
        }

        // Extract scheme
        let (scheme, rest) = url.split_once("://")
            .ok_or_else(|| "Invalid URL: missing scheme (e.g., postgresql://)".to_string())?;

        let db_type = match scheme.to_lowercase().as_str() {
            "postgresql" | "postgres" => DatabaseType::PostgreSQL,
            "cockroachdb" | "cockroach" => DatabaseType::CockroachDB,
            "greenplum" => DatabaseType::Greenplum,
            "redshift" => DatabaseType::Redshift,
            "vertica" => DatabaseType::Vertica,
            "mysql" => DatabaseType::MySQL,
            "mariadb" => DatabaseType::MariaDB,
            "snowflake" => DatabaseType::Snowflake,
            "cassandra" | "scylla" => DatabaseType::Cassandra,
            "clickhouse" => DatabaseType::ClickHouse,
            "libsql" => DatabaseType::LibSQL,
            "sqlite" => DatabaseType::SQLite,
            "redis" | "rediss" => DatabaseType::Redis,
            "mongodb" | "mongodb+srv" => DatabaseType::MongoDB,
            _ => return Err(format!("Unsupported database scheme: {}", scheme)),
        };

        // Handle SQLite specially
        if db_type == DatabaseType::SQLite {
            return Ok(Self {
                db_type: DatabaseType::SQLite,
                host: String::new(),
                port: None,
                username: String::new(),
                password: String::new(),
                database: rest.to_string(),
                use_ssl: false,
            });
        }

        if db_type == DatabaseType::LibSQL {
            let (host_port, path_query) = rest.split_once('/').unwrap_or((rest, ""));
            let (host, port) = parse_host_and_port(host_port)?;
            let (database, query) = path_query.split_once('?').unwrap_or((path_query, ""));
            let auth_token = extract_query_param(query, &["authToken", "auth_token"]).unwrap_or_default();

            return Ok(Self {
                db_type,
                host,
                port: port.or(Some(8080)),
                username: String::new(),
                password: auth_token,
                database: database.to_string(),
                use_ssl: true,
            });
        }

        if db_type == DatabaseType::Redis {
            let (authority, path_query) = rest.split_once('/').unwrap_or((rest, ""));
            let (auth_part, host_port) = authority
                .rsplit_once('@')
                .map(|(auth, host)| (Some(auth), host))
                .unwrap_or((None, authority));
            let (username, password) = match auth_part {
                Some(auth) => {
                    if let Some((user, pass)) = auth.split_once(':') {
                        (url_decode(user), url_decode(pass))
                    } else {
                        (url_decode(auth), String::new())
                    }
                }
                None => (String::new(), String::new()),
            };
            let (host, port) = parse_host_and_port(host_port)?;
            let (database, _) = path_query.split_once('?').unwrap_or((path_query, ""));

            return Ok(Self {
                db_type,
                host,
                port: port.or(Some(6379)),
                username,
                password,
                database: database.to_string(),
                use_ssl: scheme.eq_ignore_ascii_case("rediss"),
            });
        }

        if db_type == DatabaseType::MongoDB {
            let (authority, path_query) = rest.split_once('/').unwrap_or((rest, ""));
            let (auth_part, host_port) = authority
                .rsplit_once('@')
                .map(|(auth, host)| (Some(auth), host))
                .unwrap_or((None, authority));
            let (username, password) = match auth_part {
                Some(auth) => {
                    if let Some((user, pass)) = auth.split_once(':') {
                        (url_decode(user), url_decode(pass))
                    } else {
                        (url_decode(auth), String::new())
                    }
                }
                None => (String::new(), String::new()),
            };
            let (database, query) = path_query.split_once('?').unwrap_or((path_query, ""));
            let (host, port) = if scheme.eq_ignore_ascii_case("mongodb+srv") {
                (host_port.to_string(), None)
            } else {
                parse_host_and_port(host_port)?
            };

            return Ok(Self {
                db_type,
                host,
                port: port.or(Some(27017)),
                username,
                password,
                database: database.to_string(),
                use_ssl: scheme.eq_ignore_ascii_case("mongodb+srv")
                    || query.contains("tls=true")
                    || query.contains("ssl=true"),
            });
        }

        // Parse <user>:<credential>@host:port/database?params
        let (auth_part, rest) = rest.split_once('@')
            .ok_or_else(|| "Invalid URL: missing credentials or host".to_string())?;

        // Parse username:password
        let (username, password) = if let Some((u, p)) = auth_part.split_once(':') {
            (
                url_decode(u),
                url_decode(p),
            )
        } else {
            (url_decode(auth_part), String::new())
        };

        // Parse host:port/database?params
        let (host_port, path_query) = rest.split_once('/')
            .unwrap_or((rest, ""));

        // Parse host and port
        let (host, port) = parse_host_and_port(host_port)?;

        // Parse database and query params
        let (database, use_ssl) = if let Some((db, query)) = path_query.split_once('?') {
            let ssl = query.contains("sslmode=require") || query.contains("ssl=true") || query.contains("sslmode=verify-full");
            (db.to_string(), ssl)
        } else {
            (path_query.to_string(), false)
        };

        // Default ports
        let port = port.or_else(|| match db_type {
            DatabaseType::MySQL => Some(3306),
            DatabaseType::MariaDB => Some(3306),
            DatabaseType::PostgreSQL => Some(5432),
            DatabaseType::CockroachDB => Some(26257),
            DatabaseType::Greenplum => Some(5432),
            DatabaseType::Redshift => Some(5439),
            DatabaseType::Vertica => Some(5433),
            DatabaseType::SQLite => None,
            DatabaseType::DuckDB => None,
            DatabaseType::Cassandra => Some(9042),
            DatabaseType::Snowflake => Some(443),
            DatabaseType::MSSQL => Some(1433),
            DatabaseType::Redis => Some(6379),
            DatabaseType::MongoDB => Some(27017),
            DatabaseType::ClickHouse => Some(8123),
            DatabaseType::BigQuery => Some(443),
            DatabaseType::LibSQL => Some(8080),
            DatabaseType::CloudflareD1 => None,
        });

        Ok(Self {
            db_type,
            host,
            port,
            username,
            password,
            database: database.to_string(),
            use_ssl,
        })
    }
}

fn url_decode(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();

    while let Some(c) = chars.next() {
        if c == '%' {
            let d1 = chars.next();
            let d2 = chars.next();
            match (d1, d2) {
                (Some(h1), Some(h2))
                if h1.is_ascii_hexdigit() && h2.is_ascii_hexdigit() => {
                    let hex_str = format!("{}{}", h1, h2);
                    if let Ok(byte) = u8::from_str_radix(&hex_str, 16) {
                        result.push(byte as char);
                    } else {
                        result.push('%');
                        result.push(h1);
                        result.push(h2);
                    }
                }
                _ => {
                    result.push('%');
                    if let Some(d) = d1 { result.push(d); }
                    if let Some(d) = d2 { result.push(d); }
                }
            }
        } else if c == '+' {
            result.push(' ');
        } else {
            result.push(c);
        }
    }
    result
}

fn parse_host_and_port(host_port: &str) -> Result<(String, Option<u16>), String> {
    if host_port.trim().is_empty() {
        return Err("Invalid URL: missing host".to_string());
    }

    if let Some((h, p)) = host_port.rsplit_once(':') {
        if h.starts_with('[') {
            let ipv6_host = h
                .strip_prefix('[')
                .and_then(|value| value.strip_suffix(']'))
                .ok_or_else(|| "Invalid URL: unclosed IPv6 address".to_string())?;
            let port = p
                .parse::<u16>()
                .map(Some)
                .map_err(|_| "Invalid URL: port must be a valid number".to_string())?;
            return Ok((ipv6_host.to_string(), port));
        }

        if !h.contains(':') {
            let port = p
                .parse::<u16>()
                .map(Some)
                .map_err(|_| "Invalid URL: port must be a valid number".to_string())?;
            return Ok((h.to_string(), port));
        }
    }

    Ok((host_port.to_string(), None))
}

fn extract_query_param(query: &str, keys: &[&str]) -> Option<String> {
    query
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .find_map(|(key, value)| {
            keys.iter()
                .any(|candidate| key.eq_ignore_ascii_case(candidate))
                .then(|| url_decode(value))
        })
}

fn database_requires_username(db_type: DatabaseType) -> bool {
    matches!(
        db_type,
        DatabaseType::MySQL
            | DatabaseType::MariaDB
            | DatabaseType::PostgreSQL
            | DatabaseType::CockroachDB
            | DatabaseType::Greenplum
            | DatabaseType::Redshift
            | DatabaseType::Cassandra
            | DatabaseType::MSSQL
            | DatabaseType::Vertica
            | DatabaseType::ClickHouse
    )
}

#[allow(dead_code)]
impl ConnectionConfig {
    /// Create connection config from a full URL string
    pub fn from_url(url: &str, name: Option<String>) -> Result<Self, String> {
        let parsed = ParsedConnectionUrl::parse(url)?;

        let id = Uuid::new_v4().to_string();
        let db_type = parsed.db_type.clone();
        let host = parsed.host.clone();
        let database = parsed.database.clone();
        let use_ssl = parsed.use_ssl;

        Ok(Self {
            id,
            name: name.unwrap_or_else(|| {
                if database.is_empty() {
                    format!("{:?} {}", db_type, host)
                } else {
                    format!("{:?} {} / {}", db_type, host, database)
                }
            }),
            db_type,
            host: Some(host),
            port: parsed.port,
            username: Some(parsed.username),
            password: Some(parsed.password),
            database: if database.is_empty() { None } else { Some(database) },
            file_path: if parsed.db_type == DatabaseType::SQLite { Some(parsed.database) } else { None },
            use_ssl,
            ssl_mode: None,
            ssl_ca_cert_path: None,
            ssl_client_cert_path: None,
            ssl_client_key_path: None,
            ssl_skip_host_verification: None,
            color: None,
            additional_fields: HashMap::new(),
            startup_commands: None,
        })
    }

    pub fn default_port(&self) -> u16 {
        match self.db_type {
            DatabaseType::MySQL => 3306,
            DatabaseType::MariaDB => 3306,
            DatabaseType::PostgreSQL => 5432,
            DatabaseType::CockroachDB => 26257,
            DatabaseType::Greenplum => 5432,
            DatabaseType::Redshift => 5439,
            DatabaseType::SQLite => 0,
            DatabaseType::DuckDB => 0,
            DatabaseType::Cassandra => 9042,
            DatabaseType::Snowflake => 443,
            DatabaseType::MSSQL => 1433,
            DatabaseType::Redis => 6379,
            DatabaseType::MongoDB => 27017,
            DatabaseType::Vertica => 5433,
            DatabaseType::ClickHouse => 8123,
            DatabaseType::BigQuery => 443,
            DatabaseType::LibSQL => 8080,
            DatabaseType::CloudflareD1 => 0,
        }
    }

    pub fn generated_name(&self) -> String {
        let explicit_name = self.name.trim();
        if !explicit_name.is_empty() {
            return explicit_name.to_string();
        }

        if self.db_type == DatabaseType::SQLite {
            if let Some(path) = self.file_path.as_deref() {
                let trimmed = path.trim();
                if !trimmed.is_empty() {
                    let file_name = Path::new(trimmed)
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or(trimmed);
                    return format!("SQLite {}", file_name);
                }
            }

            return "SQLite local".to_string();
        }

        if self.db_type == DatabaseType::DuckDB {
            if let Some(path) = self.file_path.as_deref() {
                let trimmed = path.trim();
                if !trimmed.is_empty() {
                    let file_name = Path::new(trimmed)
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or(trimmed);
                    return format!("DuckDB {}", file_name);
                }
            }

            return "DuckDB local".to_string();
        }

        if self.db_type == DatabaseType::CloudflareD1 {
            if let Some(database_id) = self
                .additional_fields
                .get("database_id")
                .map(String::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                return format!("Cloudflare D1 {}", database_id);
            }

            return "Cloudflare D1".to_string();
        }

        if self.db_type == DatabaseType::BigQuery {
            let project_id = self
                .additional_fields
                .get("project_id")
                .map(String::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let dataset = self
                .additional_fields
                .get("dataset")
                .map(String::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty());

            return match (project_id, dataset) {
                (Some(project_id), Some(dataset)) => {
                    format!("BigQuery {} / {}", project_id, dataset)
                }
                (Some(project_id), None) => format!("BigQuery {}", project_id),
                _ => "BigQuery".to_string(),
            };
        }

        let host = self.host.as_deref().unwrap_or("").trim();
        let database = self.database.as_deref().unwrap_or("").trim();
        let db_label = format!("{:?}", self.db_type);

        if !host.is_empty() && !database.is_empty() {
            format!("{} {} / {}", db_label, host, database)
        } else if !database.is_empty() {
            format!("{} {}", db_label, database)
        } else if !host.is_empty() {
            format!("{} {}", db_label, host)
        } else {
            format!("{} connection", db_label)
        }
    }

    pub fn fill_generated_name(&mut self) {
        if self.name.trim().is_empty() {
            self.name = self.generated_name();
        }
    }

    /// Validate connection config before attempting to connect
    pub fn validate(&self) -> Result<(), String> {
        if self.name.trim().is_empty() {
            return Err("Connection name cannot be empty".to_string());
        }

        // Validate ID format (UUID)
        if self.id.trim().is_empty() {
            return Err("Connection ID cannot be empty".to_string());
        }

        // SQLite only requires file_path, other databases require host
        match self.db_type {
            DatabaseType::SQLite => {
                let path = self
                    .file_path
                    .as_deref()
                    .ok_or_else(|| "SQLite file path is required".to_string())?;
                validate_local_file_path(
                    path,
                    &["db", "db3", "sqlite", "sqlite3"],
                    "SQLite file path",
                    "SQLite",
                )?;
            }
            DatabaseType::DuckDB => {
                let path = self
                    .file_path
                    .as_deref()
                    .ok_or_else(|| "DuckDB file path is required".to_string())?;
                validate_local_file_path(
                    path,
                    &["duckdb", "ddb", "db"],
                    "DuckDB file path",
                    "DuckDB",
                )?;
            }
            DatabaseType::CloudflareD1 => {
                let account_id = self
                    .additional_fields
                    .get("account_id")
                    .map(String::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| "Cloudflare account ID is required".to_string())?;
                if account_id.len() > 64 {
                    return Err("Cloudflare account ID is too long".to_string());
                }

                let database_id = self
                    .additional_fields
                    .get("database_id")
                    .map(String::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| "Cloudflare D1 database ID is required".to_string())?;
                if database_id.len() > 128 {
                    return Err("Cloudflare D1 database ID is too long".to_string());
                }

                let token = self
                    .password
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| "Cloudflare API token is required".to_string())?;
                if token.len() > 512 {
                    return Err("Cloudflare API token is too long".to_string());
                }

                if let Some(host) = self.host.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
                    validate_network_host(host)?;
                }
            }
            DatabaseType::Snowflake => {
                let host = self
                    .host
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| "Snowflake account host is required".to_string())?;
                validate_network_host(host)?;

                let token = self
                    .password
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        "Snowflake auth token is required (programmatic access token, OAuth token, or JWT)"
                            .to_string()
                    })?;
                if token.len() > 8192 {
                    return Err("Snowflake auth token is too long".to_string());
                }

                if let Some(database) = self
                    .database
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    if database.len() > 256 {
                        return Err("Snowflake database name is too long".to_string());
                    }
                }

                if let Some(warehouse) = self
                    .additional_fields
                    .get("warehouse")
                    .map(String::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    if warehouse.len() > 256 {
                        return Err("Snowflake warehouse name is too long".to_string());
                    }
                }

                if let Some(schema) = self
                    .additional_fields
                    .get("schema")
                    .map(String::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    if schema.len() > 256 {
                        return Err("Snowflake schema name is too long".to_string());
                    }
                }

                if let Some(role) = self
                    .additional_fields
                    .get("role")
                    .map(String::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    if role.len() > 256 {
                        return Err("Snowflake role name is too long".to_string());
                    }
                }

                if let Some(port) = self.port {
                    if port == 0 {
                        return Err("Port cannot be zero".to_string());
                    }
                }
            }
            DatabaseType::BigQuery => {
                let project_id = self
                    .additional_fields
                    .get("project_id")
                    .map(String::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| "BigQuery project ID is required".to_string())?;
                if project_id.len() > 128 {
                    return Err("BigQuery project ID is too long".to_string());
                }

                if let Some(dataset) = self
                    .additional_fields
                    .get("dataset")
                    .map(String::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    if dataset.len() > 256 {
                        return Err("BigQuery dataset is too long".to_string());
                    }
                }

                if let Some(location) = self
                    .additional_fields
                    .get("location")
                    .map(String::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    if location.len() > 64 {
                        return Err("BigQuery location is too long".to_string());
                    }
                }

                let token = self
                    .password
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| "BigQuery access token is required".to_string())?;
                if token.len() > 8192 {
                    return Err("BigQuery access token is too long".to_string());
                }

                if let Some(host) = self
                    .host
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    validate_network_host(host)?;
                }
            }
            _ => {
                // For network databases, host is required
                if let Some(ref host) = self.host {
                    validate_network_host(host)?;
                } else {
                    return Err("Host is required for this database type".to_string());
                }

                if self
                    .username
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .is_none()
                    && database_requires_username(self.db_type)
                {
                    return Err("Username is required for this database type".to_string());
                }

                // Validate port if provided
                if let Some(port) = self.port {
                    if port == 0 {
                        return Err("Port cannot be zero".to_string());
                    }
                }
            }
        }

        Ok(())
    }
}

fn validate_network_host(host: &str) -> Result<(), String> {
    let trimmed = host.trim();
    if trimmed.is_empty() {
        return Err("Host cannot be empty".to_string());
    }

    if trimmed
        .chars()
        .any(|ch| ch.is_control() || ch.is_whitespace())
    {
        return Err("Host contains invalid whitespace or control characters".to_string());
    }

    if trimmed.contains("://")
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains('?')
        || trimmed.contains('#')
    {
        return Err("Host must not include a scheme, path, query, or fragment".to_string());
    }

    Ok(())
}

fn validate_local_file_path(
    path: &str,
    allowed_extensions: &[&str],
    empty_message: &str,
    engine_label: &str,
) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(format!("{empty_message} cannot be empty"));
    }

    if trimmed == ":memory:" {
        return Ok(());
    }

    if trimmed
        .chars()
        .any(|ch| matches!(ch, '\0' | '\r' | '\n' | '\t'))
    {
        return Err(format!("{engine_label} file path contains invalid control characters"));
    }

    if trimmed.starts_with("\\\\") {
        return Err(format!("{engine_label} file paths cannot use remote UNC locations"));
    }

    let colon_positions = trimmed.match_indices(':').map(|(index, _)| index).collect::<Vec<_>>();
    if colon_positions.len() > 1 || colon_positions.iter().any(|index| *index > 1) {
        return Err(format!(
            "{engine_label} file paths cannot use URI-style or alternate data stream suffixes"
        ));
    }

    let local_path = Path::new(trimmed);
    if local_path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(
            format!("{engine_label} file path cannot contain parent directory traversal segments"),
        );
    }

    let extension = local_path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase());

    if !matches!(extension.as_deref(), Some(ext) if allowed_extensions.iter().any(|candidate| ext == *candidate)) {
        let formatted_extensions = allowed_extensions
            .iter()
            .map(|ext| format!(".{ext}"))
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!(
            "{engine_label} file path must use one of these extensions: {formatted_extensions}"
        ));
    }

    let resolved_path = if local_path.is_absolute() {
        local_path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(PathBuf::from)
            .map_err(|_| "Could not resolve the current working directory".to_string())?
            .join(local_path)
    };

    for ancestor in resolved_path.ancestors() {
        if !ancestor.exists() {
            continue;
        }

        let metadata = fs::symlink_metadata(ancestor)
            .map_err(|_| format!("Could not inspect the selected {engine_label} file path"))?;

        if metadata.file_type().is_symlink() {
            return Err(format!("{engine_label} symlink targets are not allowed"));
        }
    }

    if local_path.exists() {
        let metadata = fs::symlink_metadata(local_path)
            .map_err(|_| format!("Could not inspect the selected {engine_label} file path"))?;

        if metadata.file_type().is_symlink() {
            return Err(format!("{engine_label} symlink targets are not allowed"));
        }

        if metadata.is_dir() {
            return Err(format!("{engine_label} file path must point to a file, not a directory"));
        }
    }

    if let Some(parent_dir) = resolved_path.parent() {
        if parent_dir.exists() && !parent_dir.is_dir() {
            return Err(format!("{engine_label} file path must use a valid parent directory"));
        }
    }

    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResult {
    pub columns: Vec<ColumnInfo>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub affected_rows: u64,
    pub execution_time_ms: u128,
    pub query: String,
    pub sandboxed: bool,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub is_nullable: bool,
    pub is_primary_key: bool,
    pub max_length: Option<u32>,
    pub default_value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RowKeyValue {
    pub column: String,
    pub value: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableCellUpdateRequest {
    pub table: String,
    pub database: Option<String>,
    pub target_column: String,
    pub value: serde_json::Value,
    pub primary_keys: Vec<RowKeyValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableRowDeleteRequest {
    pub table: String,
    pub database: Option<String>,
    pub rows: Vec<Vec<RowKeyValue>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableRowInsertRequest {
    pub table: String,
    pub database: Option<String>,
    /// Column names and values for the new row.
    pub values: Vec<(String, serde_json::Value)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableInfo {
    pub name: String,
    pub schema: Option<String>,
    pub table_type: String,
    pub row_count: Option<i64>,
    pub engine: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseInfo {
    pub name: String,
    pub size: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableStructure {
    pub columns: Vec<ColumnDetail>,
    pub indexes: Vec<IndexInfo>,
    pub foreign_keys: Vec<ForeignKeyInfo>,
    pub triggers: Vec<TriggerInfo>,
    pub view_definition: Option<String>,
    pub object_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnDetail {
    pub name: String,
    pub data_type: String,
    pub is_nullable: bool,
    pub is_primary_key: bool,
    pub default_value: Option<String>,
    pub extra: Option<String>,
    pub column_type: Option<String>,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub is_unique: bool,
    pub index_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForeignKeyInfo {
    pub name: String,
    pub column: String,
    pub referenced_table: String,
    pub referenced_column: String,
    pub on_update: Option<String>,
    pub on_delete: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TriggerInfo {
    pub name: String,
    pub timing: Option<String>,
    pub event: Option<String>,
    pub related_table: Option<String>,
    pub definition: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaObjectInfo {
    pub name: String,
    pub schema: Option<String>,
    pub object_type: String,
    pub related_table: Option<String>,
    pub definition: Option<String>,
}

/// A single value for FK lookup dropdowns: { value, label }
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LookupValue {
    pub value: serde_json::Value,
    pub label: String,
}

#[cfg(test)]
mod tests {
    use super::{ConnectionConfig, DatabaseType, ParsedConnectionUrl};
    use std::collections::HashMap;

    #[test]
    fn parses_redis_url_with_password_only() {
        let placeholder_credential = "example-pass";
        let parsed = ParsedConnectionUrl::parse(
            &format!("redis://:{}@127.0.0.1:6379/2", placeholder_credential),
        )
        .unwrap();
        assert_eq!(parsed.db_type, DatabaseType::Redis);
        assert_eq!(parsed.host, "127.0.0.1");
        assert_eq!(parsed.port, Some(6379));
        assert_eq!(parsed.username, "");
        assert_eq!(parsed.password, placeholder_credential);
        assert_eq!(parsed.database, "2");
        assert!(!parsed.use_ssl);
    }

    #[test]
    fn allows_redis_validation_without_username() {
        let config = ConnectionConfig {
            id: "redis-test".to_string(),
            name: "Redis test".to_string(),
            db_type: DatabaseType::Redis,
            host: Some("127.0.0.1".to_string()),
            port: Some(6379),
            username: Some(String::new()),
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
            startup_commands: None,
        };

        assert!(config.validate().is_ok());
    }

    #[test]
    fn parses_mongodb_url_with_auth_source() {
        let placeholder_credential = "example-pass";
        let parsed = ParsedConnectionUrl::parse(
            &format!(
                "mongodb://app_user:{}@127.0.0.1:27017/appdb?authSource=admin&tls=true",
                placeholder_credential
            ),
        )
        .unwrap();
        assert_eq!(parsed.db_type, DatabaseType::MongoDB);
        assert_eq!(parsed.host, "127.0.0.1");
        assert_eq!(parsed.port, Some(27017));
        assert_eq!(parsed.username, "app_user");
        assert_eq!(parsed.password, placeholder_credential);
        assert_eq!(parsed.database, "appdb");
        assert!(parsed.use_ssl);
    }

    #[test]
    fn parses_mongodb_srv_url() {
        let parsed = ParsedConnectionUrl::parse("mongodb+srv://cluster.example.mongodb.net/admin")
            .unwrap();
        assert_eq!(parsed.db_type, DatabaseType::MongoDB);
        assert_eq!(parsed.host, "cluster.example.mongodb.net");
        assert_eq!(parsed.port, Some(27017));
        assert_eq!(parsed.database, "admin");
        assert!(parsed.use_ssl);
    }

    #[test]
    fn parses_cassandra_url() {
        let placeholder_credential = "example-pass";
        let parsed = ParsedConnectionUrl::parse(
            &format!("cassandra://cassandra:{}@127.0.0.1:9042/appks", placeholder_credential),
        )
        .unwrap();
        assert_eq!(parsed.db_type, DatabaseType::Cassandra);
        assert_eq!(parsed.host, "127.0.0.1");
        assert_eq!(parsed.port, Some(9042));
        assert_eq!(parsed.username, "cassandra");
        assert_eq!(parsed.password, placeholder_credential);
        assert_eq!(parsed.database, "appks");
        assert!(!parsed.use_ssl);
    }

    #[test]
    fn parses_snowflake_url() {
        let placeholder_credential = "example-snowflake-credential";
        let parsed = ParsedConnectionUrl::parse(
            &format!(
                "snowflake://token_user:{}@acme.us-east-1.snowflakecomputing.com:443/analytics",
                placeholder_credential
            ),
        )
        .unwrap();
        assert_eq!(parsed.db_type, DatabaseType::Snowflake);
        assert_eq!(parsed.host, "acme.us-east-1.snowflakecomputing.com");
        assert_eq!(parsed.port, Some(443));
        assert_eq!(parsed.username, "token_user");
        assert_eq!(parsed.password, placeholder_credential);
        assert_eq!(parsed.database, "analytics");
    }

    #[test]
    fn validates_snowflake_requirements_without_username() {
        let mut additional_fields = HashMap::new();
        additional_fields.insert("warehouse".to_string(), "COMPUTE_WH".to_string());
        additional_fields.insert("schema".to_string(), "PUBLIC".to_string());
        additional_fields.insert("role".to_string(), "SYSADMIN".to_string());

        let config = ConnectionConfig {
            id: "snowflake-test".to_string(),
            name: "Snowflake".to_string(),
            db_type: DatabaseType::Snowflake,
            host: Some("acme.us-east-1.snowflakecomputing.com".to_string()),
            port: Some(443),
            username: None,
            password: Some("example-snowflake-credential".to_string()),
            database: Some("analytics".to_string()),
            file_path: None,
            use_ssl: true,
            ssl_mode: None,
            ssl_ca_cert_path: None,
            ssl_client_cert_path: None,
            ssl_client_key_path: None,
            ssl_skip_host_verification: None,
            color: None,
            additional_fields,
            startup_commands: None,
        };

        assert!(config.validate().is_ok());
    }

    #[test]
    fn validates_cloudflare_d1_requirements() {
        let mut additional_fields = HashMap::new();
        additional_fields.insert("account_id".to_string(), "acct_123".to_string());
        additional_fields.insert("database_id".to_string(), "db_123".to_string());

        let config = ConnectionConfig {
            id: "d1-test".to_string(),
            name: "Cloudflare D1".to_string(),
            db_type: DatabaseType::CloudflareD1,
            host: Some("api.cloudflare.com".to_string()),
            port: Some(443),
            username: None,
            password: Some("example-cloudflare-credential".to_string()),
            database: None,
            file_path: None,
            use_ssl: true,
            ssl_mode: None,
            ssl_ca_cert_path: None,
            ssl_client_cert_path: None,
            ssl_client_key_path: None,
            ssl_skip_host_verification: None,
            color: None,
            additional_fields,
            startup_commands: None,
        };

        assert!(config.validate().is_ok());
    }

    #[test]
    fn validates_bigquery_requirements() {
        let mut additional_fields = HashMap::new();
        additional_fields.insert("project_id".to_string(), "analytics-project".to_string());
        additional_fields.insert("dataset".to_string(), "events".to_string());
        additional_fields.insert("location".to_string(), "us-central1".to_string());

        let config = ConnectionConfig {
            id: "bigquery-test".to_string(),
            name: "BigQuery".to_string(),
            db_type: DatabaseType::BigQuery,
            host: Some("bigquery.googleapis.com".to_string()),
            port: Some(443),
            username: None,
            password: Some("example-bigquery-credential".to_string()),
            database: None,
            file_path: None,
            use_ssl: true,
            ssl_mode: None,
            ssl_ca_cert_path: None,
            ssl_client_cert_path: None,
            ssl_client_key_path: None,
            ssl_skip_host_verification: None,
            color: None,
            additional_fields,
            startup_commands: None,
        };

        assert!(config.validate().is_ok());
    }
}
