//! Trino driver over the coordinator HTTP protocol (`/v1/statement`).
//!
//! A statement is POSTed as the raw body; the coordinator answers with a JSON
//! page carrying `columns`/`data` plus a `nextUri` that must be polled until
//! absent. Cancelling is an HTTP DELETE on the in-flight URI.

use super::driver::DatabaseDriver;
use super::models::*;
use super::query_common::MAX_QUERY_RESULT_ROWS;
use super::safety::{normalize_order_dir, sanitize_snowflake_filter_clause};
use crate::utils::sql::split_sql_statements;
use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use reqwest::{Client, RequestBuilder};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;

#[derive(Debug, Deserialize)]
struct TrinoColumn {
    name: String,
    #[serde(rename = "type", default)]
    data_type: String,
}

#[derive(Debug, Deserialize)]
struct TrinoError {
    #[serde(default)]
    message: String,
    #[serde(rename = "errorName", default)]
    error_name: String,
    #[serde(rename = "errorCode", default)]
    error_code: i64,
}

#[derive(Debug, Deserialize)]
struct TrinoStats {
    /// `updateCount` is a JSON number on current coordinators but was a string
    /// on older ones — keep it untyped and parse leniently.
    #[serde(rename = "updateCount", default)]
    update_count: Option<serde_json::Value>,
}

/// One JSON page of the `/v1/statement` protocol. Fields other than `id` and
/// `nextUri` appear only on the pages that carry them.
#[derive(Debug, Deserialize)]
struct TrinoPage {
    #[serde(rename = "nextUri", default)]
    next_uri: Option<String>,
    #[serde(default)]
    columns: Option<Vec<TrinoColumn>>,
    #[serde(default)]
    data: Option<Vec<Vec<serde_json::Value>>>,
    #[serde(default)]
    error: Option<TrinoError>,
    #[serde(default)]
    stats: Option<TrinoStats>,
}

/// Rows/columns accumulated while following `nextUri` pages.
#[derive(Default)]
struct TrinoAccumulated {
    columns: Vec<TrinoColumn>,
    rows: Vec<Vec<serde_json::Value>>,
    update_count: Option<u64>,
    truncated: bool,
}

pub struct TrinoDriver {
    client: Client,
    base_url: String,
    username: String,
    password: Option<String>,
    /// Session default as `catalog` or `catalog.schema`.
    current_db: Arc<RwLock<Option<String>>>,
    /// request_id → URI to DELETE for a server-side abort. Holds the statement
    /// URL until the first page hands back a `nextUri`.
    in_flight: Mutex<HashMap<String, String>>,
}

impl TrinoDriver {
    pub async fn connect(config: &ConnectionConfig) -> Result<Self> {
        let host = config
            .host
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .context("Trino host is required")?;
        let port = config.port.unwrap_or(8080);
        let scheme = if config.use_ssl { "https" } else { "http" };
        let username = config
            .username
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("tabler")
            .to_string();
        Ok(Self {
            client: Client::builder()
                .build()
                .context("Failed to initialize Trino HTTP client")?,
            base_url: format!("{scheme}://{host}:{port}"),
            username,
            password: config.password.clone(),
            current_db: Arc::new(RwLock::new(config.database.clone())),
            in_flight: Mutex::new(HashMap::new()),
        })
    }

    fn statement_url(&self) -> String {
        format!("{}/v1/statement", self.base_url)
    }

    /// Split a `catalog` / `catalog.schema` database value into the pair the
    /// `X-Trino-Catalog` / `X-Trino-Schema` headers expect.
    fn split_catalog_schema(value: &str) -> Result<(String, Option<String>)> {
        let trimmed = value.trim();
        let mut parts = trimmed.splitn(2, '.');
        let catalog = parts.next().unwrap_or_default().trim();
        if catalog.is_empty() {
            return Err(anyhow!(
                "Trino database must use 'catalog' or 'catalog.schema' format"
            ));
        }
        let schema = parts
            .next()
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .map(str::to_string);
        Ok((catalog.to_string(), schema))
    }

