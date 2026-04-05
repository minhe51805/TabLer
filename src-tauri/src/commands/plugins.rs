use crate::storage::plugin_storage::{InstalledPluginRecord, PluginManifest, PluginStorage};
use rfd::FileDialog;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;
use tokio::task;

async fn run_blocking_plugin_task<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    task::spawn_blocking(operation)
        .await
        .map_err(|_| "Background plugin task failed unexpectedly.".to_string())?
}

fn now_unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn slugify_plugin_id(value: &str) -> String {
    let mut slug = String::with_capacity(value.len());
    let mut previous_was_separator = false;

    for ch in value.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            previous_was_separator = false;
        } else if !previous_was_separator {
            slug.push('-');
            previous_was_separator = true;
        }
    }

    slug.trim_matches('-').to_string()
}

fn resolve_bundle_source(root: &Path) -> Result<(PathBuf, PathBuf), String> {
    let direct_manifest = root.join("plugin.json");
    if direct_manifest.exists() {
        return Ok((root.to_path_buf(), direct_manifest));
    }

    let nested_bundle = root.join(".tableplugin");
    let nested_manifest = nested_bundle.join("plugin.json");
    if nested_manifest.exists() {
        return Ok((nested_bundle, nested_manifest));
    }

    Err("Selected folder is not a valid TableR plugin bundle.".to_string())
}

fn read_plugin_manifest(manifest_path: &Path) -> Result<PluginManifest, String> {
    let raw = fs::read_to_string(manifest_path)
        .map_err(|e| format!("Failed to read plugin manifest: {e}"))?;
    let mut manifest = serde_json::from_str::<PluginManifest>(&raw)
        .map_err(|e| format!("Failed to parse plugin manifest: {e}"))?;

    if manifest.id.trim().is_empty() {
        manifest.id = slugify_plugin_id(&manifest.name);
    } else {
        manifest.id = slugify_plugin_id(&manifest.id);
    }

    if manifest.id.is_empty() {
        return Err("Plugin manifest requires a non-empty id or name.".to_string());
    }

    if manifest.name.trim().is_empty() {
        return Err("Plugin manifest requires a non-empty name.".to_string());
    }

    if manifest.version.trim().is_empty() {
        return Err("Plugin manifest requires a version.".to_string());
    }

    if manifest.kind.trim().is_empty() {
        manifest.kind = "tooling".to_string();
    }

    Ok(manifest)
}

fn copy_dir_recursive(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.exists() {
        return Err(format!("Plugin bundle source '{}' does not exist.", source.display()));
    }

    fs::create_dir_all(destination)
        .map_err(|e| format!("Failed to create plugin destination '{}': {e}", destination.display()))?;

    for entry in fs::read_dir(source)
        .map_err(|e| format!("Failed to read plugin bundle directory '{}': {e}", source.display()))?
    {
        let entry = entry.map_err(|e| format!("Failed to read plugin bundle entry: {e}"))?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());

        if source_path.is_dir() {
            copy_dir_recursive(&source_path, &destination_path)?;
        } else {
            if let Some(parent) = destination_path.parent() {
                fs::create_dir_all(parent).map_err(|e| {
                    format!(
                        "Failed to create plugin bundle parent directory '{}': {e}",
                        parent.display()
                    )
                })?;
            }
            fs::copy(&source_path, &destination_path).map_err(|e| {
                format!(
                    "Failed to copy plugin file '{}' to '{}': {e}",
                    source_path.display(),
                    destination_path.display()
                )
            })?;
        }
    }

    Ok(())
}

fn remove_dir_if_exists(path: &Path) -> Result<(), String> {
    if path.exists() {
        fs::remove_dir_all(path)
            .map_err(|e| format!("Failed to remove plugin bundle '{}': {e}", path.display()))?;
    }
    Ok(())
}

fn sync_installed_plugins(storage: &PluginStorage) -> Result<Vec<InstalledPluginRecord>, String> {
    let current_records = storage
        .load_plugins()
        .map_err(|e| format!("Failed to load installed plugins: {e}"))?;

    let mut synced = Vec::with_capacity(current_records.len());
    let now = now_unix_seconds();

    for record in current_records {
        let bundle_path = PathBuf::from(&record.bundle_path);
        let manifest_path = bundle_path.join("plugin.json");
        if !bundle_path.exists() || !manifest_path.exists() {
            continue;
        }

        let manifest = read_plugin_manifest(&manifest_path)?;
        synced.push(InstalledPluginRecord {
            manifest,
            bundle_path: bundle_path.to_string_lossy().to_string(),
            enabled: record.enabled,
            installed_at: record.installed_at,
            updated_at: now,
        });
    }

    storage
        .save_plugins(&synced)
        .map_err(|e| format!("Failed to save installed plugins: {e}"))?;

    Ok(synced)
}

