use super::driver::DatabaseDriver;
use super::models::*;
use super::safety::{
    normalize_order_dir, qualify_mysql_table_name, quote_mysql_identifier,
    quote_mysql_order_by, sanitize_mysql_filter_clause,
};
use anyhow::{Context, Result};
use async_trait::async_trait;
use sqlx::mysql::{MySqlConnectOptions, MySqlPool, MySqlRow, MySqlSslMode};
use sqlx::{Column, ConnectOptions, MySql, QueryBuilder, Row, TypeInfo};
use std::sync::Arc;
use tokio::sync::RwLock;
use std::time::Instant;

pub struct MySqlDriver {
    pool: MySqlPool,
    current_db: Arc<RwLock<Option<String>>>,
}

impl MySqlDriver {
    pub async fn connect(config: &ConnectionConfig) -> Result<Self> {
        let host = config.host.as_deref().unwrap_or("127.0.0.1");
        let port = config.port.unwrap_or_else(|| config.default_port());
        let user = config.username.as_deref().unwrap_or("root");
        let database = config.database.as_deref();

        let mut options = MySqlConnectOptions::new()
            .host(host)
            .port(port)
            .username(user)
            .password(config.password.as_deref().unwrap_or(""));

        if let Some(database_name) = database {
            options = options.database(database_name);
        }

        options = options.ssl_mode(if config.use_ssl {
            MySqlSslMode::Required
        } else {
            MySqlSslMode::Preferred
        });
        options = options.disable_statement_logging();

        let pool = MySqlPool::connect_with(options)
            .await
            .context("Failed to connect to MySQL")?;

        let current_db = Arc::new(RwLock::new(database.map(String::from)));
        Ok(Self { pool, current_db })
    }

    fn query_returns_rows(sql: &str) -> bool {
        let trimmed = sql.trim().to_uppercase();
        trimmed.starts_with("SELECT")
            || trimmed.starts_with("SHOW")
            || trimmed.starts_with("DESCRIBE")
            || trimmed.starts_with("EXPLAIN")
            || trimmed.starts_with("WITH")
            || trimmed.contains(" RETURNING ")
    }

    fn sandbox_can_bypass_transaction(sql: &str) -> bool {
        let trimmed = sql.trim().to_uppercase();
        (trimmed.starts_with("SELECT")
            && !trimmed.contains(" FOR UPDATE")
            && !trimmed.contains(" LOCK IN SHARE MODE"))
            || trimmed.starts_with("SHOW")
            || trimmed.starts_with("DESCRIBE")
    }

