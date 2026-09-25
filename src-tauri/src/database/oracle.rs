use super::driver::DatabaseDriver;
use super::models::*;
use super::query_common::{
    statement_returns_rows, MAX_QUERY_RESULT_ROWS, METADATA_QUERY_ROW_LIMIT,
};
use super::safety::{
    normalize_order_dir, quote_oracle_identifier, quote_oracle_order_by,
    sanitize_oracle_filter_clause,
};
use crate::utils::sql::split_sql_statements;
use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::sync::{atomic::AtomicBool, Arc, RwLock};
use std::time::Instant;

/// Page size requested from the ORDS `/_/sql` endpoint. ORDS may clamp this to
/// the pool's configured maximum; `hasMore` drives the loop, not the limit.
const ORDS_PAGE_LIMIT: u64 = 500;

/// Body of `POST {base}/ords/{schema}/_/sql`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OrdsSqlPayload<'a> {
    statement_text: &'a str,
    offset: u64,
    limit: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    binds: Option<&'a [OrdsSqlBind]>,
}

/// One positional bind in the ORDS `binds` array. ORDS requires each entry
/// to carry `index` (1-based, matching `?` markers left to right),
/// `data_type` (an Oracle type name), and `value`.
#[derive(Debug, Serialize)]
struct OrdsSqlBind {
    index: u64,
    data_type: &'static str,
    value: JsonValue,
}

/// Success envelope: `{"items": [statement results], "env": {...}}`. ORDS
/// runs the payload as a script and returns one item per statement; query
/// rows live nested under `resultSet`, and statement failures surface as
/// per-item `errorCode`/`errorDetails` fields even when the HTTP status is
/// 200, so every item must be checked.
#[derive(Debug, Default, Deserialize)]
struct OrdsSqlResponse {
    #[serde(default)]
    items: Vec<OrdsStatementResult>,
}

/// One statement's outcome inside the response `items` array. `result` is
/// the affected-row count for DML (a single number, or one number per
/// element for batch statements); `resultSet` is present only for queries.
#[derive(Debug, Default, Deserialize)]
struct OrdsStatementResult {
    #[serde(default)]
    result: Option<JsonValue>,
    #[serde(default, rename = "resultSet")]
    result_set: Option<OrdsResultSet>,
    #[serde(default, rename = "errorCode")]
    error_code: Option<JsonValue>,
    #[serde(default, rename = "errorDetails")]
    error_details: Option<String>,
    #[serde(default)]
    response: Option<Vec<String>>,
}

/// The `resultSet` block of a query statement: column metadata plus one
/// JSON object per row keyed by `jsonColumnName` (serde_json's
/// `preserve_order` feature keeps the emitted column order).
#[derive(Debug, Default, Deserialize)]
struct OrdsResultSet {
    #[serde(default)]
    metadata: Vec<OrdsColumnMeta>,
    #[serde(default)]
    items: Vec<JsonMap<String, JsonValue>>,
    #[serde(default, rename = "hasMore")]
    has_more: bool,
}

#[derive(Debug, Deserialize)]
struct OrdsColumnMeta {
    #[serde(default, rename = "jsonColumnName")]
    json_column_name: Option<String>,
    #[serde(default, rename = "columnName")]
    column_name: Option<String>,
    #[serde(default, rename = "columnTypeName")]
    column_type_name: Option<String>,
    #[serde(default, rename = "isNullable")]
    is_nullable: Option<i64>,
}

/// Accumulated outcome of running one statement, possibly across several
/// paginated requests.
#[derive(Debug, Default)]
struct OrdsExecution {
    rows: Vec<JsonMap<String, JsonValue>>,
    columns: Vec<ColumnInfo>,
    affected_rows: u64,
    truncated: bool,
}

/// Error envelope. ORDS emits Problem-JSON-ish shapes (`title`, `o:errorCode`,
/// `o:errorDetails`) plus occasional `code`/`message` fields depending on the
/// version and the failure layer, so every field is optional.
#[derive(Debug, Default, Deserialize)]
struct OrdsErrorBody {
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default, rename = "o:errorCode")]
    error_code: Option<String>,
    #[serde(default, rename = "o:errorDetails")]
    error_details: Option<Vec<OrdsErrorDetail>>,
}

#[derive(Debug, Deserialize)]
struct OrdsErrorDetail {
    #[serde(default)]
    message: Option<String>,
}

/// Read/write Oracle driver backed by Oracle REST Data Services (ORDS).
/// Every statement goes through `POST {base}/ords/{schema}/_/sql` with HTTP
/// Basic auth; the schema path segment selects the ORDS-enabled schema.
pub struct OracleDriver {
    client: Client,
    base_url: String,
    username: String,
    password: String,
    current_schema: Arc<RwLock<String>>,
}

impl OracleDriver {
    pub async fn connect(config: &ConnectionConfig) -> Result<Self> {
        let base_url = Self::build_base_url(config)?;
        let username = config
            .username
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .context("Oracle ORDS username is required")?
            .to_string();
        let password = config
            .password
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .context("Oracle ORDS password is required")?
            .to_string();
        let schema = Self::resolve_schema_alias(config, &username)?;

        let driver = Self {
            client: Client::builder()
                .build()
                .context("Failed to initialize Oracle ORDS HTTP client")?,
            base_url,
            username,
            password,
            current_schema: Arc::new(RwLock::new(schema)),
        };

        driver.ping().await?;
        Ok(driver)
    }

    /// `{scheme}://{host}:{port}/{ords_base_path}` — the SQL endpoint itself is
    /// appended per request because the schema segment can change at runtime.
    fn build_base_url(config: &ConnectionConfig) -> Result<String> {
        let raw_host = config
            .host
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .context("Oracle ORDS host is required")?;
        let host = if raw_host.contains(':') && !raw_host.starts_with('[') {
            format!("[{raw_host}]")
        } else {
            raw_host.to_string()
        };

        let scheme = if config.use_ssl { "https" } else { "http" };
        let port = config
            .port
            .filter(|value| *value > 0)
            .unwrap_or(if config.use_ssl { 443 } else { 8080 });

        let base_path = config
            .additional_fields
            .get("ords_base_path")
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("ords");
        if base_path.contains('/') || base_path.contains('?') || base_path.contains('#') {
            return Err(anyhow!(
                "ORDS base path must be a single path segment (e.g. \"ords\")"
            ));
        }

        Ok(format!("{scheme}://{host}:{port}/{base_path}"))
    }