#[tauri::command]
pub async fn list_installed_plugins(
    plugin_storage: State<'_, PluginStorage>,
) -> Result<Vec<InstalledPluginRecord>, String> {
    let storage = plugin_storage.inner().clone();
    run_blocking_plugin_task(move || sync_installed_plugins(&storage)).await
}

#[tauri::command]
pub async fn install_plugin_bundle(
    plugin_storage: State<'_, PluginStorage>,
) -> Result<InstalledPluginRecord, String> {
    let selected_folder = FileDialog::new()
        .pick_folder()
        .ok_or_else(|| "No plugin bundle selected.".to_string())?;

    let storage = plugin_storage.inner().clone();
    run_blocking_plugin_task(move || {
        let (source_bundle_dir, manifest_path) = resolve_bundle_source(&selected_folder)?;
        let manifest = read_plugin_manifest(&manifest_path)?;
        let destination_bundle_dir = storage
            .bundles_dir()
            .join(format!("{}.tableplugin", manifest.id));

        remove_dir_if_exists(&destination_bundle_dir)?;
        copy_dir_recursive(&source_bundle_dir, &destination_bundle_dir)?;

        let mut records = storage
            .load_plugins()
            .map_err(|e| format!("Failed to load installed plugins: {e}"))?;
        let now = now_unix_seconds();
        let record = InstalledPluginRecord {
            manifest,
            bundle_path: destination_bundle_dir.to_string_lossy().to_string(),
            enabled: true,
            installed_at: now,
            updated_at: now,
        };

        if let Some(existing_index) = records
            .iter()
            .position(|existing| existing.manifest.id == record.manifest.id)
        {
            records[existing_index] = record.clone();
        } else {
            records.push(record.clone());
        }

        storage
            .save_plugins(&records)
            .map_err(|e| format!("Failed to save installed plugins: {e}"))?;

        Ok(record)
    })
    .await
}

#[tauri::command]
pub async fn set_plugin_enabled(
    plugin_id: String,
    enabled: bool,
    plugin_storage: State<'_, PluginStorage>,
) -> Result<InstalledPluginRecord, String> {
    let storage = plugin_storage.inner().clone();
    run_blocking_plugin_task(move || {
        let mut records = storage
            .load_plugins()
            .map_err(|e| format!("Failed to load installed plugins: {e}"))?;
        let target = records
            .iter_mut()
            .find(|record| record.manifest.id == plugin_id)
            .ok_or_else(|| format!("Plugin '{}' not found.", plugin_id))?;

        target.enabled = enabled;
        target.updated_at = now_unix_seconds();
        let result = target.clone();

        storage
            .save_plugins(&records)
            .map_err(|e| format!("Failed to save installed plugins: {e}"))?;

        Ok(result)
    })
    .await
}

#[tauri::command]
pub async fn uninstall_plugin_bundle(
    plugin_id: String,
    plugin_storage: State<'_, PluginStorage>,
) -> Result<(), String> {
    let storage = plugin_storage.inner().clone();
    run_blocking_plugin_task(move || {
        let mut records = storage
            .load_plugins()
            .map_err(|e| format!("Failed to load installed plugins: {e}"))?;
        let existing = records
            .iter()
            .find(|record| record.manifest.id == plugin_id)
            .cloned()
            .ok_or_else(|| format!("Plugin '{}' not found.", plugin_id))?;

        remove_dir_if_exists(Path::new(&existing.bundle_path))?;
        records.retain(|record| record.manifest.id != plugin_id);

        storage
            .save_plugins(&records)
            .map_err(|e| format!("Failed to save installed plugins: {e}"))?;

        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn reload_installed_plugins(
    plugin_storage: State<'_, PluginStorage>,
) -> Result<Vec<InstalledPluginRecord>, String> {
    let storage = plugin_storage.inner().clone();
    run_blocking_plugin_task(move || sync_installed_plugins(&storage)).await
}
