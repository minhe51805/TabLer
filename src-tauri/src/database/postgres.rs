use super::driver::DatabaseDriver;
use super::models::*;
use super::query_common::{statement_returns_rows, MAX_QUERY_RESULT_ROWS};
use super::safety::{
    normalize_order_dir, qualify_postgres_table_name, quote_postgres_identifier,
    quote_postgres_order_by, sanitize_postgres_filter_clause,
};
use crate::utils::sql::split_sql_statements;
use anyhow::{Context, Result};
use async_trait::async_trait;
use futures_util::TryStreamExt;
use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions, PgRow, PgSslMode};
use sqlx::types::Json;
use sqlx::{Column, ConnectOptions, Executor, Postgres, QueryBuilder, Row, TypeInfo, ValueRef};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::RwLock;
use tokio::time::{timeout, Duration};

pub struct PostgresDriver {
    pool: PgPool,
    current_db: Arc<RwLock<Option<String>>>,
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

        let mut options = PgConnectOptions::new()
            .host(host)
            .port(port)
            .username(user)
            .password(config.password.as_deref().unwrap_or(""))
            .database(database);

        options = options.ssl_mode(if config.use_ssl {
            PgSslMode::Require
        } else {
            PgSslMode::Prefer
        });
        options = options.disable_statement_logging();

