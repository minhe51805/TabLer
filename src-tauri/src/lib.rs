use tauri::{Manager, Emitter};
mod commands;
mod ai_workspace_history;
mod database;
mod query_history;
mod storage;
mod utils;

use ai_workspace_history::{get_ai_workspace_history, save_ai_workspace_history};
use commands::connection::*;
use commands::plugins::{
    install_plugin_bundle, list_installed_plugins, reload_installed_plugins,
    set_plugin_enabled, uninstall_plugin_bundle,
};
use commands::export::*;
use commands::file::*;
use commands::query::*;
use commands::table::*;
use commands::terminal::{close_terminal, open_terminal, resize_terminal, write_terminal, TerminalManager};
use commands::ai::{ask_ai, get_ai_configs, save_ai_configs};
use commands::window::{apply_window_profile, apply_window_profile_to_main, WindowProfile};
use commands::tabs::{save_tabs, load_tabs, delete_tabs};
use commands::deep_link::parse_deep_link;
use commands::update::{
    check_for_update, download_and_install_update, get_app_version,
};
use commands::connection_export::{
    export_connections_to_file, import_connections_from_file,
};
use database::manager::DatabaseManager;
use query_history::{
    clear_query_history, delete_query_history_entries, delete_query_history_entry,
    get_query_history, save_query_history,
};
use storage::connection_storage::ConnectionStorage;
use storage::plugin_storage::PluginStorage;
use storage::ai_storage::AIStorage;
use storage::tab_persistence::TabPersistence;
use storage::sql_favorites::{
    delete_sql_favorite, get_sql_favorites, save_sql_favorite,
};
use utils::rate_limiter::{AIRequestLimiter, ConnectionAttemptLimiter};
use std::time::Duration;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let start_time = std::time::Instant::now();
    eprintln!("[TableR] Application starting...");

    let db_manager = DatabaseManager::new();
    eprintln!("[TableR] DatabaseManager initialized: {:?}", start_time.elapsed());

    let conn_storage = match ConnectionStorage::new() {
        Ok(storage) => {
            eprintln!("[TableR] ConnectionStorage initialized: {:?}", start_time.elapsed());
            storage
        }
        Err(error) => {
            eprintln!("[TableR] FAILED to initialize connection storage: {error}");
            return;
        }
    };
    let ai_storage = match AIStorage::new() {
        Ok(storage) => {
            eprintln!("[TableR] AIStorage initialized: {:?}", start_time.elapsed());
            storage
        }
        Err(error) => {
            eprintln!("[TableR] FAILED to initialize AI storage: {error}");
            return;
        }
    };
    let plugin_storage = match PluginStorage::new() {
        Ok(storage) => {
            eprintln!("[TableR] PluginStorage initialized: {:?}", start_time.elapsed());
            storage
        }
        Err(error) => {
            eprintln!("[TableR] FAILED to initialize plugin storage: {error}");
            return;
        }
    };
    let tab_storage = match TabPersistence::new() {
        Ok(storage) => {
            eprintln!("[TableR] TabPersistence initialized: {:?}", start_time.elapsed());
            storage
        }
        Err(error) => {
            eprintln!("[TableR] FAILED to initialize tab persistence storage: {error}");
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
    let terminal_manager = TerminalManager::default();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(db_manager)
        .manage(conn_storage)
        .manage(plugin_storage)
        .manage(ai_storage)
        .manage(tab_storage)
        .manage(terminal_manager)
        .manage(connection_rate_limiter)
        .manage(ai_rate_limiter)
        .setup(|app| {
            #[cfg(target_os = "windows")]
            {
                if let Err(error) = app.hide_menu() {
                    eprintln!("Failed to hide native window menu: {error}");
                }
            }

            if let Err(error) = apply_window_profile_to_main(app.handle(), WindowProfile::Launcher) {
                eprintln!("Failed to apply launcher window profile: {error}");
            }

            // Register deep link handler
            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let app_handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        let url_str = url.to_string();
                        eprintln!("[DeepLink] Received: {}", url_str);
                        // Emit to frontend via event
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.emit("deep-link", url_str);
                        }
                    }
                });
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
            get_support_url,
            open_support_page,
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
            insert_table_row,
            execute_structure_statements,
            get_foreign_key_lookup_values,
            // AI commands
            ask_ai,
            get_ai_configs,
            save_ai_configs,
            // Query history commands
            save_query_history,
            get_query_history,
            delete_query_history_entry,
            delete_query_history_entries,
            clear_query_history,
            // AI workspace history commands
            get_ai_workspace_history,
            save_ai_workspace_history,
            // File commands
            read_sql_file,
            read_sql_file_from_path,
            pick_database_file,
            export_database,
            // Terminal commands
            open_terminal,
            write_terminal,
            resize_terminal,
            close_terminal,
            // SQL Favorites commands
            get_sql_favorites,
            save_sql_favorite,
            delete_sql_favorite,
            // Plugin commands
            list_installed_plugins,
            install_plugin_bundle,
            set_plugin_enabled,
            uninstall_plugin_bundle,
            reload_installed_plugins,
            // Window commands
            apply_window_profile,
            // Tab persistence commands
            save_tabs,
            load_tabs,
            delete_tabs,
            // Deep link commands
            parse_deep_link,
            // Connection export/import commands
            export_connections_to_file,
            import_connections_from_file,
            // Update commands
            check_for_update,
            download_and_install_update,
            get_app_version,
        ]);

    if let Err(error) = app.run(tauri::generate_context!()) {
        eprintln!("error while running tauri application: {error}");
    }
}
