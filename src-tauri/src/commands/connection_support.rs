use super::connection::CONNECTION_TIMEOUT;
use crate::database::driver::DatabaseDriver;
use crate::database::models::{ConnectionConfig, DatabaseType};
use crate::database::safety::{quote_mysql_identifier, quote_postgres_identifier};
use crate::database::sqlite::SqliteDriver;
use sqlx::mysql::{MySqlConnectOptions, MySqlConnection, MySqlSslMode};
use sqlx::postgres::{PgConnectOptions, PgSslMode};
use sqlx::{ConnectOptions, Connection, Executor};
use std::path::PathBuf;
use tokio::task;



pub(super) async fn run_blocking_storage_task<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    task::spawn_blocking(operation)
        .await
        .map_err(|_| "Background storage task failed unexpectedly.".to_string())?
}

pub(super) fn connection_rate_limit_key(config: &ConnectionConfig) -> String {
    let host = config
        .host
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let user = config
        .username
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let database = config
        .database
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    format!("{:?}|{}|{}|{}", config.db_type, host, user, database)
}

pub(super) fn connection_engine_label(db_type: DatabaseType) -> &'static str {
    match db_type {
        DatabaseType::MySQL => "MySQL",
        DatabaseType::MariaDB => "MariaDB",
        DatabaseType::PostgreSQL => "PostgreSQL",
        DatabaseType::CockroachDB => "CockroachDB",
        DatabaseType::Greenplum => "Greenplum",
        DatabaseType::Redshift => "Redshift",
        DatabaseType::SQLite => "SQLite",
        DatabaseType::DuckDB => "DuckDB",
        DatabaseType::Cassandra => "Cassandra",
        DatabaseType::Snowflake => "Snowflake",
        DatabaseType::MSSQL => "SQL Server",
        DatabaseType::Redis => "Redis",
        DatabaseType::MongoDB => "MongoDB",
        DatabaseType::Vertica => "Vertica",
        DatabaseType::ClickHouse => "ClickHouse",
        DatabaseType::BigQuery => "BigQuery",
        DatabaseType::LibSQL => "LibSQL",
        DatabaseType::CloudflareD1 => "Cloudflare D1",
        DatabaseType::OpenSearch => "OpenSearch",
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ConnectionFailureStage {
    Dns,
    Tcp,
    Tunnel,
    Tls,
    Authentication,
    DatabaseSelection,
    Timeout,
    Unknown,
}

pub(super) fn classify_connection_failure(
    config: &ConnectionConfig,
    normalized: &str,
) -> ConnectionFailureStage {
    if config.ssh_config.as_ref().is_some_and(|ssh| ssh.enabled)
        && ["ssh", "handshake", "tunnel", "channel"]
            .iter()
            .any(|token| normalized.contains(token))
    {
        return ConnectionFailureStage::Tunnel;
    }
    if [
        "dns",
        "failed to lookup address",
        "name or service not known",
        "nodename nor servname",
        "no such host",
    ]
    .iter()
    .any(|token| normalized.contains(token))
    {
        return ConnectionFailureStage::Dns;
    }
    if normalized.contains("10061")
        || normalized.contains("actively refused")
        || normalized.contains("connection refused")
        || normalized.contains("network is unreachable")
    {
        return ConnectionFailureStage::Tcp;
    }
    if normalized.contains("certificate")
        || normalized.contains("tls")
        || normalized.contains("ssl")
    {
        return ConnectionFailureStage::Tls;
    }
    if normalized.contains("authentication")
        || normalized.contains("password")
        || normalized.contains("access denied")
        || normalized.contains("auth failed")
    {
        return ConnectionFailureStage::Authentication;
    }
    if normalized.contains("does not exist")
        || normalized.contains("unknown database")
        || normalized.contains("database")
            && (normalized.contains("not found") || normalized.contains("missing"))
    {
        return ConnectionFailureStage::DatabaseSelection;
    }
    if normalized.contains("timed out") || normalized.contains("timeout") {
        return ConnectionFailureStage::Timeout;
    }
    ConnectionFailureStage::Unknown
}

pub(super) fn format_connection_runtime_error(
    config: &ConnectionConfig,
    error: impl std::fmt::Display,
) -> String {
    let engine = connection_engine_label(config.db_type);
    let raw = error.to_string();
    let normalized = raw.to_ascii_lowercase();

    match classify_connection_failure(config, &normalized) {
        ConnectionFailureStage::Dns => format!(
            "Connection failed at DNS lookup: the {} host name could not be resolved.", engine
        ),
        ConnectionFailureStage::Tcp => format!(
            "Connection failed at TCP: the {} server refused or could not accept the host/port connection.", engine
        ),
        ConnectionFailureStage::Tunnel => format!(
            "Connection failed at SSH tunnel: verify the bastion host, SSH credentials, and forwarding settings for {}.", engine
        ),
        ConnectionFailureStage::Tls => format!(
            "Connection failed at TLS: {} certificate or SSL negotiation failed.", engine
        ),
        ConnectionFailureStage::Authentication => format!(
            "Connection failed at authentication: verify the {} username and password.", engine
        ),
        ConnectionFailureStage::DatabaseSelection => format!(
            "Connection failed at database selection: the requested {} database was not found.", engine
        ),
        ConnectionFailureStage::Timeout => format!(
            "Connection timed out: {} did not respond before the deadline.", engine
        ),
        ConnectionFailureStage::Unknown => format!(
            "Failed to connect to {}. Please verify the host, port, credentials, and database settings.",
            engine
        ),
    }
}

pub(super) fn format_local_admin_connection_error(
    engine_label: &str,
    host: &str,
    port: u16,
    error: impl std::fmt::Display,
) -> String {
    let raw_error = error.to_string();
    let normalized = raw_error.to_ascii_lowercase();

    if normalized.contains("10061")
        || normalized.contains("actively refused")
        || normalized.contains("connection refused")
    {
        return format!(
            "{} is not accepting connections at {}:{} right now. Start the local {} service or check the host/port, then try again.",
            engine_label, host, port, engine_label
        );
    }

    if normalized.contains("authentication")
        || normalized.contains("password")
        || normalized.contains("access denied")
    {
        return format!(
            "Authentication to the local {} admin database failed. Please verify the admin username and password.",
            engine_label
        );
    }

    format!(
        "Could not connect to the local {} admin database at {}:{}. Please verify the local server and credentials.",
        engine_label, host, port
    )
}

pub(super) fn format_local_bootstrap_error(engine_label: &str, stage: &str) -> String {
    format!(
        "{} local bootstrap failed while {}. Please review the local server state, permissions, and SQL bootstrap inputs.",
        engine_label, stage
    )
}

pub(super) fn format_connection_lookup_error(error: impl std::fmt::Display) -> String {
    let normalized = error.to_string().to_ascii_lowercase();
    if normalized.contains("not found") || normalized.contains("connect first") {
        "The selected connection is not active. Please reconnect and try again.".to_string()
    } else {
        "The requested connection is not available right now. Please reconnect and try again."
            .to_string()
    }
}

pub(super) fn format_disconnect_runtime_error(error: impl std::fmt::Display) -> String {
    let normalized = error.to_string().to_ascii_lowercase();
    if normalized.contains("not found") || normalized.contains("connect first") {
        "The selected connection is already disconnected.".to_string()
    } else {
        "Disconnect failed. Please try again.".to_string()
    }
}

pub(super) fn format_database_listing_error(error: impl std::fmt::Display) -> String {
    let normalized = error.to_string().to_ascii_lowercase();
    if normalized.contains("permission") || normalized.contains("access denied") {
        "The current connection does not have permission to list databases.".to_string()
    } else {
        "Failed to load databases from the current connection.".to_string()
    }
}

pub(super) fn format_database_switch_error(error: impl std::fmt::Display) -> String {
    let normalized = error.to_string().to_ascii_lowercase();
    if normalized.contains("not found") || normalized.contains("unknown database") {
        "The requested database could not be found. Please verify the database name.".to_string()
    } else {
        "Failed to switch databases. Please verify the target database and try again.".to_string()
    }
}

pub(super) fn is_local_host(host: &str) -> bool {
    matches!(
        host.trim().to_ascii_lowercase().as_str(),
        "127.0.0.1" | "localhost" | "::1" | "[::1]"
    )
}

pub(super) fn sanitize_sqlite_file_stem(name: &str) -> String {
    let mut sanitized = String::with_capacity(name.len());
    let mut previous_was_separator = false;

    for ch in name.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            sanitized.push(ch.to_ascii_lowercase());
            previous_was_separator = false;
        } else if matches!(ch, ' ' | '-' | '_' | '.') && !previous_was_separator {
            sanitized.push('-');
            previous_was_separator = true;
        }
    }

    let sanitized = sanitized.trim_matches('-');
    if sanitized.is_empty() {
        "local-database".to_string()
    } else {
        sanitized.to_string()
    }
}

