use super::driver::DatabaseDriver;
use super::models::*;
use super::safety::{
    normalize_order_dir, qualify_mysql_table_name, quote_mysql_identifier,
    quote_mysql_order_by, sanitize_mysql_filter_clause,
};
use crate::utils::sql::split_sql_statements;
use anyhow::{Context, Result};
use async_trait::async_trait;
use futures_util::TryStreamExt;
use sqlx::mysql::{MySqlConnectOptions, MySqlPool, MySqlPoolOptions, MySqlRow, MySqlSslMode};
use sqlx::{Column, ConnectOptions, Executor, MySql, QueryBuilder, Row, TypeInfo};
use std::sync::Arc;
use tokio::sync::RwLock;
use std::time::Instant;

pub struct MySqlDriver {
    pool: MySqlPool,
    current_db: Arc<RwLock<Option<String>>>,
}

const MAX_QUERY_RESULT_ROWS: usize = 500;

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

        let pool = MySqlPoolOptions::new()
            .min_connections(1)
            .max_lifetime(std::time::Duration::from_secs(1800))
            .acquire_timeout(std::time::Duration::from_secs(30))
            .idle_timeout(std::time::Duration::from_secs(600))
            .test_before_acquire(false)
            .connect_with(options)
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
        truncated: bool,
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
            truncated,
        }
    }

    async fn fetch_rows_limited<'a, E>(executor: E, sql: &'a str) -> Result<(Vec<MySqlRow>, bool)>
    where
        E: Executor<'a, Database = MySql>,
    {
        let mut stream = sqlx::query(sql).fetch(executor);
        let mut rows = Vec::new();

        while let Some(row) = stream.try_next().await? {
            if rows.len() == MAX_QUERY_RESULT_ROWS {
                return Ok((rows, true));
            }
            rows.push(row);
        }

        Ok((rows, false))
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

    async fn list_schema_objects(&self, database: Option<&str>) -> Result<Vec<SchemaObjectInfo>> {
        let db = database
            .map(String::from)
            .or_else(|| {
                let current = self.current_db.try_read().ok();
                current.and_then(|guard| guard.clone())
            });

        let mut objects = Vec::new();

        let view_rows: Vec<MySqlRow> = if let Some(ref db_name) = db {
            sqlx::query(
                "SELECT TABLE_SCHEMA, TABLE_NAME, VIEW_DEFINITION \
                 FROM information_schema.VIEWS \
                 WHERE TABLE_SCHEMA = ? \
                 ORDER BY TABLE_SCHEMA, TABLE_NAME",
            )
            .bind(db_name)
            .fetch_all(&self.pool)
            .await?
        } else {
            sqlx::query(
                "SELECT TABLE_SCHEMA, TABLE_NAME, VIEW_DEFINITION \
                 FROM information_schema.VIEWS \
                 WHERE TABLE_SCHEMA = DATABASE() \
                 ORDER BY TABLE_SCHEMA, TABLE_NAME",
            )
            .fetch_all(&self.pool)
            .await?
        };

        objects.extend(view_rows.iter().map(|row| SchemaObjectInfo {
            name: row.get(1),
            schema: row.try_get::<String, _>(0).ok(),
            object_type: "VIEW".to_string(),
            related_table: None,
            definition: row.try_get(2).ok(),
        }));

        let trigger_rows: Vec<MySqlRow> = if let Some(ref db_name) = db {
            sqlx::query(
                "SELECT TRIGGER_SCHEMA, TRIGGER_NAME, ACTION_TIMING, EVENT_MANIPULATION, EVENT_OBJECT_TABLE, ACTION_STATEMENT \
                 FROM information_schema.TRIGGERS \
                 WHERE TRIGGER_SCHEMA = ? \
                 ORDER BY TRIGGER_SCHEMA, EVENT_OBJECT_TABLE, TRIGGER_NAME",
            )
            .bind(db_name)
            .fetch_all(&self.pool)
            .await?
        } else {
            sqlx::query(
                "SELECT TRIGGER_SCHEMA, TRIGGER_NAME, ACTION_TIMING, EVENT_MANIPULATION, EVENT_OBJECT_TABLE, ACTION_STATEMENT \
                 FROM information_schema.TRIGGERS \
                 WHERE TRIGGER_SCHEMA = DATABASE() \
                 ORDER BY TRIGGER_SCHEMA, EVENT_OBJECT_TABLE, TRIGGER_NAME",
            )
            .fetch_all(&self.pool)
            .await?
        };

        objects.extend(trigger_rows.iter().map(|row| {
            let schema = row.try_get::<String, _>(0).ok();
            let table_name = row.try_get::<String, _>(4).ok();
            let timing = row.try_get::<String, _>(2).ok();
            let event = row.try_get::<String, _>(3).ok();
            let statement = row.try_get::<String, _>(5).ok();
            let related_table = match (schema.clone(), table_name.clone()) {
                (Some(schema), Some(table)) => Some(format!("{schema}.{table}")),
                (None, Some(table)) => Some(table),
                _ => None,
            };
            let definition_table_name = table_name.clone().unwrap_or_default();
            SchemaObjectInfo {
                name: row.get(1),
                schema: schema.clone(),
                object_type: "TRIGGER".to_string(),
                related_table,
                definition: Some(
                    [
                        timing.unwrap_or_default(),
                        event.unwrap_or_default(),
                        "ON".to_string(),
                        definition_table_name,
                    ]
                    .join(" ")
                    .trim()
                    .to_string()
                        + "\n"
                        + statement.unwrap_or_default().trim(),
                ),
            }
        }));

        let routine_rows: Vec<MySqlRow> = if let Some(ref db_name) = db {
            sqlx::query(
                "SELECT ROUTINE_SCHEMA, ROUTINE_NAME, ROUTINE_TYPE, ROUTINE_DEFINITION \
                 FROM information_schema.ROUTINES \
                 WHERE ROUTINE_SCHEMA = ? \
                 ORDER BY ROUTINE_SCHEMA, ROUTINE_TYPE, ROUTINE_NAME",
            )
            .bind(db_name)
            .fetch_all(&self.pool)
            .await?
        } else {
            sqlx::query(
                "SELECT ROUTINE_SCHEMA, ROUTINE_NAME, ROUTINE_TYPE, ROUTINE_DEFINITION \
                 FROM information_schema.ROUTINES \
                 WHERE ROUTINE_SCHEMA = DATABASE() \
                 ORDER BY ROUTINE_SCHEMA, ROUTINE_TYPE, ROUTINE_NAME",
            )
            .fetch_all(&self.pool)
            .await?
        };

        objects.extend(routine_rows.iter().map(|row| SchemaObjectInfo {
            name: row.get(1),
            schema: row.try_get::<String, _>(0).ok(),
            object_type: row.get::<String, _>(2).to_ascii_uppercase(),
            related_table: None,
            definition: row.try_get(3).ok(),
        }));

        Ok(objects)
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

        let object_type = if let Some(db_name) = database {
            sqlx::query(
                "SELECT TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 1",
            )
            .bind(db_name)
            .bind(table)
            .fetch_optional(&self.pool)
            .await?
        } else {
            sqlx::query(
                "SELECT TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1",
            )
            .bind(table)
            .fetch_optional(&self.pool)
            .await?
        }
        .and_then(|row| row.try_get::<String, _>(0).ok());

        let view_definition = if let Some(db_name) = database {
            sqlx::query(
                "SELECT VIEW_DEFINITION FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 1",
            )
            .bind(db_name)
            .bind(table)
            .fetch_optional(&self.pool)
            .await?
        } else {
            sqlx::query(
                "SELECT VIEW_DEFINITION FROM information_schema.VIEWS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1",
            )
            .bind(table)
            .fetch_optional(&self.pool)
            .await?
        }
        .and_then(|row| row.try_get::<String, _>(0).ok());

        let trigger_rows: Vec<MySqlRow> = if let Some(db_name) = database {
            sqlx::query(
                "SELECT TRIGGER_NAME, ACTION_TIMING, EVENT_MANIPULATION, EVENT_OBJECT_TABLE, ACTION_STATEMENT \
                 FROM information_schema.TRIGGERS \
                 WHERE TRIGGER_SCHEMA = ? AND EVENT_OBJECT_TABLE = ? \
                 ORDER BY TRIGGER_NAME",
            )
            .bind(db_name)
            .bind(table)
            .fetch_all(&self.pool)
            .await?
        } else {
            sqlx::query(
                "SELECT TRIGGER_NAME, ACTION_TIMING, EVENT_MANIPULATION, EVENT_OBJECT_TABLE, ACTION_STATEMENT \
                 FROM information_schema.TRIGGERS \
                 WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = ? \
                 ORDER BY TRIGGER_NAME",
            )
            .bind(table)
            .fetch_all(&self.pool)
            .await?
        };

        let triggers = trigger_rows
            .iter()
            .map(|row| TriggerInfo {
                name: row.get(0),
                timing: row.try_get(1).ok(),
                event: row.try_get(2).ok(),
                related_table: row.try_get(3).ok(),
                definition: row.try_get(4).ok(),
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
        let statements = split_sql_statements(sql);

        if statements.len() <= 1 && Self::query_returns_rows(sql) {
            let (rows, truncated) = Self::fetch_rows_limited(&self.pool, sql).await?;
            let mut result = Self::build_result_from_rows(
                &rows,
                0,
                sql.to_string(),
                0,
                false,
                truncated,
            );
            result.execution_time_ms = start.elapsed().as_millis();
            Ok(result)
        } else {
            let mut total_affected: u64 = 0;
            let mut last_result: Option<QueryResult> = None;

            if statements.len() > 1 {
                for statement in &statements {
                    if Self::query_returns_rows(statement) {
                        let (rows, truncated) = Self::fetch_rows_limited(&self.pool, statement).await?;
                        last_result = Some(Self::build_result_from_rows(
                            &rows,
                            0,
                            sql.to_string(),
                            total_affected,
                            false,
                            truncated,
                        ));
                    } else {
                        let result = sqlx::query(statement).execute(&self.pool).await?;
                        total_affected += result.rows_affected();
                    }
                }
            } else if let Some(statement) = statements.first() {
                if Self::query_returns_rows(statement) {
                    let (rows, truncated) = Self::fetch_rows_limited(&self.pool, statement).await?;
                    last_result = Some(Self::build_result_from_rows(
                        &rows,
                        0,
                        sql.to_string(),
                        total_affected,
                        false,
                        truncated,
                    ));
                } else {
                    let result = sqlx::query(statement).execute(&self.pool).await?;
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

    async fn execute_sandboxed(&self, statements: &[String]) -> Result<QueryResult> {
        let start = Instant::now();
        let combined_query = statements.join(";\n");

        if statements
            .iter()
            .all(|statement| Self::sandbox_can_bypass_transaction(statement))
        {
            let mut last_result: Option<QueryResult> = None;

            for statement in statements {
                let (rows, truncated) = Self::fetch_rows_limited(&self.pool, statement).await?;
                last_result = Some(Self::build_result_from_rows(
                    &rows,
                    0,
                    combined_query.clone(),
                    0,
                    true,
                    truncated,
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
                let (rows, truncated) = Self::fetch_rows_limited(&mut *tx, statement).await?;
                last_result = Some(Self::build_result_from_rows(
                    &rows,
                    0,
                    combined_query.clone(),
                    total_affected,
                    true,
                    truncated,
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
            truncated: false,
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

    async fn count_null_values(
        &self,
        table: &str,
        database: Option<&str>,
        column: &str,
    ) -> Result<i64> {
        let sql = format!(
            "SELECT COUNT(*) FROM {} WHERE {} IS NULL",
            qualify_mysql_table_name(table, database)?,
            quote_mysql_order_by(column)?,
        );
        let row: MySqlRow = sqlx::query(&sql).fetch_one(&self.pool).await?;
        Ok(row.get(0))
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

            let mut builder = QueryBuilder::<MySql>::new("DELETE FROM ");
            builder.push(qualify_mysql_table_name(
                &request.table,
                request.database.as_deref(),
            )?);
            builder.push(" WHERE ");

            for (index, primary_key) in row_keys.iter().enumerate() {
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

            let result = builder.build().execute(&mut *tx).await?;
            total_affected += result.rows_affected();
        }

        tx.commit().await?;
        Ok(total_affected)
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