        // Try to connect with retry logic
        let mut last_error = None;
        for attempt in 1..=3 {
            let pool_opts = PgPoolOptions::new()
                .min_connections(1)
                .max_lifetime(std::time::Duration::from_secs(1800))
                .acquire_timeout(std::time::Duration::from_secs(30))
                .idle_timeout(std::time::Duration::from_secs(600))
                // Avoid an extra validation round-trip on every acquire. The initial
                // connect path already proves the pool is live, and query failures
                // surface naturally if the server drops later.
                .test_before_acquire(false);

            match pool_opts.connect_with(options.clone()).await {
                Ok(pool) => {
                    let current_db = Arc::new(RwLock::new(Some(database.to_string())));
                    return Ok(Self { pool, current_db });
                }
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

    fn split_schema_table(table: &str) -> (String, String) {
        if let Some((schema, name)) = table.split_once('.') {
            (schema.to_string(), name.to_string())
        } else {
            ("public".to_string(), table.to_string())
        }
    }

    fn query_returns_rows(sql: &str) -> bool {
        statement_returns_rows(sql, &["SELECT", "SHOW", "EXPLAIN", "WITH"])
    }

    fn build_result_from_rows(
        rows: &[PgRow],
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

        let column_types = rows
            .first()
            .map(|first| {
                first
                    .columns()
                    .iter()
                    .map(|column| column.type_info().name().to_ascii_uppercase())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        let result_rows: Vec<Vec<serde_json::Value>> = rows
            .iter()
            .map(|row| {
                row.columns()
                    .iter()
                    .enumerate()
                    .map(|(i, _)| Self::pg_cell_to_json(row, i, column_types.get(i).map(String::as_str)))
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

    async fn fetch_rows_limited<'a, E>(executor: E, sql: &'a str) -> Result<(Vec<PgRow>, bool)>
    where
        E: Executor<'a, Database = Postgres>,
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

    fn pg_cell_to_json(row: &PgRow, index: usize, type_name: Option<&str>) -> serde_json::Value {
        if row
            .try_get_raw(index)
            .map(|value| value.is_null())
            .unwrap_or(false)
        {
            return serde_json::Value::Null;
        }

        match type_name.unwrap_or_default() {
            "BOOL" => row
                .try_get::<bool, _>(index)
                .map(serde_json::Value::from)
                .unwrap_or(serde_json::Value::Null),
            "INT2" | "INT4" | "INT8" | "OID" => row
                .try_get::<i64, _>(index)
                .map(serde_json::Value::from)
                .or_else(|_| row.try_get::<i32, _>(index).map(serde_json::Value::from))
                .unwrap_or(serde_json::Value::Null),
            "FLOAT4" | "FLOAT8" | "NUMERIC" | "MONEY" => row
                .try_get::<f64, _>(index)
                .map(serde_json::Value::from)
                .unwrap_or(serde_json::Value::Null),
            "JSON" | "JSONB" => row
                .try_get::<Json<serde_json::Value>, _>(index)
                .map(|value| value.0)
                .unwrap_or(serde_json::Value::Null),
            "DATE" => row
                .try_get::<chrono::NaiveDate, _>(index)
                .map(|value| serde_json::Value::String(value.to_string()))
                .unwrap_or(serde_json::Value::Null),
            "TIME" => row
                .try_get::<chrono::NaiveTime, _>(index)
                .map(|value| serde_json::Value::String(value.to_string()))
                .unwrap_or(serde_json::Value::Null),
            "TIMESTAMP" => row
                .try_get::<chrono::NaiveDateTime, _>(index)
                .map(|value| serde_json::Value::String(value.to_string()))
                .unwrap_or(serde_json::Value::Null),
            "TIMESTAMPTZ" => row
                .try_get::<chrono::DateTime<chrono::Utc>, _>(index)
                .map(|value| serde_json::Value::String(value.to_rfc3339()))
                .unwrap_or(serde_json::Value::Null),
            _ => row
                .try_get::<String, _>(index)
                .map(serde_json::Value::String)
                .or_else(|_| row.try_get::<i64, _>(index).map(serde_json::Value::from))
                .or_else(|_| row.try_get::<f64, _>(index).map(serde_json::Value::from))
                .or_else(|_| row.try_get::<bool, _>(index).map(serde_json::Value::from))
                .unwrap_or(serde_json::Value::Null),
        }
    }

    fn push_bound_value(
        builder: &mut QueryBuilder<'_, Postgres>,
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
impl DatabaseDriver for PostgresDriver {
    async fn ping(&self) -> Result<()> {
        sqlx::query("SELECT 1")
            .execute(&self.pool)
            .await
            .context("PostgreSQL ping failed")?;
        Ok(())
    }

    async fn disconnect(&self) -> Result<()> {
        self.pool.close().await;
        Ok(())
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        let rows: Vec<PgRow> = sqlx::query(
            "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname",
        )
        .fetch_all(&self.pool)
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
        .fetch_all(&self.pool)
        .await?;

        Ok(rows
            .iter()
            .map(|row| TableInfo {
                name: row.get(0),
                table_type: row.get(1),
                schema: row.try_get::<String, _>(2).ok(),
                row_count: None,
                engine: None,
            })
            .collect())
    }

    async fn list_schema_objects(&self, _database: Option<&str>) -> Result<Vec<SchemaObjectInfo>> {
        let mut objects = Vec::new();

        let view_rows: Vec<PgRow> = sqlx::query(
            "SELECT table_schema, table_name, view_definition \
             FROM information_schema.views \
             WHERE table_schema NOT IN ('pg_catalog', 'information_schema') \
             ORDER BY table_schema, table_name",
        )
        .fetch_all(&self.pool)
        .await?;

        objects.extend(view_rows.iter().map(|row| SchemaObjectInfo {
            name: row.get(1),
            schema: row.try_get::<String, _>(0).ok(),
            object_type: "VIEW".to_string(),
            related_table: None,
            definition: row.try_get(2).ok(),
        }));

        let trigger_rows: Vec<PgRow> = sqlx::query(
            "SELECT trigger_schema, trigger_name, event_object_schema, event_object_table, action_timing, \
                    string_agg(event_manipulation, ', ' ORDER BY event_manipulation) AS events, action_statement \
             FROM information_schema.triggers \
             WHERE trigger_schema NOT IN ('pg_catalog', 'information_schema') \
             GROUP BY trigger_schema, trigger_name, event_object_schema, event_object_table, action_timing, action_statement \
             ORDER BY trigger_schema, event_object_table, trigger_name",
        )
        .fetch_all(&self.pool)
        .await?;

        objects.extend(trigger_rows.iter().map(|row| {
            let schema = row.try_get::<String, _>(0).ok();
            let table_schema = row.try_get::<String, _>(2).ok();
            let table_name = row.try_get::<String, _>(3).ok();
            let timing = row.try_get::<String, _>(4).ok();
            let events = row.try_get::<String, _>(5).ok();
            let statement = row.try_get::<String, _>(6).ok();

            SchemaObjectInfo {
                name: row.get(1),
                schema,
                object_type: "TRIGGER".to_string(),
                related_table: match (table_schema, table_name.clone()) {
                    (Some(schema), Some(table)) => Some(format!("{schema}.{table}")),
                    (None, Some(table)) => Some(table),
                    _ => table_name,
                },
                definition: Some(
                    [
                        timing.unwrap_or_default(),
                        events.unwrap_or_default(),
                        "ON".to_string(),
                        row.try_get::<String, _>(3).unwrap_or_default(),
                    ]
                    .join(" ")
                    .trim()
                    .to_string()
                        + "\n"
                        + statement.unwrap_or_default().trim(),
                ),
            }
        }));

        let routine_rows: Vec<PgRow> = sqlx::query(
            "SELECT routine_schema, routine_name, routine_type, routine_definition \
             FROM information_schema.routines \
             WHERE routine_schema NOT IN ('pg_catalog', 'information_schema') \
             ORDER BY routine_schema, routine_type, routine_name",
        )
        .fetch_all(&self.pool)
        .await?;

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
        _database: Option<&str>,
    ) -> Result<TableStructure> {
        let (schema, table_name) = Self::split_schema_table(table);

        let col_rows: Vec<PgRow> = timeout(Duration::from_secs(6), async {
            sqlx::query(
                "WITH target AS ( \
                   SELECT c.oid AS relid \
                   FROM pg_class c \
                   JOIN pg_namespace n ON n.oid = c.relnamespace \
                   WHERE n.nspname = $2 AND c.relname = $1 \
                   LIMIT 1 \
                 ) \
                 SELECT a.attname, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull, \
                        pg_get_expr(ad.adbin, ad.adrelid), \
                        format_type(a.atttypid, a.atttypmod), \
                        EXISTS ( \
                          SELECT 1 \
                          FROM pg_constraint con \
                          WHERE con.conrelid = a.attrelid \
                            AND con.contype = 'p' \
                            AND a.attnum = ANY(con.conkey) \
                        ) AS is_pk \
                 FROM target t \
                 JOIN pg_attribute a ON a.attrelid = t.relid \
                 LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum \
                 WHERE a.attnum > 0 AND NOT a.attisdropped \
                 ORDER BY a.attnum",
            )
            .bind(&table_name)
            .bind(&schema)
            .fetch_all(&self.pool)
            .await
        })
        .await
        .with_context(|| format!("Timed out loading columns for {}.{}", schema, table_name))??;

        let columns = col_rows
            .iter()
            .map(|row| ColumnDetail {
                name: row.get(0),
                data_type: row.get(1),
                is_nullable: row.try_get::<bool, _>(2).unwrap_or(false),
                default_value: row.try_get(3).ok(),
                column_type: row.try_get(4).ok(),
                is_primary_key: row.try_get::<bool, _>(5).unwrap_or(false),
                extra: None,
                comment: None,
            })
            .collect();

        let idx_query = async {
            sqlx::query(
                "WITH target AS ( \
                   SELECT c.oid AS relid \
                   FROM pg_class c \
                   JOIN pg_namespace n ON n.oid = c.relnamespace \
                   WHERE n.nspname = $2 AND c.relname = $1 \
                   LIMIT 1 \
                 ) \
                 SELECT idx.relname, ix.indisunique, att.attname, am.amname \
                 FROM target t \
                 JOIN pg_index ix ON ix.indrelid = t.relid \
                 JOIN pg_class idx ON idx.oid = ix.indexrelid \
                 JOIN pg_am am ON am.oid = idx.relam \
                 JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS key(attnum, ord) ON TRUE \
                 JOIN pg_attribute att ON att.attrelid = t.relid AND att.attnum = key.attnum \
                 ORDER BY idx.relname, key.ord",
            )
            .bind(&table_name)
            .bind(&schema)
            .fetch_all(&self.pool)
            .await
        };

        let fk_query = async {
            sqlx::query(
                "WITH target AS ( \
                   SELECT c.oid AS relid \
                   FROM pg_class c \
                   JOIN pg_namespace n ON n.oid = c.relnamespace \
                   WHERE n.nspname = $2 AND c.relname = $1 \
                   LIMIT 1 \
                 ) \
                 SELECT con.conname, src_att.attname, ref_tbl.relname, ref_att.attname, \
                        CASE con.confupdtype \
                          WHEN 'a' THEN 'NO ACTION' \
                          WHEN 'r' THEN 'RESTRICT' \
                          WHEN 'c' THEN 'CASCADE' \
                          WHEN 'n' THEN 'SET NULL' \
                          WHEN 'd' THEN 'SET DEFAULT' \
                          ELSE NULL \
                        END AS update_rule, \
                        CASE con.confdeltype \
                          WHEN 'a' THEN 'NO ACTION' \
                          WHEN 'r' THEN 'RESTRICT' \
                          WHEN 'c' THEN 'CASCADE' \
                          WHEN 'n' THEN 'SET NULL' \
                          WHEN 'd' THEN 'SET DEFAULT' \
                          ELSE NULL \
                        END AS delete_rule \
                 FROM target t \
                 JOIN pg_constraint con ON con.conrelid = t.relid AND con.contype = 'f' \
                 JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS src(attnum, ord) ON TRUE \
                 JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS dst(attnum, ord) ON dst.ord = src.ord \
                 JOIN pg_attribute src_att ON src_att.attrelid = t.relid AND src_att.attnum = src.attnum \
                 JOIN pg_class ref_tbl ON ref_tbl.oid = con.confrelid \
                 JOIN pg_attribute ref_att ON ref_att.attrelid = con.confrelid AND ref_att.attnum = dst.attnum \
                 ORDER BY con.conname, src.ord",
            )
            .bind(&table_name)
            .bind(&schema)
            .fetch_all(&self.pool)
            .await
        };

        let (idx_result, fk_result) = tokio::join!(
            timeout(Duration::from_secs(4), idx_query),
            timeout(Duration::from_secs(4), fk_query)
        );

        let idx_rows: Vec<PgRow> = match idx_result {
            Ok(Ok(rows)) => rows,
            Ok(Err(error)) => {
                eprintln!(
                    "Failed to load PostgreSQL indexes for {}.{}: {:?}",
                    schema, table_name, error
                );
                Vec::new()
            }
            Err(_) => {
                eprintln!(
                    "Timed out loading PostgreSQL indexes for {}.{}",
                    schema, table_name
                );
                Vec::new()
            }
        };

        let mut index_map: std::collections::HashMap<String, IndexInfo> =
            std::collections::HashMap::new();
        for row in &idx_rows {
            let name: String = row.get(0);
            let is_unique: bool = row.get(1);
            let col: String = row.get(2);
            let idx_type: String = row.get(3);
            index_map
                .entry(name.clone())
                .and_modify(|idx| idx.columns.push(col.clone()))
                .or_insert(IndexInfo {
                    name,
                    columns: vec![col],
                    is_unique,
                    index_type: Some(idx_type),
                });
        }
        let indexes = index_map.into_values().collect();

        let fk_rows: Vec<PgRow> = match fk_result {
            Ok(Ok(rows)) => rows,
            Ok(Err(error)) => {
                eprintln!(
                    "Failed to load PostgreSQL foreign keys for {}.{}: {:?}",
                    schema, table_name, error
                );
                Vec::new()
            }
            Err(_) => {
                eprintln!(
                    "Timed out loading PostgreSQL foreign keys for {}.{}",
                    schema, table_name
                );
                Vec::new()
            }
        };

        let foreign_keys = fk_rows
            .iter()
            .map(|row| ForeignKeyInfo {
                name: row.get(0),
                column: row.get(1),
                referenced_table: row.get(2),
                referenced_column: row.get(3),
                on_update: row.try_get(4).ok(),
                on_delete: row.try_get(5).ok(),
            })
            .collect();

        let object_type = sqlx::query(
            "SELECT table_type \
             FROM information_schema.tables \
             WHERE table_schema = $1 AND table_name = $2 \
             LIMIT 1",
        )
        .bind(&schema)
        .bind(&table_name)
        .fetch_optional(&self.pool)
        .await?
        .and_then(|row| row.try_get::<String, _>(0).ok());

        let view_definition = sqlx::query(
            "SELECT view_definition \
             FROM information_schema.views \
             WHERE table_schema = $1 AND table_name = $2 \
             LIMIT 1",
        )
        .bind(&schema)
        .bind(&table_name)
        .fetch_optional(&self.pool)
        .await?
        .and_then(|row| row.try_get::<String, _>(0).ok());

        let trigger_rows: Vec<PgRow> = sqlx::query(
            "SELECT trigger_name, action_timing, \
                    string_agg(event_manipulation, ', ' ORDER BY event_manipulation) AS events, \
                    action_statement \
             FROM information_schema.triggers \
             WHERE event_object_schema = $1 AND event_object_table = $2 \
             GROUP BY trigger_name, action_timing, action_statement \
             ORDER BY trigger_name",
        )
        .bind(&schema)
        .bind(&table_name)
        .fetch_all(&self.pool)
        .await?;

        let triggers = trigger_rows
            .iter()
            .map(|row| TriggerInfo {
                name: row.get(0),
                timing: row.try_get(1).ok(),
                event: row.try_get(2).ok(),
                related_table: Some(format!("{}.{}", schema, table_name)),
                definition: row.try_get(3).ok(),
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

    async fn get_table_columns_preview(
        &self,
        table: &str,
        _database: Option<&str>,
    ) -> Result<Vec<ColumnDetail>> {
        let (schema, table_name) = Self::split_schema_table(table);
        let rows: Vec<PgRow> = sqlx::query(
            "WITH target AS ( \
               SELECT c.oid AS relid \
               FROM pg_class c \
               JOIN pg_namespace n ON n.oid = c.relnamespace \
               WHERE n.nspname = $2 AND c.relname = $1 \
               LIMIT 1 \
             ) \
             SELECT a.attname, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull, \
                    pg_get_expr(ad.adbin, ad.adrelid), \
                    format_type(a.atttypid, a.atttypmod), \
                    EXISTS ( \
                      SELECT 1 \
                      FROM pg_constraint con \
                      WHERE con.conrelid = a.attrelid \
                        AND con.contype = 'p' \
                        AND a.attnum = ANY(con.conkey) \
                    ) AS is_pk \
             FROM target t \
             JOIN pg_attribute a ON a.attrelid = t.relid \
             LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum \
             WHERE a.attnum > 0 AND NOT a.attisdropped \
             ORDER BY a.attnum",
        )
        .bind(&table_name)
        .bind(&schema)
        .fetch_all(&self.pool)
        .await?;

        Ok(rows
            .iter()
            .map(|row| ColumnDetail {
                name: row.get(0),
                data_type: row.get(1),
                is_nullable: row.try_get::<bool, _>(2).unwrap_or(false),
                default_value: row.try_get(3).ok(),
                column_type: row.try_get(4).ok(),
                is_primary_key: row.try_get::<bool, _>(5).unwrap_or(false),
                extra: None,
                comment: None,
            })
            .collect())
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
            sql.push_str(&format!(" ORDER BY {} {}", quote_postgres_order_by(ob)?, dir));
        }
        sql.push_str(&format!(" LIMIT {} OFFSET {}", limit, offset));

        self.execute_query(&sql).await
    }

    async fn count_rows(&self, table: &str, _database: Option<&str>) -> Result<i64> {
        let sql = format!(
            "SELECT COUNT(*) FROM {}",
            qualify_postgres_table_name(table, "public")?
        );
        let row: PgRow = sqlx::query(&sql).fetch_one(&self.pool).await?;
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
        let row: PgRow = sqlx::query(&sql).fetch_one(&self.pool).await?;
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
        let mut db = self.current_db.write().await;
        *db = Some(database.to_string());
        Ok(())
    }

    fn current_database(&self) -> Option<String> {
        self.current_db.try_read().ok().and_then(|guard| guard.clone())
    }

    async fn insert_table_row(&self, request: &TableRowInsertRequest) -> Result<u64> {
        if request.values.is_empty() {
            return Err(anyhow::anyhow!("Insert requires at least one column value"));
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

        let result = builder.build().execute(&self.pool).await?;
        Ok(result.rows_affected())
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
        let (schema, table_name) = Self::split_schema_table(referenced_table);

        // Build label expression: COALESCE(display_col1, display_col2, ..., referenced_column)
        let label_expr = if !display_columns.is_empty() {
            let cols = display_columns
                .iter()
                .map(|c| format!("\"{}\"", c))
                .collect::<Vec<_>>()
                .join(", ");
            format!("COALESCE({})", cols)
        } else {
            format!("\"{}\"", referenced_column)
        };

        // Build the query - we always need the WHERE for search, so build the right query
        let pool = &self.pool;

        if let Some(search_term) = search {
            let like_pattern = format!("%{}%", search_term);
            let sql = format!(
                "SELECT \"{}\" AS value, {} AS label \
                 FROM {}.\"{}\" \
                 WHERE CAST(\"{}\" AS TEXT) ILIKE $1 \
                 ORDER BY \"{}\" \
                 LIMIT {}",
                referenced_column,
                label_expr,
                schema,
                table_name,
                referenced_column,
                referenced_column,
                limit
            );
            let rows: Vec<(serde_json::Value, String)> = sqlx::query_as(&sql)
                .bind(&like_pattern)
                .fetch_all(pool)
                .await?;
            return Ok(rows
                .into_iter()
                .map(|(value, label)| LookupValue { value, label })
                .collect());
        }

        let sql = format!(
            "SELECT \"{}\" AS value, {} AS label \
             FROM {}.\"{}\" \
             ORDER BY \"{}\" \
             LIMIT {}",
            referenced_column,
            label_expr,
            schema,
            table_name,
            referenced_column,
            limit
        );
        let rows: Vec<(serde_json::Value, String)> = sqlx::query_as(&sql)
            .fetch_all(pool)
            .await?;
        Ok(rows
            .into_iter()
            .map(|(value, label)| LookupValue { value, label })
            .collect())
    }
}
