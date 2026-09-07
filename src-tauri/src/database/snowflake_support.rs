use super::models::*;
use super::query_common::MAX_QUERY_RESULT_ROWS;
use super::safety::{quote_snowflake_identifier, quote_snowflake_order_by};
use super::snowflake::{SnowflakeDriver, SNOWFLAKE_POLL_ATTEMPTS, SNOWFLAKE_POLL_INTERVAL_MS};
use anyhow::{anyhow, bail, Context, Result};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{Number as JsonNumber, Value as JsonValue};
use std::time::Instant;
use tokio::time::{sleep, Duration};

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SnowflakeQueryStatus {
    pub(super) code: Option<String>,
    pub(super) sql_state: Option<String>,
    pub(super) message: Option<String>,
    pub(super) statement_handle: Option<String>,
    pub(super) statement_status_url: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SnowflakePartitionInfo {}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SnowflakeRowType {
    pub(super) name: String,
    #[serde(rename = "type")]
    pub(super) data_type: String,
    pub(super) length: Option<u64>,
    pub(super) precision: Option<i64>,
    pub(super) scale: Option<i64>,
    pub(super) nullable: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SnowflakeStatementStats {
    pub(super) num_rows_inserted: Option<u64>,
    pub(super) num_rows_updated: Option<u64>,
    pub(super) num_rows_deleted: Option<u64>,
    pub(super) num_duplicate_rows_updated: Option<u64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SnowflakeResultSetMetaData {
    pub(super) num_rows: Option<u64>,
    #[serde(default)]
    pub(super) row_type: Vec<SnowflakeRowType>,
    #[serde(default)]
    pub(super) partition_info: Vec<SnowflakePartitionInfo>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SnowflakeResultSet {
    pub(super) code: Option<String>,
    pub(super) sql_state: Option<String>,
    pub(super) message: Option<String>,
    pub(super) statement_handle: Option<String>,
    pub(super) result_set_meta_data: Option<SnowflakeResultSetMetaData>,
    #[serde(default)]
    pub(super) data: Vec<Vec<JsonValue>>,
    pub(super) stats: Option<SnowflakeStatementStats>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) struct SnowflakeStatementParameters {
    pub(super) rows_per_resultset: usize,
    pub(super) date_output_format: &'static str,
    pub(super) time_output_format: &'static str,
    pub(super) timestamp_ltz_output_format: &'static str,
    pub(super) timestamp_ntz_output_format: &'static str,
    pub(super) timestamp_tz_output_format: &'static str,
    pub(super) timezone: &'static str,
    pub(super) use_cached_result: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SnowflakeStatementRequest {
    pub(super) statement: String,
    pub(super) timeout: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) database: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) schema: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) warehouse: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) role: Option<String>,
    pub(super) parameters: SnowflakeStatementParameters,
}

#[derive(Debug, Clone, Default)]
pub(super) struct SnowflakeStatementContext {
    pub(super) database: Option<String>,
    pub(super) schema: Option<String>,
    pub(super) warehouse: Option<String>,
    pub(super) role: Option<String>,
}

#[derive(Debug, Clone)]
pub(super) struct SnowflakeTableReference {
    pub(super) database: String,
    pub(super) schema: String,
    pub(super) table: String,
}

pub(super) enum SnowflakeApiResponse {
    Ready(SnowflakeResultSet),
    Pending(SnowflakeQueryStatus),
}

/// HTTP statement machinery, response conversion, and SQL literal helpers for
/// the Snowflake driver, split into a second inherent impl block.
impl SnowflakeDriver {
    pub(super) fn query_returns_rows(sql: &str) -> bool {
        super::snowflake::snowflake_query_returns_rows(sql)
    }

    pub(super) fn resolve_database_name(&self, database: Option<&str>) -> Result<String> {
        database
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| self.current_database_name())
            .ok_or_else(|| anyhow!("A Snowflake database must be selected first"))
    }

    pub(super) fn build_urls(config: &ConnectionConfig) -> Result<(String, String)> {
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

    pub(super) fn format_status_message(status: &SnowflakeQueryStatus) -> Option<String> {
        let code = status.code.as_deref().unwrap_or("").trim();
        let sql_state = status.sql_state.as_deref().unwrap_or("").trim();
        let message = status.message.as_deref().unwrap_or("").trim();

        if code.is_empty() && sql_state.is_empty() && message.is_empty() {
            return None;
        }

        Some(
            match (code.is_empty(), sql_state.is_empty(), message.is_empty()) {
                (false, false, false) => format!("{code} ({sql_state}): {message}"),
                (false, true, false) => format!("{code}: {message}"),
                (true, false, false) => format!("{sql_state}: {message}"),
                (_, _, false) => message.to_string(),
                (false, false, true) => format!("{code} ({sql_state})"),
                (false, true, true) => code.to_string(),
                (true, false, true) => sql_state.to_string(),
                (true, true, true) => String::new(),
            },
        )
    }

    pub(super) fn format_api_error(status: u16, body: &str) -> String {
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

    pub(super) async fn parse_api_response(
        status: StatusCode,
        body: String,
    ) -> Result<SnowflakeApiResponse> {
        match status {
            StatusCode::OK => {
                let parsed =
                    serde_json::from_str::<SnowflakeResultSet>(&body).with_context(|| {
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

    pub(super) async fn post_statement(
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

    pub(super) async fn get_statement_status(
        &self,
        status_url: &str,
        partition: Option<usize>,
    ) -> Result<SnowflakeApiResponse> {
        let url = self.normalize_status_url(status_url);
        let mut request = self.apply_common_headers(self.client.get(url.clone()));
        if let Some(partition) = partition {
            request = request.query(&[("partition", partition.to_string())]);
        }

        let response = request.send().await.with_context(|| {
            format!("Failed to reach Snowflake statement status endpoint {url}")
        })?;
        let status = response.status();
        let body = response
            .text()
            .await
            .context("Failed to read Snowflake statement status response")?;
        Self::parse_api_response(status, body).await
    }

    pub(super) async fn await_result_set(
        &self,
        initial: SnowflakeApiResponse,
    ) -> Result<SnowflakeResultSet> {
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

    pub(super) async fn fetch_partition(
        &self,
        handle: &str,
        partition: usize,
    ) -> Result<SnowflakeResultSet> {
        let status_url = self.build_status_url_from_handle(handle);
        self.await_result_set(
            self.get_statement_status(&status_url, Some(partition))
                .await?,
        )
        .await
    }

    pub(super) fn affected_rows(stats: Option<&SnowflakeStatementStats>) -> u64 {
        stats.map_or(0, |stats| {
            stats.num_rows_inserted.unwrap_or(0)
                + stats.num_rows_updated.unwrap_or(0)
                + stats.num_rows_deleted.unwrap_or(0)
                + stats.num_duplicate_rows_updated.unwrap_or(0)
        })
    }

    pub(super) fn row_type_to_column_info(row_type: &SnowflakeRowType) -> ColumnInfo {
        ColumnInfo {
            name: row_type.name.clone(),
            data_type: Self::display_data_type(row_type),
            is_nullable: row_type.nullable.unwrap_or(true),
            is_primary_key: false,
            max_length: row_type.length.and_then(|value| u32::try_from(value).ok()),
            default_value: None,
        }
    }

    pub(super) fn display_data_type(row_type: &SnowflakeRowType) -> String {
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

    pub(super) fn row_types_from_result_set(
        result_set: &SnowflakeResultSet,
    ) -> Vec<SnowflakeRowType> {
        result_set
            .result_set_meta_data
            .as_ref()
            .map(|metadata| metadata.row_type.clone())
            .unwrap_or_default()
    }

    pub(super) fn total_rows_hint(result_set: &SnowflakeResultSet) -> Option<usize> {
        result_set
            .result_set_meta_data
            .as_ref()
            .and_then(|metadata| metadata.num_rows)
            .and_then(|value| usize::try_from(value).ok())
    }

    pub(super) fn partition_count(result_set: &SnowflakeResultSet) -> usize {
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

    pub(super) fn cell_to_json(cell: &JsonValue, row_type: &SnowflakeRowType) -> JsonValue {
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

    pub(super) fn rows_to_json(
        rows: Vec<Vec<JsonValue>>,
        row_types: &[SnowflakeRowType],
    ) -> Vec<Vec<JsonValue>> {
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

    pub(super) async fn execute_single_query(
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
        let result_set = self
            .await_result_set(self.post_statement(trimmed_sql, database_override).await?)
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

    pub(super) fn info_schema_relation(database: &str, relation: &str) -> Result<String> {
        Ok(format!(
            "{}.{}.{}",
            quote_snowflake_identifier(database)?,
            quote_snowflake_identifier("INFORMATION_SCHEMA")?,
            quote_snowflake_identifier(relation)?,
        ))
    }

    pub(super) fn sql_string_literal(value: &str) -> String {
        format!("'{}'", value.replace('\'', "''"))
    }

    pub(super) fn quote_sql_literal(value: &JsonValue) -> Result<String> {
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
                Ok(format!(
                    "PARSE_JSON({})",
                    Self::sql_string_literal(&serialized)
                ))
            }
        }
    }

    pub(super) fn parse_table_reference(
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
        let default_schema = self
            .current_schema_name()
            .or_else(|| Some("PUBLIC".to_string()));

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

    pub(super) fn qualify_table_name(table: &SnowflakeTableReference) -> Result<String> {
        Ok(format!(
            "{}.{}.{}",
            quote_snowflake_identifier(&table.database)?,
            quote_snowflake_identifier(&table.schema)?,
            quote_snowflake_identifier(&table.table)?,
        ))
    }

    pub(super) fn build_where_clause(primary_keys: &[RowKeyValue]) -> Result<String> {
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

    pub(super) fn scalar_i64(result: &QueryResult) -> Result<i64> {
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

    pub(super) fn column_index(columns: &[ColumnInfo], names: &[&str]) -> Option<usize> {
        columns.iter().position(|column| {
            names
                .iter()
                .any(|candidate| column.name.eq_ignore_ascii_case(candidate))
        })
    }

    pub(super) fn cell_as_string(
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

    pub(super) fn object_type_from_table_type(table_type: &str) -> String {
        let normalized = table_type.trim().to_ascii_uppercase();
        if normalized.is_empty() {
            "TABLE".to_string()
        } else {
            normalized
        }
    }

    pub(super) async fn refresh_session_namespace(&self) -> Result<()> {
        let sql =
            "SELECT CURRENT_DATABASE() AS current_database, CURRENT_SCHEMA() AS current_schema";
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

    pub(super) async fn find_database_name(&self, database: &str) -> Result<String> {
        let sql = format!(
            "SHOW TERSE DATABASES LIKE {}",
            Self::sql_string_literal(database.trim())
        );
        let result = self.execute_single_query(&sql, None, &sql).await?;

        result
            .rows
            .iter()
            .find_map(|row| Self::cell_as_string(row, &result.columns, &["name"]))
            .ok_or_else(|| {
                anyhow!(
                    "Snowflake database '{}' was not found or is not accessible",
                    database
                )
            })
    }

    pub(super) async fn first_schema_in_database(&self, database: &str) -> Result<Option<String>> {
        let sql = format!(
            "SELECT SCHEMA_NAME AS schema_name \
             FROM {} \
             WHERE SCHEMA_NAME <> 'INFORMATION_SCHEMA' \
             ORDER BY SCHEMA_NAME \
             LIMIT 1",
            Self::info_schema_relation(database, "SCHEMATA")?,
        );
        let result = self
            .execute_single_query(&sql, Some(database), &sql)
            .await?;
        Ok(result
            .rows
            .iter()
            .find_map(|row| Self::cell_as_string(row, &result.columns, &["schema_name"])))
    }

    pub(super) fn lookup_label_expression(
        display_columns: &[&str],
        referenced_column: &str,
    ) -> Result<String> {
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
