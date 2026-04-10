use crate::storage::file_storage::{read_json_map_with_backup, write_json_atomically};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

/// Represents a tab's persisted state for a specific connection.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedTab {
    pub tab_id: String,
    pub tab_type: String,
    pub title: String,
    pub database: Option<String>,
    pub table_name: Option<String>,
    pub content: Option<String>,
    pub scroll_top: Option<i32>,
    pub panel_heights: Option<PanelHeights>,
    pub is_active: bool,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelHeights {
    pub editor_height: Option<i32>,
    pub results_height: Option<i32>,
}

/// Tab persistence storage keyed by connection_id, storing up to MAX_TABS_PER_CONNECTION tabs (LRU).
const MAX_TABS_PER_CONNECTION: usize = 20;

#[derive(Clone)]
pub struct TabPersistence {
    storage_path: PathBuf,
    cache: Arc<RwLock<HashMap<String, Vec<PersistedTab>>>>,
}

impl TabPersistence {
    pub fn new() -> Result<Self> {
        let data_dir = crate::utils::paths::resolve_data_dir()?;

        fs::create_dir_all(&data_dir)?;

        Ok(Self {
            storage_path: data_dir.join("tab_persistence.json"),
            cache: Arc::new(RwLock::new(HashMap::new())),
        })
    }

    /// Save tabs for a connection. Performs LRU eviction if over MAX_TABS_PER_CONNECTION.
    pub fn save_tabs(&self, connection_id: &str, tabs: Vec<PersistedTab>) -> Result<()> {
        // Enforce LRU: keep most recently used tabs (active first, then by recency)
        let mut sorted = tabs;
        sorted.sort_by(|a, b| {
            // Active tab first
            if a.is_active != b.is_active {
                return b.is_active.cmp(&a.is_active);
            }
            // Then by most recently created (higher timestamp = more recent)
            b.created_at_ms.cmp(&a.created_at_ms)
        });

        let trimmed: Vec<PersistedTab> = sorted.into_iter().take(MAX_TABS_PER_CONNECTION).collect();

        let mut cache = self.cache
            .write()
            .map_err(|_| anyhow::anyhow!("Tab persistence cache lock poisoned"))?;

        cache.insert(connection_id.to_string(), trimmed.clone());

        let all_data: HashMap<String, Vec<PersistedTab>> = cache.clone();
        drop(cache);

        let json = serde_json::to_string_pretty(&all_data)?;
        write_json_atomically(&self.storage_path, &json)?;

        Ok(())
    }

    /// Load tabs for a connection.
    pub fn load_tabs(&self, connection_id: &str) -> Result<Vec<PersistedTab>> {
        // Check cache first
        {
            let cache = self.cache
                .read()
                .map_err(|_| anyhow::anyhow!("Tab persistence cache lock poisoned"))?;
            if let Some(tabs) = cache.get(connection_id) {
                return Ok(tabs.clone());
            }
        }

        // Load from file
        if !self.storage_path.exists() {
            return Ok(Vec::new());
        }

        let all_data: HashMap<String, Vec<PersistedTab>> =
            read_json_map_with_backup(&self.storage_path, "Failed to parse tab persistence file")
                .unwrap_or_default();

        let tabs = all_data.get(connection_id).cloned().unwrap_or_default();

        // Populate cache
        let mut cache = self.cache
            .write()
            .map_err(|_| anyhow::anyhow!("Tab persistence cache lock poisoned"))?;
        for (conn_id, conn_tabs) in all_data {
            cache.insert(conn_id, conn_tabs);
        }

        Ok(tabs)
    }

    /// Delete all persisted tabs for a connection.
    pub fn delete_tabs(&self, connection_id: &str) -> Result<()> {
        let mut cache = self.cache
            .write()
            .map_err(|_| anyhow::anyhow!("Tab persistence cache lock poisoned"))?;

        cache.remove(connection_id);

        let all_data: HashMap<String, Vec<PersistedTab>> = cache.clone();
        drop(cache);

        let json = serde_json::to_string_pretty(&all_data)?;
        write_json_atomically(&self.storage_path, &json)?;

        Ok(())
    }

    /// Invalidate in-memory cache for a connection (call after external changes).
    #[allow(dead_code)]
    pub fn invalidate_cache(&self) {
        if let Ok(mut cache) = self.cache.write() {
            cache.clear();
        }
    }
}
