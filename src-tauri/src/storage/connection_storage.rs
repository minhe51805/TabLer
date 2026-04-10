use crate::database::models::ConnectionConfig;
use crate::storage::file_storage::{read_json_vec_with_backup, write_json_atomically};
use anyhow::{Context, Result};
use keyring::Error as KeyringError;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{
    Arc, Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard,
};

/// Cross-platform connection storage using JSON files with in-memory caching.
/// Replaces macOS Keychain — works on Windows, macOS, and Linux.
#[derive(Clone)]
pub struct ConnectionStorage {
    storage_path: PathBuf,
    cache: Arc<RwLock<Option<Vec<ConnectionConfig>>>>,
    password_cache: Arc<RwLock<HashMap<String, String>>>,
    write_guard: Arc<Mutex<()>>,
}

impl ConnectionStorage {
    pub fn new() -> Result<Self> {
        let data_dir = crate::utils::paths::resolve_data_dir()?;

        fs::create_dir_all(&data_dir)?;

        Ok(Self {
            storage_path: data_dir.join("connections.json"),
            cache: Arc::new(RwLock::new(None)),
            password_cache: Arc::new(RwLock::new(HashMap::new())),
            write_guard: Arc::new(Mutex::new(())),
        })
    }

    fn cache_read(&self) -> Result<RwLockReadGuard<'_, Option<Vec<ConnectionConfig>>>> {
        self.cache
            .read()
            .map_err(|_| anyhow::anyhow!("Connection cache lock poisoned"))
    }

    fn cache_write(&self) -> Result<RwLockWriteGuard<'_, Option<Vec<ConnectionConfig>>>> {
        self.cache
            .write()
            .map_err(|_| anyhow::anyhow!("Connection cache lock poisoned"))
    }

    fn password_cache_read(&self) -> Result<RwLockReadGuard<'_, HashMap<String, String>>> {
        self.password_cache
            .read()
            .map_err(|_| anyhow::anyhow!("Connection password cache lock poisoned"))
    }

    fn password_cache_write(&self) -> Result<RwLockWriteGuard<'_, HashMap<String, String>>> {
        self.password_cache
            .write()
            .map_err(|_| anyhow::anyhow!("Connection password cache lock poisoned"))
    }

    fn write_lock(&self) -> Result<MutexGuard<'_, ()>> {
        self.write_guard
            .lock()
            .map_err(|_| anyhow::anyhow!("Connection storage write lock poisoned"))
    }

    fn invalidate_cache(&self) -> Result<()> {
        let mut cache = self.cache_write()?;
        *cache = None;
        let mut pw_cache = self.password_cache_write()?;
        pw_cache.clear();
        Ok(())
    }

    fn read_connections_file(&self) -> Result<Vec<ConnectionConfig>> {
        read_json_vec_with_backup(&self.storage_path, "Failed to parse saved connections")
    }

    pub fn save_connection(&self, config: &ConnectionConfig) -> Result<()> {
        let _guard = self.write_lock()?;
        let mut connections = self.read_connections_file()?;
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
            let mut pw_cache = self.password_cache_write()?;
            pw_cache.insert(config.id.clone(), password.clone());
        }

        let json = serde_json::to_string_pretty(&connections)?;
        write_json_atomically(&self.storage_path, &json)?;

        // Update cache
        let mut cache = self.cache_write()?;
        *cache = Some(connections);

        Ok(())
    }

    pub fn load_connections(&self) -> Result<Vec<ConnectionConfig>> {
        // Check cache first
        {
            let cache = self.cache_read()?;
            if let Some(ref connections) = *cache {
                return Ok(connections.clone());
            }
        }

        // Load from file
        if !self.storage_path.exists() {
            let empty: Vec<ConnectionConfig> = Vec::new();
            let mut cache = self.cache_write()?;
            *cache = Some(empty.clone());
            return Ok(empty);
        }

        let connections = self.read_connections_file()?;

        // Cache the result (without passwords)
        let safe_connections: Vec<ConnectionConfig> = connections
            .iter()
            .map(|c| {
                let mut safe = c.clone();
                safe.password = None;
                safe
            })
            .collect();

        let mut cache = self.cache_write()?;
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

        let mut pw_cache = self.password_cache_write()?;
        *pw_cache = loaded_passwords;

        Ok(connections)
    }

    pub fn load_connection_by_id(&self, connection_id: &str) -> Result<ConnectionConfig> {
        // Try password cache first
        let cached_password = {
            let pw_cache = self.password_cache_read()?;
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
                    let mut pw_cache = self.password_cache_write()?;
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
        let _guard = self.write_lock()?;
        let mut connections = self.read_connections_file()?;
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
        write_json_atomically(&self.storage_path, &json)?;

        // Invalidate cache
        self.invalidate_cache()?;

        Ok(())
    }
}
