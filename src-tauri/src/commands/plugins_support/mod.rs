//! Support helpers for the `plugins` command module. Shared low-level
//! utilities live here; each concern (manifest, bundle, install, driver,
//! registry) lives in its own submodule and is re-exported so the `plugins`
//! command file keeps a single flat import surface.

use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::task;

mod bundle;
mod driver;
mod install;
mod manifest;
mod registry;
#[cfg(test)]
mod tests;

// Active-driver resolution consumed crate-wide (re-exported again by `plugins`).
pub(crate) use driver::{resolve_active_plugin_driver, resolve_active_sidecar};

// Helpers the sibling `plugins` command file reaches through its glob import.
pub(super) use bundle::{resolve_bundle_source, validate_bundle};
pub(super) use install::{
    install_bundle_from_path, mark_missing_platform_binary, rollback_path, sync_installed_plugins,
    verify_installed_record,
};
pub(super) use registry::{
    fetch_registry_index, latest_compatible_package, materialize_registry_package,
};

// Reached only by `plugins`' own unit tests; gate the re-exports so normal
// builds stay free of unused re-exports (each helper still has a production
// caller inside this module).
#[cfg(test)]
pub(super) use bundle::compute_bundle_digest;
#[cfg(test)]
pub(super) use manifest::{validate_contributions, validate_manifest};
#[cfg(test)]
pub(super) use registry::{validate_https_url, validate_registry};

pub(super) async fn run_blocking_plugin_task<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    task::spawn_blocking(operation)
        .await
        .map_err(|_| "Background plugin task failed unexpectedly.".to_string())?
}

pub(super) fn now_unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

pub(super) fn slugify_plugin_id(value: &str) -> String {
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

pub(super) fn copy_dir_recursive(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.is_dir() {
        return Err(format!(
            "Plugin bundle source '{}' does not exist.",
            source.display()
        ));
    }
    fs::create_dir_all(destination).map_err(|e| {
        format!(
            "Failed to create plugin destination '{}': {e}",
            destination.display()
        )
    })?;
    for entry in fs::read_dir(source).map_err(|e| {
        format!(
            "Failed to read plugin bundle directory '{}': {e}",
            source.display()
        )
    })? {
        let entry = entry.map_err(|e| format!("Failed to read plugin bundle entry: {e}"))?;
        let metadata = fs::symlink_metadata(entry.path())
            .map_err(|e| format!("Failed to inspect plugin bundle entry: {e}"))?;
        if metadata.file_type().is_symlink() {
            return Err("Plugin bundles cannot contain symbolic links.".to_string());
        }
        let destination_path = destination.join(entry.file_name());
        if metadata.is_dir() {
            copy_dir_recursive(&entry.path(), &destination_path)?;
        } else if metadata.is_file() {
            fs::copy(entry.path(), &destination_path).map_err(|e| {
                format!(
                    "Failed to copy plugin file '{}': {e}",
                    entry.path().display()
                )
            })?;
        }
    }
    Ok(())
}

pub(super) fn remove_dir_if_exists(path: &Path) -> Result<(), String> {
    if path.exists() {
        fs::remove_dir_all(path)
            .map_err(|e| format!("Failed to remove plugin bundle '{}': {e}", path.display()))?;
    }
    Ok(())
}
