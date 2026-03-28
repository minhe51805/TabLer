use crate::database::manager::DatabaseManager;
use crate::database::models::{ConnectionConfig, DatabaseInfo, DatabaseType, ParsedConnectionUrl};
use crate::database::safety::{quote_mysql_identifier, quote_postgres_identifier};
use crate::storage::connection_storage::ConnectionStorage;
use crate::utils::rate_limiter::ConnectionAttemptLimiter;
use rfd::FileDialog;
use sqlx::postgres::{PgConnectOptions, PgSslMode};
use sqlx::mysql::{MySqlConnectOptions, MySqlConnection, MySqlSslMode};
use sqlx::{ConnectOptions, Connection, Executor};
use std::path::PathBuf;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;
use tokio::task;
use tokio::time::{timeout, Duration};

const CONNECTION_TIMEOUT: Duration = Duration::from_secs(45);
const DISCONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const USE_DATABASE_TIMEOUT: Duration = Duration::from_secs(15);
const BOOTSTRAP_TIMEOUT: Duration = Duration::from_secs(60);

async fn run_blocking_storage_task<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    task::spawn_blocking(operation)
        .await
        .map_err(|_| "Background storage task failed unexpectedly.".to_string())?
}

fn connection_rate_limit_key(config: &ConnectionConfig) -> String {
    let host = config.host.as_deref().unwrap_or("").trim().to_ascii_lowercase();
    let user = config.username.as_deref().unwrap_or("").trim().to_ascii_lowercase();
    let database = config.database.as_deref().unwrap_or("").trim().to_ascii_lowercase();
    format!("{:?}|{}|{}|{}", config.db_type, host, user, database)
}

fn connection_engine_label(db_type: DatabaseType) -> &'static str {
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
    }
}

fn format_connection_runtime_error(config: &ConnectionConfig, error: impl std::fmt::Display) -> String {
    let engine = connection_engine_label(config.db_type);
    let raw = error.to_string();
    let normalized = raw.to_ascii_lowercase();

    if normalized.contains("10061")
        || normalized.contains("actively refused")
        || normalized.contains("connection refused")
    {
        return format!(
            "Cannot reach the {} server. Please make sure the service is running and the host/port are correct.",
            engine
        );
    }

    if normalized.contains("authentication")
        || normalized.contains("password")
        || normalized.contains("access denied")
        || normalized.contains("auth failed")
    {
        return format!(
            "{} authentication failed. Please verify the username and password.",
            engine
        );
    }

    if normalized.contains("does not exist")
        || normalized.contains("unknown database")
        || normalized.contains("database")
            && (normalized.contains("not found") || normalized.contains("missing"))
    {
        return format!(
            "The requested {} database could not be found. Please verify the database name.",
            engine
        );
    }

    if normalized.contains("certificate")
        || normalized.contains("tls")
        || normalized.contains("ssl")
    {
        return format!(
            "{} TLS/SSL negotiation failed. Please verify the server certificate and SSL settings.",
            engine
        );
    }

    if normalized.contains("timed out") || normalized.contains("timeout") {
        return format!(
            "{} did not respond in time. Please verify the network path and try again.",
            engine
        );
    }

    format!(
        "Failed to connect to {}. Please verify the host, port, credentials, and database settings.",
        engine
    )
}

