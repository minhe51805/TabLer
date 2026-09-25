//! Rewind checkpoints — encrypted pre-image snapshots of rows a grid write is
//! about to change, so the user can undo a committed update/delete.
//!
//! Layout: `<data_dir>/rewind-checkpoints/<connection_id>/<checkpoint_id>.chk`.
//! Each file is a JSON payload encrypted by `checkpoint_crypto`
//! (AES-256-GCM, data key in the OS keyring, per-connection AAD) — the same
//! scheme export checkpoints already use. Listing decrypts every file in the
//! connection dir; a blob that fails authentication is skipped with a warning,
//! not surfaced as a fatal listing error.
//!
//! Retention: newest `MAX_CHECKPOINTS_PER_CONNECTION` are kept; older files are
//! deleted on save so disk usage stays bounded.
use crate::commands::checkpoint_crypto::{decrypt_checkpoint_payload, encrypt_checkpoint_payload};
use crate::database::models::RowKeyValue;
use crate::utils::paths::resolve_data_dir;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const MAX_CHECKPOINTS_PER_CONNECTION: usize = 20;
const CHECKPOINT_DIR: &str = "rewind-checkpoints";
const CHECKPOINT_EXT: &str = "chk";

/// Which grid write produced this checkpoint. Restore maps:
/// Update → re-apply captured old values via the atomic update path,
/// Delete → re-insert captured rows, Insert → delete the captured keys.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CheckpointKind {
    Update,
    Delete,
    Insert,
}

/// One captured row: the primary-key selector that found it plus the cell
/// values captured at write time.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredRow {
    /// The PK selector used to find the row (same shape the write carried).
    pub selector: Vec<RowKeyValue>,
    /// Captured `(column, value)` cells — full row for Delete checkpoints,
    /// only the changed columns for Update checkpoints.
    pub values: Vec<(String, serde_json::Value)>,
}

/// The encrypted payload written to disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RewindCheckpoint {
    pub id: String,
    pub connection_id: String,
    pub table: String,
    pub database: Option<String>,
    pub kind: CheckpointKind,
    /// Columns the write touched (Update only — drives which cells get
    /// restored; Delete/Insert restore ignores it).
    pub changed_columns: Vec<String>,
    pub rows: Vec<StoredRow>,
    pub created_at_ms: u64,
}

/// What the list command returns — payload minus row bodies.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RewindCheckpointInfo {
    pub id: String,
    pub table_name: String,
    pub database: Option<String>,
    pub kind: CheckpointKind,
    pub row_count: usize,
    pub created_at_ms: u64,
}

fn connection_checkpoint_dir(data_dir: &Path, connection_id: &str) -> PathBuf {
    data_dir.join(CHECKPOINT_DIR).join(connection_id)
}

fn checkpoint_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.{CHECKPOINT_EXT}"))
}

fn sanitize_id(id: &str) -> Result<String, String> {
    let trimmed = id.trim();
    if trimmed.is_empty()
        || trimmed == "."
        || trimmed == ".."
        || trimmed.contains('/')
        || trimmed.contains('\\')
    {
        return Err("Invalid checkpoint id.".to_string());
    }
    Ok(trimmed.to_string())
}

/// Persist a checkpoint for `connection_id`; encrypts before touching disk.
/// Prunes oldest siblings past the retention cap.
pub fn save_checkpoint(
    connection_id: &str,
    table: &str,
    database: Option<&str>,
    kind: CheckpointKind,
    changed_columns: Vec<String>,
    rows: Vec<StoredRow>,
) -> Result<RewindCheckpointInfo, String> {
    let data_dir = resolve_data_dir().map_err(|error| error.to_string())?;
    save_checkpoint_in(
        &data_dir,
        connection_id,
        table,
        database,
        kind,
        changed_columns,
        rows,
    )
}

