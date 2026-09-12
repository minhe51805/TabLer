//! LibSQL `driver-sidecar-v1` sidecar: a real out-of-process native driver.
//!
//! Production counterpart to `reference_sidecar` for the LibSQL/Turso engine. It
//! plugs the compiled `LibSqlDriver` into the reusable
//! [`tabler_lib::database::sidecar::serve`] loop and speaks the framed protocol
//! over stdio, exactly as a downloaded per-platform native driver would. A lean
//! app build (without `libsql-driver`) resolves this binary from an installed
//! `driver-sidecar-v1` plugin instead of linking the crate.
//!
//! Built only with the `libsql-sidecar` feature (which pulls `libsql-driver`) so
//! normal app builds stay lean.

use std::sync::Arc;

use anyhow::Result;
use async_trait::async_trait;
use tabler_lib::database::driver::DatabaseDriver;
use tabler_lib::database::libsql::LibSqlDriver;
use tabler_lib::database::models::ConnectionConfig;
use tabler_lib::database::sidecar::{serve, SidecarBackend};

/// Backs the sidecar with the compiled LibSQL driver.
struct LibSqlBackend;

#[async_trait]
impl SidecarBackend for LibSqlBackend {
    fn driver_name(&self) -> String {
        "libsql-sidecar".to_string()
    }

    async fn connect(&self, config: ConnectionConfig) -> Result<Arc<dyn DatabaseDriver>> {
        Ok(Arc::new(LibSqlDriver::connect(&config).await?))
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    // stdout carries the framed protocol; diagnostics must go to stderr only.
    serve(LibSqlBackend, tokio::io::stdin(), tokio::io::stdout()).await
}
