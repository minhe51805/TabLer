use crate::database::models::ConnectionConfig;
use crate::storage::file_storage::{read_json_vec_with_backup, write_json_atomically};
use anyhow::{Context, Result};
use keyring::Error as KeyringError;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard};

/// Cross-platform connection storage using JSON files with in-memory caching.
/// Replaces macOS Keychain — works on Windows, macOS, and Linux.
#[derive(Clone)]
pub struct ConnectionStorage {
    storage_path: PathBuf,
    cache: Arc<RwLock<Option<Vec<ConnectionConfig>>>>,
    secret_cache: Arc<RwLock<HashMap<String, ConnectionSecrets>>>,
    write_guard: Arc<Mutex<()>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionSecrets {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ssh_password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ssh_private_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ssh_passphrase: Option<String>,
}

impl ConnectionSecrets {
    fn from_config(config: &ConnectionConfig) -> Self {
        let ssh = config.ssh_config.as_ref();
        Self {
            password: config.password.clone(),
            ssh_password: ssh.and_then(|value| value.password.clone()),
            ssh_private_key: ssh.and_then(|value| value.private_key.clone()),
            ssh_passphrase: ssh.and_then(|value| value.passphrase.clone()),
        }
    }

    fn is_empty(&self) -> bool {
        self.password.is_none()
            && self.ssh_password.is_none()
            && self.ssh_private_key.is_none()
            && self.ssh_passphrase.is_none()
    }

    fn apply_to(&self, config: &mut ConnectionConfig) {
        config.password = self.password.clone();
        if let Some(ssh) = config.ssh_config.as_mut() {
            ssh.password = self.ssh_password.clone();
            ssh.private_key = self.ssh_private_key.clone();
            ssh.passphrase = self.ssh_passphrase.clone();
        }
    }

    fn decode(value: &str) -> Self {
        serde_json::from_str(value).unwrap_or_else(|_| Self {
            password: Some(value.to_string()),
            ..Self::default()
        })
    }
}

fn redact_connection_secrets(config: &ConnectionConfig) -> ConnectionConfig {
    let mut safe = config.clone();
    safe.password = None;
    if let Some(ssh) = safe.ssh_config.as_mut() {
        ssh.password = None;
        ssh.private_key = None;
        ssh.passphrase = None;
    }
    safe
}

impl ConnectionStorage {
    pub fn new() -> Result<Self> {
        let data_dir = crate::utils::paths::resolve_data_dir()?;

        Self::from_data_dir(data_dir)
    }

    fn from_data_dir(data_dir: PathBuf) -> Result<Self> {
        fs::create_dir_all(&data_dir)?;

        Ok(Self {
            storage_path: data_dir.join("connections.json"),
            cache: Arc::new(RwLock::new(None)),
            secret_cache: Arc::new(RwLock::new(HashMap::new())),
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

    fn secret_cache_read(&self) -> Result<RwLockReadGuard<'_, HashMap<String, ConnectionSecrets>>> {
        self.secret_cache
            .read()
            .map_err(|_| anyhow::anyhow!("Connection secret cache lock poisoned"))
    }

    fn secret_cache_write(
        &self,
    ) -> Result<RwLockWriteGuard<'_, HashMap<String, ConnectionSecrets>>> {
        self.secret_cache
            .write()
            .map_err(|_| anyhow::anyhow!("Connection secret cache lock poisoned"))
    }

    fn write_lock(&self) -> Result<MutexGuard<'_, ()>> {
        self.write_guard
            .lock()
            .map_err(|_| anyhow::anyhow!("Connection storage write lock poisoned"))
    }

    fn invalidate_cache(&self) -> Result<()> {
        let mut cache = self.cache_write()?;
        *cache = None;
        self.secret_cache_write()?.clear();
        Ok(())
    }

    fn read_connections_file(&self) -> Result<Vec<ConnectionConfig>> {
        read_json_vec_with_backup(&self.storage_path, "Failed to parse saved connections")
    }

