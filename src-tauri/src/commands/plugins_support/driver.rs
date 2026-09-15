//! Resolving the active plugin driver and its native sidecar for a connection.

use crate::commands::plugins::ActivePluginDriver;
use crate::storage::plugin_storage::PluginStorage;
use std::path::{Path, PathBuf};

use super::install::sync_installed_plugins;

pub(crate) fn resolve_active_plugin_driver(
    storage: &PluginStorage,
    plugin_id: &str,
    driver_id: &str,
) -> Result<ActivePluginDriver, String> {
    let bundle_root = storage
        .bundles_dir()
        .canonicalize()
        .map_err(|e| format!("Failed to inspect the plugin bundle directory: {e}"))?;
    let records = sync_installed_plugins(storage)?;
    let record = records
        .into_iter()
        .find(|record| record.manifest.id == plugin_id)
        .ok_or_else(|| format!("Required driver plugin '{plugin_id}' is not installed."))?;

    let installed_path = Path::new(&record.bundle_path)
        .canonicalize()
        .map_err(|e| format!("Failed to inspect driver plugin '{plugin_id}': {e}"))?;
    if !installed_path.starts_with(&bundle_root) {
        return Err(format!(
            "Driver plugin '{plugin_id}' is outside the managed plugin directory."
        ));
    }
    if !record.enabled || !record.verified || record.validation_error.is_some() {
        return Err(format!(
            "Driver plugin '{plugin_id}' must be enabled and verified before use."
        ));
    }
    if !record
        .manifest
        .capabilities
        .iter()
        .any(|capability| capability == "database")
    {
        return Err(format!(
            "Driver plugin '{plugin_id}' did not declare the database capability."
        ));
    }

    let contribution = record
        .manifest
        .contributes
        .drivers
        .into_iter()
        .find(|driver| driver.id == driver_id)
        .ok_or_else(|| format!("Plugin '{plugin_id}' does not provide driver '{driver_id}'."))?;
    Ok(ActivePluginDriver {
        plugin_id: record.manifest.id,
        contribution,
    })
}

/// A resolved, verified `driver-sidecar-v1` plugin ready to spawn: the same
/// managed-location / enabled / verified / capability checks as
/// `resolve_active_plugin_driver`, plus the installed bundle directory (needed
/// to locate the per-platform sidecar binary) and a runtime guard.
#[derive(Debug, Clone)]
// Compiled always (for the re-export + unit test) but only *used* by the native
// sidecar fallback in lean builds; allow dead_code so the all-features build,
// which clippy gates with `-D warnings`, stays clean.
#[allow(dead_code)]
pub(crate) struct ResolvedSidecar {
    pub plugin_id: String,
    pub driver_id: String,
    pub bundle_dir: PathBuf,
}

#[allow(dead_code)] // used by the native sidecar fallback (lean builds) + unit tests
pub(crate) fn resolve_active_sidecar(
    storage: &PluginStorage,
    plugin_id: &str,
    driver_id: &str,
) -> Result<ResolvedSidecar, String> {
    let bundle_root = storage
        .bundles_dir()
        .canonicalize()
        .map_err(|e| format!("Failed to inspect the plugin bundle directory: {e}"))?;
    let records = sync_installed_plugins(storage)?;
    let record = records
        .into_iter()
        .find(|record| record.manifest.id == plugin_id)
        .ok_or_else(|| format!("Required driver plugin '{plugin_id}' is not installed."))?;

    let installed_path = Path::new(&record.bundle_path)
        .canonicalize()
        .map_err(|e| format!("Failed to inspect driver plugin '{plugin_id}': {e}"))?;
    if !installed_path.starts_with(&bundle_root) {
        return Err(format!(
            "Driver plugin '{plugin_id}' is outside the managed plugin directory."
        ));
    }
    if !record.enabled || !record.verified || record.validation_error.is_some() {
        return Err(format!(
            "Driver plugin '{plugin_id}' must be enabled and verified before use."
        ));
    }
    if !record
        .manifest
        .capabilities
        .iter()
        .any(|capability| capability == "database")
    {
        return Err(format!(
            "Driver plugin '{plugin_id}' did not declare the database capability."
        ));
    }
    let contribution = record
        .manifest
        .contributes
        .drivers
        .iter()
        .find(|driver| driver.id == driver_id)
        .ok_or_else(|| format!("Plugin '{plugin_id}' does not provide driver '{driver_id}'."))?;
    if contribution.runtime != "driver-sidecar-v1" {
        return Err(format!(
            "Driver '{driver_id}' in plugin '{plugin_id}' is not a driver-sidecar-v1 runtime."
        ));
    }
    Ok(ResolvedSidecar {
        plugin_id: record.manifest.id.clone(),
        driver_id: driver_id.to_string(),
        bundle_dir: installed_path,
    })
}
