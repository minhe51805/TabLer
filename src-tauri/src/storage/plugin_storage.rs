use crate::storage::file_storage::{read_json_vec_with_backup, write_json_atomically};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub kind: String,
    pub description: Option<String>,
    pub author: Option<String>,
    pub entry: Option<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPluginRecord {
    pub manifest: PluginManifest,
    pub bundle_path: String,
    pub enabled: bool,
    pub installed_at: i64,
    pub updated_at: i64,
}

#[derive(Clone)]
pub struct PluginStorage {
    storage_path: PathBuf,
    bundles_dir: PathBuf,
    write_guard: Arc<Mutex<()>>,
}

impl PluginStorage {
    pub fn new() -> Result<Self> {
        let data_dir = crate::utils::paths::resolve_data_dir()?;
        let bundles_dir = data_dir.join("plugins");

        fs::create_dir_all(&bundles_dir)?;

        Ok(Self {
            storage_path: data_dir.join("plugins.json"),
            bundles_dir,
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

    pub fn load_plugins(&self) -> Result<Vec<InstalledPluginRecord>> {
        read_json_vec_with_backup(&self.storage_path, "Failed to parse installed plugins")
    }

    pub fn save_plugins(&self, plugins: &[InstalledPluginRecord]) -> Result<()> {
        let _guard = self.write_lock()?;
        let json = serde_json::to_string_pretty(plugins)?;
        write_json_atomically(&self.storage_path, &json)
    }
}
