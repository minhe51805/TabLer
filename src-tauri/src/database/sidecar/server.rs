//! Sidecar-side server harness for the `driver-sidecar-v1` protocol.
//!
//! This is the reusable half a native sidecar binary is built on: it owns the
//! stdio conversation, reads [`HostFrame`]s, dispatches each [`SidecarCall`] to a
//! real [`DatabaseDriver`], and writes framed [`SidecarFrame`] responses back.
//! A concrete sidecar only supplies a [`SidecarBackend`] (how to build the
//! driver from a [`ConnectionConfig`]); everything else — handshake, framing,
//! per-request concurrency, cancellation, and streaming imports — lives here so
//! every native sidecar shares one correct implementation.
//!
//! Concurrency mirrors the host [`super::client::SidecarClient`]: a writer task
//! serializes outgoing frames, the read loop stays responsive, and each unary
//! call runs on its own task so a slow query cannot block a concurrent
//! `CancelQueryRequest`. Handshake and Connect are handled inline so the driver
//! is guaranteed to exist before any dependent call is dispatched.

use super::encode_frame;
use super::protocol::{
    HostFrame, SidecarCall, SidecarError, SidecarErrorKind, SidecarFrame, SidecarOutcome,
    SidecarRequest, SidecarResponse, SidecarResponsePayload, SIDECAR_PROTOCOL_VERSION,
};
use crate::database::driver::DatabaseDriver;
use crate::database::models::{ConnectionConfig, CsvImportRow};
use anyhow::Result;
use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

/// Rows buffered for a streaming import before the driver receiver applies them.
const STREAM_CHANNEL_CAPACITY: usize = 1024;

/// What a concrete sidecar must provide: a stable driver name for the handshake
/// and a way to open the real [`DatabaseDriver`] for a connection request. All
/// protocol handling is done by [`serve`].
#[async_trait]
pub trait SidecarBackend: Send + Sync + 'static {
    /// Name reported back in the handshake (also the trait `driver_name`).
    fn driver_name(&self) -> String;

    /// Open the underlying connection and return the live driver. Errors are
    /// surfaced to the host as a `Connection`-kind [`SidecarError`].
    async fn connect(&self, config: ConnectionConfig) -> Result<Arc<dyn DatabaseDriver>>;
}

type ConnectedDriver = Arc<Mutex<Option<Arc<dyn DatabaseDriver>>>>;
type CancelFlags = Arc<Mutex<HashMap<u64, Arc<AtomicBool>>>>;
type StreamSenders = Arc<Mutex<HashMap<u64, mpsc::Sender<CsvImportRow>>>>;

/// Run the sidecar protocol over `reader`/`writer` until a [`HostFrame::Shutdown`]
/// or EOF. The transport is generic so a real binary passes the process stdio
/// while tests can drive it over an in-memory duplex.
pub async fn serve<B, R, W>(backend: B, reader: R, writer: W) -> Result<()>
where
    B: SidecarBackend,
    R: AsyncRead + Send + Unpin,
    W: AsyncWrite + Send + Unpin + 'static,
{
    let (out_tx, mut out_rx) = mpsc::channel::<String>(1024);
    let writer_task = tokio::spawn(async move {
        let mut writer = writer;
        while let Some(line) = out_rx.recv().await {
            if writer.write_all(line.as_bytes()).await.is_err()
                || writer.write_all(b"\n").await.is_err()
                || writer.flush().await.is_err()
            {
                break;
            }
        }
    });

    let backend = Arc::new(backend);
    let driver: ConnectedDriver = Arc::new(Mutex::new(None));
    let cancels: CancelFlags = Arc::new(Mutex::new(HashMap::new()));
    let streams: StreamSenders = Arc::new(Mutex::new(HashMap::new()));

    let mut lines = BufReader::new(reader).lines();
    while let Some(line) = lines.next_line().await? {
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            continue;
        }
        let frame: HostFrame = match super::decode_frame(trimmed) {
            Ok(f) => f,
            Err(e) => {
                send_frame(
                    &out_tx,
                    SidecarFrame::Log {
                        level: "error".into(),
                        message: format!("dropping undecodable host frame: {e}"),
                    },
                )
                .await;
                continue;
            }
        };

        match frame {
            HostFrame::Shutdown => break,
            HostFrame::Cancel { id } => {
                if let Some(flag) = cancels.lock().unwrap().get(&id) {
                    flag.store(true, Ordering::SeqCst);
                }
            }
            HostFrame::StreamChunk { id, rows } => {
                let tx = streams.lock().unwrap().get(&id).cloned();
                if let Some(tx) = tx {
                    for row in rows {
                        if tx.send(row).await.is_err() {
                            break;
                        }
                    }
                }
            }
            HostFrame::StreamEnd { id } => {
                // Dropping the sender closes the channel so the import task ends.
                streams.lock().unwrap().remove(&id);
            }
            HostFrame::Request(SidecarRequest { id, call }) => {
                handle_request(id, call, &backend, &driver, &cancels, &streams, &out_tx).await;
            }
        }
    }

    drop(out_tx);
    let _ = writer_task.await;
    Ok(())
}

