use super::driver::DatabaseDriver;
use super::models::*;
use super::query_common::{statement_returns_rows, MAX_QUERY_RESULT_ROWS};
use super::safety::{
    normalize_order_dir, quote_sqlite_identifier, quote_sqlite_order_by,
    sanitize_sqlite_filter_clause,
};
use crate::utils::sql::split_sql_statements;
use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::sync::{Arc, RwLock};
use std::time::Instant;

#[derive(Debug, Deserialize)]
struct CloudflareApiMessage {
    code: i64,
    message: String,
    documentation_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CloudflareEnvelope<T> {
    success: bool,
    #[serde(default)]
    errors: Vec<CloudflareApiMessage>,
    #[serde(default)]
    messages: Vec<CloudflareApiMessage>,
    #[serde(default)]
    result: Vec<T>,
}

#[allow(dead_code)]
#[derive(Debug, Default, Deserialize)]
struct D1StatementMeta {
    changes: Option<f64>,
    duration: Option<f64>,
    last_row_id: Option<f64>,
    rows_read: Option<f64>,
    rows_written: Option<f64>,
    changed_db: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
struct D1RawRows {
    #[serde(default)]
    columns: Vec<String>,
    #[serde(default)]
    rows: Vec<Vec<JsonValue>>,
}

#[derive(Debug, Default, Deserialize)]
struct D1StatementResult {
    #[serde(default)]
    meta: D1StatementMeta,
    #[serde(default)]
    results: D1RawRows,
    success: Option<bool>,
}

#[derive(Debug, Serialize)]
struct D1SingleQueryPayload<'a> {
    sql: &'a str,
}

pub struct CloudflareD1Driver {
    client: Client,
    raw_url: String,
    api_token: String,
    current_db: Arc<RwLock<Option<String>>>,
}

impl CloudflareD1Driver {
    pub async fn connect(config: &ConnectionConfig) -> Result<Self> {
        let raw_url = Self::build_raw_url(config)?;
        let api_token = config
            .password
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .context("Cloudflare API token is required")?
            .to_string();
        let current_db = config
            .name
            .trim()
            .is_empty()
            .then(|| {
                config
                    .additional_fields
                    .get("database_id")
                    .map(String::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
            })
            .flatten()
            .or_else(|| {
                let trimmed_name = config.name.trim();
                (!trimmed_name.is_empty()).then(|| trimmed_name.to_string())
            })
            .or_else(|| Some("Cloudflare D1".to_string()));

        let driver = Self {
            client: Client::builder()
                .build()
                .context("Failed to initialize Cloudflare D1 HTTP client")?,
            raw_url,
            api_token,
            current_db: Arc::new(RwLock::new(current_db)),
        };

        driver.ping().await?;
        Ok(driver)
    }

    fn build_raw_url(config: &ConnectionConfig) -> Result<String> {
        let account_id = config
            .additional_fields
            .get("account_id")
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .context("Cloudflare account ID is required")?;
        let database_id = config
            .additional_fields
            .get("database_id")
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .context("Cloudflare D1 database ID is required")?;

        let raw_host = config
            .host
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("api.cloudflare.com");
        let host = if raw_host.contains(':') && !raw_host.starts_with('[') {
            format!("[{raw_host}]")
        } else {
            raw_host.to_string()
        };

        let mut base_url = format!("https://{host}");
        if let Some(port) = config.port.filter(|value| *value > 0 && *value != 443) {
            base_url.push(':');
            base_url.push_str(&port.to_string());
        }

        Ok(format!(
            "{base_url}/client/v4/accounts/{account_id}/d1/database/{database_id}/raw"
        ))
    }

    fn query_returns_rows(sql: &str) -> bool {
        statement_returns_rows(sql, &["SELECT", "PRAGMA", "EXPLAIN", "WITH"])
    }

    fn current_database_name(&self) -> String {
        self.current_db
            .read()
            .ok()
            .and_then(|guard| guard.clone())
            .unwrap_or_else(|| "Cloudflare D1".to_string())
    }

    async fn execute_raw_statement(&self, sql: &str) -> Result<D1StatementResult> {
        let response = self
            .client
            .post(&self.raw_url)
            .bearer_auth(&self.api_token)
            .json(&D1SingleQueryPayload { sql })
            .send()
            .await
            .with_context(|| format!("Failed to reach Cloudflare D1 for query: {sql}"))?;

        let status = response.status();
        let body = response
            .text()
            .await
            .context("Failed to read Cloudflare D1 response body")?;

        let parsed = serde_json::from_str::<CloudflareEnvelope<D1StatementResult>>(&body)
            .context("Failed to parse Cloudflare D1 response")?;

        if !status.is_success() || !parsed.success || !parsed.errors.is_empty() {
            let message = parsed
                .errors
                .first()
                .map(|error| {
                    if let Some(url) = error.documentation_url.as_deref() {
                        format!("Cloudflare D1 API error {}: {} ({url})", error.code, error.message)
                    } else {
                        format!("Cloudflare D1 API error {}: {}", error.code, error.message)
                    }
                })
                .or_else(|| {
                    parsed
                        .messages
                        .first()
                        .map(|message| format!("Cloudflare D1 API message {}: {}", message.code, message.message))
                })
                .unwrap_or_else(|| format!("Cloudflare D1 request failed with status {}", status));
            return Err(anyhow!(message));
        }

        let statement = parsed
            .result
            .into_iter()
            .next()
            .ok_or_else(|| anyhow!("Cloudflare D1 did not return a statement result"))?;

        if statement.success == Some(false) {
            return Err(anyhow!("Cloudflare D1 reported an unsuccessful statement"));
        }

        Ok(statement)
    }

    fn affected_rows(meta: &D1StatementMeta) -> u64 {
        meta.changes
            .and_then(|value| {
                if value.is_finite() && value >= 0.0 {
                    Some(value as u64)
                } else {
                    None
                }
            })
            .unwrap_or(0)
    }

    fn execution_time_ms(meta: &D1StatementMeta, elapsed: u128) -> u128 {
        meta.duration
            .and_then(|value| {
                if value.is_finite() && value >= 0.0 {
                    Some(value as u128)
                } else {
                    None
                }
            })
            .unwrap_or(elapsed)
    }

    fn statement_to_query_result(
        statement: D1StatementResult,
        query: String,
        elapsed: u128,
    ) -> QueryResult {
        let row_count = statement.results.rows.len();
        let truncated = row_count > MAX_QUERY_RESULT_ROWS;
        let rows = statement
            .results
            .rows
            .into_iter()
            .take(MAX_QUERY_RESULT_ROWS)
            .collect::<Vec<_>>();

        QueryResult {
            columns: statement
                .results
                .columns
                .into_iter()
                .map(|name| ColumnInfo {
                    name,
                    data_type: "unknown".to_string(),
                    is_nullable: true,
                    is_primary_key: false,
                    max_length: None,
                    default_value: None,
                })
                .collect(),
            rows,
            affected_rows: Self::affected_rows(&statement.meta),
            execution_time_ms: Self::execution_time_ms(&statement.meta, elapsed),
            query,
            sandboxed: false,
            truncated,
        }
    }

    async fn raw_rows_to_objects(&self, sql: &str) -> Result<Vec<JsonMap<String, JsonValue>>> {
        let statement = self.execute_raw_statement(sql).await?;
        Ok(statement
            .results
            .rows
            .into_iter()
            .map(|row| {
                statement
                    .results
                    .columns
                    .iter()
                    .cloned()
                    .zip(row.into_iter())
                    .collect::<JsonMap<String, JsonValue>>()
            })
            .collect::<Vec<_>>())
    }

    fn sqlite_literal(value: &JsonValue) -> Result<String> {
        match value {
            JsonValue::Null => Ok("NULL".to_string()),
            JsonValue::Bool(value) => Ok(if *value { "1" } else { "0" }.to_string()),
            JsonValue::Number(value) => Ok(value.to_string()),
            JsonValue::String(value) => Ok(format!("'{}'", value.replace('\'', "''"))),
            JsonValue::Array(_) | JsonValue::Object(_) => {
                let serialized =
                    serde_json::to_string(value).context("Failed to serialize JSON value")?;
                Ok(format!("'{}'", serialized.replace('\'', "''")))
            }
        }
    }

    fn scalar_i64(result: &QueryResult) -> Result<i64> {
        let value = result
            .rows
            .first()
            .and_then(|row| row.first())
            .ok_or_else(|| anyhow!("Expected a scalar value"))?;

        value
            .as_i64()
            .or_else(|| value.as_u64().and_then(|raw| i64::try_from(raw).ok()))
            .or_else(|| value.as_f64().map(|raw| raw as i64))
            .or_else(|| value.as_str().and_then(|raw| raw.parse::<i64>().ok()))
            .ok_or_else(|| anyhow!("Expected a numeric scalar value"))
    }
}

#[async_trait]
impl DatabaseDriver for CloudflareD1Driver {
    async fn ping(&self) -> Result<()> {
        self.execute_raw_statement("SELECT 1").await?;
        Ok(())
    }

