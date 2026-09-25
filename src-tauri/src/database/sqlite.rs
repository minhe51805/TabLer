use super::driver::DatabaseDriver;
use super::models::*;
use super::query_cancel::{request_cancel, CancelLookup, CancelScopeGuard, QueryCancelRegistry};
use super::query_common::MAX_TABLE_PAGE_ROWS;
use super::safety::{
    normalize_order_dir, quote_sqlite_identifier, quote_sqlite_order_by,
    sanitize_sqlite_filter_clause,
};
use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqliteRow, SqliteSynchronous,
};
use sqlx::{ConnectOptions, QueryBuilder, Row, Sqlite};
use std::fs;
use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, RwLock,
};
use std::time::Instant;

/// Virtual-machine instructions between SQLite progress-handler callbacks
/// while a cancellable request runs — small enough that cancel lands quickly,
/// large enough to stay off the hot path.
const SQLITE_PROGRESS_CHECK_OPS: i32 = 1_000;

pub struct SqliteDriver {
    pub(super) pool: SqlitePool,
    file_path: String,
    /// request_id → running-statement scope; cancel flips a shared flag the
    /// connection's progress handler polls, which interrupts the statement.
    cancel_registry: RwLock<QueryCancelRegistry>,
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn atomic_update_queue_rolls_back_when_a_later_selector_does_not_match() {
        let driver = SqliteDriver::connect("sqlite::memory:?cache=shared")
            .await
            .unwrap();
        driver
            .execute_query("CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT)")
            .await
            .unwrap();
        driver
            .execute_query("INSERT INTO items (id, value) VALUES (1, 'before')")
            .await
            .unwrap();
        let updates = vec![
            TableCellUpdateRequest {
                table: "items".into(),
                database: None,
                target_column: "value".into(),
                value: serde_json::Value::String("after".into()),
                primary_keys: vec![RowKeyValue {
                    column: "id".into(),
                    value: serde_json::Value::from(1),
                }],
            },
            TableCellUpdateRequest {
                table: "items".into(),
                database: None,
                target_column: "value".into(),
                value: serde_json::Value::String("should-not-commit".into()),
                primary_keys: vec![RowKeyValue {
                    column: "id".into(),
                    value: serde_json::Value::from(999),
                }],
            },
        ];
        assert!(driver
            .apply_table_updates_atomically(&updates)
            .await
            .is_err());
        let result = driver
            .execute_query("SELECT value FROM items WHERE id = 1")
            .await
            .unwrap();
        assert_eq!(
            result.rows[0][0],
            serde_json::Value::String("before".into())
        );
    }

    #[tokio::test]
    async fn atomic_csv_import_rolls_back_when_a_later_row_violates_a_constraint() {
        let driver = SqliteDriver::connect("sqlite::memory:?cache=shared")
            .await
            .unwrap();
        driver
            .execute_query("CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT)")
            .await
            .unwrap();
        let rows = vec![
            TableRowInsertRequest {
                table: "items".into(),
                database: None,
                values: vec![
                    ("id".into(), serde_json::json!(1)),
                    ("value".into(), serde_json::json!("first")),
                ],
            },
            TableRowInsertRequest {
                table: "items".into(),
                database: None,
                values: vec![
                    ("id".into(), serde_json::json!(1)),
                    ("value".into(), serde_json::json!("duplicate")),
                ],
            },
        ];

        assert!(driver
            .insert_table_rows_atomically(&rows, Arc::new(AtomicBool::new(false)))
            .await
            .is_err());
        let result = driver.execute_query("SELECT * FROM items").await.unwrap();
        assert!(result.rows.is_empty());
    }