pub(super) fn default_sqlite_database_path(database_name: &str) -> Result<PathBuf, String> {
    let base_dir = dirs::data_local_dir()
        .or_else(dirs::data_dir)
        .ok_or_else(|| {
            "Could not locate a local application data directory for SQLite.".to_string()
        })?;

    Ok(base_dir.join("TableR").join("databases").join(format!(
        "{}.sqlite",
        sanitize_sqlite_file_stem(database_name)
    )))
}

pub(super) async fn create_local_sqlite_database(
    config: &ConnectionConfig,
    database_name: &str,
    bootstrap_statements: &[String],
) -> Result<String, String> {
    let resolved_file_path = config
        .file_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| {
            default_sqlite_database_path(database_name)
                .map(|path| path.to_string_lossy().to_string())
                .unwrap_or_else(|_| "local-database.sqlite".to_string())
        });

    let existed_before =
        if resolved_file_path == ":memory:" || resolved_file_path.starts_with("sqlite:") {
            false
        } else {
            PathBuf::from(&resolved_file_path).exists()
        };

    let driver = SqliteDriver::connect(&resolved_file_path)
        .await
        .map_err(|_| format_local_bootstrap_error("SQLite", "opening the database file"))?;

    for statement in bootstrap_statements {
        driver
            .execute_query(statement)
            .await
            .map_err(|_| format_local_bootstrap_error("SQLite", "applying bootstrap SQL"))?;
    }

    driver.disconnect().await.map_err(|_| {
        "SQLite local bootstrap finished, but the database file did not close cleanly.".to_string()
    })?;

    Ok(if existed_before {
        if bootstrap_statements.is_empty() {
            format!("SQLite database file is ready at {}.", resolved_file_path)
        } else {
            format!(
                "SQLite database file already existed at {}. Bootstrap SQL was applied successfully.",
                resolved_file_path
            )
        }
    } else if bootstrap_statements.is_empty() {
        format!("Created local SQLite database at {}.", resolved_file_path)
    } else {
        format!(
            "Created local SQLite database at {} and applied bootstrap SQL.",
            resolved_file_path
        )
    })
}