    async fn disconnect(&self) -> Result<()> {
        Ok(())
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        Ok(vec![DatabaseInfo {
            name: self.current_database_name(),
            size: None,
        }])
    }

    async fn list_tables(&self, _database: Option<&str>) -> Result<Vec<TableInfo>> {
        let rows = self
            .raw_rows_to_objects(
                "SELECT name, type FROM sqlite_master \
                 WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' \
                 ORDER BY name",
            )
            .await?;

        Ok(rows
            .into_iter()
            .map(|row| TableInfo {
                name: row
                    .get("name")
                    .and_then(JsonValue::as_str)
                    .unwrap_or("unnamed")
                    .to_string(),
                table_type: row
                    .get("type")
                    .and_then(JsonValue::as_str)
                    .unwrap_or("table")
                    .to_ascii_uppercase(),
                schema: None,
                row_count: None,
                engine: Some("Cloudflare D1".to_string()),
            })
            .collect())
    }

    async fn list_schema_objects(&self, _database: Option<&str>) -> Result<Vec<SchemaObjectInfo>> {
        let rows = self
            .raw_rows_to_objects(
                "SELECT name, type, tbl_name, sql \
                 FROM sqlite_master \
                 WHERE type IN ('view', 'trigger') AND name NOT LIKE 'sqlite_%' \
                 ORDER BY type, name",
            )
            .await?;

        Ok(rows
            .into_iter()
            .map(|row| SchemaObjectInfo {
                name: row
                    .get("name")
                    .and_then(JsonValue::as_str)
                    .unwrap_or("unnamed")
                    .to_string(),
                schema: None,
                object_type: row
                    .get("type")
                    .and_then(JsonValue::as_str)
                    .unwrap_or("object")
                    .to_ascii_uppercase(),
                related_table: row
                    .get("tbl_name")
                    .and_then(JsonValue::as_str)
                    .map(str::to_string),
                definition: row
                    .get("sql")
                    .and_then(JsonValue::as_str)
                    .map(str::to_string),
            })
            .collect())
    }

