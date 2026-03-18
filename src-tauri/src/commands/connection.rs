use crate::database::manager::DatabaseManager;
use crate::database::models::{ConnectionConfig, DatabaseInfo, DatabaseType, ParsedConnectionUrl};
use crate::database::safety::{quote_mysql_identifier, quote_postgres_identifier};
use crate::storage::connection_storage::ConnectionStorage;
use rfd::FileDialog;
use sqlx::postgres::{PgConnectOptions, PgSslMode};
use sqlx::mysql::{MySqlConnectOptions, MySqlConnection, MySqlSslMode};
use sqlx::{ConnectOptions, Connection, Executor};
use std::path::PathBuf;
use tauri::State;
use tokio::time::{timeout, Duration};

const CONNECTION_TIMEOUT: Duration = Duration::from_secs(45);
const DISCONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const USE_DATABASE_TIMEOUT: Duration = Duration::from_secs(15);
const BOOTSTRAP_TIMEOUT: Duration = Duration::from_secs(60);

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

    format!(
        "Could not connect to local {} admin database at {}:{}: {}",
        engine_label, host, port, raw_error
    )
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
    let user = config.username.as_deref().unwrap_or("postgres");

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
        .map_err(|e| format!("Could not connect to local PostgreSQL admin database: {e}"))?;

    let exists = sqlx::query("SELECT 1 FROM pg_database WHERE datname = $1 LIMIT 1")
        .bind(database_name)
        .fetch_optional(&pool)
        .await
        .map_err(|e| format!("Could not check existing PostgreSQL databases: {e}"))?
        .is_some();

    if !exists {
        let sql = format!(
            "CREATE DATABASE {}",
            quote_postgres_identifier(database_name).map_err(|e| e.to_string())?
        );
        pool.execute(sql.as_str())
            .await
            .map_err(|e| format!("Failed to create PostgreSQL database: {e}"))?;
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
            .map_err(|e| format!("Could not open the new PostgreSQL database for bootstrap: {e}"))?;

        let mut tx = bootstrap_pool
            .begin()
            .await
            .map_err(|e| format!("Could not start PostgreSQL bootstrap transaction: {e}"))?;

        for statement in bootstrap_statements {
            tx.execute(statement.as_str())
                .await
                .map_err(|e| format!("Failed to apply PostgreSQL bootstrap SQL: {e}"))?;
        }

        tx.commit()
            .await
            .map_err(|e| format!("Could not commit PostgreSQL bootstrap SQL: {e}"))?;
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
    let user = config.username.as_deref().unwrap_or("root");

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
    .map_err(|e| format!("Could not check existing MySQL databases: {e}"))?
    .is_some();

    if !exists {
        let sql = format!(
            "CREATE DATABASE {}",
            quote_mysql_identifier(database_name).map_err(|e| e.to_string())?
        );
        admin_connection
            .execute(sql.as_str())
            .await
            .map_err(|e| format!("Failed to create MySQL database: {e}"))?;
    }
    admin_connection
        .close()
        .await
        .map_err(|e| format!("Could not close local MySQL admin connection cleanly: {e}"))?;

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
            .map_err(|e| format!("Could not open the new MySQL database for bootstrap: {e}"))?;

        let mut tx = bootstrap_connection
            .begin()
            .await
            .map_err(|e| format!("Could not start MySQL bootstrap transaction: {e}"))?;

        for statement in bootstrap_statements {
            tx.execute(statement.as_str())
                .await
                .map_err(|e| format!("Failed to apply MySQL bootstrap SQL: {e}"))?;
        }

        tx.commit()
            .await
            .map_err(|e| format!("Could not commit MySQL bootstrap SQL: {e}"))?;
        bootstrap_connection
            .close()
            .await
            .map_err(|e| format!("Could not close MySQL bootstrap connection cleanly: {e}"))?;
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
) -> Result<String, String> {
    config.fill_generated_name();
    // Validate connection config before attempting to connect
    config.validate().map_err(|e| format!("Invalid connection config: {}", e))?;

    timeout(CONNECTION_TIMEOUT, db_manager.connect(&config))
        .await
        .map_err(|_| "Connection attempt timed out after 45 seconds.".to_string())?
        .map_err(|e| format!("Connection failed: {}", e))?;

    // Save connection (without password) to storage
    if let Err(error) = conn_storage.save_connection(&config) {
        let disconnect_message = match timeout(DISCONNECT_TIMEOUT, db_manager.disconnect(&config.id)).await {
            Ok(Ok(())) => String::new(),
            Ok(Err(disconnect_error)) => format!(" Cleanup failed: {}", disconnect_error),
            Err(_) => " Cleanup timed out.".to_string(),
        };

        return Err(format!(
            "Failed to save connection: {}. The live connection was rolled back.{}",
            error, disconnect_message
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
        .map_err(|e| format!("Disconnect failed: {}", e))
}

#[tauri::command]
pub async fn test_connection(mut config: ConnectionConfig) -> Result<String, String> {
    config.fill_generated_name();
    // Validate connection config before testing
    config.validate().map_err(|e| format!("Invalid connection config: {}", e))?;

    let temp_manager = DatabaseManager::new();
    timeout(CONNECTION_TIMEOUT, temp_manager.connect(&config))
        .await
        .map_err(|_| "Connection test timed out after 45 seconds.".to_string())?
        .map_err(|e| format!("Connection test failed: {}", e))?;
    timeout(DISCONNECT_TIMEOUT, temp_manager.disconnect(&config.id))
        .await
        .map_err(|_| "Connection test cleanup timed out after 15 seconds.".to_string())?
        .map_err(|e| format!("Cleanup failed: {}", e))?;
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
        .map_err(|e| e.to_string())?;
    driver.list_databases().await.map_err(|e| e.to_string())
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
        .map_err(|e| e.to_string())?;
    timeout(USE_DATABASE_TIMEOUT, driver.use_database(&database))
        .await
        .map_err(|_| "Switching database timed out after 15 seconds.".to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_local_database(
    mut config: ConnectionConfig,
    database_name: String,
    bootstrap_statements: Option<Vec<String>>,
) -> Result<String, String> {
    config.fill_generated_name();
    config
        .validate()
        .map_err(|e| format!("Invalid connection config: {e}"))?;

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
        .add_filter("SQLite database", &["sqlite", "sqlite3", "db"])
        .save_file();

    Ok(selected.map(|path| path.to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn get_saved_connections(
    conn_storage: State<'_, ConnectionStorage>,
) -> Result<Vec<ConnectionConfig>, String> {
    conn_storage
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
        .map_err(|e| format!("Failed to load connections: {}", e))
}

#[tauri::command]
pub async fn connect_saved_connection(
    connection_id: String,
    db_manager: State<'_, DatabaseManager>,
    conn_storage: State<'_, ConnectionStorage>,
) -> Result<String, String> {
    let config = conn_storage
        .load_connection_by_id(&connection_id)
        .map_err(|e| format!("Failed to load saved connection: {}", e))?;

    timeout(CONNECTION_TIMEOUT, db_manager.connect(&config))
        .await
        .map_err(|_| "Connection attempt timed out after 45 seconds.".to_string())?
        .map_err(|e| format!("Connection failed: {}", e))?;

    Ok(config.id)
}

#[tauri::command]
pub async fn delete_saved_connection(
    connection_id: String,
    conn_storage: State<'_, ConnectionStorage>,
) -> Result<(), String> {
    conn_storage
        .delete_connection(&connection_id)
        .map_err(|e| format!("Failed to delete connection: {}", e))
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