    /// Effective `(catalog, schema)` for a call: the per-request override wins,
    /// then the session default. Errors when neither is configured or the
    /// value is not `catalog[.schema]`.
    fn resolve_location(&self, database: Option<&str>) -> Result<(String, Option<String>)> {
        let raw = database
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| self.current_db.read().ok().and_then(|guard| guard.clone()))
            .ok_or_else(|| {
                anyhow!("Trino requires a 'catalog' or 'catalog.schema' database selection")
            })?;
        Self::split_catalog_schema(&raw)
    }

    /// Session location for request headers; an unparseable stored value just
    /// means no catalog/schema headers — the coordinator reports the problem.
    fn session_location(&self) -> Option<(String, Option<String>)> {
        self.current_db
            .read()
            .ok()
            .and_then(|guard| guard.clone())
            .and_then(|value| Self::split_catalog_schema(&value).ok())
    }

    /// Resolve `table` (optionally `schema.table` or `catalog.schema.table`)
    /// against the session/override location into concrete parts.
    fn resolve_table_parts(
        &self,
        table: &str,
        database: Option<&str>,
    ) -> Result<(String, String, String)> {
        let parts: Vec<String> = table
            .split('.')
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .map(str::to_string)
            .collect();
        match parts.as_slice() {
            [catalog, schema, name] => Ok((catalog.clone(), schema.clone(), name.clone())),
            [schema, name] => {
                let (catalog, _) = self.resolve_location(database)?;
                Ok((catalog, schema.clone(), name.clone()))
            }
            [name] => {
                let (catalog, schema) = self.resolve_location(database)?;
                let schema = schema.ok_or_else(|| {
                    anyhow!(
                        "Trino table '{table}' needs a schema: set the database to 'catalog.schema' or qualify the table name"
                    )
                })?;
                Ok((catalog, schema, name.clone()))
            }
            _ => Err(anyhow!(
                "Trino table names support at most catalog.schema.table"
            )),
        }
    }

    /// Quote a table reference for FROM/WHERE positions. One-part names rely
    /// on the session headers; a known session schema is emitted explicitly so
    /// `schema.table` resolves inside the session catalog.
    fn qualify_table_name(
        table: &str,
        location: Option<&(String, Option<String>)>,
    ) -> Result<String> {
        let parts: Vec<&str> = table
            .split('.')
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .collect();
        match (parts.as_slice(), location) {
            ([name], Some((_, Some(schema)))) => Ok(format!(
                "{}.{}",
                quote_trino_identifier(schema)?,
                quote_trino_identifier(name)?
            )),
            ([name], _) => quote_trino_identifier(name),
            ([schema, name], _) => Ok(format!(
                "{}.{}",
                quote_trino_identifier(schema)?,
                quote_trino_identifier(name)?
            )),
            ([catalog, schema, name], _) => Ok(format!(
                "{}.{}.{}",
                quote_trino_identifier(catalog)?,
                quote_trino_identifier(schema)?,
                quote_trino_identifier(name)?
            )),
            _ => Err(anyhow!(
                "Trino table names support at most catalog.schema.table"
            )),
        }
    }

    /// X-Trino-User is required on every protocol request; basic auth rides
    /// along when a password is configured.
    fn apply_auth(&self, request: RequestBuilder) -> RequestBuilder {
        let request = request
            .header("X-Trino-User", &self.username)
            .header("X-Trino-Source", "tabler");
        match &self.password {
            Some(password) if !password.is_empty() => {
                request.basic_auth(&self.username, Some(password))
            }
            _ => request,
        }
    }

    async fn send_page(request: RequestBuilder) -> Result<TrinoPage> {
        let response = request
            .send()
            .await
            .context("Failed to reach the Trino coordinator")?;
        let status = response.status();
        let body = response
            .text()
            .await
            .context("Failed to read the Trino response")?;
        if !status.is_success() {
            bail!(
                "Trino request failed with status {}: {}",
                status.as_u16(),
                body.trim()
            );
        }
        serde_json::from_str(&body).context("Failed to parse the Trino response")
    }

    async fn post_statement(
        &self,
        sql: &str,
        location: Option<&(String, Option<String>)>,
    ) -> Result<TrinoPage> {
        let mut request = self
            .apply_auth(self.client.post(self.statement_url()))
            .body(sql.to_string());
        if let Some((catalog, schema)) = location {
            request = request.header("X-Trino-Catalog", catalog.as_str());
            if let Some(schema) = schema {
                request = request.header("X-Trino-Schema", schema.as_str());
            }
        }
        Self::send_page(request).await
    }

    async fn fetch_page(&self, uri: &str) -> Result<TrinoPage> {
        Self::send_page(self.apply_auth(self.client.get(uri))).await
    }

    /// Merge one page into the accumulator. Returns the `nextUri` to follow,
    /// or `None` on the last page. A page-level `error` aborts the statement.
    fn merge_page(
        acc: &mut TrinoAccumulated,
        page: TrinoPage,
        row_cap: usize,
    ) -> Result<Option<String>> {
        if let Some(error) = page.error {
            let detail = if error.message.is_empty() {
                error.error_name
            } else {
                error.message
            };
            bail!(
                "Trino query failed (errorCode {}): {detail}",
                error.error_code
            );
        }
        if let Some(columns) = page.columns {
            acc.columns = columns;
        }
        if let Some(data) = page.data {
            for row in data {
                if acc.rows.len() >= row_cap {
                    acc.truncated = true;
                    break;
                }
                acc.rows.push(row);
            }
        }
        if let Some(count) = page
            .stats
            .and_then(|stats| stats.update_count)
            .and_then(|value| trino_count_value(&value))
            .and_then(|value| u64::try_from(value).ok())
        {
            acc.update_count = Some(count);
        }
        Ok(page.next_uri)
    }

    /// Lock the cancel-URI registry, recovering from poisoning the same way
    /// `query_cancel` does — a poisoned map must not break query execution.
    fn lock_in_flight(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        self.in_flight.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Keep the cancel registry pointed at the URI that aborts the running
    /// query. Only touches requests registered by `execute_query_for_request`.
    fn track_next_uri(&self, request_id: Option<&str>, uri: Option<&str>) {
        let Some(request_id) = request_id else {
            return;
        };
        let Some(uri) = uri else {
            return;
        };
        let mut map = self.lock_in_flight();
        if map.contains_key(request_id) {
            map.insert(request_id.to_string(), uri.to_string());
        }
    }

    /// Best-effort abort of a query we stopped consuming (row cap reached).
    async fn abort_uri(&self, uri: &str) {
        let request = self.apply_auth(self.client.delete(uri));
        if let Err(error) = request.send().await {
            log::warn!("Failed to abort truncated Trino query at {uri}: {error}");
        }
    }

    /// POST one statement and follow `nextUri` pages until the coordinator
    /// stops producing them or the row cap cuts the result short.
    async fn run_statement(
        &self,
        sql: &str,
        location: Option<&(String, Option<String>)>,
        request_id: Option<&str>,
        row_cap: usize,
    ) -> Result<TrinoAccumulated> {
        let mut page = self.post_statement(sql, location).await?;
        let mut acc = TrinoAccumulated::default();
        loop {
            let next_uri = Self::merge_page(&mut acc, page, row_cap)?;
            self.track_next_uri(request_id, next_uri.as_deref());
            if acc.rows.len() >= row_cap && next_uri.is_some() {
                acc.truncated = true;
            }
            if acc.truncated {
                if let Some(uri) = next_uri {
                    self.abort_uri(&uri).await;
                }
                break;
            }
            match next_uri {
                Some(uri) => page = self.fetch_page(&uri).await?,
                None => break,
            }
        }
        Ok(acc)
    }

    fn build_result(&self, acc: TrinoAccumulated, query: &str, elapsed: u128) -> QueryResult {
        QueryResult {
            columns: acc
                .columns
                .iter()
                .map(|column| ColumnInfo {
                    name: column.name.clone(),
                    data_type: column.data_type.clone(),
                    is_nullable: true,
                    is_primary_key: false,
                    max_length: None,
                    default_value: None,
                })
                .collect(),
            rows: acc.rows,
            affected_rows: acc.update_count.unwrap_or(0),
            execution_time_ms: elapsed,
            query: query.to_string(),
            sandboxed: false,
            truncated: acc.truncated,
        }
    }

    /// Shared body of `execute_query`/`execute_query_for_request`. Trino runs
    /// exactly one statement per POST, so multi-statement input is split and
    /// executed sequentially; the last row-producing statement wins.
    async fn execute_query_inner(
        &self,
        sql: &str,
        request_id: Option<&str>,
    ) -> Result<QueryResult> {
        let start = Instant::now();
        let statements = split_sql_statements(sql);
        let location = self.session_location();
        let mut total_affected = 0u64;
        let mut last_result: Option<QueryResult> = None;

        for statement in statements
            .iter()
            .filter(|statement| !statement.trim().is_empty())
        {
            let acc = self
                .run_statement(
                    statement,
                    location.as_ref(),
                    request_id,
                    MAX_QUERY_RESULT_ROWS,
                )
                .await?;
            if let Some(count) = acc.update_count {
                total_affected = total_affected.saturating_add(count);
            }
            if !acc.columns.is_empty() {
                last_result = Some(self.build_result(acc, sql, 0));
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

    /// Run a metadata SELECT and return the accumulated rows.
    async fn query_rows(
        &self,
        sql: &str,
        location: Option<&(String, Option<String>)>,
    ) -> Result<Vec<Vec<serde_json::Value>>> {
        Ok(self
            .run_statement(sql, location, None, usize::MAX)
            .await?
            .rows)
    }
}

/// Trino identifiers are double-quoted; a literal `"` inside the name is
/// escaped by doubling it.
fn quote_trino_identifier(value: &str) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("Identifier cannot be empty"));
    }
    if trimmed
        .chars()
        .any(|ch| matches!(ch, '\0' | '\r' | '\n' | '\t'))
    {
        return Err(anyhow!("Identifier contains invalid control characters"));
    }
    Ok(format!("\"{}\"", trimmed.replace('"', "\"\"")))
}

