//! Google Cloud Spanner driver over the REST API (`spanner.googleapis.com`).
//!
//! Auth is a Google OAuth2 access token carried in the connection password
//! field and sent as `Authorization: Bearer <token>`. The host field carries
//! the instance resource path `projects/<p>/instances/<i>`; the database field
//! carries the database id. Queries run through lazily-created Spanner
//! sessions (`POST {database}/sessions` then `POST {session}:executeSql`).
//! Deleting the session aborts its in-flight statements, which is how
//! `cancel_query_request` reaches the server.
//!
//! Only the GoogleSQL dialect is supported (backtick identifiers,
//! `@param` binds, `INFORMATION_SCHEMA` in GoogleSQL shape).

use super::driver::DatabaseDriver;
use super::models::*;
use super::query_cancel::{request_cancel, CancelLookup, CancelScopeGuard, QueryCancelRegistry};
use super::query_common::{statement_returns_rows, MAX_QUERY_RESULT_ROWS};
use super::safety::{
    normalize_order_dir, quote_bigquery_identifier, quote_bigquery_order_by,
    sanitize_bigquery_filter_clause,
};
use crate::utils::sql::split_sql_statements;
use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use reqwest::{Client, RequestBuilder};
use serde_json::{json, Map, Value as JsonValue};
use std::collections::HashSet;
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Instant;
use tokio::sync::RwLock as AsyncRwLock;

const SPANNER_API_BASE: &str = "https://spanner.googleapis.com";
/// `updateDatabaseDdl` returns a long-running operation; poll it briefly so
/// schema edits report success/failure instead of "operation started".
const DDL_POLL_ATTEMPTS: u32 = 120;
const DDL_POLL_INTERVAL_MS: u64 = 1_000;

/// Marker error for HTTP 404 `Session not found` responses so the execute
/// path can recreate the session once and retry instead of failing.
#[derive(Debug)]
struct SessionNotFound;

impl fmt::Display for SessionNotFound {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Spanner session not found")
    }
}

impl std::error::Error for SessionNotFound {}

fn is_session_not_found(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| cause.is::<SessionNotFound>())
}

/// Live Spanner session bound to the database path it was created on.
struct SpannerSession {
    database_path: String,
    name: String,
}

/// Positional `@pN` binds accumulated while building one statement.
#[derive(Default)]
struct SpannerBinds {
    params: Map<String, JsonValue>,
    param_types: Map<String, JsonValue>,
    next_index: usize,
}

impl SpannerBinds {
    /// Bind `value` as `@pN` and return the placeholder text for the SQL.
    fn push(&mut self, value: &JsonValue) -> Result<String> {
        self.next_index += 1;
        let name = format!("p{}", self.next_index);
        let (bound, code) = SpannerDriver::spanner_bind_value(value)?;
        self.params.insert(name.clone(), bound);
        self.param_types
            .insert(name.clone(), json!({ "code": code }));
        Ok(format!("@{name}"))
    }

    fn is_empty(&self) -> bool {
        self.params.is_empty()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StatementKind {
    Query,
    Dml,
    Ddl,
    Other,
}

pub struct SpannerDriver {
    client: Client,
    base_url: String,
    access_token: String,
    /// `projects/<p>/instances/<i>` from the host field.
    instance_path: String,
    /// `projects/<p>/instances/<i>/databases/<d>` for the current database.
    database_path: RwLock<String>,
    current_db: Arc<RwLock<Option<String>>>,
    /// Lazily-created session; `None` until the first query or after a
    /// cancel/disconnect deletes it server-side.
    session: AsyncRwLock<Option<SpannerSession>>,
    /// request_id → running-query scope so `cancel_query_request` can delete
    /// the session while a statement is in flight.
    cancel_registry: RwLock<QueryCancelRegistry>,
}

impl SpannerDriver {
    pub async fn connect(config: &ConnectionConfig) -> Result<Self> {
        let access_token = config
            .password
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .context("Spanner requires a Google OAuth2 access token in the password field")?
            .to_string();
        let instance_path = config
            .host
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .context("Spanner host must be the instance path projects/<p>/instances/<i>")?;
        let database = config
            .database
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .context("Spanner database name is required")?;
        let instance_path = instance_path.trim_matches('/').to_string();
        if !instance_path.starts_with("projects/") || !instance_path.contains("/instances/") {
            return Err(anyhow!(
                "Spanner host must be the instance path projects/<p>/instances/<i>"
            ));
        }
        let database_path = format!("{instance_path}/databases/{}", database.trim());
        // Standard emulator override: SPANNER_EMULATOR_HOST points the REST
        // calls at a local emulator instead of spanner.googleapis.com.
        let base_url = std::env::var("SPANNER_EMULATOR_HOST")
            .ok()
            .map(|value| value.trim().trim_end_matches('/').to_string())
            .filter(|value| !value.is_empty())
            .map(|value| {
                if value.starts_with("http://") || value.starts_with("https://") {
                    value
                } else {
                    format!("http://{value}")
                }
            })
            .unwrap_or_else(|| SPANNER_API_BASE.to_string());

        Ok(Self {
            client: Client::builder()
                .build()
                .context("Failed to initialize Spanner HTTP client")?,
            base_url,
            access_token,
            instance_path,
            database_path: RwLock::new(database_path),
            current_db: Arc::new(RwLock::new(Some(database.to_string()))),
            session: AsyncRwLock::new(None),
            cancel_registry: RwLock::new(QueryCancelRegistry::new()),
        })
    }

    fn sessions_url(base_url: &str, database_path: &str) -> String {
        format!("{base_url}/v1/{database_path}/sessions")
    }

    fn execute_sql_url(base_url: &str, session_name: &str) -> String {
        format!("{base_url}/v1/{session_name}:executeSql")
    }

    fn update_ddl_url(base_url: &str, database_path: &str) -> String {
        format!("{base_url}/v1/{database_path}/ddl")
    }

    fn databases_url(base_url: &str, instance_path: &str) -> String {
        format!("{base_url}/v1/{instance_path}/databases")
    }

    fn session_delete_url(base_url: &str, session_name: &str) -> String {
        format!("{base_url}/v1/{session_name}")
    }

    fn operation_url(base_url: &str, operation_name: &str) -> String {
        format!("{base_url}/v1/{operation_name}")
    }

    fn database_url(base_url: &str, database_path: &str) -> String {
        format!("{base_url}/v1/{database_path}")
    }

    fn current_database_path(&self) -> Result<String> {
        self.database_path
            .read()
            .map(|guard| guard.clone())
            .map_err(|_| anyhow!("Failed to access Spanner database state"))
    }

    /// Resolve the database path for one call: `None` uses the current
    /// database, an override builds `…/databases/<name>` after validation.
    fn database_path_for(&self, database: Option<&str>) -> Result<String> {
        match database.map(str::trim).filter(|value| !value.is_empty()) {
            Some(name) => {
                Self::validate_database_name(name)?;
                Ok(format!("{}/databases/{name}", self.instance_path))
            }
            None => self.current_database_path(),
        }
    }

    /// Spanner database ids become URL path segments; reject anything that
    /// could escape the resource path or break the request.
    fn validate_database_name(name: &str) -> Result<()> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err(anyhow!("Spanner database name cannot be empty"));
        }
        if trimmed
            .chars()
            .any(|ch| matches!(ch, '/' | '\\' | '\0' | '\r' | '\n' | '\t' | ' '))
        {
            return Err(anyhow!("Spanner database name contains invalid characters"));
        }
        Ok(())
    }

