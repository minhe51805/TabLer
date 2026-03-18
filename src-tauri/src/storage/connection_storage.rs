use crate::database::models::ConnectionConfig;
use anyhow::{Context, Result};
use keyring::Error as KeyringError;
use std::fs;
use std::path::PathBuf;
use std::sync::RwLock;
use std::collections::HashMap;

/// Cross-platform connection storage using JSON files with in-memory caching.
/// Replaces macOS Keychain — works on Windows, macOS, and Linux.
pub struct ConnectionStorage {
    storage_path: PathBuf,
    cache: RwLock<Option<Vec<ConnectionConfig>>>,
    password_cache: RwLock<HashMap<String, String>>,
}

impl ConnectionStorage {
    pub fn new() -> Result<Self> {
        let data_dir = dirs::data_dir()
            .context("Cannot find user data directory")?
            .join("TableR");

        fs::create_dir_all(&data_dir)?;

        Ok(Self {
            storage_path: data_dir.join("connections.json"),
            cache: RwLock::new(None),
            password_cache: RwLock::new(HashMap::new()),
        })
    }

    fn invalidate_cache(&self) {
        let mut cache = self.cache.write().unwrap();
        *cache = None;
        let mut pw_cache = self.password_cache.write().unwrap();
        pw_cache.clear();
    }

    pub fn save_connection(&self, config: &ConnectionConfig) -> Result<()> {
        let mut connections = self.load_connections()?;
        let mut safe_config = config.clone();
        safe_config.password = None;

        // Update existing or add new
        if let Some(pos) = connections.iter().position(|c| c.id == config.id) {
            connections[pos] = safe_config.clone();
        } else {
            connections.push(safe_config.clone());
        }

        // Store password in keyring (cross-platform secure storage)
        if let Some(ref password) = config.password {
            let entry = keyring::Entry::new("TableR", &config.id)
                .context("Failed to open secure storage for the connection password")?;
            entry
                .set_password(password)
                .context("Failed to store the connection password in secure storage")?;
            
            // Update password cache
            let mut pw_cache = self.password_cache.write().unwrap();
            pw_cache.insert(config.id.clone(), password.clone());
        }

        let json = serde_json::to_string_pretty(&connections)?;
        fs::write(&self.storage_path, json)?;

        // Update cache
        let mut cache = self.cache.write().unwrap();
        *cache = Some(connections);

        Ok(())
    }

    pub fn load_connections(&self) -> Result<Vec<ConnectionConfig>> {
        // Check cache first
        {
            let cache = self.cache.read().unwrap();
            if let Some(ref connections) = *cache {
                return Ok(connections.clone());
            }
        }

        // Load from file
        if !self.storage_path.exists() {
            let empty: Vec<ConnectionConfig> = Vec::new();
            let mut cache = self.cache.write().unwrap();
            *cache = Some(empty.clone());
            return Ok(empty);
        }

        let content = fs::read_to_string(&self.storage_path)?;
        let connections: Vec<ConnectionConfig> = serde_json::from_str(&content)
            .context("Failed to parse saved connections")?;

        // Cache the result (without passwords)
        let safe_connections: Vec<ConnectionConfig> = connections
            .iter()
            .map(|c| {
                let mut safe = c.clone();
                safe.password = None;
                safe
            })
            .collect();

        let mut cache = self.cache.write().unwrap();
        *cache = Some(safe_connections.clone());

        // Read keyring entries first, then update the in-memory cache in one shot
        // so we do not hold the write lock during potentially slow OS keyring I/O.
        let mut loaded_passwords = HashMap::new();
        for conn in &connections {
            if let Ok(entry) = keyring::Entry::new("TableR", &conn.id) {
                if let Ok(password) = entry.get_password() {
                    loaded_passwords.insert(conn.id.clone(), password);
                }
            }
        }

        let mut pw_cache = self.password_cache.write().unwrap();
        *pw_cache = loaded_passwords;

        Ok(connections)
    }

    pub fn load_connection_by_id(&self, connection_id: &str) -> Result<ConnectionConfig> {
        // Try password cache first
        let cached_password = {
            let pw_cache = self.password_cache.read().unwrap();
            pw_cache.get(connection_id).cloned()
        };

        let connections = self.load_connections()?;
        let mut connection = connections
            .into_iter()
            .find(|connection| connection.id == connection_id)
            .ok_or_else(|| anyhow::anyhow!("Saved connection '{}' not found", connection_id))?;

        // Use cached password or fetch from keyring
        if let Some(password) = cached_password {
            connection.password = Some(password);
        } else {
            let entry = keyring::Entry::new("TableR", connection_id)
                .context("Failed to open secure storage for the saved connection")?;

            match entry.get_password() {
                Ok(password) => {
                    connection.password = Some(password.clone());
                    let mut pw_cache = self.password_cache.write().unwrap();
                    pw_cache.insert(connection_id.to_string(), password);
                }
                Err(KeyringError::NoEntry) => {
                    connection.password = None;
                }
                Err(error) => {
                    return Err(anyhow::Error::new(error).context(
                        "Failed to read the saved connection password from secure storage",
                    ));
                }
            }
        }

        Ok(connection)
    }

    pub fn delete_connection(&self, connection_id: &str) -> Result<()> {
        let mut connections = self.load_connections()?;
        connections.retain(|c| c.id != connection_id);

        // Remove password from keyring
        let entry = keyring::Entry::new("TableR", connection_id)
            .context("Failed to open secure storage for deleting the saved connection")?;
        match entry.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => {}
            Err(error) => {
                return Err(anyhow::Error::new(error).context(
                    "Failed to delete the saved connection password from secure storage",
                ));
            }
        }

        let safe_connections: Vec<ConnectionConfig> = connections
            .iter()
            .map(|c| {
                let mut safe = c.clone();
                safe.password = None;
                safe
            })
            .collect();

        let json = serde_json::to_string_pretty(&safe_connections)?;
        fs::write(&self.storage_path, json)?;

        // Invalidate cache
        self.invalidate_cache();

        Ok(())
    }
}
