use crate::database::ai_models::AIProviderConfig;
use crate::storage::file_storage::{read_json_vec_with_backup, write_json_atomically};
use anyhow::{Context, Result};
use keyring::Error as KeyringError;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::{
    Arc, Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard,
};

/// Cross-platform AI configuration storage using JSON files with in-memory caching.
/// API Keys are stored securely in the OS keyring.
#[derive(Clone)]
pub struct AIStorage {
    storage_path: PathBuf,
    cache: Arc<RwLock<Option<Vec<AIProviderConfig>>>>,
    keyring_cache: Arc<RwLock<HashMap<String, bool>>>,
    write_guard: Arc<Mutex<()>>,
}

impl AIStorage {
    fn normalize_provider_configs(mut providers: Vec<AIProviderConfig>) -> Vec<AIProviderConfig> {
        if providers.is_empty() {
            return providers;
        }

        let mut primary_enabled_index = None;

        for (index, provider) in providers.iter().enumerate() {
            if provider.is_enabled && provider.is_primary {
                primary_enabled_index = Some(index);
                break;
            }
        }

        if primary_enabled_index.is_none() {
            primary_enabled_index = providers.iter().position(|provider| provider.is_enabled);
        }

        for (index, provider) in providers.iter_mut().enumerate() {
            provider.is_primary = Some(index) == primary_enabled_index;
        }

        providers
    }

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
            cache: Arc::new(RwLock::new(None)),
            keyring_cache: Arc::new(RwLock::new(HashMap::new())),
            write_guard: Arc::new(Mutex::new(())),
        })
    }

    fn cache_read(&self) -> Result<RwLockReadGuard<'_, Option<Vec<AIProviderConfig>>>> {
        self.cache
            .read()
            .map_err(|_| anyhow::anyhow!("AI provider cache lock poisoned"))
    }

    fn cache_write(&self) -> Result<RwLockWriteGuard<'_, Option<Vec<AIProviderConfig>>>> {
        self.cache
            .write()
            .map_err(|_| anyhow::anyhow!("AI provider cache lock poisoned"))
    }

    fn keyring_cache_read(&self) -> Result<RwLockReadGuard<'_, HashMap<String, bool>>> {
        self.keyring_cache
            .read()
            .map_err(|_| anyhow::anyhow!("AI key status cache lock poisoned"))
    }

    fn keyring_cache_write(&self) -> Result<RwLockWriteGuard<'_, HashMap<String, bool>>> {
        self.keyring_cache
            .write()
            .map_err(|_| anyhow::anyhow!("AI key status cache lock poisoned"))
    }

    fn write_lock(&self) -> Result<MutexGuard<'_, ()>> {
        self.write_guard
            .lock()
            .map_err(|_| anyhow::anyhow!("AI storage write lock poisoned"))
    }

    fn invalidate_cache(&self) -> Result<()> {
        let mut cache = self.cache_write()?;
        *cache = None;
        let mut keyring_cache = self.keyring_cache_write()?;
        keyring_cache.clear();
        Ok(())
    }

    fn read_provider_configs_file(&self) -> Result<Vec<AIProviderConfig>> {
        read_json_vec_with_backup(
            &self.storage_path,
            "Failed to parse saved AI provider configs",
        )
    }

    pub fn load_provider_configs(&self) -> Result<Vec<AIProviderConfig>> {
        // Check cache first
        {
            let cache = self.cache_read()?;
            if let Some(ref providers) = *cache {
                return Ok(providers.clone());
            }
        }

        // Load from file
        if !self.storage_path.exists() {
            let empty: Vec<AIProviderConfig> = Vec::new();
            let mut cache = self.cache_write()?;
            *cache = Some(empty.clone());
            return Ok(empty);
        }

        let providers = Self::normalize_provider_configs(self.read_provider_configs_file()?);

        // Cache the result
        let mut cache = self.cache_write()?;
        *cache = Some(providers.clone());

        Ok(providers)
    }

    pub fn save_providers(
        &self,
        providers: &[AIProviderConfig],
        api_key_updates: &HashMap<String, String>,
        cleared_provider_ids: &[String],
    ) -> Result<()> {
        let _guard = self.write_lock()?;
        let existing_provider_ids: HashSet<String> = self
            .read_provider_configs_file()?
            .into_iter()
            .map(|provider| provider.id)
            .collect();
        let normalized_providers = Self::normalize_provider_configs(providers.to_vec());
        let next_provider_ids: HashSet<String> =
            normalized_providers.iter().map(|provider| provider.id.clone()).collect();

        for removed_provider_id in existing_provider_ids.difference(&next_provider_ids) {
            Self::delete_provider_secret(removed_provider_id)?;
        }

        for provider_id in cleared_provider_ids {
            Self::delete_provider_secret(provider_id)?;
        }

        for provider in &normalized_providers {
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

        let json = serde_json::to_string_pretty(&normalized_providers)?;
        write_json_atomically(&self.storage_path, &json)?;

        // Update cache
        self.invalidate_cache()?;

        Ok(())
    }

    pub fn load_providers(&self) -> Result<(Vec<AIProviderConfig>, HashMap<String, bool>)> {
        let providers = self.load_provider_configs()?;
        let mut key_status = self.keyring_cache_read()?.clone();

        // Check keyring for providers not in cache
        for provider in &providers {
            if !key_status.contains_key(&provider.id) {
                if let Ok(entry) = keyring::Entry::new("TableR_AI", &provider.id) {
                    key_status.insert(provider.id.clone(), entry.get_password().is_ok());
                } else {
                    key_status.insert(provider.id.clone(), false);
                }
            }
        }

        // Update cache
        {
            let mut cache = self.keyring_cache_write()?;
            *cache = key_status.clone();
        }

        Ok((providers, key_status))
    }

    pub fn get_active_provider_config(&self) -> Result<AIProviderConfig> {
        self.load_provider_configs()?
            .into_iter()
            .find(|provider| provider.is_enabled && provider.is_primary)
            .or_else(|| self.load_provider_configs().ok()?.into_iter().find(|provider| provider.is_enabled))
            .ok_or_else(|| anyhow::anyhow!("No enabled AI provider found"))
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
