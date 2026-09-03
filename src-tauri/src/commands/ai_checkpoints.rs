//! AI composer DB checkpoints: `/backup` snapshots the current database into
//! an app-managed folder (no save dialog) so a later `/rollback` can restore
//! the data when a change goes wrong — the database analog of Claude Code's
//! `/rewind` / Codex `/undo` file checkpointing.
//!
//! Storage layout: `<data_dir>/ai-checkpoints/<connection_id>/<ts>-<label>.sql`
//! plus a `<name>.meta.json` sidecar carrying the counts shown in the picker.
//! Retention keeps the newest [`MAX_CHECKPOINTS_PER_CONNECTION`] per connection.

use crate::database::capabilities::DriverCapability;
use crate::database::driver::DatabaseDriver;
use crate::database::manager::DatabaseManager;
use crate::database::models::DatabaseType;
use crate::utils::paths::resolve_data_dir;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;
use tokio::task;

use super::export_support::build_sql_export;
use super::restore::{run_sql_restore, RestorePreview, RestoreResult};
use super::safe_mode::SafeModeState;

const CHECKPOINT_DIR_NAME: &str = "ai-checkpoints";
const MAX_CHECKPOINTS_PER_CONNECTION: usize = 10;
const MAX_LABEL_CHARS: usize = 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointMeta {
    pub file_name: String,
    pub label: String,
    pub created_at: u64,
    pub engine: String,
    pub database: Option<String>,
    pub table_count: usize,
    pub row_count: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseCheckpoint {
    #[serde(flatten)]
    pub meta: CheckpointMeta,
    pub size_bytes: u64,
}

fn sanitize_component(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "default".to_string()
    } else {
        cleaned
    }
}

fn sanitize_label(raw: Option<&str>) -> String {
    let note = raw.map(str::trim).filter(|value| !value.is_empty());
    match note {
        Some(value) => sanitize_component(value)
            .chars()
            .take(MAX_LABEL_CHARS)
            .collect(),
        None => "manual".to_string(),
    }
}

fn checkpoint_dir(connection_id: &str) -> Result<PathBuf, String> {
    let data_dir = resolve_data_dir().map_err(|error| error.to_string())?;
    Ok(data_dir
        .join(CHECKPOINT_DIR_NAME)
        .join(sanitize_component(connection_id)))
}

fn checkpoint_paths(dir: &PathBuf, file_name: &str) -> Result<(PathBuf, PathBuf), String> {
    // Never trust client-supplied file names with separators.
    if file_name.contains('/') || file_name.contains('\\') || file_name.contains("..") {
        return Err("Invalid checkpoint file name.".to_string());
    }
    if !file_name.ends_with(".sql") {
        return Err("Invalid checkpoint file name.".to_string());
    }
    Ok((
        dir.join(file_name),
        dir.join(format!("{file_name}.meta.json")),
    ))
}

/// Older checkpoints were dumped with `nvarchar(max)`/`varchar(max)` columns,
/// which SQL Server rejects in key/index positions with error 1919. Normalize
/// them at restore time so pre-fix checkpoints stay restorable. Only touches
/// DDL type declarations; string literals in INSERTs never contain this shape
/// after escaping (they are quoted and cannot contain a bare unquoted type).
fn normalize_legacy_mssql_dump(sql: &str) -> String {
    let body = sql
        .lines()
        .map(|line| {
            line.replace("nvarchar(max)", "nvarchar(255)")
                .replace("varchar(max)", "varchar(255)")
        })
        .collect::<Vec<_>>()
        .join("\n");

    // Full-snapshot restore for MSSQL: drop ALL existing tables first (in
    // reverse dependency order — children before parents), then run the
    // CREATE TABLE + INSERT dump as a fresh schema. This eliminates errors
    // 544 (identity), 8106 (SET IDENTITY_INSERT on non-identity), and 1919
    // (nvarchar(max) in key) by always working with freshly created tables.
    let mut pre_drop_pass = String::from("-- Pre-pass: drop existing tables (children first)\n");
    let mut body_lines = Vec::new();
    let mut table_refs = Vec::new();

    for line in body.split('\n') {
        let mut patched = line.to_string();
        if patched.contains("IF OBJECT_ID(N'") && patched.contains("', 'U') IS NULL") {
            if let Some(table_ref) = patched
                .split("OBJECT_ID(N'")
                .nth(1)
                .and_then(|rest| rest.split("', 'U')").next())
            {
                if !table_ref.is_empty() {
                    table_refs.push(table_ref.to_string());
                    // Replace the conditional CREATE with a plain CREATE.
                    patched = patched
                        .replace(&format!("IF OBJECT_ID(N'{table_ref}', 'U') IS NULL\n"), "");
                }
            }
        }
        body_lines.push(patched);
    }

    // Reverse order so children (FK dependents) drop before parents.
    for table_ref in table_refs.iter().rev() {
        // table_ref already includes brackets: [dbo].[Table]
        pre_drop_pass.push_str(&format!("DROP TABLE IF EXISTS {table_ref};\n"));
    }
    pre_drop_pass.push('\n');
    format!("{pre_drop_pass}{}", body_lines.join("\n"))
}

fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

/// Prunes the oldest checkpoints beyond the retention cap. Best effort — a
/// failed delete must never fail the create that triggered it.
fn prune_old_checkpoints(dir: &PathBuf) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut metas: Vec<(PathBuf, u64)> = entries
        .flatten()
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
        .filter_map(|entry| {
            let content = fs::read_to_string(entry.path()).ok()?;
            let meta: CheckpointMeta = serde_json::from_str(&content).ok()?;
            Some((entry.path(), meta.created_at))
        })
        .collect();
    if metas.len() <= MAX_CHECKPOINTS_PER_CONNECTION {
        return;
    }
    metas.sort_by_key(|(_, created_at)| *created_at);
    let excess = metas.len() - MAX_CHECKPOINTS_PER_CONNECTION;
    for (meta_path, _) in metas.into_iter().take(excess) {
        if let Some(stem) = meta_path.file_name().and_then(|name| name.to_str()) {
            let sql_name = stem.strip_suffix(".meta.json").map(str::to_string);
            let _ = fs::remove_file(&meta_path);
            if let Some(sql_name) = sql_name {
                let _ = fs::remove_file(dir.join(sql_name));
            }
        }
    }
}

/// `/backup`: snapshots schema + data of the current database into the
/// app-managed checkpoint folder. No dialog — the point is a fast, silent
/// safety point before risky work.
#[tauri::command]
pub async fn create_database_checkpoint(
    connection_id: String,
    database: Option<String>,
    db_type: DatabaseType,
    label: Option<String>,
    db_manager: State<'_, DatabaseManager>,
) -> Result<DatabaseCheckpoint, String> {
    db_manager
        .require_capability(&connection_id, DriverCapability::DataExport)
        .await
        .map_err(|error| error.to_string())?;
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(|error| error.to_string())?;
    let driver_ref: &dyn DatabaseDriver = &*driver;

    let requested_database = database
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let resolved_database = requested_database
        .or_else(|| driver_ref.current_database())
        .filter(|value| !value.trim().is_empty());

    let content = build_sql_export(driver_ref, resolved_database.as_deref(), db_type)
        .await
        .map_err(|error| error.to_string())?;

    let created_at = now_epoch_ms();
    let meta = CheckpointMeta {
        file_name: format!("{}-{}.sql", created_at, sanitize_label(label.as_deref())),
        label: label
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("manual checkpoint")
            .to_string(),
        created_at,
        engine: format!("{db_type:?}").to_lowercase(),
        database: resolved_database.clone(),
        table_count: content.table_count,
        row_count: content.row_count,
    };

    let dir = checkpoint_dir(&connection_id)?;
    let (sql_path, meta_path) = checkpoint_paths(&dir, &meta.file_name)?;
    let meta_for_write = meta.clone();
    let sql_body = content.content.clone();
    let size_bytes = content.content.len() as u64;
    let dir_for_write = dir.clone();
    task::spawn_blocking(move || -> Result<(), String> {
        fs::create_dir_all(&dir_for_write)
            .map_err(|error| format!("Failed to create checkpoint folder: {error}"))?;
        fs::write(&sql_path, &sql_body).map_err(|error| {
            format!(
                "Failed to write checkpoint '{}': {error}",
                sql_path.display()
            )
        })?;
        let meta_json = serde_json::to_string_pretty(&meta_for_write)
            .map_err(|error| format!("Failed to serialize checkpoint metadata: {error}"))?;
        fs::write(&meta_path, meta_json)
            .map_err(|error| format!("Failed to write checkpoint metadata: {error}"))?;
        Ok(())
    })
    .await
    .map_err(|_| "Checkpoint write task failed unexpectedly.".to_string())??;

    prune_old_checkpoints(&dir);

    Ok(DatabaseCheckpoint { size_bytes, meta })
}

/// `/rollback` step 1: list the checkpoints stored for this connection,
/// newest first.
#[tauri::command]
pub fn list_database_checkpoints(connection_id: String) -> Result<Vec<DatabaseCheckpoint>, String> {
    let dir = checkpoint_dir(&connection_id)?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let entries =
        fs::read_dir(&dir).map_err(|error| format!("Failed to read checkpoint folder: {error}"))?;
    let mut checkpoints: Vec<DatabaseCheckpoint> = entries
        .flatten()
        .filter(|entry| {
            entry
                .path()
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(".meta.json"))
        })
        .filter_map(|entry| {
            let content = fs::read_to_string(entry.path()).ok()?;
            let meta: CheckpointMeta = serde_json::from_str(&content).ok()?;
            let sql_path = dir.join(&meta.file_name);
            let size_bytes = fs::metadata(&sql_path).ok()?.len();
            Some(DatabaseCheckpoint { meta, size_bytes })
        })
        .collect();
    checkpoints.sort_by(|left, right| right.meta.created_at.cmp(&left.meta.created_at));
    Ok(checkpoints)
}

