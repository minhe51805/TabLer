//! Host-side [`DatabaseDriver`] that proxies every trait method to an
//! out-of-process `driver-sidecar-v1` sidecar over [`SidecarClient`].
//!
//! This is the "compiled native driver, but out of process" half of Phase 4:
//! `manager.rs` (Phase 4c) hands this driver a verified sidecar executable for a
//! `plugin_native` engine whose crate feature was not built in, and from the
//! rest of the app it behaves like any other `DatabaseDriver`.

use super::client::SidecarClient;
use super::protocol::{SidecarCall, SidecarResponsePayload, SIDECAR_PROTOCOL_VERSION};
use crate::database::driver::DatabaseDriver;
use crate::database::models::*;
use anyhow::{anyhow, Result};
use async_trait::async_trait;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

/// Timeout for unary calls to the sidecar. Bulk/streaming operations are not
/// subject to it (they end on completion or cancellation).
const DEFAULT_CALL_TIMEOUT: Duration = Duration::from_secs(30);

pub struct SidecarDriver {
    client: SidecarClient,
    driver_name: String,
    /// Locally cached so the synchronous `current_database()` trait method can
    /// answer without a round-trip; updated on connect and `use_database`.
    current_database: Mutex<Option<String>>,
    /// Owns the spawned process so it is killed on disconnect/drop. `None` in
    /// tests that drive the driver over an in-memory transport.
    child: Mutex<Option<Child>>,
}

impl SidecarDriver {
    /// Build a driver over an already-connected client. Used by [`Self::spawn`]
    /// and by unit tests over an in-memory transport.
    pub(crate) fn from_client(
        client: SidecarClient,
        driver_name: String,
        initial_database: Option<String>,
        child: Option<Child>,
    ) -> Self {
        Self {
            client,
            driver_name,
            current_database: Mutex::new(initial_database),
            child: Mutex::new(child),
        }
    }

    /// Spawn the verified sidecar executable, negotiate the protocol version,
    /// and open the underlying connection inside the sidecar.
    pub async fn spawn(program: &Path, args: &[String], config: &ConnectionConfig) -> Result<Self> {
        let mut child = Command::new(program)
            .args(args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| anyhow!("failed to spawn sidecar {}: {e}", program.display()))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("sidecar stdin was not piped"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("sidecar stdout was not piped"))?;
        let client = SidecarClient::new(stdout, stdin, DEFAULT_CALL_TIMEOUT);

        // Handshake first so a version mismatch fails fast and clearly.
        let driver_name = match client
            .call(SidecarCall::Handshake {
                protocol_version: SIDECAR_PROTOCOL_VERSION.to_string(),
            })
            .await?
        {
            SidecarResponsePayload::Handshake {
                protocol_version,
                driver_name,
            } => {
                if protocol_version != SIDECAR_PROTOCOL_VERSION {
                    return Err(anyhow!(
                        "sidecar speaks protocol {protocol_version}, host expects {SIDECAR_PROTOCOL_VERSION}"
                    ));
                }
                driver_name
            }
            other => return Err(anyhow!("unexpected handshake reply: {other:?}")),
        };

        client
            .call(SidecarCall::Connect {
                config: Box::new(config.clone()),
            })
            .await?;

        // Seed the cached current database from the sidecar (best effort).
        let initial_database = match client.call(SidecarCall::CurrentDatabase).await {
            Ok(SidecarResponsePayload::CurrentDatabase(db)) => db,
            _ => None,
        };

        Ok(Self::from_client(
            client,
            driver_name,
            initial_database,
            Some(child),
        ))
    }
}

fn unexpected(payload: SidecarResponsePayload) -> anyhow::Error {
    anyhow!("unexpected sidecar payload: {payload:?}")
}

fn expect_unit(payload: SidecarResponsePayload) -> Result<()> {
    match payload {
        SidecarResponsePayload::Unit => Ok(()),
        other => Err(unexpected(other)),
    }
}

fn expect_query(payload: SidecarResponsePayload) -> Result<QueryResult> {
    match payload {
        SidecarResponsePayload::Query(q) => Ok(q),
        other => Err(unexpected(other)),
    }
}

fn expect_queries(payload: SidecarResponsePayload) -> Result<Vec<QueryResult>> {
    match payload {
        SidecarResponsePayload::Queries(q) => Ok(q),
        other => Err(unexpected(other)),
    }
}

