use super::bigquery::BigQueryDriver;
use super::capabilities::{driver_capabilities, DriverCapability, DriverCapabilityProfile};
#[cfg(feature = "cassandra-driver")]
use super::cassandra::CassandraDriver;
use super::clickhouse::ClickHouseDriver;
use super::cloudflare_d1::CloudflareD1Driver;
use super::driver::DatabaseDriver;
#[cfg(feature = "duckdb-driver")]
use super::duckdb::DuckDbDriver;
use super::dynamodb::DynamoDbDriver;
use super::elasticsearch::ElasticsearchDriver;
#[cfg(feature = "libsql-driver")]
use super::libsql::LibSqlDriver;
use super::models::*;
use super::mongodb::MongoDbDriver;
use super::mssql::MssqlDriver;
use super::mysql::MySqlDriver;
use super::opensearch::OpenSearchDriver;
use super::oracle::OracleDriver;
use super::postgres::PostgresDriver;
#[cfg(feature = "redis-driver")]
use super::redis::RedisDriver;
use super::snowflake::SnowflakeDriver;
use super::spanner::SpannerDriver;
use super::sqlite::SqliteDriver;
use super::surrealdb::SurrealDbDriver;
use super::trino::TrinoDriver;
use super::typesense::TypesenseDriver;
use super::weaviate::WeaviateDriver;
use crate::ssh::ssh_tunnel::{SshTunnelManager, TunnelHandle};
use crate::storage::plugin_storage::PluginStorage;
use anyhow::{anyhow, Result};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::RwLock;

/// Error returned when a `connection_id` has no live session in the manager.
///
/// The wording is load-bearing: the detached Profiler window's auto-close
/// *safety net* matches on the "... not found. Please connect first." suffix
/// (`CONNECTION_GONE_MARKER` in `src/components/Profiler/profilerConstants.ts`).
/// Centralized here so every lookup path stays in lockstep and the message
/// can't drift out from under that fallback.
fn connection_not_found(connection_id: &str) -> anyhow::Error {
    anyhow!(
        "Connection '{}' not found. Please connect first.",
        connection_id
    )
}

