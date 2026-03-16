use crate::database::manager::DatabaseManager;
use crate::database::models::{ConnectionConfig, DatabaseInfo, ParsedConnectionUrl};
use crate::storage::connection_storage::ConnectionStorage;
use tauri::State;

#[tauri::command]
pub async fn connect_database(
    config: ConnectionConfig,
    db_manager: State<'_, DatabaseManager>,
    conn_storage: State<'_, ConnectionStorage>,
) -> Result<String, String> {
    // Validate connection config before attempting to connect
    config.validate().map_err(|e| format!("Invalid connection config: {}", e))?;

    db_manager
        .connect(&config)
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;

    // Save connection (without password) to storage
    if let Err(error) = conn_storage.save_connection(&config) {
        let disconnect_message = db_manager
            .disconnect(&config.id)
            .await
            .err()
            .map(|disconnect_error| format!(" Cleanup failed: {}", disconnect_error))
            .unwrap_or_default();

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
    db_manager
        .disconnect(&connection_id)
        .await
        .map_err(|e| format!("Disconnect failed: {}", e))
}

#[tauri::command]
pub async fn test_connection(config: ConnectionConfig) -> Result<String, String> {
    // Validate connection config before testing
    config.validate().map_err(|e| format!("Invalid connection config: {}", e))?;

    let temp_manager = DatabaseManager::new();
    temp_manager
        .connect(&config)
        .await
        .map_err(|e| format!("Connection test failed: {}", e))?;
    temp_manager
        .disconnect(&config.id)
        .await
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
    driver
        .use_database(&database)
        .await
        .map_err(|e| e.to_string())
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

    db_manager
        .connect(&config)
        .await
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
