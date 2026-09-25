use super::models::*;
use anyhow::Result;
use async_trait::async_trait;
use futures_util::{stream, Stream, StreamExt};
use std::pin::Pin;
use std::sync::{atomic::AtomicBool, Arc};

/// Core database driver trait.
/// All database operations go through this trait.
#[async_trait]
#[allow(dead_code)]
pub trait DatabaseDriver: Send + Sync {
    /// Test connectivity
    async fn ping(&self) -> Result<()>;

    /// Close the connection
    async fn disconnect(&self) -> Result<()>;

    /// List all databases
    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>>;

    /// List tables in the current/specified database
    async fn list_tables(&self, database: Option<&str>) -> Result<Vec<TableInfo>>;

    /// List schema-level objects such as views, triggers, and routines.
    async fn list_schema_objects(&self, database: Option<&str>) -> Result<Vec<SchemaObjectInfo>>;

    /// Get table structure (columns, indexes, foreign keys)
    async fn get_table_structure(
        &self,
        table: &str,
        database: Option<&str>,
    ) -> Result<TableStructure>;

    /// Get lightweight column metadata without loading the full structure payload.
    async fn get_table_columns_preview(
        &self,
        table: &str,
        database: Option<&str>,
    ) -> Result<Vec<ColumnDetail>> {
        Ok(self.get_table_structure(table, database).await?.columns)
    }

    /// Execute a raw SQL query and return results
    async fn execute_query(&self, sql: &str) -> Result<QueryResult>;

    /// Run a query under a request scope so `cancel_query` can reach the server.
    /// Default: ignore the scope (drivers without server-side cancel).
    async fn execute_query_for_request(&self, request_id: &str, sql: &str) -> Result<QueryResult> {
        let _ = request_id;
        self.execute_query(sql).await
    }

    /// Attempt to abort the in-flight server-side query for this request.
    /// Returns `Ok(false)` when the driver cannot cancel server-side.
    async fn cancel_query_request(&self, request_id: &str) -> Result<bool> {
        let _ = request_id;
        Ok(false)
    }

    /// Execute one SQL statement using already compiled bind markers. Values are
    /// supplied separately so callers never interpolate data into SQL text.
    async fn execute_parameterized_query(
        &self,
        _sql: &str,
        _parameters: &[QueryParameter],
    ) -> Result<QueryResult> {
        Err(anyhow::anyhow!(
            "Prepared SQL parameters are not supported by this database driver yet"
        ))
    }

    async fn execute_parameterized_query_for_request(
        &self,
        request_id: &str,
        sql: &str,
        parameters: &[QueryParameter],
    ) -> Result<QueryResult> {
        let _ = request_id;
        self.execute_parameterized_query(sql, parameters).await
    }

    /// Sample the currently-running operations for the live profiler, returning
    /// rows aliased to the canonical profiler column contract. SQL engines are
    /// sampled from the frontend via `execute_query`, so only non-SQL drivers
    /// (e.g. MongoDB's `$currentOp`) override this.
    async fn profiler_live_sample(&self) -> Result<QueryResult> {
        Err(anyhow::anyhow!(
            "Live profiling is not supported by this database driver"
        ))
    }

    /// Rank the most expensive operations from the engine's own statement store
    /// for the Top Queries tab, aliased to the canonical top-queries columns.
    /// Only non-SQL drivers (e.g. MongoDB's `system.profile`) override this.
    async fn profiler_top_sample(&self) -> Result<QueryResult> {
        Err(anyhow::anyhow!(
            "Top-queries profiling is not supported by this database driver"
        ))
    }