    #[tokio::test]
    async fn cancelled_csv_import_does_not_write_any_rows() {
        let driver = SqliteDriver::connect("sqlite::memory:?cache=shared")
            .await
            .unwrap();
        driver
            .execute_query("CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT)")
            .await
            .unwrap();
        let rows = vec![TableRowInsertRequest {
            table: "items".into(),
            database: None,
            values: vec![
                ("id".into(), serde_json::json!(1)),
                ("value".into(), serde_json::json!("first")),
            ],
        }];

        assert!(driver
            .insert_table_rows_atomically(&rows, Arc::new(AtomicBool::new(true)))
            .await
            .is_err());
        let result = driver.execute_query("SELECT * FROM items").await.unwrap();
        assert!(result.rows.is_empty());
    }

    #[tokio::test]
    async fn streaming_csv_import_rolls_back_after_parser_error() {
        let driver = SqliteDriver::connect("sqlite::memory:?cache=shared")
            .await
            .unwrap();
        driver
            .execute_query("CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT)")
            .await
            .unwrap();
        let (sender, receiver) = tokio::sync::mpsc::channel(2);
        sender
            .send(Ok(TableRowInsertRequest {
                table: "items".into(),
                database: None,
                values: vec![
                    ("id".into(), serde_json::json!(1)),
                    ("value".into(), serde_json::json!("first")),
                ],
            }))
            .await
            .unwrap();
        sender.send(Err("row 2 is invalid".into())).await.unwrap();
        drop(sender);

        assert!(driver
            .insert_table_row_stream_atomically(receiver, Arc::new(AtomicBool::new(false)),)
            .await
            .is_err());
        let result = driver.execute_query("SELECT * FROM items").await.unwrap();
        assert!(result.rows.is_empty());
    }

    fn temp_db_path(tag: &str) -> String {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir()
            .join(format!(
                "tabler-sqlite-structure-{tag}-{}-{unique}.db",
                std::process::id()
            ))
            .to_string_lossy()
            .into_owned()
    }

    fn cleanup_db_file(path: &str) {
        for suffix in ["", "-wal", "-shm"] {
            let _ = fs::remove_file(format!("{path}{suffix}"));
        }
    }

    #[tokio::test]
    async fn structure_statements_apply_sqlite_ddl_verbs() {
        let path = temp_db_path("ddl");
        let driver = SqliteDriver::connect(&path).await.unwrap();

        // The default DatabaseDriver::execute_structure_statements runs each
        // statement through execute_query; SQLite DDL verbs are not classified
        // as row-returning, so they execute directly against the pool.
        driver
            .execute_structure_statements(&[
                "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)".into(),
                "ALTER TABLE items ADD COLUMN qty INTEGER DEFAULT 0".into(),
                "ALTER TABLE items RENAME COLUMN name TO label".into(),
                "CREATE INDEX idx_items_label ON items (label)".into(),
                "CREATE VIEW item_labels AS SELECT label FROM items".into(),
                "DROP VIEW item_labels".into(),
                "DROP INDEX idx_items_label".into(),
                "ALTER TABLE items RENAME TO products".into(),
            ])
            .await
            .unwrap();

        // The table was renamed to `products` and carries the added and
        // renamed columns.
        let columns = driver
            .execute_query("PRAGMA table_info(products)")
            .await
            .unwrap();
        let names: Vec<String> = columns
            .rows
            .iter()
            .map(|row| row[1].as_str().unwrap().to_string())
            .collect();
        assert_eq!(names, vec!["id", "label", "qty"]);

        // Index and view were dropped; only the renamed table remains.
        let objects = driver
            .execute_query(
                "SELECT type, name FROM sqlite_master \
                 WHERE name IN ('items', 'products', 'idx_items_label', 'item_labels') \
                 ORDER BY name",
            )
            .await
            .unwrap();
        assert_eq!(
            objects.rows,
            vec![vec![
                serde_json::Value::String("table".into()),
                serde_json::Value::String("products".into())
            ]]
        );

        driver.pool.close().await;
        cleanup_db_file(&path);
    }

