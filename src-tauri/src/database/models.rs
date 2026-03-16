use serde::{Deserialize, Serialize};
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
                let closing = h.find(']')
                    .ok_or_else(|| "Invalid URL: unclosed IPv6 address".to_string())?;
                let ipv6_host = &h[1..closing];
                let port_str = &h[closing+1..];
                let port = port_str.parse().ok();
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

    pub fn connection_url(&self) -> Result<String, String> {
        match self.db_type {
            DatabaseType::MySQL | DatabaseType::MariaDB => {
                let host = self.host.as_deref().unwrap_or("127.0.0.1");
                let port = self.port.unwrap_or_else(|| self.default_port());
                let user = self.username.as_deref().unwrap_or("root");
                let pass = self.password.as_deref().unwrap_or("");
                let db = self.database.as_deref().unwrap_or("");
                // Add sslmode for cloud MySQL connections
                let ssl_param = if self.use_ssl { "?ssl=true" } else { "" };
                if db.is_empty() {
                    Ok(format!("mysql://{}:{}@{}:{}{}", user, pass, host, port, ssl_param))
                } else {
                    Ok(format!("mysql://{}:{}@{}:{}/{}{}", user, pass, host, port, db, ssl_param))
                }
            }
            DatabaseType::PostgreSQL
            | DatabaseType::CockroachDB
            | DatabaseType::Greenplum
            | DatabaseType::Redshift => {
                let host = self.host.as_deref().unwrap_or("127.0.0.1");
                let port = self.port.unwrap_or_else(|| self.default_port());
                let user = self.username.as_deref().unwrap_or("postgres");
                let pass = self.password.as_deref().unwrap_or("");
                let db = self.database.as_deref().unwrap_or("postgres");
                // Use postgresql:// scheme (more standard) with sslmode=require for cloud connections
                let ssl_mode = if self.use_ssl { "?sslmode=require" } else { "" };
                Ok(format!("postgresql://{}:{}@{}:{}/{}{}", user, pass, host, port, db, ssl_mode))
            }
            DatabaseType::SQLite => {
                let path = self.file_path.as_deref().unwrap_or(":memory:");
                Ok(format!("sqlite:{}", path))
            }
            _ => Err(format!("{:?} connections are not wired into this build yet.", self.db_type)),
        }
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResult {
    pub columns: Vec<ColumnInfo>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub affected_rows: u64,
    pub execution_time_ms: u128,
    pub query: String,
    pub sandboxed: bool,
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
