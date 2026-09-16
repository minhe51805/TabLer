use super::PostgresDriver;
use crate::config::resolve_pool_max_connections;
use crate::database::models::*;
use crate::database::pgpass::read_pgpass;
use crate::database::query_cancel::QueryCancelRegistry;
use anyhow::{Context, Result};
use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions};
use sqlx::ConnectOptions;
use std::sync::{Arc, RwLock as StdRwLock};
use tokio::sync::RwLock;

impl PostgresDriver {
    pub async fn connect(config: &ConnectionConfig) -> Result<Self> {
        let host = config.host.as_deref().unwrap_or("127.0.0.1");
        let port = config.port.unwrap_or_else(|| config.default_port());
        let user = config
            .username
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .context("PostgreSQL username is required")?;
        let database = config.database.as_deref().unwrap_or("postgres");

        // Determine password: explicit > env > pgpass
        let password = if let Some(ref pwd) = config.password {
            if !pwd.is_empty() {
                Some(pwd.clone())
            } else {
                read_pgpass(host, port, database, user)
            }
        } else {
            // No explicit password — check pgpass
            read_pgpass(host, port, database, user)
        };

        let mut options = PgConnectOptions::new()
            .host(host)
            .port(port)
            .username(user)
            .password(password.as_deref().unwrap_or(""))
            .database(database);

        options = options.disable_statement_logging();

        // sqlx 0.8 does not expose a dedicated "skip host verification" toggle
        // for PostgreSQL. If the config requests it, use VerifyCa instead of
        // VerifyFull so we still validate the certificate chain without forcing
        // host identity verification.
        let ssl_mode = match config.effective_ssl_mode() {
            SslMode::VerifyFull if config.ssl_skip_host_verification.unwrap_or(false) => {
                SslMode::VerifyCa
            }
            mode => mode,
        };

        options = match ssl_mode {
            SslMode::Disable => options.ssl_mode(sqlx::postgres::PgSslMode::Disable),
            SslMode::Prefer => options.ssl_mode(sqlx::postgres::PgSslMode::Prefer),
            SslMode::Require => options.ssl_mode(sqlx::postgres::PgSslMode::Require),
            SslMode::VerifyCa => {
                let mut opts = options.ssl_mode(sqlx::postgres::PgSslMode::VerifyCa);
                if let Some(ref ca_path) = config.ssl_ca_cert_path {
                    opts = opts.ssl_root_cert(std::path::Path::new(ca_path));
                }
                opts
            }
            SslMode::VerifyFull => {
                let mut opts = options.ssl_mode(sqlx::postgres::PgSslMode::VerifyFull);
                if let Some(ref ca_path) = config.ssl_ca_cert_path {
                    opts = opts.ssl_root_cert(std::path::Path::new(ca_path));
                }
                opts
            }
        };

        // Apply client certificate if provided
        if let (Some(ref cert_path), Some(ref key_path)) =
            (&config.ssl_client_cert_path, &config.ssl_client_key_path)
        {
            options = options
                .ssl_client_cert(std::path::Path::new(cert_path))
                .ssl_client_key(std::path::Path::new(key_path));
        }

        let pool_max_connections = resolve_pool_max_connections(config.pool_max_connections());
        let pool = Self::open_pool(options.clone(), pool_max_connections).await?;
        Ok(Self {
            pool: StdRwLock::new(pool),
            connect_options: options,
            current_db: Arc::new(RwLock::new(Some(database.to_string()))),
            cancel_registry: StdRwLock::new(QueryCancelRegistry::new()),
            pool_max_connections,
        })
    }

    pub(crate) fn pool(&self) -> PgPool {
        self.pool
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub(super) async fn open_pool(
        options: PgConnectOptions,
        max_connections: u32,
    ) -> Result<PgPool> {
        let mut last_error = None;
        for attempt in 1..=3 {
            let pool_opts = PgPoolOptions::new()
                .min_connections(1)
                .max_connections(max_connections)
                .max_lifetime(std::time::Duration::from_secs(1800))
                .acquire_timeout(std::time::Duration::from_secs(30))
                .idle_timeout(std::time::Duration::from_secs(600))
                // Avoid an extra validation round-trip on every acquire. The initial
                // connect path already proves the pool is live, and query failures
                // surface naturally if the server drops later.
                .test_before_acquire(false);

            match pool_opts.connect_with(options.clone()).await {
                Ok(pool) => return Ok(pool),
                Err(e) => {
                    last_error = Some(e);
                    if attempt < 3 {
                        tokio::time::sleep(std::time::Duration::from_millis(500 * attempt)).await;
                    }
                }
            }
        }

        let error = last_error
            .map(|err| err.to_string())
            .unwrap_or_else(|| "unknown connection error".to_string());
        Err(anyhow::anyhow!(
            "Failed to connect to PostgreSQL after 3 attempts: {}",
            error
        ))
    }
}
