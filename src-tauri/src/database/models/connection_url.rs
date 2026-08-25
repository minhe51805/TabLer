use super::connection::{ConnectionConfig, DatabaseType};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use uuid::Uuid;

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
        let (scheme, rest) = url
            .split_once("://")
            .ok_or_else(|| "Invalid URL: missing scheme (e.g., postgresql://)".to_string())?;

        // Strip SQLAlchemy driver suffix (e.g., "postgresql+psycopg2" -> "postgresql")
        let scheme_clean = if let Some((base, _)) = scheme.split_once('+') {
            base.to_lowercase()
        } else {
            scheme.to_lowercase()
        };

        let db_type = match scheme_clean.as_str() {
            "postgresql" | "postgres" => DatabaseType::PostgreSQL,
            "cockroachdb" | "cockroach" => DatabaseType::CockroachDB,
            "greenplum" => DatabaseType::Greenplum,
            "redshift" => DatabaseType::Redshift,
            "vertica" => DatabaseType::Vertica,
            "mysql" => DatabaseType::MySQL,
            "mssql" => DatabaseType::MSSQL,
            "mariadb" => DatabaseType::MariaDB,
            "snowflake" => DatabaseType::Snowflake,
            "cassandra" | "scylla" => DatabaseType::Cassandra,
            "clickhouse" => DatabaseType::ClickHouse,
            "libsql" => DatabaseType::LibSQL,
            "sqlite" => DatabaseType::SQLite,
            "redis" | "rediss" => DatabaseType::Redis,
            "mongodb" => DatabaseType::MongoDB,
            "opensearch" | "elasticsearch" => DatabaseType::OpenSearch,
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
            let auth_token =
                extract_query_param(query, &["authToken", "auth_token"]).unwrap_or_default();

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
        let (auth_part, rest) = rest
            .split_once('@')
            .ok_or_else(|| "Invalid URL: missing credentials or host".to_string())?;

        // Parse username:password
        let (username, password) = if let Some((u, p)) = auth_part.split_once(':') {
            (url_decode(u), url_decode(p))
        } else {
            (url_decode(auth_part), String::new())
        };

        // Parse host:port/database?params
        let (host_port, path_query) = rest.split_once('/').unwrap_or((rest, ""));

        // Parse host and port
        let (host, port) = parse_host_and_port(host_port)?;

        // Parse database and query params
        let (database, use_ssl) = if let Some((db, query)) = path_query.split_once('?') {
            let ssl = query.contains("sslmode=require")
                || query.contains("ssl=true")
                || query.contains("sslmode=verify-full");
            (db.to_string(), ssl)
        } else {
            (path_query.to_string(), false)
        };

        // Default ports
        let port = port.or(match db_type {
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
            DatabaseType::OpenSearch => Some(9200),
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
                (Some(h1), Some(h2)) if h1.is_ascii_hexdigit() && h2.is_ascii_hexdigit() => {
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
                    if let Some(d) = d1 {
                        result.push(d);
                    }
                    if let Some(d) = d2 {
                        result.push(d);
                    }
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

#[allow(dead_code)]
impl ConnectionConfig {
    /// Create connection config from a full URL string
    pub fn from_url(url: &str, name: Option<String>) -> Result<Self, String> {
        let parsed = ParsedConnectionUrl::parse(url)?;

        let id = Uuid::new_v4().to_string();
        let db_type = parsed.db_type;
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
            database: if database.is_empty() {
                None
            } else {
                Some(database)
            },
            file_path: if parsed.db_type == DatabaseType::SQLite {
                Some(parsed.database)
            } else {
                None
            },
            use_ssl,
            ssl_mode: None,
            ssl_ca_cert_path: None,
            ssl_client_cert_path: None,
            ssl_client_key_path: None,
            ssl_skip_host_verification: None,
            color: None,
            additional_fields: HashMap::new(),
            pre_connect_script: None,
            startup_commands: None,
            ssh_config: None,
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
            DatabaseType::OpenSearch => 9200,
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
}

#[cfg(test)]
mod tests {
    use super::{DatabaseType, ParsedConnectionUrl};

    #[test]
    fn parses_redis_url_with_password_only() {
        let placeholder_credential = "example-pass";
        let parsed = ParsedConnectionUrl::parse(&format!(
            "redis://:{}@127.0.0.1:6379/2",
            placeholder_credential
        ))
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
    fn parses_mongodb_url_with_auth_source() {
        let placeholder_credential = "example-pass";
        let parsed = ParsedConnectionUrl::parse(&format!(
            "mongodb://app_user:{}@127.0.0.1:27017/appdb?authSource=admin&tls=true",
            placeholder_credential
        ))
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
        let parsed =
            ParsedConnectionUrl::parse("mongodb+srv://cluster.example.mongodb.net/admin").unwrap();
        assert_eq!(parsed.db_type, DatabaseType::MongoDB);
        assert_eq!(parsed.host, "cluster.example.mongodb.net");
        assert_eq!(parsed.port, Some(27017));
        assert_eq!(parsed.database, "admin");
        assert!(parsed.use_ssl);
    }

    #[test]
    fn parses_cassandra_url() {
        let placeholder_credential = "example-pass";
        let parsed = ParsedConnectionUrl::parse(&format!(
            "cassandra://cassandra:{}@127.0.0.1:9042/appks",
            placeholder_credential
        ))
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
    fn parses_sqlalchemy_style_urls() {
        // postgresql+driver:// scheme should strip +driver suffix
        let parsed =
            ParsedConnectionUrl::parse("postgresql+psycopg2://user:pass@localhost:5432/mydb")
                .unwrap();
        assert_eq!(parsed.db_type, DatabaseType::PostgreSQL);
        assert_eq!(parsed.host, "localhost");
        assert_eq!(parsed.port, Some(5432));
        assert_eq!(parsed.username, "user");
        assert_eq!(parsed.password, "pass");
        assert_eq!(parsed.database, "mydb");

        // mysql+aiomysql://
        let parsed =
            ParsedConnectionUrl::parse("mysql+aiomysql://root:secret@db.example.com/mydb").unwrap();
        assert_eq!(parsed.db_type, DatabaseType::MySQL);
        assert_eq!(parsed.host, "db.example.com");
        assert_eq!(parsed.port, Some(3306));
        assert_eq!(parsed.username, "root");
        assert_eq!(parsed.password, "secret");
        assert_eq!(parsed.database, "mydb");

        // mssql+pymssql://
        let parsed = ParsedConnectionUrl::parse(
            "mssql+pymssql://sa:Password123@192.168.1.100:1433/TablerDB",
        )
        .unwrap();
        assert_eq!(parsed.db_type, DatabaseType::MSSQL);
        assert_eq!(parsed.host, "192.168.1.100");
        assert_eq!(parsed.port, Some(1433));
        assert_eq!(parsed.username, "sa");
        assert_eq!(parsed.password, "Password123");
        assert_eq!(parsed.database, "TablerDB");
    }

    #[test]
    fn parses_snowflake_url() {
        let placeholder_credential = "example-snowflake-credential";
        let parsed = ParsedConnectionUrl::parse(&format!(
            "snowflake://token_user:{}@acme.us-east-1.snowflakecomputing.com:443/analytics",
            placeholder_credential
        ))
        .unwrap();
        assert_eq!(parsed.db_type, DatabaseType::Snowflake);
        assert_eq!(parsed.host, "acme.us-east-1.snowflakecomputing.com");
        assert_eq!(parsed.port, Some(443));
        assert_eq!(parsed.username, "token_user");
        assert_eq!(parsed.password, placeholder_credential);
        assert_eq!(parsed.database, "analytics");
    }
}