fn format_local_admin_connection_error(
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

fn format_local_bootstrap_error(engine_label: &str, stage: &str) -> String {
    format!(
        "{} local bootstrap failed while {}. Please review the local server state, permissions, and SQL bootstrap inputs.",
        engine_label, stage
    )
}

fn format_connection_lookup_error(error: impl std::fmt::Display) -> String {
    let normalized = error.to_string().to_ascii_lowercase();
    if normalized.contains("not found") || normalized.contains("connect first") {
        "The selected connection is not active. Please reconnect and try again.".to_string()
    } else {
        "The requested connection is not available right now. Please reconnect and try again.".to_string()
    }
}

fn format_disconnect_runtime_error(error: impl std::fmt::Display) -> String {
    let normalized = error.to_string().to_ascii_lowercase();
    if normalized.contains("not found") || normalized.contains("connect first") {
        "The selected connection is already disconnected.".to_string()
    } else {
        "Disconnect failed. Please try again.".to_string()
    }
}

fn format_database_listing_error(error: impl std::fmt::Display) -> String {
    let normalized = error.to_string().to_ascii_lowercase();
    if normalized.contains("permission") || normalized.contains("access denied") {
        "The current connection does not have permission to list databases.".to_string()
    } else {
        "Failed to load databases from the current connection.".to_string()
    }
}

fn format_database_switch_error(error: impl std::fmt::Display) -> String {
    let normalized = error.to_string().to_ascii_lowercase();
    if normalized.contains("not found") || normalized.contains("unknown database") {
        "The requested database could not be found. Please verify the database name.".to_string()
    } else {
        "Failed to switch databases. Please verify the target database and try again.".to_string()
    }
}

fn is_local_host(host: &str) -> bool {
    matches!(
        host.trim().to_ascii_lowercase().as_str(),
        "127.0.0.1" | "localhost" | "::1" | "[::1]"
    )
}

fn sanitize_sqlite_file_stem(name: &str) -> String {
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

fn default_sqlite_database_path(database_name: &str) -> Result<PathBuf, String> {
    let base_dir = dirs::data_local_dir()
        .or_else(dirs::data_dir)
        .ok_or_else(|| "Could not locate a local application data directory for SQLite.".to_string())?;

    Ok(base_dir
        .join("TableR")
        .join("databases")
        .join(format!("{}.sqlite", sanitize_sqlite_file_stem(database_name))))
}

async fn create_local_postgres_database(
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
        .map_err(|_| format_local_bootstrap_error("PostgreSQL", "checking whether the database already exists"))?
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
            .map_err(|_| format_local_bootstrap_error("PostgreSQL", "opening the new database for bootstrap"))?;

        let mut tx = bootstrap_pool
            .begin()
            .await
            .map_err(|_| format_local_bootstrap_error("PostgreSQL", "starting the bootstrap transaction"))?;

        for statement in bootstrap_statements {
            tx.execute(statement.as_str())
                .await
                .map_err(|_| format_local_bootstrap_error("PostgreSQL", "applying bootstrap SQL"))?;
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

async fn create_local_mysql_database(
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
    .map_err(|_| format_local_bootstrap_error("MySQL", "checking whether the database already exists"))?
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
    admin_connection
        .close()
        .await
        .map_err(|_| "MySQL local bootstrap finished, but the admin connection did not close cleanly.".to_string())?;

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
            .map_err(|_| format_local_bootstrap_error("MySQL", "opening the new database for bootstrap"))?;

        let mut tx = bootstrap_connection
            .begin()
            .await
            .map_err(|_| format_local_bootstrap_error("MySQL", "starting the bootstrap transaction"))?;

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

#[tauri::command]
pub async fn connect_database(
    mut config: ConnectionConfig,
    db_manager: State<'_, DatabaseManager>,
    conn_storage: State<'_, ConnectionStorage>,
    connection_rate_limiter: State<'_, ConnectionAttemptLimiter>,
) -> Result<String, String> {
    config.fill_generated_name();
    // Validate connection config before attempting to connect
    config.validate().map_err(|e| format!("Invalid connection config: {}", e))?;
    connection_rate_limiter.check(&connection_rate_limit_key(&config)).await?;

    timeout(CONNECTION_TIMEOUT, db_manager.connect(&config))
        .await
        .map_err(|_| "Connection attempt timed out after 45 seconds.".to_string())?
        .map_err(|e| format_connection_runtime_error(&config, e))?;

    let storage = conn_storage.inner().clone();
    let config_to_save = config.clone();

    if let Err(_error) = run_blocking_storage_task(move || {
        storage
            .save_connection(&config_to_save)
            .map_err(|e| e.to_string())
    })
    .await
    {
        let disconnect_message = match timeout(DISCONNECT_TIMEOUT, db_manager.disconnect(&config.id)).await {
            Ok(Ok(())) => String::new(),
            Ok(Err(_)) => " Cleanup failed while rolling back the live connection.".to_string(),
            Err(_) => " Cleanup timed out.".to_string(),
        };

        return Err(format!(
            "Failed to save the connection profile. The live connection was rolled back.{}",
            disconnect_message
        ));
    }

    Ok(config.id.clone())
}

#[tauri::command]
pub async fn disconnect_database(
    connection_id: String,
    db_manager: State<'_, DatabaseManager>,
) -> Result<(), String> {
    timeout(DISCONNECT_TIMEOUT, db_manager.disconnect(&connection_id))
        .await
        .map_err(|_| "Disconnect timed out after 15 seconds.".to_string())?
        .map_err(format_disconnect_runtime_error)
}

#[tauri::command]
pub async fn test_connection(
    mut config: ConnectionConfig,
    connection_rate_limiter: State<'_, ConnectionAttemptLimiter>,
) -> Result<String, String> {
    config.fill_generated_name();
    // Validate connection config before testing
    config.validate().map_err(|e| format!("Invalid connection config: {}", e))?;
    connection_rate_limiter.check(&format!("test|{}", connection_rate_limit_key(&config))).await?;

    let temp_manager = DatabaseManager::new();
    timeout(CONNECTION_TIMEOUT, temp_manager.connect(&config))
        .await
        .map_err(|_| "Connection test timed out after 45 seconds.".to_string())?
        .map_err(|e| format_connection_runtime_error(&config, e))?;
    timeout(DISCONNECT_TIMEOUT, temp_manager.disconnect(&config.id))
        .await
        .map_err(|_| "Connection test cleanup timed out after 15 seconds.".to_string())?
        .map_err(|_| "Connection test cleanup failed. Please try again.".to_string())?;
    Ok("Connection successful".to_string())
}

#[tauri::command]
pub async fn list_databases(
    connection_id: String,
    db_manager: State<'_, DatabaseManager>,
) -> Result<Vec<DatabaseInfo>, String> {
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(format_connection_lookup_error)?;
    driver
        .list_databases()
        .await
        .map_err(format_database_listing_error)
}

#[tauri::command]
pub async fn use_database(
    connection_id: String,
    database: String,
    db_manager: State<'_, DatabaseManager>,
) -> Result<(), String> {
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(format_connection_lookup_error)?;
    timeout(USE_DATABASE_TIMEOUT, driver.use_database(&database))
        .await
        .map_err(|_| "Switching database timed out after 15 seconds.".to_string())?
        .map_err(format_database_switch_error)
}

#[tauri::command]
pub async fn create_local_database(
    mut config: ConnectionConfig,
    database_name: String,
    bootstrap_statements: Option<Vec<String>>,
    connection_rate_limiter: State<'_, ConnectionAttemptLimiter>,
) -> Result<String, String> {
    config.fill_generated_name();
    config
        .validate()
        .map_err(|e| format!("Invalid connection config: {e}"))?;
    connection_rate_limiter.check(&format!("bootstrap|{}", connection_rate_limit_key(&config))).await?;

    let requested_database = database_name.trim();
    if requested_database.is_empty() {
        return Err("Database name cannot be empty.".to_string());
    }

    let host = config
        .host
        .as_deref()
        .ok_or_else(|| "Host is required for local database creation.".to_string())?;

    if !is_local_host(host) {
        return Err("Local database creation is only enabled for localhost or 127.0.0.1.".to_string());
    }

    let bootstrap_statements = bootstrap_statements.unwrap_or_default();

    match config.db_type {
        DatabaseType::PostgreSQL => timeout(
            BOOTSTRAP_TIMEOUT,
            create_local_postgres_database(&config, requested_database, &bootstrap_statements),
        )
        .await
        .map_err(|_| "Local PostgreSQL bootstrap timed out after 60 seconds.".to_string())?,
        DatabaseType::MySQL | DatabaseType::MariaDB => {
            timeout(
                BOOTSTRAP_TIMEOUT,
                create_local_mysql_database(&config, requested_database, &bootstrap_statements),
            )
            .await
            .map_err(|_| "Local MySQL bootstrap timed out after 60 seconds.".to_string())?
        }
        DatabaseType::SQLite => Ok(
            "SQLite already supports creating a new database from a fresh file path.".to_string(),
        ),
        _ => Err(format!(
            "{:?} local database bootstrap is not wired into this build yet.",
            config.db_type
        )),
    }
}

#[tauri::command]
pub async fn suggest_sqlite_database_path(database_name: String) -> Result<String, String> {
    let requested_name = database_name.trim();
    let path = default_sqlite_database_path(if requested_name.is_empty() {
        "local-database"
    } else {
        requested_name
    })?;

    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn pick_sqlite_database_path(database_name: String) -> Result<Option<String>, String> {
    let suggested_path = default_sqlite_database_path(&database_name)?;
    let file_name = suggested_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("local-database.sqlite");

    let directory = suggested_path
        .parent()
        .map(|value| value.to_path_buf())
        .or_else(dirs::document_dir)
        .or_else(dirs::home_dir)
        .ok_or_else(|| "Could not locate a starting directory for the SQLite save dialog.".to_string())?;

    let selected = FileDialog::new()
        .set_directory(directory)
        .set_file_name(file_name)
        .add_filter("SQLite database", &["sqlite", "sqlite3", "db", "db3"])
        .save_file();

    Ok(selected.map(|path| path.to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn get_saved_connections(
    conn_storage: State<'_, ConnectionStorage>,
) -> Result<Vec<ConnectionConfig>, String> {
    let storage = conn_storage.inner().clone();
    run_blocking_storage_task(move || {
        storage
            .load_connections()
            .map(|connections| {
                connections
                    .into_iter()
                    .map(|mut connection| {
                        connection.password = None;
                        connection
                    })
                    .collect()
            })
            .map_err(|_| "Failed to load saved connections.".to_string())
    })
    .await
}

#[tauri::command]
pub async fn connect_saved_connection(
    connection_id: String,
    db_manager: State<'_, DatabaseManager>,
    conn_storage: State<'_, ConnectionStorage>,
    connection_rate_limiter: State<'_, ConnectionAttemptLimiter>,
) -> Result<String, String> {
    let storage = conn_storage.inner().clone();
    let requested_connection_id = connection_id.clone();
    let config = run_blocking_storage_task(move || {
        storage
            .load_connection_by_id(&requested_connection_id)
            .map_err(|_| "Failed to load the saved connection profile.".to_string())
    })
    .await?;
    connection_rate_limiter.check(&format!("saved|{}", connection_rate_limit_key(&config))).await?;

    timeout(CONNECTION_TIMEOUT, db_manager.connect(&config))
        .await
        .map_err(|_| "Connection attempt timed out after 45 seconds.".to_string())?
        .map_err(|e| format_connection_runtime_error(&config, e))?;

    Ok(config.id)
}

#[tauri::command]
pub async fn delete_saved_connection(
    connection_id: String,
    conn_storage: State<'_, ConnectionStorage>,
) -> Result<(), String> {
    let storage = conn_storage.inner().clone();
    run_blocking_storage_task(move || {
        storage
            .delete_connection(&connection_id)
            .map_err(|_| "Failed to delete the saved connection.".to_string())
    })
    .await
}

#[tauri::command]
pub async fn check_connection_status(
    connection_id: String,
    db_manager: State<'_, DatabaseManager>,
) -> Result<bool, String> {
    Ok(db_manager.is_connected(&connection_id).await)
}

/// Parse a connection URL string into ConnectionConfig
/// Supports: postgresql://, postgres://, cockroachdb://, greenplum://, redshift://, mysql://, mariadb://, sqlite://
#[tauri::command]
pub fn parse_connection_url(url: String) -> Result<ConnectionConfig, String> {
    ConnectionConfig::from_url(&url, None)
}

/// Get parsed details from a connection URL without creating a config
#[tauri::command]
pub fn parse_url_details(url: String) -> Result<ParsedConnectionUrl, String> {
    ParsedConnectionUrl::parse(&url)
}

/// Get the Buy Me a Coffee support URL
#[tauri::command]
pub fn get_support_url() -> String {
    "https://buymeacoffee.com/minjev".to_string()
}

/// Open the Buy Me a Coffee page in the default browser
#[tauri::command]
pub fn open_support_page(app: AppHandle) -> Result<(), String> {
    let url = get_support_url();
    app.opener()
        .open_url(&url, None::<String>)
        .map_err(|e| format!("Failed to open support page: {}", e))
}
