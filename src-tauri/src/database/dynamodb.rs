//! Amazon DynamoDB driver over the JSON API (`ExecuteStatement` / PartiQL),
//! signed with AWS Signature Version 4.
//!
//! Auth mapping: `username` carries the AWS access key id, `password` the
//! secret access key, and `additional_fields["session_token"]` an optional
//! STS session token. The token is a credential: `ConnectionStorage` moves it
//! into the OS keyring (like `password`) when a connection is saved and
//! restores it into `additional_fields` when the profile is loaded for
//! connecting, so it never lands plaintext in `connections.json`.
//! `host` is either a region (`us-east-1`) or a full endpoint URL
//! (`http://localhost:8000` for DynamoDB Local); when it is an endpoint,
//! `additional_fields["region"]` picks the signing region.
//!
//! Engine limitations surfaced to callers:
//! - `ExecuteStatement` runs ONE PartiQL statement per request and has no
//!   server-side cancel — request-scoped cancellation only aborts paging
//!   between HTTP calls.
//! - `ExecuteTransaction` is the only atomic write primitive and caps at
//!   100 actions; larger edit queues/imports are rejected rather than
//!   chunked. DynamoDB has no rollback-only transaction, so
//!   `preview_write_transaction` stays unsupported. JSON-snapshot restores
//!   commit each table through one `ExecuteTransaction` when it fits the
//!   cap; a table with more rows falls back to sequential
//!   `ExecuteStatement` calls and is NOT atomic.
//! - `DescribeTable.ItemCount` is approximate (refreshed roughly every 6h).
//! - DynamoDB is schemaless: only key attributes appear in
//!   `AttributeDefinitions`, so `get_table_structure` cannot list
//!   non-key attributes.
//! - PartiQL has no OFFSET — `get_table_data` skips rows client-side while
//!   paging on `NextToken`.

use super::driver::DatabaseDriver;
use super::models::*;
use super::query_cancel::{request_cancel, CancelLookup, CancelScopeGuard, QueryCancelRegistry};
use super::query_common::{statement_returns_rows, MAX_QUERY_RESULT_ROWS};
use super::safety::normalize_order_dir;
use crate::utils::sql::split_sql_statements;
use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use futures_util::{stream, Stream, StreamExt};
use hmac::{Hmac, Mac};
use reqwest::Client;
use serde_json::{json, Map as JsonMap, Value as JsonValue};
use sha2::{Digest, Sha256};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Instant;

/// DynamoDB JSON API version used in the `X-Amz-Target` header.
const DYNAMODB_TARGET_PREFIX: &str = "DynamoDB_20120810";
/// SigV4 service name for the credential scope.
const DYNAMODB_SERVICE: &str = "dynamodb";
/// Upper bound for `ExecuteStatement`'s `Limit` parameter. Larger pages are
/// pointless — DynamoDB already caps a page at 1 MB of evaluated items.
const DYNAMODB_PAGE_LIMIT: u64 = 1_000;
/// Maximum actions in one `ExecuteTransaction` call. AWS rejects larger
/// batches, and splitting them client-side would break atomicity, so
/// oversized edit queues and CSV imports are refused up front.
const DYNAMODB_TRANSACTION_ACTION_LIMIT: usize = 100;
/// Maximum accepted browse-filter length, matching `safety.rs`.
const MAX_FILTER_LEN: usize = 1_000;

type HmacSha256 = Hmac<Sha256>;

pub struct DynamoDbDriver {
    client: Client,
    /// Endpoint origin without a trailing slash (`https://dynamodb.<region>.amazonaws.com`).
    endpoint: String,
    /// `host[:port]` authority of the endpoint, signed as the `host` header.
    authority: String,
    /// Canonical URI path of the POST target (usually `/`).
    canonical_uri: String,
    region: String,
    access_key: String,
    secret_key: String,
    session_token: Option<String>,
    current_db: Arc<RwLock<Option<String>>>,
    cancel_registry: RwLock<QueryCancelRegistry>,
}

/// One `ExecuteStatement` response page.
struct ExecuteStatementPage {
    items: Vec<JsonValue>,
    next_token: Option<String>,
}

/// Client-side offset/limit window over `ExecuteStatement` pages. DynamoDB
/// has no OFFSET, so items are dropped while paging until the window opens.
struct PageCollector {
    skip: u64,
    remaining: u64,
    items: Vec<JsonValue>,
}

impl PageCollector {
    fn new(offset: u64, limit: u64) -> Self {
        Self {
            skip: offset,
            remaining: limit,
            items: Vec::new(),
        }
    }

    /// Absorb one page; returns true once the window is filled.
    fn push_page(&mut self, items: Vec<JsonValue>) -> bool {
        for item in items {
            if self.skip > 0 {
                self.skip -= 1;
                continue;
            }
            if self.remaining == 0 {
                return true;
            }
            self.items.push(item);
            self.remaining -= 1;
        }
        self.remaining == 0
    }

    /// Items still needed to satisfy the window (skip + remaining), used as
    /// the `Limit` hint for the next page request.
    fn needed(&self) -> u64 {
        self.skip + self.remaining
    }

    fn finish(self) -> Vec<JsonValue> {
        self.items
    }
}

impl DynamoDbDriver {
    pub async fn connect(config: &ConnectionConfig) -> Result<Self> {
        let access_key = config
            .username
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .context("DynamoDB requires the AWS access key id in the username field")?
            .to_string();
        let secret_key = config
            .password
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .context("DynamoDB requires the AWS secret access key in the password field")?
            .to_string();
        // Host carries either a region ("us-east-1") or a full endpoint
        // ("http://localhost:8000" for DynamoDB Local).
        let host = config
            .host
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .context("DynamoDB host must be an AWS region or an endpoint URL")?;
        let (endpoint, region) = if host.contains("amazonaws.com") || host.contains("://") {
            let endpoint = if host.contains("://") {
                host.trim_end_matches('/').to_string()
            } else {
                format!("https://{host}")
            };
            // Signing region: explicit `region` field wins, then the region
            // embedded in an AWS hostname (`dynamodb.eu-west-1.amazonaws.com`),
            // then us-east-1 for custom endpoints (e.g. DynamoDB Local).
            let region = config
                .additional_fields
                .get("region")
                .map(|value| value.trim())
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .or_else(|| aws_region_from_hostname(host))
                .unwrap_or_else(|| "us-east-1".to_string());
            (endpoint, region)
        } else {
            (
                format!("https://dynamodb.{host}.amazonaws.com"),
                host.to_string(),
            )
        };

        let session_token = config
            .additional_fields
            .get("session_token")
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .map(str::to_string);

        // The signed `host` header and canonical URI must match the exact URL
        // the POST goes to, so derive both from the final request URL.
        let post_url = format!("{endpoint}/");
        let parsed = reqwest::Url::parse(&post_url)
            .with_context(|| format!("DynamoDB endpoint '{endpoint}' is not a valid URL"))?;
        let authority = parsed
            .host_str()
            .map(|host| match parsed.port() {
                Some(port) => format!("{host}:{port}"),
                None => host.to_string(),
            })
            .context("DynamoDB endpoint URL must include a host")?;
        let canonical_uri = {
            let path = parsed.path();
            if path.is_empty() {
                "/".to_string()
            } else {
                path.to_string()
            }
        };

        Ok(Self {
            client: Client::builder()
                .build()
                .context("Failed to initialize DynamoDB HTTP client")?,
            endpoint,
            authority,
            canonical_uri,
            region,
            access_key,
            secret_key,
            session_token,
            current_db: Arc::new(RwLock::new(config.database.clone())),
            cancel_registry: RwLock::new(QueryCancelRegistry::new()),
        })
    }

    /// POST one DynamoDB JSON API operation and return the decoded body.
    /// Every request is signed with SigV4 over `host;x-amz-date;x-amz-target`
    /// (plus `x-amz-security-token` for STS sessions).
    async fn invoke(&self, operation: &str, payload: JsonValue) -> Result<JsonValue> {
        let body =
            serde_json::to_vec(&payload).context("Failed to serialize DynamoDB request body")?;
        let amz_date = chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
        let target = format!("{DYNAMODB_TARGET_PREFIX}.{operation}");

        let mut signed_headers = vec![
            ("host".to_string(), self.authority.clone()),
            ("x-amz-date".to_string(), amz_date.clone()),
            ("x-amz-target".to_string(), target.clone()),
        ];
        if let Some(token) = &self.session_token {
            signed_headers.push(("x-amz-security-token".to_string(), token.clone()));
        }

        let authorization = sigv4_authorization(
            "POST",
            &self.canonical_uri,
            "",
            &signed_headers,
            &body,
            &self.access_key,
            &self.secret_key,
            &self.region,
            DYNAMODB_SERVICE,
            &amz_date,
        );

        let mut request = self
            .client
            .post(format!("{}/", self.endpoint))
            .header("content-type", "application/x-amz-json-1.0")
            .header("x-amz-date", &amz_date)
            .header("x-amz-target", &target)
            .header("authorization", authorization)
            .body(body);
        if let Some(token) = &self.session_token {
            request = request.header("x-amz-security-token", token);
        }

        let response = request.send().await.with_context(|| {
            format!(
                "DynamoDB {operation} request failed to reach {}",
                self.endpoint
            )
        })?;
        let status = response.status();
        let text = response
            .text()
            .await
            .context("Failed to read DynamoDB response body")?;

        if !status.is_success() {
            bail!(
                "{}",
                dynamodb_error_message(operation, status.as_u16(), &text)
            );
        }

        serde_json::from_str(&text)
            .with_context(|| format!("DynamoDB {operation} returned an invalid JSON response"))
    }

    /// Run one PartiQL statement through `ExecuteStatement`, returning a
    /// single page. `parameters` are `AttributeValue` maps bound to the
    /// statement's positional `?` markers — values never enter the text.
    async fn execute_statement_page(
        &self,
        statement: &str,
        parameters: Option<&[JsonValue]>,
        limit: Option<u64>,
        next_token: Option<&str>,
    ) -> Result<ExecuteStatementPage> {
        let mut payload = json!({ "Statement": statement });
        if let Some(parameters) = parameters.filter(|params| !params.is_empty()) {
            payload["Parameters"] = JsonValue::Array(parameters.to_vec());
        }
        if let Some(limit) = limit {
            payload["Limit"] = json!(limit.clamp(1, DYNAMODB_PAGE_LIMIT));
        }
        if let Some(token) = next_token.map(str::trim).filter(|token| !token.is_empty()) {
            payload["NextToken"] = json!(token);
        }

        let response = self.invoke("ExecuteStatement", payload).await?;
        let items = match response.get("Items") {
            Some(JsonValue::Array(items)) => items.clone(),
            // DML statements legitimately return no Items field at all.
            None => Vec::new(),
            Some(_) => {
                return Err(anyhow!(
                    "DynamoDB ExecuteStatement returned a malformed Items field"
                ))
            }
        };
        let next_token = response
            .get("NextToken")
            .and_then(|value| value.as_str())
            .map(str::to_string);
        Ok(ExecuteStatementPage { items, next_token })
    }