/// `/rollback` step 2a: classify what restoring a checkpoint would run.
#[tauri::command]
pub fn preview_database_checkpoint_restore(
    connection_id: String,
    file_name: String,
    db_type: DatabaseType,
) -> Result<RestorePreview, String> {
    let dir = checkpoint_dir(&connection_id)?;
    let (sql_path, _) = checkpoint_paths(&dir, &file_name)?;
    let sql = fs::read_to_string(&sql_path).map_err(|error| {
        format!(
            "Failed to read checkpoint '{}': {error}",
            sql_path.display()
        )
    })?;
    let sql = if db_type == DatabaseType::MSSQL {
        normalize_legacy_mssql_dump(&sql)
    } else {
        sql
    };
    super::restore::build_restore_preview(&sql, db_type)
}

/// Deletes one checkpoint (the `.sql` dump and its meta sidecar). The dump
/// path is validated against separator/traversal attacks like every other
/// checkpoint command.
#[tauri::command]
pub async fn delete_database_checkpoint(
    connection_id: String,
    file_name: String,
) -> Result<(), String> {
    let dir = checkpoint_dir(&connection_id)?;
    let (sql_path, meta_path) = checkpoint_paths(&dir, &file_name)?;
    task::spawn_blocking(move || -> Result<(), String> {
        if !sql_path.exists() {
            return Err("Checkpoint not found.".to_string());
        }
        fs::remove_file(&sql_path)
            .map_err(|error| format!("Failed to delete checkpoint: {error}"))?;
        if meta_path.exists() {
            let _ = fs::remove_file(&meta_path);
        }
        Ok(())
    })
    .await
    .map_err(|error| format!("Checkpoint delete task failed: {error}"))??;
    Ok(())
}

/// `/rollback` step 2b: run the checkpoint SQL through the shared restore
/// pipeline (capability checks, statement splitting, transactional execution).
/// Safe Mode is intentionally not re-asserted here: the human confirmed the
/// exact checkpoint through the picker modal, and dump SQL routinely contains
/// parser-hostile or destructive statements that would make the recovery
/// path impossible behind read-only tiers.
#[tauri::command]
pub async fn restore_database_checkpoint(
    connection_id: String,
    file_name: String,
    db_type: DatabaseType,
    db_manager: State<'_, DatabaseManager>,
    safe_mode: State<'_, SafeModeState>,
) -> Result<RestoreResult, String> {
    let dir = checkpoint_dir(&connection_id)?;
    let (sql_path, _) = checkpoint_paths(&dir, &file_name)?;
    let sql = task::spawn_blocking(move || -> Result<String, String> {
        fs::read_to_string(&sql_path).map_err(|error| format!("Failed to read checkpoint: {error}"))
    })
    .await
    .map_err(|_| "Checkpoint read task failed unexpectedly.".to_string())??;
    let sql = if db_type == DatabaseType::MSSQL {
        normalize_legacy_mssql_dump(&sql)
    } else {
        sql
    };

    // Pre-drop: query the server for existing user tables and drop them
    // (children first via error-suppressed retry) so the dump's CREATE TABLE
    // runs on a clean slate. This is the only reliable way to handle FK
    // constraints during a full-snapshot restore.
    if db_type == DatabaseType::MSSQL {
        let driver = db_manager
            .get_driver(&connection_id)
            .await
            .map_err(|error| format!("Failed to get driver for pre-drop: {error}"))?;
        let tables = driver
            .list_tables(None)
            .await
            .map_err(|error| format!("Failed to list tables for pre-drop: {error}"))?;
        if !tables.is_empty() {
            let table_refs: Vec<String> = tables
                .iter()
                .map(|t| {
                    let schema = t.schema.as_deref().unwrap_or("dbo");
                    format!("[{schema}].[{}]", t.name)
                })
                .collect();
            // Two passes: first try all drops, then retry failures (FK order).
            for pass in 0..2 {
                for table_ref in &table_refs {
                    let _ = driver
                        .execute_query(&format!("DROP TABLE IF EXISTS {table_ref};"))
                        .await;
                }
                if pass == 0 {
                    // Small delay to let deferred constraint checks settle.
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
            }
        }
        drop(driver);
    }

    run_sql_restore(
        &connection_id,
        &sql,
        db_type,
        &db_manager,
        &safe_mode,
        false,
        false,
    )
    .await
}