/// Quote an ORDER BY column reference (`col` or `alias.col`).
fn quote_trino_order_by(column: &str) -> Result<String> {
    let parts: Vec<&str> = column
        .split('.')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect();
    if parts.is_empty() || parts.len() > 2 {
        return Err(anyhow!("Invalid column reference in ORDER BY"));
    }
    Ok(parts
        .iter()
        .map(|part| quote_trino_identifier(part))
        .collect::<Result<Vec<_>>>()?
        .join("."))
}

/// Escape a string for a single-quoted Trino literal (quote doubling).
fn trino_string_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// Serialize a JSON value as a Trino literal. Trino has no protocol-level
/// bind parameters, so write paths use strictly escaped literals.
fn trino_literal(value: &serde_json::Value) -> Result<String> {
    match value {
        serde_json::Value::Null => Ok("NULL".to_string()),
        serde_json::Value::Bool(value) => Ok(if *value { "TRUE" } else { "FALSE" }.to_string()),
        serde_json::Value::Number(value) => Ok(value.to_string()),
        serde_json::Value::String(value) => Ok(trino_string_literal(value)),
        _ => Err(anyhow!(
            "Only string, number, boolean, and null values are supported"
        )),
    }
}

/// `col = lit AND col IS NULL ...` predicate for primary-key row selectors.
fn trino_pk_condition(keys: &[RowKeyValue]) -> Result<String> {
    let mut conditions = Vec::with_capacity(keys.len());
    for key in keys {
        let mut condition = quote_trino_identifier(&key.column)?;
        if key.value.is_null() {
            condition.push_str(" IS NULL");
        } else {
            condition.push_str(" = ");
            condition.push_str(&trino_literal(&key.value)?);
        }
        conditions.push(condition);
    }
    Ok(conditions.join(" AND "))
}

