//! Reference `driver-sidecar-v1` sidecar: a real out-of-process database driver.
//!
//! This binary demonstrates the Phase 4 native-driver sidecar contract end to
//! end. It plugs a concrete [`SidecarBackend`] into the reusable
//! [`tabler_lib::database::sidecar::serve`] loop and speaks the framed protocol
//! over stdio, exactly as a downloaded per-platform native driver would.
//!
//! To keep it dependency-light and deterministic (no external server, works in
//! CI), it backs the protocol with the built-in SQLite driver -- a real
//! `DatabaseDriver`. A production native sidecar (DuckDB, Cassandra, Redis,
//! LibSQL) swaps `SqliteBackend` for its own driver behind that crate's feature
//! and reuses `serve` verbatim; nothing else about the wire contract changes.
//!
//! It is built only with the `reference-sidecar` feature so normal app builds
//! stay lean.

use std::sync::Arc;

use anyhow::Result;
use async_trait::async_trait;
use tabler_lib::database::driver::DatabaseDriver;
use tabler_lib::database::models::ConnectionConfig;
use tabler_lib::database::sidecar::{serve, SidecarBackend};
use tabler_lib::database::sqlite::SqliteDriver;

/// Backs the sidecar with the built-in SQLite driver.
struct SqliteBackend;

#[async_trait]
impl SidecarBackend for SqliteBackend {
    fn driver_name(&self) -> String {
        "sqlite-sidecar".to_string()
    }

    async fn connect(&self, config: ConnectionConfig) -> Result<Arc<dyn DatabaseDriver>> {
        // The host passes the SQLite file path in `file_path`; fall back to an
        // in-process temp database when unset.
        let path = config.file_path.as_deref().unwrap_or(":memory:");
        Ok(Arc::new(SqliteDriver::connect(path).await?))
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    // stdout carries the framed protocol; diagnostics must go to stderr only.
    serve(SqliteBackend, tokio::io::stdin(), tokio::io::stdout()).await
}
