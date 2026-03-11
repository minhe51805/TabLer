use crate::database::ai_models::AIProviderConfig;
use anyhow::{Context, Result};
use std::fs;
use std::path::PathBuf;

/// Cross-platform AI configuration storage using JSON files.
/// API Keys are stored securely in the OS keyring.
pub struct AIStorage {
    storage_path: PathBuf,
}

impl AIStorage {
    pub fn new() -> Result<Self> {
        let data_dir = dirs::data_dir()
            .context("Cannot find user data directory")?
            .join("TableR");

        fs::create_dir_all(&data_dir)?;

        Ok(Self {
            storage_path: data_dir.join("ai_providers.json"),
        })
    }

    pub fn save_providers(&self, providers: &[AIProviderConfig], api_keys: &std::collections::HashMap<String, String>) -> Result<()> {
        // Store api_keys in keyring (cross-platform secure storage)
        for provider in providers {
            if let Some(api_key) = api_keys.get(&provider.id) {
                if let Ok(entry) = keyring::Entry::new("TableR_AI", &provider.id) {
                    let _ = entry.set_password(api_key);
                }
            }
        }

        let json = serde_json::to_string_pretty(&providers)?;
        fs::write(&self.storage_path, json)?;

        Ok(())
    }

    pub fn load_providers(&self) -> Result<(Vec<AIProviderConfig>, std::collections::HashMap<String, String>)> {
        if !self.storage_path.exists() {
            return Ok((Vec::new(), std::collections::HashMap::new()));
        }

        let content = fs::read_to_string(&self.storage_path)?;
        let providers: Vec<AIProviderConfig> = serde_json::from_str(&content).unwrap_or_default();
        let mut api_keys = std::collections::HashMap::new();

        // Restore api keys from keyring
        for provider in &providers {
            if let Ok(entry) = keyring::Entry::new("TableR_AI", &provider.id) {
                if let Ok(api_key) = entry.get_password() {
                    api_keys.insert(provider.id.clone(), api_key);
                }
            }
        }

        Ok((providers, api_keys))
    }
}

impl Default for AIStorage {
    fn default() -> Self {
        Self::new().expect("Failed to initialize AI storage")
    }
}
