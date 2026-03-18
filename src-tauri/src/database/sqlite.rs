use super::driver::DatabaseDriver;
use super::models::*;
use super::safety::{
    normalize_order_dir, quote_sqlite_identifier, quote_sqlite_order_by,
    sanitize_sqlite_filter_clause,
};
use anyhow::{Context, Result};
use async_trait::async_trait;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqliteRow, SqliteSynchronous};
use sqlx::{Column, ConnectOptions, QueryBuilder, Row, Sqlite, TypeInfo};
use std::fs;
use std::path::Path;
use std::time::Instant;

pub struct SqliteDriver {
    pool: SqlitePool,
    file_path: String,
}

impl SqliteDriver {
    pub async fn connect(file_path: &str) -> Result<Self> {
        if file_path != ":memory:" && !file_path.starts_with("sqlite:") {
            let path = Path::new(file_path);
            if let Some(parent) = path.parent() {
                if !parent.as_os_str().is_empty() {
                    fs::create_dir_all(parent).context("Failed to create SQLite parent directory")?;
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
        })
    }

    fn query_returns_rows(sql: &str) -> bool {
        let trimmed = sql.trim().to_uppercase();
        trimmed.starts_with("SELECT")
            || trimmed.starts_with("PRAGMA")
            || trimmed.starts_with("EXPLAIN")
            || trimmed.starts_with("WITH")
            || trimmed.contains(" RETURNING ")
    }

    fn sandbox_can_bypass_transaction(sql: &str) -> bool {
        let trimmed = sql.trim().to_uppercase();
        trimmed.starts_with("SELECT") || trimmed.starts_with("PRAGMA")
    }

    fn build_result_from_rows(
        rows: &[SqliteRow],
        elapsed: u128,
        query: String,
        affected_rows: u64,
        sandboxed: bool,
    ) -> QueryResult {
        let columns = if let Some(first) = rows.first() {
            first.columns()
                .iter()
                .map(|c| ColumnInfo {
                    name: c.name().to_string(),
                    data_type: c.type_info().name().to_string(),
                    is_nullable: true,
                    is_primary_key: false,
                    max_length: None,
                    default_value: None,
                })
                .collect()
        } else {
            Vec::new()
        };

        let result_rows: Vec<Vec<serde_json::Value>> = rows
            .iter()
            .map(|row| {
                row.columns()
                    .iter()
                    .enumerate()
                    .map(|(i, _)| {
                        if let Ok(v) = row.try_get::<String, _>(i) {
                            serde_json::Value::String(v)
                        } else if let Ok(v) = row.try_get::<i64, _>(i) {
                            serde_json::json!(v)
                        } else if let Ok(v) = row.try_get::<f64, _>(i) {
                            serde_json::json!(v)
                        } else if let Ok(v) = row.try_get::<bool, _>(i) {
                            serde_json::json!(v)
                        } else {
                            serde_json::Value::Null
                        }
                    })
                    .collect()
            })
            .collect();

        QueryResult {
            columns,
            rows: result_rows,
            affected_rows,
            execution_time_ms: elapsed,
            query,
            sandboxed,
        }
    }

    fn push_bound_value(
        builder: &mut QueryBuilder<'_, Sqlite>,
        value: &serde_json::Value,
    ) -> Result<()> {
        match value {
            serde_json::Value::Null => {
                builder.push("NULL");
            }
            serde_json::Value::Bool(value) => {
                builder.push_bind(*value);
            }
            serde_json::Value::Number(value) => {
                if let Some(int_value) = value.as_i64() {
                    builder.push_bind(int_value);
                } else if let Some(uint_value) = value.as_u64() {
                    if let Ok(signed_value) = i64::try_from(uint_value) {
                        builder.push_bind(signed_value);
                    } else if let Some(float_value) = value.as_f64() {
                        builder.push_bind(float_value);
                    } else {
                        return Err(anyhow::anyhow!("Unsupported numeric value"));
                    }
                } else if let Some(float_value) = value.as_f64() {
                    builder.push_bind(float_value);
                } else {
                    return Err(anyhow::anyhow!("Unsupported numeric value"));
                }
            }
            serde_json::Value::String(value) => {
                builder.push_bind(value.clone());
            }
            _ => {
                return Err(anyhow::anyhow!(
                    "Only string, number, boolean, and null values are supported"
                ));
            }
        }

        Ok(())
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
                name: row.get(0),
                table_type: row.get(1),
                schema: None,
                row_count: None,
                engine: Some("SQLite".to_string()),
            })
            .collect();

