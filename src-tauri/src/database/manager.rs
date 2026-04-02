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
            | DatabaseType::Redshift
            | DatabaseType::Vertica => {
                Box::new(PostgresDriver::connect(config).await?)
            }
            DatabaseType::SQLite => {
                let path = config.file_path.as_deref().unwrap_or(":memory:");
                Box::new(SqliteDriver::connect(path).await?)
            }
            DatabaseType::DuckDB => {
                Box::new(DuckDbDriver::connect(config).await?)
            }
            DatabaseType::Cassandra => {
                Box::new(CassandraDriver::connect(config).await?)
            }
            DatabaseType::Snowflake => {
                Box::new(SnowflakeDriver::connect(config).await?)
            }
            DatabaseType::MSSQL => {
                Box::new(MssqlDriver::connect(config).await?)
            }
            DatabaseType::LibSQL => {
                Box::new(LibSqlDriver::connect(config).await?)
            }
            DatabaseType::ClickHouse => {
                Box::new(ClickHouseDriver::connect(config).await?)
            }
            DatabaseType::BigQuery => {
                Box::new(BigQueryDriver::connect(config).await?)
            }
            DatabaseType::CloudflareD1 => {
                Box::new(CloudflareD1Driver::connect(config).await?)
            }
            DatabaseType::Redis => {
                Box::new(RedisDriver::connect(config).await?)
            }
            DatabaseType::MongoDB => {
                Box::new(MongoDbDriver::connect(config).await?)
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
