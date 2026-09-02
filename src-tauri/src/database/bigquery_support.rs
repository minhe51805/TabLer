use super::bigquery::BigQueryDriver;
use super::models::*;
use super::query_common::MAX_QUERY_RESULT_ROWS;
use anyhow::{anyhow, bail, Context, Result};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Number as JsonNumber, Value as JsonValue};
use std::time::Instant;
use tokio::time::{sleep, Duration};

const BIGQUERY_QUERY_TIMEOUT_MS: u64 = 10_000;
const BIGQUERY_POLL_INTERVAL_MS: u64 = 250;
const BIGQUERY_POLL_ATTEMPTS: usize = 240;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BigQueryApiErrorItem {
    pub(super) message: Option<String>,
    pub(super) reason: Option<String>,
    pub(super) location: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BigQueryApiErrorBody {
    pub(super) code: Option<u16>,
    pub(super) message: Option<String>,
    #[serde(default)]
    pub(super) errors: Vec<BigQueryApiErrorItem>,
}

#[derive(Debug, Default, Deserialize)]
pub(super) struct BigQueryApiErrorEnvelope {
    #[serde(default)]
    pub(super) error: BigQueryApiErrorBody,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BigQueryDatasetReference {
    pub(super) project_id: String,
    pub(super) dataset_id: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BigQueryTableReference {
    pub(super) project_id: String,
    pub(super) dataset_id: String,
    pub(super) table_id: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BigQueryJobReference {
    pub(super) project_id: String,
    pub(super) job_id: String,
    pub(super) location: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BigQueryTableFieldSchema {
    pub(super) name: Option<String>,
    #[serde(rename = "type")]
    pub(super) field_type: Option<String>,
    pub(super) mode: Option<String>,
    #[serde(default)]
    pub(super) fields: Vec<BigQueryTableFieldSchema>,
    pub(super) description: Option<String>,
    pub(super) default_value_expression: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub(super) struct BigQueryTableSchema {
    #[serde(default)]
    pub(super) fields: Vec<BigQueryTableFieldSchema>,
}

#[derive(Debug, Default, Deserialize)]
pub(super) struct BigQueryViewDefinition {
    pub(super) query: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BigQueryMaterializedViewDefinition {
    pub(super) query: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BigQueryDatasetListItem {
    pub(super) location: Option<String>,
    #[serde(default)]
    pub(super) dataset_reference: BigQueryDatasetReference,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BigQueryDatasetListResponse {
    #[serde(default)]
    pub(super) datasets: Vec<BigQueryDatasetListItem>,
    pub(super) next_page_token: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BigQueryTableListItem {
    #[serde(default)]
    pub(super) table_reference: BigQueryTableReference,
    #[serde(rename = "type")]
    pub(super) table_type: Option<String>,
    pub(super) num_rows: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BigQueryTableListResponse {
    #[serde(default)]
    pub(super) tables: Vec<BigQueryTableListItem>,
    pub(super) next_page_token: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BigQueryTableResource {
    #[serde(rename = "type")]
    pub(super) table_type: Option<String>,
    pub(super) schema: Option<BigQueryTableSchema>,
    pub(super) view: Option<BigQueryViewDefinition>,
    pub(super) materialized_view: Option<BigQueryMaterializedViewDefinition>,
}

#[derive(Debug, Default, Deserialize)]
pub(super) struct BigQueryTableCell {
    #[serde(default)]
    pub(super) v: JsonValue,
}

#[derive(Debug, Default, Deserialize)]
pub(super) struct BigQueryTableRow {
    #[serde(default)]
    pub(super) f: Vec<BigQueryTableCell>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BigQueryQueryRequest {
    pub(super) query: String,
    pub(super) use_legacy_sql: bool,
    pub(super) max_results: u32,
    pub(super) timeout_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) default_dataset: Option<BigQueryDatasetReference>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) location: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BigQueryQueryResponse {
    pub(super) schema: Option<BigQueryTableSchema>,
    pub(super) job_reference: Option<BigQueryJobReference>,
    pub(super) total_rows: Option<String>,
    pub(super) page_token: Option<String>,
    #[serde(default)]
    pub(super) rows: Vec<BigQueryTableRow>,
    pub(super) job_complete: Option<bool>,
    pub(super) num_dml_affected_rows: Option<String>,
}

/// REST client helpers, API DTOs, and result conversion for the BigQuery
/// driver, split into a second inherent impl block.
impl BigQueryDriver {
    pub(super) fn build_base_url(config: &ConnectionConfig) -> Result<String> {
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

    pub(super) fn api_url(&self, path: &str) -> String {
        format!(
            "{}/{}",
            self.base_url.trim_end_matches('/'),
            path.trim_start_matches('/')
        )
    }

    pub(super) fn query_returns_rows(sql: &str) -> bool {
        super::bigquery::bigquery_query_returns_rows(sql)
    }

    pub(super) async fn parse_response<T: DeserializeOwned>(
        response: reqwest::Response,
    ) -> Result<T> {
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

    pub(super) fn format_api_error(status: u16, body: &str) -> String {
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

    pub(super) fn format_api_error_item(item: &BigQueryApiErrorItem) -> Option<String> {
        let reason = item.reason.as_deref().unwrap_or("").trim();
        let location = item.location.as_deref().unwrap_or("").trim();
        let message = item.message.as_deref().unwrap_or("").trim();

        if message.is_empty() && reason.is_empty() && location.is_empty() {
            return None;
        }

        Some(
            match (reason.is_empty(), location.is_empty(), message.is_empty()) {
                (false, false, false) => format!("{reason} at {location}: {message}"),
                (false, true, false) => format!("{reason}: {message}"),
                (true, false, false) => format!("{location}: {message}"),
                (_, _, false) => message.to_string(),
                (false, false, true) => format!("{reason} at {location}"),
                (false, true, true) => reason.to_string(),
                (true, false, true) => location.to_string(),
                (true, true, true) => String::new(),
            },
        )
    }

    pub(super) async fn get_json<T: DeserializeOwned>(
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

    pub(super) async fn post_json<T: DeserializeOwned, B: Serialize>(
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

    pub(super) async fn list_dataset_items(&self) -> Result<Vec<BigQueryDatasetListItem>> {
        let mut datasets = Vec::new();
        let mut page_token = None::<String>;

        loop {
            let mut query = vec![("maxResults".to_string(), "1000".to_string())];
            if let Some(token) = page_token.as_deref().filter(|value| !value.is_empty()) {
                query.push(("pageToken".to_string(), token.to_string()));
            }

            let response: BigQueryDatasetListResponse = self
                .get_json(&format!("projects/{}/datasets", self.project_id), &query)
                .await?;

            datasets.extend(response.datasets);
            match response.next_page_token {
                Some(token) if !token.trim().is_empty() => page_token = Some(token),
                _ => break,
            }
        }

        Ok(datasets)
    }

    pub(super) async fn ensure_default_dataset(&self) -> Result<()> {
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

    pub(super) async fn resolve_dataset_name(&self, database: Option<&str>) -> Result<String> {
        if let Some(dataset) = database.map(str::trim).filter(|value| !value.is_empty()) {
            return Ok(dataset.to_string());
        }

        self.ensure_default_dataset().await?;

        self.current_dataset
            .read()
            .await
            .clone()
            .ok_or_else(|| anyhow!("A BigQuery dataset must be selected before browsing tables"))
    }

    pub(super) async fn get_dataset(&self, dataset: &str) -> Result<BigQueryDatasetListItem> {
        self.get_json(
            &format!("projects/{}/datasets/{}", self.project_id, dataset),
            &[],
        )
        .await
    }

    pub(super) async fn list_table_items(
        &self,
        dataset: &str,
    ) -> Result<Vec<BigQueryTableListItem>> {
        let mut tables = Vec::new();
        let mut page_token = None::<String>;

        loop {
            let mut query = vec![("maxResults".to_string(), "1000".to_string())];
            if let Some(token) = page_token.as_deref().filter(|value| !value.is_empty()) {
                query.push(("pageToken".to_string(), token.to_string()));
            }

            let response: BigQueryTableListResponse = self
                .get_json(
                    &format!("projects/{}/datasets/{}/tables", self.project_id, dataset),
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

    pub(super) async fn get_table_resource(
        &self,
        project_id: &str,
        dataset_id: &str,
        table_id: &str,
    ) -> Result<BigQueryTableResource> {
        self.get_json(
            &format!("projects/{project_id}/datasets/{dataset_id}/tables/{table_id}"),
            &[],
        )
        .await
    }

    pub(super) async fn poll_query_job(
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

    pub(super) async fn execute_single_query(
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
                self.current_dataset_name()
                    .map(|dataset_id| BigQueryDatasetReference {
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

    pub(super) fn field_to_column_info(field: &BigQueryTableFieldSchema) -> ColumnInfo {
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

    pub(super) fn field_type_label(field: &BigQueryTableFieldSchema) -> String {
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

    pub(super) fn table_row_to_values(
        row: BigQueryTableRow,
        fields: &[BigQueryTableFieldSchema],
    ) -> Vec<JsonValue> {
        fields
            .iter()
            .enumerate()
            .map(|(index, field)| {
                row.f
                    .get(index)
                    .map(|cell| Self::cell_to_json(&cell.v, field))
                    .unwrap_or(JsonValue::Null)
            })
            .collect()
    }

    pub(super) fn cell_to_json(value: &JsonValue, field: &BigQueryTableFieldSchema) -> JsonValue {
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

    pub(super) fn scalar_value_from_string(raw: &str, field_type: &str) -> JsonValue {
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
            "NUMERIC" | "BIGNUMERIC" | "BYTES" | "DATE" | "DATETIME" | "TIME" | "TIMESTAMP"
            | "GEOGRAPHY" | "STRING" => JsonValue::String(raw.to_string()),
            _ => JsonValue::String(raw.to_string()),
        }
    }

    pub(super) fn parse_i64_like(value: Option<&str>) -> Option<i64> {
        value.and_then(|raw| raw.parse::<i64>().ok())
    }

    pub(super) fn table_info_from_item(item: BigQueryTableListItem) -> TableInfo {
        let table_type = item
            .table_type
            .clone()
            .unwrap_or_else(|| "TABLE".to_string())
            .to_ascii_uppercase();
        TableInfo {
                create_date: None,
            name: item.table_reference.table_id,
            schema: Some(item.table_reference.dataset_id),
            table_type,
            row_count: Self::parse_i64_like(item.num_rows.as_deref()),
            engine: Some("BigQuery".to_string()),
        }
    }

    pub(super) fn table_definition(resource: &BigQueryTableResource) -> Option<String> {
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

    pub(super) fn flatten_schema_fields(
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

    pub(super) fn parse_table_reference(
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

    pub(super) fn qualify_table_name(table_reference: &BigQueryTableReference) -> Result<String> {
        super::safety::quote_bigquery_identifier(&format!(
            "{}.{}.{}",
            table_reference.project_id, table_reference.dataset_id, table_reference.table_id
        ))
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
            JsonValue::String(value) => Ok(format!("'{}'", value.replace('\'', "''"))),
            JsonValue::Array(_) | JsonValue::Object(_) => Err(anyhow!(
                "BigQuery row editing currently supports scalar values only"
            )),
        }
    }

    pub(super) fn build_where_clause(primary_keys: &[RowKeyValue]) -> Result<String> {
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
                        super::safety::quote_bigquery_order_by(&primary_key.column)?
                    ))
                } else {
                    Ok(format!(
                        "{} = {}",
                        super::safety::quote_bigquery_order_by(&primary_key.column)?,
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

    pub(super) fn label_expression(
        display_columns: &[&str],
        referenced_column: &str,
    ) -> Result<String> {
        if display_columns.is_empty() {
            return Ok(format!(
                "CAST({} AS STRING)",
                super::safety::quote_bigquery_order_by(referenced_column)?
            ));
        }

        let parts = display_columns
            .iter()
            .map(|column| {
                Ok(format!(
                    "COALESCE(CAST({} AS STRING), '')",
                    super::safety::quote_bigquery_order_by(column)?
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
