use super::driver::DatabaseDriver;
use super::models::*;
use super::query_common::{statement_returns_rows, MAX_QUERY_RESULT_ROWS};
use super::safety::{
    normalize_order_dir, quote_clickhouse_identifier, quote_clickhouse_order_by,
    sanitize_clickhouse_filter_clause,
};
use crate::utils::sql::split_sql_statements;
use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use reqwest::Client;
use serde::Deserialize;
use serde_json::Value;
use std::sync::{Arc, RwLock};
use std::time::Instant;

#[derive(Debug, Deserialize)]
struct ClickHouseMetaColumn {
    name: String,
    #[serde(rename = "type")]
    data_type: String,
}

#[derive(Debug, Deserialize)]
struct ClickHouseJsonResult {
    meta: Vec<ClickHouseMetaColumn>,
    data: Vec<serde_json::Map<String, Value>>,
}

pub struct ClickHouseDriver {
    client: Client,
    base_url: String,
    username: String,
    password: String,
    current_db: Arc<RwLock<Option<String>>>,
}

impl ClickHouseDriver {
    pub async fn connect(config: &ConnectionConfig) -> Result<Self> {
        let base_url = Self::build_base_url(config)?;
        let username = config
            .username
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .context("ClickHouse username is required")?
            .to_string();
        let password = config.password.clone().unwrap_or_default();
        let current_db = Arc::new(RwLock::new(Some(
            config
                .database
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("default")
                .to_string(),
        )));

        let driver = Self {
            client: Client::builder()
                .build()
                .context("Failed to initialize ClickHouse HTTP client")?,
            base_url,
            username,
            password,
            current_db,
        };

        driver.ping().await?;
        Ok(driver)
    }

    fn build_base_url(config: &ConnectionConfig) -> Result<String> {
        let scheme = if config.use_ssl { "https" } else { "http" };
        let raw_host = config
            .host
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .context("ClickHouse host is required")?;
        let host = if raw_host.contains(':') && !raw_host.starts_with('[') {
            format!("[{raw_host}]")
        } else {
            raw_host.to_string()
        };
        let port = config.port.unwrap_or(8123);
        Ok(format!("{scheme}://{host}:{port}/"))
    }

    fn query_returns_rows(sql: &str) -> bool {
        statement_returns_rows(sql, &["SELECT", "SHOW", "DESCRIBE", "EXPLAIN", "WITH"])
    }

