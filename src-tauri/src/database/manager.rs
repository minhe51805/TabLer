use super::driver::DatabaseDriver;
use super::cassandra::CassandraDriver;
use super::bigquery::BigQueryDriver;
use super::clickhouse::ClickHouseDriver;
use super::cloudflare_d1::CloudflareD1Driver;
use super::duckdb::DuckDbDriver;
use super::libsql::LibSqlDriver;
use super::mongodb::MongoDbDriver;
use super::mssql::MssqlDriver;
use super::models::*;
use super::mysql::MySqlDriver;
use super::postgres::PostgresDriver;
use super::redis::RedisDriver;
use super::snowflake::SnowflakeDriver;
use super::sqlite::SqliteDriver;
use anyhow::{anyhow, Result};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use crate::ssh::ssh_tunnel::{SshTunnelManager, TunnelHandle};

/// Manages all active database connections.
/// Mirrors TablePro's DatabaseManager — connection pool, lifecycle, primary interface.
#[allow(dead_code)]
pub struct DatabaseManager {
    connections: Arc<RwLock<HashMap<String, Box<dyn DatabaseDriver>>>>,
    ssh_tunnels: Arc<RwLock<HashMap<String, TunnelHandle>>>,
    ssh_manager: Arc<SshTunnelManager>,
}

impl DatabaseManager {
    pub fn new() -> Self {
        Self {
            connections: Arc::new(RwLock::new(HashMap::new())),
            ssh_tunnels: Arc::new(RwLock::new(HashMap::new())),
            ssh_manager: Arc::new(SshTunnelManager::new()),
        }
    }

    /// Connect to a database using the provided config
    pub async fn connect(&self, config: &ConnectionConfig) -> Result<()> {
        if let Some(script) = &config.pre_connect_script {
            let script = script.trim();
            if !script.is_empty() {
                #[cfg(target_os = "windows")]
                {
                    let output = std::process::Command::new("cmd.exe")
                        .arg("/c")
                        .arg(script)
                        .output()
                        .map_err(|e| anyhow!("Failed to execute pre-connect script: {}", e))?;
                    
                    if !output.status.success() {
                        let stderr = String::from_utf8_lossy(&output.stderr);
                        return Err(anyhow!("Pre-connect script failed: {}", stderr));
                    }
                }

                #[cfg(not(target_os = "windows"))]
                {
                    let output = std::process::Command::new("sh")
                        .arg("-c")
                        .arg(script)
                        .output()
                        .map_err(|e| anyhow!("Failed to execute pre-connect script: {}", e))?;
                    
                    if !output.status.success() {
                        let stderr = String::from_utf8_lossy(&output.stderr);
                        return Err(anyhow!("Pre-connect script failed: {}", stderr));
                    }
                }
            }
        }

        let mut actual_config = config.clone();

        if let Some(ssh_cfg) = &config.ssh_config {
            if ssh_cfg.enabled {
                let handle = self.ssh_manager.connect_tunnel(ssh_cfg.clone())?;
                
                // Assuming we want to connect to actual_config.host:actual_config.port but via the SSH tunnel
                let remote_host = actual_config.host.clone().unwrap_or_else(|| "127.0.0.1".to_string());
                let remote_port = actual_config.port.unwrap_or(actual_config.default_port());

                let local_port = self.ssh_manager.forward_port(handle, None, remote_host, remote_port)?;

                actual_config.host = Some("127.0.0.1".to_string());
                actual_config.port = Some(local_port);

                // Disconnect any existing tunnel for this connection before overwriting
                let mut ssh_tunnels = self.ssh_tunnels.write().await;
                if let Some(old_handle) = ssh_tunnels.insert(config.id.clone(), handle) {
                    let _ = self.ssh_manager.disconnect_tunnel(old_handle);
                }
            }
        }

        let driver: Box<dyn DatabaseDriver> = match actual_config.db_type {
            DatabaseType::MySQL | DatabaseType::MariaDB => {
                Box::new(MySqlDriver::connect(&actual_config).await?)
            }
            DatabaseType::PostgreSQL
            | DatabaseType::CockroachDB
            | DatabaseType::Greenplum
            | DatabaseType::Redshift
            | DatabaseType::Vertica => {
                Box::new(PostgresDriver::connect(&actual_config).await?)
            }
            DatabaseType::SQLite => {
                let path = actual_config.file_path.as_deref().unwrap_or(":memory:");
                Box::new(SqliteDriver::connect(path).await?)
            }
            DatabaseType::DuckDB => {
                Box::new(DuckDbDriver::connect(&actual_config).await?)
            }
            DatabaseType::Cassandra => {
                Box::new(CassandraDriver::connect(&actual_config).await?)
            }
            DatabaseType::Snowflake => {
                Box::new(SnowflakeDriver::connect(&actual_config).await?)
            }
            DatabaseType::MSSQL => {
                Box::new(MssqlDriver::connect(&actual_config).await?)
            }
            DatabaseType::LibSQL => {
                Box::new(LibSqlDriver::connect(&actual_config).await?)
            }
            DatabaseType::ClickHouse => {
                Box::new(ClickHouseDriver::connect(&actual_config).await?)
            }
            DatabaseType::BigQuery => {
                Box::new(BigQueryDriver::connect(&actual_config).await?)
            }
            DatabaseType::CloudflareD1 => {
                Box::new(CloudflareD1Driver::connect(&actual_config).await?)
            }
            DatabaseType::Redis => {
                Box::new(RedisDriver::connect(&actual_config).await?)
            }
            DatabaseType::MongoDB => {
                Box::new(MongoDbDriver::connect(&actual_config).await?)
            }
        };

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
        
        let mut tunnels = self.ssh_tunnels.write().await;
        if let Some(handle) = tunnels.remove(connection_id) {
            let _ = self.ssh_manager.disconnect_tunnel(handle);
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

        let mut tunnels = self.ssh_tunnels.write().await;
        for (_, handle) in tunnels.drain() {
            let _ = self.ssh_manager.disconnect_tunnel(handle);
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
