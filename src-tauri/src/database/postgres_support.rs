use super::models::*;
use super::postgres::PostgresDriver;
use super::query_common::MAX_QUERY_RESULT_ROWS;
use anyhow::{Context, Result};
use futures_util::TryStreamExt;
use log::warn;
use sqlx::postgres::{PgArguments, PgRow};
use sqlx::query::Query;
use sqlx::types::Json;
use sqlx::{Column, Executor, Postgres, QueryBuilder, Row, TypeInfo, ValueRef};
use tokio::time::{timeout, Duration};

/// Query execution helpers, information_schema metadata reads, and FK lookup
/// for the PostgreSQL driver, split into a second inherent impl block.
impl PostgresDriver {
    pub(super) fn build_result_from_rows(
        rows: &[PgRow],
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
                    .map(|(i, _)| {
                        Self::pg_cell_to_json(row, i, column_types.get(i).map(String::as_str))
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
    ) -> Result<(Vec<PgRow>, bool)>
    where
        E: Executor<'a, Database = Postgres>,
    {
        Self::fetch_rows_capped(executor, sql, MAX_QUERY_RESULT_ROWS).await
    }

    pub(super) async fn fetch_rows_capped<'a, E>(
        executor: E,
        sql: &'a str,
        max_rows: usize,
    ) -> Result<(Vec<PgRow>, bool)>
    where
        E: Executor<'a, Database = Postgres>,
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
        mut query: Query<'q, Postgres, PgArguments>,
        parameters: &[QueryParameter],
    ) -> Result<Query<'q, Postgres, PgArguments>> {
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
    ) -> Result<(Vec<PgRow>, bool)> {
        let mut stream =
            Self::bind_parameterized_query(sqlx::query(sql), parameters)?.fetch(&self.pool());
        let mut rows = Vec::new();
        while let Some(row) = stream.try_next().await? {
            if rows.len() == MAX_QUERY_RESULT_ROWS {
                return Ok((rows, true));
            }
            rows.push(row);
        }
        Ok((rows, false))
    }

    pub(super) fn pg_cell_to_json(
        row: &PgRow,
        index: usize,
        type_name: Option<&str>,
    ) -> serde_json::Value {
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

    pub(super) fn push_bound_value(
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

    pub(super) async fn list_schema_objects(
        &self,
        _database: Option<&str>,
    ) -> Result<Vec<SchemaObjectInfo>> {
        let mut objects = Vec::new();

        let view_rows: Vec<PgRow> = sqlx::query(
            "SELECT table_schema, table_name, view_definition \
             FROM information_schema.views \
             WHERE table_schema NOT IN ('pg_catalog', 'information_schema') \
             ORDER BY table_schema, table_name",
        )
        .fetch_all(&self.pool())
        .await?;

        objects.extend(view_rows.iter().map(|row| SchemaObjectInfo {
                    create_date: None,
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
        .fetch_all(&self.pool())
        .await?;

        objects.extend(trigger_rows.iter().map(|row| {
            let schema = row.try_get::<String, _>(0).ok();
            let table_schema = row.try_get::<String, _>(2).ok();
            let table_name = row.try_get::<String, _>(3).ok();
            let timing = row.try_get::<String, _>(4).ok();
            let events = row.try_get::<String, _>(5).ok();
            let statement = row.try_get::<String, _>(6).ok();

            SchemaObjectInfo {
                    create_date: None,
                name: row.get(1),
                schema,
                object_type: "TRIGGER".to_string(),
                related_table: match (table_schema, table_name.clone()) {
                    (Some(schema), Some(table)) => Some(format!("{schema}.{table}")),
                    (None, Some(table)) => Some(table),
                    _ => table_name,
                },
                definition: Some(format!(
                    "{}\n{}",
                    [
                        timing.unwrap_or_default(),
                        events.unwrap_or_default(),
                        "ON".to_string(),
                        row.try_get::<String, _>(3).unwrap_or_default(),
                    ]
                    .join(" ")
                    .trim(),
                    statement.unwrap_or_default().trim(),
                )),
            }
        }));

        let routine_rows: Vec<PgRow> = sqlx::query(
            "SELECT routine_schema, routine_name, routine_type, routine_definition \
             FROM information_schema.routines \
             WHERE routine_schema NOT IN ('pg_catalog', 'information_schema') \
             ORDER BY routine_schema, routine_type, routine_name",
        )
        .fetch_all(&self.pool())
        .await?;

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
                        CASE \
                          WHEN a.attidentity = 'a' THEN 'generated always as identity' \
                          WHEN a.attidentity = 'd' THEN 'generated by default as identity' \
                          WHEN a.attgenerated = 's' THEN 'generated stored' \
                          ELSE NULL \
                        END AS extra, \
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
            .fetch_all(&self.pool())
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
                extra: row.try_get(5).ok(),
                is_primary_key: row.try_get::<bool, _>(6).unwrap_or(false),
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
            .fetch_all(&self.pool())
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
            .fetch_all(&self.pool())
            .await
        };

        let (idx_result, fk_result) = tokio::join!(
            timeout(Duration::from_secs(4), idx_query),
            timeout(Duration::from_secs(4), fk_query)
        );

        let idx_rows: Vec<PgRow> = match idx_result {
            Ok(Ok(rows)) => rows,
            Ok(Err(error)) => {
                warn!(
                    "Failed to load PostgreSQL indexes for {}.{}: {:?}",
                    schema, table_name, error
                );
                Vec::new()
            }
            Err(_) => {
                warn!(
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
                warn!(
                    "Failed to load PostgreSQL foreign keys for {}.{}: {:?}",
                    schema, table_name, error
                );
                Vec::new()
            }
            Err(_) => {
                warn!(
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
        .fetch_optional(&self.pool())
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
        .fetch_optional(&self.pool())
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
        .fetch_all(&self.pool())
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

    pub(super) async fn get_table_columns_preview(
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
                    CASE \
                      WHEN a.attidentity = 'a' THEN 'generated always as identity' \
                      WHEN a.attidentity = 'd' THEN 'generated by default as identity' \
                      WHEN a.attgenerated = 's' THEN 'generated stored' \
                      ELSE NULL \
                    END AS extra, \
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
        .fetch_all(&self.pool())
        .await?;

        Ok(rows
            .iter()
            .map(|row| ColumnDetail {
                name: row.get(0),
                data_type: row.get(1),
                is_nullable: row.try_get::<bool, _>(2).unwrap_or(false),
                default_value: row.try_get(3).ok(),
                column_type: row.try_get(4).ok(),
                extra: row.try_get(5).ok(),
                is_primary_key: row.try_get::<bool, _>(6).unwrap_or(false),
                comment: None,
            })
            .collect())
    }

    pub(super) async fn get_foreign_key_lookup_values(
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
        let pool = self.pool();

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
                .fetch_all(&pool)
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
            referenced_column, label_expr, schema, table_name, referenced_column, limit
        );
        let rows: Vec<(serde_json::Value, String)> = sqlx::query_as(&sql).fetch_all(&pool).await?;
        Ok(rows
            .into_iter()
            .map(|(value, label)| LookupValue { value, label })
            .collect())
    }
}
