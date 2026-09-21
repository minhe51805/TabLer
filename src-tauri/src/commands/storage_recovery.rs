//! Startup storage health check + corrupt-file recovery.
//!
//! Persisted workspace state lives in plain JSON files under the data dir.
//! When one of them becomes unreadable the app used to either abort before the
//! window appeared (storage migrations) or surface a generic load error long
//! after boot. These commands let the frontend probe every tracked file at
//! startup, show a "Reset & continue / Quit" dialog, and quarantine corrupt
//! files as `<name>.corrupt-<timestamp>` so the next launch re-initializes
//! them empty instead of losing data silently.

use crate::database::ai_models::AIProviderConfig;
use crate::database::models::ConnectionConfig;
use crate::mcp_security::McpTokenGrant;
use crate::storage::file_storage::{
    backup_path_for, read_json_map_with_backup, read_json_vec_with_backup,
};
use crate::storage::mcp_storage::McpAuditEvent;
use crate::storage::plugin_storage::InstalledPluginRecord;
use crate::storage::schedule_storage::QuerySchedule;
use crate::storage::semantic_storage::SemanticEntry;
use crate::storage::sql_favorites::SqlFavorite;
use crate::storage::tab_persistence::PersistedTab;
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::fs;
use std::path::Path;

/// JSON files that hold user/workspace state and must parse cleanly. Files
/// whose readers already fall back to a `<name>.bak` sibling are only flagged
/// when BOTH copies are unreadable — a recoverable primary is not corruption
/// the user needs to act on.
const TRACKED_VEC_FILES: &[&str] = &[
    "connections.json",
    "ai_providers.json",
    "plugins.json",
    "query_schedules.json",
    "semantic_glossary.json",
    "sql_favorites.json",
    "mcp_tokens.json",
    "mcp_audit.json",
];