/// Route one host request. Handshake and Connect run inline (they establish
/// state every later call depends on); all other calls are spawned so the read
/// loop keeps servicing cancellations and streamed rows.
#[allow(clippy::too_many_arguments)]
async fn handle_request<B: SidecarBackend>(
    id: u64,
    call: SidecarCall,
    backend: &Arc<B>,
    driver: &ConnectedDriver,
    cancels: &CancelFlags,
    streams: &StreamSenders,
    out_tx: &mpsc::Sender<String>,
) {
    match call {
        SidecarCall::Handshake { .. } => {
            let payload = SidecarResponsePayload::Handshake {
                protocol_version: SIDECAR_PROTOCOL_VERSION.to_string(),
                driver_name: backend.driver_name(),
            };
            send_response(out_tx, id, SidecarOutcome::Ok(payload)).await;
        }
        SidecarCall::Connect { config } => {
            let outcome = match backend.connect(*config).await {
                Ok(d) => {
                    *driver.lock().unwrap() = Some(d);
                    SidecarOutcome::Ok(SidecarResponsePayload::Unit)
                }
                Err(e) => err_outcome(e, SidecarErrorKind::Connection),
            };
            send_response(out_tx, id, outcome).await;
        }
        SidecarCall::InsertTableRowStreamAtomically => {
            let connected = driver.lock().unwrap().clone();
            let Some(d) = connected else {
                send_response(out_tx, id, not_connected()).await;
                return;
            };
            let (row_tx, row_rx) = mpsc::channel::<CsvImportRow>(STREAM_CHANNEL_CAPACITY);
            let cancelled = Arc::new(AtomicBool::new(false));
            cancels.lock().unwrap().insert(id, Arc::clone(&cancelled));
            streams.lock().unwrap().insert(id, row_tx);
            let out_tx = out_tx.clone();
            let cancels = Arc::clone(cancels);
            let streams = Arc::clone(streams);
            tokio::spawn(async move {
                let outcome = match d
                    .insert_table_row_stream_atomically(row_rx, cancelled)
                    .await
                {
                    Ok(n) => SidecarOutcome::Ok(SidecarResponsePayload::Affected(n)),
                    Err(e) => err_outcome(e, SidecarErrorKind::Query),
                };
                send_response(&out_tx, id, outcome).await;
                cancels.lock().unwrap().remove(&id);
                streams.lock().unwrap().remove(&id);
            });
        }
        other => {
            let connected = driver.lock().unwrap().clone();
            let cancelled = Arc::new(AtomicBool::new(false));
            cancels.lock().unwrap().insert(id, Arc::clone(&cancelled));
            let out_tx = out_tx.clone();
            let cancels = Arc::clone(cancels);
            tokio::spawn(async move {
                let outcome = match connected {
                    Some(d) => dispatch(d.as_ref(), other, cancelled).await,
                    None => not_connected(),
                };
                send_response(&out_tx, id, outcome).await;
                cancels.lock().unwrap().remove(&id);
            });
        }
    }
}

