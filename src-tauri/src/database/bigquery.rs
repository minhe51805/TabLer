use super::driver::DatabaseDriver;
use super::models::*;
use super::query_common::{statement_returns_rows, MAX_QUERY_RESULT_ROWS};
use super::safety::{
    normalize_order_dir, quote_bigquery_identifier, quote_bigquery_order_by,
    sanitize_bigquery_filter_clause,
};
use crate::utils::sql::split_sql_statements;
use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use reqwest::Client;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Number as JsonNumber, Value as JsonValue};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::RwLock;
use tokio::time::{sleep, Duration};

const BIGQUERY_QUERY_TIMEOUT_MS: u64 = 10_000;
const BIGQUERY_POLL_INTERVAL_MS: u64 = 250;
const BIGQUERY_POLL_ATTEMPTS: usize = 240;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BigQueryApiErrorItem {
    message: Option<String>,
    reason: Option<String>,
    location: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BigQueryApiErrorBody {
    code: Option<u16>,
    message: Option<String>,
    #[serde(default)]
    errors: Vec<BigQueryApiErrorItem>,
}

#[derive(Debug, Default, Deserialize)]
struct BigQueryApiErrorEnvelope {
    #[serde(default)]
    error: BigQueryApiErrorBody,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BigQueryDatasetReference {
    project_id: String,
    dataset_id: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BigQueryTableReference {
    project_id: String,
    dataset_id: String,
    table_id: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BigQueryJobReference {
    project_id: String,
    job_id: String,
    location: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BigQueryTableFieldSchema {
    name: Option<String>,
    #[serde(rename = "type")]
    field_type: Option<String>,
    mode: Option<String>,
    #[serde(default)]
    fields: Vec<BigQueryTableFieldSchema>,
    description: Option<String>,
    default_value_expression: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct BigQueryTableSchema {
    #[serde(default)]
    fields: Vec<BigQueryTableFieldSchema>,
}

#[derive(Debug, Default, Deserialize)]
struct BigQueryViewDefinition {
    query: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BigQueryMaterializedViewDefinition {
    query: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BigQueryDatasetListItem {
    location: Option<String>,
    #[serde(default)]
    dataset_reference: BigQueryDatasetReference,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BigQueryDatasetListResponse {
    #[serde(default)]
    datasets: Vec<BigQueryDatasetListItem>,
    next_page_token: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BigQueryTableListItem {
    #[serde(default)]
    table_reference: BigQueryTableReference,
    #[serde(rename = "type")]
    table_type: Option<String>,
    num_rows: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BigQueryTableListResponse {
    #[serde(default)]
    tables: Vec<BigQueryTableListItem>,
    next_page_token: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BigQueryTableResource {
    #[serde(rename = "type")]
    table_type: Option<String>,
    schema: Option<BigQueryTableSchema>,
    view: Option<BigQueryViewDefinition>,
    materialized_view: Option<BigQueryMaterializedViewDefinition>,
}

#[derive(Debug, Default, Deserialize)]
struct BigQueryTableCell {
    #[serde(default)]
    v: JsonValue,
}

#[derive(Debug, Default, Deserialize)]
struct BigQueryTableRow {
    #[serde(default)]
    f: Vec<BigQueryTableCell>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BigQueryQueryRequest {
    query: String,
    use_legacy_sql: bool,
    max_results: u32,
    timeout_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    default_dataset: Option<BigQueryDatasetReference>,
    #[serde(skip_serializing_if = "Option::is_none")]
    location: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BigQueryQueryResponse {
    schema: Option<BigQueryTableSchema>,
    job_reference: Option<BigQueryJobReference>,
    total_rows: Option<String>,
    page_token: Option<String>,
    #[serde(default)]
    rows: Vec<BigQueryTableRow>,
    job_complete: Option<bool>,
    num_dml_affected_rows: Option<String>,
}

pub struct BigQueryDriver {
    client: Client,
    base_url: String,
    access_token: String,
    project_id: String,
    location: Option<String>,
    current_dataset: Arc<RwLock<Option<String>>>,
}

impl BigQueryDriver {
    pub async fn connect(config: &ConnectionConfig) -> Result<Self> {
        let base_url = Self::build_base_url(config)?;
        let access_token = config
            .password
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .context("BigQuery access token is required")?
            .to_string();
        let project_id = config
            .additional_fields
            .get("project_id")
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .context("BigQuery project ID is required")?
            .to_string();
        let location = config
            .additional_fields
            .get("location")
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let initial_dataset = config
            .additional_fields
            .get("dataset")
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| {
                config
                    .database
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
            });

        let driver = Self {
            client: Client::builder()
                .build()
                .context("Failed to initialize BigQuery HTTP client")?,
            base_url,
            access_token,
            project_id,
            location,
            current_dataset: Arc::new(RwLock::new(initial_dataset)),
        };

        driver.ping().await?;
        driver.ensure_default_dataset().await?;
        Ok(driver)
    }

    fn build_base_url(config: &ConnectionConfig) -> Result<String> {
        let raw_host = config
            .host
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("bigquery.googleapis.com");
        let host = if raw_host.contains(':') && !raw_host.starts_with('[') {
            format!("[{raw_host}]")
        } else {
            raw_host.to_string()
        };
        let port_suffix = match config.port.filter(|value| *value > 0 && *value != 443) {
            Some(port) => format!(":{port}"),
            None => String::new(),
        };

        Ok(format!("https://{host}{port_suffix}/bigquery/v2"))
    }

    fn api_url(&self, path: &str) -> String {
        format!(
            "{}/{}",
            self.base_url.trim_end_matches('/'),
            path.trim_start_matches('/')
        )
    }

    fn query_returns_rows(sql: &str) -> bool {
        statement_returns_rows(sql, &["SELECT", "WITH", "SHOW", "EXPLAIN", "DESCRIBE"])
    }

    async fn parse_response<T: DeserializeOwned>(response: reqwest::Response) -> Result<T> {
        let status = response.status();
        let body = response
            .text()
            .await
            .context("Failed to read BigQuery response body")?;

        if !status.is_success() {
            bail!("{}", Self::format_api_error(status.as_u16(), &body));
        }

        serde_json::from_str::<T>(&body).with_context(|| {
            format!(
                "Failed to parse BigQuery response payload: {}",
                body.chars().take(240).collect::<String>()
            )
        })
    }

    fn format_api_error(status: u16, body: &str) -> String {
        if let Ok(envelope) = serde_json::from_str::<BigQueryApiErrorEnvelope>(body) {
            let message = envelope
                .error
                .message
                .clone()
                .or_else(|| {
                    envelope
                        .error
                        .errors
                        .first()
                        .and_then(Self::format_api_error_item)
                })
                .unwrap_or_else(|| "BigQuery request failed".to_string());
            let code = envelope.error.code.unwrap_or(status);
            return format!("BigQuery API error {code}: {message}");
        }

        let trimmed = body.trim();
        if trimmed.is_empty() {
            format!("BigQuery API request failed with status {status}")
        } else {
            format!("BigQuery API request failed with status {status}: {trimmed}")
        }
    }

    fn format_api_error_item(item: &BigQueryApiErrorItem) -> Option<String> {
        let reason = item.reason.as_deref().unwrap_or("").trim();
        let location = item.location.as_deref().unwrap_or("").trim();
        let message = item.message.as_deref().unwrap_or("").trim();

        if message.is_empty() && reason.is_empty() && location.is_empty() {
            return None;
        }

        Some(match (reason.is_empty(), location.is_empty(), message.is_empty()) {
            (false, false, false) => format!("{reason} at {location}: {message}"),
            (false, true, false) => format!("{reason}: {message}"),
            (true, false, false) => format!("{location}: {message}"),
            (_, _, false) => message.to_string(),
            (false, false, true) => format!("{reason} at {location}"),
            (false, true, true) => reason.to_string(),
            (true, false, true) => location.to_string(),
            (true, true, true) => String::new(),
        })
    }

    async fn get_json<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(String, String)],
    ) -> Result<T> {
        let response = self
            .client
            .get(self.api_url(path))
            .bearer_auth(&self.access_token)
            .header("x-goog-user-project", &self.project_id)
            .query(query)
            .send()
            .await
            .with_context(|| format!("Failed to reach BigQuery endpoint {}", self.api_url(path)))?;

        Self::parse_response(response).await
    }

    async fn post_json<T: DeserializeOwned, B: Serialize>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<T> {
        let response = self
            .client
            .post(self.api_url(path))
            .bearer_auth(&self.access_token)
            .header("x-goog-user-project", &self.project_id)
            .json(body)
            .send()
            .await
            .with_context(|| format!("Failed to reach BigQuery endpoint {}", self.api_url(path)))?;

        Self::parse_response(response).await
    }

    async fn list_dataset_items(&self) -> Result<Vec<BigQueryDatasetListItem>> {
        let mut datasets = Vec::new();
        let mut page_token = None::<String>;

        loop {
            let mut query = vec![("maxResults".to_string(), "1000".to_string())];
            if let Some(token) = page_token.as_deref().filter(|value| !value.is_empty()) {
                query.push(("pageToken".to_string(), token.to_string()));
            }

            let response: BigQueryDatasetListResponse = self
                .get_json(
                    &format!("projects/{}/datasets", self.project_id),
                    &query,
                )
                .await?;

            datasets.extend(response.datasets);
            match response.next_page_token {
                Some(token) if !token.trim().is_empty() => page_token = Some(token),
                _ => break,
            }
        }

        Ok(datasets)
    }

    async fn ensure_default_dataset(&self) -> Result<()> {
        if self.current_dataset.read().await.is_some() {
            return Ok(());
        }

        let datasets = self.list_dataset_items().await?;
        if let Some(first_dataset) = datasets.into_iter().find_map(|item| {
            let dataset_id = item.dataset_reference.dataset_id.trim();
            (!dataset_id.is_empty()).then(|| dataset_id.to_string())
        }) {
            let mut current_dataset = self.current_dataset.write().await;
            *current_dataset = Some(first_dataset);
        }

        Ok(())
    }

    async fn resolve_dataset_name(&self, database: Option<&str>) -> Result<String> {
        if let Some(dataset) = database
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Ok(dataset.to_string());
        }

        self.ensure_default_dataset().await?;

        self.current_dataset
            .read()
            .await
            .clone()
            .ok_or_else(|| anyhow!("A BigQuery dataset must be selected before browsing tables"))
    }

    fn current_dataset_name(&self) -> Option<String> {
        self.current_dataset.try_read().ok().and_then(|guard| guard.clone())
    }

    async fn get_dataset(&self, dataset: &str) -> Result<BigQueryDatasetListItem> {
        self.get_json(
            &format!("projects/{}/datasets/{}", self.project_id, dataset),
            &[],
        )
        .await
    }

    async fn list_table_items(&self, dataset: &str) -> Result<Vec<BigQueryTableListItem>> {
        let mut tables = Vec::new();
        let mut page_token = None::<String>;

        loop {
            let mut query = vec![("maxResults".to_string(), "1000".to_string())];
            if let Some(token) = page_token.as_deref().filter(|value| !value.is_empty()) {
                query.push(("pageToken".to_string(), token.to_string()));
            }

            let response: BigQueryTableListResponse = self
                .get_json(
                    &format!(
                        "projects/{}/datasets/{}/tables",
                        self.project_id, dataset
                    ),
                    &query,
                )
                .await?;

            tables.extend(response.tables);
            match response.next_page_token {
                Some(token) if !token.trim().is_empty() => page_token = Some(token),
                _ => break,
            }
        }

        Ok(tables)
    }

    async fn get_table_resource(
        &self,
        project_id: &str,
        dataset_id: &str,
        table_id: &str,
    ) -> Result<BigQueryTableResource> {
        self.get_json(
            &format!(
                "projects/{project_id}/datasets/{dataset_id}/tables/{table_id}"
            ),
            &[],
        )
        .await
    }

    async fn poll_query_job(
        &self,
        job_reference: &BigQueryJobReference,
        page_token: Option<&str>,
    ) -> Result<BigQueryQueryResponse> {
        let mut query = vec![(
            "maxResults".to_string(),
            (MAX_QUERY_RESULT_ROWS + 1).to_string(),
        )];
        if let Some(location) = job_reference
            .location
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            query.push(("location".to_string(), location.to_string()));
        }
        if let Some(token) = page_token.map(str::trim).filter(|value| !value.is_empty()) {
            query.push(("pageToken".to_string(), token.to_string()));
        }

        self.get_json(
            &format!(
                "projects/{}/queries/{}",
                job_reference.project_id, job_reference.job_id
            ),
            &query,
        )
        .await
    }

    async fn execute_single_query(
        &self,
        sql: &str,
        dataset_override: Option<&str>,
        preserve_query_text: &str,
    ) -> Result<QueryResult> {
        let trimmed_sql = sql.trim();
        if trimmed_sql.is_empty() {
            return Err(anyhow!("BigQuery query cannot be empty"));
        }

        let started_at = Instant::now();
        let default_dataset = dataset_override
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|dataset_id| BigQueryDatasetReference {
                project_id: self.project_id.clone(),
                dataset_id: dataset_id.to_string(),
            })
            .or_else(|| {
                self.current_dataset_name().map(|dataset_id| BigQueryDatasetReference {
                    project_id: self.project_id.clone(),
                    dataset_id,
                })
            });

        let mut response: BigQueryQueryResponse = self
            .post_json(
                &format!("projects/{}/queries", self.project_id),
                &BigQueryQueryRequest {
                    query: trimmed_sql.to_string(),
                    use_legacy_sql: false,
                    max_results: (MAX_QUERY_RESULT_ROWS + 1) as u32,
                    timeout_ms: BIGQUERY_QUERY_TIMEOUT_MS,
                    default_dataset,
                    location: self.location.clone(),
                },
            )
            .await?;

        let job_reference = response
            .job_reference
            .clone()
            .ok_or_else(|| anyhow!("BigQuery did not return a job reference"))?;

        let mut attempts = 0usize;
        while response.job_complete == Some(false) {
            attempts += 1;
            if attempts > BIGQUERY_POLL_ATTEMPTS {
                bail!("BigQuery query did not finish within the expected polling window");
            }

            sleep(Duration::from_millis(BIGQUERY_POLL_INTERVAL_MS)).await;
            response = self.poll_query_job(&job_reference, None).await?;
        }

        let schema = response.schema.clone().unwrap_or_default();
        let mut rows = response.rows;
        let mut page_token = response.page_token.clone();
        let affected_rows = response
            .num_dml_affected_rows
            .as_deref()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);

        while rows.len() < MAX_QUERY_RESULT_ROWS {
            let Some(token) = page_token.clone() else {
                break;
            };

            let next_page = self.poll_query_job(&job_reference, Some(&token)).await?;
            rows.extend(next_page.rows);
            page_token = next_page.page_token.clone();
        }

        let total_rows = response
            .total_rows
            .as_deref()
            .and_then(|value| value.parse::<usize>().ok());
        let truncated = rows.len() > MAX_QUERY_RESULT_ROWS
            || page_token
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .is_some()
            || total_rows
                .map(|value| value > MAX_QUERY_RESULT_ROWS)
                .unwrap_or(false);

        let query_rows = rows
            .into_iter()
            .take(MAX_QUERY_RESULT_ROWS)
            .map(|row| Self::table_row_to_values(row, &schema.fields))
            .collect::<Vec<_>>();

        Ok(QueryResult {
            columns: schema
                .fields
                .iter()
                .map(Self::field_to_column_info)
                .collect::<Vec<_>>(),
            rows: query_rows,
            affected_rows,
            execution_time_ms: started_at.elapsed().as_millis(),
            query: preserve_query_text.to_string(),
            sandboxed: false,
            truncated,
        })
    }

    fn field_to_column_info(field: &BigQueryTableFieldSchema) -> ColumnInfo {
        ColumnInfo {
            name: field.name.clone().unwrap_or_else(|| "column".to_string()),
            data_type: Self::field_type_label(field),
            is_nullable: !field
                .mode
                .as_deref()
                .map(|mode| mode.eq_ignore_ascii_case("REQUIRED"))
                .unwrap_or(false),
            is_primary_key: false,
            max_length: None,
            default_value: field.default_value_expression.clone(),
        }
    }

    fn field_type_label(field: &BigQueryTableFieldSchema) -> String {
        let base = match field
            .field_type
            .as_deref()
            .unwrap_or("STRING")
            .to_ascii_uppercase()
            .as_str()
        {
            "RECORD" => "STRUCT".to_string(),
            other => other.to_string(),
        };

        if field
            .mode
            .as_deref()
            .map(|mode| mode.eq_ignore_ascii_case("REPEATED"))
            .unwrap_or(false)
        {
            format!("ARRAY<{base}>")
        } else {
            base
        }
    }

    fn table_row_to_values(
        row: BigQueryTableRow,
        fields: &[BigQueryTableFieldSchema],
    ) -> Vec<JsonValue> {
        fields
            .iter()
            .enumerate()
            .map(|(index, field)| {
                row.f.get(index)
                    .map(|cell| Self::cell_to_json(&cell.v, field))
                    .unwrap_or(JsonValue::Null)
            })
            .collect()
    }

    fn cell_to_json(value: &JsonValue, field: &BigQueryTableFieldSchema) -> JsonValue {
        if value.is_null() {
            return JsonValue::Null;
        }

        if field
            .mode
            .as_deref()
            .map(|mode| mode.eq_ignore_ascii_case("REPEATED"))
            .unwrap_or(false)
        {
            if let Some(items) = value.as_array() {
                return JsonValue::Array(
                    items
                        .iter()
                        .map(|item| {
                            let nested_value = item.get("v").unwrap_or(item);
                            let mut nested_field = field.clone();
                            nested_field.mode = None;
                            Self::cell_to_json(nested_value, &nested_field)
                        })
                        .collect::<Vec<_>>(),
                );
            }
        }

        let field_type = field
            .field_type
            .as_deref()
            .unwrap_or("STRING")
            .to_ascii_uppercase();

        if field_type == "RECORD" || field_type == "STRUCT" {
            let mut object = JsonMap::new();
            let nested_cells = value
                .get("f")
                .and_then(JsonValue::as_array)
                .cloned()
                .unwrap_or_default();
            for (index, nested_field) in field.fields.iter().enumerate() {
                let key = nested_field
                    .name
                    .clone()
                    .unwrap_or_else(|| format!("field_{index}"));
                let nested_value = nested_cells
                    .get(index)
                    .and_then(|cell| cell.get("v"))
                    .map(|cell| Self::cell_to_json(cell, nested_field))
                    .unwrap_or(JsonValue::Null);
                object.insert(key, nested_value);
            }
            return JsonValue::Object(object);
        }

        match value {
            JsonValue::String(raw) => Self::scalar_value_from_string(raw, &field_type),
            JsonValue::Bool(_) | JsonValue::Number(_) => value.clone(),
            JsonValue::Array(values) => JsonValue::Array(values.clone()),
            JsonValue::Object(_) => value.clone(),
            JsonValue::Null => JsonValue::Null,
        }
    }

    fn scalar_value_from_string(raw: &str, field_type: &str) -> JsonValue {
        match field_type {
            "BOOL" | "BOOLEAN" => match raw {
                "true" | "TRUE" | "1" => JsonValue::Bool(true),
                "false" | "FALSE" | "0" => JsonValue::Bool(false),
                _ => JsonValue::String(raw.to_string()),
            },
            "INT64" | "INTEGER" => raw
                .parse::<i64>()
                .map(JsonValue::from)
                .unwrap_or_else(|_| JsonValue::String(raw.to_string())),
            "FLOAT" | "FLOAT64" => raw
                .parse::<f64>()
                .ok()
                .and_then(JsonNumber::from_f64)
                .map(JsonValue::Number)
                .unwrap_or_else(|| JsonValue::String(raw.to_string())),
            "JSON" => serde_json::from_str::<JsonValue>(raw)
                .unwrap_or_else(|_| JsonValue::String(raw.to_string())),
            "NUMERIC" | "BIGNUMERIC" | "BYTES" | "DATE" | "DATETIME" | "TIME"
            | "TIMESTAMP" | "GEOGRAPHY" | "STRING" => JsonValue::String(raw.to_string()),
            _ => JsonValue::String(raw.to_string()),
        }
    }

    fn parse_i64_like(value: Option<&str>) -> Option<i64> {
        value.and_then(|raw| raw.parse::<i64>().ok())
    }

    fn table_info_from_item(item: BigQueryTableListItem) -> TableInfo {
        let table_type = item
            .table_type
            .clone()
            .unwrap_or_else(|| "TABLE".to_string())
            .to_ascii_uppercase();
        TableInfo {
            name: item.table_reference.table_id,
            schema: Some(item.table_reference.dataset_id),
            table_type,
            row_count: Self::parse_i64_like(item.num_rows.as_deref()),
            engine: Some("BigQuery".to_string()),
        }
    }

    fn table_definition(resource: &BigQueryTableResource) -> Option<String> {
        resource
            .view
            .as_ref()
            .and_then(|view| view.query.clone())
            .or_else(|| {
                resource
                    .materialized_view
                    .as_ref()
                    .and_then(|view| view.query.clone())
            })
    }

    fn flatten_schema_fields(
        fields: &[BigQueryTableFieldSchema],
        prefix: Option<&str>,
        output: &mut Vec<ColumnDetail>,
    ) {
        for field in fields {
            let field_name = field.name.as_deref().unwrap_or("column");
            let full_name = match prefix.filter(|value| !value.is_empty()) {
                Some(prefix) => format!("{prefix}.{field_name}"),
                None => field_name.to_string(),
            };

            output.push(ColumnDetail {
                name: full_name.clone(),
                data_type: Self::field_type_label(field),
                is_nullable: !field
                    .mode
                    .as_deref()
                    .map(|mode| mode.eq_ignore_ascii_case("REQUIRED"))
                    .unwrap_or(false),
                is_primary_key: false,
                default_value: field.default_value_expression.clone(),
                extra: field.mode.clone(),
                column_type: Some(Self::field_type_label(field)),
                comment: field.description.clone(),
            });

            if !field.fields.is_empty() {
                Self::flatten_schema_fields(&field.fields, Some(&full_name), output);
            }
        }
    }

    fn parse_table_reference(
        &self,
        table: &str,
        dataset_override: Option<&str>,
    ) -> Result<BigQueryTableReference> {
        let parts = table
            .trim()
            .trim_matches('`')
            .split('.')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>();

        match parts.as_slice() {
            [table_id] => Ok(BigQueryTableReference {
                project_id: self.project_id.clone(),
                dataset_id: dataset_override
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
                    .or_else(|| self.current_dataset_name())
                    .ok_or_else(|| anyhow!("A BigQuery dataset must be selected first"))?,
                table_id: (*table_id).to_string(),
            }),
            [dataset_id, table_id] => Ok(BigQueryTableReference {
                project_id: self.project_id.clone(),
                dataset_id: (*dataset_id).to_string(),
                table_id: (*table_id).to_string(),
            }),
            [project_id, dataset_id, table_id] => Ok(BigQueryTableReference {
                project_id: (*project_id).to_string(),
                dataset_id: (*dataset_id).to_string(),
                table_id: (*table_id).to_string(),
            }),
            _ => Err(anyhow!(
                "BigQuery tables must be referenced as table, dataset.table, or project.dataset.table"
            )),
        }
    }

    fn qualify_table_name(table_reference: &BigQueryTableReference) -> Result<String> {
        quote_bigquery_identifier(&format!(
            "{}.{}.{}",
            table_reference.project_id, table_reference.dataset_id, table_reference.table_id
        ))
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
            JsonValue::String(value) => Ok(format!("'{}'", value.replace('\'', "''"))),
            JsonValue::Array(_) | JsonValue::Object(_) => Err(anyhow!(
                "BigQuery row editing currently supports scalar values only"
            )),
        }
    }

    fn build_where_clause(primary_keys: &[RowKeyValue]) -> Result<String> {
        if primary_keys.is_empty() {
            return Err(anyhow!(
                "BigQuery row editing requires at least one row selector column"
            ));
        }

        Ok(primary_keys
            .iter()
            .map(|primary_key| {
                if primary_key.value.is_null() {
                    Ok(format!(
                        "{} IS NULL",
                        quote_bigquery_order_by(&primary_key.column)?
                    ))
                } else {
                    Ok(format!(
                        "{} = {}",
                        quote_bigquery_order_by(&primary_key.column)?,
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

    fn label_expression(display_columns: &[&str], referenced_column: &str) -> Result<String> {
        if display_columns.is_empty() {
            return Ok(format!(
                "CAST({} AS STRING)",
                quote_bigquery_order_by(referenced_column)?
            ));
        }

        let parts = display_columns
            .iter()
            .map(|column| {
                Ok(format!(
                    "COALESCE(CAST({} AS STRING), '')",
                    quote_bigquery_order_by(column)?
                ))
            })
            .collect::<Result<Vec<_>>>()?;

        if parts.len() == 1 {
            Ok(parts[0].clone())
        } else {
            let mut concat_parts = Vec::with_capacity(parts.len() * 2 - 1);
            for (index, part) in parts.into_iter().enumerate() {
                if index > 0 {
                    concat_parts.push("' '".to_string());
                }
                concat_parts.push(part);
            }
            Ok(format!("CONCAT({})", concat_parts.join(", ")))
        }
    }
}

#[async_trait]
impl DatabaseDriver for BigQueryDriver {
    async fn ping(&self) -> Result<()> {
        let _: BigQueryDatasetListResponse = self
            .get_json(
                &format!("projects/{}/datasets", self.project_id),
                &[("maxResults".to_string(), "1".to_string())],
            )
            .await
            .context("BigQuery ping failed")?;
        Ok(())
    }

    async fn disconnect(&self) -> Result<()> {
        Ok(())
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        let mut datasets = self.list_dataset_items().await?;
        datasets.sort_by(|left, right| {
            left.dataset_reference
                .dataset_id
                .cmp(&right.dataset_reference.dataset_id)
        });

        Ok(datasets
            .into_iter()
            .map(|dataset| DatabaseInfo {
                name: dataset.dataset_reference.dataset_id,
                size: dataset
                    .location
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string),
            })
            .collect())
    }

    async fn list_tables(&self, database: Option<&str>) -> Result<Vec<TableInfo>> {
        let dataset = self.resolve_dataset_name(database).await?;
        let mut tables = self.list_table_items(&dataset).await?;
        tables.sort_by(|left, right| left.table_reference.table_id.cmp(&right.table_reference.table_id));
        Ok(tables.into_iter().map(Self::table_info_from_item).collect())
    }

    async fn list_schema_objects(&self, database: Option<&str>) -> Result<Vec<SchemaObjectInfo>> {
        let dataset = self.resolve_dataset_name(database).await?;
        let tables = self.list_table_items(&dataset).await?;
        let mut objects = Vec::new();

        for table in tables {
            let object_type = table
                .table_type
                .clone()
                .unwrap_or_else(|| "TABLE".to_string())
                .to_ascii_uppercase();
            if object_type == "TABLE" {
                continue;
            }

            let definition = if matches!(object_type.as_str(), "VIEW" | "MATERIALIZED_VIEW") {
                let resource = self
                    .get_table_resource(
                        &table.table_reference.project_id,
                        &table.table_reference.dataset_id,
                        &table.table_reference.table_id,
                    )
                    .await?;
                Self::table_definition(&resource)
            } else {
                None
            };

            objects.push(SchemaObjectInfo {
                name: table.table_reference.table_id,
                schema: Some(table.table_reference.dataset_id),
                object_type,
                related_table: None,
                definition,
            });
        }

        objects.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(objects)
    }

    async fn get_table_structure(
        &self,
        table: &str,
        database: Option<&str>,
    ) -> Result<TableStructure> {
        let table_reference = self.parse_table_reference(table, database)?;
        let resource = self
            .get_table_resource(
                &table_reference.project_id,
                &table_reference.dataset_id,
                &table_reference.table_id,
            )
            .await?;

        let mut columns = Vec::new();
        if let Some(schema) = resource.schema.as_ref() {
            Self::flatten_schema_fields(&schema.fields, None, &mut columns);
        }

        Ok(TableStructure {
            columns,
            indexes: Vec::new(),
            foreign_keys: Vec::new(),
            triggers: Vec::new(),
            view_definition: Self::table_definition(&resource),
            object_type: resource
                .table_type
                .as_deref()
                .map(|value| value.to_ascii_uppercase()),
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
        let dataset = self.resolve_dataset_name(database).await?;
        let table_reference = self.parse_table_reference(table, Some(&dataset))?;
        let mut sql = format!("SELECT * FROM {}", Self::qualify_table_name(&table_reference)?);

        if let Some(filter_clause) = sanitize_bigquery_filter_clause(filter)? {
            sql.push_str(&format!(" WHERE {filter_clause}"));
        }

        if let Some(order_column) = order_by {
            let direction = normalize_order_dir(order_dir)?;
            sql.push_str(&format!(
                " ORDER BY {} {}",
                quote_bigquery_order_by(order_column)?,
                direction
            ));
        }

        sql.push_str(&format!(" LIMIT {limit} OFFSET {offset}"));
        self.execute_single_query(&sql, Some(&table_reference.dataset_id), &sql)
            .await
    }

    async fn count_rows(&self, table: &str, database: Option<&str>) -> Result<i64> {
        let dataset = self.resolve_dataset_name(database).await?;
        let table_reference = self.parse_table_reference(table, Some(&dataset))?;
        let sql = format!(
            "SELECT COUNT(*) AS count FROM {}",
            Self::qualify_table_name(&table_reference)?
        );
        let result = self.execute_single_query(&sql, Some(&table_reference.dataset_id), &sql).await?;
        Self::scalar_i64(&result)
    }

    async fn count_null_values(
        &self,
        table: &str,
        database: Option<&str>,
        column: &str,
    ) -> Result<i64> {
        let dataset = self.resolve_dataset_name(database).await?;
        let table_reference = self.parse_table_reference(table, Some(&dataset))?;
        let sql = format!(
            "SELECT COUNT(*) AS count FROM {} WHERE {} IS NULL",
            Self::qualify_table_name(&table_reference)?,
            quote_bigquery_order_by(column)?,
        );
        let result = self.execute_single_query(&sql, Some(&table_reference.dataset_id), &sql).await?;
        Self::scalar_i64(&result)
    }

    async fn update_table_cell(&self, request: &TableCellUpdateRequest) -> Result<u64> {
        let dataset = self.resolve_dataset_name(request.database.as_deref()).await?;
        let table_reference = self.parse_table_reference(&request.table, Some(&dataset))?;
        let where_clause = Self::build_where_clause(&request.primary_keys)?;
        let sql = format!(
            "UPDATE {} SET {} = {} WHERE {}",
            Self::qualify_table_name(&table_reference)?,
            quote_bigquery_order_by(&request.target_column)?,
            Self::quote_sql_literal(&request.value)?,
            where_clause
        );

        let result = self
            .execute_single_query(&sql, Some(&table_reference.dataset_id), &sql)
            .await?;
        Ok(result.affected_rows)
    }

    async fn delete_table_rows(&self, request: &TableRowDeleteRequest) -> Result<u64> {
        if request.rows.is_empty() {
            return Err(anyhow!("Deleting rows requires at least one selected row"));
        }

        let dataset = self.resolve_dataset_name(request.database.as_deref()).await?;
        let table_reference = self.parse_table_reference(&request.table, Some(&dataset))?;
        let mut predicates = Vec::new();

        for row in &request.rows {
            predicates.push(format!("({})", Self::build_where_clause(row)?));
        }

        let sql = format!(
            "DELETE FROM {} WHERE {}",
            Self::qualify_table_name(&table_reference)?,
            predicates.join(" OR ")
        );

        let result = self
            .execute_single_query(&sql, Some(&table_reference.dataset_id), &sql)
            .await?;
        Ok(result.affected_rows)
    }

    async fn insert_table_row(&self, request: &TableRowInsertRequest) -> Result<u64> {
        if request.values.is_empty() {
            return Err(anyhow!("Insert requires at least one column value"));
        }

        let dataset = self.resolve_dataset_name(request.database.as_deref()).await?;
        let table_reference = self.parse_table_reference(&request.table, Some(&dataset))?;
        let columns = request
            .values
            .iter()
            .map(|(column, _)| quote_bigquery_identifier(column))
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
            values.join(", ")
        );

        let result = self
            .execute_single_query(&sql, Some(&table_reference.dataset_id), &sql)
            .await?;
        Ok(result.affected_rows)
    }

    async fn use_database(&self, database: &str) -> Result<()> {
        let dataset = database.trim();
        if dataset.is_empty() {
            return Err(anyhow!("BigQuery dataset name cannot be empty"));
        }

        let _dataset_info = self
            .get_dataset(dataset)
            .await
            .with_context(|| format!("Failed to switch to BigQuery dataset {dataset}"))?;

        let mut current_dataset = self.current_dataset.write().await;
        *current_dataset = Some(dataset.to_string());
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
        let value_expr = quote_bigquery_order_by(referenced_column)?;
        let label_expr = Self::label_expression(display_columns, referenced_column)?;

        let mut sql = format!(
            "SELECT {} AS value, {} AS label FROM {}",
            value_expr,
            label_expr,
            Self::qualify_table_name(&table_reference)?
        );

        if let Some(search_term) = search.map(str::trim).filter(|value| !value.is_empty()) {
            sql.push_str(&format!(
                " WHERE CAST({} AS STRING) LIKE {}",
                value_expr,
                Self::quote_sql_literal(&JsonValue::String(format!("%{search_term}%")))?,
            ));
        }

        sql.push_str(&format!(" ORDER BY {} LIMIT {}", value_expr, limit.max(1)));

        let result = self
            .execute_single_query(&sql, Some(&table_reference.dataset_id), &sql)
            .await?;

        Ok(result
            .rows
            .into_iter()
            .map(|row| {
                let value = row.first().cloned().unwrap_or(JsonValue::Null);
                let label = row.get(1).cloned().unwrap_or_else(|| value.clone());
                LookupValue {
                    value,
                    label: match label {
                        JsonValue::String(text) => text,
                        other => serde_json::to_string(&other).unwrap_or_default(),
                    },
                }
            })
            .collect())
    }

    fn current_database(&self) -> Option<String> {
        self.current_dataset_name()
    }

    fn driver_name(&self) -> &str {
        "BigQuery"
    }
}

#[cfg(test)]
mod tests {
    use super::{BigQueryDriver, BigQueryTableCell, BigQueryTableFieldSchema, BigQueryTableRow};
    use serde_json::json;

    #[test]
    fn parses_bigquery_repeated_record_rows() {
        let fields = vec![BigQueryTableFieldSchema {
            name: Some("items".to_string()),
            field_type: Some("RECORD".to_string()),
            mode: Some("REPEATED".to_string()),
            fields: vec![BigQueryTableFieldSchema {
                name: Some("id".to_string()),
                field_type: Some("INT64".to_string()),
                mode: Some("NULLABLE".to_string()),
                fields: Vec::new(),
                description: None,
                default_value_expression: None,
            }],
            description: None,
            default_value_expression: None,
        }];
        let row = BigQueryTableRow {
            f: vec![BigQueryTableCell {
                v: json!([
                    { "v": { "f": [{ "v": "1" }] } },
                    { "v": { "f": [{ "v": "2" }] } }
                ]),
            }],
        };

        let parsed = BigQueryDriver::table_row_to_values(row, &fields);
        assert_eq!(parsed, vec![json!([{ "id": 1 }, { "id": 2 }])]);
    }

    #[test]
    fn quotes_scalar_sql_literals() {
        assert_eq!(
            BigQueryDriver::quote_sql_literal(&json!("O'Reilly")).unwrap(),
            "'O''Reilly'"
        );
        assert_eq!(BigQueryDriver::quote_sql_literal(&json!(true)).unwrap(), "TRUE");
        assert_eq!(BigQueryDriver::quote_sql_literal(&json!(null)).unwrap(), "NULL");
    }
}