/// Counts arrive as JSON numbers, but older coordinators serialized
/// `updateCount` as a string — accept either shape.
fn trino_count_value(value: &serde_json::Value) -> Option<i64> {
    match value {
        serde_json::Value::Number(number) => number
            .as_i64()
            .or_else(|| number.as_u64().and_then(|v| i64::try_from(v).ok())),
        serde_json::Value::String(text) => text.trim().parse::<i64>().ok(),
        _ => None,
    }
}

#[async_trait]
impl DatabaseDriver for TrinoDriver {
    async fn ping(&self) -> Result<()> {
        let location = self.session_location();
        self.run_statement("SELECT 1", location.as_ref(), None, 1)
            .await
            .context("Trino ping failed")?;
        Ok(())
    }

    async fn disconnect(&self) -> Result<()> {
        Ok(())
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        // SHOW CATALOGS must not carry catalog/schema headers: a stale session
        // catalog would make the coordinator reject even this listing.
        let rows = self.query_rows("SHOW CATALOGS", None).await?;
        Ok(rows
            .into_iter()
            .filter_map(|row| {
                row.first()
                    .and_then(|value| value.as_str())
                    .map(|name| DatabaseInfo {
                        name: name.to_string(),
                        size: None,
                    })
            })
            .collect())
    }

    async fn list_tables(&self, database: Option<&str>) -> Result<Vec<TableInfo>> {
        let (catalog, schema) = self.resolve_location(database)?;
        let mut sql = format!(
            "SELECT table_schema, table_name, table_type \
             FROM {}.information_schema.tables",
            quote_trino_identifier(&catalog)?
        );
        if let Some(schema) = &schema {
            sql.push_str(&format!(
                " WHERE table_schema = {}",
                trino_string_literal(schema)
            ));
        }
        sql.push_str(" ORDER BY table_schema, table_name");
        let location = (catalog, schema);
        let rows = self.query_rows(&sql, Some(&location)).await?;

        Ok(rows
            .into_iter()
            .filter_map(|row| {
                let name = row.get(1).and_then(|value| value.as_str())?.to_string();
                Some(TableInfo {
                    name,
                    schema: row
                        .first()
                        .and_then(|value| value.as_str())
                        .map(str::to_string),
                    table_type: row
                        .get(2)
                        .and_then(|value| value.as_str())
                        .unwrap_or("BASE TABLE")
                        .to_string(),
                    row_count: None,
                    engine: None,
                    create_date: None,
                })
            })
            .collect())
    }

    async fn list_schema_objects(&self, database: Option<&str>) -> Result<Vec<SchemaObjectInfo>> {
        let (catalog, schema) = self.resolve_location(database)?;
        let quoted_catalog = quote_trino_identifier(&catalog)?;
        let views_sql = format!(
            "SELECT table_name AS name, 'VIEW' AS object_type, view_definition AS definition \
             FROM {quoted_catalog}.information_schema.views"
        );
        let sql = if let Some(schema) = &schema {
            let schema_literal = trino_string_literal(schema);
            format!(
                "{views_sql} WHERE table_schema = {schema_literal} \
                 UNION ALL \
                 SELECT routine_name AS name, routine_type AS object_type, \
                        CAST(NULL AS varchar) AS definition \
                 FROM {quoted_catalog}.information_schema.routines \
                 WHERE routine_schema = {schema_literal} \
                 ORDER BY name"
            )
        } else {
            format!("{views_sql} ORDER BY name")
        };
        let location = (catalog, schema);

        // information_schema.routines is missing on some connectors; fall back
        // to the views-only listing rather than failing the whole call.
        let rows = match self.query_rows(&sql, Some(&location)).await {
            Ok(rows) => rows,
            Err(first_error) => {
                let Some(schema) = location.1.as_deref() else {
                    return Err(first_error);
                };
                log::warn!(
                    "Trino schema-object union query failed ({first_error}); retrying views only"
                );
                let fallback = format!(
                    "{views_sql} WHERE table_schema = {} ORDER BY name",
                    trino_string_literal(schema)
                );
                self.query_rows(&fallback, Some(&location)).await?
            }
        };

        Ok(rows
            .into_iter()
            .filter_map(|row| {
                let name = row.first().and_then(|value| value.as_str())?.to_string();
                Some(SchemaObjectInfo {
                    name,
                    schema: location.1.clone(),
                    object_type: row
                        .get(1)
                        .and_then(|value| value.as_str())
                        .unwrap_or("VIEW")
                        .to_string(),
                    related_table: None,
                    definition: row
                        .get(2)
                        .and_then(|value| value.as_str())
                        .map(str::to_string),
                    create_date: None,
                })
            })
            .collect())
    }