    #[tokio::test]
    async fn structure_statements_surface_mid_batch_failure_without_atomicity() {
        let path = temp_db_path("ddl-fail");
        let driver = SqliteDriver::connect(&path).await.unwrap();

        // SQLite DDL through this path is NOT transactional: statements run
        // sequentially via execute_query with no surrounding transaction, so
        // a mid-batch failure leaves earlier statements applied. The error
        // must still surface to the caller.
        let result = driver
            .execute_structure_statements(&[
                "CREATE TABLE kept (id INTEGER PRIMARY KEY)".into(),
                "ALTER TABLE missing_table ADD COLUMN x INTEGER".into(),
                "CREATE TABLE never_reached (id INTEGER PRIMARY KEY)".into(),
            ])
            .await;
        assert!(result.is_err());

        // The first statement committed; the statement after the failure
        // never ran.
        let objects = driver
            .execute_query(
                "SELECT name FROM sqlite_master \
                 WHERE type = 'table' AND name IN ('kept', 'never_reached')",
            )
            .await
            .unwrap();
        assert_eq!(
            objects.rows,
            vec![vec![serde_json::Value::String("kept".into())]]
        );

        driver.pool.close().await;
        cleanup_db_file(&path);
    }

    #[tokio::test]
    async fn request_cancel_interrupts_a_running_statement() {
        let driver = Arc::new(
            SqliteDriver::connect("sqlite::memory:?cache=shared")
                .await
                .unwrap(),
        );
        // A 200k-row cross join keeps the VM busy long enough for the cancel
        // to land; the progress handler interrupts it mid-execution.
        let running = {
            let driver = driver.clone();
            tokio::spawn(async move {
                driver
                    .execute_query_for_request(
                        "req-cancel",
                        "WITH RECURSIVE seq(n) AS (\
                             SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 200000\
                         ) SELECT COUNT(*) FROM seq a, seq b LIMIT 5",
                    )
                    .await
            })
        };
        // Wait until the request slot exists, then cancel it.
        for _ in 0..100 {
            if driver.cancel_query_request("req-cancel").await.unwrap() {
                break;
            }
            tokio::task::yield_now().await;
        }
        let outcome = running.await.unwrap();
        assert_eq!(
            outcome.unwrap_err().to_string(),
            "Query cancelled.",
            "the progress handler must interrupt the statement"
        );
        // The pooled connection is healthy again after the interrupt.
        let check = driver.execute_query("SELECT 1").await.unwrap();
        assert_eq!(check.rows.len(), 1);
    }
}

impl SqliteDriver {
    pub async fn connect(file_path: &str) -> Result<Self> {
        if file_path != ":memory:" && !file_path.starts_with("sqlite:") {
            let path = Path::new(file_path);
            if let Some(parent) = path.parent() {
                if !parent.as_os_str().is_empty() {
                    fs::create_dir_all(parent)
                        .context("Failed to create SQLite parent directory")?;
                }
            }
        }

        let mut options = if file_path == ":memory:" {
            SqliteConnectOptions::new().in_memory(true)
        } else if file_path.starts_with("sqlite:") {
            file_path
                .parse::<SqliteConnectOptions>()
                .context("Failed to parse SQLite connection options")?
                .create_if_missing(true)
        } else {
            SqliteConnectOptions::new()
                .filename(file_path)
                .create_if_missing(true)
        };

        options = options
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal);
        options = options.disable_statement_logging();

        let pool = SqlitePool::connect_with(options)
            .await
            .context("Failed to connect to SQLite")?;

        Ok(Self {
            pool,
            file_path: file_path.to_string(),
            cancel_registry: RwLock::new(QueryCancelRegistry::new()),
        })
    }
}

#[async_trait]
impl DatabaseDriver for SqliteDriver {
    async fn ping(&self) -> Result<()> {
        sqlx::query("SELECT 1")
            .execute(&self.pool)
            .await
            .context("SQLite ping failed")?;
        Ok(())
    }

    async fn disconnect(&self) -> Result<()> {
        self.pool.close().await;
        Ok(())
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        // SQLite is a single-file database
        Ok(vec![DatabaseInfo {
            name: self.file_path.clone(),
            size: None,
        }])
    }