    /// Send one authenticated request and decode the JSON body. Non-2xx
    /// responses surface the Spanner `error.message` payload; a 404 whose body
    /// reports a missing session maps to [`SessionNotFound`] so callers can
    /// recreate and retry.
    async fn send_checked(&self, request: RequestBuilder) -> Result<JsonValue> {
        let response = request
            .bearer_auth(&self.access_token)
            .send()
            .await
            .context("Failed to reach Spanner endpoint")?;
        let status = response.status();
        let body = response
            .text()
            .await
            .context("Failed to read Spanner response")?;

        if !status.is_success() {
            let message = serde_json::from_str::<JsonValue>(&body)
                .ok()
                .and_then(|value| {
                    value
                        .get("error")
                        .and_then(|error| error.get("message"))
                        .and_then(|message| message.as_str())
                        .map(str::to_string)
                })
                .unwrap_or_else(|| body.trim().to_string());
            if status.as_u16() == 404 && message.to_ascii_lowercase().contains("session not found")
            {
                return Err(SessionNotFound.into());
            }
            bail!(
                "Spanner request failed with status {}: {}",
                status.as_u16(),
                message
            );
        }

        if body.trim().is_empty() {
            return Ok(JsonValue::Null);
        }
        serde_json::from_str(&body).context("Failed to parse Spanner JSON response")
    }

    /// Return the stored session for `database_path`, creating one when absent
    /// or bound to a different database.
    async fn ensure_session(&self, database_path: &str) -> Result<String> {
        {
            let guard = self.session.read().await;
            if let Some(session) = guard.as_ref() {
                if session.database_path == database_path {
                    return Ok(session.name.clone());
                }
            }
        }

        let mut guard = self.session.write().await;
        if let Some(session) = guard.as_ref() {
            if session.database_path == database_path {
                return Ok(session.name.clone());
            }
        }

        let url = Self::sessions_url(&self.base_url, database_path);
        let response = self
            .send_checked(self.client.post(&url).json(&json!({})))
            .await
            .context("Failed to create Spanner session")?;
        let name = response
            .get("name")
            .and_then(|value| value.as_str())
            .map(str::to_string)
            .context("Spanner session response did not include a session name")?;
        *guard = Some(SpannerSession {
            database_path: database_path.to_string(),
            name: name.clone(),
        });
        Ok(name)
    }

    /// Clear the stored session only when it still holds `expected`, so a
    /// retry never drops a session another caller just created.
    async fn drop_session_if(&self, expected: &str) {
        let mut guard = self.session.write().await;
        if guard
            .as_ref()
            .is_some_and(|session| session.name == expected)
        {
            *guard = None;
        }
    }

    /// DELETE the stored session. Returns whether a session existed; a
    /// server-side 404 is treated as already gone.
    async fn delete_session(&self) -> Result<bool> {
        let session = self.session.write().await.take();
        let Some(session) = session else {
            return Ok(false);
        };
        let result = self
            .send_checked(
                self.client
                    .delete(Self::session_delete_url(&self.base_url, &session.name)),
            )
            .await;
        match result {
            Ok(_) => Ok(true),
            Err(error) if is_session_not_found(&error) => Ok(true),
            Err(error) => Err(error).context("Failed to delete Spanner session"),
        }
    }

    /// One `executeSql` call against an already-resolved session.
    async fn execute_sql_on(
        &self,
        session_name: &str,
        sql: &str,
        binds: Option<&SpannerBinds>,
        row_cap: usize,
    ) -> Result<QueryResult> {
        let mut body = json!({ "sql": sql });
        if Self::statement_kind(sql) == StatementKind::Dml {
            // DML must run inside a read-write transaction; singleUse commits
            // the statement on success.
            body["transaction"] = json!({ "singleUse": { "readWrite": {} } });
        }
        if let Some(binds) = binds.filter(|binds| !binds.is_empty()) {
            body["params"] = JsonValue::Object(binds.params.clone());
            body["paramTypes"] = JsonValue::Object(binds.param_types.clone());
        }

        let started = Instant::now();
        let response = self
            .send_checked(
                self.client
                    .post(Self::execute_sql_url(&self.base_url, session_name))
                    .json(&body),
            )
            .await?;
        Ok(Self::result_from_execute_sql(
            response,
            started.elapsed().as_millis(),
            sql.to_string(),
            row_cap,
        ))
    }