    /// The `{schema}` path segment: `ords_schema` extra field wins, then the
    /// connection's database field, then the username (the common ORDS
    /// schema-alias convention for schema-enabled users).
    fn resolve_schema_alias(config: &ConnectionConfig, username: &str) -> Result<String> {
        let alias = config
            .additional_fields
            .get("ords_schema")
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
            })
            .unwrap_or_else(|| username.to_string());
        Self::validate_schema_alias(&alias)
    }

    /// Schema aliases land verbatim in the request path, so they must be a
    /// single safe segment — no separators, whitespace, or URL delimiters.
    fn validate_schema_alias(alias: &str) -> Result<String> {
        let trimmed = alias.trim();
        if trimmed.is_empty() {
            return Err(anyhow!("ORDS schema alias cannot be empty"));
        }
        if trimmed
            .chars()
            .any(|ch| ch.is_whitespace() || matches!(ch, '/' | '\\' | '?' | '#' | '%'))
        {
            return Err(anyhow!(
                "ORDS schema alias must be a single path segment (letters, digits, _, $, ., -)"
            ));
        }
        Ok(trimmed.to_string())
    }

    fn current_schema_alias(&self) -> String {
        self.current_schema
            .read()
            .ok()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    fn sql_endpoint(&self) -> String {
        format!("{}/{}/_/sql", self.base_url, self.current_schema_alias())
    }

    fn query_returns_rows(sql: &str) -> bool {
        statement_returns_rows(sql, &["SELECT", "WITH"])
    }

    fn error_message(status: reqwest::StatusCode, body: &str) -> String {
        let parsed = serde_json::from_str::<OrdsErrorBody>(body).unwrap_or_default();
        let detail = parsed
            .error_details
            .and_then(|details| {
                details
                    .into_iter()
                    .filter_map(|detail| detail.message)
                    .next()
            })
            .or(parsed.message)
            .or(parsed.title)
            .unwrap_or_else(|| {
                let trimmed = body.trim();
                trimmed.chars().take(500).collect::<String>()
            });
        match parsed.code.or(parsed.error_code) {
            Some(code) => format!("Oracle ORDS error {code}: {detail}"),
            None => format!("Oracle ORDS request failed ({status}): {detail}"),
        }
    }

    /// POST one statement and accumulate every result-set page until
    /// `hasMore` is false or `max_rows` is reached.
    async fn execute_statement(&self, sql: &str, max_rows: usize) -> Result<OrdsExecution> {
        self.execute_statement_binds(sql, &[], max_rows).await
    }

    /// `execute_statement` with positional binds. `binds[i]` supplies the
    /// (i+1)-th `?` marker in `sql`; values travel in the request body, never
    /// in the statement text.
    ///
    /// ORDS answers with one `items` entry per statement in the payload.
    /// Statement failures arrive as per-item `errorCode`/`errorDetails`
    /// fields even on HTTP 200, so every item is checked before results are
    /// collected — an error is never swallowed. For queries, `resultSet`
    /// rows are accumulated across `offset`/`limit` pages; for DML/DDL the
    /// per-item `result` counts are summed into `affected_rows`.
    async fn execute_statement_binds(
        &self,
        sql: &str,
        binds: &[OrdsSqlBind],
        max_rows: usize,
    ) -> Result<OrdsExecution> {
        let endpoint = self.sql_endpoint();
        let mut execution = OrdsExecution::default();
        let mut offset = 0u64;

        loop {
            let response = self
                .client
                .post(&endpoint)
                .basic_auth(&self.username, Some(&self.password))
                .json(&OrdsSqlPayload {
                    statement_text: sql,
                    offset,
                    limit: ORDS_PAGE_LIMIT,
                    binds: (!binds.is_empty()).then_some(binds),
                })
                .send()
                .await
                .with_context(|| format!("Failed to reach Oracle ORDS for query: {sql}"))?;

            let status = response.status();
            let body = response
                .text()
                .await
                .context("Failed to read Oracle ORDS response body")?;

            if !status.is_success() {
                return Err(anyhow!(Self::error_message(status, &body)));
            }

            let page = serde_json::from_str::<OrdsSqlResponse>(&body)
                .context("Failed to parse Oracle ORDS response")?;

            let mut page_has_more = false;
            let mut fetched = 0u64;
            for item in &page.items {
                if let Some(message) = Self::statement_error(item) {
                    return Err(anyhow!(message));
                }
                execution.affected_rows += Self::affected_rows(item);
                if let Some(result_set) = &item.result_set {
                    if execution.columns.is_empty() {
                        execution.columns = Self::result_set_columns(result_set);
                    }
                    fetched += result_set.items.len() as u64;
                    execution.rows.extend(result_set.items.iter().cloned());
                    page_has_more = result_set.has_more;
                }
            }

            offset += fetched;
            if !page_has_more || fetched == 0 {
                break;
            }
            if execution.rows.len() >= max_rows {
                execution.truncated = true;
                break;
            }
        }

        Ok(execution)
    }

    /// Extract a statement-level failure from one response item. ORDS
    /// reports script errors inside the item (`errorCode`, `errorDetails`,
    /// plus the SQLcl-style `response` lines) while still returning HTTP 200.
    fn statement_error(item: &OrdsStatementResult) -> Option<String> {
        let code = item.error_code.as_ref()?;
        let code = match code {
            JsonValue::String(text) => text.clone(),
            other => other.to_string(),
        };
        let detail = item
            .error_details
            .as_deref()
            .map(str::trim)
            .filter(|detail| !detail.is_empty())
            .map(str::to_string)
            .or_else(|| {
                item.response.as_ref().and_then(|lines| {
                    let text = lines.join("").trim().to_string();
                    (!text.is_empty()).then_some(text)
                })
            })
            .unwrap_or_else(|| "statement failed".to_string());
        Some(format!("Oracle ORDS statement failed ({code}): {detail}"))
    }

    /// `result` is the affected-row count for DML/DDL items: a single number,
    /// or an array of numbers for batch `statementText` payloads.
    fn affected_rows(item: &OrdsStatementResult) -> u64 {
        match item.result.as_ref() {
            Some(JsonValue::Number(number)) => number.as_u64().unwrap_or(0),
            Some(JsonValue::Array(counts)) => {
                counts.iter().filter_map(JsonValue::as_u64).sum::<u64>()
            }
            _ => 0,
        }
    }

    /// Build `ColumnInfo`s from `resultSet.metadata`, preferring
    /// `jsonColumnName` because that is the key ORDS uses in row objects.
    fn result_set_columns(result_set: &OrdsResultSet) -> Vec<ColumnInfo> {
        result_set
            .metadata
            .iter()
            .filter_map(|meta| {
                let name = meta
                    .json_column_name
                    .clone()
                    .or_else(|| meta.column_name.clone())?;
                Some(ColumnInfo {
                    name,
                    data_type: meta
                        .column_type_name
                        .clone()
                        .unwrap_or_else(|| "unknown".to_string()),
                    is_nullable: meta.is_nullable.map(|flag| flag == 1).unwrap_or(true),
                    is_primary_key: false,
                    max_length: None,
                    default_value: None,
                })
            })
            .collect()
    }

    /// Map ordered `QueryParameter`s to ORDS positional binds. `index` is
    /// 1-based to match the `?` markers left to right; `data_type` is the
    /// Oracle type ORDS binds as. Oracle has no portable BOOLEAN bind type
    /// (pre-23c), so booleans travel as NUMBER 1/0; Json travels as a
    /// VARCHAR2 string, matching the other drivers' convention.
    fn parameters_to_binds(parameters: &[QueryParameter]) -> Vec<OrdsSqlBind> {
        parameters
            .iter()
            .enumerate()
            .map(|(position, parameter)| {
                let (data_type, value) = match parameter.data_type {
                    QueryParameterType::Text => (
                        "VARCHAR2",
                        parameter
                            .value
                            .as_str()
                            .map(|text| JsonValue::String(text.to_string()))
                            .unwrap_or_else(|| JsonValue::String(parameter.value.to_string())),
                    ),
                    QueryParameterType::Integer | QueryParameterType::Decimal => {
                        ("NUMBER", parameter.value.clone())
                    }
                    QueryParameterType::Boolean => (
                        "NUMBER",
                        JsonValue::from(if parameter.value.as_bool().unwrap_or(false) {
                            1
                        } else {
                            0
                        }),
                    ),
                    QueryParameterType::Json => {
                        ("VARCHAR2", JsonValue::String(parameter.value.to_string()))
                    }
                    QueryParameterType::Null => ("VARCHAR2", JsonValue::Null),
                };
                OrdsSqlBind {
                    index: position as u64 + 1,
                    data_type,
                    value,
                }
            })
            .collect()
    }

    /// Map an accumulated `OrdsExecution` to a `QueryResult`. Column order
    /// comes from `resultSet.metadata`; when metadata is absent the union of
    /// row keys is taken in first-seen order (serde_json's `preserve_order`
    /// keeps ORDS's emitted order).
    fn execution_to_query_result(
        execution: OrdsExecution,
        query: String,
        elapsed: u128,
    ) -> QueryResult {
        let OrdsExecution {
            rows,
            mut columns,
            affected_rows,
            truncated,
        } = execution;

        if columns.is_empty() {
            let mut column_names: Vec<String> = Vec::new();
            for row in &rows {
                for key in row.keys() {
                    if !column_names.iter().any(|name| name == key) {
                        column_names.push(key.clone());
                    }
                }
            }
            columns = column_names
                .into_iter()
                .map(|name| ColumnInfo {
                    name,
                    data_type: "unknown".to_string(),
                    is_nullable: true,
                    is_primary_key: false,
                    max_length: None,
                    default_value: None,
                })
                .collect();
        }

        let values = rows
            .into_iter()
            .map(|row| {
                columns
                    .iter()
                    .map(|column| row.get(&column.name).cloned().unwrap_or(JsonValue::Null))
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();

        QueryResult {
            columns,
            rows: values,
            affected_rows,
            execution_time_ms: elapsed,
            query,
            sandboxed: false,
            truncated,
        }
    }

    /// Run a metadata SELECT and return the raw row objects. Metadata reads
    /// use the catalog row limit (all_objects/all_tab_columns can be large),
    /// not the interactive query cap.
    async fn query_objects(&self, sql: &str) -> Result<Vec<JsonMap<String, JsonValue>>> {
        let execution = self
            .execute_statement(sql, METADATA_QUERY_ROW_LIMIT)
            .await?;
        Ok(execution.rows)
    }

    fn string_field(row: &JsonMap<String, JsonValue>, key: &str) -> Option<String> {
        row.get(key).and_then(JsonValue::as_str).map(str::to_string)
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

    /// Single-quoted SQL string literal for dictionary lookups.
    fn sql_literal(value: &str) -> String {
        format!("'{}'", value.replace('\'', "''"))
    }

    /// Uppercase a name the way Oracle folds unquoted identifiers, for
    /// `ALL_*` dictionary comparisons.
    fn dictionary_literal(value: &str) -> String {
        Self::sql_literal(&value.trim().to_uppercase())
    }

    /// ORDS runs every `/_/sql` request in its own transaction and commits
    /// when the request ends; there is no way to hold one transaction open
    /// across HTTP calls, so multi-statement atomic operations must be
    /// rejected rather than partially applied.
    fn no_transaction_error(operation: &str) -> anyhow::Error {
        anyhow!(
            "{operation} is not supported by the Oracle ORDS driver: \
             each ORDS request auto-commits in its own transaction"
        )
    }

    /// `request.table` may already carry a schema prefix; `database`
    /// overrides it. Every segment is validated and double-quoted.
    fn qualified_table_name(table: &str, database: Option<&str>) -> Result<String> {
        let qualified = match database.map(str::trim).filter(|db| !db.is_empty()) {
            Some(db) => format!("{db}.{table}"),
            None => table.to_string(),
        };
        quote_oracle_order_by(&qualified)
    }

    /// Map raw JSON values to ORDS positional binds, inferring the Oracle
    /// type from the value: numbers bind as NUMBER, booleans as NUMBER 1/0
    /// (Oracle has no portable BOOLEAN bind type pre-23c), strings and
    /// serialized arrays/objects as VARCHAR2, and null as a VARCHAR2 NULL.
    fn values_to_binds(values: &[JsonValue]) -> Vec<OrdsSqlBind> {
        values
            .iter()
            .enumerate()
            .map(|(position, value)| {
                let (data_type, value) = match value {
                    JsonValue::Null => ("VARCHAR2", JsonValue::Null),
                    JsonValue::Bool(flag) => ("NUMBER", JsonValue::from(*flag as u8)),
                    JsonValue::Number(_) => ("NUMBER", value.clone()),
                    JsonValue::String(_) => ("VARCHAR2", value.clone()),
                    other => ("VARCHAR2", JsonValue::String(other.to_string())),
                };
                OrdsSqlBind {
                    index: position as u64 + 1,
                    data_type,
                    value,
                }
            })
            .collect()
    }

    /// Builds the `UPDATE … SET col = ? WHERE pk = ?` statement for one cell
    /// edit. Values are returned separately so they travel as ORDS binds,
    /// never interpolated into the statement text.
    fn build_cell_update_statement(
        request: &TableCellUpdateRequest,
    ) -> Result<(String, Vec<JsonValue>)> {
        if request.primary_keys.is_empty() {
            return Err(anyhow!(
                "Inline update requires at least one primary key column"
            ));
        }

        let mut values = vec![request.value.clone()];
        let mut where_clause = String::new();
        for (index, primary_key) in request.primary_keys.iter().enumerate() {
            if index > 0 {
                where_clause.push_str(" AND ");
            }
            where_clause.push_str(&quote_oracle_order_by(&primary_key.column)?);
            if primary_key.value.is_null() {
                where_clause.push_str(" IS NULL");
            } else {
                values.push(primary_key.value.clone());
                where_clause.push_str(" = ?");
            }
        }

        let sql = format!(
            "UPDATE {} SET {} = ? WHERE {}",
            Self::qualified_table_name(&request.table, request.database.as_deref())?,
            quote_oracle_order_by(&request.target_column)?,
            where_clause
        );
        Ok((sql, values))
    }

    /// Builds the `DELETE FROM … WHERE (pk = ? …) OR (…)` statement for the
    /// selected rows. NULL key values become `IS NULL` predicates and carry
    /// no bind.
    fn build_row_delete_statement(
        request: &TableRowDeleteRequest,
    ) -> Result<(String, Vec<JsonValue>)> {
        if request.rows.is_empty() {
            return Err(anyhow!("Deleting rows requires at least one selected row"));
        }

        let mut values = Vec::new();
        let mut predicates = Vec::new();
        for row_keys in &request.rows {
            let mut parts = Vec::new();
            for key in row_keys {
                if key.value.is_null() {
                    parts.push(format!("{} IS NULL", quote_oracle_order_by(&key.column)?));
                } else {
                    values.push(key.value.clone());
                    parts.push(format!("{} = ?", quote_oracle_order_by(&key.column)?));
                }
            }
            if !parts.is_empty() {
                predicates.push(format!("({})", parts.join(" AND ")));
            }
        }

        if predicates.is_empty() {
            return Err(anyhow!(
                "Deleting rows requires at least one valid row predicate"
            ));
        }

        let sql = format!(
            "DELETE FROM {} WHERE {}",
            Self::qualified_table_name(&request.table, request.database.as_deref())?,
            predicates.join(" OR ")
        );
        Ok((sql, values))
    }

    /// Builds the `INSERT INTO … (cols) VALUES (?, …)` statement for one row.
    fn build_row_insert_statement(
        request: &TableRowInsertRequest,
    ) -> Result<(String, Vec<JsonValue>)> {
        if request.values.is_empty() {
            return Err(anyhow!("Insert requires at least one column value"));
        }

        let mut columns = Vec::new();
        let mut placeholders = Vec::new();
        let mut values = Vec::new();
        for (column, value) in &request.values {
            columns.push(quote_oracle_identifier(column)?);
            values.push(value.clone());
            placeholders.push("?");
        }

        let sql = format!(
            "INSERT INTO {} ({}) VALUES ({})",
            Self::qualified_table_name(&request.table, request.database.as_deref())?,
            columns.join(", "),
            placeholders.join(", ")
        );
        Ok((sql, values))
    }
}

#[async_trait]
impl DatabaseDriver for OracleDriver {
    async fn ping(&self) -> Result<()> {
        self.execute_statement("SELECT 1 FROM DUAL", MAX_QUERY_RESULT_ROWS)
            .await?;
        Ok(())
    }

    async fn disconnect(&self) -> Result<()> {
        Ok(())
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        // ORDS schemas are the "databases" this driver can switch between:
        // every user/schema visible through ALL_USERS is a candidate alias.
        let rows = self
            .query_objects("SELECT username FROM all_users ORDER BY username")
            .await?;

        if rows.is_empty() {
            return Ok(vec![DatabaseInfo {
                name: self.current_schema_alias(),
                size: None,
            }]);
        }

        Ok(rows
            .into_iter()
            .filter_map(|row| Self::string_field(&row, "username"))
            .map(|name| DatabaseInfo { name, size: None })
            .collect())
    }

    async fn list_tables(&self, _database: Option<&str>) -> Result<Vec<TableInfo>> {
        let rows = self
            .query_objects(
                "SELECT table_name AS name, 'TABLE' AS object_type FROM all_tables \
                 WHERE owner = SYS_CONTEXT('USERENV','CURRENT_SCHEMA') \
                 UNION ALL \
                 SELECT view_name AS name, 'VIEW' AS object_type FROM all_views \
                 WHERE owner = SYS_CONTEXT('USERENV','CURRENT_SCHEMA') \
                 ORDER BY name",
            )
            .await?;

        Ok(rows
            .into_iter()
            .map(|row| TableInfo {
                create_date: None,
                name: Self::string_field(&row, "name").unwrap_or_else(|| "unnamed".to_string()),
                table_type: Self::string_field(&row, "object_type")
                    .unwrap_or_else(|| "TABLE".to_string()),
                schema: Some(self.current_schema_alias()),
                row_count: None,
                engine: Some("Oracle".to_string()),
            })
            .collect())
    }

    async fn list_schema_objects(&self, _database: Option<&str>) -> Result<Vec<SchemaObjectInfo>> {
        let rows = self
            .query_objects(
                "SELECT object_name AS name, object_type \
                 FROM all_objects \
                 WHERE owner = SYS_CONTEXT('USERENV','CURRENT_SCHEMA') \
                   AND object_type IN ('VIEW','TRIGGER','PROCEDURE','FUNCTION','PACKAGE','PACKAGE BODY','SEQUENCE','SYNONYM','TYPE') \
                 ORDER BY object_type, object_name",
            )
            .await?;

        Ok(rows
            .into_iter()
            .map(|row| SchemaObjectInfo {
                create_date: None,
                name: Self::string_field(&row, "name").unwrap_or_else(|| "unnamed".to_string()),
                schema: Some(self.current_schema_alias()),
                object_type: Self::string_field(&row, "object_type")
                    .unwrap_or_else(|| "OBJECT".to_string()),
                related_table: None,
                definition: None,
            })
            .collect())
    }

    async fn get_table_structure(
        &self,
        table: &str,
        _database: Option<&str>,
    ) -> Result<TableStructure> {
        let table_literal = Self::dictionary_literal(table);

        let col_rows = self
            .query_objects(&format!(
                "SELECT c.column_name AS name, c.data_type, c.nullable, c.data_default, \
                        c.data_length, c.data_precision, c.data_scale, \
                        CASE WHEN pk.column_name IS NULL THEN 0 ELSE 1 END AS is_pk \
                 FROM all_tab_columns c \
                 LEFT JOIN ( \
                     SELECT acc.column_name \
                     FROM all_constraints ac \
                     JOIN all_cons_columns acc \
                       ON ac.owner = acc.owner AND ac.constraint_name = acc.constraint_name \
                     WHERE ac.owner = SYS_CONTEXT('USERENV','CURRENT_SCHEMA') \
                       AND ac.table_name = {table_literal} \
                       AND ac.constraint_type = 'P' \
                 ) pk ON pk.column_name = c.column_name \
                 WHERE c.owner = SYS_CONTEXT('USERENV','CURRENT_SCHEMA') \
                   AND c.table_name = {table_literal} \
                 ORDER BY c.column_id"
            ))
            .await?;

        let columns = col_rows
            .iter()
            .map(|row| {
                let data_type =
                    Self::string_field(row, "data_type").unwrap_or_else(|| "UNKNOWN".to_string());
                let length = row.get("data_length").and_then(JsonValue::as_i64);
                let precision = row.get("data_precision").and_then(JsonValue::as_i64);
                let scale = row.get("data_scale").and_then(JsonValue::as_i64);
                let column_type = match (precision, scale, length) {
                    (Some(p), Some(s), _) => format!("{data_type}({p},{s})"),
                    (Some(p), None, _) => format!("{data_type}({p})"),
                    (None, _, Some(l))
                        if !matches!(data_type.as_str(), "NUMBER" | "DATE" | "TIMESTAMP") =>
                    {
                        format!("{data_type}({l})")
                    }
                    _ => data_type.clone(),
                };
                ColumnDetail {
                    name: Self::string_field(row, "name").unwrap_or_else(|| "column".to_string()),
                    data_type,
                    is_nullable: Self::string_field(row, "nullable")
                        .map(|value| value == "Y")
                        .unwrap_or(true),
                    default_value: Self::string_field(row, "data_default"),
                    is_primary_key: row.get("is_pk").and_then(JsonValue::as_i64).unwrap_or(0) == 1,
                    extra: None,
                    column_type: Some(column_type),
                    comment: None,
                }
            })
            .collect::<Vec<_>>();

        let idx_rows = self
            .query_objects(&format!(
                "SELECT i.index_name AS name, i.uniqueness, ic.column_name \
                 FROM all_indexes i \
                 JOIN all_ind_columns ic \
                   ON i.owner = ic.index_owner AND i.index_name = ic.index_name \
                 WHERE i.owner = SYS_CONTEXT('USERENV','CURRENT_SCHEMA') \
                   AND i.table_name = {table_literal} \
                 ORDER BY i.index_name, ic.column_position"
            ))
            .await?;

        let mut indexes: Vec<IndexInfo> = Vec::new();
        for row in &idx_rows {
            let index_name = Self::string_field(row, "name").unwrap_or_default();
            let column_name = Self::string_field(row, "column_name").unwrap_or_default();
            let is_unique = Self::string_field(row, "uniqueness")
                .map(|value| value == "UNIQUE")
                .unwrap_or(false);
            if let Some(existing) = indexes.iter_mut().find(|idx| idx.name == index_name) {
                existing.columns.push(column_name);
            } else {
                indexes.push(IndexInfo {
                    name: index_name,
                    columns: vec![column_name],
                    is_unique,
                    index_type: None,
                });
            }
        }

        let fk_rows = self
            .query_objects(&format!(
                "SELECT ac.constraint_name AS name, acc.column_name AS column_name, \
                        r_ac.table_name AS referenced_table, r_acc.column_name AS referenced_column, \
                        ac.delete_rule \
                 FROM all_constraints ac \
                 JOIN all_cons_columns acc \
                   ON ac.owner = acc.owner AND ac.constraint_name = acc.constraint_name \
                 JOIN all_constraints r_ac \
                   ON ac.r_owner = r_ac.owner AND ac.r_constraint_name = r_ac.constraint_name \
                 JOIN all_cons_columns r_acc \
                   ON r_ac.owner = r_acc.owner AND r_ac.constraint_name = r_acc.constraint_name \
                  AND acc.position = r_acc.position \
                 WHERE ac.owner = SYS_CONTEXT('USERENV','CURRENT_SCHEMA') \
                   AND ac.table_name = {table_literal} \
                   AND ac.constraint_type = 'R' \
                 ORDER BY ac.constraint_name, acc.position"
            ))
            .await?;

        let foreign_keys = fk_rows
            .iter()
            .map(|row| ForeignKeyInfo {
                name: Self::string_field(row, "name").unwrap_or_else(|| "fk".to_string()),
                column: Self::string_field(row, "column_name").unwrap_or_default(),
                referenced_table: Self::string_field(row, "referenced_table").unwrap_or_default(),
                referenced_column: Self::string_field(row, "referenced_column").unwrap_or_default(),
                on_update: None,
                on_delete: Self::string_field(row, "delete_rule"),
            })
            .collect::<Vec<_>>();

        let object_type_rows = self
            .query_objects(&format!(
                "SELECT object_type FROM all_objects \
                 WHERE owner = SYS_CONTEXT('USERENV','CURRENT_SCHEMA') \
                   AND object_name = {table_literal} \
                   AND object_type IN ('TABLE','VIEW') \
                   AND ROWNUM = 1"
            ))
            .await?;
        let object_type = object_type_rows
            .first()
            .and_then(|row| Self::string_field(row, "object_type"));

        // `all_views.text` is a LONG column; ORDS serializes it as a string on
        // current versions. If a deployment rejects it the whole structure
        // call fails — a known ORDS limitation, not silently dropped.
        let view_rows = self
            .query_objects(&format!(
                "SELECT text FROM all_views \
                 WHERE owner = SYS_CONTEXT('USERENV','CURRENT_SCHEMA') \
                   AND view_name = {table_literal} AND ROWNUM = 1"
            ))
            .await?;
        let view_definition = view_rows
            .first()
            .and_then(|row| Self::string_field(row, "text"));

        let trigger_rows = self
            .query_objects(&format!(
                "SELECT trigger_name AS name, trigger_type, triggering_event, table_name, \
                        trigger_body \
                 FROM all_triggers \
                 WHERE owner = SYS_CONTEXT('USERENV','CURRENT_SCHEMA') \
                   AND table_name = {table_literal} \
                 ORDER BY trigger_name"
            ))
            .await?;
        let triggers = trigger_rows
            .iter()
            .map(|row| TriggerInfo {
                name: Self::string_field(row, "name").unwrap_or_else(|| "trigger".to_string()),
                timing: Self::string_field(row, "trigger_type"),
                event: Self::string_field(row, "triggering_event"),
                related_table: Self::string_field(row, "table_name"),
                definition: Self::string_field(row, "trigger_body"),
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
            let execution = self.execute_statement(sql, MAX_QUERY_RESULT_ROWS).await?;
            return Ok(Self::execution_to_query_result(
                execution,
                sql.to_string(),
                started_at.elapsed().as_millis(),
            ));
        }

        let mut last_result = None;
        let mut affected_rows = 0u64;
        for statement in statements
            .iter()
            .filter(|statement| !statement.trim().is_empty())
        {
            let execution = self
                .execute_statement(statement, MAX_QUERY_RESULT_ROWS)
                .await?;
            affected_rows += execution.affected_rows;
            if Self::query_returns_rows(statement) {
                last_result = Some(Self::execution_to_query_result(
                    execution,
                    statement.clone(),
                    0,
                ));
            }
        }

        let elapsed = started_at.elapsed().as_millis();
        if let Some(mut result) = last_result {
            result.affected_rows = affected_rows;
            result.execution_time_ms = elapsed;
            return Ok(result);
        }

        Ok(QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            affected_rows,
            execution_time_ms: elapsed,
            query: sql.to_string(),
            sandboxed: false,
            truncated: false,
        })
    }

    async fn execute_parameterized_query(
        &self,
        sql: &str,
        parameters: &[QueryParameter],
    ) -> Result<QueryResult> {
        let started_at = Instant::now();
        let binds = Self::parameters_to_binds(parameters);
        let execution = self
            .execute_statement_binds(sql, &binds, MAX_QUERY_RESULT_ROWS)
            .await?;
        Ok(Self::execution_to_query_result(
            execution,
            sql.to_string(),
            started_at.elapsed().as_millis(),
        ))
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
        let mut sql = format!("SELECT * FROM {}", quote_oracle_identifier(table)?);
        if let Some(filter_clause) = sanitize_oracle_filter_clause(filter)? {
            sql.push_str(&format!(" WHERE {filter_clause}"));
        }
        if let Some(order_column) = order_by {
            let direction = normalize_order_dir(order_dir)?;
            sql.push_str(&format!(
                " ORDER BY {} {}",
                quote_oracle_order_by(order_column)?,
                direction
            ));
        }
        sql.push_str(&format!(
            " OFFSET {offset} ROWS FETCH NEXT {limit} ROWS ONLY"
        ));

        self.execute_query(&sql).await
    }

    async fn count_rows(&self, table: &str, _database: Option<&str>) -> Result<i64> {
        let sql = format!("SELECT COUNT(*) FROM {}", quote_oracle_identifier(table)?);
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
            quote_oracle_identifier(table)?,
            quote_oracle_order_by(column)?,
        );
        let result = self.execute_query(&sql).await?;
        Self::scalar_i64(&result)
    }

    async fn update_table_cell(&self, request: &TableCellUpdateRequest) -> Result<u64> {
        let (sql, values) = Self::build_cell_update_statement(request)?;
        let binds = Self::values_to_binds(&values);
        let execution = self
            .execute_statement_binds(&sql, &binds, MAX_QUERY_RESULT_ROWS)
            .await?;
        Ok(execution.affected_rows)
    }

    /// ORDS cannot hold one transaction open across HTTP requests — every
    /// `/_/sql` call auto-commits — so an edit queue cannot be made atomic
    /// and is rejected rather than partially applied.
    async fn apply_table_updates_atomically(
        &self,
        _updates: &[TableCellUpdateRequest],
    ) -> Result<u64> {
        Err(Self::no_transaction_error("Atomic edit queues"))
    }

    async fn delete_table_rows(&self, request: &TableRowDeleteRequest) -> Result<u64> {
        let (sql, values) = Self::build_row_delete_statement(request)?;
        let binds = Self::values_to_binds(&values);
        let execution = self
            .execute_statement_binds(&sql, &binds, MAX_QUERY_RESULT_ROWS)
            .await?;
        Ok(execution.affected_rows)
    }

    async fn insert_table_row(&self, request: &TableRowInsertRequest) -> Result<u64> {
        let (sql, values) = Self::build_row_insert_statement(request)?;
        let binds = Self::values_to_binds(&values);
        let execution = self
            .execute_statement_binds(&sql, &binds, MAX_QUERY_RESULT_ROWS)
            .await?;
        Ok(execution.affected_rows)
    }

    /// Rejected for the same reason as `apply_table_updates_atomically`:
    /// rows inserted by earlier requests would already be committed before a
    /// later failure or cancel could roll them back.
    async fn insert_table_rows_atomically(
        &self,
        _requests: &[TableRowInsertRequest],
        _cancelled: Arc<AtomicBool>,
    ) -> Result<u64> {
        Err(Self::no_transaction_error("Atomic CSV imports"))
    }

    /// Rejected: a streamed import spans many requests, and ORDS commits
    /// each one independently.
    async fn insert_table_row_stream_atomically(
        &self,
        _rows: tokio::sync::mpsc::Receiver<crate::database::models::CsvImportRow>,
        _cancelled: Arc<AtomicBool>,
    ) -> Result<u64> {
        Err(Self::no_transaction_error("Streaming CSV imports"))
    }

    /// Rejected: preview requires running statements then rolling them back,
    /// and ORDS auto-commits every request.
    async fn preview_write_transaction(&self, _statements: &[String]) -> Result<Vec<QueryResult>> {
        Err(Self::no_transaction_error("Write preview transactions"))
    }

    /// Schema changes run one statement per request through the same ORDS
    /// endpoint. Statements are NOT routed through `execute_query` because
    /// its client-side splitter breaks PL/SQL bodies (`CREATE OR REPLACE`,
    /// triggers) on inner semicolons — ORDS itself parses each payload, so a
    /// single statement (or a caller-supplied script) is sent verbatim.
    async fn execute_structure_statements(&self, statements: &[String]) -> Result<u64> {
        let mut total_affected = 0u64;
        for statement in statements {
            if statement.trim().is_empty() {
                continue;
            }
            total_affected += self
                .execute_statement(statement, MAX_QUERY_RESULT_ROWS)
                .await?
                .affected_rows;
        }
        Ok(total_affected)
    }

    async fn use_database(&self, database: &str) -> Result<()> {
        let trimmed = database.trim();
        if trimmed.is_empty() {
            return Ok(());
        }

        let alias = Self::validate_schema_alias(trimmed)?;
        if let Ok(mut guard) = self.current_schema.write() {
            *guard = alias;
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
        let quoted_table = quote_oracle_identifier(referenced_table)?;
        let quoted_column = quote_oracle_order_by(referenced_column)?;
        let label_expr = if !display_columns.is_empty() {
            let cols = display_columns
                .iter()
                .map(|column| {
                    Ok(format!(
                        "CAST({} AS VARCHAR2(4000))",
                        quote_oracle_order_by(column)?
                    ))
                })
                .collect::<Result<Vec<_>>>()?
                .join(", ");
            format!("COALESCE({cols})")
        } else {
            format!("CAST({quoted_column} AS VARCHAR2(4000))")
        };

        let sql = if let Some(search_term) = search {
            format!(
                "SELECT {quoted_column} AS value, {label_expr} AS label \
                 FROM {quoted_table} \
                 WHERE CAST({quoted_column} AS VARCHAR2(4000)) LIKE {} \
                 ORDER BY {quoted_column} \
                 FETCH FIRST {limit} ROWS ONLY",
                Self::sql_literal(&format!("%{search_term}%"))
            )
        } else {
            format!(
                "SELECT {quoted_column} AS value, {label_expr} AS label \
                 FROM {quoted_table} \
                 ORDER BY {quoted_column} \
                 FETCH FIRST {limit} ROWS ONLY"
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
        Some(self.current_schema_alias())
    }

    fn driver_name(&self) -> &str {
        "Oracle (ORDS)"
    }
}

#[cfg(test)]
mod tests {
    use super::{OracleDriver, OrdsErrorBody, OrdsExecution, OrdsSqlResponse, OrdsStatementResult};
    use crate::database::models::ConnectionConfig;
    use serde_json::json;
    use std::collections::HashMap;

    fn config_with(fields: &[(&str, &str)]) -> ConnectionConfig {
        let mut additional_fields = HashMap::new();
        for (key, value) in fields {
            additional_fields.insert(key.to_string(), value.to_string());
        }
        ConnectionConfig {
            additional_fields,
            ..ConnectionConfig::default()
        }
    }

    #[test]
    fn builds_https_base_url_with_default_port_and_path() {
        let mut config = config_with(&[]);
        config.host = Some("db.example.com".to_string());
        config.use_ssl = true;

        assert_eq!(
            OracleDriver::build_base_url(&config).unwrap(),
            "https://db.example.com:443/ords"
        );
    }

    #[test]
    fn builds_http_base_url_with_custom_port_and_base_path() {
        let mut config = config_with(&[("ords_base_path", "api/ords")]);
        config.host = Some("10.0.0.5".to_string());
        config.port = Some(9090);
        config.use_ssl = false;

        // A multi-segment base path is rejected — it must be one segment.
        assert!(OracleDriver::build_base_url(&config).is_err());

        let mut config = config_with(&[("ords_base_path", "rest")]);
        config.host = Some("10.0.0.5".to_string());
        config.port = Some(9090);
        config.use_ssl = false;

        assert_eq!(
            OracleDriver::build_base_url(&config).unwrap(),
            "http://10.0.0.5:9090/rest"
        );
    }

    #[test]
    fn schema_alias_prefers_extra_field_then_database_then_username() {
        let mut config = config_with(&[("ords_schema", "hr_alias")]);
        config.database = Some("hr_db".to_string());
        assert_eq!(
            OracleDriver::resolve_schema_alias(&config, "scott").unwrap(),
            "hr_alias"
        );

        let mut config = config_with(&[]);
        config.database = Some("hr_db".to_string());
        assert_eq!(
            OracleDriver::resolve_schema_alias(&config, "scott").unwrap(),
            "hr_db"
        );

        let config = config_with(&[]);
        assert_eq!(
            OracleDriver::resolve_schema_alias(&config, "scott").unwrap(),
            "scott"
        );
    }

    #[test]
    fn schema_alias_rejects_path_segments() {
        assert!(OracleDriver::validate_schema_alias("hr").is_ok());
        assert!(OracleDriver::validate_schema_alias("hr/admin").is_err());
        assert!(OracleDriver::validate_schema_alias("hr?x=1").is_err());
        assert!(OracleDriver::validate_schema_alias("  ").is_err());
    }

    #[test]
    fn oracle_identifiers_quote_and_uppercase() {
        use crate::database::safety::quote_oracle_identifier;
        assert_eq!(
            quote_oracle_identifier("employees").unwrap(),
            "\"EMPLOYEES\""
        );
        assert_eq!(quote_oracle_identifier("we\"ird").unwrap(), "\"WE\"\"IRD\"");
        assert!(quote_oracle_identifier("   ").is_err());
    }

    #[test]
    fn parses_ords_response_envelope() {
        // Real ORDS shape: one item per statement; query rows nest under
        // `resultSet` and DML counts arrive in `result`.
        let body = r#"{
            "env": {"defaultTimeZone": "Europe/London"},
            "items": [{
                "statementId": 1,
                "statementType": "query",
                "result": 0,
                "resultSet": {
                    "metadata": [
                        {"columnName": "ID", "jsonColumnName": "id",
                         "columnTypeName": "NUMBER", "isNullable": 0},
                        {"columnName": "NAME", "jsonColumnName": "name",
                         "columnTypeName": "VARCHAR2", "isNullable": 1}
                    ],
                    "items": [{"id": 1, "name": "a"}, {"id": 2, "name": "b"}],
                    "hasMore": true,
                    "count": 2,
                    "limit": 500,
                    "offset": 0
                }
            }]
        }"#;
        let page: OrdsSqlResponse = serde_json::from_str(body).unwrap();
        assert_eq!(page.items.len(), 1);
        let result_set = page.items[0].result_set.as_ref().unwrap();
        assert_eq!(result_set.items.len(), 2);
        assert!(result_set.has_more);
        assert_eq!(result_set.metadata.len(), 2);
    }

    #[test]
    fn statement_item_reports_dml_result_and_errors() {
        let dml: OrdsStatementResult = serde_json::from_str(
            r#"{"statementType": "dml", "result": 14, "response": ["\n14 rows updated.\n\n"]}"#,
        )
        .unwrap();
        assert_eq!(OracleDriver::affected_rows(&dml), 14);
        assert!(OracleDriver::statement_error(&dml).is_none());

        let batch: OrdsStatementResult =
            serde_json::from_str(r#"{"statementType": "dml", "result": [1, 1, 2]}"#).unwrap();
        assert_eq!(OracleDriver::affected_rows(&batch), 4);

        // Statement failures arrive inside the item even on HTTP 200.
        let failed: OrdsStatementResult = serde_json::from_str(
            r#"{"errorCode": 942, "errorDetails": "ORA-00942: table or view does not exist",
                "result": 0}"#,
        )
        .unwrap();
        let message = OracleDriver::statement_error(&failed).unwrap();
        assert!(message.contains("942"));
        assert!(message.contains("ORA-00942"));
    }

    #[test]
    fn row_objects_map_to_query_result_preserving_column_order() {
        // serde_json's preserve_order feature keeps the emitted key order;
        // without it Map is a BTreeMap and "z_col" would sort before "a_col"
        // alphabetically — this test pins the ORDS column contract for the
        // metadata-less fallback path.
        let first: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(r#"{"z_col": 1, "a_col": "x", "m_col": null}"#).unwrap();
        let second: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(r#"{"z_col": 2, "a_col": "y", "m_col": 5, "extra": true}"#)
                .unwrap();

        let result = OracleDriver::execution_to_query_result(
            OrdsExecution {
                rows: vec![first, second],
                ..OrdsExecution::default()
            },
            "SELECT * FROM t".to_string(),
            7,
        );

        let names: Vec<&str> = result.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["z_col", "a_col", "m_col", "extra"]);
        assert_eq!(
            result.rows[0],
            vec![json!(1), json!("x"), json!(null), json!(null)]
        );
        assert_eq!(
            result.rows[1],
            vec![json!(2), json!("y"), json!(5), json!(true)]
        );
        assert!(!result.truncated);
    }

    #[test]
    fn result_set_metadata_drives_column_info() {
        let result_set: super::OrdsResultSet = serde_json::from_str(
            r#"{
                "metadata": [
                    {"columnName": "ID", "jsonColumnName": "id",
                     "columnTypeName": "NUMBER", "isNullable": 0},
                    {"columnName": "NAME", "columnTypeName": "VARCHAR2", "isNullable": 1}
                ],
                "items": [],
                "hasMore": false
            }"#,
        )
        .unwrap();

        let columns = OracleDriver::result_set_columns(&result_set);
        assert_eq!(columns.len(), 2);
        assert_eq!(columns[0].name, "id");
        assert_eq!(columns[0].data_type, "NUMBER");
        assert!(!columns[0].is_nullable);
        // No jsonColumnName: falls back to columnName.
        assert_eq!(columns[1].name, "NAME");
        assert!(columns[1].is_nullable);
    }

    #[test]
    fn error_envelope_extracts_ords_error_fields() {
        let body = r#"{
            "code": "ORA-00942",
            "message": "table or view does not exist",
            "title": "Bad Request",
            "o:errorCode": "ORDS-22001",
            "o:errorDetails": [{"message": "SQL error"}]
        }"#;
        let parsed: OrdsErrorBody = serde_json::from_str(body).unwrap();
        assert_eq!(parsed.code.as_deref(), Some("ORA-00942"));
        assert_eq!(parsed.error_code.as_deref(), Some("ORDS-22001"));
    }

    #[test]
    fn error_message_prefers_detail_and_code() {
        let message = OracleDriver::error_message(
            reqwest::StatusCode::BAD_REQUEST,
            r#"{"code":"ORA-00942","message":"table or view does not exist"}"#,
        );
        assert_eq!(
            message,
            "Oracle ORDS error ORA-00942: table or view does not exist"
        );

        let fallback = OracleDriver::error_message(
            reqwest::StatusCode::INTERNAL_SERVER_ERROR,
            "gateway exploded",
        );
        assert!(fallback.contains("500"));
        assert!(fallback.contains("gateway exploded"));
    }

    #[test]
    fn parameters_map_to_positional_ords_binds() {
        use crate::database::models::{QueryParameter, QueryParameterType};

        let parameters = vec![
            QueryParameter {
                name: "name".to_string(),
                value: json!("O'Reilly"),
                data_type: QueryParameterType::Text,
            },
            QueryParameter {
                name: "count".to_string(),
                value: json!(42),
                data_type: QueryParameterType::Integer,
            },
            QueryParameter {
                name: "active".to_string(),
                value: json!(true),
                data_type: QueryParameterType::Boolean,
            },
            QueryParameter {
                name: "payload".to_string(),
                value: json!({"id": 1}),
                data_type: QueryParameterType::Json,
            },
            QueryParameter {
                name: "missing".to_string(),
                value: json!(null),
                data_type: QueryParameterType::Null,
            },
        ];

        let binds = serde_json::to_value(OracleDriver::parameters_to_binds(&parameters))
            .expect("binds serialize");

        assert_eq!(
            binds,
            json!([
                {"index": 1, "data_type": "VARCHAR2", "value": "O'Reilly"},
                {"index": 2, "data_type": "NUMBER", "value": 42},
                {"index": 3, "data_type": "NUMBER", "value": 1},
                {"index": 4, "data_type": "VARCHAR2", "value": "{\"id\":1}"},
                {"index": 5, "data_type": "VARCHAR2", "value": null},
            ])
        );
    }
    #[test]
    fn cell_update_builds_bound_statement() {
        use crate::database::models::{RowKeyValue, TableCellUpdateRequest};

        let request = TableCellUpdateRequest {
            table: "employees".to_string(),
            database: Some("hr".to_string()),
            target_column: "salary".to_string(),
            value: json!(9500),
            primary_keys: vec![
                RowKeyValue {
                    column: "employee_id".to_string(),
                    value: json!(42),
                },
                RowKeyValue {
                    column: "archived_at".to_string(),
                    value: json!(null),
                },
            ],
        };

        let (sql, values) = OracleDriver::build_cell_update_statement(&request).unwrap();
        assert_eq!(
            sql,
            "UPDATE \"HR\".\"EMPLOYEES\" SET \"SALARY\" = ? \
             WHERE \"EMPLOYEE_ID\" = ? AND \"ARCHIVED_AT\" IS NULL"
        );
        // NULL keys become IS NULL predicates and carry no bind value.
        assert_eq!(values, vec![json!(9500), json!(42)]);

        let binds = serde_json::to_value(OracleDriver::values_to_binds(&values)).unwrap();
        assert_eq!(
            binds,
            json!([
                {"index": 1, "data_type": "NUMBER", "value": 9500},
                {"index": 2, "data_type": "NUMBER", "value": 42},
            ])
        );
    }

    #[test]
    fn cell_update_requires_primary_keys() {
        use crate::database::models::TableCellUpdateRequest;

        let request = TableCellUpdateRequest {
            table: "t".to_string(),
            database: None,
            target_column: "c".to_string(),
            value: json!(1),
            primary_keys: vec![],
        };
        assert!(OracleDriver::build_cell_update_statement(&request).is_err());
    }

    #[test]
    fn row_delete_builds_or_predicates_with_binds() {
        use crate::database::models::{RowKeyValue, TableRowDeleteRequest};

        let request = TableRowDeleteRequest {
            table: "orders".to_string(),
            database: None,
            rows: vec![
                vec![RowKeyValue {
                    column: "id".to_string(),
                    value: json!(7),
                }],
                vec![
                    RowKeyValue {
                        column: "id".to_string(),
                        value: json!(9),
                    },
                    RowKeyValue {
                        column: "note".to_string(),
                        value: json!(null),
                    },
                ],
            ],
        };

        let (sql, values) = OracleDriver::build_row_delete_statement(&request).unwrap();
        assert_eq!(
            sql,
            "DELETE FROM \"ORDERS\" WHERE (\"ID\" = ?) OR (\"ID\" = ? AND \"NOTE\" IS NULL)"
        );
        assert_eq!(values, vec![json!(7), json!(9)]);
    }

    #[test]
    fn row_insert_builds_bound_statement() {
        use crate::database::models::TableRowInsertRequest;

        let request = TableRowInsertRequest {
            table: "employees".to_string(),
            database: None,
            values: vec![
                ("name".to_string(), json!("O'Reilly")),
                ("active".to_string(), json!(true)),
                ("meta".to_string(), json!({"a": 1})),
                ("deleted_at".to_string(), json!(null)),
            ],
        };

        let (sql, values) = OracleDriver::build_row_insert_statement(&request).unwrap();
        assert_eq!(
            sql,
            "INSERT INTO \"EMPLOYEES\" (\"NAME\", \"ACTIVE\", \"META\", \"DELETED_AT\") \
             VALUES (?, ?, ?, ?)"
        );
        assert_eq!(values.len(), 4);

        // Booleans bind as NUMBER 1/0; objects serialize to VARCHAR2 text;
        // null binds as a VARCHAR2 NULL.
        let binds = serde_json::to_value(OracleDriver::values_to_binds(&values)).unwrap();
        assert_eq!(
            binds,
            json!([
                {"index": 1, "data_type": "VARCHAR2", "value": "O'Reilly"},
                {"index": 2, "data_type": "NUMBER", "value": 1},
                {"index": 3, "data_type": "VARCHAR2", "value": "{\"a\":1}"},
                {"index": 4, "data_type": "VARCHAR2", "value": null},
            ])
        );
    }

    #[test]
    fn qualified_table_name_quotes_schema_and_table() {
        assert_eq!(
            OracleDriver::qualified_table_name("employees", Some("hr")).unwrap(),
            "\"HR\".\"EMPLOYEES\""
        );
        assert_eq!(
            OracleDriver::qualified_table_name("hr.employees", None).unwrap(),
            "\"HR\".\"EMPLOYEES\""
        );
        assert!(OracleDriver::qualified_table_name("a.b.c", None).is_err());
    }
}