fn expect_count(payload: SidecarResponsePayload) -> Result<i64> {
    match payload {
        SidecarResponsePayload::Count(n) => Ok(n),
        other => Err(unexpected(other)),
    }
}

fn expect_affected(payload: SidecarResponsePayload) -> Result<u64> {
    match payload {
        SidecarResponsePayload::Affected(n) => Ok(n),
        other => Err(unexpected(other)),
    }
}

fn expect_bool(payload: SidecarResponsePayload) -> Result<bool> {
    match payload {
        SidecarResponsePayload::Cancelled(b) => Ok(b),
        other => Err(unexpected(other)),
    }
}

fn expect_databases(payload: SidecarResponsePayload) -> Result<Vec<DatabaseInfo>> {
    match payload {
        SidecarResponsePayload::Databases(v) => Ok(v),
        other => Err(unexpected(other)),
    }
}

fn expect_tables(payload: SidecarResponsePayload) -> Result<Vec<TableInfo>> {
    match payload {
        SidecarResponsePayload::Tables(v) => Ok(v),
        other => Err(unexpected(other)),
    }
}

fn expect_schema_objects(payload: SidecarResponsePayload) -> Result<Vec<SchemaObjectInfo>> {
    match payload {
        SidecarResponsePayload::SchemaObjects(v) => Ok(v),
        other => Err(unexpected(other)),
    }
}

fn expect_columns(payload: SidecarResponsePayload) -> Result<Vec<ColumnDetail>> {
    match payload {
        SidecarResponsePayload::Columns(v) => Ok(v),
        other => Err(unexpected(other)),
    }
}

fn expect_structure(payload: SidecarResponsePayload) -> Result<TableStructure> {
    match payload {
        SidecarResponsePayload::TableStructure(s) => Ok(s),
        other => Err(unexpected(other)),
    }
}

fn expect_lookup_values(payload: SidecarResponsePayload) -> Result<Vec<LookupValue>> {
    match payload {
        SidecarResponsePayload::LookupValues(v) => Ok(v),
        other => Err(unexpected(other)),
    }
}

#[async_trait]
impl DatabaseDriver for SidecarDriver {
    async fn ping(&self) -> Result<()> {
        expect_unit(self.client.call(SidecarCall::Ping).await?)
    }

    async fn disconnect(&self) -> Result<()> {
        // Best-effort remote disconnect, then stop the process.
        let _ = self.client.call(SidecarCall::Disconnect).await;
        self.client.shutdown().await;
        let child = self.child.lock().unwrap().take();
        if let Some(mut child) = child {
            let _ = child.start_kill();
        }
        Ok(())
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        expect_databases(self.client.call(SidecarCall::ListDatabases).await?)
    }

    async fn list_tables(&self, database: Option<&str>) -> Result<Vec<TableInfo>> {
        expect_tables(
            self.client
                .call(SidecarCall::ListTables {
                    database: database.map(str::to_string),
                })
                .await?,
        )
    }

    async fn list_schema_objects(&self, database: Option<&str>) -> Result<Vec<SchemaObjectInfo>> {
        expect_schema_objects(
            self.client
                .call(SidecarCall::ListSchemaObjects {
                    database: database.map(str::to_string),
                })
                .await?,
        )
    }

    async fn get_table_structure(
        &self,
        table: &str,
        database: Option<&str>,
    ) -> Result<TableStructure> {
        expect_structure(
            self.client
                .call(SidecarCall::GetTableStructure {
                    table: table.to_string(),
                    database: database.map(str::to_string),
                })
                .await?,
        )
    }

    async fn get_table_columns_preview(
        &self,
        table: &str,
        database: Option<&str>,
    ) -> Result<Vec<ColumnDetail>> {
        expect_columns(
            self.client
                .call(SidecarCall::GetTableColumnsPreview {
                    table: table.to_string(),
                    database: database.map(str::to_string),
                })
                .await?,
        )
    }

    async fn execute_query(&self, sql: &str) -> Result<QueryResult> {
        expect_query(
            self.client
                .call(SidecarCall::ExecuteQuery {
                    sql: sql.to_string(),
                })
                .await?,
        )
    }

    async fn execute_query_for_request(&self, request_id: &str, sql: &str) -> Result<QueryResult> {
        expect_query(
            self.client
                .call(SidecarCall::ExecuteQueryForRequest {
                    request_id: request_id.to_string(),
                    sql: sql.to_string(),
                })
                .await?,
        )
    }