    /// Shared body of `execute_query`/`execute_parameterized_query` and their
    /// request-scoped variants. `cancel` is polled between pages — DynamoDB
    /// cannot abort a statement server-side, but a cancelled request stops
    /// paging immediately.
    async fn execute_query_inner(
        &self,
        sql: &str,
        parameters: Option<&[QueryParameter]>,
        cancel: Option<Arc<AtomicBool>>,
    ) -> Result<QueryResult> {
        let start = Instant::now();
        let statements = split_sql_statements(sql);
        if statements.is_empty() {
            return Err(anyhow!("Query cannot be empty"));
        }
        if parameters.is_some() && statements.len() > 1 {
            return Err(anyhow!(
                "DynamoDB ExecuteStatement accepts a single PartiQL statement"
            ));
        }
        let attribute_parameters = parameters
            .map(|params| {
                params
                    .iter()
                    .map(query_parameter_to_attribute_value)
                    .collect::<Result<Vec<_>>>()
            })
            .transpose()?;

        let mut total_affected = 0_u64;
        let mut last_result = None;

        for statement in statements
            .iter()
            .filter(|statement| !statement.trim().is_empty())
        {
            let is_select = statement_returns_rows(statement, &["SELECT"]);
            let mut items = Vec::new();
            let mut truncated = false;
            let mut next_token = None;

            // Page on NextToken until the statement is exhausted or the
            // interactive row cap is hit.
            loop {
                if cancel_requested(&cancel) {
                    return Err(anyhow!("Query cancelled."));
                }
                let page = self
                    .execute_statement_page(
                        statement,
                        attribute_parameters.as_deref(),
                        None,
                        next_token.as_deref(),
                    )
                    .await?;
                next_token = page.next_token;
                for item in page.items {
                    if items.len() == MAX_QUERY_RESULT_ROWS {
                        truncated = true;
                        break;
                    }
                    items.push(item);
                }
                if truncated || next_token.is_none() {
                    break;
                }
            }

            let affected = if is_select { 0 } else { items.len() as u64 };
            total_affected += affected;
            last_result = Some(Self::items_to_query_result(
                items,
                sql.to_string(),
                affected,
                0,
                truncated,
            ));
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

    /// `SELECT * FROM "table"` plus a validated WHERE/ORDER BY tail. The
    /// table name is always double-quoted; the filter is parsed and rebuilt
    /// with quoted identifiers, so nothing user-supplied reaches PartiQL
    /// verbatim. ORDER BY only works on a sort key — DynamoDB reports the
    /// error itself for anything else.
    fn build_select_statement(
        table: &str,
        order_by: Option<&str>,
        order_dir: Option<&str>,
        filter: Option<&str>,
    ) -> Result<String> {
        let mut statement = format!("SELECT * FROM {}", quote_partiql_identifier(table)?);

        if let Some(clause) = sanitize_partiql_filter(filter)? {
            statement.push_str(" WHERE ");
            statement.push_str(&clause);
        }

        if let Some(order_by) = order_by {
            let direction = normalize_order_dir(order_dir)?;
            statement.push_str(&format!(
                " ORDER BY {} {}",
                quote_partiql_path(order_by)?,
                direction
            ));
        }

        Ok(statement)
    }

    /// Build a `QueryResult` from raw `ExecuteStatement` items. DynamoDB
    /// returns no column metadata, so columns are the union of attribute
    /// names in first-seen order; missing attributes read as NULL.
    fn items_to_query_result(
        items: Vec<JsonValue>,
        query: String,
        affected_rows: u64,
        elapsed: u128,
        truncated: bool,
    ) -> QueryResult {
        let mut column_names: Vec<String> = Vec::new();
        for item in &items {
            if let JsonValue::Object(map) = item {
                for key in map.keys() {
                    if !column_names.iter().any(|name| name == key) {
                        column_names.push(key.clone());
                    }
                }
            }
        }

        let columns = column_names
            .iter()
            .map(|name| ColumnInfo {
                name: name.clone(),
                data_type: "DynamoDB AttributeValue".to_string(),
                is_nullable: true,
                is_primary_key: false,
                max_length: None,
                default_value: None,
            })
            .collect::<Vec<_>>();

        let rows = items
            .iter()
            .map(|item| {
                column_names
                    .iter()
                    .map(|name| {
                        item.get(name)
                            .map(attribute_value_to_json)
                            .unwrap_or(JsonValue::Null)
                    })
                    .collect::<Vec<_>>()
            })
            .collect();

        QueryResult {
            columns,
            rows,
            affected_rows,
            execution_time_ms: elapsed,
            query,
            sandboxed: false,
            truncated,
        }
    }

    /// `DescribeTable` for the named table, returning the `Table` payload.
    async fn describe_table(&self, table: &str) -> Result<JsonValue> {
        let trimmed = table.trim();
        if trimmed.is_empty() {
            return Err(anyhow!("Table name cannot be empty"));
        }
        let response = self
            .invoke("DescribeTable", json!({ "TableName": trimmed }))
            .await?;
        response.get("Table").cloned().ok_or_else(|| {
            anyhow!("DynamoDB DescribeTable returned no Table payload for '{table}'")
        })
    }

    /// PartiQL `UPDATE` for one primary-key cell edit plus its bound
    /// `AttributeValue` parameters. DynamoDB has no NULL assignment —
    /// clearing a cell removes the attribute entirely.
    fn build_update_statement(
        request: &TableCellUpdateRequest,
    ) -> Result<(String, Vec<JsonValue>)> {
        if request.primary_keys.is_empty() {
            return Err(anyhow!(
                "Inline update requires at least one primary key column"
            ));
        }

        let mut parameters = Vec::new();
        let update_clause = if request.value.is_null() {
            format!("REMOVE {}", quote_partiql_path(&request.target_column)?)
        } else {
            parameters.push(json_to_attribute_value(&request.value));
            format!("SET {} = ?", quote_partiql_path(&request.target_column)?)
        };

        let mut where_clause = String::new();
        for (index, primary_key) in request.primary_keys.iter().enumerate() {
            if index > 0 {
                where_clause.push_str(" AND ");
            }
            where_clause.push_str(&quote_partiql_path(&primary_key.column)?);
            where_clause.push_str(" = ?");
            parameters.push(json_to_attribute_value(&primary_key.value));
        }

        Ok((
            format!(
                "UPDATE {} {} WHERE {}",
                quote_partiql_identifier(&request.table)?,
                update_clause,
                where_clause
            ),
            parameters,
        ))
    }

    /// PartiQL `INSERT` for one row plus its bound `AttributeValue`
    /// parameters. Inside a VALUE struct, attribute names are single-quoted
    /// string literals, not identifiers.
    fn build_insert_statement(request: &TableRowInsertRequest) -> Result<(String, Vec<JsonValue>)> {
        if request.values.is_empty() {
            return Err(anyhow!("Insert requires at least one column value"));
        }

        let mut attributes = Vec::with_capacity(request.values.len());
        let mut parameters = Vec::with_capacity(request.values.len());
        for (column, value) in &request.values {
            attributes.push(format!("{}: ?", partiql_string_literal(column)?));
            parameters.push(json_to_attribute_value(value));
        }

        Ok((
            format!(
                "INSERT INTO {} VALUE {{{}}}",
                quote_partiql_identifier(&request.table)?,
                attributes.join(", ")
            ),
            parameters,
        ))
    }

    /// Reject batches DynamoDB cannot commit in one `ExecuteTransaction`.
    /// Chunking is never an option — it would silently break atomicity.
    fn enforce_transaction_action_limit(count: usize, unit: &str) -> Result<()> {
        if count > DYNAMODB_TRANSACTION_ACTION_LIMIT {
            return Err(anyhow!(
                "DynamoDB transactions are limited to {DYNAMODB_TRANSACTION_ACTION_LIMIT} \
                 actions; {count} {unit} cannot be applied atomically"
            ));
        }
        Ok(())
    }

    /// Assemble the `ExecuteTransaction` request body from already-built
    /// `(Statement, Parameters)` pairs. `Parameters` is omitted when empty —
    /// the API treats an empty list as invalid.
    fn build_execute_transaction_payload(statements: Vec<(String, Vec<JsonValue>)>) -> JsonValue {
        let transact_statements = statements
            .into_iter()
            .map(|(statement, parameters)| {
                let mut entry = json!({ "Statement": statement });
                if !parameters.is_empty() {
                    entry["Parameters"] = JsonValue::Array(parameters);
                }
                entry
            })
            .collect::<Vec<_>>();
        json!({ "TransactStatements": transact_statements })
    }

    /// Commit one `ExecuteTransaction` batch. DynamoDB applies every action
    /// or none; a `TransactionCanceledException` aborts the whole batch and
    /// its per-item `CancellationReasons` are surfaced in the error.
    async fn execute_transaction(&self, statements: Vec<(String, Vec<JsonValue>)>) -> Result<()> {
        let payload = Self::build_execute_transaction_payload(statements);
        self.invoke("ExecuteTransaction", payload).await?;
        Ok(())
    }

    /// Classify a restore payload: a TableR JSON snapshot (a `{`-led
    /// document whose `meta.format` is `json-snapshot`) becomes PartiQL
    /// `INSERT` statements grouped per exported table; anything else is a
    /// plain PartiQL script and returns `None`. Snapshot rows are objects
    /// keyed by attribute name — the same shape `row_to_object` exports —
    /// so each object replays through [`Self::build_insert_statement`] with
    /// every value bound as an `AttributeValue` parameter.
    fn snapshot_restore_statements(
        statements: &[String],
    ) -> Result<Option<Vec<SnapshotTableInserts>>> {
        let joined = statements.join(";\n");
        let trimmed = joined.trim();
        if !trimmed.starts_with('{') {
            return Ok(None);
        }
        let snapshot: JsonValue = serde_json::from_str(trimmed).with_context(|| {
            "The restore payload looks like a JSON snapshot but could not be parsed"
        })?;
        let format = snapshot
            .get("meta")
            .and_then(|meta| meta.get("format"))
            .and_then(JsonValue::as_str);
        if format != Some("json-snapshot") {
            return Err(anyhow!(
                "The restore payload is JSON but not a TableR json-snapshot export"
            ));
        }
        let tables = snapshot
            .get("tables")
            .and_then(JsonValue::as_array)
            .ok_or_else(|| anyhow!("The JSON snapshot does not contain a 'tables' array"))?;

        let mut plans = Vec::with_capacity(tables.len());
        for table in tables {
            let name = table
                .get("name")
                .and_then(JsonValue::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .ok_or_else(|| anyhow!("A snapshot table entry is missing its table name"))?;
            let rows = table
                .get("rows")
                .and_then(JsonValue::as_array)
                .cloned()
                .unwrap_or_default();
            let mut inserts = Vec::with_capacity(rows.len());
            for row in &rows {
                let JsonValue::Object(attributes) = row else {
                    return Err(anyhow!("A snapshot row for '{name}' is not a JSON object"));
                };
                let request = TableRowInsertRequest {
                    table: name.to_string(),
                    database: None,
                    values: attributes
                        .iter()
                        .map(|(key, value)| (key.clone(), value.clone()))
                        .collect(),
                };
                inserts.push(
                    Self::build_insert_statement(&request)
                        .with_context(|| format!("Cannot replay a snapshot row for '{name}'"))?,
                );
            }
            plans.push((name.to_string(), inserts));
        }
        Ok(Some(plans))
    }
}

/// One snapshot table and its replayable `INSERT` statements with bound
/// `AttributeValue` parameters — `(table_name, [(statement, bindings)])`.
type SnapshotTableInserts = (String, Vec<(String, Vec<JsonValue>)>);

#[async_trait]
impl DatabaseDriver for DynamoDbDriver {
    async fn ping(&self) -> Result<()> {
        self.invoke("ListTables", json!({ "Limit": 1 }))
            .await
            .context("DynamoDB ping failed")?;
        Ok(())
    }

    async fn disconnect(&self) -> Result<()> {
        Ok(())
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        // DynamoDB has no database concept; the region is the only namespace.
        Ok(vec![DatabaseInfo {
            name: self.region.clone(),
            size: None,
        }])
    }

    async fn list_tables(&self, _database: Option<&str>) -> Result<Vec<TableInfo>> {
        let mut names = Vec::new();
        let mut start = None::<String>;
        loop {
            let mut payload = json!({ "Limit": 100 });
            if let Some(token) = &start {
                payload["ExclusiveStartTableName"] = json!(token);
            }
            let response = self.invoke("ListTables", payload).await?;
            match response.get("TableNames") {
                Some(JsonValue::Array(list)) => names.extend(
                    list.iter()
                        .filter_map(|name| name.as_str().map(str::to_string)),
                ),
                Some(_) => {
                    return Err(anyhow!(
                        "DynamoDB ListTables returned a malformed TableNames field"
                    ))
                }
                None => {}
            }
            start = response
                .get("LastEvaluatedTableName")
                .and_then(|value| value.as_str())
                .map(str::to_string);
            if start.is_none() {
                break;
            }
        }

        names.sort();
        // row_count/size stay None: they require one DescribeTable per table.
        Ok(names
            .into_iter()
            .map(|name| TableInfo {
                name,
                schema: None,
                table_type: "BASE TABLE".to_string(),
                row_count: None,
                engine: Some("DynamoDB".to_string()),
                create_date: None,
            })
            .collect())
    }

    async fn list_schema_objects(&self, _database: Option<&str>) -> Result<Vec<SchemaObjectInfo>> {
        // DynamoDB has no views, triggers, or routines.
        Ok(Vec::new())
    }

    async fn get_table_structure(
        &self,
        table: &str,
        _database: Option<&str>,
    ) -> Result<TableStructure> {
        let description = self.describe_table(table).await?;

        let key_schema = description
            .get("KeySchema")
            .and_then(|value| value.as_array())
            .cloned()
            .unwrap_or_default();
        let key_type_of = |name: &str| -> Option<String> {
            key_schema.iter().find_map(|element| {
                let attribute = element.get("AttributeName")?.as_str()?;
                if attribute == name {
                    element
                        .get("KeyType")
                        .and_then(|value| value.as_str())
                        .map(str::to_string)
                } else {
                    None
                }
            })
        };

        // Only key attributes are declared — DynamoDB is schemaless, so
        // non-key attributes cannot be enumerated here.
        let columns = description
            .get("AttributeDefinitions")
            .and_then(|value| value.as_array())
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter_map(|definition| {
                let name = definition.get("AttributeName")?.as_str()?.to_string();
                let key_type = key_type_of(&name);
                Some(ColumnDetail {
                    name,
                    data_type: match definition.get("AttributeType").and_then(|v| v.as_str()) {
                        Some("N") => "Number".to_string(),
                        Some("B") => "Binary".to_string(),
                        _ => "String".to_string(),
                    },
                    is_nullable: key_type.is_none(),
                    is_primary_key: key_type.is_some(),
                    default_value: None,
                    extra: key_type,
                    column_type: None,
                    comment: None,
                })
            })
            .collect::<Vec<_>>();

        let mut indexes = Vec::new();
        for (field, index_type) in [
            ("GlobalSecondaryIndexes", "GLOBAL SECONDARY"),
            ("LocalSecondaryIndexes", "LOCAL SECONDARY"),
        ] {
            let Some(list) = description.get(field).and_then(|value| value.as_array()) else {
                continue;
            };
            for index in list {
                let Some(name) = index.get("IndexName").and_then(|value| value.as_str()) else {
                    continue;
                };
                let columns = index
                    .get("KeySchema")
                    .and_then(|value| value.as_array())
                    .map(|schema| {
                        schema
                            .iter()
                            .filter_map(|element| {
                                element
                                    .get("AttributeName")
                                    .and_then(|value| value.as_str())
                                    .map(str::to_string)
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                indexes.push(IndexInfo {
                    name: name.to_string(),
                    columns,
                    is_unique: false,
                    index_type: Some(index_type.to_string()),
                });
            }
        }

        Ok(TableStructure {
            columns,
            indexes,
            foreign_keys: Vec::new(),
            triggers: Vec::new(),
            view_definition: None,
            object_type: Some("TABLE".to_string()),
        })
    }

    async fn execute_query(&self, sql: &str) -> Result<QueryResult> {
        self.execute_query_inner(sql, None, None).await
    }

    /// Request-scoped execution: DynamoDB has no server-side cancel, so the
    /// registry only resolves the pending race and the shared flag aborts
    /// `NextToken` paging between HTTP calls.
    async fn execute_query_for_request(&self, request_id: &str, sql: &str) -> Result<QueryResult> {
        if request_id.trim().is_empty() {
            return self.execute_query(sql).await;
        }
        let guard = CancelScopeGuard::begin(&self.cancel_registry, request_id);
        if guard.register_backend(0) {
            return Err(anyhow!("Query cancelled."));
        }
        let flag = guard.cancel_flag();
        let result = self.execute_query_inner(sql, None, flag).await;
        drop(guard);
        result
    }

    async fn cancel_query_request(&self, request_id: &str) -> Result<bool> {
        match request_cancel(&self.cancel_registry, request_id) {
            CancelLookup::NotRunning => Ok(false),
            // `request_cancel` already flipped the shared flag; the paging
            // loop aborts at the next page boundary.
            CancelLookup::Pending | CancelLookup::Backend(_) => Ok(true),
        }
    }

    async fn execute_parameterized_query(
        &self,
        sql: &str,
        parameters: &[QueryParameter],
    ) -> Result<QueryResult> {
        self.execute_query_inner(sql, Some(parameters), None).await
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
        let result = self.execute_query_inner(sql, Some(parameters), flag).await;
        drop(guard);
        result
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
        let statement = Self::build_select_statement(table, order_by, order_dir, filter)?;
        let start = Instant::now();
        let mut collector = PageCollector::new(offset, limit);
        let mut next_token = None;

        loop {
            let page = self
                .execute_statement_page(
                    &statement,
                    None,
                    Some(collector.needed()),
                    next_token.as_deref(),
                )
                .await?;
            next_token = page.next_token;
            let filled = collector.push_page(page.items);
            if filled || next_token.is_none() {
                break;
            }
        }

        Ok(Self::items_to_query_result(
            collector.finish(),
            statement,
            0,
            start.elapsed().as_millis(),
            false,
        ))
    }

    /// Export streams `ExecuteStatement` pages driven by `NextToken` — no
    /// offset skipping, so every row is emitted exactly once.
    fn export_table_rows<'a>(
        &'a self,
        table: &'a str,
        _database: Option<&'a str>,
        batch_size: u64,
        order_by: Option<&'a str>,
        order_dir: Option<&'a str>,
        filter: Option<&'a str>,
    ) -> Pin<Box<dyn Stream<Item = Result<QueryResult>> + Send + 'a>> {
        let statement = match Self::build_select_statement(table, order_by, order_dir, filter) {
            Ok(statement) => statement,
            Err(error) => return stream::once(async move { Err(error) }).boxed(),
        };
        let batch_size = batch_size.clamp(1, DYNAMODB_PAGE_LIMIT);

        stream::try_unfold(
            (None::<String>, false),
            move |(mut next_token, mut done)| {
                let statement = statement.clone();
                async move {
                    loop {
                        if done {
                            return Ok(None);
                        }
                        let page = self
                            .execute_statement_page(
                                &statement,
                                None,
                                Some(batch_size),
                                next_token.as_deref(),
                            )
                            .await?;
                        next_token = page.next_token;
                        done = next_token.is_none();
                        // Skip empty mid-stream pages (1 MB boundary artifacts).
                        if page.items.is_empty() {
                            if done {
                                return Ok(None);
                            }
                            continue;
                        }
                        let result =
                            Self::items_to_query_result(page.items, statement.clone(), 0, 0, false);
                        return Ok(Some((result, (next_token, done))));
                    }
                }
            },
        )
        .boxed()
    }

    /// `DescribeTable.ItemCount` — approximate, refreshed roughly every six
    /// hours. DynamoDB has no cheap exact COUNT.
    async fn count_rows(&self, table: &str, _database: Option<&str>) -> Result<i64> {
        let description = self.describe_table(table).await?;
        description
            .get("ItemCount")
            .and_then(|value| value.as_i64())
            .ok_or_else(|| anyhow!("DynamoDB DescribeTable returned no ItemCount for '{table}'"))
    }

    async fn count_null_values(
        &self,
        _table: &str,
        _database: Option<&str>,
        _column: &str,
    ) -> Result<i64> {
        Err(anyhow!(
            "DynamoDB cannot count NULL values server-side; the column would have to be scanned client-side"
        ))
    }

    async fn update_table_cell(&self, request: &TableCellUpdateRequest) -> Result<u64> {
        let (statement, parameters) = Self::build_update_statement(request)?;
        self.execute_statement_page(&statement, Some(&parameters), None, None)
            .await?;
        Ok(1)
    }

    /// Atomic edit queue via `ExecuteTransaction`: every staged UPDATE lands
    /// in one `TransactStatements` batch, so DynamoDB commits all of them or
    /// none. The 100-action cap is enforced up front — chunking would break
    /// the all-or-nothing contract.
    async fn apply_table_updates_atomically(
        &self,
        updates: &[TableCellUpdateRequest],
    ) -> Result<u64> {
        Self::enforce_transaction_action_limit(updates.len(), "cell updates")?;
        let statements = updates
            .iter()
            .map(Self::build_update_statement)
            .collect::<Result<Vec<_>>>()?;
        if statements.is_empty() {
            return Ok(0);
        }
        self.execute_transaction(statements).await?;
        Ok(updates.len() as u64)
    }

    async fn delete_table_rows(&self, request: &TableRowDeleteRequest) -> Result<u64> {
        if request.rows.is_empty() {
            return Err(anyhow!("Deleting rows requires at least one selected row"));
        }

        let table = quote_partiql_identifier(&request.table)?;
        // PartiQL DELETE requires the full primary key per statement — no OR
        // batching — and ExecuteStatement has no multi-statement transaction,
        // so rows go one statement each. A mid-batch failure leaves earlier
        // rows deleted and surfaces the error.
        for row_keys in &request.rows {
            if row_keys.is_empty() {
                return Err(anyhow!(
                    "Each deleted row must include at least one primary key value"
                ));
            }
            let mut where_clause = String::new();
            let mut parameters = Vec::with_capacity(row_keys.len());
            for (index, primary_key) in row_keys.iter().enumerate() {
                if index > 0 {
                    where_clause.push_str(" AND ");
                }
                where_clause.push_str(&quote_partiql_path(&primary_key.column)?);
                where_clause.push_str(" = ?");
                parameters.push(json_to_attribute_value(&primary_key.value));
            }
            let statement = format!("DELETE FROM {table} WHERE {where_clause}");
            self.execute_statement_page(&statement, Some(&parameters), None, None)
                .await?;
        }
        Ok(request.rows.len() as u64)
    }

    async fn insert_table_row(&self, request: &TableRowInsertRequest) -> Result<u64> {
        let (statement, parameters) = Self::build_insert_statement(request)?;
        self.execute_statement_page(&statement, Some(&parameters), None, None)
            .await?;
        Ok(1)
    }

    /// Atomic CSV import via `ExecuteTransaction`. The cancel flag is
    /// honoured while statements are built and once more before commit —
    /// DynamoDB cannot abort an in-flight transaction, but the single
    /// request either commits every row or none.
    async fn insert_table_rows_atomically(
        &self,
        requests: &[TableRowInsertRequest],
        cancelled: Arc<AtomicBool>,
    ) -> Result<u64> {
        if requests.is_empty() {
            return Err(anyhow!("CSV import requires at least one row"));
        }
        Self::enforce_transaction_action_limit(requests.len(), "CSV rows")?;

        let mut statements = Vec::with_capacity(requests.len());
        for request in requests {
            if cancelled.load(Ordering::Relaxed) {
                return Err(anyhow!("CSV import cancelled; all rows were rolled back"));
            }
            statements.push(Self::build_insert_statement(request)?);
        }
        if cancelled.load(Ordering::Relaxed) {
            return Err(anyhow!("CSV import cancelled; all rows were rolled back"));
        }

        self.execute_transaction(statements).await?;
        Ok(requests.len() as u64)
    }

    /// Streaming import buffers every row, then commits one
    /// `ExecuteTransaction`. DynamoDB has no incremental transaction to
    /// flush mid-stream, so files beyond the 100-action cap cannot be
    /// imported atomically and are rejected before anything is written.
    async fn insert_table_row_stream_atomically(
        &self,
        mut rows: tokio::sync::mpsc::Receiver<crate::database::models::CsvImportRow>,
        cancelled: Arc<AtomicBool>,
    ) -> Result<u64> {
        let mut requests = Vec::new();
        while let Some(row) = rows.recv().await {
            if cancelled.load(Ordering::Relaxed) {
                return Err(anyhow!("CSV import cancelled; all rows were rolled back"));
            }
            requests.push(row.map_err(anyhow::Error::msg)?);
            if requests.len() > DYNAMODB_TRANSACTION_ACTION_LIMIT {
                return Err(anyhow!(
                    "CSV import exceeds DynamoDB's {DYNAMODB_TRANSACTION_ACTION_LIMIT}-action \
                     transaction limit; streaming writes cannot be made atomic beyond it"
                ));
            }
        }
        self.insert_table_rows_atomically(&requests, cancelled)
            .await
    }

    /// Schema edits map a minimal DDL subset onto DynamoDB control-plane
    /// calls: `CREATE TABLE name (pk type[, sk type])` → `CreateTable`
    /// (on-demand billing) and `DROP TABLE name` → `DeleteTable`. Names and
    /// types are parsed into a structured JSON payload — never interpolated
    /// into a statement — and anything outside the subset is rejected with a
    /// clear error. Each statement is applied sequentially; DynamoDB has no
    /// multi-statement DDL transaction.
    async fn execute_structure_statements(&self, statements: &[String]) -> Result<u64> {
        let mut total_affected = 0_u64;
        for statement in statements {
            if statement.trim().is_empty() {
                continue;
            }
            let (operation, payload) = parse_ddl_statement(statement)?;
            self.invoke(operation, payload).await?;
            total_affected += 1;
        }
        Ok(total_affected)
    }

    /// Restore replays either a TableR JSON snapshot or a plain PartiQL
    /// dump.
    ///
    /// A snapshot exports rows as PartiQL `INSERT`s grouped per table: a
    /// table whose INSERTs fit one `ExecuteTransaction` (≤100 actions)
    /// commits atomically; a table with more rows falls back to sequential
    /// `ExecuteStatement` calls — NOT atomic, so a failure leaves earlier
    /// rows applied (logged as a warning, error surfaced honestly).
    /// Snapshots contain no table-creation step: restoring into a missing
    /// table surfaces DynamoDB's own error.
    ///
    /// Plain dumps replay one request per statement — DynamoDB cannot
    /// transact across calls, so that path was never atomic either.
    async fn execute_restore_statements(&self, statements: &[String]) -> Result<u64> {
        if let Some(tables) = Self::snapshot_restore_statements(statements)? {
            let mut total_affected = 0_u64;
            for (table, inserts) in tables {
                if inserts.is_empty() {
                    continue;
                }
                if inserts.len() <= DYNAMODB_TRANSACTION_ACTION_LIMIT {
                    self.execute_transaction(inserts).await?;
                    total_affected += 1;
                    continue;
                }
                log::warn!(
                    "DynamoDB snapshot restore of '{table}' applies {} INSERTs \
                     sequentially — a table exceeding the {DYNAMODB_TRANSACTION_ACTION_LIMIT}-action \
                     transaction cap cannot restore atomically",
                    inserts.len()
                );
                for (statement, parameters) in &inserts {
                    self.execute_statement_page(statement, Some(parameters), None, None)
                        .await?;
                }
                total_affected += 1;
            }
            return Ok(total_affected);
        }

        let mut total_affected = 0_u64;
        for statement in statements {
            if statement.trim().is_empty() {
                continue;
            }
            self.execute_statement_page(statement, None, None, None)
                .await?;
            total_affected += 1;
        }
        Ok(total_affected)
    }

    async fn use_database(&self, _database: &str) -> Result<()> {
        Err(anyhow!(
            "DynamoDB has no database concept; the AWS region is fixed by the connection"
        ))
    }

    async fn get_foreign_key_lookup_values(
        &self,
        _referenced_table: &str,
        _referenced_column: &str,
        _display_columns: &[&str],
        _search: Option<&str>,
        _limit: u32,
    ) -> Result<Vec<LookupValue>> {
        Err(anyhow!(
            "DynamoDB has no foreign keys; lookup values are not supported"
        ))
    }

    fn current_database(&self) -> Option<String> {
        self.current_db.read().ok()?.clone()
    }

    fn driver_name(&self) -> &str {
        "dynamodb"
    }
}

fn cancel_requested(flag: &Option<Arc<AtomicBool>>) -> bool {
    flag.as_ref()
        .is_some_and(|flag| flag.load(Ordering::SeqCst))
}

// ---------------------------------------------------------------------------
// AWS Signature Version 4
// ---------------------------------------------------------------------------

fn sha256_hex(data: &[u8]) -> String {
    to_hex(&Sha256::digest(data))
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

/// SigV4 header value normalization: trim and collapse whitespace runs.
fn normalize_header_value(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The standard `AWS4 + secret → date → region → service → aws4_request`
/// HMAC chain.
fn sigv4_derive_signing_key(secret_key: &str, date: &str, region: &str, service: &str) -> Vec<u8> {
    let k_date = hmac_sha256(format!("AWS4{secret_key}").as_bytes(), date.as_bytes());
    let k_region = hmac_sha256(&k_date, region.as_bytes());
    let k_service = hmac_sha256(&k_region, service.as_bytes());
    hmac_sha256(&k_service, b"aws4_request")
}

/// Build the canonical request and the `SignedHeaders` list. `headers` must
/// already be lowercase-named; they are sorted here per the spec.
fn sigv4_canonical_request(
    method: &str,
    canonical_uri: &str,
    canonical_query: &str,
    headers: &[(String, String)],
    payload_hash: &str,
) -> (String, String) {
    let mut sorted = headers.to_vec();
    sorted.sort_by(|left, right| left.0.cmp(&right.0));

    let mut canonical_headers = String::new();
    let mut signed_names = Vec::with_capacity(sorted.len());
    for (name, value) in &sorted {
        canonical_headers.push_str(name);
        canonical_headers.push(':');
        canonical_headers.push_str(&normalize_header_value(value));
        canonical_headers.push('\n');
        signed_names.push(name.as_str());
    }
    let signed_headers = signed_names.join(";");

    let request = format!(
        "{method}\n{canonical_uri}\n{canonical_query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
    );
    (request, signed_headers)
}

/// Full SigV4 `Authorization` header value for one request. `amz_date` is
/// `YYYYMMDD'T'HHMMSS'Z'`; the credential scope date is its first 8 chars.
#[allow(clippy::too_many_arguments)]
fn sigv4_authorization(
    method: &str,
    canonical_uri: &str,
    canonical_query: &str,
    headers: &[(String, String)],
    payload: &[u8],
    access_key: &str,
    secret_key: &str,
    region: &str,
    service: &str,
    amz_date: &str,
) -> String {
    let payload_hash = sha256_hex(payload);
    let (canonical_request, signed_headers) = sigv4_canonical_request(
        method,
        canonical_uri,
        canonical_query,
        headers,
        &payload_hash,
    );

    let date = &amz_date[..8];
    let scope = format!("{date}/{region}/{service}/aws4_request");
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );

    let signing_key = sigv4_derive_signing_key(secret_key, date, region, service);
    let signature = to_hex(&hmac_sha256(&signing_key, string_to_sign.as_bytes()));

    format!(
        "AWS4-HMAC-SHA256 Credential={access_key}/{scope}, SignedHeaders={signed_headers}, Signature={signature}"
    )
}

/// Extract the region from an AWS endpoint hostname or URL
/// (`dynamodb.eu-west-1.amazonaws.com` → `eu-west-1`). Returns `None` for
/// custom endpoints (DynamoDB Local, proxies) and global hostnames.
fn aws_region_from_hostname(host: &str) -> Option<String> {
    let hostname = host
        .split("://")
        .nth(1)
        .unwrap_or(host)
        .split('/')
        .next()
        .unwrap_or(host)
        .split(':')
        .next()
        .unwrap_or(host);
    let labels = hostname.split('.').collect::<Vec<_>>();
    // dynamodb.<region>.amazonaws.com and
    // *.dynamodb.<region>.vpce.amazonaws.com — the region sits before the
    // trailing amazonaws.com (skipping a `vpce` label).
    if labels.len() >= 4 && labels[labels.len() - 2..] == ["amazonaws", "com"] {
        let index = if labels[labels.len() - 3] == "vpce" && labels.len() >= 5 {
            labels.len() - 4
        } else {
            labels.len() - 3
        };
        let region = labels[index];
        if !region.is_empty() && region != "dynamodb" && region != "vpce" {
            return Some(region.to_string());
        }
    }
    None
}

/// Extract `__type`/`message` from a DynamoDB error envelope. A
/// `TransactionCanceledException` additionally carries per-item
/// `CancellationReasons` — appended so callers learn WHICH action failed.
fn dynamodb_error_message(operation: &str, status: u16, body: &str) -> String {
    let parsed = serde_json::from_str::<JsonValue>(body).ok();
    let kind = parsed
        .as_ref()
        .and_then(|value| value.get("__type"))
        .and_then(|value| value.as_str())
        .map(|raw| raw.rsplit('#').next().unwrap_or(raw));
    let message = parsed
        .as_ref()
        .and_then(|value| value.get("message").or_else(|| value.get("Message")))
        .and_then(|value| value.as_str());

    let mut rendered = match (kind, message) {
        (Some(kind), Some(message)) => {
            format!("DynamoDB {operation} failed ({status} {kind}): {message}")
        }
        (Some(kind), None) => format!("DynamoDB {operation} failed ({status} {kind})"),
        _ => {
            return format!(
                "DynamoDB {operation} failed with status {status}: {}",
                body.trim()
            )
        }
    };

    if let Some(reasons) = parsed
        .as_ref()
        .and_then(|value| value.get("CancellationReasons"))
        .and_then(|value| value.as_array())
    {
        let details = reasons
            .iter()
            .enumerate()
            .filter_map(|(index, reason)| {
                let code = reason.get("Code").and_then(|value| value.as_str())?;
                if code == "None" {
                    return None;
                }
                let detail = reason
                    .get("Message")
                    .and_then(|value| value.as_str())
                    .map(|text| format!(": {text}"))
                    .unwrap_or_default();
                Some(format!("action {index}: {code}{detail}"))
            })
            .collect::<Vec<_>>();
        if !details.is_empty() {
            rendered.push_str(&format!(" [{}]", details.join("; ")));
        }
    }
    rendered
}

// ---------------------------------------------------------------------------
// AttributeValue <-> JSON conversion
// ---------------------------------------------------------------------------

/// Convert a DynamoDB `AttributeValue` map (`{"S": "x"}`, `{"N": "1"}`, ...)
/// into plain JSON. `N`/`NS` payloads are parsed to numbers; unparseable
/// numbers keep their string form rather than being dropped. Unknown tags
/// pass through untouched.
fn attribute_value_to_json(value: &JsonValue) -> JsonValue {
    let Some(map) = value.as_object() else {
        return value.clone();
    };
    let Some((tag, payload)) = map.iter().next() else {
        return JsonValue::Null;
    };

    match tag.as_str() {
        "S" | "B" | "SS" | "BS" | "BOOL" => payload.clone(),
        "NULL" => JsonValue::Null,
        "N" => payload
            .as_str()
            .map(dynamodb_number_to_json)
            .unwrap_or_else(|| payload.clone()),
        "NS" => payload
            .as_array()
            .map(|items| {
                JsonValue::Array(
                    items
                        .iter()
                        .map(|item| {
                            item.as_str()
                                .map(dynamodb_number_to_json)
                                .unwrap_or_else(|| item.clone())
                        })
                        .collect(),
                )
            })
            .unwrap_or_else(|| payload.clone()),
        "M" => payload
            .as_object()
            .map(|object| {
                JsonValue::Object(
                    object
                        .iter()
                        .map(|(key, value)| (key.clone(), attribute_value_to_json(value)))
                        .collect::<JsonMap<String, JsonValue>>(),
                )
            })
            .unwrap_or_else(|| payload.clone()),
        "L" => payload
            .as_array()
            .map(|items| JsonValue::Array(items.iter().map(attribute_value_to_json).collect()))
            .unwrap_or_else(|| payload.clone()),
        _ => value.clone(),
    }
}

/// DynamoDB numbers arrive as strings; parse to i64/u64/f64, falling back to
/// the raw string for out-of-range or non-finite values.
fn dynamodb_number_to_json(raw: &str) -> JsonValue {
    if let Ok(value) = raw.parse::<i64>() {
        return JsonValue::from(value);
    }
    if let Ok(value) = raw.parse::<u64>() {
        return JsonValue::from(value);
    }
    if let Ok(value) = raw.parse::<f64>() {
        if value.is_finite() {
            return JsonValue::from(value);
        }
    }
    JsonValue::String(raw.to_string())
}

/// Convert plain JSON into a DynamoDB `AttributeValue` map. Used for bound
/// parameters and write-path values — never interpolated into statement text.
fn json_to_attribute_value(value: &JsonValue) -> JsonValue {
    match value {
        JsonValue::Null => json!({ "NULL": true }),
        JsonValue::Bool(flag) => json!({ "BOOL": flag }),
        JsonValue::Number(number) => json!({ "N": number.to_string() }),
        JsonValue::String(text) => json!({ "S": text }),
        JsonValue::Array(items) => {
            let converted = items
                .iter()
                .map(json_to_attribute_value)
                .collect::<Vec<_>>();
            json!({ "L": converted })
        }
        JsonValue::Object(map) => {
            let converted = map
                .iter()
                .map(|(key, value)| (key.clone(), json_to_attribute_value(value)))
                .collect::<JsonMap<String, JsonValue>>();
            json!({ "M": converted })
        }
    }
}

/// Map a typed `QueryParameter` to an `AttributeValue`, following the same
/// strict per-type checks the other drivers use.
fn query_parameter_to_attribute_value(parameter: &QueryParameter) -> Result<JsonValue> {
    let value = &parameter.value;
    Ok(match parameter.data_type {
        QueryParameterType::Text => json!({ "S": value.as_str().ok_or_else(|| {
            anyhow!("Parameter '{}' must be a string.", parameter.name)
        })? }),
        QueryParameterType::Integer => json!({ "N": value.as_i64().ok_or_else(|| {
            anyhow!("Parameter '{}' must be an integer.", parameter.name)
        })?.to_string() }),
        QueryParameterType::Decimal => json!({ "N": value.as_f64().ok_or_else(|| {
            anyhow!("Parameter '{}' must be a number.", parameter.name)
        })?.to_string() }),
        QueryParameterType::Boolean => json!({ "BOOL": value.as_bool().ok_or_else(|| {
            anyhow!("Parameter '{}' must be boolean.", parameter.name)
        })? }),
        QueryParameterType::Json => json_to_attribute_value(value),
        QueryParameterType::Null => json!({ "NULL": true }),
    })
}

// ---------------------------------------------------------------------------
// PartiQL quoting and filter sanitizing
// ---------------------------------------------------------------------------

/// Quote one PartiQL identifier with double quotes (embedded `"` doubled).
/// Rejects empty names and control characters so nothing can break out of
/// the quoted context.
fn quote_partiql_identifier(value: &str) -> Result<String> {
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

/// Quote a possibly dotted attribute path (`a.b` → `"a"."b"`) for column
/// positions. Table names use [`quote_partiql_identifier`] instead — a dot
/// inside a table name is literal, not a path separator.
fn quote_partiql_path(value: &str) -> Result<String> {
    let parts = value.split('.').map(str::trim).collect::<Vec<_>>();
    if parts.is_empty() || parts.len() > 8 || parts.iter().any(|part| part.is_empty()) {
        return Err(anyhow!("Invalid identifier path in DynamoDB statement"));
    }
    Ok(parts
        .iter()
        .map(|part| quote_partiql_identifier(part))
        .collect::<Result<Vec<_>>>()?
        .join("."))
}

/// Render a single-quoted PartiQL string literal (`'` doubled). Used for
/// attribute names inside INSERT VALUE structs, which are literals, not
/// identifiers.
fn partiql_string_literal(value: &str) -> Result<String> {
    if value.is_empty() {
        return Err(anyhow!("Attribute name cannot be empty"));
    }
    if value.chars().any(|ch| matches!(ch, '\0' | '\r' | '\n')) {
        return Err(anyhow!(
            "Attribute name contains invalid control characters"
        ));
    }
    Ok(format!("'{}'", value.replace('\'', "''")))
}

// ---------------------------------------------------------------------------
// Minimal DDL subset → DynamoDB control-plane operations
// ---------------------------------------------------------------------------

/// One token of the DDL subset grammar: a bare word (keywords, types), a
/// double-quoted identifier (already unescaped), or punctuation.
#[derive(Debug, PartialEq)]
enum DdlToken {
    Word(String),
    Ident(String),
    Punct(char),
}

/// Split a DDL statement into tokens. Only whitespace, `"`-quoted
/// identifiers, `(`, `)`, `,`, `;` and bare `[A-Za-z0-9_.$-]` words are
/// recognized — anything else (quotes, comments, operators) fails here so
/// no fragment can be reinterpreted as part of a name.
fn tokenize_ddl(statement: &str) -> Result<Vec<DdlToken>> {
    let mut tokens = Vec::new();
    let mut chars = statement.chars().peekable();
    while let Some(&ch) = chars.peek() {
        match ch {
            ch if ch.is_whitespace() => {
                chars.next();
            }
            '(' | ')' | ',' | ';' => {
                tokens.push(DdlToken::Punct(ch));
                chars.next();
            }
            '"' => {
                chars.next();
                let mut name = String::new();
                loop {
                    match chars.next() {
                        Some('"') if chars.peek() == Some(&'"') => {
                            name.push('"');
                            chars.next();
                        }
                        Some('"') => break,
                        Some(inner) => name.push(inner),
                        None => {
                            return Err(anyhow!("Unterminated quoted identifier in DDL statement"))
                        }
                    }
                }
                tokens.push(DdlToken::Ident(name));
            }
            ch if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '$' | '#' | '-') => {
                let mut word = String::new();
                while let Some(&next) = chars.peek() {
                    if next.is_ascii_alphanumeric() || matches!(next, '_' | '.' | '$' | '#' | '-') {
                        word.push(next);
                        chars.next();
                    } else {
                        break;
                    }
                }
                tokens.push(DdlToken::Word(word));
            }
            other => {
                return Err(anyhow!(
                    "Unsupported character '{other}' in DDL statement; only \
                     CREATE TABLE / DROP TABLE are supported"
                ))
            }
        }
    }
    Ok(tokens)
}

/// Pull the next identifier token (quoted or bare word). Bare keywords are
/// accepted as names — DynamoDB attribute/table names have no reserved
/// words — but punctuation never is.
fn next_ddl_ident(tokens: &[DdlToken], pos: &mut usize, what: &str) -> Result<String> {
    let name = match tokens.get(*pos) {
        Some(DdlToken::Ident(name)) | Some(DdlToken::Word(name)) => name.clone(),
        _ => return Err(anyhow!("Expected {what} in DDL statement")),
    };
    *pos += 1;
    if name.is_empty()
        || name
            .chars()
            .any(|ch| matches!(ch, '\0' | '\r' | '\n' | '\t'))
    {
        return Err(anyhow!("Invalid {what} in DDL statement"));
    }
    Ok(name)
}

/// Consume one expected keyword, case-insensitively.
fn expect_ddl_keyword(tokens: &[DdlToken], pos: &mut usize, keyword: &str) -> Result<()> {
    match tokens.get(*pos) {
        Some(DdlToken::Word(word)) if word.eq_ignore_ascii_case(keyword) => {
            *pos += 1;
            Ok(())
        }
        _ => Err(anyhow!("Expected {keyword} in DDL statement")),
    }
}

/// Consume one expected punctuation token.
fn expect_ddl_punct(tokens: &[DdlToken], pos: &mut usize, punct: char) -> Result<()> {
    match tokens.get(*pos) {
        Some(DdlToken::Punct(ch)) if *ch == punct => {
            *pos += 1;
            Ok(())
        }
        _ => Err(anyhow!("Expected '{punct}' in DDL statement")),
    }
}

/// Consume an optional keyword; returns whether it was present.
fn eat_ddl_keyword(tokens: &[DdlToken], pos: &mut usize, keyword: &str) -> bool {
    if matches!(tokens.get(*pos), Some(DdlToken::Word(word)) if word.eq_ignore_ascii_case(keyword))
    {
        *pos += 1;
        true
    } else {
        false
    }
}

/// Map a SQL-ish column type onto a DynamoDB scalar key type. Only S/N/B
/// exist for key attributes; anything else is rejected so a typo never
/// silently creates a wrongly-typed key.
fn dynamodb_key_type(word: &str) -> Result<&'static str> {
    Ok(match word.to_ascii_uppercase().as_str() {
        "S" | "STRING" | "TEXT" | "VARCHAR" | "CHAR" => "S",
        "N" | "NUMBER" | "INT" | "INTEGER" | "BIGINT" | "SMALLINT" | "TINYINT" | "FLOAT"
        | "DOUBLE" | "REAL" | "DECIMAL" | "NUMERIC" => "N",
        "B" | "BINARY" | "BLOB" | "BYTES" | "VARBINARY" => "B",
        other => {
            return Err(anyhow!(
                "Unsupported key attribute type '{other}'; DynamoDB keys are S, N, or B"
            ))
        }
    })
}

/// Parse one statement of the supported DDL subset into a DynamoDB
/// control-plane `(operation, payload)` pair:
///
/// - `CREATE TABLE name (pk col type[, sk col type])` → `CreateTable` with
///   `BillingMode: PAY_PER_REQUEST`. Only key attributes are declared —
///   non-key columns do not exist in DynamoDB's schema.
/// - `DROP TABLE name` → `DeleteTable`.
///
/// Names and types are parsed tokens placed into a structured JSON
/// payload; nothing is ever interpolated into a statement string.
fn parse_ddl_statement(statement: &str) -> Result<(&'static str, JsonValue)> {
    let tokens = tokenize_ddl(statement)?;
    let mut pos = 0_usize;
    // Tolerate leading/trailing semicolons from script splitting.
    while matches!(tokens.get(pos), Some(DdlToken::Punct(';'))) {
        pos += 1;
    }

    let unsupported = || {
        anyhow!(
            "Unsupported statement for DynamoDB schema edit; only \
             CREATE TABLE name (pk type[, sk type]) and DROP TABLE name are supported"
        )
    };

    let verb = match tokens.get(pos) {
        Some(DdlToken::Word(word)) => word.to_ascii_uppercase(),
        _ => return Err(unsupported()),
    };
    pos += 1;

    let result = match verb.as_str() {
        "CREATE" => {
            expect_ddl_keyword(&tokens, &mut pos, "TABLE")?;
            // Optional IF NOT EXISTS.
            if eat_ddl_keyword(&tokens, &mut pos, "IF") {
                expect_ddl_keyword(&tokens, &mut pos, "NOT")?;
                expect_ddl_keyword(&tokens, &mut pos, "EXISTS")?;
            }
            let table = next_ddl_ident(&tokens, &mut pos, "table name")?;
            expect_ddl_punct(&tokens, &mut pos, '(')?;

            let mut attributes = Vec::new();
            let mut key_schema = Vec::new();
            loop {
                let column = next_ddl_ident(&tokens, &mut pos, "key column name")?;
                let type_word = match tokens.get(pos) {
                    Some(DdlToken::Word(word)) => word.clone(),
                    _ => {
                        return Err(anyhow!(
                            "Expected a key attribute type (S, N, or B) for column '{column}'"
                        ))
                    }
                };
                pos += 1;
                let attribute_type = dynamodb_key_type(&type_word)?;
                attributes.push(json!({
                    "AttributeName": column,
                    "AttributeType": attribute_type,
                }));
                key_schema.push(json!({
                    "AttributeName": column,
                    "KeyType": if key_schema.is_empty() { "HASH" } else { "RANGE" },
                }));
                if key_schema.len() == 2 {
                    break;
                }
                match tokens.get(pos) {
                    Some(DdlToken::Punct(',')) => pos += 1,
                    _ => break,
                }
            }
            expect_ddl_punct(&tokens, &mut pos, ')')?;

            (
                "CreateTable",
                json!({
                    "TableName": table,
                    "AttributeDefinitions": attributes,
                    "KeySchema": key_schema,
                    "BillingMode": "PAY_PER_REQUEST",
                }),
            )
        }
        "DROP" => {
            expect_ddl_keyword(&tokens, &mut pos, "TABLE")?;
            // Optional IF EXISTS.
            if eat_ddl_keyword(&tokens, &mut pos, "IF") {
                expect_ddl_keyword(&tokens, &mut pos, "EXISTS")?;
            }
            let table = next_ddl_ident(&tokens, &mut pos, "table name")?;
            ("DeleteTable", json!({ "TableName": table }))
        }
        _ => return Err(unsupported()),
    };

    // Only trailing semicolons may follow the parsed statement.
    for token in &tokens[pos..] {
        if !matches!(token, DdlToken::Punct(';')) {
            return Err(anyhow!(
                "Unexpected trailing tokens in DDL statement; only one \
                 CREATE TABLE or DROP TABLE per statement is supported"
            ));
        }
    }
    Ok(result)
}

/// Parse a browse filter into a rebuilt PartiQL WHERE clause with every
/// identifier double-quoted. Anything outside the
/// `identifier op literal [AND|OR ...]` grammar is rejected rather than
/// interpolated — same contract as `safety::sanitize_*_filter_clause`.
fn sanitize_partiql_filter(filter: Option<&str>) -> Result<Option<String>> {
    let Some(filter) = filter else {
        return Ok(None);
    };
    let trimmed = filter.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.len() > MAX_FILTER_LEN {
        return Err(anyhow!("Filter clause is too long"));
    }
    let lower = trimmed.to_ascii_lowercase();
    if trimmed.contains(';')
        || lower.contains("--")
        || lower.contains("/*")
        || lower.contains("*/")
        || trimmed.contains('\0')
    {
        return Err(anyhow!(
            "Filter clause contains disallowed multi-statement or comment syntax"
        ));
    }
    Ok(Some(PartiQlFilterParser::new(trimmed).parse()?))
}

/// Recursive-descent parser for the browse-filter grammar. Mirrors
/// `safety::FilterParser` (private to that module) with PartiQL quoting.
struct PartiQlFilterParser<'a> {
    input: &'a str,
    position: usize,
}

impl<'a> PartiQlFilterParser<'a> {
    fn new(input: &'a str) -> Self {
        Self { input, position: 0 }
    }

    fn parse(mut self) -> Result<String> {
        let mut output = self.parse_condition()?;
        loop {
            self.skip_whitespace();
            if self.is_eof() {
                break;
            }
            if self.consume_keyword("AND") {
                output.push_str(" AND ");
            } else if self.consume_keyword("OR") {
                output.push_str(" OR ");
            } else {
                return Err(anyhow!("Only AND/OR connectors are allowed in filters"));
            }
            output.push_str(&self.parse_condition()?);
        }
        Ok(output)
    }

    fn parse_condition(&mut self) -> Result<String> {
        self.skip_whitespace();
        let identifier = self.parse_identifier()?;
        self.skip_whitespace();
        let operator = self.parse_operator()?;
        self.skip_whitespace();

        let mut output = quote_partiql_path(&identifier)?;
        output.push(' ');
        output.push_str(operator);

        match operator {
            "IS NULL" | "IS NOT NULL" | "IS TRUE" | "IS FALSE" | "IS NOT TRUE" | "IS NOT FALSE" => {
                Ok(output)
            }
            "IS" | "IS NOT" => {
                output.push(' ');
                output.push_str(&self.parse_is_literal()?);
                Ok(output)
            }
            _ => {
                output.push(' ');
                output.push_str(&self.parse_literal()?);
                Ok(output)
            }
        }
    }

    fn parse_identifier(&mut self) -> Result<String> {
        let start = self.position;
        // Identifiers must start with a letter or underscore — a leading digit
        // would make `1 = 1` parse as a literal-vs-literal tautology.
        match self.peek_char() {
            Some(ch) if ch.is_ascii_alphabetic() || ch == '_' => {
                self.position += ch.len_utf8();
            }
            _ => return Err(anyhow!("Invalid identifier in filter clause")),
        }
        let mut last_was_dot = false;
        while let Some(ch) = self.peek_char() {
            if ch.is_ascii_alphanumeric() || ch == '_' {
                self.position += ch.len_utf8();
                last_was_dot = false;
            } else if ch == '.' {
                if last_was_dot {
                    return Err(anyhow!("Invalid identifier in filter clause"));
                }
                self.position += 1;
                last_was_dot = true;
            } else {
                break;
            }
        }
        if last_was_dot {
            return Err(anyhow!("Invalid identifier in filter clause"));
        }
        Ok(self.input[start..self.position].to_string())
    }

    fn parse_operator(&mut self) -> Result<&'static str> {
        if self.consume_keyword("IS") {
            self.skip_whitespace();
            if self.consume_keyword("NOT") {
                self.skip_whitespace();
                if self.consume_keyword("NULL") {
                    return Ok("IS NOT NULL");
                }
                if self.consume_keyword("TRUE") {
                    return Ok("IS NOT TRUE");
                }
                if self.consume_keyword("FALSE") {
                    return Ok("IS NOT FALSE");
                }
                return Ok("IS NOT");
            }
            if self.consume_keyword("NULL") {
                return Ok("IS NULL");
            }
            if self.consume_keyword("TRUE") {
                return Ok("IS TRUE");
            }
            if self.consume_keyword("FALSE") {
                return Ok("IS FALSE");
            }
            return Ok("IS");
        }
        if self.consume_keyword("LIKE") {
            return Ok("LIKE");
        }
        for (symbol, name) in [
            (">=", ">="),
            ("<=", "<="),
            ("!=", "!="),
            ("<>", "<>"),
            ("=", "="),
            (">", ">"),
            ("<", "<"),
        ] {
            if self.consume_symbol(symbol) {
                return Ok(name);
            }
        }
        Err(anyhow!("Unsupported operator in filter clause"))
    }

    fn parse_is_literal(&mut self) -> Result<String> {
        if self.consume_keyword("NULL") {
            return Ok("NULL".to_string());
        }
        if self.consume_keyword("TRUE") {
            return Ok("TRUE".to_string());
        }
        if self.consume_keyword("FALSE") {
            return Ok("FALSE".to_string());
        }
        Err(anyhow!("IS / IS NOT only support NULL, TRUE, or FALSE"))
    }

    fn parse_literal(&mut self) -> Result<String> {
        if self.peek_char() == Some('\'') {
            return self.parse_string_literal();
        }
        if self.consume_keyword("NULL") {
            return Ok("NULL".to_string());
        }
        if self.consume_keyword("TRUE") {
            return Ok("TRUE".to_string());
        }
        if self.consume_keyword("FALSE") {
            return Ok("FALSE".to_string());
        }
        self.parse_numeric_literal()
    }

    fn parse_numeric_literal(&mut self) -> Result<String> {
        let start = self.position;
        if matches!(self.peek_char(), Some('+') | Some('-')) {
            self.position += 1;
        }
        let mut saw_digit = false;
        while matches!(self.peek_char(), Some(ch) if ch.is_ascii_digit()) {
            self.position += 1;
            saw_digit = true;
        }
        if self.peek_char() == Some('.') {
            self.position += 1;
            while matches!(self.peek_char(), Some(ch) if ch.is_ascii_digit()) {
                self.position += 1;
                saw_digit = true;
            }
        }
        if !saw_digit {
            return Err(anyhow!("Expected a literal value in filter clause"));
        }
        let literal = &self.input[start..self.position];
        if literal.ends_with('.') {
            return Err(anyhow!("Invalid numeric literal in filter clause"));
        }
        Ok(literal.to_string())
    }

    fn parse_string_literal(&mut self) -> Result<String> {
        let mut output = String::from("'");
        self.expect_char('\'')?;
        loop {
            let Some(ch) = self.peek_char() else {
                return Err(anyhow!("Unterminated string literal in filter clause"));
            };
            self.position += ch.len_utf8();
            output.push(ch);
            if ch == '\'' {
                if self.peek_char() == Some('\'') {
                    self.position += 1;
                    output.push('\'');
                    continue;
                }
                break;
            }
        }
        Ok(output)
    }

    fn skip_whitespace(&mut self) {
        while matches!(self.peek_char(), Some(ch) if ch.is_whitespace()) {
            self.position += 1;
        }
    }

    fn consume_keyword(&mut self, keyword: &str) -> bool {
        let end = self.position + keyword.len();
        if end > self.input.len() {
            return false;
        }
        let candidate = &self.input[self.position..end];
        if !candidate.eq_ignore_ascii_case(keyword) {
            return false;
        }
        if matches!(self.peek_after(end), Some(ch) if ch.is_ascii_alphanumeric() || ch == '_') {
            return false;
        }
        self.position = end;
        true
    }

    fn consume_symbol(&mut self, symbol: &str) -> bool {
        if self.input[self.position..].starts_with(symbol) {
            self.position += symbol.len();
            return true;
        }
        false
    }

    fn expect_char(&mut self, expected: char) -> Result<()> {
        match self.peek_char() {
            Some(ch) if ch == expected => {
                self.position += ch.len_utf8();
                Ok(())
            }
            _ => Err(anyhow!("Expected '{expected}'")),
        }
    }

    fn peek_char(&self) -> Option<char> {
        self.input[self.position..].chars().next()
    }

    fn peek_after(&self, index: usize) -> Option<char> {
        self.input.get(index..)?.chars().next()
    }

    fn is_eof(&self) -> bool {
        self.position >= self.input.len()
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

    /// AWS's documented SigV4 example (IAM ListUsers, GET iam.amazonaws.com):
    /// the canonical request, derived key, and signature are all published,
    /// so this pins the whole signing pipeline end to end.
    #[test]
    fn sigv4_matches_aws_documented_example() {
        let headers = vec![
            (
                "content-type".to_string(),
                "application/x-www-form-urlencoded; charset=utf-8".to_string(),
            ),
            ("host".to_string(), "iam.amazonaws.com".to_string()),
            ("x-amz-date".to_string(), "20150830T123600Z".to_string()),
        ];
        let authorization = sigv4_authorization(
            "GET",
            "/",
            "Action=ListUsers&Version=2010-05-08",
            &headers,
            b"",
            "AKIDEXAMPLE",
            "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
            "us-east-1",
            "iam",
            "20150830T123600Z",
        );
        assert_eq!(
            authorization,
            "AWS4-HMAC-SHA256 \
             Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, \
             SignedHeaders=content-type;host;x-amz-date, \
             Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7"
        );
    }

    /// The intermediate kSigning value is also published by AWS — a wrong
    /// HMAC chain fails here even before the signature comparison.
    #[test]
    fn sigv4_derives_documented_signing_key() {
        let key = sigv4_derive_signing_key(
            "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
            "20150830",
            "us-east-1",
            "iam",
        );
        assert_eq!(
            to_hex(&key),
            "c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9"
        );
    }

    #[test]
    fn aws_region_parsed_from_endpoint_hostname() {
        assert_eq!(
            aws_region_from_hostname("dynamodb.eu-west-1.amazonaws.com").as_deref(),
            Some("eu-west-1")
        );
        assert_eq!(
            aws_region_from_hostname("https://dynamodb.ap-south-1.amazonaws.com").as_deref(),
            Some("ap-south-1")
        );
        assert_eq!(aws_region_from_hostname("http://localhost:8000"), None);
        assert_eq!(aws_region_from_hostname("dynamodb.amazonaws.com"), None);
    }

    #[test]
    fn attribute_value_to_json_maps_every_variant() {
        let item = json!({
            "s": {"S": "hello"},
            "n_int": {"N": "42"},
            "n_dec": {"N": "2.5"},
            "n_big": {"N": "18446744073709551615"},
            "n_bad": {"N": "not-a-number"},
            "bool": {"BOOL": true},
            "null": {"NULL": true},
            "b": {"B": "aGk="},
            "ss": {"SS": ["a", "b"]},
            "ns": {"NS": ["1", "2.5"]},
            "bs": {"BS": ["eA==", "eQ=="]},
            "m": {"M": {"inner": {"S": "x"}, "deep": {"N": "7"}}},
            "l": {"L": [{"N": "1"}, {"S": "y"}, {"NULL": true}]},
        });

        assert_eq!(attribute_value_to_json(&item["s"]), json!("hello"));
        assert_eq!(attribute_value_to_json(&item["n_int"]), json!(42));
        assert_eq!(attribute_value_to_json(&item["n_dec"]), json!(2.5));
        assert_eq!(
            attribute_value_to_json(&item["n_big"]),
            json!(18446744073709551615_u64)
        );
        // Unparseable N keeps its string form instead of being dropped.
        assert_eq!(
            attribute_value_to_json(&item["n_bad"]),
            json!("not-a-number")
        );
        assert_eq!(attribute_value_to_json(&item["bool"]), json!(true));
        assert_eq!(attribute_value_to_json(&item["null"]), JsonValue::Null);
        assert_eq!(attribute_value_to_json(&item["b"]), json!("aGk="));
        assert_eq!(attribute_value_to_json(&item["ss"]), json!(["a", "b"]));
        assert_eq!(attribute_value_to_json(&item["ns"]), json!([1, 2.5]));
        assert_eq!(
            attribute_value_to_json(&item["bs"]),
            json!(["eA==", "eQ=="])
        );
        assert_eq!(
            attribute_value_to_json(&item["m"]),
            json!({"inner": "x", "deep": 7})
        );
        assert_eq!(
            attribute_value_to_json(&item["l"]),
            json!([1, "y", JsonValue::Null])
        );
    }

    #[test]
    fn json_to_attribute_value_maps_every_variant() {
        assert_eq!(
            json_to_attribute_value(&json!("hello")),
            json!({"S": "hello"})
        );
        assert_eq!(json_to_attribute_value(&json!(42)), json!({"N": "42"}));
        assert_eq!(json_to_attribute_value(&json!(2.5)), json!({"N": "2.5"}));
        assert_eq!(json_to_attribute_value(&json!(true)), json!({"BOOL": true}));
        assert_eq!(
            json_to_attribute_value(&JsonValue::Null),
            json!({"NULL": true})
        );
        assert_eq!(
            json_to_attribute_value(&json!([1, "x"])),
            json!({"L": [{"N": "1"}, {"S": "x"}]})
        );
        assert_eq!(
            json_to_attribute_value(&json!({"a": 1})),
            json!({"M": {"a": {"N": "1"}}})
        );
    }

    #[test]
    fn query_parameters_map_to_attribute_values() {
        assert_eq!(
            query_parameter_to_attribute_value(&parameter(json!("x"), QueryParameterType::Text))
                .unwrap(),
            json!({"S": "x"})
        );
        assert_eq!(
            query_parameter_to_attribute_value(&parameter(json!(7), QueryParameterType::Integer))
                .unwrap(),
            json!({"N": "7"})
        );
        assert_eq!(
            query_parameter_to_attribute_value(&parameter(json!(2.5), QueryParameterType::Decimal))
                .unwrap(),
            json!({"N": "2.5"})
        );
        assert_eq!(
            query_parameter_to_attribute_value(&parameter(
                json!(true),
                QueryParameterType::Boolean
            ))
            .unwrap(),
            json!({"BOOL": true})
        );
        assert_eq!(
            query_parameter_to_attribute_value(&parameter(
                json!({"a": 1}),
                QueryParameterType::Json
            ))
            .unwrap(),
            json!({"M": {"a": {"N": "1"}}})
        );
        assert_eq!(
            query_parameter_to_attribute_value(&parameter(
                JsonValue::Null,
                QueryParameterType::Null
            ))
            .unwrap(),
            json!({"NULL": true})
        );
        assert!(query_parameter_to_attribute_value(&parameter(
            json!("nope"),
            QueryParameterType::Integer
        ))
        .is_err());
    }

    #[test]
    fn partiql_identifier_quoting_validates_and_escapes() {
        assert_eq!(
            quote_partiql_identifier("my table").unwrap(),
            "\"my table\""
        );
        assert_eq!(quote_partiql_identifier("a\"b").unwrap(), "\"a\"\"b\"");
        assert!(quote_partiql_identifier("").is_err());
        assert!(quote_partiql_identifier("   ").is_err());
        assert!(quote_partiql_identifier("a\nb").is_err());
        assert_eq!(quote_partiql_path("a.b.c").unwrap(), "\"a\".\"b\".\"c\"");
        assert!(quote_partiql_path("a..b").is_err());
    }

    #[test]
    fn partiql_string_literal_escapes_quotes() {
        assert_eq!(partiql_string_literal("attr").unwrap(), "'attr'");
        assert_eq!(partiql_string_literal("o'brien").unwrap(), "'o''brien'");
        assert!(partiql_string_literal("").is_err());
    }

    #[test]
    fn page_collector_skips_offset_and_bounds_limit() {
        let mut collector = PageCollector::new(3, 2);
        // First page is fully inside the skipped window.
        assert!(!collector.push_page(vec![json!(1), json!(2)]));
        // Second page finishes the skip, then fills the window.
        assert!(collector.push_page(vec![json!(3), json!(4), json!(5), json!(6)]));
        assert_eq!(collector.finish(), vec![json!(4), json!(5)]);
    }

    #[test]
    fn page_collector_reports_unfilled_window() {
        let mut collector = PageCollector::new(0, 10);
        assert!(!collector.push_page(vec![json!(1)]));
        assert_eq!(collector.needed(), 9);
    }

    #[test]
    fn filter_sanitizer_rebuilds_clause_with_quoted_identifiers() {
        let clause = sanitize_partiql_filter(Some("name = 'O''Brien' AND age >= 30"))
            .unwrap()
            .unwrap();
        assert_eq!(clause, "\"name\" = 'O''Brien' AND \"age\" >= 30");

        let clause = sanitize_partiql_filter(Some("meta.size < 10 OR active IS NOT NULL"))
            .unwrap()
            .unwrap();
        assert_eq!(clause, "\"meta\".\"size\" < 10 OR \"active\" IS NOT NULL");

        assert_eq!(sanitize_partiql_filter(None).unwrap(), None);
        assert_eq!(sanitize_partiql_filter(Some("   ")).unwrap(), None);
    }

    #[test]
    fn filter_sanitizer_rejects_unsafe_input() {
        assert!(sanitize_partiql_filter(Some("x = 1; DROP TABLE t")).is_err());
        assert!(sanitize_partiql_filter(Some("x = 1 -- comment")).is_err());
        assert!(sanitize_partiql_filter(Some("x = 'unterminated")).is_err());
        assert!(sanitize_partiql_filter(Some("x BETWEEN 1 AND 2")).is_err());
        assert!(sanitize_partiql_filter(Some("1 = 1")).is_err());
    }

    #[test]
    fn error_message_extracts_dynamodb_envelope() {
        let body = r#"{"__type":"com.amazonaws.dynamodb.v20120810#ResourceNotFoundException","message":"Requested resource not found"}"#;
        assert_eq!(
            dynamodb_error_message("DescribeTable", 400, body),
            "DynamoDB DescribeTable failed (400 ResourceNotFoundException): Requested resource not found"
        );
        assert_eq!(
            dynamodb_error_message("ListTables", 500, "not json"),
            "DynamoDB ListTables failed with status 500: not json"
        );
    }

    fn cell_update(value: JsonValue) -> TableCellUpdateRequest {
        TableCellUpdateRequest {
            table: "users".to_string(),
            database: None,
            target_column: "name".to_string(),
            value,
            primary_keys: vec![
                RowKeyValue {
                    column: "pk".to_string(),
                    value: json!("u1"),
                },
                RowKeyValue {
                    column: "sk".to_string(),
                    value: json!(7),
                },
            ],
        }
    }

    fn row_insert() -> TableRowInsertRequest {
        TableRowInsertRequest {
            table: "users".to_string(),
            database: None,
            values: vec![
                ("pk".to_string(), json!("u1")),
                ("age".to_string(), json!(30)),
            ],
        }
    }

    #[test]
    fn update_statement_binds_values_without_interpolation() {
        let (statement, parameters) =
            DynamoDbDriver::build_update_statement(&cell_update(json!("O'Brien"))).unwrap();
        assert_eq!(
            statement,
            "UPDATE \"users\" SET \"name\" = ? WHERE \"pk\" = ? AND \"sk\" = ?"
        );
        assert_eq!(
            parameters,
            vec![
                json!({"S": "O'Brien"}),
                json!({"S": "u1"}),
                json!({"N": "7"})
            ]
        );
    }

    #[test]
    fn update_statement_null_value_removes_attribute() {
        let (statement, parameters) =
            DynamoDbDriver::build_update_statement(&cell_update(JsonValue::Null)).unwrap();
        assert_eq!(
            statement,
            "UPDATE \"users\" REMOVE \"name\" WHERE \"pk\" = ? AND \"sk\" = ?"
        );
        // Only the key parameters are bound — REMOVE takes no value.
        assert_eq!(parameters, vec![json!({"S": "u1"}), json!({"N": "7"})]);
    }

    #[test]
    fn update_statement_requires_primary_key() {
        let mut request = cell_update(json!("x"));
        request.primary_keys.clear();
        assert!(DynamoDbDriver::build_update_statement(&request).is_err());
    }

    #[test]
    fn insert_statement_quotes_attribute_names_as_literals() {
        let (statement, parameters) =
            DynamoDbDriver::build_insert_statement(&row_insert()).unwrap();
        assert_eq!(statement, "INSERT INTO \"users\" VALUE {'pk': ?, 'age': ?}");
        assert_eq!(parameters, vec![json!({"S": "u1"}), json!({"N": "30"})]);

        let mut empty = row_insert();
        empty.values.clear();
        assert!(DynamoDbDriver::build_insert_statement(&empty).is_err());
    }

    #[test]
    fn transaction_payload_wraps_statements_with_parameters() {
        let payload = DynamoDbDriver::build_execute_transaction_payload(vec![
            DynamoDbDriver::build_insert_statement(&row_insert()).unwrap(),
            DynamoDbDriver::build_update_statement(&cell_update(JsonValue::Null)).unwrap(),
        ]);
        let actions = payload["TransactStatements"].as_array().unwrap();
        assert_eq!(actions.len(), 2);
        assert_eq!(
            actions[0]["Statement"],
            json!("INSERT INTO \"users\" VALUE {'pk': ?, 'age': ?}")
        );
        assert_eq!(actions[0]["Parameters"], json!([{"S": "u1"}, {"N": "30"}]));
        assert_eq!(
            actions[1]["Statement"],
            json!("UPDATE \"users\" REMOVE \"name\" WHERE \"pk\" = ? AND \"sk\" = ?")
        );
        assert_eq!(actions[1]["Parameters"], json!([{"S": "u1"}, {"N": "7"}]));
    }

    #[test]
    fn transaction_limit_rejects_over_100_actions() {
        assert!(DynamoDbDriver::enforce_transaction_action_limit(100, "cell updates").is_ok());

        let error =
            DynamoDbDriver::enforce_transaction_action_limit(101, "cell updates").unwrap_err();
        assert!(error.to_string().contains("100"));
        assert!(error.to_string().contains("101"));
    }

    #[test]
    fn snapshot_restore_builds_grouped_insert_statements() {
        let snapshot = json!({
            "meta": {"format": "json-snapshot", "engine": "dynamodb"},
            "tables": [
                {
                    "name": "users",
                    "rows": [
                        {"pk": "u1", "age": 30, "tags": ["a", "b"]},
                        {"pk": "u2", "active": true, "meta": {"city": "AD"}, "nick": null}
                    ]
                },
                {
                    "name": "audit log",
                    "rows": [{"pk": "evt", "detail": "it's \"quoted\""}]
                }
            ]
        });
        let tables =
            DynamoDbDriver::snapshot_restore_statements(&[
                serde_json::to_string(&snapshot).unwrap()
            ])
            .unwrap()
            .unwrap();
        assert_eq!(tables.len(), 2);

        let (name, inserts) = &tables[0];
        assert_eq!(name, "users");
        assert_eq!(inserts.len(), 2);
        // Attribute names are single-quoted literals inside the VALUE
        // struct; every value stays bound as a `?` parameter.
        assert_eq!(
            inserts[0].0,
            "INSERT INTO \"users\" VALUE {'pk': ?, 'age': ?, 'tags': ?}"
        );
        assert_eq!(
            inserts[0].1,
            vec![
                json!({"S": "u1"}),
                json!({"N": "30"}),
                json!({"L": [{"S": "a"}, {"S": "b"}]})
            ]
        );
        // Nested snapshot values map recursively: object → M, null → NULL.
        assert_eq!(
            inserts[1].1,
            vec![
                json!({"S": "u2"}),
                json!({"BOOL": true}),
                json!({"M": {"city": {"S": "AD"}}}),
                json!({"NULL": true})
            ]
        );

        let (name, inserts) = &tables[1];
        assert_eq!(name, "audit log");
        assert_eq!(inserts.len(), 1);
        assert_eq!(
            inserts[0].0,
            "INSERT INTO \"audit log\" VALUE {'pk': ?, 'detail': ?}"
        );
        assert_eq!(
            inserts[0].1,
            vec![json!({"S": "evt"}), json!({"S": "it's \"quoted\""})]
        );
    }

    #[test]
    fn snapshot_restore_classifies_and_rejects() {
        // Plain PartiQL dumps keep the sequential path — no snapshot.
        assert!(DynamoDbDriver::snapshot_restore_statements(&[
            "INSERT INTO \"users\" VALUE {'pk': 'u1'}".to_string()
        ])
        .unwrap()
        .is_none());

        // A `{`-led payload that is not a json-snapshot is an honest error.
        let wrong_format = serde_json::to_string(&json!({
            "meta": {"format": "csv-export"}, "tables": []
        }))
        .unwrap();
        assert!(DynamoDbDriver::snapshot_restore_statements(&[wrong_format]).is_err());

        // Split statement list rejoins into one document; the format tag
        // must still be validated.
        let missing_tables = serde_json::to_string(&json!({
            "meta": {"format": "json-snapshot"}
        }))
        .unwrap();
        let error = DynamoDbDriver::snapshot_restore_statements(&[missing_tables]).unwrap_err();
        assert!(error.to_string().contains("'tables'"));

        // A snapshot row that is not a JSON object cannot become an INSERT.
        let bad_row = serde_json::to_string(&json!({
            "meta": {"format": "json-snapshot"},
            "tables": [{"name": "users", "rows": [["pk", "u1"]]}]
        }))
        .unwrap();
        assert!(DynamoDbDriver::snapshot_restore_statements(&[bad_row]).is_err());
    }

    #[test]
    fn ddl_create_table_builds_create_table_payload() {
        let (operation, payload) = parse_ddl_statement("CREATE TABLE users (id TEXT)").unwrap();
        assert_eq!(operation, "CreateTable");
        assert_eq!(
            payload,
            json!({
                "TableName": "users",
                "AttributeDefinitions": [{"AttributeName": "id", "AttributeType": "S"}],
                "KeySchema": [{"AttributeName": "id", "KeyType": "HASH"}],
                "BillingMode": "PAY_PER_REQUEST",
            })
        );
    }

    #[test]
    fn ddl_create_table_with_sort_key_and_quoted_names() {
        let (operation, payload) = parse_ddl_statement(
            "create table if not exists \"my table\" (\"pk col\" number, sk binary);",
        )
        .unwrap();
        assert_eq!(operation, "CreateTable");
        assert_eq!(
            payload,
            json!({
                "TableName": "my table",
                "AttributeDefinitions": [
                    {"AttributeName": "pk col", "AttributeType": "N"},
                    {"AttributeName": "sk", "AttributeType": "B"},
                ],
                "KeySchema": [
                    {"AttributeName": "pk col", "KeyType": "HASH"},
                    {"AttributeName": "sk", "KeyType": "RANGE"},
                ],
                "BillingMode": "PAY_PER_REQUEST",
            })
        );
    }

    #[test]
    fn ddl_drop_table_builds_delete_table_payload() {
        let (operation, payload) =
            parse_ddl_statement("DROP TABLE IF EXISTS \"old table\"").unwrap();
        assert_eq!(operation, "DeleteTable");
        assert_eq!(payload, json!({ "TableName": "old table" }));
    }

    #[test]
    fn ddl_parser_rejects_unsupported_and_malformed_statements() {
        // Outside the subset entirely.
        assert!(parse_ddl_statement("ALTER TABLE t ADD COLUMN x INT").is_err());
        assert!(parse_ddl_statement("CREATE INDEX i ON t (c)").is_err());
        // Missing key column list / type.
        assert!(parse_ddl_statement("CREATE TABLE t").is_err());
        assert!(parse_ddl_statement("CREATE TABLE t (id)").is_err());
        // Third key column — DynamoDB tables have at most HASH + RANGE.
        assert!(parse_ddl_statement("CREATE TABLE t (a S, b N, c S)").is_err());
        // Non-key column definitions are not part of the subset: a second
        // typed column parses as the RANGE key, so exercise a non-key type
        // (JSON maps to no key attribute) and a sized type parameter.
        assert!(parse_ddl_statement("CREATE TABLE t (id S, payload JSON)").is_err());
        assert!(parse_ddl_statement("CREATE TABLE t (id S, name VARCHAR(50))").is_err());
        // Unsupported key type.
        assert!(parse_ddl_statement("CREATE TABLE t (id DATE)").is_err());
        // Trailing garbage / second statement.
        assert!(parse_ddl_statement("DROP TABLE t; DROP TABLE u").is_err());
        // Injection-shaped input fails at the tokenizer, never interpolates.
        assert!(parse_ddl_statement("DROP TABLE t -- comment").is_err());
        assert!(parse_ddl_statement("CREATE TABLE t (id S) ENGINE=x").is_err());
    }

    #[test]
    fn error_message_surfaces_transaction_cancellation_reasons() {
        let body = r#"{
            "__type": "com.amazonaws.dynamodb.v20120810#TransactionCanceledException",
            "message": "Transaction cancelled",
            "CancellationReasons": [
                {"Code": "None"},
                {"Code": "ConditionalCheckFailed", "Message": "The conditional request failed"}
            ]
        }"#;
        assert_eq!(
            dynamodb_error_message("ExecuteTransaction", 400, body),
            "DynamoDB ExecuteTransaction failed (400 TransactionCanceledException): \
             Transaction cancelled [action 1: ConditionalCheckFailed: The conditional request failed]"
        );
    }
}
