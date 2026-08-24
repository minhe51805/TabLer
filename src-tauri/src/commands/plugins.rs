use crate::database::manager::DatabaseManager;
use crate::storage::plugin_storage::{InstalledPluginRecord, PluginManifest, PluginStorage};
use rfd::FileDialog;
use semver::Version;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use super::plugins_support::*;
pub(crate) use super::plugins_support::resolve_active_plugin_driver;
use tauri::State;
use uuid::Uuid;

pub(super) const PLUGIN_API_VERSION: u32 = 1;
pub(super) const MAX_PLUGIN_FILES: usize = 512;
pub(super) const MAX_PLUGIN_BYTES: u64 = 64 * 1024 * 1024;
pub(super) const MAX_REGISTRY_BYTES: u64 = 2 * 1024 * 1024;
pub(super) const DEFAULT_PLUGIN_REGISTRY_URL: &str =
    "https://raw.githubusercontent.com/minhe51805/TabLer/main/plugin-registry.json";
pub(super) const ALLOWED_KINDS: &[&str] = &[
    "tooling",
    "adapter",
    "visualization",
    "ai",
    "export",
    "import",
    "theme",
    "extension",
];
pub(super) const ALLOWED_CAPABILITIES: &[&str] = &[
    "commands",
    "database",
    "export",
    "import",
    "sidebar",
    "ai",
    "theme",
    "autocomplete",
    "file",
];
pub(super) const ALLOWED_PERMISSIONS: &[&str] = &[
    "workspace.read",
    "connection.metadata",
    "query.read",
    "query.execute",
    "network.fetch",
    "file.read",
    "file.write",
    "clipboard.write",
    "notifications",
];

#[derive(Debug)]
pub(super) struct ValidatedBundle {
    pub(super) manifest: PluginManifest,
    pub(super) digest: String,
}