    async fn list_tables(&self, _database: Option<&str>) -> Result<Vec<TableInfo>> {
        let rows: Vec<SqliteRow> = sqlx::query(
            "SELECT name, type FROM sqlite_master \
             WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' \
             ORDER BY name",
        )
        .fetch_all(&self.pool)
        .await?;

        let tables = rows
            .iter()
            .map(|row| TableInfo {
                create_date: None,
                name: row.get(0),
                table_type: row.get(1),
                schema: None,
                row_count: None,
                engine: Some("SQLite".to_string()),
            })
            .collect();

        Ok(tables)
    }

    async fn list_schema_objects(&self, database: Option<&str>) -> Result<Vec<SchemaObjectInfo>> {
        // Resolves to the inherent method in sqlite_support.rs (inherent wins
        // over the trait method in associated-function resolution).
        SqliteDriver::list_schema_objects(self, database).await
    }

    async fn get_table_structure(
        &self,
        table: &str,
        database: Option<&str>,
    ) -> Result<TableStructure> {
        SqliteDriver::get_table_structure(self, table, database).await
    }

    async fn execute_query(&self, sql: &str) -> Result<QueryResult> {
        let mut conn = self.pool.acquire().await.context("SQLite acquire failed")?;
        Self::execute_query_on_conn(&mut conn, sql).await
    }

    /// Request-scoped execution on a dedicated pooled connection. SQLite has
    /// no killable backend id, so cancel rides a progress handler installed on
    /// this connection that polls the request's shared cancel flag and
    /// interrupts the running statement.
    async fn execute_query_for_request(&self, request_id: &str, sql: &str) -> Result<QueryResult> {
        if request_id.trim().is_empty() {
            return self.execute_query(sql).await;
        }
        let mut conn = self.pool.acquire().await.context("SQLite acquire failed")?;
        let guard = CancelScopeGuard::begin(&self.cancel_registry, request_id);
        let flag = guard
            .cancel_flag()
            .context("SQLite cancel scope missing its flag")?;
        // No backend id exists to register; the marker only resolves the
        // pending-cancel race before the statement starts.
        if guard.register_backend(0) {
            return Err(anyhow!("Query cancelled."));
        }
        {
            let mut handle = conn
                .lock_handle()
                .await
                .context("SQLite lock_handle failed")?;
            let flag = flag.clone();
            handle.set_progress_handler(SQLITE_PROGRESS_CHECK_OPS, move || {
                !flag.load(Ordering::SeqCst)
            });
        }
        let result = Self::execute_query_on_conn(&mut conn, sql).await;
        // Detach the handler so the pooled connection does not keep polling a
        // dead flag on later checkouts.
        if let Ok(mut handle) = conn.lock_handle().await {
            handle.set_progress_handler(0, || true);
        }
        drop(guard);
        match result {
            Err(error) if flag.load(Ordering::SeqCst) => {
                let _ = error;
                Err(anyhow!("Query cancelled."))
            }
            result => result,
        }
    }

    /// Cancel flips the request's shared flag; the progress handler installed
    /// by `execute_query_for_request` interrupts the statement at the next VM
    /// checkpoint. There is no second-connection kill for an embedded engine.
    async fn cancel_query_request(&self, request_id: &str) -> Result<bool> {
        match request_cancel(&self.cancel_registry, request_id) {
            CancelLookup::NotRunning => Ok(false),
            CancelLookup::Pending | CancelLookup::Backend(_) => Ok(true),
        }
    }

