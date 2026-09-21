use tauri::{Emitter, Manager};
mod agent_commands;
mod agent_memory;
mod agent_memory_native;
mod agent_rules;
mod ai_skill_seed;
mod ai_skills;
mod ai_workspace_cache;
mod ai_workspace_history;
mod commands;
pub mod config;
pub mod database;
pub mod error;
pub mod mcp;
pub mod mcp_local;
pub mod mcp_security;
mod observability;
pub mod query_history;
pub mod ssh;
pub mod storage;
mod utils;

/// Sandbox SQL-safety guard, re-exported at the crate root so the driver
/// integration harness (`tests/driver_integration.rs`) can exercise the
/// filesystem/network/OS capability boundary end-to-end against live engines.
/// These are the exact functions the sandbox gateway in `commands::query`
/// calls before any statement reaches a driver; this is a test-facing
/// re-export, not a widening of the private `utils` module.
pub mod sandbox_guard {
    pub use crate::utils::sql::{classify_sql_with_dialect, detect_dangerous_capability};
}

mod watcher;

use ai_workspace_cache::{
    delete_ai_attachments, delete_ai_attachments_for_thread, delete_ai_attachments_for_workspace,
    delete_all_ai_attachments, delete_thread_memories_for_workspace,
    delete_thread_memory_for_thread, delete_workspace_context_snapshots, get_ai_attachment_data,
    get_latest_workspace_digest, list_ai_attachments, list_latest_workspace_digests,
    list_thread_memories, list_workspace_context_snapshots, save_ai_attachments,
    save_workspace_context_snapshot, upsert_thread_memory,
};