    fn build_result_from_rows(
        rows: &[MySqlRow],
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
                    .map(|(i, _col)| {
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
        builder: &mut QueryBuilder<'_, MySql>,
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
impl DatabaseDriver for MySqlDriver {
    async fn ping(&self) -> Result<()> {
        sqlx::query("SELECT 1")
            .execute(&self.pool)
            .await
            .context("MySQL ping failed")?;
        Ok(())
    }

    async fn disconnect(&self) -> Result<()> {
        self.pool.close().await;
        Ok(())
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        let rows: Vec<MySqlRow> = sqlx::query("SHOW DATABASES")
            .fetch_all(&self.pool)
            .await?;

        let mut databases = Vec::new();
        for row in rows {
            let name: String = row.get(0);
            databases.push(DatabaseInfo {
                name,
                size: None,
            });
        }
        Ok(databases)
    }

    async fn list_tables(&self, database: Option<&str>) -> Result<Vec<TableInfo>> {
        let db = database
            .map(String::from)
            .or_else(|| {
                let current = self.current_db.try_read().ok();
                current.and_then(|guard| guard.clone())
            });

        let rows: Vec<MySqlRow> = if let Some(ref db_name) = db {
            sqlx::query(
                "SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS, ENGINE \
                 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?",
            )
            .bind(db_name)
            .fetch_all(&self.pool)
            .await?
        } else {
            sqlx::query(
                "SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS, ENGINE \
                 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()",
            )
            .fetch_all(&self.pool)
            .await?
        };

        let mut tables = Vec::new();
        for row in rows {
            tables.push(TableInfo {
                name: row.get(0),
                schema: db.clone(),
                table_type: row.get::<String, _>(1),
                row_count: row.try_get::<i64, _>(2).ok(),
                engine: row.try_get::<String, _>(3).ok(),
            });
        }
        Ok(tables)
    }

    async fn get_table_structure(
        &self,
        table: &str,
        database: Option<&str>,
    ) -> Result<TableStructure> {
        // Columns
        let col_rows: Vec<MySqlRow> = if let Some(db_name) = database {
            sqlx::query(
                "SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_KEY, \
                 COLUMN_DEFAULT, EXTRA, COLUMN_TYPE, COLUMN_COMMENT \
                 FROM information_schema.COLUMNS \
                 WHERE TABLE_NAME = ? AND TABLE_SCHEMA = ? ORDER BY ORDINAL_POSITION",
            )
            .bind(table)
            .bind(db_name)
            .fetch_all(&self.pool)
            .await?
        } else {
            sqlx::query(
                "SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_KEY, \
                 COLUMN_DEFAULT, EXTRA, COLUMN_TYPE, COLUMN_COMMENT \
                 FROM information_schema.COLUMNS \
                 WHERE TABLE_NAME = ? AND TABLE_SCHEMA = DATABASE() ORDER BY ORDINAL_POSITION",
            )
            .bind(table)
            .fetch_all(&self.pool)
            .await?
        };

        let columns: Vec<ColumnDetail> = col_rows
            .iter()
            .map(|row| ColumnDetail {
                name: row.get(0),
                data_type: row.get(1),
                is_nullable: row.get::<String, _>(2) == "YES",
                is_primary_key: row.get::<String, _>(3) == "PRI",
                default_value: row.try_get(4).ok(),
                extra: row.try_get(5).ok(),
                column_type: row.try_get(6).ok(),
                comment: row.try_get(7).ok(),
            })
            .collect();

        // Indexes
        let idx_rows: Vec<MySqlRow> = if let Some(db_name) = database {
            sqlx::query(
                "SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE, INDEX_TYPE \
                 FROM information_schema.STATISTICS \
                 WHERE TABLE_NAME = ? AND TABLE_SCHEMA = ? ORDER BY SEQ_IN_INDEX",
            )
            .bind(table)
            .bind(db_name)
            .fetch_all(&self.pool)
            .await?
        } else {
            sqlx::query(
                "SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE, INDEX_TYPE \
                 FROM information_schema.STATISTICS \
                 WHERE TABLE_NAME = ? AND TABLE_SCHEMA = DATABASE() ORDER BY SEQ_IN_INDEX",
            )
            .bind(table)
            .fetch_all(&self.pool)
            .await?
        };

        let mut index_map: std::collections::HashMap<String, IndexInfo> =
            std::collections::HashMap::new();
        for row in &idx_rows {
            let name: String = row.get(0);
            let col: String = row.get(1);
            let non_unique: i32 = row.get(2);
            let idx_type: String = row.get(3);

            index_map
                .entry(name.clone())
                .and_modify(|idx| idx.columns.push(col.clone()))
                .or_insert(IndexInfo {
                    name,
                    columns: vec![col],
                    is_unique: non_unique == 0,
                    index_type: Some(idx_type),
                });
        }
        let indexes: Vec<IndexInfo> = index_map.into_values().collect();

        // Foreign keys
        let fk_rows: Vec<MySqlRow> = if let Some(db_name) = database {
            sqlx::query(
                "SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, \
                 REFERENCED_COLUMN_NAME \
                 FROM information_schema.KEY_COLUMN_USAGE \
                 WHERE TABLE_NAME = ? AND TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL",
            )
            .bind(table)
            .bind(db_name)
            .fetch_all(&self.pool)
            .await?
        } else {
            sqlx::query(
                "SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, \
                 REFERENCED_COLUMN_NAME \
                 FROM information_schema.KEY_COLUMN_USAGE \
                 WHERE TABLE_NAME = ? AND TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL",
            )
            .bind(table)
            .fetch_all(&self.pool)
            .await?
        };

        let foreign_keys: Vec<ForeignKeyInfo> = fk_rows
            .iter()
            .map(|row| ForeignKeyInfo {
                name: row.get(0),
                column: row.get(1),
                referenced_table: row.get(2),
                referenced_column: row.get(3),
                on_update: None,
                on_delete: None,
            })
            .collect();

        Ok(TableStructure {
            columns,
            indexes,
            foreign_keys,
        })
    }

    async fn execute_query(&self, sql: &str) -> Result<QueryResult> {
        let start = Instant::now();
        if Self::query_returns_rows(sql) {
            let rows: Vec<MySqlRow> = sqlx::query(sql).fetch_all(&self.pool).await?;
            let elapsed = start.elapsed().as_millis();
            Ok(Self::build_result_from_rows(
                &rows,
                elapsed,
                sql.to_string(),
                0,
                false,
            ))
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
                let rows: Vec<MySqlRow> = sqlx::query(statement).fetch_all(&self.pool).await?;
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
                let rows: Vec<MySqlRow> = sqlx::query(statement).fetch_all(&mut *tx).await?;
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
        database: Option<&str>,
        offset: u64,
        limit: u64,
        order_by: Option<&str>,
        order_dir: Option<&str>,
        filter: Option<&str>,
    ) -> Result<QueryResult> {
        let mut sql = format!("SELECT * FROM {}", qualify_mysql_table_name(table, database)?);
        if let Some(filter_clause) = sanitize_mysql_filter_clause(filter)? {
            sql.push_str(&format!(" WHERE {}", filter_clause));
        }
        if let Some(ob) = order_by {
            let dir = normalize_order_dir(order_dir)?;
            sql.push_str(&format!(" ORDER BY {} {}", quote_mysql_order_by(ob)?, dir));
        }
        sql.push_str(&format!(" LIMIT {} OFFSET {}", limit, offset));

        self.execute_query(&sql).await
    }

    async fn count_rows(&self, table: &str, database: Option<&str>) -> Result<i64> {
        let sql = format!("SELECT COUNT(*) FROM {}", qualify_mysql_table_name(table, database)?);
        let row: MySqlRow = sqlx::query(&sql).fetch_one(&self.pool).await?;
        let count: i64 = row.get(0);
        Ok(count)
    }

    async fn update_table_cell(&self, request: &TableCellUpdateRequest) -> Result<u64> {
        if request.primary_keys.is_empty() {
            return Err(anyhow::anyhow!(
                "Inline update requires at least one primary key column"
            ));
        }

        let mut builder = QueryBuilder::<MySql>::new("UPDATE ");
        builder.push(qualify_mysql_table_name(
            &request.table,
            request.database.as_deref(),
        )?);
        builder.push(" SET ");
        builder.push(quote_mysql_order_by(&request.target_column)?);
        builder.push(" = ");
        Self::push_bound_value(&mut builder, &request.value)?;
        builder.push(" WHERE ");

        for (index, primary_key) in request.primary_keys.iter().enumerate() {
            if index > 0 {
                builder.push(" AND ");
            }

            builder.push(quote_mysql_order_by(&primary_key.column)?);
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

    async fn use_database(&self, database: &str) -> Result<()> {
        let sql = format!("USE {}", quote_mysql_identifier(database)?);
        sqlx::query(&sql)
            .execute(&self.pool)
            .await?;
        let mut db = self.current_db.write().await;
        *db = Some(database.to_string());
        Ok(())
    }

    fn current_database(&self) -> Option<String> {
        self.current_db.try_read().ok().and_then(|guard| guard.clone())
    }

    fn driver_name(&self) -> &str {
        "MySQL"
    }
}