/// `data_dir`-parameterized variant for tests — same body as `save_checkpoint`.
pub fn save_checkpoint_in(
    data_dir: &Path,
    connection_id: &str,
    table: &str,
    database: Option<&str>,
    kind: CheckpointKind,
    changed_columns: Vec<String>,
    rows: Vec<StoredRow>,
) -> Result<RewindCheckpointInfo, String> {
    if rows.is_empty() {
        return Err("A rewind checkpoint needs at least one captured row.".to_string());
    }
    let dir = connection_checkpoint_dir(data_dir, connection_id);
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("Failed to create checkpoint directory: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }

    let checkpoint = RewindCheckpoint {
        id: uuid::Uuid::new_v4().to_string(),
        connection_id: connection_id.to_string(),
        table: table.to_string(),
        database: database.map(str::to_string),
        kind,
        changed_columns,
        rows,
        created_at_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    };
    let payload = serde_json::to_vec(&checkpoint)
        .map_err(|error| format!("Failed to serialize checkpoint: {error}"))?;
    let blob = encrypt_checkpoint_payload(connection_id, &payload)?;
    // Staging + rename so a crash mid-write cannot leave a half checkpoint.
    let path = checkpoint_path(&dir, &checkpoint.id);
    let staging = path.with_extension("chk.tmp");
    std::fs::write(&staging, &blob)
        .map_err(|error| format!("Failed to write checkpoint staging file: {error}"))?;
    if let Err(error) = std::fs::rename(&staging, &path) {
        let _ = std::fs::remove_file(&staging);
        return Err(format!("Failed to finalize checkpoint write: {error}"));
    }

    prune_checkpoints(&dir);
    Ok(RewindCheckpointInfo {
        id: checkpoint.id,
        table_name: checkpoint.table,
        database: checkpoint.database,
        kind: checkpoint.kind,
        row_count: checkpoint.rows.len(),
        created_at_ms: checkpoint.created_at_ms,
    })
}

fn read_checkpoint_file(
    dir: &Path,
    connection_id: &str,
    file_name: &str,
) -> Result<RewindCheckpoint, String> {
    let path = dir.join(file_name);
    let blob =
        std::fs::read(&path).map_err(|error| format!("Failed to read checkpoint: {error}"))?;
    let payload = decrypt_checkpoint_payload(connection_id, &blob)?;
    serde_json::from_slice(&payload)
        .map_err(|error| format!("Failed to parse checkpoint {file_name}: {error}"))
}

/// List checkpoints for a connection, newest first. Undecryptable or corrupt
/// files are skipped — a poisoned blob must not hide the rest.
pub fn list_checkpoints(connection_id: &str) -> Result<Vec<RewindCheckpointInfo>, String> {
    let data_dir = resolve_data_dir().map_err(|error| error.to_string())?;
    list_checkpoints_in(&data_dir, connection_id)
}

pub fn list_checkpoints_in(
    data_dir: &Path,
    connection_id: &str,
) -> Result<Vec<RewindCheckpointInfo>, String> {
    let dir = connection_checkpoint_dir(data_dir, connection_id);
    let mut infos = Vec::new();
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(infos),
        Err(error) => return Err(format!("Failed to list checkpoints: {error}")),
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(&format!(".{CHECKPOINT_EXT}")) {
            continue;
        }
        match read_checkpoint_file(&dir, connection_id, &name) {
            Ok(checkpoint) => infos.push(RewindCheckpointInfo {
                id: checkpoint.id,
                table_name: checkpoint.table,
                database: checkpoint.database,
                kind: checkpoint.kind,
                row_count: checkpoint.rows.len(),
                created_at_ms: checkpoint.created_at_ms,
            }),
            Err(error) => {
                eprintln!("[tabler] skipping unreadable rewind checkpoint {name}: {error}");
            }
        }
    }
    infos.sort_by_key(|i| std::cmp::Reverse(i.created_at_ms));
    Ok(infos)
}

/// Load the full checkpoint payload for restore.
pub fn load_checkpoint(connection_id: &str, id: &str) -> Result<RewindCheckpoint, String> {
    let data_dir = resolve_data_dir().map_err(|error| error.to_string())?;
    load_checkpoint_in(&data_dir, connection_id, id)
}

pub fn load_checkpoint_in(
    data_dir: &Path,
    connection_id: &str,
    id: &str,
) -> Result<RewindCheckpoint, String> {
    let id = sanitize_id(id)?;
    let dir = connection_checkpoint_dir(data_dir, connection_id);
    let file_name = format!("{id}.{CHECKPOINT_EXT}");
    read_checkpoint_file(&dir, connection_id, &file_name)
}

pub fn delete_checkpoint(connection_id: &str, id: &str) -> Result<bool, String> {
    let data_dir = resolve_data_dir().map_err(|error| error.to_string())?;
    delete_checkpoint_in(&data_dir, connection_id, id)
}

pub fn delete_checkpoint_in(
    data_dir: &Path,
    connection_id: &str,
    id: &str,
) -> Result<bool, String> {
    let id = sanitize_id(id)?;
    let path = checkpoint_path(&connection_checkpoint_dir(data_dir, connection_id), &id);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("Failed to delete checkpoint: {error}")),
    }
}

