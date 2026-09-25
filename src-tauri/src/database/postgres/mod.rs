use crate::database::models::DatabaseType;
use crate::database::query_cancel::QueryCancelRegistry;
use sqlx::postgres::{PgConnectOptions, PgPool};
use std::collections::HashMap;
use std::sync::{Arc, RwLock as StdRwLock};
use tokio::sync::RwLock;

pub struct PostgresDriver {
    pub(super) pool: StdRwLock<PgPool>,
    connect_options: PgConnectOptions,
    pub(super) current_db: Arc<RwLock<Option<String>>>,
    cancel_registry: StdRwLock<QueryCancelRegistry>,
    /// Engine from the connection config. Several engines share this wire
    /// driver; Vertica needs it to cancel via INTERRUPT_STATEMENT instead of
    /// pg_cancel_backend (which Vertica does not honor).
    db_type: DatabaseType,
    /// Vertica cancel bookkeeping: request_id -> session id captured from
    /// `SELECT current_session()` when the request started.
    vertica_sessions: StdRwLock<VerticaSessionRegistry>,
    /// Resolved pool size for this connection, reused when the pool is rebuilt
    /// on `use_database` so the override survives a database switch.
    pool_max_connections: u32,
}

/// Vertica-side cancel bookkeeping. The shared [`QueryCancelRegistry`] only
/// stores a numeric backend id, which Vertica cannot use: INTERRUPT_STATEMENT
/// needs the session id (a string like `v_node0001-1234:0x1a`) plus the
/// running statement id, which is resolved from v_monitor.query_requests at
/// cancel time because it does not exist until the statement starts
/// executing.
#[derive(Default)]
pub(super) struct VerticaSessionRegistry {
    sessions: HashMap<String, String>,
}

impl VerticaSessionRegistry {
    pub(super) fn register(&mut self, request_id: &str, session_id: String) {
        self.sessions.insert(request_id.to_string(), session_id);
    }

    pub(super) fn session_id(&self, request_id: &str) -> Option<String> {
        self.sessions.get(request_id).cloned()
    }

    pub(super) fn finish(&mut self, request_id: &str) {
        self.sessions.remove(request_id);
    }
}

mod connect;
mod driver_ops;
mod exec;