    async fn get_table_structure(
        &self,
        table: &str,
        _database: Option<&str>,
    ) -> Result<TableStructure> {
        let quoted_table = quote_sqlite_identifier(table)?;
        let col_rows = self
            .raw_rows_to_objects(&format!("PRAGMA table_info({quoted_table})"))
            .await?;

        let columns = col_rows
            .iter()
            .map(|row| ColumnDetail {
                name: row
                    .get("name")
                    .and_then(JsonValue::as_str)
                    .unwrap_or("column")
                    .to_string(),
                data_type: row
                    .get("type")
                    .and_then(JsonValue::as_str)
                    .unwrap_or("TEXT")
                    .to_string(),
                is_nullable: row
                    .get("notnull")
                    .and_then(JsonValue::as_i64)
                    .unwrap_or(0)
                    == 0,
                default_value: row
                    .get("dflt_value")
                    .and_then(JsonValue::as_str)
                    .map(str::to_string),
                is_primary_key: row.get("pk").and_then(JsonValue::as_i64).unwrap_or(0) > 0,
                extra: None,
                column_type: None,
                comment: None,
            })
            .collect::<Vec<_>>();

        let idx_rows = self
            .raw_rows_to_objects(&format!("PRAGMA index_list({quoted_table})"))
            .await?;

        let mut indexes = Vec::new();
        for row in idx_rows {
            let index_name = row
                .get("name")
                .and_then(JsonValue::as_str)
                .unwrap_or("unnamed_index")
                .to_string();
            let idx_info_rows = self
                .raw_rows_to_objects(&format!(
                    "PRAGMA index_info({})",
                    quote_sqlite_identifier(&index_name)?
                ))
                .await?;
            indexes.push(IndexInfo {
                name: index_name,
                columns: idx_info_rows
                    .into_iter()
                    .filter_map(|entry| {
                        entry.get("name").and_then(JsonValue::as_str).map(str::to_string)
                    })
                    .collect::<Vec<_>>(),
                is_unique: row.get("unique").and_then(JsonValue::as_i64).unwrap_or(0) == 1,
                index_type: None,
            });
        }

        let fk_rows = self
            .raw_rows_to_objects(&format!("PRAGMA foreign_key_list({quoted_table})"))
            .await?;
        let foreign_keys = fk_rows
            .into_iter()
            .map(|row| ForeignKeyInfo {
                name: format!("fk_{}", row.get("id").and_then(JsonValue::as_i64).unwrap_or(0)),
                column: row
                    .get("from")
                    .and_then(JsonValue::as_str)
                    .unwrap_or("")
                    .to_string(),
                referenced_table: row
                    .get("table")
                    .and_then(JsonValue::as_str)
                    .unwrap_or("")
                    .to_string(),
                referenced_column: row
                    .get("to")
                    .and_then(JsonValue::as_str)
                    .unwrap_or("")
                    .to_string(),
                on_update: row
                    .get("on_update")
                    .and_then(JsonValue::as_str)
                    .map(str::to_string),
                on_delete: row
                    .get("on_delete")
                    .and_then(JsonValue::as_str)
                    .map(str::to_string),
            })
            .collect::<Vec<_>>();

        let object_type_rows = self
            .raw_rows_to_objects(&format!(
                "SELECT type FROM sqlite_master WHERE name = {} AND type IN ('table', 'view') LIMIT 1",
                Self::sqlite_literal(&JsonValue::String(table.to_string()))?
            ))
            .await?;
        let object_type = object_type_rows
            .first()
            .and_then(|row| row.get("type"))
            .and_then(JsonValue::as_str)
            .map(|value| value.to_ascii_uppercase());

        let view_rows = self
            .raw_rows_to_objects(&format!(
                "SELECT sql FROM sqlite_master WHERE type = 'view' AND name = {} LIMIT 1",
                Self::sqlite_literal(&JsonValue::String(table.to_string()))?
            ))
            .await?;
        let view_definition = view_rows
            .first()
            .and_then(|row| row.get("sql"))
            .and_then(JsonValue::as_str)
            .map(str::to_string);

        let trigger_rows = self
            .raw_rows_to_objects(&format!(
                "SELECT name, tbl_name, sql \
                 FROM sqlite_master \
                 WHERE type = 'trigger' AND tbl_name = {} \
                 ORDER BY name",
                Self::sqlite_literal(&JsonValue::String(table.to_string()))?
            ))
            .await?;
        let triggers = trigger_rows
            .into_iter()
            .map(|row| TriggerInfo {
                name: row
                    .get("name")
                    .and_then(JsonValue::as_str)
                    .unwrap_or("trigger")
                    .to_string(),
                timing: None,
                event: None,
                related_table: row
                    .get("tbl_name")
                    .and_then(JsonValue::as_str)
                    .map(str::to_string),
                definition: row
                    .get("sql")
                    .and_then(JsonValue::as_str)
                    .map(str::to_string),
            })
            .collect::<Vec<_>>();

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
        let started_at = Instant::now();
        let statements = split_sql_statements(sql);

        if statements.len() <= 1 && Self::query_returns_rows(sql) {
            let statement = self.execute_raw_statement(sql).await?;
            return Ok(Self::statement_to_query_result(
                statement,
                sql.to_string(),
                started_at.elapsed().as_millis(),
            ));
        }

        let mut total_affected = 0u64;
        let mut last_result = None;

        for statement in statements.iter().filter(|statement| !statement.trim().is_empty()) {
            let result = self.execute_raw_statement(statement).await?;
            total_affected += Self::affected_rows(&result.meta);

            if Self::query_returns_rows(statement) {
                last_result = Some(Self::statement_to_query_result(
                    result,
                    sql.to_string(),
                    0,
                ));
            }
        }

        let elapsed = started_at.elapsed().as_millis();
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
        _database: Option<&str>,
        offset: u64,
        limit: u64,
        order_by: Option<&str>,
        order_dir: Option<&str>,
        filter: Option<&str>,
    ) -> Result<QueryResult> {
        let mut sql = format!("SELECT * FROM {}", quote_sqlite_identifier(table)?);
        if let Some(filter_clause) = sanitize_sqlite_filter_clause(filter)? {
            sql.push_str(&format!(" WHERE {filter_clause}"));
        }
        if let Some(order_column) = order_by {
            let direction = normalize_order_dir(order_dir)?;
            sql.push_str(&format!(
                " ORDER BY {} {}",
                quote_sqlite_order_by(order_column)?,
                direction
            ));
        }
        sql.push_str(&format!(" LIMIT {} OFFSET {}", limit, offset));

        self.execute_query(&sql).await
    }