pub(super) async fn create_local_postgres_database(
    config: &ConnectionConfig,
    database_name: &str,
    bootstrap_statements: &[String],
) -> Result<String, String> {
    let host = config
        .host
        .as_deref()
        .ok_or_else(|| "Host is required for PostgreSQL".to_string())?;
    let port = config.port.unwrap_or_else(|| config.default_port());
    let user = config
        .username
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Username is required for PostgreSQL local bootstrap.".to_string())?;

    let mut options = PgConnectOptions::new()
        .host(host)
        .port(port)
        .username(user)
        .password(config.password.as_deref().unwrap_or(""))
        .database("postgres");

    options = options.ssl_mode(if config.use_ssl {
        PgSslMode::Require
    } else {
        PgSslMode::Prefer
    });
    options = options.disable_statement_logging();

    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(CONNECTION_TIMEOUT)
        .connect_with(options)
        .await
        .map_err(|e| format_local_admin_connection_error("PostgreSQL", host, port, e))?;

    let exists = sqlx::query("SELECT 1 FROM pg_database WHERE datname = $1 LIMIT 1")
        .bind(database_name)
        .fetch_optional(&pool)
        .await
        .map_err(|_| {
            format_local_bootstrap_error(
                "PostgreSQL",
                "checking whether the database already exists",
            )
        })?
        .is_some();

    if !exists {
        let sql = format!(
            "CREATE DATABASE {}",
            quote_postgres_identifier(database_name).map_err(|e| e.to_string())?
        );
        pool.execute(sql.as_str())
            .await
            .map_err(|_| format_local_bootstrap_error("PostgreSQL", "creating the new database"))?;
    }
    pool.close().await;

    if !bootstrap_statements.is_empty() {
        let mut bootstrap_options = PgConnectOptions::new()
            .host(host)
            .port(port)
            .username(user)
            .password(config.password.as_deref().unwrap_or(""))
            .database(database_name);

        bootstrap_options = bootstrap_options.ssl_mode(if config.use_ssl {
            PgSslMode::Require
        } else {
            PgSslMode::Prefer
        });
        bootstrap_options = bootstrap_options.disable_statement_logging();

        let bootstrap_pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(CONNECTION_TIMEOUT)
            .connect_with(bootstrap_options)
            .await
            .map_err(|_| {
                format_local_bootstrap_error("PostgreSQL", "opening the new database for bootstrap")
            })?;

        let mut tx = bootstrap_pool.begin().await.map_err(|_| {
            format_local_bootstrap_error("PostgreSQL", "starting the bootstrap transaction")
        })?;

        for statement in bootstrap_statements {
            tx.execute(statement.as_str()).await.map_err(|_| {
                format_local_bootstrap_error("PostgreSQL", "applying bootstrap SQL")
            })?;
        }

        tx.commit()
            .await
            .map_err(|_| format_local_bootstrap_error("PostgreSQL", "committing bootstrap SQL"))?;
        bootstrap_pool.close().await;
    }

    Ok(if exists {
        if bootstrap_statements.is_empty() {
            format!("Database \"{database_name}\" already exists and is ready to use.")
        } else {
            format!(
                "Database \"{database_name}\" already existed. Bootstrap SQL was applied successfully."
            )
        }
    } else if bootstrap_statements.is_empty() {
        format!("Created local PostgreSQL database \"{database_name}\". You can connect to it now.")
    } else {
        format!("Created local PostgreSQL database \"{database_name}\" and applied bootstrap SQL.")
    })
}

