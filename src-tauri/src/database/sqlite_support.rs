use super::models::*;
use super::query_common::{statement_returns_rows, MAX_QUERY_RESULT_ROWS};
use super::sqlite::SqliteDriver;
use anyhow::Result;
use futures_util::TryStreamExt;
use sqlx::query::Query;
use sqlx::sqlite::{SqliteArguments, SqliteRow};
use sqlx::{Column, Executor, QueryBuilder, Row, Sqlite, TypeInfo};

/// Query execution helpers and sqlite_master/PRAGMA metadata reads for the
/// SQLite driver, split into a second inherent impl block.
impl SqliteDriver {
    pub(super) fn query_returns_rows(sql: &str) -> bool {
        statement_returns_rows(sql, &["SELECT", "PRAGMA", "EXPLAIN", "WITH"])
    }

    pub(super) fn build_result_from_rows(
        rows: &[SqliteRow],
        elapsed: u128,
        query: String,
        affected_rows: u64,
        sandboxed: bool,
        truncated: bool,
    ) -> QueryResult {
        let columns = if let Some(first) = rows.first() {
            first
                .columns()
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
            truncated,
        }
    }

    pub(super) async fn fetch_rows_limited<'a, E>(
        executor: E,
        sql: &'a str,
    ) -> Result<(Vec<SqliteRow>, bool)>
    where
        E: Executor<'a, Database = Sqlite>,
    {
        Self::fetch_rows_capped(executor, sql, MAX_QUERY_RESULT_ROWS).await
    }

    pub(super) async fn fetch_rows_capped<'a, E>(
        executor: E,
        sql: &'a str,
        max_rows: usize,
    ) -> Result<(Vec<SqliteRow>, bool)>
    where
        E: Executor<'a, Database = Sqlite>,
    {
        let max_rows = max_rows.max(1);
        let mut stream = sqlx::query(sql).fetch(executor);
        let mut rows = Vec::new();

        while let Some(row) = stream.try_next().await? {
            if rows.len() == max_rows {
                return Ok((rows, true));
            }
            rows.push(row);
        }

        Ok((rows, false))
    }

    pub(super) fn bind_parameterized_query<'q>(
        mut query: Query<'q, Sqlite, SqliteArguments<'q>>,
        parameters: &[QueryParameter],
    ) -> Result<Query<'q, Sqlite, SqliteArguments<'q>>> {
        for parameter in parameters {
            query = match parameter.data_type {
                QueryParameterType::Text => query.bind(
                    parameter
                        .value
                        .as_str()
                        .ok_or_else(|| {
                            anyhow::anyhow!("Parameter '{}' must be text.", parameter.name)
                        })?
                        .to_string(),
                ),
                QueryParameterType::Integer => {
                    query.bind(parameter.value.as_i64().ok_or_else(|| {
                        anyhow::anyhow!("Parameter '{}' must be an integer.", parameter.name)
                    })?)
                }
                QueryParameterType::Decimal => {
                    query.bind(parameter.value.as_f64().ok_or_else(|| {
                        anyhow::anyhow!("Parameter '{}' must be a number.", parameter.name)
                    })?)
                }
                QueryParameterType::Boolean => {
                    query.bind(parameter.value.as_bool().ok_or_else(|| {
                        anyhow::anyhow!("Parameter '{}' must be boolean.", parameter.name)
                    })?)
                }
                QueryParameterType::Json => query.bind(parameter.value.to_string()),
                QueryParameterType::Null => query.bind(Option::<String>::None),
            };
        }
        Ok(query)
    }

    pub(super) async fn fetch_parameterized_rows(
        &self,
        sql: &str,
        parameters: &[QueryParameter],
    ) -> Result<(Vec<SqliteRow>, bool)> {
        let mut stream =
            Self::bind_parameterized_query(sqlx::query(sql), parameters)?.fetch(&self.pool);
        let mut rows = Vec::new();
        while let Some(row) = stream.try_next().await? {
            if rows.len() == MAX_QUERY_RESULT_ROWS {
                return Ok((rows, true));
            }
            rows.push(row);
        }
        Ok((rows, false))
    }

    pub(super) fn push_bound_value(
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

    pub(super) async fn list_schema_objects(
        &self,
        _database: Option<&str>,
    ) -> Result<Vec<SchemaObjectInfo>> {
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
                    create_date: None,
                name: row.get(0),
                schema: None,
                object_type: row.get::<String, _>(1).to_ascii_uppercase(),
                related_table: row.try_get::<String, _>(2).ok(),
                definition: row.try_get(3).ok(),
            })
            .collect())
    }

    pub(super) async fn get_table_structure(
        &self,
        table: &str,
        _database: Option<&str>,
    ) -> Result<TableStructure> {
        let quoted_table = super::safety::quote_sqlite_identifier(table)?;
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
        let idx_rows: Vec<SqliteRow> = sqlx::query(&format!("PRAGMA index_list({})", quoted_table))
            .fetch_all(&self.pool)
            .await?;

        let mut indexes = Vec::new();
        for row in &idx_rows {
            let name: String = row.get(1);
            let is_unique: i32 = row.get(2);

            let info_rows: Vec<SqliteRow> = sqlx::query(&format!(
                "PRAGMA index_info({})",
                super::safety::quote_sqlite_identifier(&name)?
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

        let view_definition =
            sqlx::query("SELECT sql FROM sqlite_master WHERE type = 'view' AND name = ? LIMIT 1")
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
}