    pub fn save_connection(&self, config: &ConnectionConfig) -> Result<()> {
        let _guard = self.write_lock()?;
        let mut connections = self.read_connections_file()?;
        let safe_config = redact_connection_secrets(config);

        // Update existing or add new
        if let Some(pos) = connections.iter().position(|c| c.id == config.id) {
            connections[pos] = safe_config.clone();
        } else {
            connections.push(safe_config.clone());
        }

        let secrets = ConnectionSecrets::from_config(config);
        if !secrets.is_empty() {
            let entry = keyring::Entry::new("TableR", &config.id)
                .context("Failed to open secure storage for the connection secrets")?;
            entry
                .set_password(&serde_json::to_string(&secrets)?)
                .context("Failed to store the connection secrets in secure storage")?;
            self.secret_cache_write()?
                .insert(config.id.clone(), secrets);
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
        let mut safe_connections = Vec::with_capacity(connections.len());
        let mut loaded_secrets = HashMap::new();
        let mut migrated_plaintext = false;

        for connection in &connections {
            let inline_secrets = ConnectionSecrets::from_config(connection);
            let secrets = if !inline_secrets.is_empty() {
                let entry = keyring::Entry::new("TableR", &connection.id)
                    .context("Failed to open secure storage during secret migration")?;
                entry
                    .set_password(&serde_json::to_string(&inline_secrets)?)
                    .context("Failed to migrate connection secrets into secure storage")?;
                migrated_plaintext = true;
                Some(inline_secrets)
            } else if let Ok(entry) = keyring::Entry::new("TableR", &connection.id) {
                entry
                    .get_password()
                    .ok()
                    .map(|value| ConnectionSecrets::decode(&value))
            } else {
                None
            };
            if let Some(secrets) = secrets {
                loaded_secrets.insert(connection.id.clone(), secrets);
            }
            safe_connections.push(redact_connection_secrets(connection));
        }

        if migrated_plaintext {
            let json = serde_json::to_string_pretty(&safe_connections)?;
            write_json_atomically(&self.storage_path, &json)?;
        }

        let mut cache = self.cache_write()?;
        *cache = Some(safe_connections.clone());

        *self.secret_cache_write()? = loaded_secrets;

        Ok(safe_connections)
    }

    pub fn load_connection_by_id(&self, connection_id: &str) -> Result<ConnectionConfig> {
        let cached_secrets = {
            let cache = self.secret_cache_read()?;
            cache.get(connection_id).cloned()
        };

        let connections = self.load_connections()?;
        let mut connection = connections
            .into_iter()
            .find(|connection| connection.id == connection_id)
            .ok_or_else(|| anyhow::anyhow!("Saved connection '{}' not found", connection_id))?;

        if let Some(secrets) = cached_secrets {
            secrets.apply_to(&mut connection);
        } else {
            let entry = keyring::Entry::new("TableR", connection_id)
                .context("Failed to open secure storage for the saved connection")?;

            match entry.get_password() {
                Ok(value) => {
                    let secrets = ConnectionSecrets::decode(&value);
                    secrets.apply_to(&mut connection);
                    self.secret_cache_write()?
                        .insert(connection_id.to_string(), secrets);
                }
                Err(KeyringError::NoEntry) => {
                    connection.password = None;
                }
                Err(error) => {
                    return Err(anyhow::Error::new(error).context(
                        "Failed to read the saved connection secrets from secure storage",
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

        let safe_connections: Vec<ConnectionConfig> =
            connections.iter().map(redact_connection_secrets).collect();

        let json = serde_json::to_string_pretty(&safe_connections)?;
        write_json_atomically(&self.storage_path, &json)?;

        // Invalidate cache
        self.invalidate_cache()?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::ConnectionStorage;
    use crate::database::models::{ConnectionConfig, DatabaseType};
    use crate::ssh::ssh_tunnel::{SshAuthMethod, SshConfig};
    use std::fs;
    use std::sync::Once;
    use uuid::Uuid;

    static KEYRING_INIT: Once = Once::new();

    fn use_mock_keyring() {
        KEYRING_INIT.call_once(|| {
            keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
        });
    }

    #[test]
    fn migrates_v014b_plaintext_secrets_without_exposing_them_on_list() {
        use_mock_keyring();
        let root = std::env::temp_dir().join(format!("tabler-secret-migration-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let connection_id = format!("legacy-{}", Uuid::new_v4());
        let legacy = ConnectionConfig {
            id: connection_id.clone(),
            name: "Legacy PostgreSQL".to_string(),
            db_type: DatabaseType::PostgreSQL,
            password: Some("database-secret".to_string()),
            ssh_config: Some(SshConfig {
                enabled: true,
                host: "bastion.example".to_string(),
                port: 22,
                user: "deploy".to_string(),
                auth_type: SshAuthMethod::PrivateKeyWithPassphrase,
                password: Some("ssh-secret".to_string()),
                private_key: Some("private-key-material".to_string()),
                private_key_path: None,
                passphrase: Some("key-passphrase".to_string()),
            }),
            ..ConnectionConfig::default()
        };
        fs::write(
            root.join("connections.json"),
            serde_json::to_string_pretty(&vec![legacy]).unwrap(),
        )
        .unwrap();

        let storage = ConnectionStorage::from_data_dir(root.clone()).unwrap();
        let listed = storage.load_connections().unwrap();
        assert!(listed[0].password.is_none());
        let listed_ssh = listed[0].ssh_config.as_ref().unwrap();
        assert!(listed_ssh.password.is_none());
        assert!(listed_ssh.private_key.is_none());
        assert!(listed_ssh.passphrase.is_none());

        let persisted = fs::read_to_string(root.join("connections.json")).unwrap();
        for secret in [
            "database-secret",
            "ssh-secret",
            "private-key-material",
            "key-passphrase",
        ] {
            assert!(!persisted.contains(secret));
        }

        let restored = storage.load_connection_by_id(&connection_id).unwrap();
        assert_eq!(restored.password.as_deref(), Some("database-secret"));
        let restored_ssh = restored.ssh_config.as_ref().unwrap();
        assert_eq!(restored_ssh.password.as_deref(), Some("ssh-secret"));
        assert_eq!(
            restored_ssh.private_key.as_deref(),
            Some("private-key-material")
        );
        assert_eq!(restored_ssh.passphrase.as_deref(), Some("key-passphrase"));

        let _ = keyring::Entry::new("TableR", &connection_id)
            .and_then(|entry| entry.delete_credential());
        let _ = fs::remove_dir_all(root);
    }
}
