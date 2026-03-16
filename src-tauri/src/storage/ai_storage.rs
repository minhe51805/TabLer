use crate::database::ai_models::AIProviderConfig;
use anyhow::{Context, Result};
use keyring::Error as KeyringError;
use std::fs;
use std::path::PathBuf;
use std::collections::{HashMap, HashSet};

/// Cross-platform AI configuration storage using JSON files.
/// API Keys are stored securely in the OS keyring.
pub struct AIStorage {
    storage_path: PathBuf,
}

impl AIStorage {
    fn delete_provider_secret(provider_id: &str) -> Result<()> {
        let entry = keyring::Entry::new("TableR_AI", provider_id)
            .context("Failed to open secure storage for the AI provider secret")?;
        match entry.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(error) => Err(anyhow::Error::new(error).context(
                "Failed to delete the AI provider secret from secure storage",
            )),
        }
    }

    pub fn new() -> Result<Self> {
        let data_dir = dirs::data_dir()
            .context("Cannot find user data directory")?
            .join("TableR");

        fs::create_dir_all(&data_dir)?;

        Ok(Self {
            storage_path: data_dir.join("ai_providers.json"),
        })
    }

    pub fn load_provider_configs(&self) -> Result<Vec<AIProviderConfig>> {
        if !self.storage_path.exists() {
            return Ok(Vec::new());
        }

        let content = fs::read_to_string(&self.storage_path)?;
        serde_json::from_str(&content).context("Failed to parse saved AI provider configs")
    }

    pub fn save_providers(
        &self,
        providers: &[AIProviderConfig],
        api_key_updates: &HashMap<String, String>,
        cleared_provider_ids: &[String],
    ) -> Result<()> {
        let existing_provider_ids: HashSet<String> = self
            .load_provider_configs()?
            .into_iter()
            .map(|provider| provider.id)
            .collect();
        let next_provider_ids: HashSet<String> =
            providers.iter().map(|provider| provider.id.clone()).collect();

        for removed_provider_id in existing_provider_ids.difference(&next_provider_ids) {
            Self::delete_provider_secret(removed_provider_id)?;
        }

        for provider_id in cleared_provider_ids {
            Self::delete_provider_secret(provider_id)?;
        }

        for provider in providers {
            if let Some(api_key) = api_key_updates.get(&provider.id) {
                if !api_key.trim().is_empty() {
                    let entry = keyring::Entry::new("TableR_AI", &provider.id)
                        .context("Failed to open secure storage for the AI provider secret")?;
                    entry
                        .set_password(api_key)
                        .context("Failed to store the AI provider secret in secure storage")?;
                }
            }
        }

        let json = serde_json::to_string_pretty(&providers)?;
        fs::write(&self.storage_path, json)?;

        Ok(())
    }

    pub fn load_providers(&self) -> Result<(Vec<AIProviderConfig>, HashMap<String, bool>)> {
        let providers = self.load_provider_configs()?;
        let mut key_status = HashMap::new();

        for provider in &providers {
            if let Ok(entry) = keyring::Entry::new("TableR_AI", &provider.id) {
                key_status.insert(provider.id.clone(), entry.get_password().is_ok());
            } else {
                key_status.insert(provider.id.clone(), false);
            }
        }

        Ok((providers, key_status))
    }

    pub fn get_provider_config(&self, provider_id: &str) -> Result<AIProviderConfig> {
        self.load_provider_configs()?
            .into_iter()
            .find(|provider| provider.id == provider_id)
            .ok_or_else(|| anyhow::anyhow!("AI provider '{}' not found", provider_id))
    }

    pub fn get_api_key(&self, provider_id: &str) -> Result<String> {
        let entry = keyring::Entry::new("TableR_AI", provider_id)?;
        entry
            .get_password()
            .map_err(|error| anyhow::anyhow!("Missing API key for provider '{}': {}", provider_id, error))
    }

    pub fn get_api_key_optional(&self, provider_id: &str) -> Result<Option<String>> {
        let entry = keyring::Entry::new("TableR_AI", provider_id)
            .context("Failed to open secure storage for the AI provider secret")?;
        match entry.get_password() {
            Ok(password) => Ok(Some(password)),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(error) => Err(anyhow::Error::new(error).context(
                "Failed to read the AI provider secret from secure storage",
            )),
        }
    }
}