    async fn preview_write_transaction(&self, statements: &[String]) -> Result<Vec<QueryResult>> {
        let mut tx = self.pool.begin().await?;
        let mut results = Vec::new();

        // Every statement runs inside one transaction; any failure stops the
        // loop and the unconditional rollback below discards partial work.
        let execution = async {
            for statement in statements {
                let start = Instant::now();
                if Self::query_returns_rows(statement) {
                    let (rows, truncated) = Self::fetch_rows_limited(&mut *tx, statement).await?;
                    let mut result = Self::build_result_from_rows(
                        &rows,
                        0,
                        statement.clone(),
                        0,
                        false,
                        truncated,
                    );
                    result.execution_time_ms = start.elapsed().as_millis();
                    results.push(result);
                } else {
                    let executed = sqlx::query(statement).execute(&mut *tx).await?;
                    results.push(QueryResult {
                        columns: Vec::new(),
                        rows: Vec::new(),
                        affected_rows: executed.rows_affected(),
                        execution_time_ms: start.elapsed().as_millis(),
                        query: statement.clone(),
                        sandboxed: true,
                        truncated: false,
                    });
                }
            }
            Ok::<_, anyhow::Error>(())
        }
        .await;

        let rollback = tx.rollback().await;
        execution?;
        if let Err(error) = rollback {
            // A failed rollback can leave the preview's writes committed —
            // never report a clean rollback that did not happen.
            log::error!("write-preview rollback failed: {error}");
            return Err(anyhow::anyhow!(
                "Write preview rollback failed; the previewed statements may have been committed: {error}"
            ));
        }
        Ok(results)
    }
    async fn execute_parameterized_query(
        &self,
        sql: &str,
        parameters: &[QueryParameter],
    ) -> Result<QueryResult> {
        let mut conn = self.pool.acquire().await.context("SQLite acquire failed")?;
        Self::execute_parameterized_on_conn(&mut conn, sql, parameters).await
    }

    /// Request-scoped parameterized execution: same progress-handler cancel
    /// path as `execute_query_for_request`.
    async fn execute_parameterized_query_for_request(
        &self,
        request_id: &str,
        sql: &str,
        parameters: &[QueryParameter],
    ) -> Result<QueryResult> {
        if request_id.trim().is_empty() {
            return self.execute_parameterized_query(sql, parameters).await;
        }
        let mut conn = self.pool.acquire().await.context("SQLite acquire failed")?;
        let guard = CancelScopeGuard::begin(&self.cancel_registry, request_id);
        let flag = guard
            .cancel_flag()
            .context("SQLite cancel scope missing its flag")?;
        if guard.register_backend(0) {
            return Err(anyhow!("Query cancelled."));
        }
        {
            let mut handle = conn
                .lock_handle()
                .await
                .context("SQLite lock_handle failed")?;
            let flag = flag.clone();
            handle.set_progress_handler(SQLITE_PROGRESS_CHECK_OPS, move || {
                !flag.load(Ordering::SeqCst)
            });
        }
        let result = Self::execute_parameterized_on_conn(&mut conn, sql, parameters).await;
        if let Ok(mut handle) = conn.lock_handle().await {
            handle.set_progress_handler(0, || true);
        }
        drop(guard);
        match result {
            Err(error) if flag.load(Ordering::SeqCst) => {
                let _ = error;
                Err(anyhow!("Query cancelled."))
            }
            result => result,
        }
    }

    async fn get_table_data(
        &self,
        table: &str,
        _database: Option<&str>,
        offset: u64,
        limit: u64,
        order_by: Option<&str>,
        order_dir: Option<&str>,
        filter: Option<&str>,
    ) -> Result<QueryResult> {
        let mut sql = format!("SELECT * FROM {}", quote_sqlite_identifier(table)?);
        if let Some(filter_clause) = sanitize_sqlite_filter_clause(filter)? {
            sql.push_str(&format!(" WHERE {}", filter_clause));
        }
        if let Some(ob) = order_by {
            let dir = normalize_order_dir(order_dir)?;
            sql.push_str(&format!(" ORDER BY {} {}", quote_sqlite_order_by(ob)?, dir));
        }
        let fetch_limit = limit.clamp(1, MAX_TABLE_PAGE_ROWS);
        sql.push_str(&format!(" LIMIT {} OFFSET {}", fetch_limit, offset));

        let start = Instant::now();
        let (rows, truncated) =
            Self::fetch_rows_capped(&self.pool, &sql, fetch_limit as usize).await?;
        let mut result = Self::build_result_from_rows(
            &rows,
            start.elapsed().as_millis(),
            sql,
            0,
            false,
            truncated || limit > fetch_limit,
        );
        result.execution_time_ms = start.elapsed().as_millis();
        Ok(result)
    }

