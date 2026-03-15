use super::driver::DatabaseDriver;
use super::models::*;
use anyhow::{Context, Result};
use async_trait::async_trait;
use sqlx::sqlite::{SqlitePool, SqliteRow};
use sqlx::{Column, Row, TypeInfo};
use std::time::Instant;

pub struct SqliteDriver {
    pool: SqlitePool,
    file_path: String,
}

impl SqliteDriver {
    pub async fn connect(url: &str, file_path: &str) -> Result<Self> {
        let pool = SqlitePool::connect(url)
            .await
            .context("Failed to connect to SQLite")?;

        Ok(Self {
            pool,
            file_path: file_path.to_string(),
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
                name: row.get(0),
                table_type: row.get(1),
                schema: None,
                row_count: None,
                engine: Some("SQLite".to_string()),
            })
            .collect();

        Ok(tables)
    }

    async fn get_table_structure(
        &self,
        table: &str,
        _database: Option<&str>,
    ) -> Result<TableStructure> {
        // Columns via PRAGMA
        let col_rows: Vec<SqliteRow> = sqlx::query(&format!("PRAGMA table_info('{}')", table))
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
            sqlx::query(&format!("PRAGMA index_list('{}')", table))
                .fetch_all(&self.pool)
                .await?;

        let mut indexes = Vec::new();
        for row in &idx_rows {
            let name: String = row.get(1);
            let is_unique: i32 = row.get(2);

            let info_rows: Vec<SqliteRow> =
                sqlx::query(&format!("PRAGMA index_info('{}')", name))
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
            sqlx::query(&format!("PRAGMA foreign_key_list('{}')", table))
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

        Ok(TableStructure {
            columns,
            indexes,
            foreign_keys,
        })
    }

    async fn execute_query(&self, sql: &str) -> Result<QueryResult> {
        let start = Instant::now();
        let trimmed = sql.trim().to_uppercase();

        let is_select = trimmed.starts_with("SELECT")
            || trimmed.starts_with("PRAGMA")
            || trimmed.starts_with("EXPLAIN")
            || trimmed.starts_with("WITH");

        if is_select {
            let rows: Vec<SqliteRow> = sqlx::query(sql).fetch_all(&self.pool).await?;
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
        let mut sql = format!("SELECT * FROM \"{}\"", table);
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
        let sql = format!("SELECT COUNT(*) FROM \"{}\"", table);
        let row: SqliteRow = sqlx::query(&sql).fetch_one(&self.pool).await?;
        let count: i64 = row.get(0);
        Ok(count)
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
