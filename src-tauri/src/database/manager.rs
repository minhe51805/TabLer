use super::driver::DatabaseDriver;
use super::models::*;
use super::mysql::MySqlDriver;
use super::postgres::PostgresDriver;
use super::sqlite::SqliteDriver;
use anyhow::{anyhow, Result};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

/// Manages all active database connections.
/// Mirrors TablePro's DatabaseManager — connection pool, lifecycle, primary interface.
#[allow(dead_code)]
pub struct DatabaseManager {
    connections: Arc<RwLock<HashMap<String, Box<dyn DatabaseDriver>>>>,
}

impl DatabaseManager {
    pub fn new() -> Self {
        Self {
            connections: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Connect to a database using the provided config
    pub async fn connect(&self, config: &ConnectionConfig) -> Result<()> {
        let driver: Box<dyn DatabaseDriver> = match config.db_type {
            DatabaseType::MySQL | DatabaseType::MariaDB => {
                Box::new(MySqlDriver::connect(config).await?)
            }
            DatabaseType::PostgreSQL
            | DatabaseType::CockroachDB
            | DatabaseType::Greenplum
            | DatabaseType::Redshift => {
                Box::new(PostgresDriver::connect(config).await?)
            }
            DatabaseType::SQLite => {
                let path = config.file_path.as_deref().unwrap_or(":memory:");
                Box::new(SqliteDriver::connect(path).await?)
            }
            _ => {
                return Err(anyhow!(
                    "{:?} connections are not implemented in this build yet.",
                    config.db_type
                ));
            }
        };

        // Verify connection
        driver.ping().await?;

        let mut conns = self.connections.write().await;
        let previous_driver = conns.insert(config.id.clone(), driver);
        drop(conns);

        if let Some(previous_driver) = previous_driver {
            let _ = previous_driver.disconnect().await;
        }

        Ok(())
    }

    /// Disconnect from a specific connection
    pub async fn disconnect(&self, connection_id: &str) -> Result<()> {
        let mut conns = self.connections.write().await;
        if let Some(driver) = conns.remove(connection_id) {
            driver.disconnect().await?;
        }
        Ok(())
    }

    /// Disconnect all connections
    #[allow(dead_code)]
    pub async fn disconnect_all(&self) -> Result<()> {
        let mut conns = self.connections.write().await;
        for (_, driver) in conns.drain() {
            let _ = driver.disconnect().await;
        }
        Ok(())
    }

    /// Get a reference to a driver by connection ID
    pub async fn get_driver(&self, connection_id: &str) -> Result<impl std::ops::Deref<Target = Box<dyn DatabaseDriver>> + '_> {
        let conns = self.connections.read().await;
        tokio::sync::RwLockReadGuard::try_map(conns, |map| map.get(connection_id))
            .map_err(|_| anyhow!("Connection '{}' not found. Please connect first.", connection_id))
    }

    /// Check if a connection exists and is alive
    pub async fn is_connected(&self, connection_id: &str) -> bool {
        let conns = self.connections.read().await;
        if let Some(driver) = conns.get(connection_id) {
            driver.ping().await.is_ok()
        } else {
            false
        }
    }

    /// List all active connection IDs
    #[allow(dead_code)]
    pub async fn active_connections(&self) -> Vec<String> {
        let conns = self.connections.read().await;
        conns.keys().cloned().collect()
    }
}

impl Default for DatabaseManager {
    fn default() -> Self {
        Self::new()
    }
}
