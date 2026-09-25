//! AI composer DB checkpoints: `/backup` snapshots the current database into
//! an app-managed folder (no save dialog) so a later `/rollback` can restore
//! the data when a change goes wrong — the database analog of Claude Code's
//! `/rewind` / Codex `/undo` file checkpointing.
//!
//! Storage layout: `<data_dir>/ai-checkpoints/<connection_id>/<ts>-<label>.<ext>`
//! plus a `<name>.meta.json` sidecar carrying the counts shown in the picker.
//! `ext` follows `preferred_export_format`: `.sql` dumps for SQL engines,
//! `.json` snapshots for document/KV/search engines (`.enc` is also accepted
//! on read for externally produced encrypted blobs). Bodies at rest are
//! passed through [`super::checkpoint_crypto`]; legacy plaintext files still
//! read transparently.
//! Retention keeps the newest [`MAX_CHECKPOINTS_PER_CONNECTION`] per connection.
//!
//! Restore semantics: replaying a checkpoint is a data-overlay — the dump's
//! INSERT/restore payload is applied over the CURRENT state, so rows written
//! after the checkpoint are not deleted (MSSQL is the exception: its
//! drop-and-recreate pipeline really does return the schema to the snapshot).

use crate::database::capabilities::DriverCapability;
use crate::database::driver::DatabaseDriver;
use crate::database::manager::DatabaseManager;
use crate::database::models::DatabaseType;
use crate::utils::paths::resolve_data_dir;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;
use tokio::task;

use super::checkpoint_crypto::{decrypt_checkpoint_payload, encrypt_checkpoint_payload};
use super::export::{DatabaseExportFormat, SqlExportPayload};
use super::export_support::{build_sql_export, preferred_export_format, stream_json_snapshot};
use super::restore::{run_sql_restore, PreRestoreSnapshot, RestorePreview, RestoreResult};
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

/// Payload produced by the engine-specific dump step of [`snapshot_database`].
/// SQL dumps build in memory; JSON snapshots stream to a staging file inside
/// the checkpoint dir so a full database never materializes in one Vec.
enum SnapshotPayload {
    Sql(SqlExportPayload),
    Json {
        temp_path: PathBuf,
        table_count: usize,
        row_count: u64,
    },
}

impl SnapshotPayload {
    fn extension(&self) -> &'static str {
        match self {
            SnapshotPayload::Sql(_) => "sql",
            SnapshotPayload::Json { .. } => "json",
        }
    }

    fn table_count(&self) -> usize {
        match self {
            SnapshotPayload::Sql(payload) => payload.table_count,
            SnapshotPayload::Json { table_count, .. } => *table_count,
        }
    }

    fn row_count(&self) -> u64 {
        match self {
            SnapshotPayload::Sql(payload) => payload.row_count,
            SnapshotPayload::Json { row_count, .. } => *row_count,
        }
    }
}

/// Engines that cannot replay the checkpoint artifact `snapshot_database`
/// produces for them. The read-only search transport (OpenSearch, and the
/// Elasticsearch bridge sharing it) is the only member: it snapshots as a
/// JSON document while `restore.rs` hard-blocks the engine — its driver is
/// read-only — so a checkpoint file would be a dead artifact no restore path
/// can consume. Document engines (MongoDB, DynamoDB) replay the same JSON
/// snapshot shape through their drivers, and Redis rebuilds keys from it, so
/// they are intentionally NOT listed here.
pub(super) fn checkpoint_restore_supported(db_type: DatabaseType) -> bool {
    !matches!(
        db_type,
        DatabaseType::OpenSearch | DatabaseType::Elasticsearch
    )
}

/// Reads and decrypts a checkpoint body. `decrypt_checkpoint_payload` passes
/// legacy plaintext files through untouched, so pre-encryption checkpoints
/// keep working without a format flag.
fn read_checkpoint_body(connection_id: &str, path: &Path) -> Result<Vec<u8>, String> {
    let blob = fs::read(path)
        .map_err(|error| format!("Failed to read checkpoint '{}': {error}", path.display()))?;
    decrypt_checkpoint_payload(connection_id, &blob)
        .map_err(|error| format!("Failed to decrypt checkpoint '{}': {error}", path.display()))
}