    async fn count_rows(&self, table: &str, _database: Option<&str>) -> Result<i64> {
        let sql = format!("SELECT COUNT(*) FROM {}", quote_sqlite_identifier(table)?);
        let result = self.execute_query(&sql).await?;
        Self::scalar_i64(&result)
    }

    async fn count_null_values(
        &self,
        table: &str,
        _database: Option<&str>,
        column: &str,
    ) -> Result<i64> {
        let sql = format!(
            "SELECT COUNT(*) FROM {} WHERE {} IS NULL",
            quote_sqlite_identifier(table)?,
            quote_sqlite_order_by(column)?,
        );
        let result = self.execute_query(&sql).await?;
        Self::scalar_i64(&result)
    }

    async fn update_table_cell(&self, request: &TableCellUpdateRequest) -> Result<u64> {
        if request.primary_keys.is_empty() {
            return Err(anyhow!("Inline update requires at least one primary key column"));
        }

        let mut sql = format!(
            "UPDATE {} SET {} = {} WHERE ",
            quote_sqlite_identifier(&request.table)?,
            quote_sqlite_order_by(&request.target_column)?,
            Self::sqlite_literal(&request.value)?,
        );

        for (index, primary_key) in request.primary_keys.iter().enumerate() {
            if index > 0 {
                sql.push_str(" AND ");
            }
            sql.push_str(&quote_sqlite_order_by(&primary_key.column)?);
            if primary_key.value.is_null() {
                sql.push_str(" IS NULL");
            } else {
                sql.push_str(" = ");
                sql.push_str(&Self::sqlite_literal(&primary_key.value)?);
            }
        }

        let result = self.execute_raw_statement(&sql).await?;
        Ok(Self::affected_rows(&result.meta))
    }