/// Object-shaped JSON files (everything above is array-shaped).
const TRACKED_OBJECT_FILES: &[&str] = &[
    "tab_persistence.json",
    "storage-schema.json",
    "storage-migration-journal.json",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageFileIssue {
    /// Bare file name inside the data dir, e.g. `connections.json`.
    pub file: String,
    /// Parse/read error text, shown verbatim in the recovery dialog.
    pub error: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageHealthReport {
    pub healthy: bool,
    pub issues: Vec<StorageFileIssue>,
}

fn is_tracked_file(name: &str) -> bool {
    TRACKED_VEC_FILES.contains(&name) || TRACKED_OBJECT_FILES.contains(&name)
}

/// Parse `path` as a JSON array of `T` through the same backup-fallback reader
/// the storage modules use, so "corrupt" here means exactly what the real
/// load path would fail on.
fn check_vec_file<T>(data_dir: &Path, file: &str, context: &str, issues: &mut Vec<StorageFileIssue>)
where
    T: DeserializeOwned,
{
    let path = data_dir.join(file);
    if let Err(error) = read_json_vec_with_backup::<T>(&path, context) {
        issues.push(StorageFileIssue {
            file: file.to_string(),
            error: error.to_string(),
        });
    }
}

fn check_map_file<K, V>(
    data_dir: &Path,
    file: &str,
    context: &str,
    issues: &mut Vec<StorageFileIssue>,
) where
    K: DeserializeOwned + std::hash::Hash + Eq,
    V: DeserializeOwned,
{
    let path = data_dir.join(file);
    if let Err(error) = read_json_map_with_backup::<K, V>(&path, context) {
        issues.push(StorageFileIssue {
            file: file.to_string(),
            error: error.to_string(),
        });
    }
}

/// Manifest/journal files have no `.bak` fallback: any unreadable or
/// non-object content counts as corrupt.
fn check_object_file(data_dir: &Path, file: &str, issues: &mut Vec<StorageFileIssue>) {
    let path = data_dir.join(file);
    if !path.exists() {
        return;
    }
    let verdict = fs::read(&path)
        .map_err(|e| format!("Failed to read '{}': {e}", path.display()))
        .and_then(|bytes| {
            serde_json::from_slice::<serde_json::Value>(&bytes)
                .map_err(|e| format!("Failed to parse '{}': {e}", path.display()))
        })
        .and_then(|value| {
            if value.is_object() {
                Ok(())
            } else {
                Err(format!("'{}' is not a JSON object", path.display()))
            }
        });
    if let Err(error) = verdict {
        issues.push(StorageFileIssue {
            file: file.to_string(),
            error,
        });
    }
}

/// Probe every tracked storage file and report which ones fail to parse.
/// Runs at frontend boot; a healthy report costs a handful of small reads.
#[tauri::command]
pub fn check_storage_health() -> Result<StorageHealthReport, String> {
    let data_dir = crate::utils::paths::resolve_data_dir().map_err(|error| error.to_string())?;
    let mut issues = Vec::new();

    check_vec_file::<ConnectionConfig>(
        &data_dir,
        "connections.json",
        "Failed to parse saved connections",
        &mut issues,
    );
    check_vec_file::<AIProviderConfig>(
        &data_dir,
        "ai_providers.json",
        "Failed to parse saved AI provider configs",
        &mut issues,
    );
    check_vec_file::<InstalledPluginRecord>(
        &data_dir,
        "plugins.json",
        "Failed to parse installed plugins",
        &mut issues,
    );
    check_vec_file::<QuerySchedule>(
        &data_dir,
        "query_schedules.json",
        "query_schedules",
        &mut issues,
    );
    check_vec_file::<SemanticEntry>(
        &data_dir,
        "semantic_glossary.json",
        "semantic glossary",
        &mut issues,
    );
    check_vec_file::<SqlFavorite>(
        &data_dir,
        "sql_favorites.json",
        "sql_favorites",
        &mut issues,
    );
    check_vec_file::<McpTokenGrant>(
        &data_dir,
        "mcp_tokens.json",
        "Failed to read MCP tokens",
        &mut issues,
    );
    check_vec_file::<McpAuditEvent>(
        &data_dir,
        "mcp_audit.json",
        "Failed to read MCP audit log",
        &mut issues,
    );
    check_map_file::<String, Vec<PersistedTab>>(
        &data_dir,
        "tab_persistence.json",
        "Failed to parse tab persistence file",
        &mut issues,
    );
    check_object_file(&data_dir, "storage-schema.json", &mut issues);
    check_object_file(&data_dir, "storage-migration-journal.json", &mut issues);

    Ok(StorageHealthReport {
        healthy: issues.is_empty(),
        issues,
    })
}

/// Quarantine the given tracked files (and their `.bak` siblings) by renaming
/// them to `<name>.corrupt-<timestamp>`, then leave the data dir ready for a
/// clean re-initialization on next launch. Only file names the health check
/// itself tracks may be reset — arbitrary paths are rejected.
#[tauri::command]
pub fn reset_corrupt_storage(files: Vec<String>) -> Result<Vec<String>, String> {
    let data_dir = crate::utils::paths::resolve_data_dir().map_err(|error| error.to_string())?;
    let timestamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    let mut quarantined = Vec::new();

    for file in &files {
        if !is_tracked_file(file) {
            return Err(format!("Refusing to reset untracked file '{file}'"));
        }
    }

    for file in &files {
        let primary = data_dir.join(file);
        let backup = backup_path_for(&primary);
        for path in [primary, backup] {
            if !path.exists() {
                continue;
            }
            let file_name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(file);
            let target = path.with_file_name(format!("{file_name}.corrupt-{timestamp}"));
            fs::rename(&path, &target)
                .map_err(|e| format!("Failed to quarantine '{}': {e}", path.display()))?;
            quarantined.push(target.display().to_string());
        }
    }

    Ok(quarantined)
}

/// Quit the app from the corrupt-storage dialog's "Quit" action.
#[tauri::command]
pub fn exit_app(app: tauri::AppHandle, code: Option<i32>) {
    app.exit(code.unwrap_or(0));
}