    fn current_database_name(&self, override_name: Option<&str>) -> String {
        override_name
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| self.current_db.read().ok().and_then(|guard| guard.clone()))
            .unwrap_or_else(|| "default".to_string())
    }

    fn qualify_table_name(table: &str, database: Option<&str>) -> Result<String> {
        let trimmed = table.trim();
        if trimmed.is_empty() {
            return Err(anyhow!("Table name cannot be empty"));
        }

        let parts = trimmed
            .split('.')
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>();

        match parts.as_slice() {
            [schema, name] => Ok(format!(
                "{}.{}",
                quote_clickhouse_identifier(schema)?,
                quote_clickhouse_identifier(name)?,
            )),
            [name] => {
                if let Some(database_name) = database.map(str::trim).filter(|value| !value.is_empty())
                {
                    Ok(format!(
                        "{}.{}",
                        quote_clickhouse_identifier(database_name)?,
                        quote_clickhouse_identifier(name)?,
                    ))
                } else {
                    quote_clickhouse_identifier(name)
                }
            }
            _ => Err(anyhow!("Only database.table names are supported for ClickHouse")),
        }
    }

    fn quote_clickhouse_literal(value: &serde_json::Value) -> Result<String> {
        match value {
            serde_json::Value::Null => Ok("NULL".to_string()),
            serde_json::Value::Bool(value) => Ok(if *value { "1" } else { "0" }.to_string()),
            serde_json::Value::Number(value) => Ok(value.to_string()),
            serde_json::Value::String(value) => Ok(format!(
                "'{}'",
                value.replace('\\', "\\\\").replace('\'', "\\'")
            )),
            _ => Err(anyhow!(
                "Only string, number, boolean, and null values are supported"
            )),
        }
    }

    fn append_json_format(sql: &str) -> Result<String> {
        let trimmed = sql.trim().trim_end_matches(';').trim();
        if trimmed.is_empty() {
            return Err(anyhow!("Query cannot be empty"));
        }

        if trimmed.to_ascii_uppercase().contains(" FORMAT ") {
            return Err(anyhow!(
                "Custom FORMAT clauses are not supported yet for ClickHouse query results"
            ));
        }

        Ok(format!("{trimmed} FORMAT JSON"))
    }

    async fn post_query(&self, sql: &str, database: Option<&str>) -> Result<String> {
        let mut request = self
            .client
            .post(&self.base_url)
            .basic_auth(&self.username, Some(&self.password))
            .body(sql.to_string());

        if let Some(database_name) = database.map(str::trim).filter(|value| !value.is_empty()) {
            request = request.query(&[("database", database_name)]);
        }

        let response = request
            .send()
            .await
            .with_context(|| format!("Failed to reach ClickHouse for query: {sql}"))?;
        let status = response.status();
        let body = response
            .text()
            .await
            .context("Failed to read ClickHouse response")?;

        if !status.is_success() {
            bail!(
                "ClickHouse request failed with status {}: {}",
                status.as_u16(),
                body.trim()
            );
        }

        Ok(body)
    }

    async fn query_json(&self, sql: &str, database: Option<&str>) -> Result<ClickHouseJsonResult> {
        let body = self
            .post_query(&Self::append_json_format(sql)?, database)
            .await?;

        serde_json::from_str(&body).context("Failed to parse ClickHouse JSON response")
    }

    fn build_result_from_json(
        result: ClickHouseJsonResult,
        elapsed: u128,
        query: String,
        affected_rows: u64,
        sandboxed: bool,
    ) -> QueryResult {
        let mut truncated = false;
        let columns = result
            .meta
            .iter()
            .map(|column| ColumnInfo {
                name: column.name.clone(),
                data_type: column.data_type.clone(),
                is_nullable: column.data_type.contains("Nullable("),
                is_primary_key: false,
                max_length: None,
                default_value: None,
            })
            .collect::<Vec<_>>();

        let mut rows = Vec::new();
        for row in result.data {
            if rows.len() == MAX_QUERY_RESULT_ROWS {
                truncated = true;
                break;
            }

            rows.push(
                result
                    .meta
                    .iter()
                    .map(|column| row.get(&column.name).cloned().unwrap_or(serde_json::Value::Null))
                    .collect::<Vec<_>>(),
            );
        }

        QueryResult {
            columns,
            rows,
            affected_rows,
            execution_time_ms: elapsed,
            query,
            sandboxed,
            truncated,
        }
    }
}

#[async_trait]
impl DatabaseDriver for ClickHouseDriver {
    async fn ping(&self) -> Result<()> {
        self.post_query("SELECT 1", Some(&self.current_database_name(None)))
            .await
            .context("ClickHouse ping failed")?;
        Ok(())
    }

    async fn disconnect(&self) -> Result<()> {
        Ok(())
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        let result = self
            .query_json("SELECT name FROM system.databases ORDER BY name", None)
            .await?;

        Ok(result
            .data
            .into_iter()
            .map(|row| DatabaseInfo {
                name: row
                    .get("name")
                    .and_then(|value| value.as_str())
                    .unwrap_or("default")
                    .to_string(),
                size: None,
            })
            .collect())
    }