/// Keep the newest `MAX_CHECKPOINTS_PER_CONNECTION`; delete the rest. Failure
/// to prune is non-fatal — an old checkpoint is stale data, not corruption.
fn prune_checkpoints(dir: &Path) {
    let mut files: Vec<(PathBuf, std::time::SystemTime)> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some(CHECKPOINT_EXT) {
                return None;
            }
            let modified = entry
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            Some((path, modified))
        })
        .collect();
    if files.len() <= MAX_CHECKPOINTS_PER_CONNECTION {
        return;
    }
    files.sort_by_key(|f| std::cmp::Reverse(f.1));
    for (path, _) in files.split_off(MAX_CHECKPOINTS_PER_CONNECTION) {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::models::RowKeyValue;
    use std::sync::Once;

    static KEYRING_INIT: Once = Once::new();

    fn use_mock_keyring() {
        KEYRING_INIT.call_once(|| {
            keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
        });
    }

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tabler-rewind-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample_row(id: i64, content: &str) -> StoredRow {
        StoredRow {
            selector: vec![RowKeyValue {
                column: "id".into(),
                value: serde_json::json!(id),
            }],
            values: vec![
                ("id".into(), serde_json::json!(id)),
                ("content".into(), serde_json::json!(content)),
            ],
        }
    }

    #[test]
    fn save_list_load_delete_round_trip() {
        use_mock_keyring();
        let root = temp_root("roundtrip");
        let info = save_checkpoint_in(
            &root,
            "conn-1",
            "comments",
            None,
            CheckpointKind::Delete,
            Vec::new(),
            vec![sample_row(1, "gone"), sample_row(2, "also gone")],
        )
        .unwrap();
        assert_eq!(info.row_count, 2);
        assert_eq!(info.table_name, "comments");

        let list = list_checkpoints_in(&root, "conn-1").unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, info.id);
        assert_eq!(list[0].kind, CheckpointKind::Delete);

        let loaded = load_checkpoint_in(&root, "conn-1", &info.id).unwrap();
        assert_eq!(loaded.rows.len(), 2);
        assert_eq!(loaded.rows[0].values[1].1, serde_json::json!("gone"));

        assert!(delete_checkpoint_in(&root, "conn-1", &info.id).unwrap());
        assert!(list_checkpoints_in(&root, "conn-1").unwrap().is_empty());
        // Second delete is idempotent.
        assert!(!delete_checkpoint_in(&root, "conn-1", &info.id).unwrap());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn checkpoints_are_connection_scoped_and_encrypted() {
        use_mock_keyring();
        let root = temp_root("scoped");
        save_checkpoint_in(
            &root,
            "conn-a",
            "t",
            None,
            CheckpointKind::Update,
            vec!["c".into()],
            vec![sample_row(1, "v")],
        )
        .unwrap();
        // Different connection sees an empty list — AAD binds the blob.
        assert!(list_checkpoints_in(&root, "conn-b").unwrap().is_empty());
        // A blob read directly is ciphertext, not JSON.
        let dir = root.join(CHECKPOINT_DIR).join("conn-a");
        let blob = std::fs::read(dir.read_dir().unwrap().next().unwrap().unwrap().path()).unwrap();
        assert!(blob.starts_with(b"TCK1"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn list_skips_corrupt_files() {
        use_mock_keyring();
        let root = temp_root("corrupt");
        save_checkpoint_in(
            &root,
            "conn-1",
            "t",
            None,
            CheckpointKind::Delete,
            Vec::new(),
            vec![sample_row(9, "keep")],
        )
        .unwrap();
        let dir = root.join(CHECKPOINT_DIR).join("conn-1");
        std::fs::write(dir.join("broken.chk"), b"TCK1-garbage").unwrap();
        let list = list_checkpoints_in(&root, "conn-1").unwrap();
        assert_eq!(list.len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn retention_prunes_oldest_checkpoints() {
        use_mock_keyring();
        let root = temp_root("retention");
        for i in 0..(MAX_CHECKPOINTS_PER_CONNECTION + 3) {
            save_checkpoint_in(
                &root,
                "conn-1",
                "t",
                None,
                CheckpointKind::Delete,
                Vec::new(),
                vec![sample_row(i as i64, "row")],
            )
            .unwrap();
            // Distinct mtimes so prune ordering is deterministic.
            std::thread::sleep(std::time::Duration::from_millis(15));
        }
        let list = list_checkpoints_in(&root, "conn-1").unwrap();
        assert_eq!(list.len(), MAX_CHECKPOINTS_PER_CONNECTION);
        let _ = std::fs::remove_dir_all(&root);
    }
}