    async fn count_rows(&self, table: &str, _database: Option<&str>) -> Result<i64> {
        let sql = format!("SELECT COUNT(*) FROM {}", quote_sqlite_identifier(table)?);
        let row: SqliteRow = sqlx::query(&sql).fetch_one(&self.pool).await?;
        let count: i64 = row.get(0);
        Ok(count)
    }

    async fn count_null_values(
        &self,
        table: &str,
        _database: Option<&str>,
        column: &str,
    ) -> Result<i64> {
        let sql = format!(
            "SELECT COUNT(*) FROM {} WHERE {} IS NULL",
            quote_sqlite_identifier(table)?,
            quote_sqlite_order_by(column)?,
        );
        let row: SqliteRow = sqlx::query(&sql).fetch_one(&self.pool).await?;
        Ok(row.get(0))
    }

    async fn update_table_cell(&self, request: &TableCellUpdateRequest) -> Result<u64> {
        if request.primary_keys.is_empty() {
            return Err(anyhow::anyhow!(
                "Inline update requires at least one primary key column"
            ));
        }

        let mut builder = QueryBuilder::<Sqlite>::new("UPDATE ");
        builder.push(quote_sqlite_identifier(&request.table)?);
        builder.push(" SET ");
        builder.push(quote_sqlite_order_by(&request.target_column)?);
        builder.push(" = ");
        Self::push_bound_value(&mut builder, &request.value)?;
        builder.push(" WHERE ");

        for (index, primary_key) in request.primary_keys.iter().enumerate() {
            if index > 0 {
                builder.push(" AND ");
            }

            builder.push(quote_sqlite_order_by(&primary_key.column)?);
            if primary_key.value.is_null() {
                builder.push(" IS NULL");
            } else {
                builder.push(" = ");
                Self::push_bound_value(&mut builder, &primary_key.value)?;
            }
        }

        let result = builder.build().execute(&self.pool).await?;
        Ok(result.rows_affected())
    }

    async fn execute_restore_statements(&self, statements: &[String]) -> Result<u64> {
        let mut transaction = self.pool.begin().await?;
        let mut total_affected = 0;
        for statement in statements {
            total_affected += sqlx::query(statement)
                .execute(&mut *transaction)
                .await?
                .rows_affected();
        }
        transaction.commit().await?;
        Ok(total_affected)
    }

    async fn apply_table_updates_atomically(
        &self,
        updates: &[TableCellUpdateRequest],
    ) -> Result<u64> {
        let mut transaction = self.pool.begin().await?;
        let mut affected_rows = 0;
        for request in updates {
            if request.primary_keys.is_empty() {
                return Err(anyhow::anyhow!(
                    "Inline update requires at least one primary key column"
                ));
            }
            let mut builder = QueryBuilder::<Sqlite>::new("UPDATE ");
            builder.push(quote_sqlite_identifier(&request.table)?);
            builder.push(" SET ");
            builder.push(quote_sqlite_order_by(&request.target_column)?);
            builder.push(" = ");
            Self::push_bound_value(&mut builder, &request.value)?;
            builder.push(" WHERE ");
            for (index, primary_key) in request.primary_keys.iter().enumerate() {
                if index > 0 {
                    builder.push(" AND ");
                }
                builder.push(quote_sqlite_order_by(&primary_key.column)?);
                if primary_key.value.is_null() {
                    builder.push(" IS NULL");
                } else {
                    builder.push(" = ");
                    Self::push_bound_value(&mut builder, &primary_key.value)?;
                }
            }
            let result = builder.build().execute(&mut *transaction).await?;
            if result.rows_affected() == 0 {
                return Err(anyhow::anyhow!(
                    "An edit queue row no longer matches its primary-key selector"
                ));
            }
            affected_rows += result.rows_affected();
        }
        transaction.commit().await?;
        Ok(affected_rows)
    }