    async fn get_table_structure(
        &self,
        table: &str,
        database: Option<&str>,
    ) -> Result<TableStructure> {
        let (catalog, schema, table_name) = self.resolve_table_parts(table, database)?;
        let quoted_catalog = quote_trino_identifier(&catalog)?;
        let schema_literal = trino_string_literal(&schema);
        let table_literal = trino_string_literal(&table_name);
        let location = (catalog.clone(), Some(schema.clone()));

        let column_sql = format!(
            "SELECT column_name, data_type, is_nullable, column_default \
             FROM {quoted_catalog}.information_schema.columns \
             WHERE table_schema = {schema_literal} AND table_name = {table_literal} \
             ORDER BY ordinal_position"
        );
        let column_rows = self.query_rows(&column_sql, Some(&location)).await?;

        // Primary-key flags are best-effort: most connectors do not expose
        // table_constraints, so a failure must not break structure browsing.
        let pk_sql = format!(
            "SELECT kcu.column_name \
             FROM {quoted_catalog}.information_schema.table_constraints tc \
             JOIN {quoted_catalog}.information_schema.key_column_usage kcu \
               ON tc.constraint_catalog = kcu.constraint_catalog \
              AND tc.constraint_schema = kcu.constraint_schema \
              AND tc.constraint_name = kcu.constraint_name \
             WHERE tc.constraint_type = 'PRIMARY KEY' \
               AND tc.table_schema = {schema_literal} \
               AND tc.table_name = {table_literal}"
        );
        let pk_columns: std::collections::HashSet<String> =
            match self.query_rows(&pk_sql, Some(&location)).await {
                Ok(rows) => rows
                    .into_iter()
                    .filter_map(|row| {
                        row.first()
                            .and_then(|value| value.as_str())
                            .map(str::to_string)
                    })
                    .collect(),
                Err(error) => {
                    log::warn!("Trino primary-key lookup failed for {table}: {error}");
                    std::collections::HashSet::new()
                }
            };

        let columns = column_rows
            .into_iter()
            .map(|row| {
                let name = row
                    .first()
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string();
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
                        .map(|value| value.eq_ignore_ascii_case("YES"))
                        .unwrap_or(true),
                    default_value: row
                        .get(3)
                        .and_then(|value| value.as_str())
                        .map(str::to_string),
                    extra: None,
                    column_type: None,
                    comment: None,
                }
            })
            .collect();

