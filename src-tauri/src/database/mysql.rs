use super::driver::DatabaseDriver;
use super::models::*;
use anyhow::{Context, Result};
use async_trait::async_trait;
use sqlx::mysql::{MySqlPool, MySqlRow};
use sqlx::{Column, Row, TypeInfo};
use std::sync::Arc;
use tokio::sync::RwLock;
use std::time::Instant;

pub struct MySqlDriver {
    pool: MySqlPool,
    current_db: Arc<RwLock<Option<String>>>,
}

impl MySqlDriver {
    pub async fn connect(url: &str, database: Option<&str>) -> Result<Self> {
        let pool = MySqlPool::connect(url)
            .await
            .context("Failed to connect to MySQL")?;

        let current_db = Arc::new(RwLock::new(database.map(String::from)));
        Ok(Self { pool, current_db })
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

        let query = if let Some(ref db) = db {
            format!(
                "SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS, ENGINE \
                 FROM information_schema.TABLES WHERE TABLE_SCHEMA = '{}'",
                db
            )
        } else {
            "SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS, ENGINE \
             FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()"
                .to_string()
        };

        let rows: Vec<MySqlRow> = sqlx::query(&query).fetch_all(&self.pool).await?;

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
        let db_clause = if let Some(db) = database {
            format!("AND TABLE_SCHEMA = '{}'", db)
        } else {
            "AND TABLE_SCHEMA = DATABASE()".to_string()
        };

        // Columns
        let col_query = format!(
            "SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_KEY, \
             COLUMN_DEFAULT, EXTRA, COLUMN_TYPE, COLUMN_COMMENT \
             FROM information_schema.COLUMNS \
             WHERE TABLE_NAME = '{}' {} ORDER BY ORDINAL_POSITION",
            table, db_clause
        );
        let col_rows: Vec<MySqlRow> = sqlx::query(&col_query).fetch_all(&self.pool).await?;

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
        let idx_query = format!(
            "SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE, INDEX_TYPE \
             FROM information_schema.STATISTICS \
             WHERE TABLE_NAME = '{}' {} ORDER BY SEQ_IN_INDEX",
            table, db_clause
        );
        let idx_rows: Vec<MySqlRow> = sqlx::query(&idx_query).fetch_all(&self.pool).await?;

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
        let fk_query = format!(
            "SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, \
             REFERENCED_COLUMN_NAME \
             FROM information_schema.KEY_COLUMN_USAGE \
             WHERE TABLE_NAME = '{}' {} AND REFERENCED_TABLE_NAME IS NOT NULL",
            table, db_clause
        );
        let fk_rows: Vec<MySqlRow> = sqlx::query(&fk_query).fetch_all(&self.pool).await?;

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

        // Detect if it's a SELECT query
        let trimmed = sql.trim().to_uppercase();
        let is_select = trimmed.starts_with("SELECT") || trimmed.starts_with("SHOW") || trimmed.starts_with("DESCRIBE") || trimmed.starts_with("EXPLAIN");

        if is_select {
            let rows: Vec<MySqlRow> = sqlx::query(sql).fetch_all(&self.pool).await?;
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
                        .map(|(i, _col)| {
                            // Try different types
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
        let mut sql = format!("SELECT * FROM `{}`", table);
        if let Some(f) = filter {
            if !f.is_empty() {
                sql.push_str(&format!(" WHERE {}", f));
            }
        }
        if let Some(ob) = order_by {
            let dir = order_dir.unwrap_or("ASC");
            sql.push_str(&format!(" ORDER BY `{}` {}", ob, dir));
        }
        sql.push_str(&format!(" LIMIT {} OFFSET {}", limit, offset));

        self.execute_query(&sql).await
    }

    async fn count_rows(&self, table: &str, _database: Option<&str>) -> Result<i64> {
        let sql = format!("SELECT COUNT(*) FROM `{}`", table);
        let row: MySqlRow = sqlx::query(&sql).fetch_one(&self.pool).await?;
        let count: i64 = row.get(0);
        Ok(count)
    }

    async fn use_database(&self, database: &str) -> Result<()> {
        sqlx::query(&format!("USE `{}`", database))
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