    async fn delete_table_rows(&self, request: &TableRowDeleteRequest) -> Result<u64> {
        if request.rows.is_empty() {
            return Err(anyhow::anyhow!(
                "Deleting rows requires at least one selected row"
            ));
        }

        let mut tx = self.pool.begin().await?;
        let mut total_affected = 0u64;

        for row_keys in &request.rows {
            if row_keys.is_empty() {
                return Err(anyhow::anyhow!(
                    "Each deleted row must include at least one primary key value"
                ));
            }

            let mut builder = QueryBuilder::<Sqlite>::new("DELETE FROM ");
            builder.push(quote_sqlite_identifier(&request.table)?);
            builder.push(" WHERE ");

            for (index, primary_key) in row_keys.iter().enumerate() {
                if index > 0 {
                    builder.push(" AND ");
                }

                builder.push(quote_sqlite_order_by(&primary_key.column)?);
                if primary_key.value.is_null() {
                    builder.push(" IS NULL");
                } else {
                    builder.push(" = ");
                    Self::push_bound_value(&mut builder, &primary_key.value)?;
                }
            }

            let result = builder.build().execute(&mut *tx).await?;
            total_affected += result.rows_affected();
        }

        tx.commit().await?;
        Ok(total_affected)
    }

    async fn use_database(&self, _database: &str) -> Result<()> {
        // SQLite doesn't have multiple databases in the traditional sense
        Ok(())
    }

    fn current_database(&self) -> Option<String> {
        Some(self.file_path.clone())
    }

    async fn insert_table_row(&self, request: &TableRowInsertRequest) -> Result<u64> {
        if request.values.is_empty() {
            return Err(anyhow::anyhow!("Insert requires at least one column value"));
        }

        let mut builder = QueryBuilder::<Sqlite>::new("INSERT INTO ");
        builder.push(quote_sqlite_identifier(&request.table)?);
        builder.push(" (");

        let mut first = true;
        for (col, _) in &request.values {
            if !first {
                builder.push(", ");
            }
            first = false;
            builder.push(quote_sqlite_identifier(col)?);
        }

        builder.push(") VALUES (");

        first = true;
        for (_, value) in &request.values {
            if !first {
                builder.push(", ");
            }
            first = false;
            Self::push_bound_value(&mut builder, value)?;
        }

        builder.push(")");

        let result = builder.build().execute(&self.pool).await?;
        Ok(result.rows_affected())
    }

    async fn insert_table_rows_atomically(
        &self,
        requests: &[TableRowInsertRequest],
        cancelled: Arc<AtomicBool>,
    ) -> Result<u64> {
        if requests.is_empty() {
            return Err(anyhow::anyhow!("CSV import requires at least one row"));
        }

        let mut transaction = self.pool.begin().await?;
        let mut affected_rows = 0;
        for request in requests {
            if cancelled.load(Ordering::Relaxed) {
                return Err(anyhow::anyhow!(
                    "CSV import cancelled; all rows were rolled back"
                ));
            }
            if request.values.is_empty() {
                return Err(anyhow::anyhow!(
                    "Each CSV row requires at least one column value"
                ));
            }

            let mut builder = QueryBuilder::<Sqlite>::new("INSERT INTO ");
            builder.push(quote_sqlite_identifier(&request.table)?);
            builder.push(" (");
            for (index, (column, _)) in request.values.iter().enumerate() {
                if index > 0 {
                    builder.push(", ");
                }
                builder.push(quote_sqlite_identifier(column)?);
            }
            builder.push(") VALUES (");
            for (index, (_, value)) in request.values.iter().enumerate() {
                if index > 0 {
                    builder.push(", ");
                }
                Self::push_bound_value(&mut builder, value)?;
            }
            builder.push(")");
            affected_rows += builder
                .build()
                .execute(&mut *transaction)
                .await?
                .rows_affected();
        }

        transaction.commit().await?;
        Ok(affected_rows)
    }

