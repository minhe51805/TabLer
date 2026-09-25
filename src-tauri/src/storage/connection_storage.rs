use crate::database::models::ConnectionConfig;
use crate::storage::file_storage::{
    file_parse_fails, quarantine_corrupt_file, read_json_vec_with_backup, securely_remove_file,
    write_json_atomically, write_json_atomically_without_backup,
};
use crate::storage_notices::{push_storage_notice, StorageNotice};
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
    /// DynamoDB STS session token. The driver reads it from
    /// `additional_fields["session_token"]`, but as a credential it must not
    /// persist plaintext in `connections.json`, so the storage layer moves it
    /// here (see `SESSION_TOKEN_FIELD`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session_token: Option<String>,
}

/// `additional_fields` key carrying the DynamoDB STS session token
/// (matched case-insensitively). It is a credential, not metadata: on save it
/// is moved into `ConnectionSecrets` (OS keyring) and stripped from the
/// persisted config, exactly like `password`/SSH secrets; on load
/// `apply_to` restores it into `additional_fields` under the canonical key
/// the driver reads.
const SESSION_TOKEN_FIELD: &str = "session_token";

fn session_token_in(config: &ConnectionConfig) -> Option<String> {
    config
        .additional_fields
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(SESSION_TOKEN_FIELD))
        .map(|(_, value)| value.clone())
        .filter(|value| !value.trim().is_empty())
}

fn strip_session_token(fields: &mut HashMap<String, String>) {
    fields.retain(|key, _| !key.eq_ignore_ascii_case(SESSION_TOKEN_FIELD));
}

impl ConnectionSecrets {
    fn from_config(config: &ConnectionConfig) -> Self {
        let ssh = config.ssh_config.as_ref();
        Self {
            password: config.password.clone(),
            ssh_password: ssh.and_then(|value| value.password.clone()),
            ssh_private_key: ssh.and_then(|value| value.private_key.clone()),
            ssh_passphrase: ssh.and_then(|value| value.passphrase.clone()),
            session_token: session_token_in(config),
        }
    }

    fn is_empty(&self) -> bool {
        self.password.is_none()
            && self.ssh_password.is_none()
            && self.ssh_private_key.is_none()
            && self.ssh_passphrase.is_none()
            && self.session_token.is_none()
    }