use ai_workspace_history::{get_ai_workspace_history, save_ai_workspace_history};
use commands::ai::{
    ask_ai, ask_ai_stream, cancel_ai_request, get_ai_configs, list_provider_models,
    save_agent_trace, save_ai_configs, AIRequestCancellationState,
};
use commands::ai_checkpoints::{
    create_database_checkpoint, delete_database_checkpoint, list_database_checkpoints,
    preview_database_checkpoint_restore, rename_database_checkpoint, restore_database_checkpoint,
};
use commands::connection::*;
use commands::connection_export::{export_connections_to_file, import_connections_from_file};
use commands::data_export::{cancel_table_export, export_table_data, TableExportCancellationState};
use commands::data_import::{
    import_csv, import_json, import_xlsx, preview_import_csv, preview_import_json,
    preview_import_xlsx,
};
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
use commands::plugins::{
    check_plugin_updates, get_plugin_registry, install_plugin_bundle, install_registry_plugin,
    list_installed_plugins, reload_installed_plugins, rollback_plugin_bundle, set_plugin_enabled,
    uninstall_plugin_bundle,
};
use commands::profiler::{execute_profiler_sample, get_profiler_probe, get_top_queries_probe};
use commands::query::*;
use commands::restore::{preview_database_restore, restore_database_sql};
use commands::safe_mode::{set_safe_mode_policy, SafeModeState};
use commands::schedule::spawn_scheduler;
use commands::schema_diff::{compare_schemas, generate_migration_script};
use commands::search::{list_tables_in, search_schema, search_table_data, search_table_data_multi};
use commands::table::*;
use commands::tabs::{delete_tabs, load_tabs, save_tabs};
use commands::terminal::{
    close_terminal, open_terminal, resize_terminal, write_terminal, TerminalManager,
};
use commands::update::{
    check_for_update, download_and_install_update, get_app_version, restart_app,
};
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
use storage::semantic_storage::{delete_semantic_entry, get_semantic_entries, save_semantic_entry};
use storage::sql_favorites::{delete_sql_favorite, get_sql_favorites, save_sql_favorite};
use storage::tab_persistence::TabPersistence;
use utils::rate_limiter::{AIRequestLimiter, ConnectionAttemptLimiter};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(feature = "e2e")]
    keyring::set_default_credential_builder(keyring::mock::default_credential_builder());

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
        // The updater plugin logs every unreachable endpoint at error level
        // (e.g. no published release yet), which spams the console on every
        // launch; the check failure is already surfaced to the UI instead.
        env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
            .filter_module("tauri_plugin_updater", log::LevelFilter::Off)
            .init();
    }
    info!("[TableR] Application starting");
    if let Err(error) = storage::migrations::run_storage_migrations(&data_dir) {
        // Log-and-continue: the boot-time check_storage_health probe renders a
        // recovery dialog over the affected files; aborting here would leave the
        // user with a silent no-window exit and no way to reset.
        error!("[TableR] storage migration failed (recovery dialog will offer reset): {error}");
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
        // Generous enough for legitimate retry loops ("test connection" +
        // "connect" during first-time setup / debugging), still capped to
        // blunt credential brute-forcing.
        20,
        "Too many connection attempts in a short time. Please wait about a minute and try again.",
    );
    let ai_rate_limiter = AIRequestLimiter::new(
        Duration::from_secs(60),
        24,
        "Too many AI requests in a short time. Please wait a moment and try again.",
    );
    let ai_request_cancellation_state = AIRequestCancellationState::default();
    let csv_import_cancellation_state = CsvImportCancellationState::default();
    let table_export_cancellation_state = TableExportCancellationState::default();
    let query_cancellation_state = QueryCancellationState::default();
    let safe_mode_state = SafeModeState::default();
    let connection_attempt_cancellation_state = ConnectionAttemptCancellationState::default();
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
        .manage(table_export_cancellation_state)
        .manage(query_cancellation_state)
        .manage(safe_mode_state)
        .manage(connection_attempt_cancellation_state)
        .manage(DiagnosticReviewState::default())
        .setup(|app| {
            if let Err(e) = watcher::start_watcher(app.handle().clone()) {
                error!("[TableR] Failed to start watcher: {}", e);
            }

            // Query scheduler: minute-tick loop over persisted schedules.
            spawn_scheduler(app.handle().clone());

            // Built-in Agent Skill pack: install the SQL/T-SQL domain knowledge
            // on first run (and refresh it after an upgrade) without ever
            // clobbering a skill the user edited. Failure here must never block
            // startup — the app works fine with zero skills installed.
            match ai_skill_seed::seed_builtin_skills(false) {
                Ok(report) => info!(
                    "[TableR] Built-in skills: {} installed, {} refreshed, {} unchanged, {} user-modified",
                    report.installed, report.refreshed, report.unchanged, report.user_modified
                ),
                Err(error) => error!("[TableR] Failed to seed built-in skills: {}", error),
            }

            // Built-in Agent Rule pack (guardrails): same policy as the skills —
            // install on first run, refresh shipped content after an upgrade, and
            // never clobber a rule the user edited. Startup must not depend on it.
            match agent_rules::seed_builtin_rules(false) {
                Ok(report) => info!(
                    "[TableR] Built-in rules: {} installed, {} refreshed, {} unchanged, {} user-modified",
                    report.installed, report.refreshed, report.unchanged, report.user_modified
                ),
                Err(error) => error!("[TableR] Failed to seed built-in rules: {}", error),
            }

            // Built-in slash-command pack: the composer's `/` menu is useless on a
            // fresh install without it. Same contract as skills and rules - an
            // edited command is never clobbered, a deleted one is restored.
            match agent_commands::seed_builtin_commands(false) {
                Ok(report) => info!(
                    "[TableR] Built-in commands: {} installed, {} refreshed, {} unchanged, {} user-modified",
                    report.installed, report.refreshed, report.unchanged, report.user_modified
                ),
                Err(error) => error!("[TableR] Failed to seed built-in commands: {}", error),
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
            cancel_connection_attempt,
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
            rename_saved_connection,
            check_connection_status,
            get_connection_capabilities,
            get_native_driver_availability,
            parse_connection_url,
            parse_url_details,
            get_support_url,
            open_support_page,
            preview_diagnostic_bundle,
            export_diagnostic_bundle,
            // Query commands
            execute_query,
            classify_sql_safety,
            set_safe_mode_policy,
            cancel_query,
            execute_parameterized_query,
            execute_agent_parameterized_query,
            execute_query_progressive,
            search_schema,
            search_table_data,
            search_table_data_multi,
            list_tables_in,
            compare_schemas,
            generate_migration_script,
            preview_import_csv,
            import_csv,
            preview_import_json,
            import_json,
            preview_import_xlsx,
            import_xlsx,
            execute_sandboxed_query,
            execute_agent_readonly_query,
            explain_agent_statement,
            preview_write_transaction,
            save_agent_trace,
            preview_database_restore,
            restore_database_sql,
            create_database_checkpoint,
            list_database_checkpoints,
            preview_database_checkpoint_restore,
            delete_database_checkpoint,
            rename_database_checkpoint,
            restore_database_checkpoint,
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
            import_csv_file_atomically,
            cancel_csv_import,
            export_table_data,
            cancel_table_export,
            execute_structure_statements,
            get_foreign_key_lookup_values,
            // AI commands
            ask_ai,
            ask_ai_stream,
            cancel_ai_request,
            get_ai_configs,
            save_ai_configs,
            list_provider_models,
            // Query history commands
            save_query_history,
            get_query_history,
            delete_query_history_entry,
            delete_query_history_entries,
            clear_query_history,
            // AI workspace history commands
            get_ai_workspace_history,
            save_ai_workspace_history,
            save_workspace_context_snapshot,
            list_workspace_context_snapshots,
            get_latest_workspace_digest,
            list_latest_workspace_digests,
            delete_workspace_context_snapshots,
            upsert_thread_memory,
            list_thread_memories,
            delete_thread_memories_for_workspace,
            delete_thread_memory_for_thread,
            save_ai_attachments,
            list_ai_attachments,
            get_ai_attachment_data,
            delete_ai_attachments,
            delete_all_ai_attachments,
            delete_ai_attachments_for_workspace,
            delete_ai_attachments_for_thread,
            agent_memory::list_agent_memory,
            agent_memory::read_agent_memory,
            agent_memory::save_agent_memory,
            agent_memory::delete_agent_memory,
            agent_memory_native::run_agent_memory_tool,
            ai_skills::list_ai_skills,
            ai_skills::read_ai_skill,
            ai_skills::read_ai_skill_resource,
            ai_skills::ai_skills_directory,
            ai_skills::create_ai_skill,
            ai_skills::update_ai_skill,
            // Built-in skill pack: seed on demand / restore shipped content.
            ai_skill_seed::seed_ai_builtin_skills,
            ai_skill_seed::reset_ai_builtin_skills,
            // Built-in rule pack (guardrails): seed on demand / restore shipped content.
            agent_commands::seed_ai_builtin_commands,
            agent_commands::reset_ai_builtin_commands,
            agent_commands::list_ai_commands,
            agent_commands::list_user_slash_commands,
            agent_commands::resolve_ai_command,
            agent_rules::seed_ai_builtin_rules,
            agent_rules::reset_ai_builtin_rules,
            // Guardrail evaluation: plan gate + rules manager.
            agent_rules::evaluate_agent_rules,
            agent_rules::list_agent_rules,
            // P9 learning loop: the rule the user approved from a run finding.
            agent_rules::save_agent_rule, // File commands
            read_sql_file,
            read_sql_file_from_path,
            read_csv_file,
            pick_database_file,
            save_export_file,
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
            commands::schedule::list_query_schedules,
            commands::schedule::save_query_schedule,
            commands::schedule::delete_query_schedule,
            // P10: an unattended agent task reports its real outcome back here
            // (the backend only dispatches; it never runs the agent).
            commands::schedule::complete_agent_schedule_run,
            commands::schedule::acknowledge_missed_schedule_runs,
            // Semantic glossary commands
            get_semantic_entries,
            save_semantic_entry,
            delete_semantic_entry,
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
            restart_app,
            // Storage health / recovery (boot-time dialog)
            commands::storage_recovery::check_storage_health,
            commands::storage_recovery::reset_corrupt_storage,
            commands::storage_recovery::exit_app,
            // First-run sample database
            commands::sample_db::create_sample_database,
            // Workspace bundle export/import (team sharing)
            commands::workspace_bundle::export_workspace_bundle,
            commands::workspace_bundle::import_workspace_bundle,
            // Per-project guardrail rules
            agent_rules::write_workspace_rule,
            // Linked folders commands
            watcher::add_linked_folder,
            watcher::remove_linked_folder,
            watcher::get_linked_folders,
            watcher::scan_linked_folder,
            watcher::read_linked_file,
            // Maintenance commands
            preview_maintenance_command,
            run_maintenance_command,
            // Live profiler (per-engine active-session sampling probe)
            get_profiler_probe,
            // Profiler: statement-store aggregate ranking probe
            get_top_queries_probe,
            // Profiler: native (non-SQL) sampling, e.g. MongoDB $currentOp / system.profile
            execute_profiler_sample,
            push_workspace_sync,
            pull_workspace_sync,
        ]);

    if let Err(error) = app.run(tauri::generate_context!()) {
        error!("error while running tauri application: {}", error);
    }
}