    /// `executeSql` with one session-not-found retry: the stored session is
    /// dropped, recreated, and the statement sent once more. When the cancel
    /// flag is set the session was deleted by `cancel_query_request`, so the
    /// query must not be resurrected.
    async fn execute_sql_with_retry(
        &self,
        sql: &str,
        binds: Option<&SpannerBinds>,
        database: Option<&str>,
        cancel_flag: Option<&AtomicBool>,
        row_cap: usize,
    ) -> Result<QueryResult> {
        let database_path = self.database_path_for(database)?;
        let session_name = self.ensure_session(&database_path).await?;
        match self
            .execute_sql_on(&session_name, sql, binds, row_cap)
            .await
        {
            Ok(result) => Ok(result),
            Err(error) if is_session_not_found(&error) => {
                if cancel_flag.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
                    return Err(anyhow!("Query cancelled."));
                }
                self.drop_session_if(&session_name).await;
                let session_name = self.ensure_session(&database_path).await?;
                if cancel_flag.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
                    return Err(anyhow!("Query cancelled."));
                }
                self.execute_sql_on(&session_name, sql, binds, row_cap)
                    .await
            }
            Err(error) => Err(error),
        }
    }

    async fn execute_sql(
        &self,
        sql: &str,
        binds: Option<&SpannerBinds>,
        database: Option<&str>,
    ) -> Result<QueryResult> {
        self.execute_sql_with_retry(sql, binds, database, None, MAX_QUERY_RESULT_ROWS)
            .await
    }

    /// Run DDL through `updateDatabaseDdl` and poll the returned operation
    /// until it resolves so callers see the real outcome.
    async fn execute_ddl(&self, statements: &[String]) -> Result<()> {
        let database_path = self.current_database_path()?;
        let url = Self::update_ddl_url(&self.base_url, &database_path);
        let response = self
            .send_checked(
                self.client
                    .post(&url)
                    .json(&json!({ "statements": statements })),
            )
            .await
            .context("Spanner DDL request failed")?;

        let Some(operation_name) = response
            .get("name")
            .and_then(|value| value.as_str())
            .map(str::to_string)
        else {
            // Synchronous completion (no operation handle): nothing to poll.
            return Ok(());
        };

        for attempt in 0..DDL_POLL_ATTEMPTS {
            if attempt > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(DDL_POLL_INTERVAL_MS)).await;
            }
            let operation = self
                .send_checked(
                    self.client
                        .get(Self::operation_url(&self.base_url, &operation_name)),
                )
                .await
                .context("Failed to poll Spanner DDL operation")?;
            if operation
                .get("done")
                .and_then(|value| value.as_bool())
                .unwrap_or(false)
            {
                if let Some(error) = operation.get("error") {
                    let message = error
                        .get("message")
                        .and_then(|value| value.as_str())
                        .unwrap_or("unknown error");
                    bail!("Spanner DDL operation failed: {message}");
                }
                return Ok(());
            }
        }
        bail!("Spanner DDL operation did not finish within the polling window")
    }

    fn statement_kind(sql: &str) -> StatementKind {
        if statement_returns_rows(sql, &["SELECT", "WITH"]) {
            return StatementKind::Query;
        }
        if statement_returns_rows(sql, &["INSERT", "UPDATE", "DELETE"]) {
            return StatementKind::Dml;
        }
        if statement_returns_rows(
            sql,
            &[
                "CREATE", "ALTER", "DROP", "RENAME", "GRANT", "REVOKE", "ANALYZE",
            ],
        ) {
            return StatementKind::Ddl;
        }
        StatementKind::Other
    }

    /// Map one `executeSql` response to a `QueryResult`: row values are
    /// converted through the declared Spanner type codes, DML row counts come
    /// from `stats.rowCountExact`/`rowCountLowerBound`.
    fn result_from_execute_sql(
        response: JsonValue,
        elapsed_ms: u128,
        query: String,
        row_cap: usize,
    ) -> QueryResult {
        let fields = response
            .get("metadata")
            .and_then(|metadata| metadata.get("rowType"))
            .and_then(|row_type| row_type.get("fields"))
            .and_then(|fields| fields.as_array())
            .cloned()
            .unwrap_or_default();

        let columns = fields
            .iter()
            .map(|field| ColumnInfo {
                name: field
                    .get("name")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string(),
                data_type: Self::spanner_type_name(field.get("type")),
                is_nullable: true,
                is_primary_key: false,
                max_length: None,
                default_value: None,
            })
            .collect::<Vec<_>>();

        let mut truncated = false;
        let mut rows = Vec::new();
        if let Some(raw_rows) = response.get("rows").and_then(|rows| rows.as_array()) {
            for raw_row in raw_rows {
                if rows.len() >= row_cap {
                    truncated = true;
                    break;
                }
                let values = raw_row.as_array().cloned().unwrap_or_default();
                rows.push(
                    values
                        .iter()
                        .enumerate()
                        .map(|(index, value)| {
                            Self::spanner_value_to_json(
                                value,
                                fields.get(index).and_then(|field| field.get("type")),
                            )
                        })
                        .collect::<Vec<_>>(),
                );
            }
        }

        let affected_rows = response
            .get("stats")
            .and_then(|stats| {
                stats
                    .get("rowCountExact")
                    .or_else(|| stats.get("rowCountLowerBound"))
            })
            .and_then(Self::json_to_u64)
            .unwrap_or(0);

        QueryResult {
            columns,
            rows,
            affected_rows,
            execution_time_ms: elapsed_ms,
            query,
            sandboxed: false,
            truncated,
        }
    }

    fn json_to_u64(value: &JsonValue) -> Option<u64> {
        value
            .as_u64()
            .or_else(|| value.as_i64().and_then(|raw| u64::try_from(raw).ok()))
            .or_else(|| value.as_str().and_then(|raw| raw.parse::<u64>().ok()))
    }

    /// Convert one wire value using its declared Spanner type code. INT64 and
    /// NUMERIC arrive as strings (precision-safe); FLOAT64/FLOAT32 may arrive
    /// as numbers or the strings "NaN"/"Infinity"/"-Infinity".
    fn spanner_value_to_json(value: &JsonValue, type_info: Option<&JsonValue>) -> JsonValue {
        if value.is_null() {
            return JsonValue::Null;
        }
        let code = type_info
            .and_then(|info| info.get("code"))
            .and_then(|code| code.as_str())
            .unwrap_or_default();

        match code {
            "INT64" => value
                .as_str()
                .and_then(|raw| raw.parse::<i64>().ok())
                .map(JsonValue::from)
                .unwrap_or_else(|| value.clone()),
            "FLOAT64" | "FLOAT32" => {
                if let Some(number) = value.as_f64() {
                    JsonValue::from(number)
                } else if let Some(raw) = value.as_str() {
                    match raw.parse::<f64>() {
                        Ok(parsed) if parsed.is_finite() => JsonValue::from(parsed),
                        // Keep non-finite sentinels ("NaN", "Infinity") as
                        // strings — serde_json cannot represent them.
                        _ => value.clone(),
                    }
                } else {
                    value.clone()
                }
            }
            "BOOL" => value
                .as_bool()
                .map(JsonValue::from)
                .unwrap_or_else(|| value.clone()),
            "ARRAY" => {
                let element_type = type_info.and_then(|info| info.get("arrayElementType"));
                match value.as_array() {
                    Some(elements) => JsonValue::Array(
                        elements
                            .iter()
                            .map(|element| Self::spanner_value_to_json(element, element_type))
                            .collect(),
                    ),
                    None => value.clone(),
                }
            }
            "STRUCT" => {
                let fields = type_info
                    .and_then(|info| info.get("structType"))
                    .and_then(|struct_type| struct_type.get("fields"))
                    .and_then(|fields| fields.as_array());
                match (value.as_array(), fields) {
                    (Some(values), Some(fields)) => {
                        let mut object = Map::new();
                        for (index, item) in values.iter().enumerate() {
                            let field = fields.get(index);
                            let name = field
                                .and_then(|field| field.get("name"))
                                .and_then(|name| name.as_str())
                                .map(str::to_string)
                                .unwrap_or_else(|| format!("field_{}", index + 1));
                            object.insert(
                                name,
                                Self::spanner_value_to_json(
                                    item,
                                    field.and_then(|field| field.get("type")),
                                ),
                            );
                        }
                        JsonValue::Object(object)
                    }
                    _ => value.clone(),
                }
            }
            // STRING, JSON, BYTES (base64), DATE, TIMESTAMP, NUMERIC and
            // unknown codes pass through unchanged.
            _ => value.clone(),
        }
    }

    /// Render a Spanner type descriptor for column metadata, e.g.
    /// `ARRAY<INT64>` or `STRUCT<a:STRING,b:BOOL>`.
    fn spanner_type_name(type_info: Option<&JsonValue>) -> String {
        let Some(type_info) = type_info else {
            return "UNKNOWN".to_string();
        };
        let code = type_info
            .get("code")
            .and_then(|code| code.as_str())
            .unwrap_or("UNKNOWN");
        match code {
            "ARRAY" => format!(
                "ARRAY<{}>",
                Self::spanner_type_name(type_info.get("arrayElementType"))
            ),
            "STRUCT" => {
                let fields = type_info
                    .get("structType")
                    .and_then(|struct_type| struct_type.get("fields"))
                    .and_then(|fields| fields.as_array())
                    .map(|fields| {
                        fields
                            .iter()
                            .map(|field| {
                                let name = field
                                    .get("name")
                                    .and_then(|name| name.as_str())
                                    .unwrap_or_default();
                                let inner = Self::spanner_type_name(field.get("type"));
                                if name.is_empty() {
                                    inner
                                } else {
                                    format!("{name}:{inner}")
                                }
                            })
                            .collect::<Vec<_>>()
                            .join(",")
                    })
                    .unwrap_or_default();
                format!("STRUCT<{fields}>")
            }
            _ => code.to_string(),
        }
    }

    /// Spanner binds INT64 and NUMERIC parameters as strings; JSON parameters
    /// carry the serialized document.
    fn spanner_param_binding(parameter: &QueryParameter) -> Result<(JsonValue, &'static str)> {
        match &parameter.value {
            JsonValue::Null => {
                let code = match parameter.data_type {
                    QueryParameterType::Integer => "INT64",
                    QueryParameterType::Decimal => "FLOAT64",
                    QueryParameterType::Boolean => "BOOL",
                    QueryParameterType::Json => "JSON",
                    QueryParameterType::Text | QueryParameterType::Null => "STRING",
                };
                Ok((JsonValue::Null, code))
            }
            JsonValue::Bool(value) => Ok((JsonValue::Bool(*value), "BOOL")),
            JsonValue::Number(value) => {
                if value.as_i64().is_some() || value.as_u64().is_some() {
                    Ok((JsonValue::String(value.to_string()), "INT64"))
                } else {
                    Ok((JsonValue::Number(value.clone()), "FLOAT64"))
                }
            }
            JsonValue::String(value) => {
                if parameter.data_type == QueryParameterType::Json {
                    Ok((JsonValue::String(value.clone()), "JSON"))
                } else {
                    Ok((JsonValue::String(value.clone()), "STRING"))
                }
            }
            JsonValue::Array(_) | JsonValue::Object(_)
                if parameter.data_type == QueryParameterType::Json =>
            {
                Ok((
                    JsonValue::String(serde_json::to_string(&parameter.value)?),
                    "JSON",
                ))
            }
            _ => Err(anyhow!(
                "Spanner parameters only support string, number, boolean, JSON, and null values"
            )),
        }
    }

    /// Bind a raw JSON value for driver-built DML (`@pN` placeholders).
    /// Structured values travel as JSON documents; null is never bound here —
    /// callers emit a literal `NULL` so the column type resolves it.
    fn spanner_bind_value(value: &JsonValue) -> Result<(JsonValue, &'static str)> {
        match value {
            JsonValue::Null => Err(anyhow!(
                "Spanner null values must be written as a literal NULL"
            )),
            JsonValue::Bool(value) => Ok((JsonValue::Bool(*value), "BOOL")),
            JsonValue::Number(value) => {
                if value.as_i64().is_some() || value.as_u64().is_some() {
                    Ok((JsonValue::String(value.to_string()), "INT64"))
                } else {
                    Ok((JsonValue::Number(value.clone()), "FLOAT64"))
                }
            }
            JsonValue::String(value) => Ok((JsonValue::String(value.clone()), "STRING")),
            JsonValue::Array(_) | JsonValue::Object(_) => {
                Ok((JsonValue::String(serde_json::to_string(value)?), "JSON"))
            }
        }
    }

    /// Rewrite positional `?` markers (outside literals and comments) to
    /// Spanner `@pN` named parameters and build the `params`/`paramTypes`
    /// maps. `parameters` is ordered to match marker positions.
    fn rewrite_spanner_placeholders(
        sql: &str,
        parameters: &[QueryParameter],
    ) -> Result<(String, SpannerBinds)> {
        let chars = sql.chars().collect::<Vec<_>>();
        let mut output = String::with_capacity(sql.len());
        let mut binds = SpannerBinds::default();
        let mut index = 0;
        let mut state = SpannerScanState::Normal;

        while index < chars.len() {
            let current = chars[index];
            match state {
                SpannerScanState::Normal => {
                    if current == '-' && chars.get(index + 1) == Some(&'-') {
                        output.push_str("--");
                        index += 2;
                        state = SpannerScanState::LineComment;
                        continue;
                    }
                    if current == '#' {
                        output.push(current);
                        index += 1;
                        state = SpannerScanState::LineComment;
                        continue;
                    }
                    if current == '/' && chars.get(index + 1) == Some(&'*') {
                        output.push_str("/*");
                        index += 2;
                        state = SpannerScanState::BlockComment;
                        continue;
                    }
                    if current == '\'' {
                        output.push(current);
                        index += 1;
                        state = SpannerScanState::SingleQuote;
                        continue;
                    }
                    if current == '"' {
                        output.push(current);
                        index += 1;
                        state = SpannerScanState::DoubleQuote;
                        continue;
                    }
                    if current == '`' {
                        output.push(current);
                        index += 1;
                        state = SpannerScanState::BacktickQuote;
                        continue;
                    }
                    if current == '?' {
                        let position = binds.next_index + 1;
                        let parameter = parameters.get(position - 1).ok_or_else(|| {
                            anyhow!(
                                "Spanner query has {position} '?' markers but only {} parameters were supplied",
                                parameters.len()
                            )
                        })?;
                        let (bound, code) = Self::spanner_param_binding(parameter)?;
                        binds.next_index = position;
                        let name = format!("p{position}");
                        binds.params.insert(name.clone(), bound);
                        binds
                            .param_types
                            .insert(name.clone(), json!({ "code": code }));
                        output.push_str(&format!("@{name}"));
                        index += 1;
                        continue;
                    }
                    output.push(current);
                    index += 1;
                }
                SpannerScanState::LineComment => {
                    output.push(current);
                    index += 1;
                    if current == '\n' {
                        state = SpannerScanState::Normal;
                    }
                }
                SpannerScanState::BlockComment => {
                    output.push(current);
                    if current == '*' && chars.get(index + 1) == Some(&'/') {
                        output.push('/');
                        index += 2;
                        state = SpannerScanState::Normal;
                    } else {
                        index += 1;
                    }
                }
                SpannerScanState::SingleQuote => {
                    output.push(current);
                    if current == '\\' && index + 1 < chars.len() {
                        output.push(chars[index + 1]);
                        index += 2;
                    } else if current == '\'' && chars.get(index + 1) == Some(&'\'') {
                        output.push('\'');
                        index += 2;
                    } else {
                        index += 1;
                        if current == '\'' {
                            state = SpannerScanState::Normal;
                        }
                    }
                }
                SpannerScanState::DoubleQuote => {
                    output.push(current);
                    if current == '\\' && index + 1 < chars.len() {
                        output.push(chars[index + 1]);
                        index += 2;
                    } else if current == '"' && chars.get(index + 1) == Some(&'"') {
                        output.push('"');
                        index += 2;
                    } else {
                        index += 1;
                        if current == '"' {
                            state = SpannerScanState::Normal;
                        }
                    }
                }
                SpannerScanState::BacktickQuote => {
                    output.push(current);
                    index += 1;
                    if current == '`' {
                        state = SpannerScanState::Normal;
                    }
                }
            }
        }

        if binds.next_index != parameters.len() {
            bail!(
                "Spanner query has {} '?' markers but {} parameters were supplied",
                binds.next_index,
                parameters.len()
            );
        }
        Ok((output, binds))
    }

    /// Quote a possibly schema-qualified table name (`schema.table`) with
    /// backticks; every segment is validated first.
    fn qualify_table_name(table: &str) -> Result<String> {
        let parts = table
            .split('.')
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>();
        match parts.as_slice() {
            [] => Err(anyhow!("Table name cannot be empty")),
            [_, _, _, ..] => Err(anyhow!("Only schema.table names are supported for Spanner")),
            _ => parts
                .iter()
                .map(|part| quote_bigquery_identifier(part))
                .collect::<Result<Vec<_>>>()
                .map(|quoted| quoted.join(".")),
        }
    }

    /// Split `schema.table` into `(schema, table)`; unqualified names get the
    /// default empty schema.
    fn split_table_reference(table: &str) -> Result<(String, String)> {
        let parts = table
            .split('.')
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>();
        match parts.as_slice() {
            [name] => Ok((String::new(), (*name).to_string())),
            [schema, name] => Ok(((*schema).to_string(), (*name).to_string())),
            _ => Err(anyhow!("Only schema.table names are supported for Spanner")),
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

    /// Shared body of `execute_query`/`execute_query_for_request`: split the
    /// script, batch consecutive DDL into one `updateDatabaseDdl` call, run
    /// DML inside a single-use read-write transaction, and return the last
    /// row-producing result with the total affected count.
    async fn execute_query_inner(
        &self,
        sql: &str,
        cancel_flag: Option<Arc<AtomicBool>>,
    ) -> Result<QueryResult> {
        let started = Instant::now();
        let statements = split_sql_statements(sql)
            .into_iter()
            .filter(|statement| !statement.trim().is_empty())
            .collect::<Vec<_>>();

        if statements.len() <= 1 {
            let statement = statements.first().map(String::as_str).unwrap_or(sql);
            if Self::statement_kind(statement) == StatementKind::Ddl {
                self.execute_ddl(&[statement.to_string()]).await?;
                return Ok(QueryResult {
                    columns: Vec::new(),
                    rows: Vec::new(),
                    affected_rows: 0,
                    execution_time_ms: started.elapsed().as_millis(),
                    query: sql.to_string(),
                    sandboxed: false,
                    truncated: false,
                });
            }
            return self
                .execute_sql_with_retry(
                    statement,
                    None,
                    None,
                    cancel_flag.as_deref(),
                    MAX_QUERY_RESULT_ROWS,
                )
                .await;
        }

        let mut total_affected = 0u64;
        let mut last_result = None;
        let mut ddl_batch: Vec<String> = Vec::new();

        for statement in &statements {
            match Self::statement_kind(statement) {
                StatementKind::Ddl => ddl_batch.push(statement.clone()),
                kind => {
                    if !ddl_batch.is_empty() {
                        self.execute_ddl(&ddl_batch).await?;
                        ddl_batch.clear();
                    }
                    let result = self
                        .execute_sql_with_retry(
                            statement,
                            None,
                            None,
                            cancel_flag.as_deref(),
                            MAX_QUERY_RESULT_ROWS,
                        )
                        .await?;
                    total_affected += result.affected_rows;
                    if kind == StatementKind::Query || !result.rows.is_empty() {
                        last_result = Some(result);
                    }
                }
            }
        }
        if !ddl_batch.is_empty() {
            self.execute_ddl(&ddl_batch).await?;
        }

        let elapsed = started.elapsed().as_millis();
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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SpannerScanState {
    Normal,
    LineComment,
    BlockComment,
    SingleQuote,
    DoubleQuote,
    BacktickQuote,
}

#[async_trait]
impl DatabaseDriver for SpannerDriver {
    async fn ping(&self) -> Result<()> {
        self.execute_sql("SELECT 1", None, None)
            .await
            .context("Spanner ping failed")?;
        Ok(())
    }

    async fn disconnect(&self) -> Result<()> {
        if let Err(error) = self.delete_session().await {
            log::warn!("Failed to delete Spanner session on disconnect: {error:#}");
        }
        Ok(())
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        let mut databases = Vec::new();
        let mut page_token = None::<String>;

        loop {
            let mut request = self
                .client
                .get(Self::databases_url(&self.base_url, &self.instance_path));
            if let Some(token) = page_token.as_deref().filter(|value| !value.is_empty()) {
                request = request.query(&[("pageToken", token)]);
            }
            let response = self.send_checked(request).await?;

            if let Some(items) = response.get("databases").and_then(|v| v.as_array()) {
                for item in items {
                    if let Some(name) = item.get("name").and_then(|v| v.as_str()) {
                        let short = name.rsplit('/').next().unwrap_or(name).to_string();
                        databases.push(DatabaseInfo {
                            name: short,
                            size: None,
                        });
                    }
                }
            }

            match response
                .get("nextPageToken")
                .and_then(|v| v.as_str())
                .filter(|v| !v.is_empty())
            {
                Some(token) => page_token = Some(token.to_string()),
                None => break,
            }
        }

        databases.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(databases)
    }

    async fn list_tables(&self, database: Option<&str>) -> Result<Vec<TableInfo>> {
        let sql = "SELECT TABLE_NAME, TABLE_TYPE \
                   FROM INFORMATION_SCHEMA.TABLES \
                   WHERE TABLE_TYPE = 'BASE TABLE' \
                   ORDER BY TABLE_NAME";
        let result = self.execute_sql(sql, None, database).await?;
        let schema = database
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| self.current_database());

        Ok(result
            .rows
            .iter()
            .map(|row| TableInfo {
                create_date: None,
                name: row
                    .first()
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string(),
                schema: schema.clone(),
                table_type: row
                    .get(1)
                    .and_then(|value| value.as_str())
                    .unwrap_or("BASE TABLE")
                    .to_string(),
                row_count: None,
                engine: Some("Spanner".to_string()),
            })
            .collect())
    }

    async fn list_schema_objects(&self, database: Option<&str>) -> Result<Vec<SchemaObjectInfo>> {
        let sql = "SELECT TABLE_NAME, VIEW_DEFINITION \
                   FROM INFORMATION_SCHEMA.VIEWS \
                   ORDER BY TABLE_NAME";
        let result = self.execute_sql(sql, None, database).await?;
        let schema = database
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| self.current_database());

        Ok(result
            .rows
            .iter()
            .map(|row| SchemaObjectInfo {
                create_date: None,
                name: row
                    .first()
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string(),
                schema: schema.clone(),
                object_type: "VIEW".to_string(),
                related_table: None,
                definition: row
                    .get(1)
                    .and_then(|value| value.as_str())
                    .map(str::to_string),
            })
            .collect())
    }

    async fn get_table_structure(
        &self,
        table: &str,
        database: Option<&str>,
    ) -> Result<TableStructure> {
        let (schema, table_name) = Self::split_table_reference(table)?;
        let mut binds = SpannerBinds::default();
        let schema_param = binds.push(&JsonValue::String(schema.clone()))?;
        let table_param = binds.push(&JsonValue::String(table_name.clone()))?;

        let column_sql = format!(
            "SELECT COLUMN_NAME, SPANNER_TYPE, IS_NULLABLE, IS_GENERATED, \
                    GENERATION_EXPRESSION, COLUMN_DEFAULT \
             FROM INFORMATION_SCHEMA.COLUMNS \
             WHERE TABLE_SCHEMA = {schema_param} AND TABLE_NAME = {table_param} \
             ORDER BY ORDINAL_POSITION"
        );
        let column_result = self
            .execute_sql(&column_sql, Some(&binds), database)
            .await?;

        let pk_sql = format!(
            "SELECT COLUMN_NAME \
             FROM INFORMATION_SCHEMA.INDEX_COLUMNS \
             WHERE TABLE_SCHEMA = {schema_param} AND TABLE_NAME = {table_param} \
               AND INDEX_NAME = 'PRIMARY_KEY' \
             ORDER BY ORDINAL_POSITION"
        );
        let pk_result = self.execute_sql(&pk_sql, Some(&binds), database).await?;
        let pk_columns: HashSet<String> = pk_result
            .rows
            .iter()
            .filter_map(|row| row.first().and_then(|value| value.as_str()))
            .map(str::to_string)
            .collect();

        let columns = column_result
            .rows
            .iter()
            .map(|row| {
                let name = row
                    .first()
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string();
                let is_generated = row
                    .get(3)
                    .and_then(|value| value.as_str())
                    .is_some_and(|value| value.eq_ignore_ascii_case("ALWAYS"));
                let generation = row
                    .get(4)
                    .and_then(|value| value.as_str())
                    .filter(|value| !value.is_empty());
                ColumnDetail {
                    is_primary_key: pk_columns.contains(&name),
                    name,
                    data_type: row
                        .get(1)
                        .and_then(|value| value.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    is_nullable: row
                        .get(2)
                        .and_then(|value| value.as_str())
                        .is_some_and(|value| value.eq_ignore_ascii_case("YES")),
                    default_value: row
                        .get(5)
                        .and_then(|value| value.as_str())
                        .filter(|value| !value.is_empty())
                        .map(str::to_string),
                    extra: if is_generated {
                        Some(match generation {
                            Some(expression) => {
                                format!("GENERATED ALWAYS AS ({expression})")
                            }
                            None => "GENERATED ALWAYS".to_string(),
                        })
                    } else {
                        None
                    },
                    column_type: None,
                    comment: None,
                }
            })
            .collect::<Vec<_>>();

        let index_sql = format!(
            "SELECT i.INDEX_NAME, i.IS_UNIQUE, i.INDEX_TYPE, c.COLUMN_NAME \
             FROM INFORMATION_SCHEMA.INDEXES i \
             JOIN INFORMATION_SCHEMA.INDEX_COLUMNS c \
               ON c.TABLE_SCHEMA = i.TABLE_SCHEMA \
              AND c.TABLE_NAME = i.TABLE_NAME \
              AND c.INDEX_NAME = i.INDEX_NAME \
             WHERE i.TABLE_SCHEMA = {schema_param} AND i.TABLE_NAME = {table_param} \
               AND i.INDEX_TYPE != 'PRIMARY_KEY' \
             ORDER BY i.INDEX_NAME, c.ORDINAL_POSITION"
        );
        let index_result = self.execute_sql(&index_sql, Some(&binds), database).await?;
        let mut indexes: Vec<IndexInfo> = Vec::new();
        for row in &index_result.rows {
            let name = row
                .first()
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string();
            let column = row
                .get(3)
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string();
            if let Some(existing) = indexes.iter_mut().find(|index| index.name == name) {
                existing.columns.push(column);
            } else {
                indexes.push(IndexInfo {
                    name,
                    columns: vec![column],
                    is_unique: row
                        .get(1)
                        .and_then(|value| value.as_bool())
                        .unwrap_or(false),
                    index_type: row
                        .get(2)
                        .and_then(|value| value.as_str())
                        .map(str::to_string),
                });
            }
        }

        let fk_sql = format!(
            "SELECT rc.CONSTRAINT_NAME, kcu.COLUMN_NAME, kcu2.TABLE_NAME, \
                    kcu2.COLUMN_NAME, rc.UPDATE_RULE, rc.DELETE_RULE \
             FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc \
             JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu \
               ON kcu.CONSTRAINT_CATALOG = rc.CONSTRAINT_CATALOG \
              AND kcu.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA \
              AND kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME \
             JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu2 \
               ON kcu2.CONSTRAINT_CATALOG = rc.UNIQUE_CONSTRAINT_CATALOG \
              AND kcu2.CONSTRAINT_SCHEMA = rc.UNIQUE_CONSTRAINT_SCHEMA \
              AND kcu2.CONSTRAINT_NAME = rc.UNIQUE_CONSTRAINT_NAME \
              AND kcu2.ORDINAL_POSITION = kcu.POSITION_IN_UNIQUE_CONSTRAINT \
             WHERE kcu.TABLE_SCHEMA = {schema_param} AND kcu.TABLE_NAME = {table_param} \
             ORDER BY rc.CONSTRAINT_NAME, kcu.ORDINAL_POSITION"
        );
        let fk_result = self.execute_sql(&fk_sql, Some(&binds), database).await?;
        let foreign_keys = fk_result
            .rows
            .iter()
            .map(|row| ForeignKeyInfo {
                name: row
                    .first()
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string(),
                column: row
                    .get(1)
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string(),
                referenced_table: row
                    .get(2)
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string(),
                referenced_column: row
                    .get(3)
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string(),
                on_update: row
                    .get(4)
                    .and_then(|value| value.as_str())
                    .map(str::to_string),
                on_delete: row
                    .get(5)
                    .and_then(|value| value.as_str())
                    .map(str::to_string),
            })
            .collect();

        let object_sql = format!(
            "SELECT TABLE_TYPE \
             FROM INFORMATION_SCHEMA.TABLES \
             WHERE TABLE_SCHEMA = {schema_param} AND TABLE_NAME = {table_param} \
             LIMIT 1"
        );
        let object_result = self
            .execute_sql(&object_sql, Some(&binds), database)
            .await?;
        let object_type = object_result
            .rows
            .first()
            .and_then(|row| row.first())
            .and_then(|value| value.as_str())
            .map(str::to_string);

        let view_definition = if object_type.as_deref() == Some("VIEW") {
            let view_sql = format!(
                "SELECT VIEW_DEFINITION \
                 FROM INFORMATION_SCHEMA.VIEWS \
                 WHERE TABLE_SCHEMA = {schema_param} AND TABLE_NAME = {table_param} \
                 LIMIT 1"
            );
            self.execute_sql(&view_sql, Some(&binds), database)
                .await?
                .rows
                .first()
                .and_then(|row| row.first())
                .and_then(|value| value.as_str())
                .map(str::to_string)
        } else {
            None
        };

        Ok(TableStructure {
            columns,
            indexes,
            foreign_keys,
            triggers: Vec::new(),
            view_definition,
            object_type,
        })
    }

    async fn execute_query(&self, sql: &str) -> Result<QueryResult> {
        self.execute_query_inner(sql, None).await
    }

    /// Request-scoped execution: the query runs on the shared session so
    /// `cancel_query_request` can DELETE it and abort the in-flight call.
    async fn execute_query_for_request(&self, request_id: &str, sql: &str) -> Result<QueryResult> {
        if request_id.trim().is_empty() {
            return self.execute_query(sql).await;
        }
        let guard = CancelScopeGuard::begin(&self.cancel_registry, request_id);
        // The session is the kill target, not a backend id — registering a
        // marker only resolves the pending-cancel race.
        if guard.register_backend(0) {
            return Err(anyhow!("Query cancelled."));
        }
        let flag = guard.cancel_flag();
        let result = self.execute_query_inner(sql, flag).await;
        drop(guard);
        result
    }

    /// Spanner aborts in-flight `executeSql` calls when their session is
    /// deleted; the stored session is cleared so the next query recreates it.
    async fn cancel_query_request(&self, request_id: &str) -> Result<bool> {
        match request_cancel(&self.cancel_registry, request_id) {
            CancelLookup::NotRunning => Ok(false),
            CancelLookup::Pending => Ok(true),
            CancelLookup::Backend(_) => self.delete_session().await,
        }
    }

    async fn execute_parameterized_query(
        &self,
        sql: &str,
        parameters: &[QueryParameter],
    ) -> Result<QueryResult> {
        let (rewritten, binds) = Self::rewrite_spanner_placeholders(sql, parameters)?;
        self.execute_sql(&rewritten, Some(&binds), None).await
    }

    async fn execute_parameterized_query_for_request(
        &self,
        request_id: &str,
        sql: &str,
        parameters: &[QueryParameter],
    ) -> Result<QueryResult> {
        if request_id.trim().is_empty() {
            return self.execute_parameterized_query(sql, parameters).await;
        }
        let guard = CancelScopeGuard::begin(&self.cancel_registry, request_id);
        if guard.register_backend(0) {
            return Err(anyhow!("Query cancelled."));
        }
        let flag = guard.cancel_flag();
        let (rewritten, binds) = Self::rewrite_spanner_placeholders(sql, parameters)?;
        let result = self
            .execute_sql_with_retry(
                &rewritten,
                Some(&binds),
                None,
                flag.as_deref(),
                MAX_QUERY_RESULT_ROWS,
            )
            .await;
        drop(guard);
        result
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
        let mut sql = format!("SELECT * FROM {}", Self::qualify_table_name(table)?);

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
        // Page directly through executeSql: the caller's LIMIT bounds the
        // page, so the interactive row cap must not truncate it.
        self.execute_sql_with_retry(&sql, None, database, None, usize::MAX)
            .await
    }

    async fn count_rows(&self, table: &str, database: Option<&str>) -> Result<i64> {
        let sql = format!(
            "SELECT COUNT(*) AS count FROM {}",
            Self::qualify_table_name(table)?
        );
        let result = self.execute_sql(&sql, None, database).await?;
        Self::scalar_i64(&result)
    }

    async fn count_null_values(
        &self,
        table: &str,
        database: Option<&str>,
        column: &str,
    ) -> Result<i64> {
        let sql = format!(
            "SELECT COUNT(*) AS count FROM {} WHERE {} IS NULL",
            Self::qualify_table_name(table)?,
            quote_bigquery_order_by(column)?,
        );
        let result = self.execute_sql(&sql, None, database).await?;
        Self::scalar_i64(&result)
    }

    async fn update_table_cell(&self, request: &TableCellUpdateRequest) -> Result<u64> {
        if request.primary_keys.is_empty() {
            return Err(anyhow!(
                "Inline update requires at least one primary key column"
            ));
        }

        let mut binds = SpannerBinds::default();
        let target = quote_bigquery_order_by(&request.target_column)?;
        let set_value = if request.value.is_null() {
            "NULL".to_string()
        } else {
            binds.push(&request.value)?
        };

        let mut conditions = Vec::new();
        for primary_key in &request.primary_keys {
            let column = quote_bigquery_order_by(&primary_key.column)?;
            if primary_key.value.is_null() {
                conditions.push(format!("{column} IS NULL"));
            } else {
                conditions.push(format!("{column} = {}", binds.push(&primary_key.value)?));
            }
        }

        let sql = format!(
            "UPDATE {} SET {target} = {set_value} WHERE {}",
            Self::qualify_table_name(&request.table)?,
            conditions.join(" AND ")
        );
        let result = self
            .execute_sql(&sql, Some(&binds), request.database.as_deref())
            .await?;
        Ok(result.affected_rows)
    }

    async fn delete_table_rows(&self, request: &TableRowDeleteRequest) -> Result<u64> {
        if request.rows.is_empty() {
            return Err(anyhow!("Deleting rows requires at least one selected row"));
        }

        let mut binds = SpannerBinds::default();
        let mut predicates = Vec::new();
        for row_keys in &request.rows {
            if row_keys.is_empty() {
                return Err(anyhow!(
                    "Each deleted row must include at least one primary key value"
                ));
            }
            let mut conditions = Vec::new();
            for primary_key in row_keys {
                let column = quote_bigquery_order_by(&primary_key.column)?;
                if primary_key.value.is_null() {
                    conditions.push(format!("{column} IS NULL"));
                } else {
                    conditions.push(format!("{column} = {}", binds.push(&primary_key.value)?));
                }
            }
            predicates.push(format!("({})", conditions.join(" AND ")));
        }

        let sql = format!(
            "DELETE FROM {} WHERE {}",
            Self::qualify_table_name(&request.table)?,
            predicates.join(" OR ")
        );
        let result = self
            .execute_sql(&sql, Some(&binds), request.database.as_deref())
            .await?;
        Ok(result.affected_rows)
    }

    async fn insert_table_row(&self, request: &TableRowInsertRequest) -> Result<u64> {
        if request.values.is_empty() {
            return Err(anyhow!("Insert requires at least one column value"));
        }

        let mut binds = SpannerBinds::default();
        let mut columns = Vec::new();
        let mut values = Vec::new();
        for (column, value) in &request.values {
            columns.push(quote_bigquery_identifier(column)?);
            if value.is_null() {
                values.push("NULL".to_string());
            } else {
                values.push(binds.push(value)?);
            }
        }

        let sql = format!(
            "INSERT INTO {} ({}) VALUES ({})",
            Self::qualify_table_name(&request.table)?,
            columns.join(", "),
            values.join(", ")
        );
        let result = self
            .execute_sql(&sql, Some(&binds), request.database.as_deref())
            .await?;
        Ok(result.affected_rows.max(1))
    }

    async fn use_database(&self, database: &str) -> Result<()> {
        let trimmed = database.trim();
        Self::validate_database_name(trimmed)?;

        let new_path = format!("{}/databases/{trimmed}", self.instance_path);
        // Verify the database exists before switching so typos fail here
        // instead of on the next query.
        self.send_checked(
            self.client
                .get(Self::database_url(&self.base_url, &new_path)),
        )
        .await
        .with_context(|| format!("Failed to switch to Spanner database {trimmed}"))?;

        {
            let mut path = self
                .database_path
                .write()
                .map_err(|_| anyhow!("Failed to access Spanner database state"))?;
            *path = new_path;
        }
        {
            let mut current = self
                .current_db
                .write()
                .map_err(|_| anyhow!("Failed to access Spanner database state"))?;
            *current = Some(trimmed.to_string());
        }
        // The stored session is bound to the old database path; drop it so the
        // next query creates a session on the new database.
        *self.session.write().await = None;
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
        let value_expr = quote_bigquery_order_by(referenced_column)?;
        let label_expr = Self::label_expression(display_columns, referenced_column)?;
        let mut binds = SpannerBinds::default();

        let mut sql = format!(
            "SELECT {value_expr} AS value, {label_expr} AS label FROM {}",
            Self::qualify_table_name(referenced_table)?
        );

        if let Some(search_term) = search.map(str::trim).filter(|value| !value.is_empty()) {
            let pattern = binds.push(&JsonValue::String(format!("%{search_term}%")))?;
            sql.push_str(&format!(
                " WHERE CAST({value_expr} AS STRING) LIKE {pattern}"
            ));
        }

        sql.push_str(&format!(" ORDER BY {value_expr} LIMIT {}", limit.max(1)));

        let result = self.execute_sql(&sql, Some(&binds), None).await?;
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
        self.current_db.read().ok()?.clone()
    }

    fn driver_name(&self) -> &str {
        "spanner"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parameter(value: JsonValue, data_type: QueryParameterType) -> QueryParameter {
        QueryParameter {
            name: "p".to_string(),
            value,
            data_type,
        }
    }

    #[test]
    fn maps_spanner_scalar_type_codes_to_json_values() {
        let int64 = json!({ "code": "INT64" });
        assert_eq!(
            SpannerDriver::spanner_value_to_json(&json!("42"), Some(&int64)),
            json!(42)
        );
        // INT64 beyond f64 precision stays exact.
        assert_eq!(
            SpannerDriver::spanner_value_to_json(&json!("9223372036854775807"), Some(&int64)),
            json!(9223372036854775807_i64)
        );

        let float64 = json!({ "code": "FLOAT64" });
        assert_eq!(
            SpannerDriver::spanner_value_to_json(&json!(1.5), Some(&float64)),
            json!(1.5)
        );
        assert_eq!(
            SpannerDriver::spanner_value_to_json(&json!("2.25"), Some(&float64)),
            json!(2.25)
        );
        // Non-finite sentinels cannot be JSON numbers — keep the string.
        assert_eq!(
            SpannerDriver::spanner_value_to_json(&json!("NaN"), Some(&float64)),
            json!("NaN")
        );

        let boolean = json!({ "code": "BOOL" });
        assert_eq!(
            SpannerDriver::spanner_value_to_json(&json!(true), Some(&boolean)),
            json!(true)
        );

        let string = json!({ "code": "STRING" });
        assert_eq!(
            SpannerDriver::spanner_value_to_json(&json!("abc"), Some(&string)),
            json!("abc")
        );

        // NULL maps to Null regardless of the declared type.
        assert_eq!(
            SpannerDriver::spanner_value_to_json(&JsonValue::Null, Some(&int64)),
            JsonValue::Null
        );
    }

    #[test]
    fn maps_spanner_array_and_struct_type_codes() {
        let array_of_int = json!({
            "code": "ARRAY",
            "arrayElementType": { "code": "INT64" }
        });
        assert_eq!(
            SpannerDriver::spanner_value_to_json(&json!(["1", "2", null]), Some(&array_of_int)),
            json!([1, 2, null])
        );

        let struct_type = json!({
            "code": "STRUCT",
            "structType": {
                "fields": [
                    { "name": "id", "type": { "code": "INT64" } },
                    { "name": "label", "type": { "code": "STRING" } }
                ]
            }
        });
        assert_eq!(
            SpannerDriver::spanner_value_to_json(&json!(["7", "seven"]), Some(&struct_type)),
            json!({ "id": 7, "label": "seven" })
        );

        // Unnamed struct fields fall back to positional names.
        let anonymous_struct = json!({
            "code": "STRUCT",
            "structType": {
                "fields": [
                    { "type": { "code": "BOOL" } },
                    { "type": { "code": "STRING" } }
                ]
            }
        });
        assert_eq!(
            SpannerDriver::spanner_value_to_json(&json!([true, "x"]), Some(&anonymous_struct)),
            json!({ "field_1": true, "field_2": "x" })
        );
    }

    #[test]
    fn renders_spanner_type_names() {
        assert_eq!(
            SpannerDriver::spanner_type_name(Some(&json!({ "code": "STRING" }))),
            "STRING"
        );
        assert_eq!(
            SpannerDriver::spanner_type_name(Some(&json!({
                "code": "ARRAY",
                "arrayElementType": { "code": "INT64" }
            }))),
            "ARRAY<INT64>"
        );
        assert_eq!(
            SpannerDriver::spanner_type_name(Some(&json!({
                "code": "STRUCT",
                "structType": {
                    "fields": [
                        { "name": "a", "type": { "code": "STRING" } },
                        { "type": { "code": "BOOL" } }
                    ]
                }
            }))),
            "STRUCT<a:STRING,BOOL>"
        );
        assert_eq!(SpannerDriver::spanner_type_name(None), "UNKNOWN");
    }

    #[test]
    fn maps_query_parameters_to_spanner_param_types() {
        let (value, code) =
            SpannerDriver::spanner_param_binding(&parameter(json!("hi"), QueryParameterType::Text))
                .expect("string param");
        assert_eq!((value, code), (json!("hi"), "STRING"));

        let (value, code) = SpannerDriver::spanner_param_binding(&parameter(
            json!(42),
            QueryParameterType::Integer,
        ))
        .expect("integer param");
        // INT64 binds travel as strings.
        assert_eq!((value, code), (json!("42"), "INT64"));

        let (value, code) = SpannerDriver::spanner_param_binding(&parameter(
            json!(1.5),
            QueryParameterType::Decimal,
        ))
        .expect("decimal param");
        assert_eq!((value, code), (json!(1.5), "FLOAT64"));

        let (value, code) = SpannerDriver::spanner_param_binding(&parameter(
            json!(true),
            QueryParameterType::Boolean,
        ))
        .expect("bool param");
        assert_eq!((value, code), (json!(true), "BOOL"));

        // Null takes its type from the declared hint, defaulting to STRING.
        let (value, code) = SpannerDriver::spanner_param_binding(&parameter(
            JsonValue::Null,
            QueryParameterType::Integer,
        ))
        .expect("null int param");
        assert_eq!((value, code), (JsonValue::Null, "INT64"));
        let (value, code) = SpannerDriver::spanner_param_binding(&parameter(
            JsonValue::Null,
            QueryParameterType::Null,
        ))
        .expect("null default param");
        assert_eq!((value, code), (JsonValue::Null, "STRING"));

        // JSON-typed strings and documents bind as JSON.
        let (_, code) = SpannerDriver::spanner_param_binding(&parameter(
            json!("{\"a\":1}"),
            QueryParameterType::Json,
        ))
        .expect("json string param");
        assert_eq!(code, "JSON");
        let (value, code) = SpannerDriver::spanner_param_binding(&parameter(
            json!({ "a": 1 }),
            QueryParameterType::Json,
        ))
        .expect("json object param");
        assert_eq!((value, code), (json!("{\"a\":1}"), "JSON"));

        // Structured values without a JSON hint are rejected.
        assert!(SpannerDriver::spanner_param_binding(&parameter(
            json!([1, 2]),
            QueryParameterType::Text,
        ))
        .is_err());
    }

    #[test]
    fn builds_spanner_urls_from_resource_paths() {
        let base = "https://spanner.googleapis.com";
        let database_path = "projects/p/instances/i/databases/d";
        assert_eq!(
            SpannerDriver::sessions_url(base, database_path),
            "https://spanner.googleapis.com/v1/projects/p/instances/i/databases/d/sessions"
        );
        let session = "projects/p/instances/i/databases/d/sessions/sess-1";
        assert_eq!(
            SpannerDriver::execute_sql_url(base, session),
            "https://spanner.googleapis.com/v1/projects/p/instances/i/databases/d/sessions/sess-1:executeSql"
        );
        assert_eq!(
            SpannerDriver::session_delete_url(base, session),
            "https://spanner.googleapis.com/v1/projects/p/instances/i/databases/d/sessions/sess-1"
        );
        assert_eq!(
            SpannerDriver::databases_url(base, "projects/p/instances/i"),
            "https://spanner.googleapis.com/v1/projects/p/instances/i/databases"
        );
        assert_eq!(
            SpannerDriver::update_ddl_url(base, database_path),
            "https://spanner.googleapis.com/v1/projects/p/instances/i/databases/d/ddl"
        );
    }

    #[test]
    fn rewrites_question_mark_placeholders_to_named_params() {
        let (sql, binds) = SpannerDriver::rewrite_spanner_placeholders(
            "SELECT * FROM t WHERE a = ? AND b = ? -- ? ignored\nAND c = '?'",
            &[
                parameter(json!(1), QueryParameterType::Integer),
                parameter(json!("x"), QueryParameterType::Text),
            ],
        )
        .expect("rewrite");
        assert_eq!(
            sql,
            "SELECT * FROM t WHERE a = @p1 AND b = @p2 -- ? ignored\nAND c = '?'"
        );
        assert_eq!(binds.params.get("p1"), Some(&json!("1")));
        assert_eq!(binds.params.get("p2"), Some(&json!("x")));
        assert_eq!(
            binds.param_types.get("p1"),
            Some(&json!({ "code": "INT64" }))
        );
        assert_eq!(
            binds.param_types.get("p2"),
            Some(&json!({ "code": "STRING" }))
        );
    }

    #[test]
    fn rejects_mismatched_placeholder_counts() {
        assert!(SpannerDriver::rewrite_spanner_placeholders(
            "SELECT ?",
            &[
                parameter(json!(1), QueryParameterType::Integer),
                parameter(json!(2), QueryParameterType::Integer),
            ],
        )
        .is_err());
        assert!(SpannerDriver::rewrite_spanner_placeholders(
            "SELECT ?, ?",
            &[parameter(json!(1), QueryParameterType::Integer),]
        )
        .is_err());
    }

    #[test]
    fn parses_information_schema_rows_into_query_result() {
        let response = json!({
            "metadata": {
                "rowType": {
                    "fields": [
                        { "name": "TABLE_NAME", "type": { "code": "STRING" } },
                        { "name": "TABLE_TYPE", "type": { "code": "STRING" } }
                    ]
                }
            },
            "rows": [["Singers", "BASE TABLE"], ["Albums", "BASE TABLE"]]
        });
        let result = SpannerDriver::result_from_execute_sql(
            response,
            0,
            "SELECT TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES".to_string(),
            MAX_QUERY_RESULT_ROWS,
        );
        assert_eq!(result.columns.len(), 2);
        assert_eq!(result.columns[0].name, "TABLE_NAME");
        assert_eq!(result.columns[0].data_type, "STRING");
        assert_eq!(
            result.rows,
            vec![
                vec![json!("Singers"), json!("BASE TABLE")],
                vec![json!("Albums"), json!("BASE TABLE")],
            ]
        );
        assert!(!result.truncated);
    }

    #[test]
    fn parses_dml_stats_and_truncates_at_row_cap() {
        let response = json!({
            "stats": { "rowCountExact": "3" }
        });
        let result = SpannerDriver::result_from_execute_sql(
            response,
            0,
            "DELETE FROM t WHERE x".to_string(),
            MAX_QUERY_RESULT_ROWS,
        );
        assert_eq!(result.affected_rows, 3);
        assert!(result.columns.is_empty());

        let response = json!({
            "metadata": {
                "rowType": {
                    "fields": [{ "name": "n", "type": { "code": "INT64" } }]
                }
            },
            "rows": [["1"], ["2"], ["3"]]
        });
        let result =
            SpannerDriver::result_from_execute_sql(response, 0, "SELECT n FROM t".to_string(), 2);
        assert_eq!(result.rows.len(), 2);
        assert!(result.truncated);
    }

    #[test]
    fn classifies_statement_kinds() {
        assert_eq!(
            SpannerDriver::statement_kind("SELECT 1"),
            StatementKind::Query
        );
        assert_eq!(
            SpannerDriver::statement_kind("-- c\nWITH x AS (SELECT 1) SELECT * FROM x"),
            StatementKind::Query
        );
        assert_eq!(
            SpannerDriver::statement_kind("UPDATE t SET a = 1"),
            StatementKind::Dml
        );
        assert_eq!(
            SpannerDriver::statement_kind("CREATE TABLE t (id INT64) PRIMARY KEY(id)"),
            StatementKind::Ddl
        );
        assert_eq!(
            SpannerDriver::statement_kind("DROP INDEX idx"),
            StatementKind::Ddl
        );
    }

    #[test]
    fn quotes_and_splits_table_names() {
        assert_eq!(
            SpannerDriver::qualify_table_name("Singers").expect("table"),
            "`Singers`"
        );
        assert_eq!(
            SpannerDriver::qualify_table_name("sch.Singers").expect("qualified"),
            "`sch`.`Singers`"
        );
        assert!(SpannerDriver::qualify_table_name("a.b.c").is_err());
        assert_eq!(
            SpannerDriver::split_table_reference("sch.t").expect("split"),
            ("sch".to_string(), "t".to_string())
        );
        assert_eq!(
            SpannerDriver::split_table_reference("t").expect("split"),
            (String::new(), "t".to_string())
        );
    }

    #[test]
    fn validates_database_names() {
        assert!(SpannerDriver::validate_database_name("my-db_1").is_ok());
        assert!(SpannerDriver::validate_database_name("").is_err());
        assert!(SpannerDriver::validate_database_name("a/b").is_err());
        assert!(SpannerDriver::validate_database_name("a b").is_err());
    }
}
