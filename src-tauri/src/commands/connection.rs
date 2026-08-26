use super::connection_support::*;
use crate::database::capabilities::DriverCapabilityProfile;
use crate::database::manager::DatabaseManager;
use crate::database::models::{ConnectionConfig, DatabaseInfo, DatabaseType, ParsedConnectionUrl};
use crate::storage::connection_storage::ConnectionStorage;
use crate::utils::rate_limiter::ConnectionAttemptLimiter;
use rfd::FileDialog;
use std::collections::HashMap;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::Mutex;
use tokio::time::{timeout, Duration};
use tokio_util::sync::CancellationToken;

pub(super) const CONNECTION_TIMEOUT: Duration = Duration::from_secs(45);
pub(super) const DISCONNECT_TIMEOUT: Duration = Duration::from_secs(15);
pub(super) const USE_DATABASE_TIMEOUT: Duration = Duration::from_secs(15);
pub(super) const BOOTSTRAP_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Default)]
pub struct ConnectionAttemptCancellationState {
    active: Mutex<HashMap<String, CancellationToken>>,
}

impl ConnectionAttemptCancellationState {
    async fn register(&self, request_id: &str, token: CancellationToken) {
        if let Some(previous) = self
            .active
            .lock()
            .await
            .insert(request_id.to_string(), token)
        {
            previous.cancel();
        }
    }

    async fn finish(&self, request_id: &str) {
        self.active.lock().await.remove(request_id);
    }

    async fn cancel(&self, request_id: &str) -> bool {
        let token = self.active.lock().await.get(request_id).cloned();
        if let Some(token) = token {
            token.cancel();
            true
        } else {
            false
        }
    }
}

#[tauri::command]
pub async fn cancel_connection_attempt(
    request_id: String,
    cancellation_state: State<'_, ConnectionAttemptCancellationState>,
) -> Result<bool, String> {
    let request_id = request_id.trim();
    if request_id.is_empty() {
        return Err("Request ID cannot be empty.".to_string());
    }
    Ok(cancellation_state.cancel(request_id).await)
}