    async fn delete_table_rows(&self, request: &TableRowDeleteRequest) -> Result<u64> {
        if request.rows.is_empty() {
            return Err(anyhow!("Deleting rows requires at least one selected row"));
        }

        let mut total_affected = 0u64;
        for row_keys in &request.rows {
            if row_keys.is_empty() {
                return Err(anyhow!(
                    "Each deleted row must include at least one primary key value"
                ));
            }

            let mut sql = format!("DELETE FROM {} WHERE ", quote_sqlite_identifier(&request.table)?);
            for (index, primary_key) in row_keys.iter().enumerate() {
                if index > 0 {
                    sql.push_str(" AND ");
                }
                sql.push_str(&quote_sqlite_order_by(&primary_key.column)?);
                if primary_key.value.is_null() {
                    sql.push_str(" IS NULL");
                } else {
                    sql.push_str(" = ");
                    sql.push_str(&Self::sqlite_literal(&primary_key.value)?);
                }
            }

            let result = self.execute_raw_statement(&sql).await?;
            total_affected += Self::affected_rows(&result.meta);
        }

        Ok(total_affected)
    }

    async fn insert_table_row(&self, request: &TableRowInsertRequest) -> Result<u64> {
        if request.values.is_empty() {
            return Err(anyhow!("Insert requires at least one column value"));
        }

        let columns = request
            .values
            .iter()
            .map(|(column, _)| quote_sqlite_identifier(column))
            .collect::<Result<Vec<_>>>()?;
        let values = request
            .values
            .iter()
            .map(|(_, value)| Self::sqlite_literal(value))
            .collect::<Result<Vec<_>>>()?;

        let sql = format!(
            "INSERT INTO {} ({}) VALUES ({})",
            quote_sqlite_identifier(&request.table)?,
            columns.join(", "),
            values.join(", "),
        );

        let result = self.execute_raw_statement(&sql).await?;
        Ok(Self::affected_rows(&result.meta))
    }

