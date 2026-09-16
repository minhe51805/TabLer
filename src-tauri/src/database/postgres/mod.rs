use crate::database::query_cancel::QueryCancelRegistry;
use sqlx::postgres::{PgConnectOptions, PgPool};
use std::sync::{Arc, RwLock as StdRwLock};
use tokio::sync::RwLock;

pub struct PostgresDriver {
    pub(super) pool: StdRwLock<PgPool>,
    connect_options: PgConnectOptions,
    pub(super) current_db: Arc<RwLock<Option<String>>>,
    cancel_registry: StdRwLock<QueryCancelRegistry>,
    /// Resolved pool size for this connection, reused when the pool is rebuilt
    /// on `use_database` so the override survives a database switch.
    pool_max_connections: u32,
}

mod connect;
mod driver_ops;
mod exec;
