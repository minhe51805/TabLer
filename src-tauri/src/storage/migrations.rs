use crate::storage::file_storage::{backup_path_for, write_json_atomically};
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

const CURRENT_STORAGE_SCHEMA_VERSION: u32 = 1;
const MANIFEST_FILE: &str = "storage-schema.json";
const JOURNAL_FILE: &str = "storage-migration-journal.json";
const BACKUP_DIR: &str = "storage-migration-backups";

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StorageSchemaManifest {
    version: u32,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MigrationJournal {
    from_version: u32,
    to_version: u32,
    backup_id: String,
}

pub fn run_storage_migrations(data_dir: &Path) -> Result<()> {
    fs::create_dir_all(data_dir).with_context(|| {
        format!(
            "Failed to create TableR data directory '{}'",
            data_dir.display()
        )
    })?;

    recover_interrupted_migration(data_dir)?;
    let version = read_manifest_version(data_dir)?;
    if version > CURRENT_STORAGE_SCHEMA_VERSION {
        return Err(anyhow!(
            "TableR data uses storage schema v{version}, but this build only supports up to v{CURRENT_STORAGE_SCHEMA_VERSION}. Install a newer TableR build; this version will not modify the data."
        ));
    }
    if version == CURRENT_STORAGE_SCHEMA_VERSION {
        return Ok(());
    }

    let backup_id = format!(
        "v{version}-to-v{}-{}",
        CURRENT_STORAGE_SCHEMA_VERSION,
        Uuid::new_v4()
    );
    create_snapshot(data_dir, &backup_id)?;
    let journal = MigrationJournal {
        from_version: version,
        to_version: CURRENT_STORAGE_SCHEMA_VERSION,
        backup_id,
    };
    write_json(&data_dir.join(JOURNAL_FILE), &journal)?;

    migrate(version, CURRENT_STORAGE_SCHEMA_VERSION)?;
    write_json(
        &data_dir.join(MANIFEST_FILE),
        &StorageSchemaManifest {
            version: CURRENT_STORAGE_SCHEMA_VERSION,
        },
    )?;
    remove_file_and_backup(&data_dir.join(JOURNAL_FILE))?;
    Ok(())
}

fn read_manifest_version(data_dir: &Path) -> Result<u32> {
    let path = data_dir.join(MANIFEST_FILE);
    if !path.exists() {
        return Ok(0);
    }
    let bytes = fs::read(&path)
        .with_context(|| format!("Failed to read storage manifest '{}'", path.display()))?;
    let manifest: StorageSchemaManifest = serde_json::from_slice(&bytes).with_context(|| {
        format!(
            "Storage manifest '{}' is corrupt. TableR left all persisted data unchanged.",
            path.display()
        )
    })?;
    Ok(manifest.version)
}

fn migrate(from_version: u32, to_version: u32) -> Result<()> {
    match (from_version, to_version) {
        (0, 1) => Ok(()),
        _ => Err(anyhow!(
            "No storage migration path exists from v{from_version} to v{to_version}"
        )),
    }
}

fn create_snapshot(data_dir: &Path, backup_id: &str) -> Result<()> {
    let snapshot_dir = data_dir.join(BACKUP_DIR).join(backup_id);
    fs::create_dir_all(&snapshot_dir).with_context(|| {
        format!(
            "Failed to create migration backup '{}'",
            snapshot_dir.display()
        )
    })?;
    for entry in fs::read_dir(data_dir)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() || !should_snapshot(&path) {
            continue;
        }
        fs::copy(&path, snapshot_dir.join(entry.file_name()))
            .with_context(|| format!("Failed to back up persisted file '{}'", path.display()))?;
    }
    Ok(())
}

fn should_snapshot(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    name != MANIFEST_FILE
        && name != JOURNAL_FILE
        && !name.ends_with(".lock")
        && !name.ends_with(".tmp")
}