    async fn list_tables(&self, database: Option<&str>) -> Result<Vec<TableInfo>> {
        let db = self.current_database_name(database);
        let sql = format!(
            "SELECT name, engine \
             FROM system.tables \
             WHERE database = '{}' AND is_temporary = 0 \
             ORDER BY name",
            db.replace('\\', "\\\\").replace('\'', "\\'")
        );
        let result = self.query_json(&sql, None).await?;

        Ok(result
            .data
            .into_iter()
            .map(|row| {
                let engine = row
                    .get("engine")
                    .and_then(|value| value.as_str())
                    .unwrap_or("ClickHouse")
                    .to_string();
                TableInfo {
                    name: row
                        .get("name")
                        .and_then(|value| value.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    schema: Some(db.clone()),
                    table_type: if engine.eq_ignore_ascii_case("View")
                        || engine.eq_ignore_ascii_case("MaterializedView")
                    {
                        "VIEW".to_string()
                    } else {
                        "BASE TABLE".to_string()
                    },
                    row_count: None,
                    engine: Some(engine),
                }
            })
            .collect())
    }

    async fn list_schema_objects(
        &self,
        database: Option<&str>,
    ) -> Result<Vec<SchemaObjectInfo>> {
        let db = self.current_database_name(database);
        let sql = format!(
            "SELECT name, engine, create_table_query \
             FROM system.tables \
             WHERE database = '{}' \
               AND engine IN ('View', 'MaterializedView') \
             ORDER BY name",
            db.replace('\\', "\\\\").replace('\'', "\\'")
        );
        let result = self.query_json(&sql, None).await?;

        Ok(result
            .data
            .into_iter()
            .map(|row| {
                let engine = row
                    .get("engine")
                    .and_then(|value| value.as_str())
                    .unwrap_or("VIEW");
                SchemaObjectInfo {
                    name: row
                        .get("name")
                        .and_then(|value| value.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    schema: Some(db.clone()),
                    object_type: if engine.eq_ignore_ascii_case("MaterializedView") {
                        "MATERIALIZED VIEW".to_string()
                    } else {
                        "VIEW".to_string()
                    },
                    related_table: None,
                    definition: row
                        .get("create_table_query")
                        .and_then(|value| value.as_str())
                        .map(str::to_string),
                }
            })
            .collect())
    }

    async fn get_table_structure(
        &self,
        table: &str,
        database: Option<&str>,
    ) -> Result<TableStructure> {
        let db = self.current_database_name(database);
        let escaped_db = db.replace('\\', "\\\\").replace('\'', "\\'");
        let escaped_table = table.trim().replace('\\', "\\\\").replace('\'', "\\'");

        let column_sql = format!(
            "SELECT name, type, default_expression, is_in_primary_key \
             FROM system.columns \
             WHERE database = '{escaped_db}' AND table = '{escaped_table}' \
             ORDER BY position"
        );
        let column_result = self.query_json(&column_sql, None).await?;
        let columns = column_result
            .data
            .into_iter()
            .map(|row| {
                let data_type = row
                    .get("type")
                    .and_then(|value| value.as_str())
                    .unwrap_or("String")
                    .to_string();
                ColumnDetail {
                    name: row
                        .get("name")
                        .and_then(|value| value.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    is_nullable: data_type.contains("Nullable("),
                    is_primary_key: row
                        .get("is_in_primary_key")
                        .and_then(|value| value.as_u64())
                        .unwrap_or(0)
                        > 0,
                    default_value: row
                        .get("default_expression")
                        .and_then(|value| value.as_str())
                        .filter(|value| !value.is_empty())
                        .map(str::to_string),
                    data_type,
                    extra: None,
                    column_type: None,
                    comment: None,
                }
            })
            .collect::<Vec<_>>();

        let object_sql = format!(
            "SELECT engine, create_table_query \
             FROM system.tables \
             WHERE database = '{escaped_db}' AND name = '{escaped_table}' \
             LIMIT 1"
        );
        let object_result = self.query_json(&object_sql, None).await?;
        let object_row = object_result.data.into_iter().next();
        let engine = object_row
            .as_ref()
            .and_then(|row| row.get("engine"))
            .and_then(|value| value.as_str())
            .unwrap_or("MergeTree");
        let object_type = if engine.eq_ignore_ascii_case("View") {
            Some("VIEW".to_string())
        } else if engine.eq_ignore_ascii_case("MaterializedView") {
            Some("MATERIALIZED VIEW".to_string())
        } else {
            Some("TABLE".to_string())
        };
        let view_definition = object_row
            .as_ref()
            .and_then(|row| row.get("create_table_query"))
            .and_then(|value| value.as_str())
            .filter(|_| object_type.as_deref().unwrap_or("TABLE") != "TABLE")
            .map(str::to_string);

        Ok(TableStructure {
            columns,
            indexes: Vec::new(),
            foreign_keys: Vec::new(),
            triggers: Vec::new(),
            view_definition,
            object_type,
        })
    }

    async fn execute_query(&self, sql: &str) -> Result<QueryResult> {
        let start = Instant::now();
        let statements = split_sql_statements(sql);
        let database = self.current_database_name(None);

        if statements.len() <= 1 && Self::query_returns_rows(sql) {
            let result = self.query_json(sql, Some(&database)).await?;
            return Ok(Self::build_result_from_json(
                result,
                start.elapsed().as_millis(),
                sql.to_string(),
                0,
                false,
            ));
        }

        let total_affected = 0u64;
        let mut last_result = None;

        for statement in statements.iter().filter(|statement| !statement.trim().is_empty()) {
            if Self::query_returns_rows(statement) {
                let result = self.query_json(statement, Some(&database)).await?;
                last_result = Some(Self::build_result_from_json(
                    result,
                    0,
                    sql.to_string(),
                    total_affected,
                    false,
                ));
            } else {
                self.post_query(statement, Some(&database)).await?;
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
        let db = self.current_database_name(database);
        let mut sql = format!(
            "SELECT * FROM {}",
            Self::qualify_table_name(table, Some(&db))?
        );

        if let Some(filter_clause) = sanitize_clickhouse_filter_clause(filter)? {
            sql.push_str(&format!(" WHERE {filter_clause}"));
        }

        if let Some(order_by) = order_by {
            let direction = normalize_order_dir(order_dir)?;
            sql.push_str(&format!(
                " ORDER BY {} {}",
                quote_clickhouse_order_by(order_by)?,
                direction
            ));
        }

        sql.push_str(&format!(" LIMIT {limit} OFFSET {offset}"));
        self.execute_query(&sql).await
    }

    async fn count_rows(&self, table: &str, database: Option<&str>) -> Result<i64> {
        let db = self.current_database_name(database);
        let sql = format!(
            "SELECT count() AS count FROM {}",
            Self::qualify_table_name(table, Some(&db))?
        );
        let result = self.query_json(&sql, Some(&db)).await?;
        result
            .data
            .first()
            .and_then(|row| row.get("count"))
            .and_then(|value| value.as_i64())
            .ok_or_else(|| anyhow!("ClickHouse count query returned no rows"))
    }

    async fn count_null_values(
        &self,
        table: &str,
        database: Option<&str>,
        column: &str,
    ) -> Result<i64> {
        let db = self.current_database_name(database);
        let sql = format!(
            "SELECT count() AS count FROM {} WHERE {} IS NULL",
            Self::qualify_table_name(table, Some(&db))?,
            quote_clickhouse_order_by(column)?,
        );
        let result = self.query_json(&sql, Some(&db)).await?;
        result
            .data
            .first()
            .and_then(|row| row.get("count"))
            .and_then(|value| value.as_i64())
            .ok_or_else(|| anyhow!("ClickHouse null-count query returned no rows"))
    }

    async fn update_table_cell(&self, request: &TableCellUpdateRequest) -> Result<u64> {
        if request.primary_keys.is_empty() {
            return Err(anyhow!(
                "Inline update requires at least one primary key column"
            ));
        }

        let db = self.current_database_name(request.database.as_deref());
        let mut where_clause = String::new();
        for (index, primary_key) in request.primary_keys.iter().enumerate() {
            if index > 0 {
                where_clause.push_str(" AND ");
            }

            where_clause.push_str(&quote_clickhouse_order_by(&primary_key.column)?);
            if primary_key.value.is_null() {
                where_clause.push_str(" IS NULL");
            } else {
                where_clause.push_str(" = ");
                where_clause.push_str(&Self::quote_clickhouse_literal(&primary_key.value)?);
            }
        }

        let sql = format!(
            "ALTER TABLE {} UPDATE {} = {} WHERE {}",
            Self::qualify_table_name(&request.table, Some(&db))?,
            quote_clickhouse_order_by(&request.target_column)?,
            Self::quote_clickhouse_literal(&request.value)?,
            where_clause
        );

        self.post_query(&sql, Some(&db)).await?;
        Ok(0)
    }

    async fn delete_table_rows(&self, request: &TableRowDeleteRequest) -> Result<u64> {
        if request.rows.is_empty() {
            return Err(anyhow!(
                "Deleting rows requires at least one selected row"
            ));
        }

        let db = self.current_database_name(request.database.as_deref());
        let mut predicates = Vec::new();

        for row_keys in &request.rows {
            if row_keys.is_empty() {
                return Err(anyhow!(
                    "Each deleted row must include at least one primary key value"
                ));
            }

            let mut conditions = Vec::new();
            for primary_key in row_keys {
                let mut condition = quote_clickhouse_order_by(&primary_key.column)?;
                if primary_key.value.is_null() {
                    condition.push_str(" IS NULL");
                } else {
                    condition.push_str(" = ");
                    condition.push_str(&Self::quote_clickhouse_literal(&primary_key.value)?);
                }
                conditions.push(condition);
            }

            predicates.push(format!("({})", conditions.join(" AND ")));
        }

        let sql = format!(
            "ALTER TABLE {} DELETE WHERE {}",
            Self::qualify_table_name(&request.table, Some(&db))?,
            predicates.join(" OR ")
        );

        self.post_query(&sql, Some(&db)).await?;
        Ok(request.rows.len() as u64)
    }

    async fn use_database(&self, database: &str) -> Result<()> {
        let trimmed = database.trim();
        if trimmed.is_empty() {
            return Err(anyhow!("ClickHouse database name cannot be empty"));
        }

        let mut current = self
            .current_db
            .write()
            .map_err(|_| anyhow!("Failed to access ClickHouse database state"))?;
        *current = Some(trimmed.to_string());
        Ok(())
    }

    fn current_database(&self) -> Option<String> {
        self.current_db.read().ok().and_then(|guard| guard.clone())
    }

    fn driver_name(&self) -> &str {
        "ClickHouse"
    }
}
