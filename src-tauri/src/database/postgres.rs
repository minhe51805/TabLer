use super::driver::DatabaseDriver;
use super::models::*;
use super::pgpass::read_pgpass;
use super::query_cancel::{request_cancel, CancelLookup, CancelScopeGuard, QueryCancelRegistry};
use super::query_common::{statement_returns_rows, MAX_TABLE_PAGE_ROWS};
use super::safety::{
    normalize_order_dir, qualify_postgres_table_name, quote_postgres_identifier,
    quote_postgres_order_by, sanitize_postgres_filter_clause,
};
use crate::utils::sql::split_sql_statements;
use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use futures_util::TryStreamExt;
use sqlx::postgres::{PgConnectOptions, PgConnection, PgPool, PgPoolOptions, PgRow};
use sqlx::{ConnectOptions, Postgres, QueryBuilder, Row};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock as StdRwLock};
use std::time::Instant;
use tokio::sync::RwLock;

const POOL_MAX_CONNECTIONS: u32 = 8;

pub struct PostgresDriver {
    pub(super) pool: StdRwLock<PgPool>,
    connect_options: PgConnectOptions,
    pub(super) current_db: Arc<RwLock<Option<String>>>,
    cancel_registry: StdRwLock<QueryCancelRegistry>,
}

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

        let pool = Self::open_pool(options.clone()).await?;
        Ok(Self {
            pool: StdRwLock::new(pool),
            connect_options: options,
            current_db: Arc::new(RwLock::new(Some(database.to_string()))),
            cancel_registry: StdRwLock::new(QueryCancelRegistry::new()),
        })
    }

    pub(super) fn pool(&self) -> PgPool {
        self.pool
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    async fn open_pool(options: PgConnectOptions) -> Result<PgPool> {
        let mut last_error = None;
        for attempt in 1..=3 {
            let pool_opts = PgPoolOptions::new()
                .min_connections(1)
                .max_connections(POOL_MAX_CONNECTIONS)
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

    pub(super) fn split_schema_table(table: &str) -> (String, String) {
        if let Some((schema, name)) = table.split_once('.') {
            (schema.to_string(), name.to_string())
        } else {
            ("public".to_string(), table.to_string())
        }
    }

    fn query_returns_rows(sql: &str) -> bool {
        statement_returns_rows(sql, &["SELECT", "SHOW", "EXPLAIN", "WITH"])
    }

    async fn execute_query_on_conn(conn: &mut PgConnection, sql: &str) -> Result<QueryResult> {
        let start = Instant::now();
        let statements = split_sql_statements(sql);

        if statements.len() <= 1 && Self::query_returns_rows(sql) {
            let (rows, truncated) = Self::fetch_rows_limited(&mut *conn, sql).await?;
            let mut result =
                Self::build_result_from_rows(&rows, 0, sql.to_string(), 0, false, truncated);
            result.execution_time_ms = start.elapsed().as_millis();
            return Ok(result);
        }

        let mut total_affected: u64 = 0;
        let mut last_result: Option<QueryResult> = None;
        let iterable: Vec<&String> = if statements.len() > 1 {
            statements.iter().collect()
        } else {
            statements.first().into_iter().collect()
        };

        for statement in iterable {
            if Self::query_returns_rows(statement) {
                let (rows, truncated) = Self::fetch_rows_limited(&mut *conn, statement).await?;
                last_result = Some(Self::build_result_from_rows(
                    &rows,
                    0,
                    sql.to_string(),
                    total_affected,
                    false,
                    truncated,
                ));
            } else {
                let result = sqlx::query(statement).execute(&mut *conn).await?;
                total_affected += result.rows_affected();
            }
        }

        let elapsed = start.elapsed().as_millis();
        if let Some(mut result) = last_result {
            result.execution_time_ms = elapsed;
            result.affected_rows = total_affected;
            return Ok(result);
        }

        Ok(QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            affected_rows: total_affected,
            execution_time_ms: elapsed,
            query: sql.to_string(),
            sandboxed: false,
            truncated: false,
        })
    }
}

#[async_trait]
impl DatabaseDriver for PostgresDriver {
    async fn ping(&self) -> Result<()> {
        sqlx::query("SELECT 1")
            .execute(&self.pool())
            .await
            .context("PostgreSQL ping failed")?;
        Ok(())
    }

    async fn disconnect(&self) -> Result<()> {
        self.pool().close().await;
        Ok(())
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        let rows: Vec<PgRow> = sqlx::query(
            "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname",
        )
        .fetch_all(&self.pool())
        .await?;

        Ok(rows
            .iter()
            .map(|row| DatabaseInfo {
                name: row.get(0),
                size: None,
            })
            .collect())
    }

    async fn list_tables(&self, _database: Option<&str>) -> Result<Vec<TableInfo>> {
        let rows: Vec<PgRow> = sqlx::query(
            "SELECT table_name, table_type, table_schema \
             FROM information_schema.tables \
             WHERE table_schema NOT IN ('pg_catalog', 'information_schema') \
             ORDER BY table_schema, table_name",
        )
        .fetch_all(&self.pool())
        .await?;

        Ok(rows
            .iter()
            .map(|row| TableInfo {
                create_date: None,
                name: row.get(0),
                table_type: row.get(1),
                schema: row.try_get::<String, _>(2).ok(),
                row_count: None,
                engine: None,
            })
            .collect())
    }

    async fn list_schema_objects(&self, database: Option<&str>) -> Result<Vec<SchemaObjectInfo>> {
        // Resolves to the inherent method in postgres_support.rs (inherent wins
        // over the trait method in associated-function resolution).
        PostgresDriver::list_schema_objects(self, database).await
    }

    async fn get_table_structure(
        &self,
        table: &str,
        database: Option<&str>,
    ) -> Result<TableStructure> {
        PostgresDriver::get_table_structure(self, table, database).await
    }

    async fn get_table_columns_preview(
        &self,
        table: &str,
        database: Option<&str>,
    ) -> Result<Vec<ColumnDetail>> {
        PostgresDriver::get_table_columns_preview(self, table, database).await
    }

    async fn execute_query_for_request(&self, request_id: &str, sql: &str) -> Result<QueryResult> {
        if request_id.trim().is_empty() {
            return self.execute_query(sql).await;
        }
        let pool = self.pool();
        let mut conn = pool.acquire().await.context("PostgreSQL acquire failed")?;
        let guard = CancelScopeGuard::begin(&self.cancel_registry, request_id);
        let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut *conn)
            .await
            .context("PostgreSQL backend pid lookup failed")?;
        if guard.register_backend(i64::from(pid)) {
            return Err(anyhow!("Query cancelled."));
        }
        let result = Self::execute_query_on_conn(&mut conn, sql).await;
        drop(guard);
        result
    }

    async fn cancel_query_request(&self, request_id: &str) -> Result<bool> {
        match request_cancel(&self.cancel_registry, request_id) {
            CancelLookup::NotRunning => Ok(false),
            CancelLookup::Pending => Ok(true),
            CancelLookup::Backend(pid) => {
                let cancelled: bool = sqlx::query_scalar("SELECT pg_cancel_backend($1)")
                    .bind(pid as i32)
                    .fetch_one(&self.pool())
                    .await
                    .context("PostgreSQL pg_cancel_backend failed")?;
                Ok(cancelled)
            }
        }
    }

    async fn execute_query(&self, sql: &str) -> Result<QueryResult> {
        let start = Instant::now();
        let statements = split_sql_statements(sql);

        if statements.len() <= 1 && Self::query_returns_rows(sql) {
            let (rows, truncated) = Self::fetch_rows_limited(&self.pool(), sql).await?;
            let mut result =
                Self::build_result_from_rows(&rows, 0, sql.to_string(), 0, false, truncated);
            result.execution_time_ms = start.elapsed().as_millis();
            Ok(result)
        } else {
            let mut total_affected: u64 = 0;
            let mut last_result: Option<QueryResult> = None;

            if statements.len() > 1 {
                for statement in &statements {
                    if Self::query_returns_rows(statement) {
                        let (rows, truncated) =
                            Self::fetch_rows_limited(&self.pool(), statement).await?;
                        last_result = Some(Self::build_result_from_rows(
                            &rows,
                            0,
                            sql.to_string(),
                            total_affected,
                            false,
                            truncated,
                        ));
                    } else {
                        let result = sqlx::query(statement).execute(&self.pool()).await?;
                        total_affected += result.rows_affected();
                    }
                }
            } else if let Some(statement) = statements.first() {
                if Self::query_returns_rows(statement) {
                    let (rows, truncated) =
                        Self::fetch_rows_limited(&self.pool(), statement).await?;
                    last_result = Some(Self::build_result_from_rows(
                        &rows,
                        0,
                        sql.to_string(),
                        total_affected,
                        false,
                        truncated,
                    ));
                } else {
                    let result = sqlx::query(statement).execute(&self.pool()).await?;
                    total_affected += result.rows_affected();
                }
            }

            let elapsed = start.elapsed().as_millis();
            if let Some(mut result) = last_result {
                result.execution_time_ms = elapsed;
                result.affected_rows = total_affected;
                return Ok(result);
            }

            Ok(QueryResult {
                columns: Vec::new(),
                rows: Vec::new(),
                affected_rows: total_affected,
                execution_time_ms: elapsed,
                query: sql.to_string(),
                sandboxed: false,
                truncated: false,
            })
        }
    }

    async fn preview_write_transaction(&self, statements: &[String]) -> Result<Vec<QueryResult>> {
        let mut tx = self.pool().begin().await?;
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

        if let Err(error) = tx.rollback().await {
            log::warn!("write-preview rollback failed: {error}");
        }
        execution?;
        Ok(results)
    }

    async fn execute_parameterized_query(
        &self,
        sql: &str,
        parameters: &[QueryParameter],
    ) -> Result<QueryResult> {
        let start = Instant::now();
        if Self::query_returns_rows(sql) {
            let (rows, truncated) = self.fetch_parameterized_rows(sql, parameters).await?;
            let mut result =
                Self::build_result_from_rows(&rows, 0, sql.to_string(), 0, false, truncated);
            result.execution_time_ms = start.elapsed().as_millis();
            return Ok(result);
        }
        let outcome = Self::bind_parameterized_query(sqlx::query(sql), parameters)?
            .execute(&self.pool())
            .await?;
        Ok(QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            affected_rows: outcome.rows_affected(),
            execution_time_ms: start.elapsed().as_millis(),
            query: sql.to_string(),
            sandboxed: false,
            truncated: false,
        })
    }

    async fn execute_parameterized_query_for_request(
        &self,
        request_id: &str,
        sql: &str,
        parameters: &[QueryParameter],
    ) -> Result<QueryResult> {
        if request_id.trim().is_empty() {
            return self.execute_parameterized_query(sql, parameters).await;
        }
        let pool = self.pool();
        let mut conn = pool.acquire().await.context("PostgreSQL acquire failed")?;
        let guard = CancelScopeGuard::begin(&self.cancel_registry, request_id);
        let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut *conn)
            .await
            .context("PostgreSQL backend pid lookup failed")?;
        if guard.register_backend(i64::from(pid)) {
            return Err(anyhow!("Query cancelled."));
        }
        let start = Instant::now();
        let result = if Self::query_returns_rows(sql) {
            let mut stream =
                Self::bind_parameterized_query(sqlx::query(sql), parameters)?.fetch(&mut *conn);
            let mut rows = Vec::new();
            let mut truncated = false;
            while let Some(row) = stream.try_next().await? {
                if rows.len() == super::query_common::MAX_QUERY_RESULT_ROWS {
                    truncated = true;
                    break;
                }
                rows.push(row);
            }
            let mut result =
                Self::build_result_from_rows(&rows, 0, sql.to_string(), 0, false, truncated);
            result.execution_time_ms = start.elapsed().as_millis();
            Ok(result)
        } else {
            let outcome = Self::bind_parameterized_query(sqlx::query(sql), parameters)?
                .execute(&mut *conn)
                .await?;
            Ok(QueryResult {
                columns: Vec::new(),
                rows: Vec::new(),
                affected_rows: outcome.rows_affected(),
                execution_time_ms: start.elapsed().as_millis(),
                query: sql.to_string(),
                sandboxed: false,
                truncated: false,
            })
        };
        drop(guard);
        result
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
        let mut sql = format!(
            "SELECT * FROM {}",
            qualify_postgres_table_name(table, "public")?
        );

        if let Some(filter_clause) = sanitize_postgres_filter_clause(filter)? {
            sql.push_str(&format!(" WHERE {}", filter_clause));
        }
        if let Some(ob) = order_by {
            let dir = normalize_order_dir(order_dir)?;
            sql.push_str(&format!(
                " ORDER BY {} {}",
                quote_postgres_order_by(ob)?,
                dir
            ));
        }
        let fetch_limit = limit.clamp(1, MAX_TABLE_PAGE_ROWS);
        sql.push_str(&format!(" LIMIT {} OFFSET {}", fetch_limit, offset));

        let start = Instant::now();
        let (rows, truncated) =
            Self::fetch_rows_capped(&self.pool(), &sql, fetch_limit as usize).await?;
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
        let sql = format!(
            "SELECT COUNT(*) FROM {}",
            qualify_postgres_table_name(table, "public")?
        );
        let row: PgRow = sqlx::query(&sql).fetch_one(&self.pool()).await?;
        Ok(row.get(0))
    }

    async fn count_null_values(
        &self,
        table: &str,
        _database: Option<&str>,
        column: &str,
    ) -> Result<i64> {
        let sql = format!(
            "SELECT COUNT(*) FROM {} WHERE {} IS NULL",
            qualify_postgres_table_name(table, "public")?,
            quote_postgres_order_by(column)?,
        );
        let row: PgRow = sqlx::query(&sql).fetch_one(&self.pool()).await?;
        Ok(row.get(0))
    }

    async fn update_table_cell(&self, request: &TableCellUpdateRequest) -> Result<u64> {
        if request.primary_keys.is_empty() {
            return Err(anyhow::anyhow!(
                "Inline update requires at least one primary key column"
            ));
        }

        let mut builder = QueryBuilder::<Postgres>::new("UPDATE ");
        builder.push(qualify_postgres_table_name(&request.table, "public")?);
        builder.push(" SET ");
        builder.push(quote_postgres_order_by(&request.target_column)?);
        builder.push(" = ");
        Self::push_bound_value(&mut builder, &request.value)?;
        builder.push(" WHERE ");

        for (index, primary_key) in request.primary_keys.iter().enumerate() {
            if index > 0 {
                builder.push(" AND ");
            }

            builder.push(quote_postgres_order_by(&primary_key.column)?);
            if primary_key.value.is_null() {
                builder.push(" IS NULL");
            } else {
                builder.push(" = ");
                Self::push_bound_value(&mut builder, &primary_key.value)?;
            }
        }

        let result = builder.build().execute(&self.pool()).await?;
        Ok(result.rows_affected())
    }

    async fn execute_restore_statements(&self, statements: &[String]) -> Result<u64> {
        let mut transaction = self.pool().begin().await?;
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
        let mut transaction = self.pool().begin().await?;
        let mut affected_rows = 0;
        for request in updates {
            if request.primary_keys.is_empty() {
                return Err(anyhow::anyhow!(
                    "Inline update requires at least one primary key column"
                ));
            }
            let mut builder = QueryBuilder::<Postgres>::new("UPDATE ");
            builder.push(qualify_postgres_table_name(&request.table, "public")?);
            builder.push(" SET ");
            builder.push(quote_postgres_order_by(&request.target_column)?);
            builder.push(" = ");
            Self::push_bound_value(&mut builder, &request.value)?;
            builder.push(" WHERE ");
            for (index, primary_key) in request.primary_keys.iter().enumerate() {
                if index > 0 {
                    builder.push(" AND ");
                }
                builder.push(quote_postgres_order_by(&primary_key.column)?);
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

        let mut tx = self.pool().begin().await?;
        let mut total_affected = 0u64;

        for row_keys in &request.rows {
            if row_keys.is_empty() {
                return Err(anyhow::anyhow!(
                    "Each deleted row must include at least one primary key value"
                ));
            }

            let mut builder = QueryBuilder::<Postgres>::new("DELETE FROM ");
            builder.push(qualify_postgres_table_name(&request.table, "public")?);
            builder.push(" WHERE ");

            for (index, primary_key) in row_keys.iter().enumerate() {
                if index > 0 {
                    builder.push(" AND ");
                }

                builder.push(quote_postgres_order_by(&primary_key.column)?);
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

    async fn use_database(&self, database: &str) -> Result<()> {
        let database = database.trim();
        if database.is_empty() {
            return Err(anyhow!("Database name is required"));
        }
        if self.current_database().as_deref() == Some(database) {
            return Ok(());
        }

        let options = self.connect_options.clone().database(database);
        let new_pool = Self::open_pool(options).await?;
        let old_pool = {
            let mut guard = self
                .pool
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            std::mem::replace(&mut *guard, new_pool)
        };
        old_pool.close().await;
        *self.current_db.write().await = Some(database.to_string());
        Ok(())
    }

    fn current_database(&self) -> Option<String> {
        self.current_db
            .try_read()
            .ok()
            .and_then(|guard| guard.clone())
    }

    async fn insert_table_row(&self, request: &TableRowInsertRequest) -> Result<u64> {
        if request.values.is_empty() {
            let sql = format!(
                "INSERT INTO {} DEFAULT VALUES",
                qualify_postgres_table_name(&request.table, "public")?
            );
            let result = sqlx::query(&sql).execute(&self.pool()).await?;
            return Ok(result.rows_affected());
        }

        let mut builder = QueryBuilder::<Postgres>::new("INSERT INTO ");
        builder.push(qualify_postgres_table_name(&request.table, "public")?);
        builder.push(" (");

        let mut first = true;
        for (col, _) in &request.values {
            if !first {
                builder.push(", ");
            }
            first = false;
            builder.push(quote_postgres_identifier(col)?);
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

        let result = builder.build().execute(&self.pool()).await?;
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

        let mut transaction = self.pool().begin().await?;
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

            let mut builder = QueryBuilder::<Postgres>::new("INSERT INTO ");
            builder.push(qualify_postgres_table_name(&request.table, "public")?);
            builder.push(" (");
            for (index, (column, _)) in request.values.iter().enumerate() {
                if index > 0 {
                    builder.push(", ");
                }
                builder.push(quote_postgres_identifier(column)?);
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
        let mut transaction = self.pool().begin().await?;
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
            let mut builder = QueryBuilder::<Postgres>::new("INSERT INTO ");
            builder.push(qualify_postgres_table_name(&request.table, "public")?);
            builder.push(" (");
            for (index, (column, _)) in request.values.iter().enumerate() {
                if index > 0 {
                    builder.push(", ");
                }
                builder.push(quote_postgres_identifier(column)?);
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
        "PostgreSQL"
    }

    async fn get_foreign_key_lookup_values(
        &self,
        referenced_table: &str,
        referenced_column: &str,
        display_columns: &[&str],
        search: Option<&str>,
        limit: u32,
    ) -> Result<Vec<LookupValue>> {
        PostgresDriver::get_foreign_key_lookup_values(
            self,
            referenced_table,
            referenced_column,
            display_columns,
            search,
            limit,
        )
        .await
    }
}
