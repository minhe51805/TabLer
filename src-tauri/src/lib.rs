mod commands;
mod database;
mod storage;

use commands::connection::*;
use commands::query::*;
use commands::system::{
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

    let app = tauri::Builder::default()
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
            get_table_data,
            count_table_rows,
            update_table_cell,
            delete_table_rows,
            // System commands
            start_terminal_session,
            send_terminal_input,
            stop_terminal_session,
            // AI commands
            ask_ai,
            get_ai_configs,
            save_ai_configs,
        ]);

    if let Err(error) = app.run(tauri::generate_context!()) {
        eprintln!("error while running tauri application: {error}");
    }
}