/// Map one unary [`SidecarCall`] to its [`DatabaseDriver`] method and wrap the
/// result in a typed payload. Mirrors the host `SidecarDriver` impl exactly, so
/// the two stay in lockstep as the trait evolves.
async fn dispatch(
    driver: &dyn DatabaseDriver,
    call: SidecarCall,
    cancelled: Arc<AtomicBool>,
) -> SidecarOutcome {
    use SidecarResponsePayload as P;
    let result: Result<SidecarResponsePayload> = match call {
        // Handled inline by the caller; never dispatched here.
        SidecarCall::Handshake { .. }
        | SidecarCall::Connect { .. }
        | SidecarCall::InsertTableRowStreamAtomically => {
            return err_outcome(
                anyhow::anyhow!("call must not be dispatched to the driver"),
                SidecarErrorKind::Protocol,
            )
        }
        SidecarCall::Ping => driver.ping().await.map(|_| P::Unit),
        SidecarCall::Disconnect => driver.disconnect().await.map(|_| P::Unit),
        SidecarCall::ListDatabases => driver.list_databases().await.map(P::Databases),
        SidecarCall::ListTables { database } => {
            driver.list_tables(database.as_deref()).await.map(P::Tables)
        }
        SidecarCall::ListSchemaObjects { database } => driver
            .list_schema_objects(database.as_deref())
            .await
            .map(P::SchemaObjects),
        SidecarCall::GetTableStructure { table, database } => driver
            .get_table_structure(&table, database.as_deref())
            .await
            .map(P::TableStructure),
        SidecarCall::GetTableColumnsPreview { table, database } => driver
            .get_table_columns_preview(&table, database.as_deref())
            .await
            .map(P::Columns),
        SidecarCall::ExecuteQuery { sql } => driver.execute_query(&sql).await.map(P::Query),
        SidecarCall::ExecuteQueryForRequest { request_id, sql } => driver
            .execute_query_for_request(&request_id, &sql)
            .await
            .map(P::Query),
        SidecarCall::CancelQueryRequest { request_id } => driver
            .cancel_query_request(&request_id)
            .await
            .map(P::Cancelled),
        SidecarCall::ExecuteParameterizedQuery { sql, parameters } => driver
            .execute_parameterized_query(&sql, &parameters)
            .await
            .map(P::Query),
        SidecarCall::ExecuteParameterizedQueryForRequest {
            request_id,
            sql,
            parameters,
        } => driver
            .execute_parameterized_query_for_request(&request_id, &sql, &parameters)
            .await
            .map(P::Query),

        SidecarCall::GetTableData {
            table,
            database,
            offset,
            limit,
            order_by,
            order_dir,
            filter,
        } => driver
            .get_table_data(
                &table,
                database.as_deref(),
                offset,
                limit,
                order_by.as_deref(),
                order_dir.as_deref(),
                filter.as_deref(),
            )
            .await
            .map(P::Query),
        SidecarCall::CountRows { table, database } => driver
            .count_rows(&table, database.as_deref())
            .await
            .map(P::Count),
        SidecarCall::CountNullValues {
            table,
            database,
            column,
        } => driver
            .count_null_values(&table, database.as_deref(), &column)
            .await
            .map(P::Count),
        SidecarCall::UpdateTableCell { request } => {
            driver.update_table_cell(&request).await.map(P::Affected)
        }
        SidecarCall::ApplyTableUpdatesAtomically { updates } => driver
            .apply_table_updates_atomically(&updates)
            .await
            .map(P::Affected),
        SidecarCall::DeleteTableRows { request } => {
            driver.delete_table_rows(&request).await.map(P::Affected)
        }
        SidecarCall::InsertTableRow { request } => {
            driver.insert_table_row(&request).await.map(P::Affected)
        }
        SidecarCall::InsertTableRowsAtomically { requests } => driver
            .insert_table_rows_atomically(&requests, cancelled)
            .await
            .map(P::Affected),
        SidecarCall::ExecuteStructureStatements { statements } => driver
            .execute_structure_statements(&statements)
            .await
            .map(P::Affected),
        SidecarCall::PreviewWriteTransaction { statements } => driver
            .preview_write_transaction(&statements)
            .await
            .map(P::Queries),
        SidecarCall::ExecuteRestoreStatements { statements } => driver
            .execute_restore_statements(&statements)
            .await
            .map(P::Affected),
        SidecarCall::UseDatabase { database } => {
            driver.use_database(&database).await.map(|_| P::Unit)
        }
        SidecarCall::GetForeignKeyLookupValues {
            referenced_table,
            referenced_column,
            display_columns,
            search,
            limit,
        } => {
            let display: Vec<&str> = display_columns.iter().map(String::as_str).collect();
            driver
                .get_foreign_key_lookup_values(
                    &referenced_table,
                    &referenced_column,
                    &display,
                    search.as_deref(),
                    limit,
                )
                .await
                .map(P::LookupValues)
        }
        SidecarCall::CurrentDatabase => Ok(P::CurrentDatabase(driver.current_database())),
        SidecarCall::DriverName => Ok(P::DriverName(driver.driver_name().to_string())),
    };

    match result {
        Ok(payload) => SidecarOutcome::Ok(payload),
        Err(e) => err_outcome(e, SidecarErrorKind::Query),
    }
}

