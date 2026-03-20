use serde::{Deserialize, Serialize};
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
    pub color: Option<String>,
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
    /// Parse a full connection URL (e.g., postgresql://user:pass@host:5432/db?sslmode=require)
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
            "mysql" => DatabaseType::MySQL,
            "mariadb" => DatabaseType::MariaDB,
            "sqlite" => DatabaseType::SQLite,
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

        // Parse user:pass@host:port/database?params
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
        let (host, port) = if let Some((h, p)) = host_port.rsplit_once(':') {
            // Handle IPv6 addresses like [::1]:5432
            if h.starts_with('[') {
                let ipv6_host = h
                    .strip_prefix('[')
                    .and_then(|value| value.strip_suffix(']'))
                    .ok_or_else(|| "Invalid URL: unclosed IPv6 address".to_string())?;
                let port = p.parse().ok();
                (ipv6_host.to_string(), port)
            } else {
                let port = p.parse().ok();
                (h.to_string(), port)
            }
        } else {
            (host_port.to_string(), None)
        };

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
            DatabaseType::SQLite => None,
            DatabaseType::DuckDB => None,
            DatabaseType::Cassandra => Some(9042),
            DatabaseType::Snowflake => Some(443),
            DatabaseType::MSSQL => Some(1433),
            DatabaseType::Redis => Some(6379),
            DatabaseType::MongoDB => Some(27017),
            DatabaseType::Vertica => Some(5433),
            DatabaseType::ClickHouse => Some(8123),
            DatabaseType::BigQuery => None,
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
    // Simple URL decode - handle common cases
    let mut result = String::new();
    let mut chars = s.chars().peekable();

    while let Some(c) = chars.next() {
        if c == '%' {
            let hex: String = chars.by_ref().take(2).collect();
            if hex.len() == 2 {
                if let Ok(byte) = u8::from_str_radix(&hex, 16) {
                    result.push(byte as char);
                    continue;
                }
            }
            result.push('%');
            result.push_str(&hex);
        } else if c == '+' {
            result.push(' ');
        } else {
            result.push(c);
        }
    }
    result
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
            color: None,
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
            DatabaseType::BigQuery => 0,
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
                validate_sqlite_file_path(path)?;
            }
            DatabaseType::DuckDB | DatabaseType::BigQuery | DatabaseType::CloudflareD1 => {
                if let Some(ref path) = self.file_path {
                    if path.trim().is_empty() {
                        return Err("File path cannot be empty for SQLite/DuckDB".to_string());
                    }
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

fn validate_sqlite_file_path(path: &str) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("SQLite file path cannot be empty".to_string());
    }

    if trimmed == ":memory:" {
        return Ok(());
    }

    if trimmed
        .chars()
        .any(|ch| matches!(ch, '\0' | '\r' | '\n' | '\t'))
    {
        return Err("SQLite file path contains invalid control characters".to_string());
    }

    if trimmed.starts_with("\\\\") {
        return Err("SQLite file paths cannot use remote UNC locations".to_string());
    }

    let colon_positions = trimmed.match_indices(':').map(|(index, _)| index).collect::<Vec<_>>();
    if colon_positions.len() > 1 || colon_positions.iter().any(|index| *index > 1) {
        return Err("SQLite file paths cannot use URI-style or alternate data stream suffixes".to_string());
    }

    let sqlite_path = Path::new(trimmed);
    if sqlite_path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(
            "SQLite file path cannot contain parent directory traversal segments".to_string(),
        );
    }

    let extension = sqlite_path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase());

    match extension.as_deref() {
        Some("db") | Some("db3") | Some("sqlite") | Some("sqlite3") => {}
        _ => {
            return Err(
                "SQLite file path must use a .db, .db3, .sqlite, or .sqlite3 extension"
                    .to_string(),
            )
        }
    }

    let resolved_path = if sqlite_path.is_absolute() {
        sqlite_path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(PathBuf::from)
            .map_err(|_| "Could not resolve the current working directory".to_string())?
            .join(sqlite_path)
    };

    for ancestor in resolved_path.ancestors() {
        if !ancestor.exists() {
            continue;
        }

        let metadata = fs::symlink_metadata(ancestor)
            .map_err(|_| "Could not inspect the selected SQLite file path".to_string())?;

        if metadata.file_type().is_symlink() {
            return Err("SQLite symlink targets are not allowed".to_string());
        }
    }

    if sqlite_path.exists() {
        let metadata = fs::symlink_metadata(sqlite_path)
            .map_err(|_| "Could not inspect the selected SQLite file path".to_string())?;

        if metadata.file_type().is_symlink() {
            return Err("SQLite symlink targets are not allowed".to_string());
        }

        if metadata.is_dir() {
            return Err("SQLite file path must point to a file, not a directory".to_string());
        }
    }

    if let Some(parent_dir) = resolved_path.parent() {
        if parent_dir.exists() && !parent_dir.is_dir() {
            return Err("SQLite file path must use a valid parent directory".to_string());
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
