use super::models::*;
use super::mysql::MySqlDriver;
use super::query_common::{statement_returns_rows, MAX_QUERY_RESULT_ROWS};
use anyhow::Result;
use futures_util::TryStreamExt;
use sqlx::mysql::{MySqlArguments, MySqlRow};
use sqlx::query::Query;
use sqlx::types::Json;
use sqlx::{Column, Executor, MySql, QueryBuilder, Row, TypeInfo};

/// Query execution helpers and information_schema metadata reads for the
/// MySQL driver, split into a second inherent impl block.
impl MySqlDriver {
    pub(super) fn query_returns_rows(sql: &str) -> bool {
        statement_returns_rows(sql, &["SELECT", "SHOW", "DESCRIBE", "EXPLAIN", "WITH"])
    }

    pub(super) fn build_result_from_rows(
        rows: &[MySqlRow],
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

    pub(super) async fn fetch_rows_limited<'a, E>(
        executor: E,
        sql: &'a str,
    ) -> Result<(Vec<MySqlRow>, bool)>
    where
        E: Executor<'a, Database = MySql>,
    {
        Self::fetch_rows_capped(executor, sql, MAX_QUERY_RESULT_ROWS).await
    }

    pub(super) async fn fetch_rows_capped<'a, E>(
        executor: E,
        sql: &'a str,
        max_rows: usize,
    ) -> Result<(Vec<MySqlRow>, bool)>
    where
        E: Executor<'a, Database = MySql>,
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
        mut query: Query<'q, MySql, MySqlArguments>,
        parameters: &[QueryParameter],
    ) -> Result<Query<'q, MySql, MySqlArguments>> {
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
                QueryParameterType::Json => query.bind(Json(parameter.value.clone())),
                QueryParameterType::Null => query.bind(Option::<String>::None),
            };
        }
        Ok(query)
    }

    pub(super) async fn fetch_parameterized_rows(
        &self,
        sql: &str,
        parameters: &[QueryParameter],
    ) -> Result<(Vec<MySqlRow>, bool)> {
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

    pub(super) async fn list_schema_objects(
        &self,
        database: Option<&str>,
    ) -> Result<Vec<SchemaObjectInfo>> {
        let db = database.map(String::from).or_else(|| {
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
                    create_date: None,
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
                    create_date: None,
                name: row.get(1),
                schema: schema.clone(),
                object_type: "TRIGGER".to_string(),
                related_table,
                definition: Some(format!(
                    "{}\n{}",
                    [
                        timing.unwrap_or_default(),
                        event.unwrap_or_default(),
                        "ON".to_string(),
                        definition_table_name,
                    ]
                    .join(" ")
                    .trim(),
                    statement.unwrap_or_default().trim(),
                )),
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
                    create_date: None,
            name: row.get(1),
            schema: row.try_get::<String, _>(0).ok(),
            object_type: row.get::<String, _>(2).to_ascii_uppercase(),
            related_table: None,
            definition: row.try_get(3).ok(),
        }));

        Ok(objects)
    }

    pub(super) async fn get_table_structure(
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
}
