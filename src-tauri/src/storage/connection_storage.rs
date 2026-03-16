use crate::database::models::ConnectionConfig;
use anyhow::{Context, Result};
use keyring::Error as KeyringError;
use std::fs;
use std::path::PathBuf;

/// Cross-platform connection storage using JSON files.
/// Replaces macOS Keychain — works on Windows, macOS, and Linux.
pub struct ConnectionStorage {
    storage_path: PathBuf,
}

impl ConnectionStorage {
    pub fn new() -> Result<Self> {
        let data_dir = dirs::data_dir()
            .context("Cannot find user data directory")?
            .join("TableR");

        fs::create_dir_all(&data_dir)?;

        Ok(Self {
            storage_path: data_dir.join("connections.json"),
        })
    }

    pub fn save_connection(&self, config: &ConnectionConfig) -> Result<()> {
        let mut connections = self.load_connections()?;

        // Update existing or add new
        if let Some(pos) = connections.iter().position(|c| c.id == config.id) {
            connections[pos] = config.clone();
        } else {
            connections.push(config.clone());
        }

        // Store password in keyring (cross-platform secure storage)
        if let Some(ref password) = config.password {
            let entry = keyring::Entry::new("TableR", &config.id)
                .context("Failed to open secure storage for the connection password")?;
            entry
                .set_password(password)
                .context("Failed to store the connection password in secure storage")?;
        }

        // Save config without password to JSON
        let safe_connections: Vec<ConnectionConfig> = connections
            .iter()
            .map(|c| {
                let mut safe = c.clone();
                safe.password = None; // Don't store passwords in plain JSON
                safe
            })
            .collect();

        let json = serde_json::to_string_pretty(&safe_connections)?;
        fs::write(&self.storage_path, json)?;

        Ok(())
    }

    pub fn load_connections(&self) -> Result<Vec<ConnectionConfig>> {
        if !self.storage_path.exists() {
            return Ok(Vec::new());
        }

        let content = fs::read_to_string(&self.storage_path)?;
        serde_json::from_str(&content).context("Failed to parse saved connections")
    }

    pub fn load_connection_by_id(&self, connection_id: &str) -> Result<ConnectionConfig> {
        let mut connection = self
            .load_connections()?
            .into_iter()
            .find(|connection| connection.id == connection_id)
            .ok_or_else(|| anyhow::anyhow!("Saved connection '{}' not found", connection_id))?;

        let entry = keyring::Entry::new("TableR", connection_id)
            .context("Failed to open secure storage for the saved connection")?;

        match entry.get_password() {
            Ok(password) => {
                connection.password = Some(password);
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

        Ok(())
    }
}
