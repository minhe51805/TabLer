use super::bigquery::BigQueryDriver;
use super::capabilities::{driver_capabilities, DriverCapability, DriverCapabilityProfile};
use super::cassandra::CassandraDriver;
use super::clickhouse::ClickHouseDriver;
use super::cloudflare_d1::CloudflareD1Driver;
use super::driver::DatabaseDriver;
use super::duckdb::DuckDbDriver;
use super::libsql::LibSqlDriver;
use super::models::*;
use super::mongodb::MongoDbDriver;
use super::mssql::MssqlDriver;
use super::mysql::MySqlDriver;
use super::opensearch::OpenSearchDriver;
use super::postgres::PostgresDriver;
use super::redis::RedisDriver;
use super::snowflake::SnowflakeDriver;
use super::sqlite::SqliteDriver;
use crate::ssh::ssh_tunnel::{SshTunnelManager, TunnelHandle};
use crate::storage::plugin_storage::PluginStorage;
use anyhow::{anyhow, Result};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

/// Manages all active database connections.
/// Owns the connection pool, lifecycle, and primary database interface.
#[allow(dead_code)]
pub struct DatabaseManager {
    connections: Arc<RwLock<HashMap<String, Box<dyn DatabaseDriver>>>>,
    connection_types: Arc<RwLock<HashMap<String, DatabaseType>>>,
    ssh_tunnels: Arc<RwLock<HashMap<String, TunnelHandle>>>,
    ssh_manager: Arc<SshTunnelManager>,
    plugin_storage: PluginStorage,
}

struct PendingTunnel {
    manager: Arc<SshTunnelManager>,
    handle: Option<TunnelHandle>,
}

impl PendingTunnel {
    fn new(manager: Arc<SshTunnelManager>, handle: TunnelHandle) -> Self {
        Self {
            manager,
            handle: Some(handle),
        }
    }

    fn commit(mut self) -> TunnelHandle {
        self.handle
            .take()
            .expect("pending tunnel must have a handle")
    }
}

impl Drop for PendingTunnel {
    fn drop(&mut self) {
        if let Some(handle) = self.handle.take() {
            let _ = self.manager.disconnect_tunnel(handle);
        }
    }
}

impl DatabaseManager {
    pub fn new() -> Self {
        Self::with_plugin_storage(
            PluginStorage::new().expect("TableR plugin storage could not be initialized"),
        )
    }