/// Manages all active database connections.
/// Owns the connection pool, lifecycle, and primary database interface.
#[allow(dead_code)]
pub struct DatabaseManager {
    connections: Arc<RwLock<HashMap<String, Arc<dyn DatabaseDriver>>>>,
    connection_types: Arc<RwLock<HashMap<String, DatabaseType>>>,
    /// Per-connection query timeout overrides (seconds), captured at connect
    /// time from `ConnectionConfig::query_timeout_seconds`. Absent entries mean
    /// "use the classified default window".
    connection_query_timeouts: Arc<RwLock<HashMap<String, u64>>>,
    /// Live sessions whose `ConnectionConfig::read_only` pin is set. Captured
    /// at connect time so every write command can reject mutations before any
    /// statement reaches the driver.
    read_only_connections: Arc<RwLock<HashSet<String>>>,
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

/// Plugin-split gate for HTTP engines. `PluginHttp` engines (ClickHouse,
/// BigQuery, Snowflake, Cloudflare D1, OpenSearch) only connect once an
/// installed, enabled, verified declarative-http-v1 plugin contributes the
/// matching protocol — the compiled driver stays in-app but is unreachable
/// without the plugin, so the app ships only the built-in engines by default.
/// Returns the resolved plugin id for provenance.
async fn require_installed_http_plugin(
    plugin_storage: &PluginStorage,
    config: &mut ConnectionConfig,
    protocol: &str,
) -> Result<String> {
    backfill_plugin_driver_fields(plugin_storage, config, protocol, "declarative-http-v1").await;
    let plugin_id = config
        .additional_fields
        .get("plugin_id")
        .map(String::as_str)
        .unwrap_or_default()
        .to_string();
    let driver_id = config
        .additional_fields
        .get("plugin_driver_id")
        .map(String::as_str)
        .unwrap_or_default()
        .to_string();
    if plugin_id.is_empty() || driver_id.is_empty() {
        return Err(anyhow!(
            "{protocol} connections require an installed driver plugin"
        ));
    }
    let storage = plugin_storage.clone();
    let active = tokio::task::spawn_blocking(move || {
        crate::commands::plugins::resolve_active_plugin_driver(&storage, &plugin_id, &driver_id)
    })
    .await
    .map_err(|_| anyhow!("Driver plugin verification stopped unexpectedly"))?
    .map_err(anyhow::Error::msg)?;
    if active.contribution.runtime != "declarative-http-v1"
        || active.contribution.status != "stable"
        || active.contribution.protocol != protocol
    {
        return Err(anyhow!(
            "The selected plugin driver is incompatible with the {protocol} host"
        ));
    }
    Ok(active.plugin_id)
}

/// Backfill `plugin_id` / `plugin_driver_id` for plugin-gated engines whose
/// saved config predates the binding (imported profiles, connections saved
/// before the picker started injecting it). When exactly ONE installed plugin
/// contributes a `runtime` driver for `protocol`, the binding is unambiguous
/// and filled in; zero or several matches leave the config untouched so the
/// gate still reports a clear "requires an installed driver plugin" error.
/// The resolved driver is re-verified by the caller, so a disabled or
/// unverified plugin still fails with the precise reason.
async fn backfill_plugin_driver_fields(
    plugin_storage: &PluginStorage,
    config: &mut ConnectionConfig,
    protocol: &str,
    runtime: &str,
) {
    let has_binding = ["plugin_id", "plugin_driver_id"].iter().all(|key| {
        config
            .additional_fields
            .get(*key)
            .is_some_and(|value| !value.trim().is_empty())
    });
    if has_binding {
        return;
    }
    let storage = plugin_storage.clone();
    let runtime_owned = runtime.to_string();
    let protocol_owned = protocol.to_string();
    let matches = tokio::task::spawn_blocking(move || {
        storage.load_plugins().map(|records| {
            records
                .into_iter()
                .filter(|record| {
                    record.manifest.contributes.drivers.iter().any(|driver| {
                        driver.protocol == protocol_owned && driver.runtime == runtime_owned
                    })
                })
                .map(|record| (record.manifest.id, record.manifest.contributes.drivers))
                .collect::<Vec<_>>()
        })
    })
    .await
    .ok()
    .and_then(|result| result.ok())
    .unwrap_or_default();
    let [(plugin_id, drivers)] = matches.as_slice() else {
        return;
    };
    let Some(driver) = drivers
        .iter()
        .find(|driver| driver.protocol == protocol && driver.runtime == runtime)
    else {
        return;
    };
    config
        .additional_fields
        .insert("plugin_id".to_string(), plugin_id.clone());
    config
        .additional_fields
        .insert("plugin_driver_id".to_string(), driver.id.clone());
}

/// Native-engine (`plugin_native`) sidecar gate, mirroring
/// `require_installed_http_plugin`: when the wire-protocol crate was not built
/// in, the engine only connects via a verified `driver-sidecar-v1` plugin that
/// ships a per-platform sidecar executable. Resolves and spawns it, returning
/// the proxy driver. Compiled only in builds where a native feature is absent.
#[cfg(any(
    not(feature = "duckdb-driver"),
    not(feature = "cassandra-driver"),
    not(feature = "redis-driver"),
    not(feature = "libsql-driver"),
))]
async fn connect_native_sidecar(
    plugin_storage: &PluginStorage,
    config: &mut ConnectionConfig,
    protocol: &str,
) -> Result<Arc<dyn DatabaseDriver>> {
    backfill_plugin_driver_fields(plugin_storage, config, protocol, "driver-sidecar-v1").await;
    let plugin_id = config
        .additional_fields
        .get("plugin_id")
        .map(String::as_str)
        .unwrap_or_default()
        .to_string();
    let driver_id = config
        .additional_fields
        .get("plugin_driver_id")
        .map(String::as_str)
        .unwrap_or_default()
        .to_string();
    if plugin_id.is_empty() || driver_id.is_empty() {
        return Err(anyhow!(
            "{protocol} connections require an installed native driver plugin (sidecar)"
        ));
    }
    let storage = plugin_storage.clone();
    let (resolve_plugin, resolve_driver) = (plugin_id.clone(), driver_id.clone());
    let resolved = tokio::task::spawn_blocking(move || {
        crate::commands::plugins::resolve_active_sidecar(&storage, &resolve_plugin, &resolve_driver)
    })
    .await
    .map_err(|_| anyhow!("Native driver plugin verification stopped unexpectedly"))?
    .map_err(anyhow::Error::msg)?;

    let executable = crate::database::sidecar::sidecar_executable_path(
        &resolved.bundle_dir,
        &resolved.driver_id,
    );
    if !executable.exists() {
        return Err(anyhow!(
            "Native driver plugin '{}' has no sidecar binary for this platform ({}).",
            resolved.plugin_id,
            crate::database::sidecar::platform_target()
        ));
    }
    let driver = crate::database::sidecar::SidecarDriver::spawn(&executable, &[], config).await?;
    let driver: Arc<dyn DatabaseDriver> = Arc::new(driver);
    Ok(driver)
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
            connection_query_timeouts: Arc::new(RwLock::new(HashMap::new())),
            read_only_connections: Arc::new(RwLock::new(HashSet::new())),
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

        let driver: Arc<dyn DatabaseDriver> = match actual_config.db_type {
            DatabaseType::MySQL | DatabaseType::MariaDB => {
                Arc::new(MySqlDriver::connect(&actual_config).await?)
            }
            DatabaseType::PostgreSQL
            | DatabaseType::CockroachDB
            | DatabaseType::Greenplum
            | DatabaseType::Redshift
            | DatabaseType::Vertica => Arc::new(PostgresDriver::connect(&actual_config).await?),
            DatabaseType::SQLite => {
                let path = actual_config.file_path.as_deref().unwrap_or(":memory:");
                Arc::new(SqliteDriver::connect(path).await?)
            }
            #[cfg(feature = "duckdb-driver")]
            DatabaseType::DuckDB => Arc::new(DuckDbDriver::connect(&actual_config).await?),
            #[cfg(not(feature = "duckdb-driver"))]
            DatabaseType::DuckDB => {
                connect_native_sidecar(&self.plugin_storage, &mut actual_config, "duckdb").await?
            }
            #[cfg(feature = "cassandra-driver")]
            DatabaseType::Cassandra => Arc::new(CassandraDriver::connect(&actual_config).await?),
            #[cfg(not(feature = "cassandra-driver"))]
            DatabaseType::Cassandra => {
                connect_native_sidecar(&self.plugin_storage, &mut actual_config, "cassandra")
                    .await?
            }
            DatabaseType::Snowflake => {
                require_installed_http_plugin(
                    &self.plugin_storage,
                    &mut actual_config,
                    "snowflake",
                )
                .await?;
                Arc::new(SnowflakeDriver::connect(&actual_config).await?)
            }
            DatabaseType::MSSQL => Arc::new(MssqlDriver::connect(&actual_config).await?),
            #[cfg(feature = "libsql-driver")]
            DatabaseType::LibSQL => Arc::new(LibSqlDriver::connect(&actual_config).await?),
            #[cfg(not(feature = "libsql-driver"))]
            DatabaseType::LibSQL => {
                connect_native_sidecar(&self.plugin_storage, &mut actual_config, "libsql").await?
            }
            DatabaseType::ClickHouse => {
                require_installed_http_plugin(
                    &self.plugin_storage,
                    &mut actual_config,
                    "clickhouse",
                )
                .await?;
                Arc::new(ClickHouseDriver::connect(&actual_config).await?)
            }
            DatabaseType::BigQuery => {
                require_installed_http_plugin(&self.plugin_storage, &mut actual_config, "bigquery")
                    .await?;
                Arc::new(BigQueryDriver::connect(&actual_config).await?)
            }
            DatabaseType::CloudflareD1 => {
                require_installed_http_plugin(
                    &self.plugin_storage,
                    &mut actual_config,
                    "cloudflare_d1",
                )
                .await?;
                Arc::new(CloudflareD1Driver::connect(&actual_config).await?)
            }
            #[cfg(feature = "redis-driver")]
            DatabaseType::Redis => Arc::new(RedisDriver::connect(&actual_config).await?),
            #[cfg(not(feature = "redis-driver"))]
            DatabaseType::Redis => {
                connect_native_sidecar(&self.plugin_storage, &mut actual_config, "redis").await?
            }
            DatabaseType::MongoDB => Arc::new(MongoDbDriver::connect(&actual_config).await?),
            DatabaseType::OpenSearch => {
                let plugin_id = require_installed_http_plugin(
                    &self.plugin_storage,
                    &mut actual_config,
                    "opensearch",
                )
                .await?;
                Arc::new(OpenSearchDriver::connect(&actual_config, plugin_id).await?)
            }
            DatabaseType::Elasticsearch => {
                let plugin_id = require_installed_http_plugin(
                    &self.plugin_storage,
                    &mut actual_config,
                    "elasticsearch",
                )
                .await?;
                Arc::new(ElasticsearchDriver::connect(&actual_config, plugin_id).await?)
            }
            DatabaseType::Oracle => {
                require_installed_http_plugin(&self.plugin_storage, &mut actual_config, "oracle")
                    .await?;
                Arc::new(OracleDriver::connect(&actual_config).await?)
            }
            DatabaseType::Spanner => {
                require_installed_http_plugin(&self.plugin_storage, &mut actual_config, "spanner")
                    .await?;
                Arc::new(SpannerDriver::connect(&actual_config).await?)
            }
            DatabaseType::DynamoDB => {
                require_installed_http_plugin(&self.plugin_storage, &mut actual_config, "dynamodb")
                    .await?;
                Arc::new(DynamoDbDriver::connect(&actual_config).await?)
            }
            DatabaseType::Trino => {
                require_installed_http_plugin(&self.plugin_storage, &mut actual_config, "trino")
                    .await?;
                Arc::new(TrinoDriver::connect(&actual_config).await?)
            }
            DatabaseType::Typesense => {
                require_installed_http_plugin(
                    &self.plugin_storage,
                    &mut actual_config,
                    "typesense",
                )
                .await?;
                Arc::new(TypesenseDriver::connect(&actual_config).await?)
            }
            DatabaseType::SurrealDB => {
                require_installed_http_plugin(
                    &self.plugin_storage,
                    &mut actual_config,
                    "surrealdb",
                )
                .await?;
                Arc::new(SurrealDbDriver::connect(&actual_config).await?)
            }
            DatabaseType::Weaviate => {
                require_installed_http_plugin(&self.plugin_storage, &mut actual_config, "weaviate")
                    .await?;
                Arc::new(WeaviateDriver::connect(&actual_config).await?)
            }
        };

        let mut conns = self.connections.write().await;
        let previous_driver = conns.insert(config.id.clone(), driver);
        drop(conns);

        self.connection_types
            .write()
            .await
            .insert(config.id.clone(), config.db_type);

        match config.query_timeout_seconds.filter(|&secs| secs > 0) {
            Some(secs) => {
                self.connection_query_timeouts
                    .write()
                    .await
                    .insert(config.id.clone(), secs);
            }
            None => {
                // Reconnecting with the override cleared must not leave a stale
                // entry from the previous session.
                self.connection_query_timeouts
                    .write()
                    .await
                    .remove(&config.id);
            }
        }
        if config.read_only {
            self.read_only_connections
                .write()
                .await
                .insert(config.id.clone());
        } else {
            // Reconnecting with the pin cleared must not leave a stale entry.
            self.read_only_connections.write().await.remove(&config.id);
        }

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
        self.connection_query_timeouts
            .write()
            .await
            .remove(connection_id);
        self.read_only_connections
            .write()
            .await
            .remove(connection_id);
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
        self.connection_query_timeouts.write().await.clear();
        self.read_only_connections.write().await.clear();

        let mut tunnels = self.ssh_tunnels.write().await;
        for (_, handle) in tunnels.drain() {
            let _ = self.ssh_manager.disconnect_tunnel(handle);
        }

        Ok(())
    }

    /// Get a driver by connection ID. Returns an `Arc` clone so the map's
    /// read-lock is released immediately: pings and long queries no longer
    /// block connect/disconnect (write-lock) while waiting on the network.
    pub async fn get_driver(&self, connection_id: &str) -> Result<Arc<dyn DatabaseDriver>> {
        let conns = self.connections.read().await;
        conns
            .get(connection_id)
            .cloned()
            .ok_or_else(|| connection_not_found(connection_id))
    }

    /// Check if a connection exists and is alive. The ping runs on a cloned
    /// `Arc` with the map lock released, so a slow network round-trip never
    /// stalls connect/disconnect.
    pub async fn is_connected(&self, connection_id: &str) -> bool {
        let Ok(driver) = self.get_driver(connection_id).await else {
            return false;
        };
        driver.ping().await.is_ok()
    }

    pub async fn connection_database_type(&self, connection_id: &str) -> Result<DatabaseType> {
        self.connection_types
            .read()
            .await
            .get(connection_id)
            .copied()
            .ok_or_else(|| connection_not_found(connection_id))
    }

    /// Per-connection query timeout override in seconds, captured at connect
    /// time. `None` means the caller should use the classified default window.
    pub async fn connection_query_timeout(&self, connection_id: &str) -> Option<u64> {
        self.connection_query_timeouts
            .read()
            .await
            .get(connection_id)
            .copied()
    }
    /// Whether this live session was opened with `ConnectionConfig::read_only`.
    /// Unknown/disconnected ids report false — callers already fail those on
    /// the driver lookup, so the flag only gates sessions that exist.
    pub async fn is_read_only(&self, connection_id: &str) -> bool {
        self.read_only_connections
            .read()
            .await
            .contains(connection_id)
    }

    /// Earliest-guard check for every write path: a read-only connection
    /// rejects the command before any statement reaches the driver. The
    /// message is user-facing and stable — the frontend surfaces it verbatim.
    pub async fn assert_write_allowed(&self, connection_id: &str) -> Result<(), String> {
        if self.is_read_only(connection_id).await {
            return Err(format!(
                "Connection '{connection_id}' is read-only. Write operations are blocked."
            ));
        }
        Ok(())
    }

    pub async fn get_connection_capabilities(
        &self,
        connection_id: &str,
    ) -> Result<DriverCapabilityProfile> {
        let connection_types = self.connection_types.read().await;
        let database_type = connection_types
            .get(connection_id)
            .copied()
            .ok_or_else(|| connection_not_found(connection_id))?;
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