    async fn execute_structure_statements(&self, statements: &[String]) -> Result<u64> {
        let mut total_affected = 0u64;
        for statement in statements.iter().filter(|statement| !statement.trim().is_empty()) {
            let result = self.execute_raw_statement(statement).await?;
            total_affected += Self::affected_rows(&result.meta);
        }
        Ok(total_affected)
    }

    async fn use_database(&self, database: &str) -> Result<()> {
        let trimmed = database.trim();
        if trimmed.is_empty() {
            return Ok(());
        }

        if let Ok(mut guard) = self.current_db.write() {
            *guard = Some(trimmed.to_string());
        }

        Ok(())
    }

    async fn get_foreign_key_lookup_values(
        &self,
        referenced_table: &str,
        referenced_column: &str,
        display_columns: &[&str],
        search: Option<&str>,
        limit: u32,
    ) -> Result<Vec<LookupValue>> {
        let label_expr = if !display_columns.is_empty() {
            let cols = display_columns
                .iter()
                .map(|column| format!("\"{}\"", column))
                .collect::<Vec<_>>()
                .join(", ");
            format!("COALESCE({cols})")
        } else {
            format!("\"{}\"", referenced_column)
        };

        let sql = if let Some(search_term) = search {
            let like_pattern = format!("%{}%", search_term);
            format!(
                "SELECT \"{}\" AS value, {} AS label \
                 FROM \"{}\" \
                 WHERE CAST(\"{}\" AS TEXT) LIKE {} \
                 ORDER BY \"{}\" \
                 LIMIT {}",
                referenced_column,
                label_expr,
                referenced_table,
                referenced_column,
                Self::sqlite_literal(&JsonValue::String(like_pattern))?,
                referenced_column,
                limit
            )
        } else {
            format!(
                "SELECT \"{}\" AS value, {} AS label \
                 FROM \"{}\" \
                 ORDER BY \"{}\" \
                 LIMIT {}",
                referenced_column,
                label_expr,
                referenced_table,
                referenced_column,
                limit
            )
        };

        let result = self.execute_query(&sql).await?;
        Ok(result
            .rows
            .into_iter()
            .map(|row| LookupValue {
                value: row.first().cloned().unwrap_or(JsonValue::Null),
                label: row
                    .get(1)
                    .map(ToString::to_string)
                    .unwrap_or_else(|| row.first().map(ToString::to_string).unwrap_or_default()),
            })
            .collect())
    }

    fn current_database(&self) -> Option<String> {
        Some(self.current_database_name())
    }

    fn driver_name(&self) -> &str {
        "Cloudflare D1"
    }
}

#[cfg(test)]
mod tests {
    use super::CloudflareD1Driver;
    use serde_json::json;

    #[test]
    fn serializes_json_values_for_sqlite_literals() {
        assert_eq!(CloudflareD1Driver::sqlite_literal(&json!(null)).unwrap(), "NULL");
        assert_eq!(CloudflareD1Driver::sqlite_literal(&json!(true)).unwrap(), "1");
        assert_eq!(
            CloudflareD1Driver::sqlite_literal(&json!("O'Reilly")).unwrap(),
            "'O''Reilly'"
        );
        assert_eq!(
            CloudflareD1Driver::sqlite_literal(&json!({"id": 1})).unwrap(),
            "'{\"id\":1}'"
        );
    }
}