    pub fn with_plugin_storage(plugin_storage: PluginStorage) -> Self {
        Self {
            connections: Arc::new(RwLock::new(HashMap::new())),
            connection_types: Arc::new(RwLock::new(HashMap::new())),
            ssh_tunnels: Arc::new(RwLock::new(HashMap::new())),
            ssh_manager: Arc::new(SshTunnelManager::new()),
            plugin_storage,
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
        let mut pending_tunnel = None;

        if let Some(ssh_cfg) = &config.ssh_config {
            if ssh_cfg.enabled {
                let handle = self.ssh_manager.connect_tunnel(ssh_cfg.clone())?;

                // Assuming we want to connect to actual_config.host:actual_config.port but via the SSH tunnel
                let remote_host = actual_config
                    .host
                    .clone()
                    .unwrap_or_else(|| "127.0.0.1".to_string());
                let remote_port = actual_config.port.unwrap_or(actual_config.default_port());

                let local_port =
                    self.ssh_manager
                        .forward_port(handle, None, remote_host, remote_port)?;

                actual_config.host = Some("127.0.0.1".to_string());
                actual_config.port = Some(local_port);
                pending_tunnel = Some(PendingTunnel::new(self.ssh_manager.clone(), handle));
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
            | DatabaseType::Vertica => Box::new(PostgresDriver::connect(&actual_config).await?),
            DatabaseType::SQLite => {
                let path = actual_config.file_path.as_deref().unwrap_or(":memory:");
                Box::new(SqliteDriver::connect(path).await?)
            }
            DatabaseType::DuckDB => Box::new(DuckDbDriver::connect(&actual_config).await?),
            DatabaseType::Cassandra => Box::new(CassandraDriver::connect(&actual_config).await?),
            DatabaseType::Snowflake => Box::new(SnowflakeDriver::connect(&actual_config).await?),
            DatabaseType::MSSQL => Box::new(MssqlDriver::connect(&actual_config).await?),
            DatabaseType::LibSQL => Box::new(LibSqlDriver::connect(&actual_config).await?),
            DatabaseType::ClickHouse => Box::new(ClickHouseDriver::connect(&actual_config).await?),
            DatabaseType::BigQuery => Box::new(BigQueryDriver::connect(&actual_config).await?),
            DatabaseType::CloudflareD1 => {
                Box::new(CloudflareD1Driver::connect(&actual_config).await?)
            }
            DatabaseType::Redis => Box::new(RedisDriver::connect(&actual_config).await?),
            DatabaseType::MongoDB => Box::new(MongoDbDriver::connect(&actual_config).await?),
            DatabaseType::OpenSearch => {
                let plugin_id = actual_config
                    .additional_fields
                    .get("plugin_id")
                    .map(String::as_str)
                    .unwrap_or_default()
                    .to_string();
                let driver_id = actual_config
                    .additional_fields
                    .get("plugin_driver_id")
                    .map(String::as_str)
                    .unwrap_or_default()
                    .to_string();
                if plugin_id.is_empty() || driver_id.is_empty() {
                    return Err(anyhow!(
                        "OpenSearch connections require an installed driver plugin"
                    ));
                }
                let storage = self.plugin_storage.clone();
                let active = tokio::task::spawn_blocking(move || {
                    crate::commands::plugins::resolve_active_plugin_driver(
                        &storage, &plugin_id, &driver_id,
                    )
                })
                .await
                .map_err(|_| anyhow!("Driver plugin verification stopped unexpectedly"))?
                .map_err(anyhow::Error::msg)?;
                if active.contribution.runtime != "declarative-http-v1"
                    || active.contribution.status != "stable"
                    || active.contribution.protocol != "opensearch"
                {
                    return Err(anyhow!(
                        "The selected plugin driver is incompatible with the OpenSearch host ABI"
                    ));
                }
                Box::new(OpenSearchDriver::connect(&actual_config, active.plugin_id).await?)
            }
        };

        let mut conns = self.connections.write().await;
        let previous_driver = conns.insert(config.id.clone(), driver);
        drop(conns);

        self.connection_types
            .write()
            .await
            .insert(config.id.clone(), config.db_type);

        if let Some(pending_tunnel) = pending_tunnel {
            let handle = pending_tunnel.commit();
            let mut ssh_tunnels = self.ssh_tunnels.write().await;
            if let Some(old_handle) = ssh_tunnels.insert(config.id.clone(), handle) {
                let _ = self.ssh_manager.disconnect_tunnel(old_handle);
            }
        }

        if let Some(previous_driver) = previous_driver {
            let _ = previous_driver.disconnect().await;
        }

        Ok(())
    }

    /// Disconnect from a specific connection
    pub async fn disconnect(&self, connection_id: &str) -> Result<()> {
        let mut conns = self.connections.write().await;
        let driver = conns.remove(connection_id);
        drop(conns);
        self.connection_types.write().await.remove(connection_id);
        if let Some(driver) = driver {
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
        drop(conns);
        self.connection_types.write().await.clear();

        let mut tunnels = self.ssh_tunnels.write().await;
        for (_, handle) in tunnels.drain() {
            let _ = self.ssh_manager.disconnect_tunnel(handle);
        }

        Ok(())
    }

    /// Get a reference to a driver by connection ID
    pub async fn get_driver(
        &self,
        connection_id: &str,
    ) -> Result<impl std::ops::Deref<Target = Box<dyn DatabaseDriver>> + '_> {
        let conns = self.connections.read().await;
        tokio::sync::RwLockReadGuard::try_map(conns, |map| map.get(connection_id)).map_err(|_| {
            anyhow!(
                "Connection '{}' not found. Please connect first.",
                connection_id
            )
        })
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

    pub async fn get_connection_capabilities(
        &self,
        connection_id: &str,
    ) -> Result<DriverCapabilityProfile> {
        let connection_types = self.connection_types.read().await;
        let database_type = connection_types
            .get(connection_id)
            .copied()
            .ok_or_else(|| {
                anyhow!(
                    "Connection '{}' not found. Please connect first.",
                    connection_id
                )
            })?;
        Ok(driver_capabilities(database_type))
    }

    pub async fn require_capability(
        &self,
        connection_id: &str,
        capability: DriverCapability,
    ) -> Result<()> {
        self.get_connection_capabilities(connection_id)
            .await?
            .require(capability)
            .map_err(anyhow::Error::msg)
    }

    /// List all active connection IDs
    #[allow(dead_code)]
    pub async fn active_connections(&self) -> Vec<String> {
        let conns = self.connections.read().await;
        conns.keys().cloned().collect()
    }

    pub async fn disconnect_driver_connections(&self, driver_name: &str) -> usize {
        let connection_ids = {
            let conns = self.connections.read().await;
            conns
                .iter()
                .filter(|(_, driver)| driver.driver_name() == driver_name)
                .map(|(connection_id, _)| connection_id.clone())
                .collect::<Vec<_>>()
        };
        for connection_id in &connection_ids {
            let _ = self.disconnect(connection_id).await;
        }
        connection_ids.len()
    }
}

impl Default for DatabaseManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::capabilities::{CapabilitySupport, DriverCapability};
    use crate::storage::plugin_storage::{InstalledPluginRecord, PluginManifest};
    use axum::{routing::get, Json, Router};
    use serde_json::json;
    use std::fs;
    use std::path::Path;
    use tokio::net::TcpListener;
    use uuid::Uuid;

    #[tokio::test]
    async fn active_connection_exposes_and_clears_its_capability_contract() {
        let root =
            std::env::temp_dir().join(format!("tabler-manager-capability-{}", Uuid::new_v4()));
        let storage = PluginStorage::from_data_dir(root.clone()).unwrap();
        let manager = DatabaseManager::with_plugin_storage(storage);
        let config = ConnectionConfig {
            id: "sqlite-capability".to_string(),
            name: "SQLite capability".to_string(),
            db_type: DatabaseType::SQLite,
            file_path: Some(":memory:".to_string()),
            ..ConnectionConfig::default()
        };

        manager.connect(&config).await.unwrap();
        let profile = manager
            .get_connection_capabilities(&config.id)
            .await
            .unwrap();
        assert_eq!(
            profile.capabilities.inline_edit,
            CapabilitySupport::Supported
        );
        manager
            .require_capability(&config.id, DriverCapability::AtomicEditQueue)
            .await
            .unwrap();

        manager.disconnect(&config.id).await.unwrap();
        assert!(manager
            .get_connection_capabilities(&config.id)
            .await
            .is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn verified_driver_plugin_connects_and_disconnects_as_one_runtime() {
        let root = std::env::temp_dir().join(format!("tabler-manager-plugin-{}", Uuid::new_v4()));
        let storage = PluginStorage::from_data_dir(root.clone()).unwrap();
        let bundle = storage.bundles_dir().join("opensearch-driver.tableplugin");
        fs::create_dir_all(&bundle).unwrap();
        let source_manifest = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("plugins")
            .join("opensearch-driver")
            .join("plugin.json");
        fs::copy(&source_manifest, bundle.join("plugin.json")).unwrap();
        let manifest: PluginManifest =
            serde_json::from_slice(&fs::read(&source_manifest).unwrap()).unwrap();
        storage
            .save_plugins(&[InstalledPluginRecord {
                manifest,
                bundle_path: bundle.to_string_lossy().to_string(),
                enabled: true,
                installed_at: 1,
                updated_at: 1,
                verified: false,
                computed_integrity: None,
                validation_error: None,
                rollback_available: false,
                previous_version: None,
            }])
            .unwrap();

        let app = Router::new().route(
            "/",
            get(|| async { Json(json!({ "version": { "number": "2.17.0" } })) }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let manager = DatabaseManager::with_plugin_storage(storage);
        let mut config = ConnectionConfig {
            id: "plugin-connection".to_string(),
            name: "Plugin connection".to_string(),
            db_type: DatabaseType::OpenSearch,
            host: Some("127.0.0.1".to_string()),
            port: Some(port),
            database: Some("logs".to_string()),
            ..ConnectionConfig::default()
        };
        config
            .additional_fields
            .insert("plugin_id".to_string(), "opensearch-driver".to_string());
        config
            .additional_fields
            .insert("plugin_driver_id".to_string(), "opensearch".to_string());

        manager.connect(&config).await.unwrap();
        assert!(manager.is_connected(&config.id).await);
        assert_eq!(
            manager
                .disconnect_driver_connections("opensearch-driver")
                .await,
            1
        );
        assert!(!manager.is_connected(&config.id).await);

        server.abort();
        let _ = fs::remove_dir_all(root);
    }
}
