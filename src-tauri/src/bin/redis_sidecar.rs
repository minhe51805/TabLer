//! Redis `driver-sidecar-v1` sidecar: a real out-of-process native driver.
//!
//! Production counterpart to `reference_sidecar` for the Redis engine. It plugs
//! the compiled `RedisDriver` into the reusable
//! [`tabler_lib::database::sidecar::serve`] loop and speaks the framed protocol
//! over stdio, exactly as a downloaded per-platform native driver would. A lean
//! app build (without `redis-driver`) resolves this binary from an installed
//! `driver-sidecar-v1` plugin instead of linking the crate.
//!
//! Built only with the `redis-sidecar` feature (which pulls `redis-driver`) so
//! normal app builds stay lean.

use std::sync::Arc;

use anyhow::Result;
use async_trait::async_trait;
use tabler_lib::database::driver::DatabaseDriver;
use tabler_lib::database::models::ConnectionConfig;
use tabler_lib::database::redis::RedisDriver;
use tabler_lib::database::sidecar::{serve, SidecarBackend};

/// Backs the sidecar with the compiled Redis driver.
struct RedisBackend;

#[async_trait]
impl SidecarBackend for RedisBackend {
    fn driver_name(&self) -> String {
        "redis-sidecar".to_string()
    }

    async fn connect(&self, config: ConnectionConfig) -> Result<Arc<dyn DatabaseDriver>> {
        Ok(Arc::new(RedisDriver::connect(&config).await?))
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    // stdout carries the framed protocol; diagnostics must go to stderr only.
    serve(RedisBackend, tokio::io::stdin(), tokio::io::stdout()).await
}