fn checkpoint_paths(dir: &Path, file_name: &str) -> Result<(PathBuf, PathBuf), String> {
    // Never trust client-supplied file names with separators.
    if file_name.contains('/') || file_name.contains('\\') || file_name.contains("..") {
        return Err("Invalid checkpoint file name.".to_string());
    }
    // `.sql` dumps and `.json` snapshots are the formats snapshot_database
    // writes; `.enc` is accepted for externally produced encrypted blobs.
    // `.meta.json` sidecars are metadata, never checkpoint bodies.
    let valid_body = (file_name.ends_with(".sql")
        || file_name.ends_with(".json")
        || file_name.ends_with(".enc"))
        && !file_name.ends_with(".meta.json");
    if !valid_body {
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
/// Legacy MSSQL dumps rendered string literals without the `N` prefix, so
/// restoring them silently converted Vietnamese (and any Unicode) text to
/// the server's windows-1252 codepage ("Nguy?n V?n An" mojibake). Prefixing
/// every string literal inside INSERT statements with `N` keeps them
/// NVARCHAR so legacy checkpoints restore Unicode correctly.
fn add_n_prefix_to_insert_literals(line: &str) -> String {
    const Q: char = '\u{27}';
    // The dump uses multi-line INSERTs: the header ("INSERT INTO [t] (...)")
    // carries no literals, while the data rows are continuation lines that
    // start with "(" (or a bare literal). Cover both, plus the single-line
    // compact form. Other lines (IF OBJECT_ID guards, CREATE/DROP) keep the
    // N they already have.
    let trimmed = line.trim_start();
    let carries_literals = trimmed.starts_with("INSERT INTO")
        || trimmed.starts_with('(')
        || trimmed.starts_with('\u{27}');
    if !carries_literals || !line.contains('\'') {
        return line.to_string();
    }
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::with_capacity(line.len() + 16);
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == Q {
            if out.ends_with('N') {
                out.push(Q);
            } else {
                out.push('N');
                out.push(Q);
            }
            i += 1;
            while i < chars.len() {
                out.push(chars[i]);
                if chars[i] == Q {
                    if i + 1 < chars.len() && chars[i + 1] == Q {
                        out.push(Q);
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

fn normalize_legacy_mssql_dump(sql: &str) -> String {
    let body = sql
        .lines()
        .map(|line| {
            add_n_prefix_to_insert_literals(
                &line
                    .replace("nvarchar(max)", "nvarchar(255)")
                    .replace("varchar(max)", "varchar(255)"),
            )
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
    snapshot_database(&connection_id, database, db_type, label, &db_manager).await
}

/// Shared snapshot core: dump schema + data and persist it (with a meta
/// sidecar) under the connection's checkpoint folder. Powers `/backup`, the
/// agent's create_checkpoint tool, and the pre-restore safety snapshot.
/// Engines without a restore path for their snapshot format are refused up
/// front — a checkpoint that can never be replayed is dead weight that only
/// looks like a safety point.
pub(super) async fn snapshot_database(
    connection_id: &str,
    database: Option<String>,
    db_type: DatabaseType,
    label: Option<String>,
    db_manager: &DatabaseManager,
) -> Result<DatabaseCheckpoint, String> {
    if !checkpoint_restore_supported(db_type) {
        return Err(format!(
            "Checkpoints are not supported on {db_type:?}: its snapshot cannot be restored."
        ));
    }
    db_manager
        .require_capability(connection_id, DriverCapability::DataExport)
        .await
        .map_err(|error| error.to_string())?;
    let driver = db_manager
        .get_driver(connection_id)
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

    let created_at = now_epoch_ms();
    let label_component = sanitize_label(label.as_deref());
    let dir = checkpoint_dir(connection_id)?;
    task::spawn_blocking({
        let dir = dir.clone();
        move || fs::create_dir_all(&dir)
    })
    .await
    .map_err(|_| "Checkpoint folder task failed unexpectedly.".to_string())?
    .map_err(|error| format!("Failed to create checkpoint folder: {error}"))?;

    let payload = match preferred_export_format(db_type) {
        DatabaseExportFormat::Sql => SnapshotPayload::Sql(
            build_sql_export(driver_ref, resolved_database.as_deref(), db_type)
                .await
                .map_err(|error| error.to_string())?,
        ),
        DatabaseExportFormat::JsonSnapshot => {
            // Same dump the manual export produces — streamed to a staging
            // file so the snapshot never materializes as one buffer.
            let temp_path = dir.join(format!("{created_at}-{label_component}.json.tmp"));
            match stream_json_snapshot(
                driver_ref,
                resolved_database.as_deref(),
                db_type,
                &temp_path,
            )
            .await
            {
                Ok((table_count, row_count)) => SnapshotPayload::Json {
                    temp_path,
                    table_count,
                    row_count,
                },
                Err(error) => {
                    let _ = fs::remove_file(&temp_path);
                    return Err(error.to_string());
                }
            }
        }
    };

    let meta = CheckpointMeta {
        file_name: format!("{created_at}-{label_component}.{}", payload.extension()),
        label: label
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("manual checkpoint")
            .to_string(),
        created_at,
        engine: format!("{db_type:?}").to_lowercase(),
        database: resolved_database.clone(),
        table_count: payload.table_count(),
        row_count: payload.row_count(),
    };

    let (checkpoint_path, meta_path) = checkpoint_paths(&dir, &meta.file_name)?;
    let meta_for_write = meta.clone();
    let connection_id_for_write = connection_id.to_string();
    let size_bytes = task::spawn_blocking(move || -> Result<u64, String> {
        let body = match payload {
            SnapshotPayload::Sql(content) => content.content.into_bytes(),
            SnapshotPayload::Json { temp_path, .. } => {
                let bytes = fs::read(&temp_path).map_err(|error| {
                    let _ = fs::remove_file(&temp_path);
                    format!("Failed to read snapshot staging file: {error}")
                })?;
                let _ = fs::remove_file(&temp_path);
                bytes
            }
        };
        let encrypted = encrypt_checkpoint_payload(&connection_id_for_write, &body)
            .map_err(|error| format!("Failed to encrypt checkpoint: {error}"))?;
        let size_bytes = encrypted.len() as u64;
        fs::write(&checkpoint_path, &encrypted).map_err(|error| {
            format!(
                "Failed to write checkpoint '{}': {error}",
                checkpoint_path.display()
            )
        })?;
        let meta_json = serde_json::to_string_pretty(&meta_for_write)
            .map_err(|error| format!("Failed to serialize checkpoint metadata: {error}"))?;
        fs::write(&meta_path, meta_json)
            .map_err(|error| format!("Failed to write checkpoint metadata: {error}"))?;
        Ok(size_bytes)
    })
    .await
    .map_err(|_| "Checkpoint write task failed unexpectedly.".to_string())??;

    prune_old_checkpoints(&dir);

    Ok(DatabaseCheckpoint { size_bytes, meta })
}

/// Best-effort safety snapshot before a restore on engines that cannot abort
/// a failed restore atomically. Returns `None` for transactional engines —
/// their restore rolls itself back, so a snapshot would be redundant cost.
pub(super) async fn create_pre_restore_snapshot(
    connection_id: &str,
    db_type: DatabaseType,
    db_manager: &DatabaseManager,
) -> Result<Option<CheckpointMeta>, String> {
    if super::restore::supports_transactional_restore(db_type) {
        return Ok(None);
    }
    let checkpoint = snapshot_database(
        connection_id,
        None,
        db_type,
        Some("pre-restore safety".to_string()),
        db_manager,
    )
    .await?;
    Ok(Some(checkpoint.meta))
}

/// Best-effort variant used by the rollback path: returns the failure to the
/// caller (which surfaces it to the UI) but never aborts recovery.
async fn capture_pre_restore_safety_snapshot(
    connection_id: &str,
    db_type: DatabaseType,
    db_manager: &DatabaseManager,
) -> Result<CheckpointMeta, String> {
    let checkpoint = snapshot_database(
        connection_id,
        None,
        db_type,
        Some("pre-restore safety".to_string()),
        db_manager,
    )
    .await?;
    log::info!(
        "pre-restore snapshot captured: {}",
        checkpoint.meta.file_name
    );
    Ok(checkpoint.meta)
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
            let body_path = dir.join(&meta.file_name);
            let size_bytes = fs::metadata(&body_path).ok()?.len();
            Some(DatabaseCheckpoint { meta, size_bytes })
        })
        .collect();
    checkpoints.sort_by_key(|checkpoint| std::cmp::Reverse(checkpoint.meta.created_at));
    Ok(checkpoints)
}

/// True when the decrypted checkpoint body is a TableR JSON snapshot
/// (`meta.format == "json-snapshot"`) rather than a SQL dump.
fn is_json_snapshot_body(body: &str) -> bool {
    if !body.trim_start().starts_with('{') {
        return false;
    }
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("meta")
                .and_then(|meta| meta.get("format"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        })
        .as_deref()
        == Some("json-snapshot")
}

/// `/rollback` step 2a: classify what restoring a checkpoint would run.
/// SQL dumps are counted by the shared SQL classifier; JSON snapshots are
/// counted straight from the payload (tables replayed + rows re-inserted)
/// because splitting them as SQL would report garbage.
#[tauri::command]
pub fn preview_database_checkpoint_restore(
    connection_id: String,
    file_name: String,
    db_type: DatabaseType,
) -> Result<RestorePreview, String> {
    let dir = checkpoint_dir(&connection_id)?;
    let (checkpoint_path, _) = checkpoint_paths(&dir, &file_name)?;
    let body = read_checkpoint_body(&connection_id, &checkpoint_path)?;
    let body = String::from_utf8(body)
        .map_err(|_| "The checkpoint body is not valid UTF-8.".to_string())?;

    if is_json_snapshot_body(&body) {
        return build_json_snapshot_preview(&body);
    }

    let sql = if db_type == DatabaseType::MSSQL {
        normalize_legacy_mssql_dump(&body)
    } else {
        body
    };
    super::restore::build_restore_preview(&sql, db_type)
}

/// Counts a JSON snapshot checkpoint for the restore preview: each snapshot
/// table is replayed and its rows are re-inserted — a pure data restore with
/// no schema or destructive statements. Snapshot replay is a data-overlay:
/// it never deletes rows written after the checkpoint, and on engines like
/// Redis a failed replay cannot roll back, so the preview must say so.
fn build_json_snapshot_preview(body: &str) -> Result<RestorePreview, String> {
    let snapshot: serde_json::Value = serde_json::from_str(body)
        .map_err(|error| format!("The JSON checkpoint could not be parsed: {error}"))?;
    let tables = snapshot
        .get("tables")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "The JSON snapshot does not contain a 'tables' array.".to_string())?;
    let row_count: u64 = tables
        .iter()
        .map(|table| {
            table
                .get("rows")
                .and_then(serde_json::Value::as_array)
                .map(|rows| rows.len() as u64)
                .unwrap_or(0)
        })
        .sum();
    Ok(RestorePreview {
        statement_count: tables.len(),
        schema_change_count: 0,
        data_change_count: row_count as usize,
        destructive_statement_count: 0,
        unclassified_statement_count: 0,
        transactional: false,
        warning: Some(
            "JSON snapshot restore overlays checkpoint rows on the current data — rows written after the checkpoint are kept, and a failed replay cannot be rolled back."
                .to_string(),
        ),
    })
}

/// Deletes one checkpoint (the dump/snapshot file and its meta sidecar).
/// The dump path is validated against separator/traversal attacks like every
/// other checkpoint command.
#[tauri::command]
pub async fn delete_database_checkpoint(
    connection_id: String,
    file_name: String,
) -> Result<(), String> {
    let dir = checkpoint_dir(&connection_id)?;
    let (checkpoint_path, meta_path) = checkpoint_paths(&dir, &file_name)?;
    task::spawn_blocking(move || -> Result<(), String> {
        if !checkpoint_path.exists() {
            return Err("Checkpoint not found.".to_string());
        }
        fs::remove_file(&checkpoint_path)
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

/// Rename a checkpoint (updates the label in the meta sidecar). The dump
/// file name itself is left untouched — labels live in the sidecar only.
#[tauri::command]
pub async fn rename_database_checkpoint(
    connection_id: String,
    file_name: String,
    label: String,
) -> Result<CheckpointMeta, String> {
    let dir = checkpoint_dir(&connection_id)?;
    let (_checkpoint_path, meta_path) = checkpoint_paths(&dir, &file_name)?;
    let trimmed = label.trim();
    if trimmed.is_empty() {
        return Err("Checkpoint label must not be empty.".to_string());
    }
    let clean_label: String = trimmed.chars().take(MAX_LABEL_CHARS * 2).collect();
    task::spawn_blocking(move || -> Result<CheckpointMeta, String> {
        let content = fs::read_to_string(&meta_path)
            .map_err(|error| format!("Failed to read checkpoint meta: {error}"))?;
        let mut meta: CheckpointMeta = serde_json::from_str(&content)
            .map_err(|error| format!("Failed to parse checkpoint meta: {error}"))?;
        meta.label = clean_label;
        let updated = serde_json::to_string_pretty(&meta)
            .map_err(|error| format!("Failed to encode checkpoint meta: {error}"))?;
        fs::write(&meta_path, updated)
            .map_err(|error| format!("Failed to write checkpoint meta: {error}"))?;
        Ok(meta)
    })
    .await
    .map_err(|error| format!("Checkpoint rename task failed: {error}"))?
}

/// `/rollback` step 2b: replay the checkpoint through the shared restore
/// pipeline (capability checks, payload classification, driver execution).
/// SQL dumps go through statement splitting as before; JSON snapshots are
/// handed to the driver's `execute_restore_statements`, which replays them
/// as a data-overlay (checkpoint rows over the current state — newer rows
/// are not deleted). Safe Mode is intentionally not re-asserted here: the
/// human confirmed the exact checkpoint through the picker modal, and dump
/// payloads routinely contain parser-hostile or destructive statements that
/// would make the recovery path impossible behind read-only tiers.
#[tauri::command]
pub async fn restore_database_checkpoint(
    connection_id: String,
    file_name: String,
    db_type: DatabaseType,
    db_manager: State<'_, DatabaseManager>,
    safe_mode: State<'_, SafeModeState>,
) -> Result<RestoreResult, String> {
    if !checkpoint_restore_supported(db_type) {
        return Err(format!(
            "Checkpoints cannot be restored on {db_type:?}: the engine has no replay path."
        ));
    }
    db_manager.assert_write_allowed(&connection_id).await?;
    let dir = checkpoint_dir(&connection_id)?;
    let (checkpoint_path, _) = checkpoint_paths(&dir, &file_name)?;
    let connection_id_for_read = connection_id.clone();
    let body = task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        read_checkpoint_body(&connection_id_for_read, &checkpoint_path)
    })
    .await
    .map_err(|_| "Checkpoint read task failed unexpectedly.".to_string())??;
    let body = String::from_utf8(body)
        .map_err(|_| "The checkpoint body is not valid UTF-8.".to_string())?;
    // JSON snapshots replay verbatim — the driver detects the snapshot
    // payload itself (redis/mongo pattern), so no SQL normalization applies.
    let sql = if db_type == DatabaseType::MSSQL && !is_json_snapshot_body(&body) {
        normalize_legacy_mssql_dump(&body)
    } else {
        body
    };

    let mut pre_restore_warning: Option<String> = None;

    // Safety net for the recovery path itself: snapshot the CURRENT state so
    // even a mid-restore failure leaves a fallback checkpoint. Only engines
    // that can lose data on this path pay for it: MSSQL drops tables BEFORE
    // its transactional dump replay, and non-transactional engines apply
    // statement-by-statement. Fully-atomic engines (PostgreSQL/SQLite family)
    // skip the cost. Best effort — a failed snapshot is logged but never
    // blocks recovery (same policy as the agent auto-checkpoint).
    let restore_is_atomic = super::restore::supports_transactional_restore(db_type);
    if db_type != DatabaseType::MSSQL && !restore_is_atomic {
        if let Err(error) =
            capture_pre_restore_safety_snapshot(&connection_id, db_type, &db_manager).await
        {
            log::warn!("pre-restore snapshot failed, continuing rollback anyway: {error}");
            pre_restore_warning = Some(format!(
                "Pre-restore snapshot failed ({error}) — the rollback is running without a fresh fallback point."
            ));
        }
    }

    // MSSQL's pre-drop is destructive and sits OUTSIDE the transactional
    // dump replay, so it always gets its own safety snapshot first. A failed
    // snapshot must be visible to the user — the rollback proceeds unprotected.
    if db_type == DatabaseType::MSSQL {
        if let Err(error) =
            capture_pre_restore_safety_snapshot(&connection_id, db_type, &db_manager).await
        {
            log::warn!("pre-restore snapshot failed, rollback proceeds unprotected: {error}");
            pre_restore_warning = Some(format!(
                "Pre-restore snapshot failed ({error}) — the rollback proceeds unprotected. Create a /backup manually if this rollback misbehaves."
            ));
        }
    }

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
            // Two passes: first try all drops, then retry only the failures
            // (FK order). A table that still refuses to drop after both
            // passes is reported in the restore warnings — silently
            // discarding the error would let the replay hit a leftover table
            // with no hint why.
            let mut pending: Vec<&String> = table_refs.iter().collect();
            for pass in 0..2 {
                let mut still_pending = Vec::new();
                for table_ref in &pending {
                    if let Err(error) = driver
                        .execute_query(&format!("DROP TABLE IF EXISTS {table_ref};"))
                        .await
                    {
                        log::warn!(
                            "pre-drop of {table_ref} failed (pass {}): {error}",
                            pass + 1
                        );
                        still_pending.push(*table_ref);
                    }
                }
                pending = still_pending;
                if pending.is_empty() {
                    break;
                }
                if pass == 0 {
                    // Small delay to let deferred constraint checks settle.
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
            }
            if !pending.is_empty() {
                let warning = format!(
                    "Pre-drop could not remove {} table(s) ({}); the replay may fail on leftover objects.",
                    pending.len(),
                    pending
                        .iter()
                        .map(|name| name.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                );
                log::warn!("{warning}");
                pre_restore_warning = Some(match pre_restore_warning {
                    Some(existing) => format!("{existing} {warning}"),
                    None => warning,
                });
            }
        }
        drop(driver);
    }

    let mut result = run_sql_restore(
        &connection_id,
        &sql,
        db_type,
        &db_manager,
        &safe_mode,
        false,
        false,
        // The rollback path already captured its own pre-restore snapshot
        // BEFORE the destructive pre-drop, so the pipeline must not repeat it.
        PreRestoreSnapshot::CallerManaged,
    )
    .await?;
    result.warning = pre_restore_warning;
    Ok(result)
}

#[cfg(test)]
mod n_prefix_tests {
    use super::*;

    #[test]
    fn legacy_insert_lines_get_n_prefixed_literals() {
        let dump = "INSERT INTO [dbo].[SinhViens] ([HoTen]) VALUES ('Nguy\u{1ec5}n V\u{103}n An');";
        let out = normalize_legacy_mssql_dump(dump);
        assert!(out.contains("VALUES (N'Nguy"), "missing N prefix: {out}");
        assert!(out.contains("An');"));
    }

    #[test]
    fn already_n_prefixed_literals_are_not_double_prefixed() {
        let dump = "INSERT INTO [t] ([a],[b]) VALUES (N'x', 'y');";
        let out = normalize_legacy_mssql_dump(dump);
        assert!(out.contains("(N'x', N'y')"), "mixed prefix wrong: {out}");
        assert!(!out.contains("NN'"), "double prefix: {out}");
    }

    #[test]
    fn escaped_quotes_inside_literals_survive_n_prefixing() {
        let dump = "INSERT INTO [t] ([a]) VALUES ('O''Brien');";
        let out = normalize_legacy_mssql_dump(dump);
        assert!(out.contains("N'O''Brien'"), "escaped quote broken: {out}");
    }
}

#[cfg(test)]
mod n_prefix_multiline_tests {
    use super::*;

    #[test]
    fn multiline_insert_data_rows_get_n_prefixed_too() {
        let dump = "INSERT INTO [dbo].[SinhViens] ([MaSV], [HoTen]) VALUES\n".to_string()
            + "('SV001', 'Nguy\u{1ec5}n V\u{103}n An'),\n"
            + "('SV002', 'Tr\u{1ea7}n Th\u{1ecb} B\u{1ecb}');";
        let out = normalize_legacy_mssql_dump(&dump);
        assert!(
            out.contains("(N'SV001', N'Nguy\u{1ec5}n V\u{103}n An')"),
            "row1: {out}"
        );
        assert!(
            out.contains("(N'SV002', N'Tr\u{1ea7}n Th\u{1ecb} B\u{1ecb}')"),
            "row2: {out}"
        );
    }

    #[test]
    fn object_id_guard_lines_are_not_touched() {
        let dump = "IF OBJECT_ID(N'[dbo].[T]', 'U') IS NULL CREATE TABLE [dbo].[T] ([a] int);";
        let out = normalize_legacy_mssql_dump(dump);
        assert!(
            out.contains("OBJECT_ID(N'[dbo].[T]', 'U')"),
            "guard mangled: {out}"
        );
    }
}
#[cfg(test)]
mod checkpoint_format_tests {
    use super::*;

    #[test]
    fn checkpoint_paths_accept_sql_json_enc_and_reject_other_names() {
        let dir = Path::new("checkpoints");
        for name in ["1-a.sql", "1-a.json", "1-a.enc"] {
            let (body, meta) = checkpoint_paths(dir, name)
                .unwrap_or_else(|error| panic!("{name} rejected: {error}"));
            assert_eq!(body, dir.join(name));
            assert_eq!(meta, dir.join(format!("{name}.meta.json")));
        }
        for name in [
            "1-a.txt",
            "1-a.meta.json",
            "../x.sql",
            "a/b.sql",
            "a\\b.sql",
            "no-extension",
        ] {
            assert!(
                checkpoint_paths(dir, name).is_err(),
                "{name} should be rejected"
            );
        }
    }

    #[test]
    fn json_snapshot_detection_uses_the_snapshot_format_marker() {
        assert!(is_json_snapshot_body(
            r#"{"meta":{"format":"json-snapshot"},"tables":[]}"#
        ));
        // JSON that is not a TableR snapshot stays on the SQL path so it
        // fails honestly in the SQL classifier instead of miscounting.
        assert!(!is_json_snapshot_body(
            r#"{"meta":{"format":"other"},"tables":[]}"#
        ));
        assert!(!is_json_snapshot_body("INSERT INTO t VALUES (1);"));
        assert!(!is_json_snapshot_body("{not valid json"));
    }

    #[test]
    fn json_snapshot_preview_counts_tables_and_rows_as_data_restore() {
        let body = serde_json::json!({
            "meta": {"format": "json-snapshot", "engine": "mongodb"},
            "tables": [
                {"name": "users", "rows": [{"_id": 1}, {"_id": 2}]},
                {"name": "orders", "rows": [{"_id": 9}]},
                {"name": "empty", "rows": []},
            ],
        })
        .to_string();
        let preview = build_json_snapshot_preview(&body).unwrap();
        assert_eq!(preview.statement_count, 3);
        assert_eq!(preview.data_change_count, 3);
        assert_eq!(preview.schema_change_count, 0);
        assert_eq!(preview.destructive_statement_count, 0);
        assert_eq!(preview.unclassified_statement_count, 0);
        assert!(!preview.transactional);
        assert!(preview.warning.is_some());
    }

    #[test]
    fn json_snapshot_preview_rejects_a_missing_tables_array() {
        assert!(build_json_snapshot_preview(r#"{"meta":{"format":"json-snapshot"}}"#).is_err());
    }
    #[test]
    fn only_the_read_only_search_engines_are_blocked_from_checkpointing() {
        // OpenSearch and the Elasticsearch bridge share the read-only search
        // transport — restore.rs refuses them, so checkpoints must too.
        assert!(!checkpoint_restore_supported(DatabaseType::OpenSearch));
        assert!(!checkpoint_restore_supported(DatabaseType::Elasticsearch));
        for db_type in [
            DatabaseType::MySQL,
            DatabaseType::PostgreSQL,
            DatabaseType::MSSQL,
            DatabaseType::SQLite,
            DatabaseType::MongoDB,
            DatabaseType::DynamoDB,
            DatabaseType::Redis,
            DatabaseType::Cassandra,
        ] {
            assert!(
                checkpoint_restore_supported(db_type),
                "{db_type:?} should checkpoint"
            );
        }
    }
}