        Ok(tables)
    }

    async fn list_schema_objects(&self, _database: Option<&str>) -> Result<Vec<SchemaObjectInfo>> {
        let rows: Vec<SqliteRow> = sqlx::query(
            "SELECT name, type, tbl_name, sql \
             FROM sqlite_master \
             WHERE type IN ('view', 'trigger') AND name NOT LIKE 'sqlite_%' \
             ORDER BY type, name",
        )
        .fetch_all(&self.pool)
        .await?;

        Ok(rows
            .iter()
            .map(|row| SchemaObjectInfo {
                name: row.get(0),
                schema: None,
                object_type: row.get::<String, _>(1).to_ascii_uppercase(),
                related_table: row.try_get::<String, _>(2).ok(),
                definition: row.try_get(3).ok(),
            })
            .collect())
    }

    async fn get_table_structure(
        &self,
        table: &str,
        _database: Option<&str>,
    ) -> Result<TableStructure> {
        let quoted_table = quote_sqlite_identifier(table)?;
        // Columns via PRAGMA
        let col_rows: Vec<SqliteRow> = sqlx::query(&format!("PRAGMA table_info({})", quoted_table))
            .fetch_all(&self.pool)
            .await?;

        let columns = col_rows
            .iter()
            .map(|row| {
                let pk: i32 = row.get(5);
                ColumnDetail {
                    name: row.get(1),
                    data_type: row.get(2),
                    is_nullable: row.get::<i32, _>(3) == 0,
                    default_value: row.try_get(4).ok(),
                    is_primary_key: pk > 0,
                    extra: None,
                    column_type: None,
                    comment: None,
                }
            })
            .collect();

        // Indexes
        let idx_rows: Vec<SqliteRow> =
            sqlx::query(&format!("PRAGMA index_list({})", quoted_table))
                .fetch_all(&self.pool)
                .await?;

        let mut indexes = Vec::new();
        for row in &idx_rows {
            let name: String = row.get(1);
            let is_unique: i32 = row.get(2);

            let info_rows: Vec<SqliteRow> =
                sqlx::query(&format!(
                    "PRAGMA index_info({})",
                    quote_sqlite_identifier(&name)?
                ))
                    .fetch_all(&self.pool)
                    .await?;

            let cols: Vec<String> = info_rows.iter().map(|r| r.get(2)).collect();

            indexes.push(IndexInfo {
                name,
                columns: cols,
                is_unique: is_unique == 1,
                index_type: None,
            });
        }

        // Foreign keys
        let fk_rows: Vec<SqliteRow> =
            sqlx::query(&format!("PRAGMA foreign_key_list({})", quoted_table))
                .fetch_all(&self.pool)
                .await?;

        let foreign_keys = fk_rows
            .iter()
            .map(|row| ForeignKeyInfo {
                name: format!("fk_{}", row.get::<i32, _>(0)),
                column: row.get(3),
                referenced_table: row.get(2),
                referenced_column: row.get(4),
                on_update: row.try_get(5).ok(),
                on_delete: row.try_get(6).ok(),
            })
            .collect();

        let object_type = sqlx::query(
            "SELECT type FROM sqlite_master WHERE name = ? AND type IN ('table', 'view') LIMIT 1",
        )
        .bind(table)
        .fetch_optional(&self.pool)
        .await?
        .and_then(|row| row.try_get::<String, _>(0).ok())
        .map(|value| value.to_ascii_uppercase());

        let view_definition = sqlx::query(
            "SELECT sql FROM sqlite_master WHERE type = 'view' AND name = ? LIMIT 1",
        )
        .bind(table)
        .fetch_optional(&self.pool)
        .await?
        .and_then(|row| row.try_get::<String, _>(0).ok());

        let trigger_rows: Vec<SqliteRow> = sqlx::query(
            "SELECT name, tbl_name, sql \
             FROM sqlite_master \
             WHERE type = 'trigger' AND tbl_name = ? \
             ORDER BY name",
        )
        .bind(table)
        .fetch_all(&self.pool)
        .await?;

        let triggers = trigger_rows
            .iter()
            .map(|row| TriggerInfo {
                name: row.get(0),
                timing: None,
                event: None,
                related_table: row.try_get::<String, _>(1).ok(),
                definition: row.try_get(2).ok(),
            })
            .collect();

        Ok(TableStructure {
            columns,
            indexes,
            foreign_keys,
            triggers,
            view_definition,
            object_type,
        })
    }

    async fn execute_query(&self, sql: &str) -> Result<QueryResult> {
        let start = Instant::now();
        if Self::query_returns_rows(sql) {
            let rows: Vec<SqliteRow> = sqlx::query(sql).fetch_all(&self.pool).await?;
            let mut result = Self::build_result_from_rows(
                &rows,
                0,
                sql.to_string(),
                0,
                false,
            );
            result.execution_time_ms = start.elapsed().as_millis();
            Ok(result)
        } else {
            // For non-SELECT queries, split by semicolon and execute each statement
            let statements: Vec<&str> = sql
                .split(';')
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .collect();

            let mut total_affected: u64 = 0;
            let elapsed;

            if statements.len() > 1 {
                // Execute each statement separately for multiple statements
                for statement in &statements {
                    let result = sqlx::query(statement).execute(&self.pool).await?;
                    total_affected += result.rows_affected();
                }
                elapsed = start.elapsed().as_millis();
            } else {
                // Single statement - execute directly
                let result = sqlx::query(sql).execute(&self.pool).await?;
                total_affected = result.rows_affected();
                elapsed = start.elapsed().as_millis();
            }

            Ok(QueryResult {
                columns: Vec::new(),
                rows: Vec::new(),
                affected_rows: total_affected,
                execution_time_ms: elapsed,
                query: sql.to_string(),
                sandboxed: false,
            })
        }
    }

    async fn execute_sandboxed(&self, statements: &[String]) -> Result<QueryResult> {
        let start = Instant::now();
        let combined_query = statements.join(";\n");

        if statements
            .iter()
            .all(|statement| Self::sandbox_can_bypass_transaction(statement))
        {
            let mut last_result: Option<QueryResult> = None;

            for statement in statements {
                let rows: Vec<SqliteRow> = sqlx::query(statement).fetch_all(&self.pool).await?;
                last_result = Some(Self::build_result_from_rows(
                    &rows,
                    0,
                    combined_query.clone(),
                    0,
                    true,
                ));
            }

            let elapsed = start.elapsed().as_millis();
            if let Some(mut result) = last_result {
                result.execution_time_ms = elapsed;
                result.query = combined_query;
                result.sandboxed = true;
                return Ok(result);
            }
        }

        let mut tx = self.pool.begin().await?;
        let mut total_affected = 0;
        let mut last_result: Option<QueryResult> = None;

        for statement in statements {
            if Self::query_returns_rows(statement) {
                let rows: Vec<SqliteRow> = sqlx::query(statement).fetch_all(&mut *tx).await?;
                last_result = Some(Self::build_result_from_rows(
                    &rows,
                    0,
                    combined_query.clone(),
                    total_affected,
                    true,
                ));
            } else {
                let result = sqlx::query(statement).execute(&mut *tx).await?;
                total_affected += result.rows_affected();
            }
        }

        tx.rollback().await?;
        let elapsed = start.elapsed().as_millis();

        if let Some(mut result) = last_result {
            result.execution_time_ms = elapsed;
            result.affected_rows = total_affected;
            result.query = combined_query.clone();
            result.sandboxed = true;
            return Ok(result);
        }

        Ok(QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            affected_rows: total_affected,
            execution_time_ms: elapsed,
            query: combined_query,
            sandboxed: true,
        })
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
        sql.push_str(&format!(" LIMIT {} OFFSET {}", limit, offset));

        self.execute_query(&sql).await
    }

    async fn count_rows(&self, table: &str, _database: Option<&str>) -> Result<i64> {
        let sql = format!("SELECT COUNT(*) FROM {}", quote_sqlite_identifier(table)?);
        let row: SqliteRow = sqlx::query(&sql).fetch_one(&self.pool).await?;
        let count: i64 = row.get(0);
        Ok(count)
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

    fn driver_name(&self) -> &str {
        "SQLite"
    }
}