    /// Get rows from a table with pagination
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
    ) -> Result<QueryResult>;

    /// Stream every row of a table for export, in bounded batches.
    ///
    /// Unlike [`Self::get_table_data`], which is capped for interactive
    /// browsing, this must keep paginating until the table is exhausted.
    /// The default implementation walks `get_table_data` with offset paging;
    /// drivers whose browse path caps or rejects large offsets (Cassandra,
    /// MongoDB, ClickHouse, OpenSearch) override it with native paging.
    /// `batch_size` is a hint; implementations may emit smaller batches.
    fn export_table_rows<'a>(
        &'a self,
        table: &'a str,
        database: Option<&'a str>,
        batch_size: u64,
        order_by: Option<&'a str>,
        order_dir: Option<&'a str>,
        filter: Option<&'a str>,
    ) -> Pin<Box<dyn Stream<Item = Result<QueryResult>> + Send + 'a>> {
        let batch_size = batch_size.max(1);
        stream::try_unfold((0_u64, false), move |(offset, prev_truncated)| async move {
            let batch = self
                .get_table_data(
                    table, database, offset, batch_size, order_by, order_dir, filter,
                )
                .await?;
            let fetched = batch.rows.len() as u64;
            if fetched == 0 {
                if prev_truncated {
                    // The previous page was capped below the requested batch
                    // size, so the export would silently drop rows.
                    log::warn!(
                        "Table export of '{table}' may be incomplete: the driver truncated a page"
                    );
                }
                return Ok(None);
            }
            let last_page = fetched < batch_size;
            let truncated = batch.truncated;
            if last_page && truncated {
                log::warn!(
                    "Table export of '{table}' may be incomplete: the driver truncated a page"
                );
            }
            Ok(Some((batch, (offset + fetched, truncated))))
        })
        .boxed()
    }

    /// Count rows in a table
    async fn count_rows(&self, table: &str, database: Option<&str>) -> Result<i64>;

    /// Count how many NULL values a specific column currently contains.
    async fn count_null_values(
        &self,
        table: &str,
        database: Option<&str>,
        column: &str,
    ) -> Result<i64>;

    /// Update a single cell in a table using a primary-key based row selector.
    async fn update_table_cell(&self, request: &TableCellUpdateRequest) -> Result<u64>;

    /// Apply a batch of primary-key based cell updates atomically. Drivers that
    /// cannot guarantee a single transaction must reject this operation rather
    /// than leave the edit queue partially committed.
    async fn apply_table_updates_atomically(
        &self,
        _updates: &[TableCellUpdateRequest],
    ) -> Result<u64> {
        Err(anyhow::anyhow!(
            "Atomic edit queues are not supported by this database driver yet"
        ))
    }

    /// Delete one or more rows in a table using primary-key based row selectors.
    async fn delete_table_rows(&self, request: &TableRowDeleteRequest) -> Result<u64>;

    /// Insert a single new row into a table.
    async fn insert_table_row(&self, request: &TableRowInsertRequest) -> Result<u64>;

    /// Insert many rows in one transaction. Drivers that do not have a
    /// transaction primitive must reject this instead of partially importing a
    /// CSV file.
    async fn insert_table_rows_atomically(
        &self,
        _requests: &[TableRowInsertRequest],
        _cancelled: Arc<AtomicBool>,
    ) -> Result<u64> {
        Err(anyhow::anyhow!(
            "Atomic CSV imports are not supported by this database driver yet"
        ))
    }
    /// Select the rows matching each primary-key selector — the pre-image a
    /// rewind checkpoint stores before a write. Returns one `QueryResult` per
    /// selector (same order). Default: unsupported; the grid then writes
    /// without offering rewind for that engine.
    async fn select_rows_by_keys(
        &self,
        _table: &str,
        _database: Option<&str>,
        _selectors: &[Vec<crate::database::models::RowKeyValue>],
    ) -> Result<Vec<QueryResult>> {
        Err(anyhow::anyhow!(
            "Row pre-image capture is not supported by this database driver yet"
        ))
    }

    /// Consume a bounded row stream inside one transaction. Implementations
    /// must roll back the transaction when parsing fails, cancellation is
    /// requested, or the channel closes before a successful end-of-stream.
    async fn insert_table_row_stream_atomically(
        &self,
        _rows: tokio::sync::mpsc::Receiver<crate::database::models::CsvImportRow>,
        _cancelled: Arc<AtomicBool>,
    ) -> Result<u64> {
        Err(anyhow::anyhow!(
            "Streaming CSV imports are not supported by this database driver yet"
        ))
    }

    /// Execute reviewed schema-change statements in the backend, sequentially.
    async fn execute_structure_statements(&self, statements: &[String]) -> Result<u64> {
        let mut total_affected = 0;
        for statement in statements {
            total_affected += self.execute_query(statement).await?.affected_rows;
        }
        Ok(total_affected)
    }

    /// Executes mutating statements inside one transaction and ALWAYS rolls
    /// back, returning the affected/returned rows as a preview. Engines that
    /// cannot guarantee full rollback reject this operation.
    async fn preview_write_transaction(&self, _statements: &[String]) -> Result<Vec<QueryResult>> {
        Err(anyhow::anyhow!(
            "Write preview transactions are not supported by this database driver yet"
        ))
    }

    /// Restore a reviewed SQL dump. Transaction-capable drivers override this
    /// so every statement is pinned to the same database transaction.
    async fn execute_restore_statements(&self, statements: &[String]) -> Result<u64> {
        self.execute_structure_statements(statements).await
    }

    /// Switch to a different database
    async fn use_database(&self, database: &str) -> Result<()>;

    /// Get lookup values for a FK reference: SELECT pk, display FROM table LIMIT n
    async fn get_foreign_key_lookup_values(
        &self,
        referenced_table: &str,
        referenced_column: &str,
        display_columns: &[&str],
        search: Option<&str>,
        limit: u32,
    ) -> Result<Vec<LookupValue>>;

    /// Get the current database name
    fn current_database(&self) -> Option<String>;

    /// Get the driver/database type name
    fn driver_name(&self) -> &str;

    /// Downcast hook for engine-specific APIs that cannot be expressed through
    /// the generic trait surface (e.g. OpenSearch's security REST endpoints).
    /// Drivers that expose such APIs override this; everything else stays `None`.
    fn as_any(&self) -> Option<&dyn std::any::Any> {
        None
    }
}