#[tauri::command]
pub async fn get_connection_capabilities(
    connection_id: String,
    db_manager: State<'_, DatabaseManager>,
) -> Result<DriverCapabilityProfile, String> {
    db_manager
        .get_connection_capabilities(&connection_id)
        .await
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod connection_diagnostic_tests {
    use super::{
        classify_connection_failure, ConnectionAttemptCancellationState, ConnectionFailureStage,
    };
    use crate::database::models::ConnectionConfig;
    use tokio_util::sync::CancellationToken;

    #[test]
    fn diagnostics_distinguish_connection_failure_stages() {
        let config = ConnectionConfig::default();
        let fixtures = [
            ("dns: no such host", ConnectionFailureStage::Dns),
            ("connection refused", ConnectionFailureStage::Tcp),
            ("certificate verify failed", ConnectionFailureStage::Tls),
            (
                "password authentication failed",
                ConnectionFailureStage::Authentication,
            ),
            (
                "database does not exist",
                ConnectionFailureStage::DatabaseSelection,
            ),
            ("operation timed out", ConnectionFailureStage::Timeout),
        ];
        for (error, expected) in fixtures {
            assert_eq!(classify_connection_failure(&config, error), expected);
        }
    }

    #[tokio::test]
    async fn connection_cancellation_replaces_and_cleans_up_requests() {
        let state = ConnectionAttemptCancellationState::default();
        let first = CancellationToken::new();
        let second = CancellationToken::new();
        state.register("connect-1", first.clone()).await;
        state.register("connect-1", second.clone()).await;
        assert!(first.is_cancelled());
        assert!(state.cancel("connect-1").await);
        assert!(second.is_cancelled());
        state.finish("connect-1").await;
        assert!(!state.cancel("connect-1").await);
    }
}

#[tauri::command]
pub async fn connect_database(
    mut config: ConnectionConfig,
    request_id: Option<String>,
    db_manager: State<'_, DatabaseManager>,
    conn_storage: State<'_, ConnectionStorage>,
    connection_rate_limiter: State<'_, ConnectionAttemptLimiter>,
    cancellation_state: State<'_, ConnectionAttemptCancellationState>,
) -> Result<String, String> {
    config.resolve_env_vars();
    config.fill_generated_name();
    // Validate connection config before attempting to connect
    config
        .validate()
        .map_err(|e| format!("Invalid connection config: {}", e))?;
    connection_rate_limiter
        .check(&connection_rate_limit_key(&config))
        .await?;

    let request_id = request_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let token = CancellationToken::new();
    if let Some(request_id) = request_id.as_deref() {
        cancellation_state.register(request_id, token.clone()).await;
    }
    let connect_result = tokio::select! {
        _ = token.cancelled() => Err("Connection attempt cancelled.".to_string()),
        result = timeout(CONNECTION_TIMEOUT, db_manager.connect(&config)) => result
            .map_err(|_| "Connection attempt timed out after 45 seconds.".to_string())
            .and_then(|result| result.map_err(|error| format_connection_runtime_error(&config, error))),
    };
    if let Some(request_id) = request_id.as_deref() {
        cancellation_state.finish(request_id).await;
    }
    connect_result?;

    let storage = conn_storage.inner().clone();
    let config_to_save = config.clone();

    if let Err(_error) = run_blocking_storage_task(move || {
        storage
            .save_connection(&config_to_save)
            .map_err(|e| e.to_string())
    })
    .await
    {
        let disconnect_message =
            match timeout(DISCONNECT_TIMEOUT, db_manager.disconnect(&config.id)).await {
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
    request_id: Option<String>,
    connection_rate_limiter: State<'_, ConnectionAttemptLimiter>,
    cancellation_state: State<'_, ConnectionAttemptCancellationState>,
) -> Result<String, String> {
    config.resolve_env_vars();
    config.fill_generated_name();
    // Validate connection config before testing
    config
        .validate()
        .map_err(|e| format!("Invalid connection config: {}", e))?;
    connection_rate_limiter
        .check(&format!("test|{}", connection_rate_limit_key(&config)))
        .await?;

    let temp_manager = DatabaseManager::new();
    let request_id = request_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let token = CancellationToken::new();
    if let Some(request_id) = request_id.as_deref() {
        cancellation_state.register(request_id, token.clone()).await;
    }
    let test_result = tokio::select! {
        _ = token.cancelled() => Err("Connection test cancelled.".to_string()),
        result = timeout(CONNECTION_TIMEOUT, temp_manager.connect(&config)) => result
            .map_err(|_| "Connection test timed out after 45 seconds.".to_string())
            .and_then(|result| result.map_err(|error| format_connection_runtime_error(&config, error))),
    };
    if let Some(request_id) = request_id.as_deref() {
        cancellation_state.finish(request_id).await;
    }
    test_result?;
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
    config.resolve_env_vars();
    config.fill_generated_name();
    config
        .validate()
        .map_err(|e| format!("Invalid connection config: {e}"))?;
    connection_rate_limiter
        .check(&format!("bootstrap|{}", connection_rate_limit_key(&config)))
        .await?;

    let requested_database = database_name.trim();
    if requested_database.is_empty() {
        return Err("Database name cannot be empty.".to_string());
    }

    let bootstrap_statements = bootstrap_statements.unwrap_or_default();

    if config.db_type == DatabaseType::SQLite {
        return timeout(
            BOOTSTRAP_TIMEOUT,
            create_local_sqlite_database(&config, requested_database, &bootstrap_statements),
        )
        .await
        .map_err(|_| "Local SQLite bootstrap timed out after 60 seconds.".to_string())?;
    }

    let host = config
        .host
        .as_deref()
        .ok_or_else(|| "Host is required for local database creation.".to_string())?;

    if !is_local_host(host) {
        return Err(
            "Local database creation is only enabled for localhost or 127.0.0.1.".to_string(),
        );
    }

    match config.db_type {
        DatabaseType::PostgreSQL => timeout(
            BOOTSTRAP_TIMEOUT,
            create_local_postgres_database(&config, requested_database, &bootstrap_statements),
        )
        .await
        .map_err(|_| "Local PostgreSQL bootstrap timed out after 60 seconds.".to_string())?,
        DatabaseType::MySQL | DatabaseType::MariaDB => timeout(
            BOOTSTRAP_TIMEOUT,
            create_local_mysql_database(&config, requested_database, &bootstrap_statements),
        )
        .await
        .map_err(|_| "Local MySQL bootstrap timed out after 60 seconds.".to_string())?,
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
        .ok_or_else(|| {
            "Could not locate a starting directory for the SQLite save dialog.".to_string()
        })?;

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
    request_id: Option<String>,
    db_manager: State<'_, DatabaseManager>,
    conn_storage: State<'_, ConnectionStorage>,
    connection_rate_limiter: State<'_, ConnectionAttemptLimiter>,
    cancellation_state: State<'_, ConnectionAttemptCancellationState>,
) -> Result<String, String> {
    let storage = conn_storage.inner().clone();
    let requested_connection_id = connection_id.clone();
    let mut config = run_blocking_storage_task(move || {
        storage
            .load_connection_by_id(&requested_connection_id)
            .map_err(|_| "Failed to load the saved connection profile.".to_string())
    })
    .await?;
    config.resolve_env_vars();
    connection_rate_limiter
        .check(&format!("saved|{}", connection_rate_limit_key(&config)))
        .await?;

    let request_id = request_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let token = CancellationToken::new();
    if let Some(request_id) = request_id.as_deref() {
        cancellation_state.register(request_id, token.clone()).await;
    }
    let connect_result = tokio::select! {
        _ = token.cancelled() => Err("Connection attempt cancelled.".to_string()),
        result = timeout(CONNECTION_TIMEOUT, db_manager.connect(&config)) => result
            .map_err(|_| "Connection attempt timed out after 45 seconds.".to_string())
            .and_then(|result| result.map_err(|e| format_connection_runtime_error(&config, e))),
    };
    if let Some(request_id) = request_id.as_deref() {
        cancellation_state.finish(request_id).await;
    }
    connect_result?;

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
/// Supports: postgresql://, postgres://, cockroachdb://, greenplum://, redshift://, mysql://, mariadb://, sqlite://, redis://, rediss://, mongodb://, mongodb+srv://
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
