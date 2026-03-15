use super::driver::DatabaseDriver;
use super::models::*;
use anyhow::{Context, Result};
use async_trait::async_trait;
use sqlx::postgres::{PgPool, PgPoolOptions, PgRow};
use sqlx::{Column, Row, TypeInfo};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::RwLock;
use tokio::time::{timeout, Duration};

pub struct PostgresDriver {
    pool: PgPool,
    current_db: Arc<RwLock<Option<String>>>,
}

impl PostgresDriver {
    pub async fn connect(url: &str, database: Option<&str>) -> Result<Self> {
        eprintln!("[DEBUG] Connecting to PostgreSQL with URL (password hidden): {}", 
            url.replace(|c: char| !c.is_alphanumeric() && c != '@' && c != ':' && c != '/' && c != '?' && c != '=', "*"));
        
        // Increase timeout and add retry for cloud connections (Supabase, Neon, etc.)
        let _pool_options = PgPoolOptions::new()
            .max_lifetime(std::time::Duration::from_secs(1800))
            .acquire_timeout(std::time::Duration::from_secs(30))
            .idle_timeout(std::time::Duration::from_secs(600));
        
        // Try to connect with retry logic
        let mut last_error = None;
        for attempt in 1..=3 {
            let pool_opts = PgPoolOptions::new()
                .max_lifetime(std::time::Duration::from_secs(1800))
                .acquire_timeout(std::time::Duration::from_secs(30))
                .idle_timeout(std::time::Duration::from_secs(600));
            
            match pool_opts.connect(url).await {
                Ok(pool) => {
                    eprintln!("[DEBUG] PostgreSQL connection established on attempt {}", attempt);
                    let current_db = Arc::new(RwLock::new(database.map(String::from)));
                    return Ok(Self { pool, current_db });
                }
                Err(e) => {
                    eprintln!("[DEBUG] Connection attempt {} failed: {}", attempt, e);
                    last_error = Some(e);
                    if attempt < 3 {
                        tokio::time::sleep(std::time::Duration::from_millis(500 * attempt)).await;
                    }
                }
            }
        }
        
        Err(anyhow::anyhow!("Failed to connect to PostgreSQL after 3 attempts: {}", last_error.unwrap()))
    }

    fn split_schema_table(table: &str) -> (String, String) {
        if let Some((schema, name)) = table.split_once('.') {
            (schema.to_string(), name.to_string())
        } else {
            ("public".to_string(), table.to_string())
        }
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

        Ok(TableStructure {
            columns,
            indexes,
            foreign_keys,
        })
    }

    async fn execute_query(&self, sql: &str) -> Result<QueryResult> {
        let start = Instant::now();
        let trimmed = sql.trim().to_uppercase();

        // Check if it's a SELECT-like query
        let is_select = trimmed.starts_with("SELECT")
            || trimmed.starts_with("SHOW")
            || trimmed.starts_with("EXPLAIN")
            || trimmed.starts_with("WITH");

        if is_select {
            let rows: Vec<PgRow> = sqlx::query(sql).fetch_all(&self.pool).await?;
            let elapsed = start.elapsed().as_millis();

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
                            } else if let Ok(v) = row.try_get::<i32, _>(i) {
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

            Ok(QueryResult {
                columns,
                rows: result_rows,
                affected_rows: 0,
                execution_time_ms: elapsed,
                query: sql.to_string(),
            })
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
        let (schema, table_name) = Self::split_schema_table(table);
        let mut sql = format!("SELECT * FROM \"{}\".\"{}\"", schema, table_name);

        if let Some(f) = filter {
            if !f.is_empty() {
                sql.push_str(&format!(" WHERE {}", f));
            }
        }
        if let Some(ob) = order_by {
            let dir = order_dir.unwrap_or("ASC");
            sql.push_str(&format!(" ORDER BY \"{}\" {}", ob, dir));
        }
        sql.push_str(&format!(" LIMIT {} OFFSET {}", limit, offset));

        self.execute_query(&sql).await
    }

    async fn count_rows(&self, table: &str, _database: Option<&str>) -> Result<i64> {
        let (schema, table_name) = Self::split_schema_table(table);
        let sql = format!("SELECT COUNT(*) FROM \"{}\".\"{}\"", schema, table_name);
        let row: PgRow = sqlx::query(&sql).fetch_one(&self.pool).await?;
        Ok(row.get(0))
    }

    async fn use_database(&self, database: &str) -> Result<()> {
        let mut db = self.current_db.write().await;
        *db = Some(database.to_string());
        Ok(())
    }

    fn current_database(&self) -> Option<String> {
        self.current_db.try_read().ok().and_then(|guard| guard.clone())
    }

    fn driver_name(&self) -> &str {
        "PostgreSQL"
    }
}