    fn apply_to(&self, config: &mut ConnectionConfig) {
        config.password = self.password.clone();
        if let Some(ssh) = config.ssh_config.as_mut() {
            ssh.password = self.ssh_password.clone();
            ssh.private_key = self.ssh_private_key.clone();
            ssh.passphrase = self.ssh_passphrase.clone();
        }
        strip_session_token(&mut config.additional_fields);
        if let Some(token) = &self.session_token {
            config
                .additional_fields
                .insert(SESSION_TOKEN_FIELD.to_string(), token.clone());
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
    strip_session_token(&mut safe.additional_fields);
    safe
}

/// `additional_fields` marker recording that this connection's secrets live in
/// the OS keyring. It travels with synced `connections.json` data (the keyring
/// does not), so a load that finds the marker but no keyring entry can warn
/// the user that the saved password must be re-entered.
const SECRETS_STORED_FIELD: &str = "secretsStored";

fn mark_secrets_stored(config: &mut ConnectionConfig, stored: bool) {
    if stored {
        config
            .additional_fields
            .insert(SECRETS_STORED_FIELD.to_string(), "true".to_string());
    } else {
        config.additional_fields.remove(SECRETS_STORED_FIELD);
    }
}

fn had_stored_secrets(config: &ConnectionConfig) -> bool {
    config
        .additional_fields
        .get(SECRETS_STORED_FIELD)
        .map(|value| value == "true")
        .unwrap_or(false)
}

fn notify_corrupt_connections(error: &dyn std::fmt::Display, quarantined: &[PathBuf]) {
    let quarantined_list = quarantined
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    push_storage_notice(StorageNotice {
        id: "corrupt:connections.json".to_string(),
        kind: "corrupt".to_string(),
        title: "Saved connections file was corrupt".to_string(),
        message: format!(
            "connections.json could not be read ({error}) and was moved aside ({quarantined_list}). \
             TableR started with an empty connection list; re-save or re-import your connections. \
             The quarantined file keeps the original data for manual recovery."
        ),
    });
}

impl ConnectionStorage {
    pub fn new() -> Result<Self> {
        let data_dir = crate::utils::paths::resolve_data_dir()?;

        Self::from_data_dir(data_dir)
    }

    pub(crate) fn from_data_dir(data_dir: PathBuf) -> Result<Self> {
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

    /// Read `connections.json`, tolerating a corrupt file: quarantine it to
    /// `<name>.corrupt-<timestamp>`, notify the user, and start fresh instead
    /// of failing every load/save with an unrecoverable parse error.
    /// Non-corruption failures (lock contention, IO) still propagate.
    fn read_connections_or_quarantine(&self) -> Result<Vec<ConnectionConfig>> {
        match self.read_connections_file() {
            Ok(connections) => Ok(connections),
            Err(error) => {
                if !file_parse_fails::<Vec<ConnectionConfig>>(&self.storage_path) {
                    return Err(error);
                }
                let quarantined =
                    quarantine_corrupt_file(&self.storage_path).with_context(|| {
                        format!(
                            "connections.json is corrupt ({error}) and could not be quarantined"
                        )
                    })?;
                log::error!("connections.json was corrupt and has been quarantined: {error}");
                notify_corrupt_connections(&error, &quarantined);
                Ok(Vec::new())
            }
        }
    }

    fn read_connections_file(&self) -> Result<Vec<ConnectionConfig>> {
        read_json_vec_with_backup(&self.storage_path, "Failed to parse saved connections")
    }

    pub fn save_connection(&self, config: &ConnectionConfig) -> Result<()> {
        let _guard = self.write_lock()?;
        let mut connections = self.read_connections_or_quarantine()?;
        let secrets = ConnectionSecrets::from_config(config);
        let mut safe_config = redact_connection_secrets(config);
        mark_secrets_stored(&mut safe_config, !secrets.is_empty());

        // Update existing or add new
        if let Some(pos) = connections.iter().position(|c| c.id == config.id) {
            connections[pos] = safe_config.clone();
        } else {
            connections.push(safe_config.clone());
        }

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

        let connections = self.read_connections_or_quarantine()?;
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
            let mut safe = redact_connection_secrets(connection);
            // Record whether credentials exist in the keyring so a synced
            // `connections.json` on another machine can flag missing secrets.
            mark_secrets_stored(&mut safe, loaded_secrets.contains_key(&connection.id));
            safe_connections.push(safe);
        }

        if migrated_plaintext {
            let json = serde_json::to_string_pretty(&safe_connections)?;
            // The pre-migration file held plaintext secrets; rotating it into
            // `.bak` would keep them on disk, so this rewrite keeps no backup
            // and scrubs any existing one.
            write_json_atomically_without_backup(&self.storage_path, &json)?;
            securely_remove_file(&crate::storage::file_storage::backup_path_for(
                &self.storage_path,
            ))?;
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
                    if had_stored_secrets(&connection) {
                        // The marker survived sync/copy but the OS keyring did
                        // not — the user must re-enter the credentials.
                        push_storage_notice(StorageNotice {
                            id: format!("missing-secrets:{connection_id}"),
                            kind: "warning".to_string(),
                            title: "Saved password missing".to_string(),
                            message: format!(
                                "The saved credentials for '{}' are not in this device's secure \
                                 storage (they do not sync between machines). Re-enter the \
                                 password/SSH/session-token secrets for this connection.",
                                connection.name
                            ),
                        });
                    }
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
        let mut connections = self.read_connections_or_quarantine()?;
        connections.retain(|c| c.id != connection_id);

        // Remove password from keyring
        let entry = keyring::Entry::new("TableR", connection_id)
            .context("Failed to open secure storage for deleting the saved connection")?;
        match entry.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => {}
            Err(error) => {
                // A locked or broken OS credential store (Windows Credential
                // Manager lock, enterprise policy, ...) must not leave the
                // user unable to delete a saved connection. The metadata row
                // is already removed from `connections` above, so proceed and
                // treat the secret cleanup as best-effort — the orphaned
                // keyring entry is logged for manual removal instead of
                // silently blocking the whole delete.
                log::warn!(
                    "Could not delete the keyring credential for connection {}: {}. \
                     The saved connection was removed, but its secret may remain \
                     in the OS secure store.",
                    connection_id,
                    error
                );
                push_storage_notice(StorageNotice {
                    id: format!("keyring-delete-failed:{connection_id}"),
                    kind: "warning".to_string(),
                    title: "Credential cleanup incomplete".to_string(),
                    message: format!(
                        "The connection was deleted, but its credential could not be removed from \
                         the OS secure store ({error}). You may need to remove it manually."
                    ),
                });
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
        // The migration rewrite must not leave plaintext secrets in the
        // rotated `.bak` either.
        let bak_path = root.join("connections.json.bak");
        if bak_path.exists() {
            let bak = fs::read_to_string(&bak_path).unwrap();
            for secret in [
                "database-secret",
                "ssh-secret",
                "private-key-material",
                "key-passphrase",
            ] {
                assert!(!bak.contains(secret), "secret leaked into .bak");
            }
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

    #[test]
    fn save_connection_tolerates_corrupt_connections_file() {
        use_mock_keyring();
        let root = std::env::temp_dir().join(format!("tabler-corrupt-save-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("connections.json"), "{ not valid json !!!").unwrap();

        let storage = ConnectionStorage::from_data_dir(root.clone()).unwrap();
        let connection = ConnectionConfig {
            id: format!("conn-{}", Uuid::new_v4()),
            name: "Recovered".to_string(),
            db_type: DatabaseType::PostgreSQL,
            password: Some("pw".to_string()),
            ..ConnectionConfig::default()
        };

        // A corrupt existing file must not make new saves fail.
        storage.save_connection(&connection).unwrap();

        // The corrupt file was quarantined, not deleted.
        let quarantined: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().contains(".corrupt-"))
            .collect();
        assert_eq!(quarantined.len(), 1);

        // The new connection round-trips.
        let listed = storage.load_connections().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "Recovered");

        let _ = keyring::Entry::new("TableR", &connection.id)
            .and_then(|entry| entry.delete_credential());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn session_token_is_moved_to_keyring_not_persisted() {
        use_mock_keyring();
        let root = std::env::temp_dir().join(format!("tabler-session-token-{}", Uuid::new_v4()));
        let storage = ConnectionStorage::from_data_dir(root.clone()).unwrap();

        let mut additional_fields = std::collections::HashMap::new();
        // Case-insensitive match: the key can arrive in other casings and must
        // still be treated as a secret.
        additional_fields.insert("Session_Token".to_string(), "sts-token-xyz".to_string());
        additional_fields.insert("region".to_string(), "us-west-2".to_string());
        let connection = ConnectionConfig {
            id: format!("ddb-{}", Uuid::new_v4()),
            name: "Dynamo Prod".to_string(),
            db_type: DatabaseType::DynamoDB,
            host: Some("us-west-2".to_string()),
            username: Some("AKIAEXAMPLE".to_string()),
            password: Some("aws-secret".to_string()),
            additional_fields,
            ..ConnectionConfig::default()
        };

        storage.save_connection(&connection).unwrap();

        // The persisted file holds no credential material.
        let persisted = fs::read_to_string(root.join("connections.json")).unwrap();
        assert!(!persisted.contains("sts-token-xyz"));
        assert!(!persisted.contains("session_token"));
        assert!(!persisted.contains("aws-secret"));
        // Non-secret additional fields stay.
        assert!(persisted.contains("us-west-2"));

        // The list path returns the redacted view.
        let listed = storage.load_connections().unwrap();
        assert!(listed[0]
            .additional_fields
            .keys()
            .all(|key| !key.eq_ignore_ascii_case("session_token")));

        // The connect path restores the token under the canonical key the
        // DynamoDB driver reads.
        let restored = storage.load_connection_by_id(&connection.id).unwrap();
        assert_eq!(
            restored
                .additional_fields
                .get("session_token")
                .map(String::as_str),
            Some("sts-token-xyz")
        );
        assert_eq!(restored.password.as_deref(), Some("aws-secret"));

        let _ = keyring::Entry::new("TableR", &connection.id)
            .and_then(|entry| entry.delete_credential());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn legacy_file_plaintext_session_token_is_migrated_and_scrubbed() {
        use_mock_keyring();
        let root = std::env::temp_dir().join(format!("tabler-sts-migration-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();

        // Pre-fix shape: the token sits plaintext in additional_fields.
        let mut additional_fields = std::collections::HashMap::new();
        additional_fields.insert("session_token".to_string(), "legacy-sts-token".to_string());
        let connection_id = format!("ddb-legacy-{}", Uuid::new_v4());
        let legacy = ConnectionConfig {
            id: connection_id.clone(),
            name: "Legacy Dynamo".to_string(),
            db_type: DatabaseType::DynamoDB,
            host: Some("us-east-1".to_string()),
            additional_fields,
            ..ConnectionConfig::default()
        };
        fs::write(
            root.join("connections.json"),
            serde_json::to_string_pretty(&vec![legacy]).unwrap(),
        )
        .unwrap();

        let storage = ConnectionStorage::from_data_dir(root.clone()).unwrap();
        let listed = storage.load_connections().unwrap();
        assert!(listed[0]
            .additional_fields
            .keys()
            .all(|key| !key.eq_ignore_ascii_case("session_token")));

        // The migration rewrite scrubs the token from disk (and keeps no
        // plaintext backup), while the token stays usable via the keyring.
        let persisted = fs::read_to_string(root.join("connections.json")).unwrap();
        assert!(!persisted.contains("legacy-sts-token"));
        let restored = storage.load_connection_by_id(&connection_id).unwrap();
        assert_eq!(
            restored
                .additional_fields
                .get("session_token")
                .map(String::as_str),
            Some("legacy-sts-token")
        );

        let _ = keyring::Entry::new("TableR", &connection_id)
            .and_then(|entry| entry.delete_credential());
        let _ = fs::remove_dir_all(root);
    }
}