fn err_outcome(err: anyhow::Error, kind: SidecarErrorKind) -> SidecarOutcome {
    SidecarOutcome::Err(SidecarError {
        message: err.to_string(),
        kind,
    })
}

fn not_connected() -> SidecarOutcome {
    SidecarOutcome::Err(SidecarError {
        message: "sidecar received a call before Connect".to_string(),
        kind: SidecarErrorKind::Protocol,
    })
}

async fn send_response(tx: &mpsc::Sender<String>, id: u64, outcome: SidecarOutcome) {
    send_frame(tx, SidecarFrame::Response(SidecarResponse { id, outcome })).await;
}

async fn send_frame(tx: &mpsc::Sender<String>, frame: SidecarFrame) {
    if let Ok(line) = encode_frame(&frame) {
        let _ = tx.send(line).await;
    }
}

#[cfg(test)]
mod tests {
    use super::{serve, SidecarBackend};
    use crate::database::driver::DatabaseDriver;
    use crate::database::models::{ConnectionConfig, DatabaseType};
    use crate::database::sidecar::client::SidecarClient;
    use crate::database::sidecar::protocol::{
        SidecarCall, SidecarResponsePayload, SIDECAR_PROTOCOL_VERSION,
    };
    use crate::database::sqlite::SqliteDriver;
    use anyhow::Result;
    use async_trait::async_trait;
    use std::sync::Arc;
    use std::time::Duration;

    /// A real backend for the harness test: opens the built-in SQLite driver so
    /// the whole `serve` -> dispatch -> driver path is exercised without needing
    /// an external server. A production native sidecar swaps this for its own
    /// driver behind a crate feature and reuses `serve` verbatim.
    struct SqliteBackend;

    #[async_trait]
    impl SidecarBackend for SqliteBackend {
        fn driver_name(&self) -> String {
            "sqlite-sidecar".to_string()
        }

        async fn connect(&self, config: ConnectionConfig) -> Result<Arc<dyn DatabaseDriver>> {
            let path = config.file_path.as_deref().unwrap_or(":memory:");
            Ok(Arc::new(SqliteDriver::connect(path).await?))
        }
    }

    fn sqlite_config(path: &str) -> ConnectionConfig {
        ConnectionConfig {
            id: "harness".into(),
            name: "harness".into(),
            db_type: DatabaseType::SQLite,
            host: None,
            port: None,
            username: None,
            password: None,
            database: None,
            file_path: Some(path.to_string()),
            use_ssl: false,
            ssl_mode: None,
            ssl_ca_cert_path: None,
            ssl_client_cert_path: None,
            ssl_client_key_path: None,
            ssl_skip_host_verification: None,
            color: None,
            additional_fields: Default::default(),
            pre_connect_script: None,
            startup_commands: None,
            ssh_config: None,
        }
    }

