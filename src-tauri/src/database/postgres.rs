use super::driver::DatabaseDriver;
use super::models::*;
use anyhow::{Context, Result};
use async_trait::async_trait;
use sqlx::postgres::{PgPool, PgRow};
use sqlx::{Column, Row, TypeInfo};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::RwLock;

pub struct PostgresDriver {
    pool: PgPool,
    current_db: Arc<RwLock<Option<String>>>,
}

impl PostgresDriver {
    pub async fn connect(url: &str, database: Option<&str>) -> Result<Self> {
        let pool = PgPool::connect(url)
            .await
            .context("Failed to connect to PostgreSQL")?;

        let current_db = Arc::new(RwLock::new(database.map(String::from)));
        Ok(Self { pool, current_db })
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

        let col_rows: Vec<PgRow> = sqlx::query(
            "SELECT c.column_name, c.data_type, c.is_nullable, c.column_default, \
             c.udt_name, \
             CASE WHEN tc.constraint_type = 'PRIMARY KEY' THEN true ELSE false END as is_pk \
             FROM information_schema.columns c \
             LEFT JOIN information_schema.key_column_usage kcu \
               ON c.column_name = kcu.column_name AND c.table_name = kcu.table_name AND c.table_schema = kcu.table_schema \
             LEFT JOIN information_schema.table_constraints tc \
               ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema AND tc.constraint_type = 'PRIMARY KEY' \
             WHERE c.table_name = $1 AND c.table_schema = $2 \
             ORDER BY c.ordinal_position",
        )
        .bind(&table_name)
        .bind(&schema)
        .fetch_all(&self.pool)
        .await?;

        let columns = col_rows
            .iter()
            .map(|row| ColumnDetail {
                name: row.get(0),
                data_type: row.get(1),
                is_nullable: row.get::<String, _>(2) == "YES",
                default_value: row.try_get(3).ok(),
                column_type: row.try_get(4).ok(),
                is_primary_key: row.try_get::<bool, _>(5).unwrap_or(false),
                extra: None,
                comment: None,
            })
            .collect();

        let idx_rows: Vec<PgRow> = sqlx::query(
            "SELECT i.relname, ix.indisunique, a.attname, am.amname \
             FROM pg_index ix \
             JOIN pg_class t ON t.oid = ix.indrelid \
             JOIN pg_namespace ns ON ns.oid = t.relnamespace \
             JOIN pg_class i ON i.oid = ix.indexrelid \
             JOIN pg_am am ON am.oid = i.relam \
             JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey) \
             WHERE t.relname = $1 AND ns.nspname = $2 \
             ORDER BY i.relname",
        )
        .bind(&table_name)
        .bind(&schema)
        .fetch_all(&self.pool)
        .await?;

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

        let fk_rows: Vec<PgRow> = sqlx::query(
            "SELECT tc.constraint_name, kcu.column_name, \
             ccu.table_name AS referenced_table, ccu.column_name AS referenced_column, \
             rc.update_rule, rc.delete_rule \
             FROM information_schema.table_constraints tc \
             JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema \
             JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.table_schema \
             JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema \
             WHERE tc.table_name = $1 AND tc.table_schema = $2 AND tc.constraint_type = 'FOREIGN KEY'",
        )
        .bind(&table_name)
        .bind(&schema)
        .fetch_all(&self.pool)
        .await?;

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

        if trimmed.starts_with("SELECT")
            || trimmed.starts_with("SHOW")
            || trimmed.starts_with("EXPLAIN")
            || trimmed.starts_with("WITH")
        {
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
            let result = sqlx::query(sql).execute(&self.pool).await?;
            let elapsed = start.elapsed().as_millis();

            Ok(QueryResult {
                columns: Vec::new(),
                rows: Vec::new(),
                affected_rows: result.rows_affected(),
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
