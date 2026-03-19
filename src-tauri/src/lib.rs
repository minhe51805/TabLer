mod commands;
mod database;
mod storage;
mod utils;

use commands::connection::*;
use commands::query::*;
use commands::table::*;
use commands::ai::{ask_ai, get_ai_configs, save_ai_configs};
use database::manager::DatabaseManager;
use storage::connection_storage::ConnectionStorage;
use storage::ai_storage::AIStorage;
use utils::rate_limiter::{AIRequestLimiter, ConnectionAttemptLimiter};
use std::time::Duration;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let db_manager = DatabaseManager::new();
    let conn_storage = match ConnectionStorage::new() {
        Ok(storage) => storage,
        Err(error) => {
            eprintln!("Failed to initialize connection storage: {error}");
            return;
        }
    };
    let ai_storage = match AIStorage::new() {
        Ok(storage) => storage,
        Err(error) => {
            eprintln!("Failed to initialize AI storage: {error}");
            return;
        }
    };
    let connection_rate_limiter = ConnectionAttemptLimiter::new(
        Duration::from_secs(60),
        8,
        "Too many connection attempts in a short time. Please wait about a minute and try again.",
    );
    let ai_rate_limiter = AIRequestLimiter::new(
        Duration::from_secs(60),
        24,
        "Too many AI requests in a short time. Please wait a moment and try again.",
    );

    let app = tauri::Builder::default()
        .manage(db_manager)
        .manage(conn_storage)
        .manage(ai_storage)
        .manage(connection_rate_limiter)
        .manage(ai_rate_limiter)
        .setup(|app| {
            #[cfg(target_os = "windows")]
            {
                if let Err(error) = app.hide_menu() {
                    eprintln!("Failed to hide native window menu: {error}");
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Connection commands
            connect_database,
            disconnect_database,
            test_connection,
            list_databases,
            use_database,
            create_local_database,
            suggest_sqlite_database_path,
            pick_sqlite_database_path,
            get_saved_connections,
            connect_saved_connection,
            delete_saved_connection,
            check_connection_status,
            parse_connection_url,
            parse_url_details,
            // Query commands
            execute_query,
            execute_sandboxed_query,
            // Table commands
            list_tables,
            list_schema_objects,
            get_table_structure,
            get_table_columns_preview,
            get_table_data,
            count_table_rows,
            count_table_null_values,
            update_table_cell,
            delete_table_rows,
            execute_structure_statements,
            // AI commands
            ask_ai,
            get_ai_configs,
            save_ai_configs,
        ]);

    if let Err(error) = app.run(tauri::generate_context!()) {
        eprintln!("error while running tauri application: {error}");
    }
}
