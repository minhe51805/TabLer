use crate::database::models::ConnectionConfig;
use anyhow::{Context, Result};
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
        let mut connections = self.load_connections().unwrap_or_default();

        // Update existing or add new
        if let Some(pos) = connections.iter().position(|c| c.id == config.id) {
            connections[pos] = config.clone();
        } else {
            connections.push(config.clone());
        }

        // Store password in keyring (cross-platform secure storage)
        if let Some(ref password) = config.password {
            if let Ok(entry) = keyring::Entry::new("TableR", &config.id) {
                let _ = entry.set_password(password);
            }
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
        let mut connections: Vec<ConnectionConfig> = serde_json::from_str(&content)?;

        // Restore passwords from keyring
        for conn in &mut connections {
            if let Ok(entry) = keyring::Entry::new("TableR", &conn.id) {
                if let Ok(password) = entry.get_password() {
                    conn.password = Some(password);
                }
            }
        }

        Ok(connections)
    }

    pub fn delete_connection(&self, connection_id: &str) -> Result<()> {
        let mut connections = self.load_connections().unwrap_or_default();
        connections.retain(|c| c.id != connection_id);

        // Remove password from keyring
        if let Ok(entry) = keyring::Entry::new("TableR", connection_id) {
            let _ = entry.delete_credential();
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

impl Default for ConnectionStorage {
    fn default() -> Self {
        Self::new().expect("Failed to initialize connection storage")
    }
}
