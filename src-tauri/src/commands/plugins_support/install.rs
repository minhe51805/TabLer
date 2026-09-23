//! Plugin install lifecycle: staging a validated bundle into place, computing
//! rollback paths, and syncing the installed-plugin records on disk.

use crate::database::sidecar::{platform_target, sidecar_executable_path};
use crate::storage::plugin_storage::{InstalledPluginRecord, PluginStorage};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

use super::bundle::validate_bundle;
use super::{copy_dir_recursive, now_unix_seconds, remove_dir_if_exists};

pub(crate) fn rollback_path(storage: &PluginStorage, plugin_id: &str) -> PathBuf {
    storage
        .rollback_dir()
        .join(format!("{plugin_id}.tableplugin"))
}

pub(crate) fn verify_installed_record(mut record: InstalledPluginRecord) -> InstalledPluginRecord {
    match validate_bundle(Path::new(&record.bundle_path)) {
        Ok(validated) if validated.manifest.id == record.manifest.id => {
            record.manifest = validated.manifest;
            record.computed_integrity = Some(validated.digest);
            record.verified = true;
            record.validation_error = None;
        }
        Ok(_) => {
            record.enabled = false;
            record.verified = false;
            record.validation_error =
                Some("Installed plugin id no longer matches its record.".to_string());
        }
        Err(error) => {
            record.enabled = false;
            record.verified = false;
            record.validation_error = Some(error);
        }
    }
    mark_missing_platform_binary(&mut record);
    record
}

/// A `driver-sidecar-v1` bundle is only usable when it ships a
/// `bin/<os>-<arch>/` executable for the running platform. A digest-valid
/// bundle without one can never connect, so the record is marked incomplete —
/// the picker shows "missing binary" instead of flipping the engine to Ready
/// or asking the user to enable a plugin that cannot run. The marker phrase
/// "no binary for this platform" is load-bearing: the frontend keys the
/// "incomplete" availability state off it (MISSING_PLATFORM_BINARY_MARKER).
pub(crate) fn mark_missing_platform_binary(record: &mut InstalledPluginRecord) {
    if !record.verified || record.validation_error.is_some() {
        return;
    }
    let bundle_dir = Path::new(&record.bundle_path);
    let missing = record
        .manifest
        .contributes
        .drivers
        .iter()
        .filter(|driver| driver.runtime == "driver-sidecar-v1")
        .find(|driver| !sidecar_executable_path(bundle_dir, &driver.id).is_file());
    if let Some(driver) = missing {
        record.enabled = false;
        record.verified = false;
        record.validation_error = Some(format!(
            "Install incomplete — no binary for this platform ({}): sidecar '{}' is missing bin/{}/.",
            platform_target(),
            driver.id,
            platform_target()
        ));
    }
}

pub(crate) fn sync_installed_plugins(
    storage: &PluginStorage,
) -> Result<Vec<InstalledPluginRecord>, String> {
    let records = storage
        .load_plugins()
        .map_err(|e| format!("Failed to load installed plugins: {e}"))?;
    let now = now_unix_seconds();
    let synced = records
        .into_iter()
        .filter(|record| Path::new(&record.bundle_path).is_dir())
        .map(|mut record| {
            record.updated_at = now;
            record.rollback_available = rollback_path(storage, &record.manifest.id).is_dir();
            verify_installed_record(record)
        })
        .collect::<Vec<_>>();
    storage
        .save_plugins(&synced)
        .map_err(|e| format!("Failed to save installed plugins: {e}"))?;
    Ok(synced)
}

pub(crate) fn install_bundle_from_path(
    storage: &PluginStorage,
    source_bundle_dir: &Path,
) -> Result<InstalledPluginRecord, String> {
    let source = validate_bundle(source_bundle_dir)?;
    let staging = storage
        .staging_dir()
        .join(format!("{}-{}", source.manifest.id, Uuid::new_v4()));
    copy_dir_recursive(source_bundle_dir, &staging)?;
    let staged = match validate_bundle(&staging) {
        Ok(bundle) => bundle,
        Err(error) => {
            let _ = remove_dir_if_exists(&staging);
            return Err(error);
        }
    };

    let destination = storage
        .bundles_dir()
        .join(format!("{}.tableplugin", staged.manifest.id));
    let rollback = rollback_path(storage, &staged.manifest.id);
    let mut records = storage
        .load_plugins()
        .map_err(|e| format!("Failed to load installed plugins: {e}"))?;
    let existing = records
        .iter()
        .find(|record| record.manifest.id == staged.manifest.id)
        .cloned();

    remove_dir_if_exists(&rollback)?;
    if destination.exists() {
        fs::rename(&destination, &rollback)
            .map_err(|e| format!("Failed to preserve the previous plugin version: {e}"))?;
    }
    if let Err(error) = fs::rename(&staging, &destination) {
        if rollback.exists() {
            let _ = fs::rename(&rollback, &destination);
        }
        let _ = remove_dir_if_exists(&staging);
        return Err(format!(
            "Failed to activate the staged plugin bundle: {error}"
        ));
    }
    let now = now_unix_seconds();
    let mut record = InstalledPluginRecord {
        manifest: staged.manifest,
        bundle_path: destination.to_string_lossy().to_string(),
        enabled: true,
        installed_at: existing.as_ref().map_or(now, |record| record.installed_at),
        updated_at: now,
        verified: true,
        computed_integrity: Some(staged.digest),
        validation_error: None,
        rollback_available: existing.is_some(),
        previous_version: existing.map(|record| record.manifest.version),
    };
    // A sidecar bundle without a binary for this platform must surface as
    // incomplete immediately — not only after the next sync pass.
    mark_missing_platform_binary(&mut record);

    if let Some(index) = records
        .iter()
        .position(|existing| existing.manifest.id == record.manifest.id)
    {
        records[index] = record.clone();
    } else {
        records.push(record.clone());
    }
    if let Err(error) = storage.save_plugins(&records) {
        let _ = remove_dir_if_exists(&destination);
        if rollback.exists() {
            let _ = fs::rename(&rollback, &destination);
        }
        return Err(format!("Failed to save installed plugins: {error}"));
    }
    Ok(record)
}