#[derive(Debug, Clone)]
pub(crate) struct ActivePluginDriver {
    pub plugin_id: String,
    pub contribution: crate::storage::plugin_storage::PluginDriverContribution,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRegistryAsset {
    pub path: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRegistryPackage {
    pub manifest: PluginManifest,
    #[serde(default)]
    pub assets: Vec<PluginRegistryAsset>,
    pub published_at: Option<String>,
    pub release_notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRegistryIndex {
    pub schema_version: u32,
    pub generated_at: String,
    #[serde(default)]
    pub packages: Vec<PluginRegistryPackage>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginUpdateCandidate {
    pub plugin_id: String,
    pub installed_version: String,
    pub available_version: String,
    pub package: PluginRegistryPackage,
}


#[tauri::command]
pub async fn get_plugin_registry(
    registry_url: Option<String>,
) -> Result<PluginRegistryIndex, String> {
    fetch_registry_index(registry_url).await
}

#[tauri::command]
pub async fn check_plugin_updates(
    registry_url: Option<String>,
    plugin_storage: State<'_, PluginStorage>,
) -> Result<Vec<PluginUpdateCandidate>, String> {
    let index = fetch_registry_index(registry_url).await?;
    let records = plugin_storage
        .load_plugins()
        .map_err(|e| format!("Failed to load installed plugins: {e}"))?;
    let mut updates = Vec::new();
    for record in records {
        let installed = Version::parse(&record.manifest.version).map_err(|_| {
            format!(
                "Installed plugin '{}' has an invalid version.",
                record.manifest.id
            )
        })?;
        if let Ok(package) = latest_compatible_package(&index, &record.manifest.id) {
            let available = Version::parse(&package.manifest.version)
                .map_err(|_| "Registry returned an invalid version.".to_string())?;
            if available > installed {
                updates.push(PluginUpdateCandidate {
                    plugin_id: record.manifest.id,
                    installed_version: installed.to_string(),
                    available_version: available.to_string(),
                    package: package.clone(),
                });
            }
        }
    }
    Ok(updates)
}

#[tauri::command]
pub async fn install_registry_plugin(
    plugin_id: String,
    registry_url: Option<String>,
    plugin_storage: State<'_, PluginStorage>,
    db_manager: State<'_, DatabaseManager>,
) -> Result<InstalledPluginRecord, String> {
    let index = fetch_registry_index(registry_url).await?;
    let package = latest_compatible_package(&index, &plugin_id)?.clone();
    let storage = plugin_storage.inner().clone();
    let source = materialize_registry_package(&storage, &package).await?;
    let install_source = source.clone();
    let install_storage = storage.clone();
    let result = run_blocking_plugin_task(move || {
        install_bundle_from_path(&install_storage, &install_source)
    })
    .await;
    let _ = remove_dir_if_exists(&source);
    let installed = result?;
    db_manager
        .disconnect_driver_connections(&installed.manifest.id)
        .await;
    Ok(installed)
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
    db_manager: State<'_, DatabaseManager>,
) -> Result<InstalledPluginRecord, String> {
    let selected_folder = FileDialog::new()
        .pick_folder()
        .ok_or_else(|| "No plugin bundle selected.".to_string())?;
    let storage = plugin_storage.inner().clone();
    let installed = run_blocking_plugin_task(move || {
        let (source_bundle_dir, _) = resolve_bundle_source(&selected_folder)?;
        install_bundle_from_path(&storage, &source_bundle_dir)
    })
    .await?;
    db_manager
        .disconnect_driver_connections(&installed.manifest.id)
        .await;
    Ok(installed)
}

#[tauri::command]
pub async fn set_plugin_enabled(
    plugin_id: String,
    enabled: bool,
    plugin_storage: State<'_, PluginStorage>,
    db_manager: State<'_, DatabaseManager>,
) -> Result<InstalledPluginRecord, String> {
    let storage = plugin_storage.inner().clone();
    let updated = run_blocking_plugin_task(move || {
        let mut records = storage
            .load_plugins()
            .map_err(|e| format!("Failed to load installed plugins: {e}"))?;
        let index = records
            .iter()
            .position(|record| record.manifest.id == plugin_id)
            .ok_or_else(|| format!("Plugin '{plugin_id}' not found."))?;
        let mut target = verify_installed_record(records[index].clone());
        if enabled && !target.verified {
            return Err(target
                .validation_error
                .unwrap_or_else(|| "Plugin could not be verified.".to_string()));
        }
        target.enabled = enabled;
        target.updated_at = now_unix_seconds();
        records[index] = target.clone();
        storage
            .save_plugins(&records)
            .map_err(|e| format!("Failed to save installed plugins: {e}"))?;
        Ok(target)
    })
    .await?;
    if !updated.enabled {
        db_manager
            .disconnect_driver_connections(&updated.manifest.id)
            .await;
    }
    Ok(updated)
}

#[tauri::command]
pub async fn rollback_plugin_bundle(
    plugin_id: String,
    plugin_storage: State<'_, PluginStorage>,
    db_manager: State<'_, DatabaseManager>,
) -> Result<InstalledPluginRecord, String> {
    let storage = plugin_storage.inner().clone();
    let restored = run_blocking_plugin_task(move || {
        let mut records = storage
            .load_plugins()
            .map_err(|e| format!("Failed to load installed plugins: {e}"))?;
        let index = records
            .iter()
            .position(|record| record.manifest.id == plugin_id)
            .ok_or_else(|| format!("Plugin '{plugin_id}' not found."))?;
        let destination = PathBuf::from(&records[index].bundle_path);
        let rollback = rollback_path(&storage, &plugin_id);
        if !rollback.is_dir() {
            return Err(format!("Plugin '{plugin_id}' has no rollback version."));
        }
        let validated = validate_bundle(&rollback)?;
        if validated.manifest.id != plugin_id {
            return Err("Rollback bundle id does not match the installed plugin.".to_string());
        }

        let swap = storage
            .staging_dir()
            .join(format!("rollback-{plugin_id}-{}", Uuid::new_v4()));
        fs::rename(&destination, &swap)
            .map_err(|e| format!("Failed to stage the current plugin version: {e}"))?;
        if let Err(error) = fs::rename(&rollback, &destination) {
            let _ = fs::rename(&swap, &destination);
            return Err(format!("Failed to activate the rollback version: {error}"));
        }
        if let Err(error) = fs::rename(&swap, &rollback) {
            let _ = fs::rename(&destination, &swap);
            let _ = fs::rename(&rollback, &destination);
            let _ = fs::rename(&swap, &rollback);
            return Err(format!(
                "Failed to preserve the replaced plugin version: {error}"
            ));
        }

        let current_version = records[index].manifest.version.clone();
        let now = now_unix_seconds();
        records[index] = InstalledPluginRecord {
            manifest: validated.manifest,
            bundle_path: destination.to_string_lossy().to_string(),
            enabled: records[index].enabled,
            installed_at: records[index].installed_at,
            updated_at: now,
            verified: true,
            computed_integrity: Some(validated.digest),
            validation_error: None,
            rollback_available: true,
            previous_version: Some(current_version),
        };
        storage
            .save_plugins(&records)
            .map_err(|e| format!("Failed to save rollback state: {e}"))?;
        Ok(records[index].clone())
    })
    .await?;
    db_manager
        .disconnect_driver_connections(&restored.manifest.id)
        .await;
    Ok(restored)
}

#[tauri::command]
pub async fn uninstall_plugin_bundle(
    plugin_id: String,
    plugin_storage: State<'_, PluginStorage>,
    db_manager: State<'_, DatabaseManager>,
) -> Result<(), String> {
    let storage = plugin_storage.inner().clone();
    let removed_plugin_id = plugin_id.clone();
    run_blocking_plugin_task(move || {
        let mut records = storage
            .load_plugins()
            .map_err(|e| format!("Failed to load installed plugins: {e}"))?;
        let existing = records
            .iter()
            .find(|record| record.manifest.id == plugin_id)
            .cloned()
            .ok_or_else(|| format!("Plugin '{plugin_id}' not found."))?;
        remove_dir_if_exists(Path::new(&existing.bundle_path))?;
        remove_dir_if_exists(&rollback_path(&storage, &plugin_id))?;
        records.retain(|record| record.manifest.id != plugin_id);
        storage
            .save_plugins(&records)
            .map_err(|e| format!("Failed to save installed plugins: {e}"))?;
        Ok(())
    })
    .await?;
    db_manager
        .disconnect_driver_connections(&removed_plugin_id)
        .await;
    Ok(())
}

#[tauri::command]
pub async fn reload_installed_plugins(
    plugin_storage: State<'_, PluginStorage>,
) -> Result<Vec<InstalledPluginRecord>, String> {
    let storage = plugin_storage.inner().clone();
    run_blocking_plugin_task(move || sync_installed_plugins(&storage)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::plugin_storage::{
        PluginCompatibility, PluginContributions, PluginDriverContribution, PluginIntegrity,
    };

    fn manifest() -> PluginManifest {
        PluginManifest {
            api_version: 1,
            id: "sample-format".to_string(),
            name: "Sample format".to_string(),
            version: "1.2.3".to_string(),
            kind: "export".to_string(),
            description: None,
            author: None,
            entry: Some("entry.wasm".to_string()),
            capabilities: vec!["export".to_string()],
            permissions: vec![],
            compatibility: PluginCompatibility::default(),
            integrity: Some(PluginIntegrity {
                algorithm: "sha256".to_string(),
                digest: "0".repeat(64),
            }),
            update_url: None,
            contributes: PluginContributions::default(),
        }
    }

    #[test]
    fn rejects_unknown_capabilities() {
        let root = std::env::temp_dir().join(format!("tabler-plugin-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("entry.wasm"), b"wasm").unwrap();
        let mut value = manifest();
        value.capabilities.push("host.shell".to_string());
        let error = validate_manifest(&value, &root).unwrap_err();
        assert!(error.contains("Unknown plugin capability"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_entry_path_traversal() {
        let root = std::env::temp_dir().join(format!("tabler-plugin-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let mut value = manifest();
        value.entry = Some("../outside.wasm".to_string());
        let error = validate_manifest(&value, &root).unwrap_err();
        assert!(error.contains("cannot escape"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn digest_changes_when_bundle_content_changes() {
        let root = std::env::temp_dir().join(format!("tabler-plugin-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("entry.wasm"), b"first").unwrap();
        let value = manifest();
        let first = compute_bundle_digest(&root, &value).unwrap();
        fs::write(root.join("entry.wasm"), b"second").unwrap();
        let second = compute_bundle_digest(&root, &value).unwrap();
        assert_ne!(first, second);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn official_portable_formats_bundle_is_valid() {
        let bundle = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("plugins")
            .join("portable-formats");
        let validated = validate_bundle(&bundle).unwrap();
        assert_eq!(validated.manifest.id, "portable-formats");
        assert_eq!(validated.manifest.contributes.formats.len(), 3);
    }

    #[test]
    fn official_opensearch_driver_bundle_is_valid_and_permission_bounded() {
        let bundle = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("plugins")
            .join("opensearch-driver");
        let validated = validate_bundle(&bundle).unwrap();
        let driver = &validated.manifest.contributes.drivers[0];
        assert_eq!(driver.protocol, "opensearch");
        assert_eq!(driver.runtime, "declarative-http-v1");

        let mut missing_permission = validated.manifest;
        missing_permission
            .permissions
            .retain(|permission| permission != "network.fetch");
        assert!(validate_contributions(&missing_permission)
            .unwrap_err()
            .contains("network.fetch"));
    }

    #[test]
    fn active_driver_resolution_rechecks_integrity_and_managed_location() {
        let root = std::env::temp_dir().join(format!("tabler-driver-runtime-{}", Uuid::new_v4()));
        let storage = PluginStorage::from_data_dir(root.clone()).unwrap();
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("plugins")
            .join("opensearch-driver");
        let destination = storage.bundles_dir().join("opensearch-driver.tableplugin");
        copy_dir_recursive(&source, &destination).unwrap();
        let validated = validate_bundle(&destination).unwrap();
        storage
            .save_plugins(&[InstalledPluginRecord {
                manifest: validated.manifest,
                bundle_path: destination.to_string_lossy().to_string(),
                enabled: true,
                installed_at: now_unix_seconds(),
                updated_at: now_unix_seconds(),
                verified: true,
                computed_integrity: Some(validated.digest),
                validation_error: None,
                rollback_available: false,
                previous_version: None,
            }])
            .unwrap();

        let active =
            resolve_active_plugin_driver(&storage, "opensearch-driver", "opensearch").unwrap();
        assert_eq!(active.contribution.runtime, "declarative-http-v1");

        let manifest_path = destination.join("plugin.json");
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        manifest["description"] = serde_json::Value::String("tampered".to_string());
        fs::write(
            &manifest_path,
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        assert!(resolve_active_plugin_driver(&storage, "opensearch-driver", "opensearch").is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_unrecognized_declarative_driver_protocols() {
        let mut value = manifest();
        value.kind = "adapter".to_string();
        value.capabilities = vec!["database".to_string()];
        value.permissions = vec![
            "connection.metadata".to_string(),
            "query.read".to_string(),
            "query.execute".to_string(),
            "network.fetch".to_string(),
        ];
        value.contributes.drivers = vec![PluginDriverContribution {
            id: "unsafe-proxy".to_string(),
            label: "Unsafe proxy".to_string(),
            protocol: "arbitrary-http".to_string(),
            runtime: "declarative-http-v1".to_string(),
            status: "stable".to_string(),
        }];
        assert!(validate_contributions(&value)
            .unwrap_err()
            .contains("unsupported"));
    }

    #[test]
    fn generated_registry_matches_the_runtime_contract() {
        let registry_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("plugin-registry.json");
        let raw = fs::read(registry_path).unwrap();
        let registry: PluginRegistryIndex = serde_json::from_slice(&raw).unwrap();
        validate_registry(&registry).unwrap();
        assert_eq!(registry.schema_version, 1);
        assert_eq!(registry.packages.len(), 2);
    }

    #[test]
    fn registry_urls_must_be_https_without_credentials() {
        assert!(validate_https_url("https://example.com/plugins.json", "Registry").is_ok());
        assert!(validate_https_url("http://example.com/plugins.json", "Registry").is_err());
        assert!(
            validate_https_url("https://user:secret@example.com/plugins.json", "Registry").is_err()
        );
    }
}