    /// Drive the real `SidecarClient` against the real `serve` loop over an
    /// in-memory duplex: handshake, connect, then a full DDL/DML/read round
    /// trip, and a clean shutdown. Proves the sidecar-side harness honors the
    /// wire contract end to end without spawning a process.
    #[tokio::test]
    async fn serve_round_trips_the_full_lifecycle_over_a_duplex() {
        let db_path =
            std::env::temp_dir().join(format!("tabler-sidecar-harness-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&db_path);

        let (host_io, sidecar_io) = tokio::io::duplex(1 << 16);
        let (host_r, host_w) = tokio::io::split(host_io);
        let (sidecar_r, sidecar_w) = tokio::io::split(sidecar_io);
        let server = tokio::spawn(serve(SqliteBackend, sidecar_r, sidecar_w));

        let client = SidecarClient::new(host_r, host_w, Duration::from_secs(15));

        let handshake = client
            .call(SidecarCall::Handshake {
                protocol_version: SIDECAR_PROTOCOL_VERSION.to_string(),
            })
            .await
            .expect("handshake");
        match handshake {
            SidecarResponsePayload::Handshake {
                protocol_version,
                driver_name,
            } => {
                assert_eq!(protocol_version, SIDECAR_PROTOCOL_VERSION);
                assert_eq!(driver_name, "sqlite-sidecar");
            }
            other => panic!("unexpected handshake reply: {other:?}"),
        }

        let connect = client
            .call(SidecarCall::Connect {
                config: Box::new(sqlite_config(db_path.to_str().unwrap())),
            })
            .await
            .expect("connect");
        assert!(matches!(connect, SidecarResponsePayload::Unit));

        assert!(matches!(
            client.call(SidecarCall::Ping).await.expect("ping"),
            SidecarResponsePayload::Unit
        ));
        client
            .call(SidecarCall::ExecuteQuery {
                sql: "CREATE TABLE harness_rows (id INTEGER PRIMARY KEY, name TEXT)".into(),
            })
            .await
            .expect("create");
        client
            .call(SidecarCall::ExecuteQuery {
                sql: "INSERT INTO harness_rows (id, name) VALUES (1,'a'),(2,'b'),(3,'c')".into(),
            })
            .await
            .expect("insert");

        match client
            .call(SidecarCall::CountRows {
                table: "harness_rows".into(),
                database: None,
            })
            .await
            .expect("count")
        {
            SidecarResponsePayload::Count(n) => assert_eq!(n, 3),
            other => panic!("unexpected count reply: {other:?}"),
        }

        match client
            .call(SidecarCall::ListTables { database: None })
            .await
            .expect("list tables")
        {
            SidecarResponsePayload::Tables(tables) => {
                assert!(tables.iter().any(|t| t.name == "harness_rows"));
            }
            other => panic!("unexpected list tables reply: {other:?}"),
        }

        match client
            .call(SidecarCall::ExecuteQuery {
                sql: "SELECT id, name FROM harness_rows ORDER BY id".into(),
            })
            .await
            .expect("select")
        {
            SidecarResponsePayload::Query(result) => assert_eq!(result.rows.len(), 3),
            other => panic!("unexpected select reply: {other:?}"),
        }

        client.shutdown().await;
        let served = tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .expect("serve loop ends after shutdown")
            .expect("serve task join");
        assert!(served.is_ok(), "serve returned an error: {served:?}");

        let _ = std::fs::remove_file(&db_path);
    }

    /// A call arriving before `Connect` must come back as a structured error,
    /// not a panic or a hang.
    #[tokio::test]
    async fn calls_before_connect_return_a_protocol_error() {
        let (host_io, sidecar_io) = tokio::io::duplex(1 << 16);
        let (host_r, host_w) = tokio::io::split(host_io);
        let (sidecar_r, sidecar_w) = tokio::io::split(sidecar_io);
        let _server = tokio::spawn(serve(SqliteBackend, sidecar_r, sidecar_w));
        let client = SidecarClient::new(host_r, host_w, Duration::from_secs(10));

        let err = client
            .call(SidecarCall::Ping)
            .await
            .expect_err("ping before connect must fail");
        assert!(
            err.to_string().contains("before Connect"),
            "unexpected error: {err}"
        );
        client.shutdown().await;
    }
}