    async fn insert_table_row_stream_atomically(
        &self,
        mut rows: tokio::sync::mpsc::Receiver<crate::database::models::CsvImportRow>,
        cancelled: Arc<AtomicBool>,
    ) -> Result<u64> {
        let mut transaction = self.pool.begin().await?;
        let mut affected_rows = 0;
        while let Some(request) = rows.recv().await {
            if cancelled.load(Ordering::Relaxed) {
                return Err(anyhow::anyhow!(
                    "CSV import cancelled; all rows were rolled back"
                ));
            }
            let request = request.map_err(anyhow::Error::msg)?;
            if request.values.is_empty() {
                return Err(anyhow::anyhow!(
                    "Each CSV row requires at least one column value"
                ));
            }
            let mut builder = QueryBuilder::<Sqlite>::new("INSERT INTO ");
            builder.push(quote_sqlite_identifier(&request.table)?);
            builder.push(" (");
            for (index, (column, _)) in request.values.iter().enumerate() {
                if index > 0 {
                    builder.push(", ");
                }
                builder.push(quote_sqlite_identifier(column)?);
            }
            builder.push(") VALUES (");
            for (index, (_, value)) in request.values.iter().enumerate() {
                if index > 0 {
                    builder.push(", ");
                }
                Self::push_bound_value(&mut builder, value)?;
            }
            builder.push(")");
            affected_rows += builder
                .build()
                .execute(&mut *transaction)
                .await?
                .rows_affected();
        }
        if affected_rows == 0 {
            return Err(anyhow::anyhow!("CSV import did not contain any data rows"));
        }
        transaction.commit().await?;
        Ok(affected_rows)
    }

    fn driver_name(&self) -> &str {
        "SQLite"
    }

    async fn get_foreign_key_lookup_values(
        &self,
        referenced_table: &str,
        referenced_column: &str,
        display_columns: &[&str],
        search: Option<&str>,
        limit: u32,
    ) -> Result<Vec<LookupValue>> {
        // Identifiers are quoted (never interpolated raw) so a name like
        // `weird"table` cannot break out of the query; only the LIKE pattern
        // and LIMIT travel as bound values.
        let column_sql = quote_sqlite_identifier(referenced_column)?;
        let table_sql = referenced_table
            .split('.')
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .map(quote_sqlite_identifier)
            .collect::<Result<Vec<_>>>()?
            .join(".");
        let label_expr = if !display_columns.is_empty() {
            let cols = display_columns
                .iter()
                .map(|c| quote_sqlite_identifier(c))
                .collect::<Result<Vec<_>>>()?
                .join(", ");
            format!("COALESCE({cols})")
        } else {
            column_sql.clone()
        };

        let pool = &self.pool;
        let limit = i64::from(limit.min(10_000));

        if let Some(search_term) = search {
            let like_pattern = format!("%{}%", search_term);
            let sql = format!(
                "SELECT {column_sql} AS value, {label_expr} AS label \
                 FROM {table_sql} \
                 WHERE CAST({column_sql} AS TEXT) LIKE ?1 \
                 ORDER BY {column_sql} \
                 LIMIT ?2"
            );
            let rows: Vec<(serde_json::Value, String)> = sqlx::query_as(&sql)
                .bind(&like_pattern)
                .bind(limit)
                .fetch_all(pool)
                .await?;
            return Ok(rows
                .into_iter()
                .map(|(value, label)| LookupValue { value, label })
                .collect());
        }

        let sql = format!(
            "SELECT {column_sql} AS value, {label_expr} AS label \
             FROM {table_sql} \
             ORDER BY {column_sql} \
             LIMIT ?1"
        );
        let rows: Vec<(serde_json::Value, String)> =
            sqlx::query_as(&sql).bind(limit).fetch_all(pool).await?;
        Ok(rows
            .into_iter()
            .map(|(value, label)| LookupValue { value, label })
            .collect())
    }
}
