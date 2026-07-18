use tauri::{Emitter, Manager};
mod ai_workspace_history;
mod commands;
pub mod database;
pub mod mcp;
pub mod mcp_local;
pub mod mcp_security;
mod observability;
pub mod query_history;
pub mod ssh;
pub mod storage;
mod utils;
mod watcher;

use ai_workspace_history::{get_ai_workspace_history, save_ai_workspace_history};
use commands::ai::{
    ask_ai, cancel_ai_request, get_ai_configs, save_ai_configs, AIRequestCancellationState,
};
use commands::connection::*;
use commands::connection_export::{export_connections_to_file, import_connections_from_file};
use commands::deep_link::parse_deep_link;
use commands::diagnostics::{
    export_diagnostic_bundle, preview_diagnostic_bundle, DiagnosticReviewState,
};
use commands::export::*;
use commands::file::*;
use commands::maintenance::{preview_maintenance_command, run_maintenance_command};
use commands::mcp::{
    create_mcp_token, get_mcp_audit_events, get_mcp_connection_policy, get_mcp_local_server_status,
    list_mcp_tokens, revoke_mcp_token, set_mcp_connection_policy, start_mcp_local_server,
    stop_mcp_local_server,
};
use commands::operations::get_operational_queries;
use commands::plugins::{
    check_plugin_updates, get_plugin_registry, install_plugin_bundle, install_registry_plugin,
    list_installed_plugins, reload_installed_plugins, rollback_plugin_bundle, set_plugin_enabled,
    uninstall_plugin_bundle,
};
use commands::query::*;
use commands::restore::{preview_database_restore, restore_database_sql};
use commands::table::*;
use commands::tabs::{delete_tabs, load_tabs, save_tabs};
use commands::terminal::{
    close_terminal, open_terminal, resize_terminal, write_terminal, TerminalManager,
};
use commands::update::{check_for_update, download_and_install_update, get_app_version};
use commands::users_roles::{
    apply_user_role_change, get_user_role_snapshot, review_user_role_change,
};
use commands::window::{apply_window_profile, apply_window_profile_to_main, WindowProfile};
use commands::workspace_sync::{pull_workspace_sync, push_workspace_sync};
use database::manager::DatabaseManager;
use log::{error, info};
use mcp_local::McpLocalServer;
use query_history::{
    clear_query_history, delete_query_history_entries, delete_query_history_entry,
    get_query_history, save_query_history,
};
use std::time::Duration;
use storage::ai_storage::AIStorage;
use storage::connection_storage::ConnectionStorage;
use storage::mcp_storage::McpStorage;
use storage::plugin_storage::PluginStorage;
use storage::sql_favorites::{delete_sql_favorite, get_sql_favorites, save_sql_favorite};
use storage::tab_persistence::TabPersistence;
use utils::rate_limiter::{AIRequestLimiter, ConnectionAttemptLimiter};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let start_time = std::time::Instant::now();
    let data_dir = match utils::paths::resolve_data_dir() {
        Ok(path) => path,
        Err(error) => {
            error!(
                "[TableR] FAILED to resolve application data directory: {}",
                error
            );
            return;
        }
    };
    if let Err(error) = observability::initialize(&data_dir) {
        eprintln!("TableR logging initialization failed: {error}");
        env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    }
    info!("[TableR] Application starting");
    if let Err(error) = storage::migrations::run_storage_migrations(&data_dir) {
        error!("[TableR] SAFE STARTUP ABORT: {}", error);
        return;
    }

    let conn_storage = match ConnectionStorage::new() {
        Ok(storage) => {
            info!(
                "[TableR] ConnectionStorage initialized: {:?}",
                start_time.elapsed()
            );
            storage
        }
        Err(error) => {
            error!(
                "[TableR] FAILED to initialize connection storage: {}",
                error
            );
            return;
        }
    };
    let ai_storage = match AIStorage::new() {
        Ok(storage) => {
            info!("[TableR] AIStorage initialized: {:?}", start_time.elapsed());
            storage
        }
        Err(error) => {
            error!("[TableR] FAILED to initialize AI storage: {}", error);
            return;
        }
    };
    let plugin_storage = match PluginStorage::new() {
        Ok(storage) => {
            info!(
                "[TableR] PluginStorage initialized: {:?}",
                start_time.elapsed()
            );
            storage
        }
        Err(error) => {
            error!("[TableR] FAILED to initialize plugin storage: {}", error);
            return;
        }
    };
    let db_manager = DatabaseManager::with_plugin_storage(plugin_storage.clone());
    info!(
        "[TableR] DatabaseManager initialized: {:?}",
        start_time.elapsed()
    );
    let tab_storage = match TabPersistence::new() {
        Ok(storage) => {
            info!(
                "[TableR] TabPersistence initialized: {:?}",
                start_time.elapsed()
            );
            storage
        }
        Err(error) => {
            error!(
                "[TableR] FAILED to initialize tab persistence storage: {}",
                error
            );
            return;
        }
    };
    let mcp_storage = match McpStorage::new() {
        Ok(storage) => storage,
        Err(error) => {
            error!("[TableR] FAILED to initialize MCP storage: {}", error);
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
    let ai_request_cancellation_state = AIRequestCancellationState::default();
    let csv_import_cancellation_state = CsvImportCancellationState::default();
    let terminal_manager = TerminalManager::default();

    let builder = tauri::Builder::default();
    #[cfg(feature = "e2e")]
    let builder = builder.plugin(tauri_plugin_wdio::init());

    let app = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(db_manager)
        .manage(conn_storage)
        .manage(plugin_storage)
        .manage(ai_storage)
        .manage(tab_storage)
        .manage(mcp_storage)
        .manage(McpLocalServer::default())
        .manage(watcher::LinkedFoldersState::new())
        .manage(terminal_manager)
        .manage(connection_rate_limiter)
        .manage(ai_rate_limiter)
        .manage(ai_request_cancellation_state)
        .manage(csv_import_cancellation_state)
        .manage(DiagnosticReviewState::default())
        .setup(|app| {
            if let Err(e) = watcher::start_watcher(app.handle().clone()) {
                error!("[TableR] Failed to start watcher: {}", e);
            }

            #[cfg(target_os = "windows")]
            {
                if let Err(error) = app.hide_menu() {
                    error!("Failed to hide native window menu: {}", error);
                }
            }

            if let Err(error) = apply_window_profile_to_main(app.handle(), WindowProfile::Launcher)
            {
                error!("Failed to apply launcher window profile: {}", error);
            }

            // Register deep link handler
            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let app_handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        let url_str = url.to_string();
                        info!("[DeepLink] Received external navigation request");
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
            get_connection_capabilities,
            parse_connection_url,
            parse_url_details,
            get_support_url,
            open_support_page,
            preview_diagnostic_bundle,
            export_diagnostic_bundle,
            // Query commands
            execute_query,
            execute_parameterized_query,
            execute_sandboxed_query,
            preview_database_restore,
            restore_database_sql,
            // Table commands
            list_tables,
            list_schema_objects,
            get_table_structure,
            get_table_columns_preview,
            get_table_data,
            count_table_rows,
            count_table_null_values,
            update_table_cell,
            apply_table_updates_atomically,
            delete_table_rows,
            insert_table_row,
            insert_table_rows_atomically,
            cancel_csv_import,
            execute_structure_statements,
            get_foreign_key_lookup_values,
            // AI commands
            ask_ai,
            cancel_ai_request,
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
            read_csv_file,
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
            rollback_plugin_bundle,
            get_plugin_registry,
            check_plugin_updates,
            install_registry_plugin,
            // MCP security and integration commands
            list_mcp_tokens,
            create_mcp_token,
            revoke_mcp_token,
            get_mcp_audit_events,
            get_mcp_connection_policy,
            set_mcp_connection_policy,
            start_mcp_local_server,
            stop_mcp_local_server,
            get_mcp_local_server_status,
            get_user_role_snapshot,
            review_user_role_change,
            apply_user_role_change,
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
            // Linked folders commands
            watcher::add_linked_folder,
            watcher::remove_linked_folder,
            watcher::get_linked_folders,
            watcher::scan_linked_folder,
            watcher::read_linked_file,
            // Maintenance commands
            preview_maintenance_command,
            run_maintenance_command,
            // Operations dashboard queries
            get_operational_queries,
            push_workspace_sync,
            pull_workspace_sync,
        ]);

    if let Err(error) = app.run(tauri::generate_context!()) {
        error!("error while running tauri application: {}", error);
    }
}
