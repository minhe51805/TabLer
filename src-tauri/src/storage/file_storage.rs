use anyhow::{Context, Result};
use fs2::FileExt;
use serde::de::DeserializeOwned;
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn backup_path_for(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("storage.json");
    path.with_file_name(format!("{file_name}.bak"))
}

fn lock_path_for(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("storage.json");
    path.with_file_name(format!("{file_name}.lock"))
}

struct StorageFileLock {
    file: File,
}

impl StorageFileLock {
    fn acquire(path: &Path, exclusive: bool) -> Result<Self> {
        let lock_path = lock_path_for(path);
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(&lock_path)
            .with_context(|| {
                format!("Failed to open storage lock file '{}'", lock_path.display())
            })?;

        if exclusive {
            file.lock_exclusive().with_context(|| {
                format!("Failed to acquire exclusive storage lock '{}'", lock_path.display())
            })?;
        } else {
            file.lock_shared().with_context(|| {
                format!("Failed to acquire shared storage lock '{}'", lock_path.display())
            })?;
        }

        Ok(Self { file })
    }
}

impl Drop for StorageFileLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

pub fn read_json_vec_with_backup<T>(path: &Path, parse_context: &str) -> Result<Vec<T>>
where
    T: DeserializeOwned,
{
    let _lock = StorageFileLock::acquire(path, false)?;
    let backup_path = backup_path_for(path);

    if path.exists() {
        match read_json_vec::<T>(path, parse_context) {
            Ok(items) => return Ok(items),
            Err(primary_error) if backup_path.exists() => {
                return read_json_vec::<T>(&backup_path, parse_context).with_context(|| {
                    format!(
                        "{parse_context} (primary file was unreadable: {primary_error})"
                    )
                });
            }
            Err(primary_error) => return Err(primary_error),
        }
    }

    if backup_path.exists() {
        return read_json_vec::<T>(&backup_path, parse_context)
            .with_context(|| format!("{parse_context} (using backup file)"));
    }

    Ok(Vec::new())
}

fn read_json_vec<T>(path: &Path, parse_context: &str) -> Result<Vec<T>>
where
    T: DeserializeOwned,
{
    let content = fs::read_to_string(path).with_context(|| {
        format!("Failed to read storage file '{}'", path.display())
    })?;

    serde_json::from_str(&content).with_context(|| parse_context.to_string())
}

pub fn read_json_map_with_backup<K, V>(
    path: &Path,
    parse_context: &str,
) -> Result<HashMap<K, V>>
where
    K: DeserializeOwned + std::hash::Hash + Eq,
    V: DeserializeOwned,
{
    let _lock = StorageFileLock::acquire(path, false)?;
    let backup_path = backup_path_for(path);

    if path.exists() {
        match read_json_map::<K, V>(path, parse_context) {
            Ok(items) => return Ok(items),
            Err(primary_error) if backup_path.exists() => {
                return read_json_map::<K, V>(&backup_path, parse_context).with_context(|| {
                    format!(
                        "{parse_context} (primary file was unreadable: {primary_error})"
                    )
                });
            }
            Err(primary_error) => return Err(primary_error),
        }
    }

    if backup_path.exists() {
        return read_json_map::<K, V>(&backup_path, parse_context)
            .with_context(|| format!("{parse_context} (using backup file)"));
    }

    Ok(HashMap::new())
}

fn read_json_map<K, V>(path: &Path, parse_context: &str) -> Result<HashMap<K, V>>
where
    K: DeserializeOwned + std::hash::Hash + Eq,
    V: DeserializeOwned,
{
    let content = fs::read_to_string(path).with_context(|| {
        format!("Failed to read storage file '{}'", path.display())
    })?;

    serde_json::from_str(&content).with_context(|| parse_context.to_string())
}

pub fn write_json_atomically(path: &Path, json: &str) -> Result<()> {
    let _lock = StorageFileLock::acquire(path, true)?;
    let parent = path
        .parent()
        .context("Storage path is missing a parent directory")?;
    fs::create_dir_all(parent).with_context(|| {
        format!(
            "Failed to create storage parent directory '{}'",
            parent.display()
        )
    })?;

    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("storage.json");
    let temp_path = parent.join(format!(
        "{file_name}.{}.tmp",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let backup_path = backup_path_for(path);

    {
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .with_context(|| {
                format!(
                    "Failed to open temporary storage file '{}'",
                    temp_path.display()
                )
            })?;
        let mut writer = BufWriter::new(file);
        writer
            .write_all(json.as_bytes())
            .context("Failed to write storage contents to temporary file")?;
        writer
            .flush()
            .context("Failed to flush temporary storage file")?;
        writer
            .get_ref()
            .sync_all()
            .context("Failed to sync temporary storage file")?;
    }

    let had_primary = path.exists();
    if had_primary {
        if backup_path.exists() {
            fs::remove_file(&backup_path).with_context(|| {
                format!(
                    "Failed to remove stale storage backup '{}'",
                    backup_path.display()
                )
            })?;
        }

        fs::rename(path, &backup_path).with_context(|| {
            format!(
                "Failed to rotate storage file '{}' into backup '{}'",
                path.display(),
                backup_path.display()
            )
        })?;
    }

    if let Err(error) = fs::rename(&temp_path, path) {
        let _ = fs::remove_file(&temp_path);
        if had_primary && backup_path.exists() && !path.exists() {
            let _ = fs::rename(&backup_path, path);
        }

        return Err(anyhow::Error::new(error).context(format!(
            "Failed to replace storage file '{}'",
            path.display()
        )));
    }

    if let Ok(file) = OpenOptions::new().read(true).open(path) {
        let _ = file.sync_all();
    }

    Ok(())
}
