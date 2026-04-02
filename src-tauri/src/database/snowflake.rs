use super::driver::DatabaseDriver;
use super::models::*;
use super::query_common::{statement_returns_rows, MAX_QUERY_RESULT_ROWS};
use super::safety::{
    normalize_order_dir, quote_snowflake_identifier, quote_snowflake_order_by,
    sanitize_snowflake_filter_clause,
};
use crate::utils::sql::split_sql_statements;
use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{Number as JsonNumber, Value as JsonValue};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::RwLock;
use tokio::time::{sleep, Duration};

const SNOWFLAKE_QUERY_TIMEOUT_SECS: u64 = 45;
const SNOWFLAKE_POLL_INTERVAL_MS: u64 = 300;
const SNOWFLAKE_POLL_ATTEMPTS: usize = 400;
const SNOWFLAKE_USER_AGENT: &str = "TableR/0.1";

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnowflakeQueryStatus {
    code: Option<String>,
    sql_state: Option<String>,
    message: Option<String>,
    statement_handle: Option<String>,
    statement_status_url: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnowflakePartitionInfo {}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnowflakeRowType {
    name: String,
    #[serde(rename = "type")]
    data_type: String,
    length: Option<u64>,
    precision: Option<i64>,
    scale: Option<i64>,
    nullable: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnowflakeStatementStats {
    num_rows_inserted: Option<u64>,
    num_rows_updated: Option<u64>,
    num_rows_deleted: Option<u64>,
    num_duplicate_rows_updated: Option<u64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnowflakeResultSetMetaData {
    num_rows: Option<u64>,
    #[serde(default)]
    row_type: Vec<SnowflakeRowType>,
    #[serde(default)]
    partition_info: Vec<SnowflakePartitionInfo>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnowflakeResultSet {
    code: Option<String>,
    sql_state: Option<String>,
    message: Option<String>,
    statement_handle: Option<String>,
    result_set_meta_data: Option<SnowflakeResultSetMetaData>,
    #[serde(default)]
    data: Vec<Vec<JsonValue>>,
    stats: Option<SnowflakeStatementStats>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "snake_case")]
struct SnowflakeStatementParameters {
    rows_per_resultset: usize,
    date_output_format: &'static str,
    time_output_format: &'static str,
    timestamp_ltz_output_format: &'static str,
    timestamp_ntz_output_format: &'static str,
    timestamp_tz_output_format: &'static str,
    timezone: &'static str,
    use_cached_result: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct SnowflakeStatementRequest {
    statement: String,
    timeout: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    database: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    schema: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    warehouse: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    role: Option<String>,
    parameters: SnowflakeStatementParameters,
}

#[derive(Debug, Clone, Default)]
struct SnowflakeStatementContext {
    database: Option<String>,
    schema: Option<String>,
    warehouse: Option<String>,
    role: Option<String>,
}

#[derive(Debug, Clone)]
struct SnowflakeTableReference {
    database: String,
    schema: String,
    table: String,
}

enum SnowflakeApiResponse {
    Ready(SnowflakeResultSet),
    Pending(SnowflakeQueryStatus),
}

pub struct SnowflakeDriver {
    client: Client,
    root_url: String,
    statements_url: String,
    access_token: String,
    current_db: Arc<RwLock<Option<String>>>,
    current_schema: Arc<RwLock<Option<String>>>,
    warehouse: Option<String>,
    role: Option<String>,
}

impl SnowflakeDriver {
    pub async fn connect(config: &ConnectionConfig) -> Result<Self> {
        let (root_url, statements_url) = Self::build_urls(config)?;
        let access_token = config
            .password
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .context("Snowflake auth token is required")?
            .to_string();

        let driver = Self {
            client: Client::builder()
                .build()
                .context("Failed to initialize Snowflake HTTP client")?,
            root_url,
            statements_url,
            access_token,
            current_db: Arc::new(RwLock::new(
                config
                    .database
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string),
            )),
            current_schema: Arc::new(RwLock::new(
                config
                    .additional_fields
                    .get("schema")
                    .map(String::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string),
            )),
            warehouse: config
                .additional_fields
                .get("warehouse")
                .map(String::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
            role: config
                .additional_fields
                .get("role")
                .map(String::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
        };

        driver.ping().await?;
        driver.refresh_session_namespace().await?;
        Ok(driver)
    }

    fn build_urls(config: &ConnectionConfig) -> Result<(String, String)> {
        let raw_host = config
            .host
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .context("Snowflake account host is required")?;
        let host = if raw_host.contains(':') && !raw_host.starts_with('[') {
            format!("[{raw_host}]")
        } else {
            raw_host.to_string()
        };
        let port_suffix = match config.port.filter(|value| *value > 0 && *value != 443) {
            Some(port) => format!(":{port}"),
            None => String::new(),
        };
        let root_url = format!("https://{host}{port_suffix}");
        let statements_url = format!("{root_url}/api/v2/statements");
        Ok((root_url, statements_url))
    }

    fn query_returns_rows(sql: &str) -> bool {
        statement_returns_rows(sql, &["SELECT", "SHOW", "DESCRIBE", "EXPLAIN", "WITH"])
    }

    fn current_database_name(&self) -> Option<String> {
        self.current_db.try_read().ok().and_then(|guard| guard.clone())
    }

    fn current_schema_name(&self) -> Option<String> {
        self.current_schema
            .try_read()
            .ok()
            .and_then(|guard| guard.clone())
    }

    fn resolve_database_name(&self, database: Option<&str>) -> Result<String> {
        database
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| self.current_database_name())
            .ok_or_else(|| anyhow!("A Snowflake database must be selected first"))
    }

    fn build_statement_context(&self, database_override: Option<&str>) -> SnowflakeStatementContext {
        SnowflakeStatementContext {
            database: database_override
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .or_else(|| self.current_database_name()),
            schema: self.current_schema_name(),
            warehouse: self.warehouse.clone(),
            role: self.role.clone(),
        }
    }

    fn build_statement_request(
        &self,
        statement: &str,
        database_override: Option<&str>,
    ) -> SnowflakeStatementRequest {
        let context = self.build_statement_context(database_override);
        SnowflakeStatementRequest {
            statement: statement.trim().to_string(),
            timeout: SNOWFLAKE_QUERY_TIMEOUT_SECS,
            database: context.database,
            schema: context.schema,
            warehouse: context.warehouse,
            role: context.role,
            parameters: SnowflakeStatementParameters {
                rows_per_resultset: MAX_QUERY_RESULT_ROWS + 1,
                date_output_format: "YYYY-MM-DD",
                time_output_format: "HH24:MI:SS.FF3",
                timestamp_ltz_output_format: "YYYY-MM-DD HH24:MI:SS.FF3 TZHTZM",
                timestamp_ntz_output_format: "YYYY-MM-DD HH24:MI:SS.FF3",
                timestamp_tz_output_format: "YYYY-MM-DD HH24:MI:SS.FF3 TZHTZM",
                timezone: "UTC",
                use_cached_result: true,
            },
        }
    }

    fn apply_common_headers(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        request
            .bearer_auth(&self.access_token)
            .header("Accept", "application/json")
            .header("User-Agent", SNOWFLAKE_USER_AGENT)
    }

    fn build_status_url_from_handle(&self, handle: &str) -> String {
        format!(
            "{}/api/v2/statements/{}",
            self.root_url.trim_end_matches('/'),
            handle
        )
    }

    fn normalize_status_url(&self, raw_url: &str) -> String {
        let trimmed = raw_url.trim();
        if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
            trimmed.to_string()
        } else if trimmed.starts_with('/') {
            format!("{}{}", self.root_url.trim_end_matches('/'), trimmed)
        } else {
            format!("{}/{}", self.root_url.trim_end_matches('/'), trimmed)
        }
    }

    fn format_status_message(status: &SnowflakeQueryStatus) -> Option<String> {
        let code = status.code.as_deref().unwrap_or("").trim();
        let sql_state = status.sql_state.as_deref().unwrap_or("").trim();
        let message = status.message.as_deref().unwrap_or("").trim();

        if code.is_empty() && sql_state.is_empty() && message.is_empty() {
            return None;
        }

        Some(match (code.is_empty(), sql_state.is_empty(), message.is_empty()) {
            (false, false, false) => format!("{code} ({sql_state}): {message}"),
            (false, true, false) => format!("{code}: {message}"),
            (true, false, false) => format!("{sql_state}: {message}"),
            (_, _, false) => message.to_string(),
            (false, false, true) => format!("{code} ({sql_state})"),
            (false, true, true) => code.to_string(),
            (true, false, true) => sql_state.to_string(),
            (true, true, true) => String::new(),
        })
    }

    fn format_api_error(status: u16, body: &str) -> String {
        if let Ok(parsed) = serde_json::from_str::<SnowflakeQueryStatus>(body) {
            if let Some(message) = Self::format_status_message(&parsed) {
                return format!("Snowflake API error {status}: {message}");
            }
        }

        if let Ok(parsed) = serde_json::from_str::<SnowflakeResultSet>(body) {
            let message = parsed
                .message
                .or_else(|| parsed.code.clone())
                .unwrap_or_else(|| "Snowflake request failed".to_string());
            let code = parsed.code.unwrap_or_else(|| status.to_string());
            let sql_state = parsed.sql_state.unwrap_or_default();
            if sql_state.trim().is_empty() {
                return format!("Snowflake API error {code}: {message}");
            }
            return format!("Snowflake API error {code} ({sql_state}): {message}");
        }

        let trimmed = body.trim();
        if trimmed.is_empty() {
            format!("Snowflake API request failed with status {status}")
        } else {
            format!("Snowflake API request failed with status {status}: {trimmed}")
        }
    }

    async fn parse_api_response(
        status: StatusCode,
        body: String,
    ) -> Result<SnowflakeApiResponse> {
        match status {
            StatusCode::OK => {
                let parsed = serde_json::from_str::<SnowflakeResultSet>(&body).with_context(|| {
                    format!(
                        "Failed to parse Snowflake response payload: {}",
                        body.chars().take(240).collect::<String>()
                    )
                })?;
                Ok(SnowflakeApiResponse::Ready(parsed))
            }
            StatusCode::ACCEPTED | StatusCode::TOO_MANY_REQUESTS => {
                let parsed =
                    serde_json::from_str::<SnowflakeQueryStatus>(&body).with_context(|| {
                        format!(
                            "Failed to parse Snowflake pending response payload: {}",
                            body.chars().take(240).collect::<String>()
                        )
                    })?;
                Ok(SnowflakeApiResponse::Pending(parsed))
            }
            _ => bail!("{}", Self::format_api_error(status.as_u16(), &body)),
        }
    }

    async fn post_statement(
        &self,
        statement: &str,
        database_override: Option<&str>,
    ) -> Result<SnowflakeApiResponse> {
        let request = self.build_statement_request(statement, database_override);
        let response = self
            .apply_common_headers(self.client.post(&self.statements_url))
            .json(&request)
            .send()
            .await
            .with_context(|| format!("Failed to reach Snowflake for query: {statement}"))?;
        let status = response.status();
        let body = response
            .text()
            .await
            .context("Failed to read Snowflake response body")?;
        Self::parse_api_response(status, body).await
    }

    async fn get_statement_status(
        &self,
        status_url: &str,
        partition: Option<usize>,
    ) -> Result<SnowflakeApiResponse> {
        let url = self.normalize_status_url(status_url);
        let mut request = self.apply_common_headers(self.client.get(url.clone()));
        if let Some(partition) = partition {
            request = request.query(&[("partition", partition.to_string())]);
        }

        let response = request
            .send()
            .await
            .with_context(|| format!("Failed to reach Snowflake statement status endpoint {url}"))?;
        let status = response.status();
        let body = response
            .text()
            .await
            .context("Failed to read Snowflake statement status response")?;
        Self::parse_api_response(status, body).await
    }

    async fn await_result_set(&self, initial: SnowflakeApiResponse) -> Result<SnowflakeResultSet> {
        match initial {
            SnowflakeApiResponse::Ready(result_set) => Ok(result_set),
            SnowflakeApiResponse::Pending(mut status) => {
                for _ in 0..SNOWFLAKE_POLL_ATTEMPTS {
                    let status_url = status
                        .statement_status_url
                        .clone()
                        .map(|value| self.normalize_status_url(&value))
                        .or_else(|| {
                            status
                                .statement_handle
                                .as_deref()
                                .map(|handle| self.build_status_url_from_handle(handle))
                        })
                        .ok_or_else(|| {
                            anyhow!(
                                "Snowflake reported a pending statement but did not include a handle"
                            )
                        })?;

                    sleep(Duration::from_millis(SNOWFLAKE_POLL_INTERVAL_MS)).await;
                    match self.get_statement_status(&status_url, None).await? {
                        SnowflakeApiResponse::Ready(result_set) => return Ok(result_set),
                        SnowflakeApiResponse::Pending(next_status) => status = next_status,
                    }
                }

                let message = Self::format_status_message(&status)
                    .unwrap_or_else(|| "Snowflake query is still pending".to_string());
                Err(anyhow!(
                    "Snowflake query did not finish within the expected polling window: {message}"
                ))
            }
        }
    }

    async fn fetch_partition(
        &self,
        handle: &str,
        partition: usize,
    ) -> Result<SnowflakeResultSet> {
        let status_url = self.build_status_url_from_handle(handle);
        self.await_result_set(self.get_statement_status(&status_url, Some(partition)).await?)
            .await
    }

    fn affected_rows(stats: Option<&SnowflakeStatementStats>) -> u64 {
        stats.map_or(0, |stats| {
            stats.num_rows_inserted.unwrap_or(0)
                + stats.num_rows_updated.unwrap_or(0)
                + stats.num_rows_deleted.unwrap_or(0)
                + stats.num_duplicate_rows_updated.unwrap_or(0)
        })
    }

    fn row_type_to_column_info(row_type: &SnowflakeRowType) -> ColumnInfo {
        ColumnInfo {
            name: row_type.name.clone(),
            data_type: Self::display_data_type(row_type),
            is_nullable: row_type.nullable.unwrap_or(true),
            is_primary_key: false,
            max_length: row_type.length.and_then(|value| u32::try_from(value).ok()),
            default_value: None,
        }
    }

    fn display_data_type(row_type: &SnowflakeRowType) -> String {
        let normalized = row_type.data_type.trim().to_ascii_uppercase();
        match normalized.as_str() {
            "FIXED" => match (row_type.precision, row_type.scale) {
                (Some(precision), Some(scale)) => format!("NUMBER({precision}, {scale})"),
                (Some(precision), None) => format!("NUMBER({precision})"),
                _ => "NUMBER".to_string(),
            },
            "REAL" => "FLOAT".to_string(),
            "TEXT" => row_type
                .length
                .map(|length| format!("TEXT({length})"))
                .unwrap_or_else(|| "TEXT".to_string()),
            other => other.to_string(),
        }
    }

    fn row_types_from_result_set(result_set: &SnowflakeResultSet) -> Vec<SnowflakeRowType> {
        result_set
            .result_set_meta_data
            .as_ref()
            .map(|metadata| metadata.row_type.clone())
            .unwrap_or_default()
    }

    fn total_rows_hint(result_set: &SnowflakeResultSet) -> Option<usize> {
        result_set
            .result_set_meta_data
            .as_ref()
            .and_then(|metadata| metadata.num_rows)
            .and_then(|value| usize::try_from(value).ok())
    }

    fn partition_count(result_set: &SnowflakeResultSet) -> usize {
        result_set
            .result_set_meta_data
            .as_ref()
            .map(|metadata| {
                if metadata.partition_info.is_empty() {
                    1
                } else {
                    metadata.partition_info.len()
                }
            })
            .unwrap_or(1)
    }

    fn cell_to_json(cell: &JsonValue, row_type: &SnowflakeRowType) -> JsonValue {
        match cell {
            JsonValue::Null => JsonValue::Null,
            JsonValue::Bool(_) | JsonValue::Number(_) => cell.clone(),
            JsonValue::Array(_) | JsonValue::Object(_) => cell.clone(),
            JsonValue::String(raw) => {
                let kind = row_type.data_type.trim().to_ascii_uppercase();
                match kind.as_str() {
                    "FIXED" => {
                        if row_type.scale.unwrap_or(0) == 0 {
                            raw.parse::<i64>()
                                .map(JsonValue::from)
                                .unwrap_or_else(|_| JsonValue::String(raw.to_string()))
                        } else {
                            raw.parse::<f64>()
                                .ok()
                                .and_then(JsonNumber::from_f64)
                                .map(JsonValue::Number)
                                .unwrap_or_else(|| JsonValue::String(raw.to_string()))
                        }
                    }
                    "REAL" => raw
                        .parse::<f64>()
                        .ok()
                        .and_then(JsonNumber::from_f64)
                        .map(JsonValue::Number)
                        .unwrap_or_else(|| JsonValue::String(raw.to_string())),
                    "BOOLEAN" => match raw.to_ascii_lowercase().as_str() {
                        "true" | "1" => JsonValue::Bool(true),
                        "false" | "0" => JsonValue::Bool(false),
                        _ => JsonValue::String(raw.to_string()),
                    },
                    "ARRAY" | "OBJECT" | "VARIANT" => serde_json::from_str::<JsonValue>(raw)
                        .unwrap_or_else(|_| JsonValue::String(raw.to_string())),
                    _ => JsonValue::String(raw.to_string()),
                }
            }
        }
    }

    fn rows_to_json(rows: Vec<Vec<JsonValue>>, row_types: &[SnowflakeRowType]) -> Vec<Vec<JsonValue>> {
        rows.into_iter()
            .map(|row| {
                if row_types.is_empty() {
                    return row;
                }

                row.into_iter()
                    .enumerate()
                    .map(|(index, cell)| {
                        row_types
                            .get(index)
                            .map(|row_type| Self::cell_to_json(&cell, row_type))
                            .unwrap_or(cell)
                    })
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>()
    }

    async fn execute_single_query(
        &self,
        sql: &str,
        database_override: Option<&str>,
        preserve_query_text: &str,
    ) -> Result<QueryResult> {
        let trimmed_sql = sql.trim();
        if trimmed_sql.is_empty() {
            return Err(anyhow!("Snowflake query cannot be empty"));
        }

        let started_at = Instant::now();
        let result_set =
            self.await_result_set(self.post_statement(trimmed_sql, database_override).await?)
                .await?;
        let row_types = Self::row_types_from_result_set(&result_set);
        let mut raw_rows = result_set.data.clone();
        let mut truncated = Self::total_rows_hint(&result_set)
            .map(|value| value > MAX_QUERY_RESULT_ROWS)
            .unwrap_or(false);

        let partition_count = Self::partition_count(&result_set);
        if raw_rows.len() <= MAX_QUERY_RESULT_ROWS && partition_count > 1 {
            if let Some(handle) = result_set.statement_handle.clone() {
                for partition in 1..partition_count {
                    let partition_result = self.fetch_partition(&handle, partition).await?;
                    raw_rows.extend(partition_result.data);
                    if raw_rows.len() > MAX_QUERY_RESULT_ROWS {
                        truncated = true;
                        break;
                    }
                }
            } else {
                truncated = true;
            }
        } else if raw_rows.len() > MAX_QUERY_RESULT_ROWS {
            truncated = true;
        }

        let rows = Self::rows_to_json(
            raw_rows.into_iter().take(MAX_QUERY_RESULT_ROWS).collect(),
            &row_types,
        );
        let columns = if row_types.is_empty() {
            rows.first()
                .map(|row| {
                    row.iter()
                        .enumerate()
                        .map(|(index, _)| ColumnInfo {
                            name: format!("column_{}", index + 1),
                            data_type: "TEXT".to_string(),
                            is_nullable: true,
                            is_primary_key: false,
                            max_length: None,
                            default_value: None,
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        } else {
            row_types
                .iter()
                .map(Self::row_type_to_column_info)
                .collect::<Vec<_>>()
        };

        Ok(QueryResult {
            columns,
            rows,
            affected_rows: Self::affected_rows(result_set.stats.as_ref()),
            execution_time_ms: started_at.elapsed().as_millis(),
            query: preserve_query_text.to_string(),
            sandboxed: false,
            truncated,
        })
    }

    fn info_schema_relation(database: &str, relation: &str) -> Result<String> {
        Ok(format!(
            "{}.{}.{}",
            quote_snowflake_identifier(database)?,
            quote_snowflake_identifier("INFORMATION_SCHEMA")?,
            quote_snowflake_identifier(relation)?,
        ))
    }

    fn sql_string_literal(value: &str) -> String {
        format!("'{}'", value.replace('\'', "''"))
    }

    fn quote_sql_literal(value: &JsonValue) -> Result<String> {
        match value {
            JsonValue::Null => Ok("NULL".to_string()),
            JsonValue::Bool(value) => Ok(if *value {
                "TRUE".to_string()
            } else {
                "FALSE".to_string()
            }),
            JsonValue::Number(value) => Ok(value.to_string()),
            JsonValue::String(value) => Ok(Self::sql_string_literal(value)),
            JsonValue::Array(_) | JsonValue::Object(_) => {
                let serialized =
                    serde_json::to_string(value).context("Failed to serialize JSON value")?;
                Ok(format!("PARSE_JSON({})", Self::sql_string_literal(&serialized)))
            }
        }
    }

    fn parse_table_reference(
        &self,
        table: &str,
        database_override: Option<&str>,
    ) -> Result<SnowflakeTableReference> {
        let parts = table
            .trim()
            .split('.')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>();

        let default_database = database_override
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| self.current_database_name());
        let default_schema = self.current_schema_name().or_else(|| Some("PUBLIC".to_string()));

        match parts.as_slice() {
            [table_name] => Ok(SnowflakeTableReference {
                database: default_database
                    .ok_or_else(|| anyhow!("A Snowflake database must be selected first"))?,
                schema: default_schema
                    .ok_or_else(|| anyhow!("A Snowflake schema must be selected first"))?,
                table: table_name.clone(),
            }),
            [schema_name, table_name] => Ok(SnowflakeTableReference {
                database: default_database
                    .ok_or_else(|| anyhow!("A Snowflake database must be selected first"))?,
                schema: schema_name.clone(),
                table: table_name.clone(),
            }),
            [database_name, schema_name, table_name] => Ok(SnowflakeTableReference {
                database: database_name.clone(),
                schema: schema_name.clone(),
                table: table_name.clone(),
            }),
            _ => Err(anyhow!(
                "Snowflake tables must be referenced as table, schema.table, or database.schema.table"
            )),
        }
    }

    fn qualify_table_name(table: &SnowflakeTableReference) -> Result<String> {
        Ok(format!(
            "{}.{}.{}",
            quote_snowflake_identifier(&table.database)?,
            quote_snowflake_identifier(&table.schema)?,
            quote_snowflake_identifier(&table.table)?,
        ))
    }

    fn build_where_clause(primary_keys: &[RowKeyValue]) -> Result<String> {
        if primary_keys.is_empty() {
            return Err(anyhow!(
                "Snowflake row editing requires at least one row selector column"
            ));
        }

        Ok(primary_keys
            .iter()
            .map(|primary_key| {
                if primary_key.value.is_null() {
                    Ok(format!(
                        "{} IS NULL",
                        quote_snowflake_order_by(&primary_key.column)?,
                    ))
                } else {
                    Ok(format!(
                        "{} = {}",
                        quote_snowflake_order_by(&primary_key.column)?,
                        Self::quote_sql_literal(&primary_key.value)?,
                    ))
                }
            })
            .collect::<Result<Vec<_>>>()?
            .join(" AND "))
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

    fn column_index(columns: &[ColumnInfo], names: &[&str]) -> Option<usize> {
        columns.iter().position(|column| {
            names
                .iter()
                .any(|candidate| column.name.eq_ignore_ascii_case(candidate))
        })
    }

    fn cell_as_string(
        row: &[JsonValue],
        columns: &[ColumnInfo],
        names: &[&str],
    ) -> Option<String> {
        let index = Self::column_index(columns, names)?;
        let value = row.get(index)?;
        match value {
            JsonValue::Null => None,
            JsonValue::String(value) => Some(value.clone()),
            JsonValue::Number(value) => Some(value.to_string()),
            JsonValue::Bool(value) => Some(value.to_string()),
            other => Some(other.to_string()),
        }
    }

    fn object_type_from_table_type(table_type: &str) -> String {
        let normalized = table_type.trim().to_ascii_uppercase();
        if normalized.is_empty() {
            "TABLE".to_string()
        } else {
            normalized
        }
    }

    async fn refresh_session_namespace(&self) -> Result<()> {
        let sql = "SELECT CURRENT_DATABASE() AS current_database, CURRENT_SCHEMA() AS current_schema";
        let result = self.execute_single_query(sql, None, sql).await?;
        let Some(row) = result.rows.first() else {
            return Ok(());
        };

        let database = Self::cell_as_string(row, &result.columns, &["current_database"]);
        let schema = Self::cell_as_string(row, &result.columns, &["current_schema"]);

        let mut current_db = self.current_db.write().await;
        *current_db = database;
        drop(current_db);

        let mut current_schema = self.current_schema.write().await;
        *current_schema = schema;
        Ok(())
    }

    async fn find_database_name(&self, database: &str) -> Result<String> {
        let sql = format!(
            "SHOW TERSE DATABASES LIKE {}",
            Self::sql_string_literal(database.trim())
        );
        let result = self.execute_single_query(&sql, None, &sql).await?;

        result
            .rows
            .iter()
            .find_map(|row| Self::cell_as_string(row, &result.columns, &["name"]))
            .ok_or_else(|| anyhow!("Snowflake database '{}' was not found or is not accessible", database))
    }

    async fn first_schema_in_database(&self, database: &str) -> Result<Option<String>> {
        let sql = format!(
            "SELECT SCHEMA_NAME AS schema_name \
             FROM {} \
             WHERE SCHEMA_NAME <> 'INFORMATION_SCHEMA' \
             ORDER BY SCHEMA_NAME \
             LIMIT 1",
            Self::info_schema_relation(database, "SCHEMATA")?,
        );
        let result = self.execute_single_query(&sql, Some(database), &sql).await?;
        Ok(result
            .rows
            .iter()
            .find_map(|row| Self::cell_as_string(row, &result.columns, &["schema_name"])))
    }

    fn lookup_label_expression(display_columns: &[&str], referenced_column: &str) -> Result<String> {
        let expression_parts = if display_columns.is_empty() {
            vec![format!(
                "COALESCE(TO_VARCHAR({}), '')",
                quote_snowflake_order_by(referenced_column)?,
            )]
        } else {
            display_columns
                .iter()
                .map(|column| {
                    Ok(format!(
                        "COALESCE(TO_VARCHAR({}), '')",
                        quote_snowflake_order_by(column)?,
                    ))
                })
                .collect::<Result<Vec<_>>>()?
        };

        Ok(expression_parts.join(" || ' ' || "))
    }
}

#[async_trait]
impl DatabaseDriver for SnowflakeDriver {
    async fn ping(&self) -> Result<()> {
        let result = self
            .execute_single_query("SELECT 1 AS ok", None, "SELECT 1 AS ok")
            .await
            .context("Snowflake ping failed")?;
        let _ = Self::scalar_i64(&result)?;
        Ok(())
    }

    async fn disconnect(&self) -> Result<()> {
        Ok(())
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        let sql = "SHOW TERSE DATABASES";
        let result = self.execute_single_query(sql, None, sql).await?;
        let mut databases = result
            .rows
            .iter()
            .filter_map(|row| Self::cell_as_string(row, &result.columns, &["name"]))
            .map(|name| DatabaseInfo { name, size: None })
            .collect::<Vec<_>>();
        databases.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(databases)
    }

    async fn list_tables(&self, database: Option<&str>) -> Result<Vec<TableInfo>> {
        let database_name = self.resolve_database_name(database)?;
        let sql = format!(
            "SELECT TABLE_SCHEMA AS schema_name, TABLE_NAME AS table_name, TABLE_TYPE AS table_type \
             FROM {} \
             WHERE TABLE_SCHEMA <> 'INFORMATION_SCHEMA' \
             ORDER BY TABLE_SCHEMA, TABLE_NAME",
            Self::info_schema_relation(&database_name, "TABLES")?,
        );
        let result = self
            .execute_single_query(&sql, Some(&database_name), &sql)
            .await?;

        Ok(result
            .rows
            .iter()
            .map(|row| TableInfo {
                name: Self::cell_as_string(row, &result.columns, &["table_name"])
                    .unwrap_or_else(|| "table".to_string()),
                schema: Self::cell_as_string(row, &result.columns, &["schema_name"]),
                table_type: Self::cell_as_string(row, &result.columns, &["table_type"])
                    .map(|value| Self::object_type_from_table_type(&value))
                    .unwrap_or_else(|| "TABLE".to_string()),
                row_count: None,
                engine: Some("Snowflake".to_string()),
            })
            .collect())
    }

    async fn list_schema_objects(&self, database: Option<&str>) -> Result<Vec<SchemaObjectInfo>> {
        let database_name = self.resolve_database_name(database)?;
        let views_sql = format!(
            "SELECT TABLE_SCHEMA AS schema_name, TABLE_NAME AS object_name, VIEW_DEFINITION AS definition \
             FROM {} \
             WHERE TABLE_SCHEMA <> 'INFORMATION_SCHEMA' \
             ORDER BY TABLE_SCHEMA, TABLE_NAME",
            Self::info_schema_relation(&database_name, "VIEWS")?,
        );
        let views_result = self
            .execute_single_query(&views_sql, Some(&database_name), &views_sql)
            .await?;

        let mut objects = views_result
            .rows
            .iter()
            .map(|row| SchemaObjectInfo {
                name: Self::cell_as_string(row, &views_result.columns, &["object_name"])
                    .unwrap_or_else(|| "view".to_string()),
                schema: Self::cell_as_string(row, &views_result.columns, &["schema_name"]),
                object_type: "VIEW".to_string(),
                related_table: None,
                definition: Self::cell_as_string(row, &views_result.columns, &["definition"]),
            })
            .collect::<Vec<_>>();

        let materialized_sql = format!(
            "SELECT TABLE_SCHEMA AS schema_name, TABLE_NAME AS object_name, TABLE_TYPE AS object_type \
             FROM {} \
             WHERE TABLE_TYPE = 'MATERIALIZED VIEW' \
               AND TABLE_SCHEMA <> 'INFORMATION_SCHEMA' \
             ORDER BY TABLE_SCHEMA, TABLE_NAME",
            Self::info_schema_relation(&database_name, "TABLES")?,
        );
        let materialized_result = self
            .execute_single_query(&materialized_sql, Some(&database_name), &materialized_sql)
            .await?;
        objects.extend(materialized_result.rows.iter().map(|row| SchemaObjectInfo {
            name: Self::cell_as_string(row, &materialized_result.columns, &["object_name"])
                .unwrap_or_else(|| "materialized_view".to_string()),
            schema: Self::cell_as_string(row, &materialized_result.columns, &["schema_name"]),
            object_type: Self::cell_as_string(row, &materialized_result.columns, &["object_type"])
                .map(|value| value.to_ascii_uppercase())
                .unwrap_or_else(|| "MATERIALIZED VIEW".to_string()),
            related_table: None,
            definition: None,
        }));

        let routines_sql = format!(
            "SELECT ROUTINE_SCHEMA AS schema_name, ROUTINE_NAME AS object_name, ROUTINE_TYPE AS object_type, ROUTINE_DEFINITION AS definition \
             FROM {} \
             WHERE ROUTINE_SCHEMA <> 'INFORMATION_SCHEMA' \
             ORDER BY ROUTINE_SCHEMA, ROUTINE_NAME",
            Self::info_schema_relation(&database_name, "ROUTINES")?,
        );
        if let Ok(routines_result) = self
            .execute_single_query(&routines_sql, Some(&database_name), &routines_sql)
            .await
        {
            objects.extend(routines_result.rows.iter().map(|row| SchemaObjectInfo {
                name: Self::cell_as_string(row, &routines_result.columns, &["object_name"])
                    .unwrap_or_else(|| "routine".to_string()),
                schema: Self::cell_as_string(row, &routines_result.columns, &["schema_name"]),
                object_type: Self::cell_as_string(
                    row,
                    &routines_result.columns,
                    &["object_type"],
                )
                .map(|value| value.to_ascii_uppercase())
                .unwrap_or_else(|| "ROUTINE".to_string()),
                related_table: None,
                definition: Self::cell_as_string(row, &routines_result.columns, &["definition"]),
            }));
        }

        objects.sort_by(|left, right| {
            left.schema
                .cmp(&right.schema)
                .then(left.name.cmp(&right.name))
        });
        Ok(objects)
    }

    async fn get_table_structure(
        &self,
        table: &str,
        database: Option<&str>,
    ) -> Result<TableStructure> {
        let table_reference = self.parse_table_reference(table, database)?;
        let database_name = table_reference.database.clone();
        let schema_literal = Self::sql_string_literal(&table_reference.schema);
        let table_literal = Self::sql_string_literal(&table_reference.table);

        let columns_sql = format!(
            "SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type, IS_NULLABLE AS is_nullable, COLUMN_DEFAULT AS column_default, COMMENT AS comment \
             FROM {} \
             WHERE TABLE_SCHEMA ILIKE {} AND TABLE_NAME ILIKE {} \
             ORDER BY ORDINAL_POSITION",
            Self::info_schema_relation(&database_name, "COLUMNS")?,
            schema_literal,
            table_literal,
        );
        let columns_result = self
            .execute_single_query(&columns_sql, Some(&database_name), &columns_sql)
            .await?;

        let primary_keys_sql = format!(
            "SELECT kcu.COLUMN_NAME AS column_name \
             FROM {} tc \
             JOIN {} kcu \
               ON tc.CONSTRAINT_CATALOG = kcu.CONSTRAINT_CATALOG \
              AND tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA \
              AND tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME \
             WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' \
               AND tc.TABLE_SCHEMA ILIKE {} \
               AND tc.TABLE_NAME ILIKE {} \
             ORDER BY kcu.ORDINAL_POSITION",
            Self::info_schema_relation(&database_name, "TABLE_CONSTRAINTS")?,
            Self::info_schema_relation(&database_name, "KEY_COLUMN_USAGE")?,
            schema_literal,
            table_literal,
        );
        let primary_keys_result = self
            .execute_single_query(&primary_keys_sql, Some(&database_name), &primary_keys_sql)
            .await?;
        let primary_keys = primary_keys_result
            .rows
            .iter()
            .filter_map(|row| {
                Self::cell_as_string(row, &primary_keys_result.columns, &["column_name"])
            })
            .collect::<HashSet<_>>();

        let columns = columns_result
            .rows
            .iter()
            .map(|row| {
                let column_name =
                    Self::cell_as_string(row, &columns_result.columns, &["column_name"])
                        .unwrap_or_else(|| "column".to_string());
                let is_nullable = Self::cell_as_string(
                    row,
                    &columns_result.columns,
                    &["is_nullable"],
                )
                .map(|value| value.eq_ignore_ascii_case("YES"))
                .unwrap_or(true);
                let data_type = Self::cell_as_string(row, &columns_result.columns, &["data_type"])
                    .unwrap_or_else(|| "TEXT".to_string());

                ColumnDetail {
                    name: column_name.clone(),
                    data_type: data_type.clone(),
                    is_nullable,
                    is_primary_key: primary_keys.contains(&column_name),
                    default_value: Self::cell_as_string(
                        row,
                        &columns_result.columns,
                        &["column_default"],
                    ),
                    extra: None,
                    column_type: Some(data_type),
                    comment: Self::cell_as_string(row, &columns_result.columns, &["comment"]),
                }
            })
            .collect::<Vec<_>>();

        let foreign_keys_sql = format!(
            "SELECT \
                kcu.CONSTRAINT_NAME AS constraint_name, \
                kcu.COLUMN_NAME AS column_name, \
                ccu.TABLE_SCHEMA AS referenced_schema, \
                ccu.TABLE_NAME AS referenced_table, \
                ccu.COLUMN_NAME AS referenced_column, \
                rc.UPDATE_RULE AS update_rule, \
                rc.DELETE_RULE AS delete_rule \
             FROM {} tc \
             JOIN {} kcu \
               ON tc.CONSTRAINT_CATALOG = kcu.CONSTRAINT_CATALOG \
              AND tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA \
              AND tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME \
             JOIN {} rc \
               ON tc.CONSTRAINT_CATALOG = rc.CONSTRAINT_CATALOG \
              AND tc.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA \
              AND tc.CONSTRAINT_NAME = rc.CONSTRAINT_NAME \
             JOIN {} ccu \
               ON rc.UNIQUE_CONSTRAINT_CATALOG = ccu.CONSTRAINT_CATALOG \
              AND rc.UNIQUE_CONSTRAINT_SCHEMA = ccu.CONSTRAINT_SCHEMA \
              AND rc.UNIQUE_CONSTRAINT_NAME = ccu.CONSTRAINT_NAME \
              AND COALESCE(ccu.ORDINAL_POSITION, 0) = COALESCE(kcu.POSITION_IN_UNIQUE_CONSTRAINT, ccu.ORDINAL_POSITION, 0) \
             WHERE tc.CONSTRAINT_TYPE = 'FOREIGN KEY' \
               AND tc.TABLE_SCHEMA ILIKE {} \
               AND tc.TABLE_NAME ILIKE {} \
             ORDER BY kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION",
            Self::info_schema_relation(&database_name, "TABLE_CONSTRAINTS")?,
            Self::info_schema_relation(&database_name, "KEY_COLUMN_USAGE")?,
            Self::info_schema_relation(&database_name, "REFERENTIAL_CONSTRAINTS")?,
            Self::info_schema_relation(&database_name, "KEY_COLUMN_USAGE")?,
            schema_literal,
            table_literal,
        );
        let foreign_keys = match self
            .execute_single_query(&foreign_keys_sql, Some(&database_name), &foreign_keys_sql)
            .await
        {
            Ok(result) => result
                .rows
                .iter()
                .map(|row| {
                    let referenced_schema =
                        Self::cell_as_string(row, &result.columns, &["referenced_schema"]);
                    let referenced_table = Self::cell_as_string(
                        row,
                        &result.columns,
                        &["referenced_table"],
                    )
                    .unwrap_or_default();
                    ForeignKeyInfo {
                        name: Self::cell_as_string(row, &result.columns, &["constraint_name"])
                            .unwrap_or_else(|| "fk".to_string()),
                        column: Self::cell_as_string(row, &result.columns, &["column_name"])
                            .unwrap_or_default(),
                        referenced_table: referenced_schema
                            .filter(|schema| !schema.is_empty())
                            .map(|schema| format!("{schema}.{referenced_table}"))
                            .unwrap_or(referenced_table),
                        referenced_column: Self::cell_as_string(
                            row,
                            &result.columns,
                            &["referenced_column"],
                        )
                        .unwrap_or_default(),
                        on_update: Self::cell_as_string(row, &result.columns, &["update_rule"]),
                        on_delete: Self::cell_as_string(row, &result.columns, &["delete_rule"]),
                    }
                })
                .collect::<Vec<_>>(),
            Err(_) => Vec::new(),
        };

        let object_sql = format!(
            "SELECT TABLE_TYPE AS table_type \
             FROM {} \
             WHERE TABLE_SCHEMA ILIKE {} AND TABLE_NAME ILIKE {} \
             LIMIT 1",
            Self::info_schema_relation(&database_name, "TABLES")?,
            schema_literal,
            table_literal,
        );
        let object_result = self
            .execute_single_query(&object_sql, Some(&database_name), &object_sql)
            .await?;
        let object_type = object_result
            .rows
            .first()
            .and_then(|row| Self::cell_as_string(row, &object_result.columns, &["table_type"]))
            .map(|value| Self::object_type_from_table_type(&value));

        let view_definition = if object_type.as_deref() == Some("VIEW") {
            let view_sql = format!(
                "SELECT VIEW_DEFINITION AS definition \
                 FROM {} \
                 WHERE TABLE_SCHEMA ILIKE {} AND TABLE_NAME ILIKE {} \
                 LIMIT 1",
                Self::info_schema_relation(&database_name, "VIEWS")?,
                schema_literal,
                table_literal,
            );
            self.execute_single_query(&view_sql, Some(&database_name), &view_sql)
                .await
                .ok()
                .and_then(|result| {
                    result.rows.first().and_then(|row| {
                        Self::cell_as_string(row, &result.columns, &["definition"])
                    })
                })
        } else {
            None
        };

        Ok(TableStructure {
            columns,
            indexes: Vec::new(),
            foreign_keys,
            triggers: Vec::new(),
            view_definition,
            object_type,
        })
    }

    async fn execute_query(&self, sql: &str) -> Result<QueryResult> {
        let started_at = Instant::now();
        let statements = split_sql_statements(sql);

        if statements.len() <= 1 {
            return self.execute_single_query(sql, None, sql).await;
        }

        let mut total_affected = 0u64;
        let mut last_result = None;

        for statement in statements.iter().filter(|statement| !statement.trim().is_empty()) {
            let result = self.execute_single_query(statement, None, sql).await?;
            total_affected += result.affected_rows;

            if Self::query_returns_rows(statement) || !result.rows.is_empty() {
                last_result = Some(result);
            }
        }

        if let Some(mut result) = last_result {
            result.execution_time_ms = started_at.elapsed().as_millis();
            result.affected_rows = total_affected;
            return Ok(result);
        }

        Ok(QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            affected_rows: total_affected,
            execution_time_ms: started_at.elapsed().as_millis(),
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
        let table_reference = self.parse_table_reference(table, database)?;
        let database_name = table_reference.database.clone();
        let mut sql = format!("SELECT * FROM {}", Self::qualify_table_name(&table_reference)?);

        if let Some(filter_clause) = sanitize_snowflake_filter_clause(filter)? {
            sql.push_str(&format!(" WHERE {filter_clause}"));
        }

        if let Some(order_column) = order_by {
            let direction = normalize_order_dir(order_dir)?;
            sql.push_str(&format!(
                " ORDER BY {} {}",
                quote_snowflake_order_by(order_column)?,
                direction
            ));
        }

        sql.push_str(&format!(" LIMIT {limit} OFFSET {offset}"));
        self.execute_single_query(&sql, Some(&database_name), &sql).await
    }

    async fn count_rows(&self, table: &str, database: Option<&str>) -> Result<i64> {
        let table_reference = self.parse_table_reference(table, database)?;
        let database_name = table_reference.database.clone();
        let sql = format!(
            "SELECT COUNT(*) AS count FROM {}",
            Self::qualify_table_name(&table_reference)?,
        );
        let result = self
            .execute_single_query(&sql, Some(&database_name), &sql)
            .await?;
        Self::scalar_i64(&result)
    }

    async fn count_null_values(
        &self,
        table: &str,
        database: Option<&str>,
        column: &str,
    ) -> Result<i64> {
        let table_reference = self.parse_table_reference(table, database)?;
        let database_name = table_reference.database.clone();
        let sql = format!(
            "SELECT COUNT(*) AS count FROM {} WHERE {} IS NULL",
            Self::qualify_table_name(&table_reference)?,
            quote_snowflake_order_by(column)?,
        );
        let result = self
            .execute_single_query(&sql, Some(&database_name), &sql)
            .await?;
        Self::scalar_i64(&result)
    }

    async fn update_table_cell(&self, request: &TableCellUpdateRequest) -> Result<u64> {
        if request.primary_keys.is_empty() {
            return Err(anyhow!(
                "Inline update requires at least one primary key column"
            ));
        }

        let table_reference =
            self.parse_table_reference(&request.table, request.database.as_deref())?;
        let database_name = table_reference.database.clone();
        let sql = format!(
            "UPDATE {} SET {} = {} WHERE {}",
            Self::qualify_table_name(&table_reference)?,
            quote_snowflake_order_by(&request.target_column)?,
            Self::quote_sql_literal(&request.value)?,
            Self::build_where_clause(&request.primary_keys)?,
        );
        let result = self
            .execute_single_query(&sql, Some(&database_name), &sql)
            .await?;
        Ok(result.affected_rows)
    }

    async fn delete_table_rows(&self, request: &TableRowDeleteRequest) -> Result<u64> {
        if request.rows.is_empty() {
            return Err(anyhow!("Deleting rows requires at least one selected row"));
        }

        let table_reference =
            self.parse_table_reference(&request.table, request.database.as_deref())?;
        let database_name = table_reference.database.clone();
        let predicates = request
            .rows
            .iter()
            .map(|row_keys| {
                if row_keys.is_empty() {
                    return Err(anyhow!(
                        "Each deleted row must include at least one primary key value"
                    ));
                }

                Ok(format!("({})", Self::build_where_clause(row_keys)?))
            })
            .collect::<Result<Vec<_>>>()?;

        let sql = format!(
            "DELETE FROM {} WHERE {}",
            Self::qualify_table_name(&table_reference)?,
            predicates.join(" OR "),
        );
        let result = self
            .execute_single_query(&sql, Some(&database_name), &sql)
            .await?;
        Ok(result.affected_rows)
    }

    async fn insert_table_row(&self, request: &TableRowInsertRequest) -> Result<u64> {
        if request.values.is_empty() {
            return Err(anyhow!("Insert requires at least one column value"));
        }

        let table_reference =
            self.parse_table_reference(&request.table, request.database.as_deref())?;
        let database_name = table_reference.database.clone();
        let columns = request
            .values
            .iter()
            .map(|(column, _)| quote_snowflake_identifier(column))
            .collect::<Result<Vec<_>>>()?;
        let values = request
            .values
            .iter()
            .map(|(_, value)| Self::quote_sql_literal(value))
            .collect::<Result<Vec<_>>>()?;

        let sql = format!(
            "INSERT INTO {} ({}) VALUES ({})",
            Self::qualify_table_name(&table_reference)?,
            columns.join(", "),
            values.join(", "),
        );
        let result = self
            .execute_single_query(&sql, Some(&database_name), &sql)
            .await?;
        Ok(result.affected_rows)
    }

    async fn use_database(&self, database: &str) -> Result<()> {
        let trimmed = database.trim();
        if trimmed.is_empty() {
            return Err(anyhow!("Snowflake database name cannot be empty"));
        }

        let resolved_database = self.find_database_name(trimmed).await?;
        let default_schema = self.first_schema_in_database(&resolved_database).await.ok().flatten();

        let mut current_db = self.current_db.write().await;
        *current_db = Some(resolved_database);
        drop(current_db);

        let mut current_schema = self.current_schema.write().await;
        *current_schema = default_schema;
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
        let table_reference = self.parse_table_reference(referenced_table, None)?;
        let database_name = table_reference.database.clone();
        let value_expr = quote_snowflake_order_by(referenced_column)?;
        let label_expr = Self::lookup_label_expression(display_columns, referenced_column)?;

        let mut sql = format!(
            "SELECT {} AS value, {} AS label FROM {}",
            value_expr,
            label_expr,
            Self::qualify_table_name(&table_reference)?,
        );

        if let Some(search_term) = search.map(str::trim).filter(|value| !value.is_empty()) {
            sql.push_str(&format!(
                " WHERE TO_VARCHAR({}) ILIKE {}",
                value_expr,
                Self::sql_string_literal(&format!("%{search_term}%")),
            ));
        }

        sql.push_str(&format!(" ORDER BY {} LIMIT {}", value_expr, limit));
        let result = self
            .execute_single_query(&sql, Some(&database_name), &sql)
            .await?;

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
        self.current_database_name()
    }

    fn driver_name(&self) -> &str {
        "Snowflake"
    }
}

#[cfg(test)]
mod tests {
    use super::SnowflakeDriver;
    use serde_json::json;

    #[test]
    fn serializes_variant_values_for_sql_literals() {
        assert_eq!(SnowflakeDriver::quote_sql_literal(&json!(null)).unwrap(), "NULL");
        assert_eq!(SnowflakeDriver::quote_sql_literal(&json!(true)).unwrap(), "TRUE");
        assert_eq!(
            SnowflakeDriver::quote_sql_literal(&json!("O'Reilly")).unwrap(),
            "'O''Reilly'"
        );
        assert_eq!(
            SnowflakeDriver::quote_sql_literal(&json!({"id": 1})).unwrap(),
            "PARSE_JSON('{\"id\":1}')"
        );
    }
}
