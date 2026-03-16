mod commands;
mod database;
mod storage;

use commands::connection::*;
use commands::query::*;
use commands::system::{
    open_system_terminal,
    send_terminal_input,
    start_terminal_session,
    stop_terminal_session,
};
use commands::table::*;
use commands::ai::{ask_ai, get_ai_configs, save_ai_configs};
use database::manager::DatabaseManager;
use storage::connection_storage::ConnectionStorage;
use storage::ai_storage::AIStorage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let db_manager = DatabaseManager::new();
    let conn_storage = ConnectionStorage::new().expect("Failed to initialize connection storage");
    let ai_storage = AIStorage::new().expect("Failed to initialize AI storage");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(db_manager)
        .manage(conn_storage)
        .manage(ai_storage)
        .invoke_handler(tauri::generate_handler![
            // Connection commands
            connect_database,
            disconnect_database,
            test_connection,
            list_databases,
            use_database,
            get_saved_connections,
            delete_saved_connection,
            check_connection_status,
            parse_connection_url,
            parse_url_details,
            // Query commands
            execute_query,
            execute_sandboxed_query,
            // Table commands
            list_tables,
            get_table_structure,
            get_table_data,
            count_table_rows,
            // System commands
            open_system_terminal,
            start_terminal_session,
            send_terminal_input,
            stop_terminal_session,
            // AI commands
            ask_ai,
            get_ai_configs,
            save_ai_configs,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