    async fn cancel_query_request(&self, request_id: &str) -> Result<bool> {
        expect_bool(
            self.client
                .call(SidecarCall::CancelQueryRequest {
                    request_id: request_id.to_string(),
                })
                .await?,
        )
    }

    async fn execute_parameterized_query(
        &self,
        sql: &str,
        parameters: &[QueryParameter],
    ) -> Result<QueryResult> {
        expect_query(
            self.client
                .call(SidecarCall::ExecuteParameterizedQuery {
                    sql: sql.to_string(),
                    parameters: parameters.to_vec(),
                })
                .await?,
        )
    }

    async fn execute_parameterized_query_for_request(
        &self,
        request_id: &str,
        sql: &str,
        parameters: &[QueryParameter],
    ) -> Result<QueryResult> {
        expect_query(
            self.client
                .call(SidecarCall::ExecuteParameterizedQueryForRequest {
                    request_id: request_id.to_string(),
                    sql: sql.to_string(),
                    parameters: parameters.to_vec(),
                })
                .await?,
        )
    }

    #[allow(clippy::too_many_arguments)]
    async fn get_table_data(
        &self,
        table: &str,
        database: Option<&str>,
        offset: u64,
        limit: u64,
        order_by: Option<&str>,
        order_dir: Option<&str>,
        filter: Option<&str>,
    ) -> Result<QueryResult> {
        expect_query(
            self.client
                .call(SidecarCall::GetTableData {
                    table: table.to_string(),
                    database: database.map(str::to_string),
                    offset,
                    limit,
                    order_by: order_by.map(str::to_string),
                    order_dir: order_dir.map(str::to_string),
                    filter: filter.map(str::to_string),
                })
                .await?,
        )
    }

    async fn count_rows(&self, table: &str, database: Option<&str>) -> Result<i64> {
        expect_count(
            self.client
                .call(SidecarCall::CountRows {
                    table: table.to_string(),
                    database: database.map(str::to_string),
                })
                .await?,
        )
    }

    async fn count_null_values(
        &self,
        table: &str,
        database: Option<&str>,
        column: &str,
    ) -> Result<i64> {
        expect_count(
            self.client
                .call(SidecarCall::CountNullValues {
                    table: table.to_string(),
                    database: database.map(str::to_string),
                    column: column.to_string(),
                })
                .await?,
        )
    }

    async fn update_table_cell(&self, request: &TableCellUpdateRequest) -> Result<u64> {
        expect_affected(
            self.client
                .call(SidecarCall::UpdateTableCell {
                    request: request.clone(),
                })
                .await?,
        )
    }

    async fn apply_table_updates_atomically(
        &self,
        updates: &[TableCellUpdateRequest],
    ) -> Result<u64> {
        expect_affected(
            self.client
                .call(SidecarCall::ApplyTableUpdatesAtomically {
                    updates: updates.to_vec(),
                })
                .await?,
        )
    }

    async fn delete_table_rows(&self, request: &TableRowDeleteRequest) -> Result<u64> {
        expect_affected(
            self.client
                .call(SidecarCall::DeleteTableRows {
                    request: request.clone(),
                })
                .await?,
        )
    }

    async fn insert_table_row(&self, request: &TableRowInsertRequest) -> Result<u64> {
        expect_affected(
            self.client
                .call(SidecarCall::InsertTableRow {
                    request: request.clone(),
                })
                .await?,
        )
    }

    async fn insert_table_rows_atomically(
        &self,
        requests: &[TableRowInsertRequest],
        cancelled: Arc<AtomicBool>,
    ) -> Result<u64> {
        expect_affected(
            self.client
                .call_cancellable(
                    SidecarCall::InsertTableRowsAtomically {
                        requests: requests.to_vec(),
                    },
                    cancelled,
                )
                .await?,
        )
    }

    async fn insert_table_row_stream_atomically(
        &self,
        rows: mpsc::Receiver<CsvImportRow>,
        cancelled: Arc<AtomicBool>,
    ) -> Result<u64> {
        expect_affected(self.client.stream_import(rows, cancelled).await?)
    }

    async fn execute_structure_statements(&self, statements: &[String]) -> Result<u64> {
        expect_affected(
            self.client
                .call(SidecarCall::ExecuteStructureStatements {
                    statements: statements.to_vec(),
                })
                .await?,
        )
    }