        let object_sql = format!(
            "SELECT t.table_type, v.view_definition \
             FROM {quoted_catalog}.information_schema.tables t \
             LEFT JOIN {quoted_catalog}.information_schema.views v \
               ON v.table_catalog = t.table_catalog \
              AND v.table_schema = t.table_schema \
              AND v.table_name = t.table_name \
             WHERE t.table_schema = {schema_literal} AND t.table_name = {table_literal} \
             LIMIT 1"
        );
        let object_row = self
            .query_rows(&object_sql, Some(&location))
            .await?
            .into_iter()
            .next();
        let object_type = object_row
            .as_ref()
            .and_then(|row| row.first())
            .and_then(|value| value.as_str())
            .map(str::to_string);
        let view_definition = object_row
            .as_ref()
            .and_then(|row| row.get(1))
            .and_then(|value| value.as_str())
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
        self.execute_query_inner(sql, None).await
    }

    /// Request-scoped execution: the in-flight URI (statement URL until the
    /// first `nextUri` arrives) is registered so `cancel_query_request` can
    /// DELETE it on a second connection.
    async fn execute_query_for_request(&self, request_id: &str, sql: &str) -> Result<QueryResult> {
        if request_id.trim().is_empty() {
            return self.execute_query(sql).await;
        }
        self.lock_in_flight()
            .insert(request_id.to_string(), self.statement_url());
        let result = self.execute_query_inner(sql, Some(request_id)).await;
        self.lock_in_flight().remove(request_id);
        result
    }

    /// Trino aborts a running query when the client DELETEs its `nextUri`
    /// (or the statement URI before the first page lands).
    async fn cancel_query_request(&self, request_id: &str) -> Result<bool> {
        let uri = self.lock_in_flight().get(request_id).cloned();
        let Some(uri) = uri else {
            return Ok(false);
        };
        // A non-2xx just means the query already finished — still cancelled.
        self.apply_auth(self.client.delete(&uri))
            .send()
            .await
            .context("Failed to send the Trino cancel request")?;
        Ok(true)
    }

    /// The `/v1/statement` protocol has no bind parameters; values must never
    /// be interpolated into SQL text, so parameterized execution is rejected.
    async fn execute_parameterized_query(
        &self,
        _sql: &str,
        _parameters: &[QueryParameter],
    ) -> Result<QueryResult> {
        Err(anyhow!(
            "Trino's HTTP protocol has no bind parameters; parameterized queries are not supported"
        ))
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
        let location = self.resolve_location(database)?;
        let mut sql = format!(
            "SELECT * FROM {}",
            Self::qualify_table_name(table, Some(&location))?
        );

        // Trino shares the double-quoted identifier grammar and has no ILIKE,
        // which is exactly the Snowflake filter dialect.
        if let Some(filter_clause) = sanitize_snowflake_filter_clause(filter)? {
            sql.push_str(&format!(" WHERE {filter_clause}"));
        }

        if let Some(order_by) = order_by {
            let direction = normalize_order_dir(order_dir)?;
            sql.push_str(&format!(
                " ORDER BY {} {}",
                quote_trino_order_by(order_by)?,
                direction
            ));
        }

        sql.push_str(&format!(" LIMIT {limit} OFFSET {offset}"));
        // Page directly through run_statement: execute_query caps results at
        // MAX_QUERY_RESULT_ROWS, which would truncate paged fetches.
        let acc = self
            .run_statement(&sql, Some(&location), None, usize::MAX)
            .await?;
        Ok(self.build_result(acc, &sql, 0))
    }

    async fn count_rows(&self, table: &str, database: Option<&str>) -> Result<i64> {
        let location = self.resolve_location(database)?;
        let sql = format!(
            "SELECT COUNT(*) AS count FROM {}",
            Self::qualify_table_name(table, Some(&location))?
        );
        let rows = self.query_rows(&sql, Some(&location)).await?;
        rows.first()
            .and_then(|row| row.first())
            .and_then(trino_count_value)
            .ok_or_else(|| anyhow!("Trino count query returned no rows"))
    }

    async fn count_null_values(
        &self,
        table: &str,
        database: Option<&str>,
        column: &str,
    ) -> Result<i64> {
        let location = self.resolve_location(database)?;
        let sql = format!(
            "SELECT COUNT(*) AS count FROM {} WHERE {} IS NULL",
            Self::qualify_table_name(table, Some(&location))?,
            quote_trino_identifier(column)?,
        );
        let rows = self.query_rows(&sql, Some(&location)).await?;
        rows.first()
            .and_then(|row| row.first())
            .and_then(trino_count_value)
            .ok_or_else(|| anyhow!("Trino null-count query returned no rows"))
    }

    async fn update_table_cell(&self, request: &TableCellUpdateRequest) -> Result<u64> {
        if request.primary_keys.is_empty() {
            return Err(anyhow!(
                "Inline update requires at least one primary key column"
            ));
        }
        let location = self.resolve_location(request.database.as_deref())?;
        let sql = format!(
            "UPDATE {} SET {} = {} WHERE {}",
            Self::qualify_table_name(&request.table, Some(&location))?,
            quote_trino_identifier(&request.target_column)?,
            trino_literal(&request.value)?,
            trino_pk_condition(&request.primary_keys)?,
        );
        let acc = self
            .run_statement(&sql, Some(&location), None, usize::MAX)
            .await?;
        Ok(acc.update_count.unwrap_or(0))
    }

    async fn delete_table_rows(&self, request: &TableRowDeleteRequest) -> Result<u64> {
        if request.rows.is_empty() {
            return Err(anyhow!("Deleting rows requires at least one selected row"));
        }
        let location = self.resolve_location(request.database.as_deref())?;
        let mut predicates = Vec::with_capacity(request.rows.len());
        for row_keys in &request.rows {
            if row_keys.is_empty() {
                return Err(anyhow!(
                    "Each deleted row must include at least one primary key value"
                ));
            }
            predicates.push(format!("({})", trino_pk_condition(row_keys)?));
        }
        let sql = format!(
            "DELETE FROM {} WHERE {}",
            Self::qualify_table_name(&request.table, Some(&location))?,
            predicates.join(" OR ")
        );
        let acc = self
            .run_statement(&sql, Some(&location), None, usize::MAX)
            .await?;
        Ok(acc.update_count.unwrap_or(request.rows.len() as u64))
    }

    async fn insert_table_row(&self, request: &TableRowInsertRequest) -> Result<u64> {
        if request.values.is_empty() {
            return Err(anyhow!("Insert requires at least one column value"));
        }
        let location = self.resolve_location(request.database.as_deref())?;
        let mut columns = Vec::with_capacity(request.values.len());
        let mut values = Vec::with_capacity(request.values.len());
        for (column, value) in &request.values {
            columns.push(quote_trino_identifier(column)?);
            values.push(trino_literal(value)?);
        }
        let sql = format!(
            "INSERT INTO {} ({}) VALUES ({})",
            Self::qualify_table_name(&request.table, Some(&location))?,
            columns.join(", "),
            values.join(", "),
        );
        let acc = self
            .run_statement(&sql, Some(&location), None, usize::MAX)
            .await?;
        Ok(acc.update_count.unwrap_or(1))
    }

    async fn use_database(&self, database: &str) -> Result<()> {
        let (catalog, schema) = Self::split_catalog_schema(database)?;
        let normalized = match schema {
            Some(schema) => format!("{catalog}.{schema}"),
            None => catalog,
        };
        let mut current = self
            .current_db
            .write()
            .map_err(|_| anyhow!("Failed to access Trino database state"))?;
        *current = Some(normalized);
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
        let location = self.resolve_location(None)?;
        let table_qualified = Self::qualify_table_name(referenced_table, Some(&location))?;
        let column = quote_trino_identifier(referenced_column)?;

        let label_expr = if display_columns.is_empty() {
            format!("CAST({column} AS varchar)")
        } else {
            let cols = display_columns
                .iter()
                .map(|col| {
                    quote_trino_identifier(col).map(|quoted| format!("CAST({quoted} AS varchar)"))
                })
                .collect::<Result<Vec<_>>>()?;
            format!("concat_ws(' ', {})", cols.join(", "))
        };

        let mut sql =
            format!("SELECT {column} AS value, {label_expr} AS label FROM {table_qualified}");
        if let Some(search) = search.map(str::trim).filter(|value| !value.is_empty()) {
            sql.push_str(&format!(
                " WHERE CAST({column} AS varchar) LIKE {}",
                trino_string_literal(&format!("%{search}%"))
            ));
        }
        sql.push_str(&format!(" ORDER BY {column} LIMIT {limit}"));

        let rows = self.query_rows(&sql, Some(&location)).await?;
        Ok(rows
            .into_iter()
            .map(|row| {
                let value = row.first().cloned().unwrap_or(serde_json::Value::Null);
                let label = row.get(1).cloned().unwrap_or(serde_json::Value::Null);
                LookupValue {
                    value,
                    label: match label {
                        serde_json::Value::String(text) => text,
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
        "trino"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page_json(body: &str) -> TrinoPage {
        serde_json::from_str(body).expect("test page must parse")
    }

    #[test]
    fn parses_a_result_page_with_columns_data_and_next_uri() {
        let page = page_json(
            r#"{
                "id": "20260101_000000_00001_abcd",
                "infoUri": "http://coordinator:8080/ui/query.html?20260101_000000_00001_abcd",
                "nextUri": "http://coordinator:8080/v1/statement/20260101_000000_00001_abcd/2",
                "columns": [
                    {"name": "id", "type": "bigint"},
                    {"name": "name", "type": "varchar"}
                ],
                "data": [[1, "alice"], [2, "bob"]],
                "stats": {"state": "RUNNING"}
            }"#,
        );
        assert_eq!(
            page.next_uri.as_deref(),
            Some("http://coordinator:8080/v1/statement/20260101_000000_00001_abcd/2")
        );
        assert_eq!(page.columns.as_ref().map(Vec::len), Some(2));
        assert_eq!(page.data.as_ref().map(Vec::len), Some(2));
        assert!(page.error.is_none());
    }

    #[test]
    fn merge_page_accumulates_columns_and_rows_across_pages() {
        let mut acc = TrinoAccumulated::default();
        let first = page_json(
            r#"{"nextUri": "http://x/2",
                "columns": [{"name": "n", "type": "bigint"}],
                "data": [[1], [2]]}"#,
        );
        let next = TrinoDriver::merge_page(&mut acc, first, 500).unwrap();
        assert_eq!(next.as_deref(), Some("http://x/2"));

        let second = page_json(r#"{"data": [[3]], "stats": {"state": "FINISHED"}}"#);
        let next = TrinoDriver::merge_page(&mut acc, second, 500).unwrap();
        assert!(next.is_none());

        assert_eq!(acc.columns.len(), 1);
        assert_eq!(acc.columns[0].name, "n");
        assert_eq!(acc.rows.len(), 3);
        assert!(!acc.truncated);
    }

    #[test]
    fn merge_page_bails_on_error_pages() {
        let mut acc = TrinoAccumulated::default();
        let page = page_json(
            r#"{"error": {
                    "message": "Table hive.default.missing does not exist",
                    "errorCode": 4,
                    "errorName": "TABLE_NOT_FOUND"
                }}"#,
        );
        let error = TrinoDriver::merge_page(&mut acc, page, 500).unwrap_err();
        assert!(
            error.to_string().contains("TABLE_NOT_FOUND")
                || error.to_string().contains("does not exist")
        );
        assert!(error.to_string().contains('4'));
    }

    #[test]
    fn merge_page_maps_update_count_into_affected_rows() {
        let mut acc = TrinoAccumulated::default();
        let page = page_json(
            r#"{"stats": {"state": "FINISHED", "updateCount": 42, "updateType": "DELETE"}}"#,
        );
        TrinoDriver::merge_page(&mut acc, page, 500).unwrap();
        assert_eq!(acc.update_count, Some(42));

        // Older coordinators serialize updateCount as a string.
        let mut acc = TrinoAccumulated::default();
        let page = page_json(r#"{"stats": {"updateCount": "7"}}"#);
        TrinoDriver::merge_page(&mut acc, page, 500).unwrap();
        assert_eq!(acc.update_count, Some(7));
    }

    #[test]
    fn merge_page_marks_truncation_at_the_row_cap() {
        let mut acc = TrinoAccumulated::default();
        let page = page_json(
            r#"{"nextUri": "http://x/2",
                "columns": [{"name": "n", "type": "bigint"}],
                "data": [[1], [2], [3]]}"#,
        );
        TrinoDriver::merge_page(&mut acc, page, 2).unwrap();
        assert_eq!(acc.rows.len(), 2);
        assert!(acc.truncated);
    }

    #[test]
    fn split_catalog_schema_parses_database_formats() {
        assert_eq!(
            TrinoDriver::split_catalog_schema("hive.sales").unwrap(),
            ("hive".to_string(), Some("sales".to_string()))
        );
        assert_eq!(
            TrinoDriver::split_catalog_schema("hive").unwrap(),
            ("hive".to_string(), None)
        );
        assert_eq!(
            TrinoDriver::split_catalog_schema(" hive . sales ").unwrap(),
            ("hive".to_string(), Some("sales".to_string()))
        );
        assert!(TrinoDriver::split_catalog_schema("").is_err());
        assert!(TrinoDriver::split_catalog_schema(".sales").is_err());
        assert!(TrinoDriver::split_catalog_schema("   ").is_err());
    }

    #[test]
    fn quote_trino_identifier_escapes_and_validates() {
        assert_eq!(quote_trino_identifier("orders").unwrap(), "\"orders\"");
        assert_eq!(quote_trino_identifier("we\"ird").unwrap(), "\"we\"\"ird\"");
        assert!(quote_trino_identifier("").is_err());
        assert!(quote_trino_identifier("  ").is_err());
        assert!(quote_trino_identifier("a\nb").is_err());
    }

    #[test]
    fn qualify_table_name_uses_session_schema_for_bare_names() {
        let location = ("hive".to_string(), Some("sales".to_string()));
        assert_eq!(
            TrinoDriver::qualify_table_name("orders", Some(&location)).unwrap(),
            "\"sales\".\"orders\""
        );
        assert_eq!(
            TrinoDriver::qualify_table_name("orders", None).unwrap(),
            "\"orders\""
        );
        assert_eq!(
            TrinoDriver::qualify_table_name("s.orders", Some(&location)).unwrap(),
            "\"s\".\"orders\""
        );
        assert_eq!(
            TrinoDriver::qualify_table_name("c.s.orders", Some(&location)).unwrap(),
            "\"c\".\"s\".\"orders\""
        );
        assert!(TrinoDriver::qualify_table_name("a.b.c.d", Some(&location)).is_err());
        assert!(TrinoDriver::qualify_table_name("", Some(&location)).is_err());
    }

    #[test]
    fn trino_literal_escapes_values() {
        assert_eq!(
            trino_literal(&serde_json::json!("o'brien")).unwrap(),
            "'o''brien'"
        );
        assert_eq!(trino_literal(&serde_json::json!(42)).unwrap(), "42");
        assert_eq!(trino_literal(&serde_json::json!(true)).unwrap(), "TRUE");
        assert_eq!(trino_literal(&serde_json::Value::Null).unwrap(), "NULL");
        assert!(trino_literal(&serde_json::json!([1, 2])).is_err());
        assert!(trino_literal(&serde_json::json!({"a": 1})).is_err());
    }

    #[test]
    fn pk_condition_handles_null_and_quoted_columns() {
        let keys = vec![
            RowKeyValue {
                column: "id".to_string(),
                value: serde_json::json!(7),
            },
            RowKeyValue {
                column: "deleted_at".to_string(),
                value: serde_json::Value::Null,
            },
        ];
        assert_eq!(
            trino_pk_condition(&keys).unwrap(),
            "\"id\" = 7 AND \"deleted_at\" IS NULL"
        );
    }

    #[test]
    fn cancel_bookkeeping_tracks_only_registered_requests() {
        let driver = TrinoDriver {
            client: Client::new(),
            base_url: "http://localhost:8080".to_string(),
            username: "tabler".to_string(),
            password: None,
            current_db: Arc::new(RwLock::new(None)),
            in_flight: Mutex::new(HashMap::new()),
        };

        // Unregistered request ids are ignored.
        driver.track_next_uri(Some("req-1"), Some("http://x/1"));
        assert!(driver.lock_in_flight().is_empty());

        // Registered ids follow the latest nextUri.
        driver
            .lock_in_flight()
            .insert("req-2".to_string(), driver.statement_url());
        driver.track_next_uri(Some("req-2"), Some("http://x/2"));
        assert_eq!(
            driver.lock_in_flight().get("req-2").cloned(),
            Some("http://x/2".to_string())
        );
        driver.track_next_uri(Some("req-2"), Some("http://x/3"));
        assert_eq!(
            driver.lock_in_flight().get("req-2").cloned(),
            Some("http://x/3".to_string())
        );

        // No request id: nothing recorded.
        driver.track_next_uri(None, Some("http://x/4"));
        assert_eq!(driver.lock_in_flight().len(), 1);
    }

    #[test]
    fn trino_count_value_accepts_numbers_and_strings() {
        assert_eq!(trino_count_value(&serde_json::json!(12)), Some(12));
        assert_eq!(trino_count_value(&serde_json::json!("34")), Some(34));
        assert_eq!(trino_count_value(&serde_json::Value::Null), None);
        assert_eq!(trino_count_value(&serde_json::json!("abc")), None);
    }
}