pub(super) async fn create_local_mysql_database(
    config: &ConnectionConfig,
    database_name: &str,
    bootstrap_statements: &[String],
) -> Result<String, String> {
    let host = config
        .host
        .as_deref()
        .ok_or_else(|| "Host is required for MySQL/MariaDB".to_string())?;
    let port = config.port.unwrap_or_else(|| config.default_port());
    let user = config
        .username
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Username is required for MySQL local bootstrap.".to_string())?;

    let mut options = MySqlConnectOptions::new()
        .host(host)
        .port(port)
        .username(user)
        .password(config.password.as_deref().unwrap_or(""))
        .database("mysql");

    options = options.ssl_mode(if config.use_ssl {
        MySqlSslMode::Required
    } else {
        MySqlSslMode::Preferred
    });
    options = options.disable_statement_logging();

    let mut admin_connection = MySqlConnection::connect_with(&options)
        .await
        .map_err(|e| format_local_admin_connection_error("MySQL", host, port, e))?;

    let exists = sqlx::query(
        "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ? LIMIT 1",
    )
    .bind(database_name)
    .fetch_optional(&mut admin_connection)
    .await
    .map_err(|_| {
        format_local_bootstrap_error("MySQL", "checking whether the database already exists")
    })?
    .is_some();

    if !exists {
        let sql = format!(
            "CREATE DATABASE {}",
            quote_mysql_identifier(database_name).map_err(|e| e.to_string())?
        );
        admin_connection
            .execute(sql.as_str())
            .await
            .map_err(|_| format_local_bootstrap_error("MySQL", "creating the new database"))?;
    }
    admin_connection.close().await.map_err(|_| {
        "MySQL local bootstrap finished, but the admin connection did not close cleanly."
            .to_string()
    })?;

    if !bootstrap_statements.is_empty() {
        let mut bootstrap_options = MySqlConnectOptions::new()
            .host(host)
            .port(port)
            .username(user)
            .password(config.password.as_deref().unwrap_or(""))
            .database(database_name);

        bootstrap_options = bootstrap_options.ssl_mode(if config.use_ssl {
            MySqlSslMode::Required
        } else {
            MySqlSslMode::Preferred
        });
        bootstrap_options = bootstrap_options.disable_statement_logging();

        let mut bootstrap_connection = MySqlConnection::connect_with(&bootstrap_options)
            .await
            .map_err(|_| {
                format_local_bootstrap_error("MySQL", "opening the new database for bootstrap")
            })?;

        let mut tx = bootstrap_connection.begin().await.map_err(|_| {
            format_local_bootstrap_error("MySQL", "starting the bootstrap transaction")
        })?;

        for statement in bootstrap_statements {
            tx.execute(statement.as_str())
                .await
                .map_err(|_| format_local_bootstrap_error("MySQL", "applying bootstrap SQL"))?;
        }

        tx.commit()
            .await
            .map_err(|_| format_local_bootstrap_error("MySQL", "committing bootstrap SQL"))?;
        bootstrap_connection
            .close()
            .await
            .map_err(|_| "MySQL local bootstrap finished, but the bootstrap connection did not close cleanly.".to_string())?;
    }

    Ok(if exists {
        if bootstrap_statements.is_empty() {
            format!("Database `{database_name}` already exists and is ready to use.")
        } else {
            format!("Database `{database_name}` already existed. Bootstrap SQL was applied successfully.")
        }
    } else if bootstrap_statements.is_empty() {
        format!("Created local MySQL database `{database_name}`. You can connect to it now.")
    } else {
        format!("Created local MySQL database `{database_name}` and applied bootstrap SQL.")
    })
}