    async fn preview_write_transaction(&self, statements: &[String]) -> Result<Vec<QueryResult>> {
        expect_queries(
            self.client
                .call(SidecarCall::PreviewWriteTransaction {
                    statements: statements.to_vec(),
                })
                .await?,
        )
    }

    async fn execute_restore_statements(&self, statements: &[String]) -> Result<u64> {
        expect_affected(
            self.client
                .call(SidecarCall::ExecuteRestoreStatements {
                    statements: statements.to_vec(),
                })
                .await?,
        )
    }

    async fn use_database(&self, database: &str) -> Result<()> {
        expect_unit(
            self.client
                .call(SidecarCall::UseDatabase {
                    database: database.to_string(),
                })
                .await?,
        )?;
        *self.current_database.lock().unwrap() = Some(database.to_string());
        Ok(())
    }

    async fn get_foreign_key_lookup_values(
        &self,
        referenced_table: &str,
        referenced_column: &str,
        display_columns: &[&str],
        search: Option<&str>,
        limit: u32,
    ) -> Result<Vec<LookupValue>> {
        expect_lookup_values(
            self.client
                .call(SidecarCall::GetForeignKeyLookupValues {
                    referenced_table: referenced_table.to_string(),
                    referenced_column: referenced_column.to_string(),
                    display_columns: display_columns.iter().map(|s| s.to_string()).collect(),
                    search: search.map(str::to_string),
                    limit,
                })
                .await?,
        )
    }

    fn current_database(&self) -> Option<String> {
        self.current_database.lock().unwrap().clone()
    }

    fn driver_name(&self) -> &str {
        self.driver_name.as_str()
    }
}

#[cfg(test)]
mod tests {
    use super::SidecarDriver;
    use crate::database::driver::DatabaseDriver;
    use crate::database::sidecar::client::SidecarClient;
    use crate::database::sidecar::protocol::{
        HostFrame, SidecarCall, SidecarFrame, SidecarOutcome, SidecarRequest, SidecarResponse,
        SidecarResponsePayload,
    };
    use crate::database::sidecar::{decode_frame, encode_frame};
    use std::time::Duration;
    use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};

    /// A trivial sidecar: `count_rows` returns 5, everything else returns Unit.
    async fn fake<R, W>(reader: R, mut writer: W)
    where
        R: AsyncRead + Unpin,
        W: AsyncWrite + Unpin,
    {
        let mut reader = BufReader::new(reader);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let trimmed = line.trim_end_matches(['\r', '\n']);
                    if trimmed.is_empty() {
                        continue;
                    }
                    let frame: HostFrame = decode_frame(trimmed).unwrap();
                    if let HostFrame::Request(SidecarRequest { id, call }) = frame {
                        let payload = match call {
                            SidecarCall::CountRows { .. } => SidecarResponsePayload::Count(5),
                            _ => SidecarResponsePayload::Unit,
                        };
                        let reply = SidecarFrame::Response(SidecarResponse {
                            id,
                            outcome: SidecarOutcome::Ok(payload),
                        });
                        let ln = encode_frame(&reply).unwrap();
                        writer.write_all(ln.as_bytes()).await.unwrap();
                        writer.write_all(b"\n").await.unwrap();
                        writer.flush().await.unwrap();
                    }
                }
            }
        }
    }

    fn driver_over_fake() -> SidecarDriver {
        let (client_io, sidecar_io) = tokio::io::duplex(16 * 1024);
        let (cr, cw) = tokio::io::split(client_io);
        let (sr, sw) = tokio::io::split(sidecar_io);
        tokio::spawn(fake(sr, sw));
        let client = SidecarClient::new(cr, cw, Duration::from_secs(5));
        SidecarDriver::from_client(client, "duck-fake".to_string(), None, None)
    }

    #[tokio::test]
    async fn forwards_unary_calls_and_maps_payloads() {
        let driver = driver_over_fake();
        driver.ping().await.unwrap();
        assert_eq!(driver.count_rows("t", None).await.unwrap(), 5);
        assert_eq!(driver.driver_name(), "duck-fake");
    }

    #[tokio::test]
    async fn use_database_updates_the_cached_current_database() {
        let driver = driver_over_fake();
        assert_eq!(driver.current_database(), None);
        driver.use_database("shop").await.unwrap();
        assert_eq!(driver.current_database(), Some("shop".to_string()));
    }
}
