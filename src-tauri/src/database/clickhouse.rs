use super::driver::DatabaseDriver;
use super::models::*;
use super::query_cancel::{request_cancel, CancelLookup, CancelScopeGuard, QueryCancelRegistry};
use super::query_common::{statement_returns_rows, MAX_QUERY_RESULT_ROWS};
use super::safety::{
    normalize_order_dir, quote_clickhouse_identifier, quote_clickhouse_order_by,
    sanitize_clickhouse_filter_clause,
};
use crate::utils::sql::split_sql_statements;
use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use futures_util::{stream, Stream, StreamExt};
use reqwest::Client;
use serde::Deserialize;
use serde_json::Value;
use std::pin::Pin;
use std::sync::{Arc, RwLock};
use std::time::Instant;

/// Server-side query cap sent as the `max_execution_time` URL param — the
/// outer tokio timeout only aborts the HTTP wait; without this ClickHouse
/// keeps running the statement after the client gives up.
const CLICKHOUSE_MAX_EXECUTION_TIME_SECS: u64 = 120;

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
    /// request_id → running-query scope so `cancel_query_request` can KILL
    /// the tagged server-side query over a second HTTP request.
    cancel_registry: RwLock<QueryCancelRegistry>,
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
            cancel_registry: RwLock::new(QueryCancelRegistry::new()),
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
                if let Some(database_name) =
                    database.map(str::trim).filter(|value| !value.is_empty())
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
            _ => Err(anyhow!(
                "Only database.table names are supported for ClickHouse"
            )),
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
        self.post_query_with_params(sql, database, &[], None).await
    }

    /// POST `sql` with ClickHouse `param_<name>` URL arguments carrying bound
    /// values for `{name:Type}` placeholders — the HTTP interface has no
    /// positional `?` binds, so values never enter the query text. `query_id`
    /// tags the server-side process so `cancel_query_request` can KILL it.
    async fn post_query_with_params(
        &self,
        sql: &str,
        database: Option<&str>,
        params: &[(String, String)],
        query_id: Option<&str>,
    ) -> Result<String> {
        // Server-side execution cap: the outer tokio timeout aborts the HTTP
        // wait, but ClickHouse would keep running the query without this.
        let mut request = self
            .client
            .post(&self.base_url)
            .basic_auth(&self.username, Some(&self.password))
            .query(&[("max_execution_time", CLICKHOUSE_MAX_EXECUTION_TIME_SECS)])
            .query(params)
            .body(sql.to_string());

        if let Some(database_name) = database.map(str::trim).filter(|value| !value.is_empty()) {
            request = request.query(&[("database", database_name)]);
        }
        if let Some(query_id) = query_id.map(str::trim).filter(|value| !value.is_empty()) {
            request = request.query(&[("query_id", query_id)]);
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

    /// ClickHouse `query_id` for one statement of a cancellable request. The
    /// `tabler-<request_id>-<n>` prefix lets `KILL QUERY` match every statement
    /// of the batch with `startsWith`; request ids are UUIDs, so the trailing
    /// `-` keeps prefixes of different requests disjoint.
    fn request_query_id(request_id: &str, statement_index: usize) -> String {
        format!("tabler-{request_id}-{statement_index}")
    }

    /// Escape a value for a single-quoted ClickHouse string literal.
    fn escape_string_literal(value: &str) -> String {
        value.replace('\\', "\\\\").replace('\'', "\\'")
    }

    async fn query_json(&self, sql: &str, database: Option<&str>) -> Result<ClickHouseJsonResult> {
        self.query_json_with_params(sql, database, &[], None).await
    }

    async fn query_json_with_params(
        &self,
        sql: &str,
        database: Option<&str>,
        params: &[(String, String)],
        query_id: Option<&str>,
    ) -> Result<ClickHouseJsonResult> {
        let body = self
            .post_query_with_params(&Self::append_json_format(sql)?, database, params, query_id)
            .await?;

        serde_json::from_str(&body).context("Failed to parse ClickHouse JSON response")
    }

    fn build_result_from_json(
        result: ClickHouseJsonResult,
        elapsed: u128,
        query: String,
        affected_rows: u64,
        sandboxed: bool,
        row_cap: usize,
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
            if rows.len() == row_cap {
                truncated = true;
                break;
            }

            rows.push(
                result
                    .meta
                    .iter()
                    .map(|column| {
                        row.get(&column.name)
                            .cloned()
                            .unwrap_or(serde_json::Value::Null)
                    })
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

    /// Shared body of `execute_query`/`execute_query_for_request`. When
    /// `request_id` is set, each statement is posted with a derived
    /// `query_id` so a cancel can find and kill it server-side.
    async fn execute_query_inner(
        &self,
        sql: &str,
        request_id: Option<&str>,
    ) -> Result<QueryResult> {
        let start = Instant::now();
        let statements = split_sql_statements(sql);
        let database = self.current_database_name(None);
        let query_id_at = |index: usize| request_id.map(|id| Self::request_query_id(id, index));

        if statements.len() <= 1 && Self::query_returns_rows(sql) {
            let result = self
                .query_json_with_params(sql, Some(&database), &[], query_id_at(0).as_deref())
                .await?;
            return Ok(Self::build_result_from_json(
                result,
                start.elapsed().as_millis(),
                sql.to_string(),
                0,
                false,
                MAX_QUERY_RESULT_ROWS,
            ));
        }

        let total_affected = 0u64;
        let mut last_result = None;

        for (index, statement) in statements
            .iter()
            .filter(|statement| !statement.trim().is_empty())
            .enumerate()
        {
            let query_id = query_id_at(index);
            if Self::query_returns_rows(statement) {
                let result = self
                    .query_json_with_params(statement, Some(&database), &[], query_id.as_deref())
                    .await?;
                last_result = Some(Self::build_result_from_json(
                    result,
                    0,
                    sql.to_string(),
                    total_affected,
                    false,
                    MAX_QUERY_RESULT_ROWS,
                ));
            } else {
                self.post_query_with_params(statement, Some(&database), &[], query_id.as_deref())
                    .await?;
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

    /// Shared body of `execute_parameterized_query` and its request-scoped
    /// variant; `request_id` tags the statement's `query_id` for KILL QUERY.
    async fn execute_parameterized_query_inner(
        &self,
        sql: &str,
        parameters: &[QueryParameter],
        request_id: Option<&str>,
    ) -> Result<QueryResult> {
        let start = Instant::now();
        let database = self.current_database_name(None);
        let (rewritten_sql, params) = rewrite_clickhouse_placeholders(sql, parameters)?;
        let query_id = request_id.map(|id| Self::request_query_id(id, 0));

        if Self::query_returns_rows(&rewritten_sql) {
            let result = self
                .query_json_with_params(
                    &rewritten_sql,
                    Some(&database),
                    &params,
                    query_id.as_deref(),
                )
                .await?;
            return Ok(Self::build_result_from_json(
                result,
                start.elapsed().as_millis(),
                sql.to_string(),
                0,
                false,
                MAX_QUERY_RESULT_ROWS,
            ));
        }

        self.post_query_with_params(
            &rewritten_sql,
            Some(&database),
            &params,
            query_id.as_deref(),
        )
        .await?;
        Ok(QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            affected_rows: 0,
            execution_time_ms: start.elapsed().as_millis(),
            query: sql.to_string(),
            sandboxed: false,
            truncated: false,
        })
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
                    create_date: None,
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

    async fn list_schema_objects(&self, database: Option<&str>) -> Result<Vec<SchemaObjectInfo>> {
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
                    create_date: None,
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
        self.execute_query_inner(sql, None).await
    }

    /// Request-scoped execution: every statement is tagged with a
    /// `tabler-<request_id>-<n>` `query_id` so `cancel_query_request` can KILL
    /// the in-flight statement over a second HTTP request.
    async fn execute_query_for_request(&self, request_id: &str, sql: &str) -> Result<QueryResult> {
        if request_id.trim().is_empty() {
            return self.execute_query(sql).await;
        }
        let guard = CancelScopeGuard::begin(&self.cancel_registry, request_id);
        // The query_id is derived from the request id, so there is no backend
        // id to look up — registering a marker only resolves the pending race.
        if guard.register_backend(0) {
            return Err(anyhow!("Query cancelled."));
        }
        let result = self.execute_query_inner(sql, Some(request_id)).await;
        drop(guard);
        result
    }

    /// Cancels by issuing `KILL QUERY WHERE startsWith(query_id, ...)` over a
    /// fresh HTTP request — the in-flight request is blocked waiting on its
    /// own response, so the kill rides a second connection.
    async fn cancel_query_request(&self, request_id: &str) -> Result<bool> {
        match request_cancel(&self.cancel_registry, request_id) {
            CancelLookup::NotRunning => Ok(false),
            CancelLookup::Pending => Ok(true),
            CancelLookup::Backend(_) => {
                let prefix = Self::escape_string_literal(&format!("tabler-{request_id}-"));
                let kill_sql = format!("KILL QUERY WHERE startsWith(query_id, '{prefix}') ASYNC");
                self.post_query(&kill_sql, None)
                    .await
                    .context("ClickHouse KILL QUERY failed")?;
                Ok(true)
            }
        }
    }

    async fn execute_parameterized_query(
        &self,
        sql: &str,
        parameters: &[QueryParameter],
    ) -> Result<QueryResult> {
        self.execute_parameterized_query_inner(sql, parameters, None)
            .await
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
        let result = self
            .execute_parameterized_query_inner(sql, parameters, Some(request_id))
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
        // Page directly through query_json: execute_query caps results at
        // MAX_QUERY_RESULT_ROWS, which would silently truncate paged fetches
        // beyond 500 rows. The caller's LIMIT bounds the page instead.
        let result = self.query_json(&sql, Some(&db)).await?;
        Ok(Self::build_result_from_json(
            result,
            0,
            sql,
            0,
            false,
            usize::MAX,
        ))
    }

    fn export_table_rows<'a>(
        &'a self,
        table: &'a str,
        database: Option<&'a str>,
        batch_size: u64,
        order_by: Option<&'a str>,
        order_dir: Option<&'a str>,
        filter: Option<&'a str>,
    ) -> Pin<Box<dyn Stream<Item = Result<QueryResult>> + Send + 'a>> {
        let batch_size = batch_size.max(1);
        stream::try_unfold(0_u64, move |offset| async move {
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

            // Export pages walk LIMIT/OFFSET without the interactive row cap.
            sql.push_str(&format!(" LIMIT {batch_size} OFFSET {offset}"));
            let result = self.query_json(&sql, Some(&db)).await?;
            let result = Self::build_result_from_json(result, 0, sql, 0, false, usize::MAX);
            let fetched = result.rows.len() as u64;
            if fetched == 0 {
                return Ok(None);
            }
            Ok(Some((result, offset + fetched)))
        })
        .boxed()
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
            .and_then(clickhouse_count_value)
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
            .and_then(clickhouse_count_value)
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
            return Err(anyhow!("Deleting rows requires at least one selected row"));
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

    async fn insert_table_row(&self, request: &TableRowInsertRequest) -> Result<u64> {
        if request.values.is_empty() {
            return Err(anyhow!("Insert requires at least one column value"));
        }

        let db = self.current_database_name(request.database.as_deref());
        let mut cols = Vec::new();
        let mut vals = Vec::new();
        for (col, value) in &request.values {
            cols.push(quote_clickhouse_identifier(col)?.to_string());
            vals.push(Self::quote_clickhouse_literal(value)?.to_string());
        }

        let sql = format!(
            "INSERT INTO {} ({}) VALUES ({})",
            Self::qualify_table_name(&request.table, Some(&db))?,
            cols.join(", "),
            vals.join(", "),
        );

        self.execute_query(&sql).await?;
        Ok(1)
    }

    fn driver_name(&self) -> &str {
        "ClickHouse"
    }

    async fn get_foreign_key_lookup_values(
        &self,
        referenced_table: &str,
        referenced_column: &str,
        display_columns: &[&str],
        search: Option<&str>,
        limit: u32,
    ) -> Result<Vec<LookupValue>> {
        let db = self.current_database();
        let table_qualified = Self::qualify_table_name(referenced_table, db.as_deref())?;

        // Build label expression
        let label_expr = if !display_columns.is_empty() {
            let cols: Result<Vec<_>> = display_columns
                .iter()
                .map(|c| quote_clickhouse_identifier(c))
                .collect();
            let cols = cols?.join(", ");
            format!("coalesce({})", cols)
        } else {
            quote_clickhouse_identifier(referenced_column)?
        };

        let col_quoted = quote_clickhouse_identifier(referenced_column)?;

        let sql = if let Some(s) = search {
            let like_pattern = format!("%{}%", s);
            format!(
                "SELECT {} AS value, {} AS label \
                 FROM {} \
                 WHERE CAST({} AS String) LIKE '{}' \
                 ORDER BY {} \
                 LIMIT {}",
                col_quoted,
                label_expr,
                table_qualified,
                col_quoted,
                like_pattern,
                col_quoted,
                limit
            )
        } else {
            format!(
                "SELECT {} AS value, {} AS label \
                 FROM {} \
                 ORDER BY {} \
                 LIMIT {}",
                col_quoted, label_expr, table_qualified, col_quoted, limit
            )
        };

        let result = self.query_json(&sql, db.as_deref()).await?;
        let mut values = Vec::with_capacity(result.data.len());
        for row in result.data {
            let v = row.get("value").unwrap_or(&serde_json::Value::Null);
            let lbl = row.get("label").unwrap_or(&serde_json::Value::Null);
            values.push(LookupValue {
                value: v.clone(),
                label: if lbl.is_string() {
                    lbl.as_str().unwrap().to_string()
                } else {
                    serde_json::to_string(lbl).unwrap_or_default()
                },
            });
        }
        Ok(values)
    }
}

/// ClickHouse quotes 64-bit integers inside JSON output by default
/// (`output_format_json_quote_64bit_integers=1`), so counts can arrive as
/// strings ("3") instead of numbers. Accept either shape.
fn clickhouse_count_value(value: &serde_json::Value) -> Option<i64> {
    match value {
        serde_json::Value::Number(number) => number.as_i64(),
        serde_json::Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

/// ClickHouse's HTTP interface binds values through `{name:Type}` placeholders
/// plus `param_<name>` URL arguments, not positional `?` markers. Rewrite each
/// `?` outside literals/comments/heredocs to `{param_N:Type}` (N = 1..n) and
/// produce the matching `param_N` arguments. `parameters` is ordered to match
/// marker positions, so the Nth `?` consumes `parameters[N-1]`.
fn rewrite_clickhouse_placeholders(
    sql: &str,
    parameters: &[QueryParameter],
) -> Result<(String, Vec<(String, String)>)> {
    let chars = sql.chars().collect::<Vec<_>>();
    let mut output = String::with_capacity(sql.len());
    let mut param_args = Vec::new();
    let mut index = 0;
    let mut state = ClickHouseScanState::Normal;
    let mut heredoc_tag: Option<String> = None;

    while index < chars.len() {
        if let Some(tag) = heredoc_tag.as_deref() {
            let tag_chars = tag.chars().collect::<Vec<_>>();
            if chars[index..].starts_with(&tag_chars) {
                output.push_str(tag);
                index += tag_chars.len();
                heredoc_tag = None;
            } else {
                output.push(chars[index]);
                index += 1;
            }
            continue;
        }
        let current = chars[index];
        match state {
            ClickHouseScanState::Normal => {
                if current == '-' && chars.get(index + 1) == Some(&'-') {
                    output.push_str("--");
                    index += 2;
                    state = ClickHouseScanState::LineComment;
                    continue;
                }
                if current == '#' {
                    output.push(current);
                    index += 1;
                    state = ClickHouseScanState::LineComment;
                    continue;
                }
                if current == '/' && chars.get(index + 1) == Some(&'*') {
                    output.push_str("/*");
                    index += 2;
                    state = ClickHouseScanState::BlockComment;
                    continue;
                }
                if current == '\'' {
                    output.push(current);
                    index += 1;
                    state = ClickHouseScanState::SingleQuote;
                    continue;
                }
                if current == '"' {
                    output.push(current);
                    index += 1;
                    state = ClickHouseScanState::DoubleQuote;
                    continue;
                }
                if current == '`' {
                    output.push(current);
                    index += 1;
                    state = ClickHouseScanState::BacktickQuote;
                    continue;
                }
                if current == '$' {
                    let (_, tag_end) = read_clickhouse_heredoc_tag(&chars, index + 1);
                    if chars.get(tag_end) == Some(&'$') {
                        let tag = chars[index..=tag_end].iter().collect::<String>();
                        output.push_str(&tag);
                        index = tag_end + 1;
                        heredoc_tag = Some(tag);
                        continue;
                    }
                }
                if current == '?' {
                    let position = param_args.len() + 1;
                    let parameter = parameters.get(position - 1).ok_or_else(|| {
                        anyhow!(
                            "ClickHouse query has {position} '?' markers but only {} parameters were supplied",
                            parameters.len()
                        )
                    })?;
                    let name = format!("param_{position}");
                    output.push_str(&format!(
                        "{{{name}:{}}}",
                        clickhouse_parameter_type(parameter.data_type)
                    ));
                    param_args.push((name, clickhouse_parameter_value(parameter)?));
                    index += 1;
                    continue;
                }
                output.push(current);
                index += 1;
            }
            ClickHouseScanState::LineComment => {
                output.push(current);
                index += 1;
                if current == '\n' {
                    state = ClickHouseScanState::Normal;
                }
            }
            ClickHouseScanState::BlockComment => {
                output.push(current);
                if current == '*' && chars.get(index + 1) == Some(&'/') {
                    output.push('/');
                    index += 2;
                    state = ClickHouseScanState::Normal;
                } else {
                    index += 1;
                }
            }
            ClickHouseScanState::SingleQuote => {
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
                        state = ClickHouseScanState::Normal;
                    }
                }
            }
            ClickHouseScanState::DoubleQuote => {
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
                        state = ClickHouseScanState::Normal;
                    }
                }
            }
            ClickHouseScanState::BacktickQuote => {
                output.push(current);
                index += 1;
                if current == '`' {
                    state = ClickHouseScanState::Normal;
                }
            }
        }
    }

    if param_args.len() != parameters.len() {
        bail!(
            "ClickHouse query has {} '?' markers but {} parameters were supplied",
            param_args.len(),
            parameters.len()
        );
    }
    Ok((output, param_args))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ClickHouseScanState {
    Normal,
    LineComment,
    BlockComment,
    SingleQuote,
    DoubleQuote,
    BacktickQuote,
}

fn read_clickhouse_heredoc_tag(chars: &[char], start: usize) -> (String, usize) {
    let mut end = start;
    while chars
        .get(end)
        .is_some_and(|value| *value == '_' || value.is_ascii_alphanumeric())
    {
        end += 1;
    }
    (chars[start..end].iter().collect(), end)
}

fn clickhouse_parameter_type(data_type: QueryParameterType) -> &'static str {
    match data_type {
        QueryParameterType::Text | QueryParameterType::Json => "String",
        QueryParameterType::Integer => "Int64",
        QueryParameterType::Decimal => "Float64",
        QueryParameterType::Boolean => "Bool",
        QueryParameterType::Null => "Nullable(String)",
    }
}

/// Serialize a bound value into the text form ClickHouse parses for
/// `param_<name>` URL arguments. NULL uses the `\N` sentinel — the literal
/// string "NULL" is not accepted for Nullable parameters.
fn clickhouse_parameter_value(parameter: &QueryParameter) -> Result<String> {
    match parameter.data_type {
        QueryParameterType::Text => parameter
            .value
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| anyhow!("Parameter '{}' must be a string.", parameter.name)),
        QueryParameterType::Integer => parameter
            .value
            .as_i64()
            .map(|value| value.to_string())
            .ok_or_else(|| anyhow!("Parameter '{}' must be an integer.", parameter.name)),
        QueryParameterType::Decimal => parameter
            .value
            .as_f64()
            .map(|value| value.to_string())
            .ok_or_else(|| anyhow!("Parameter '{}' must be a number.", parameter.name)),
        QueryParameterType::Boolean => parameter
            .value
            .as_bool()
            .map(|value| if value { "1" } else { "0" }.to_string())
            .ok_or_else(|| anyhow!("Parameter '{}' must be boolean.", parameter.name)),
        QueryParameterType::Json => Ok(parameter.value.to_string()),
        QueryParameterType::Null => Ok("\\N".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::{clickhouse_parameter_value, rewrite_clickhouse_placeholders};
    use crate::database::models::{QueryParameter, QueryParameterType};
    use serde_json::json;

    fn param(
        name: &str,
        value: serde_json::Value,
        data_type: QueryParameterType,
    ) -> QueryParameter {
        QueryParameter {
            name: name.to_string(),
            value,
            data_type,
        }
    }

    #[test]
    fn rewrites_markers_to_named_placeholders() {
        let parameters = [
            param("a", json!("x"), QueryParameterType::Text),
            param("b", json!(7), QueryParameterType::Integer),
            param("c", json!(true), QueryParameterType::Boolean),
            param("d", json!(null), QueryParameterType::Null),
        ];
        let (sql, args) =
            rewrite_clickhouse_placeholders("SELECT ?, ?, ?, ?", &parameters).unwrap();
        assert_eq!(
            sql,
            "SELECT {param_1:String}, {param_2:Int64}, {param_3:Bool}, {param_4:Nullable(String)}"
        );
        assert_eq!(
            args,
            vec![
                ("param_1".to_string(), "x".to_string()),
                ("param_2".to_string(), "7".to_string()),
                ("param_3".to_string(), "1".to_string()),
                ("param_4".to_string(), "\\N".to_string()),
            ]
        );
    }

    #[test]
    fn skips_markers_inside_literals_and_comments() {
        let parameters = [param("a", json!(1), QueryParameterType::Integer)];
        let (sql, args) = rewrite_clickhouse_placeholders(
            "SELECT '?' AS s, \"?\" AS d, `?` AS b, $tag$?$tag$ AS h, ? -- ?\n/* ? */ # ?",
            &parameters,
        )
        .unwrap();
        assert_eq!(
            sql,
            "SELECT '?' AS s, \"?\" AS d, `?` AS b, $tag$?$tag$ AS h, {param_1:Int64} -- ?\n/* ? */ # ?"
        );
        assert_eq!(args, vec![("param_1".to_string(), "1".to_string())]);
    }

    #[test]
    fn skips_backslash_escaped_quotes() {
        let parameters = [param("a", json!("v"), QueryParameterType::Text)];
        let (sql, args) =
            rewrite_clickhouse_placeholders("SELECT '\\'?\\'' , ?", &parameters).unwrap();
        assert_eq!(sql, "SELECT '\\'?\\'' , {param_1:String}");
        assert_eq!(args.len(), 1);
    }

    #[test]
    fn rejects_marker_parameter_count_mismatch() {
        assert!(rewrite_clickhouse_placeholders("SELECT ?, ?", &[]).is_err());
        let parameters = [
            param("a", json!(1), QueryParameterType::Integer),
            param("b", json!(2), QueryParameterType::Integer),
        ];
        assert!(rewrite_clickhouse_placeholders("SELECT ?", &parameters).is_err());
    }

    #[test]
    fn rejects_mismatched_value_types() {
        assert!(
            clickhouse_parameter_value(&param("a", json!("x"), QueryParameterType::Integer))
                .is_err()
        );
        assert!(
            clickhouse_parameter_value(&param("a", json!(1), QueryParameterType::Text)).is_err()
        );
    }
}
