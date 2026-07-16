use crate::storage::file_storage::{read_json_vec_with_backup, write_json_atomically};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

fn default_plugin_api_version() -> u32 {
    1
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCompatibility {
    pub min_app_version: Option<String>,
    pub max_app_version: Option<String>,
    #[serde(default)]
    pub platforms: Vec<String>,
    #[serde(default)]
    pub architectures: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginIntegrity {
    pub algorithm: String,
    pub digest: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginContributions {
    #[serde(default)]
    pub formats: Vec<PluginFormatContribution>,
    #[serde(default)]
    pub drivers: Vec<PluginDriverContribution>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginFormatContribution {
    pub id: String,
    pub label: String,
    pub description: Option<String>,
    pub extension: String,
    pub mime_type: String,
    pub mode: String,
    pub delimiter: Option<String>,
    #[serde(default = "default_true")]
    pub include_header: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDriverContribution {
    pub id: String,
    pub label: String,
    pub protocol: String,
    pub runtime: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    #[serde(default = "default_plugin_api_version")]
    pub api_version: u32,
    pub id: String,
    pub name: String,
    pub version: String,
    pub kind: String,
    pub description: Option<String>,
    pub author: Option<String>,
    pub entry: Option<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub compatibility: PluginCompatibility,
    pub integrity: Option<PluginIntegrity>,
    pub update_url: Option<String>,
    #[serde(default)]
    pub contributes: PluginContributions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPluginRecord {
    pub manifest: PluginManifest,
    pub bundle_path: String,
    pub enabled: bool,
    pub installed_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub verified: bool,
    pub computed_integrity: Option<String>,
    pub validation_error: Option<String>,
    #[serde(default)]
    pub rollback_available: bool,
    pub previous_version: Option<String>,
}

#[derive(Clone)]
pub struct PluginStorage {
    storage_path: PathBuf,
    bundles_dir: PathBuf,
    rollback_dir: PathBuf,
    staging_dir: PathBuf,
    write_guard: Arc<Mutex<()>>,
}

impl PluginStorage {
    pub fn new() -> Result<Self> {
        let data_dir = crate::utils::paths::resolve_data_dir()?;
        Self::from_data_dir(data_dir)
    }

    pub(crate) fn from_data_dir(data_dir: PathBuf) -> Result<Self> {
        let bundles_dir = data_dir.join("plugins");
        let rollback_dir = data_dir.join("plugin-rollbacks");
        let staging_dir = data_dir.join("plugin-staging");

        fs::create_dir_all(&bundles_dir)?;
        fs::create_dir_all(&rollback_dir)?;
        fs::create_dir_all(&staging_dir)?;

        Ok(Self {
            storage_path: data_dir.join("plugins.json"),
            bundles_dir,
            rollback_dir,
            staging_dir,
            write_guard: Arc::new(Mutex::new(())),
        })
    }

    fn write_lock(&self) -> Result<MutexGuard<'_, ()>> {
        self.write_guard
            .lock()
            .map_err(|_| anyhow::anyhow!("Plugin storage write lock poisoned"))
    }

    pub fn bundles_dir(&self) -> &PathBuf {
        &self.bundles_dir
    }

    pub fn rollback_dir(&self) -> &PathBuf {
        &self.rollback_dir
    }

    pub fn staging_dir(&self) -> &PathBuf {
        &self.staging_dir
    }

    pub fn load_plugins(&self) -> Result<Vec<InstalledPluginRecord>> {
        read_json_vec_with_backup(&self.storage_path, "Failed to parse installed plugins")
    }

    pub fn save_plugins(&self, plugins: &[InstalledPluginRecord]) -> Result<()> {
        let _guard = self.write_lock()?;
        let json = serde_json::to_string_pretty(plugins)?;
        write_json_atomically(&self.storage_path, &json)
    }
}