fn recover_interrupted_migration(data_dir: &Path) -> Result<()> {
    let journal_path = data_dir.join(JOURNAL_FILE);
    if !journal_path.exists() {
        return Ok(());
    }
    let bytes = fs::read(&journal_path).with_context(|| {
        format!(
            "Failed to read migration journal '{}'",
            journal_path.display()
        )
    })?;
    let journal: MigrationJournal = serde_json::from_slice(&bytes).with_context(|| {
        format!(
            "Migration journal '{}' is corrupt. TableR will not guess at recovery or modify persisted data.",
            journal_path.display()
        )
    })?;

    if read_manifest_version(data_dir)? == journal.to_version {
        remove_file_and_backup(&journal_path)?;
        return Ok(());
    }

    let snapshot_dir = safe_snapshot_dir(data_dir, &journal.backup_id)?;
    if !snapshot_dir.is_dir() {
        return Err(anyhow!(
            "Interrupted storage migration cannot be recovered because backup '{}' is missing.",
            snapshot_dir.display()
        ));
    }
    for entry in fs::read_dir(&snapshot_dir)? {
        let entry = entry?;
        if entry.path().is_file() {
            fs::copy(entry.path(), data_dir.join(entry.file_name())).with_context(|| {
                format!(
                    "Failed to restore migration backup '{}'.",
                    entry.path().display()
                )
            })?;
        }
    }
    remove_file_and_backup(&journal_path)?;
    Ok(())
}

fn safe_snapshot_dir(data_dir: &Path, backup_id: &str) -> Result<PathBuf> {
    if backup_id.is_empty()
        || backup_id.contains('/')
        || backup_id.contains('\\')
        || backup_id == "."
        || backup_id == ".."
    {
        return Err(anyhow!(
            "Migration journal contains an invalid backup identifier."
        ));
    }
    Ok(data_dir.join(BACKUP_DIR).join(backup_id))
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let json = serde_json::to_string_pretty(value)? + "\n";
    write_json_atomically(path, &json)
}

fn remove_file_and_backup(path: &Path) -> Result<()> {
    if path.exists() {
        fs::remove_file(path)?;
    }
    let backup = backup_path_for(path);
    if backup.exists() {
        fs::remove_file(backup)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("tabler-migration-{name}-{}", Uuid::new_v4()))
    }

    #[test]
    fn upgrades_legacy_state_and_keeps_a_snapshot() {
        let root = fixture("upgrade");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("connections.json"), "[]").unwrap();

        run_storage_migrations(&root).unwrap();

        assert_eq!(read_manifest_version(&root).unwrap(), 1);
        let backups = fs::read_dir(root.join(BACKUP_DIR)).unwrap().count();
        assert_eq!(backups, 1);
        assert_eq!(
            fs::read_to_string(root.join("connections.json")).unwrap(),
            "[]"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn restores_an_interrupted_upgrade_before_retrying() {
        let root = fixture("interrupted");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("connections.json"), "original").unwrap();
        create_snapshot(&root, "fixture-backup").unwrap();
        write_json(
            &root.join(JOURNAL_FILE),
            &MigrationJournal {
                from_version: 0,
                to_version: 1,
                backup_id: "fixture-backup".to_string(),
            },
        )
        .unwrap();
        fs::write(root.join("connections.json"), "partial").unwrap();

        run_storage_migrations(&root).unwrap();

        assert_eq!(
            fs::read_to_string(root.join("connections.json")).unwrap(),
            "original"
        );
        assert_eq!(read_manifest_version(&root).unwrap(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupt_manifest_fails_without_touching_data() {
        let root = fixture("corrupt");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(MANIFEST_FILE), "not-json").unwrap();
        fs::write(root.join("connections.json"), "important").unwrap();

        let error = run_storage_migrations(&root).unwrap_err().to_string();

        assert!(error.contains("corrupt"));
        assert_eq!(
            fs::read_to_string(root.join("connections.json")).unwrap(),
            "important"
        );
        assert!(!root.join(BACKUP_DIR).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn newer_state_rejects_unsupported_downgrade() {
        let root = fixture("downgrade");
        fs::create_dir_all(&root).unwrap();
        write_json(
            &root.join(MANIFEST_FILE),
            &StorageSchemaManifest { version: 99 },
        )
        .unwrap();

        let error = run_storage_migrations(&root).unwrap_err().to_string();

        assert!(error.contains("only supports up to"));
        assert!(!root.join(BACKUP_DIR).exists());
        fs::remove_dir_all(root).unwrap();
    }
}
