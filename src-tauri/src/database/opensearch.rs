use super::driver::DatabaseDriver;
use super::models::*;
use super::query_cancel::{request_cancel, CancelLookup, CancelScopeGuard, QueryCancelRegistry};
use anyhow::{anyhow, Result};
use async_trait::async_trait;
use futures_util::{stream, Stream, StreamExt, TryStreamExt};
use reqwest::{Client, Method, Url};
use serde_json::{json, Map, Value};
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::Path;
use std::pin::Pin;
use std::sync::RwLock;
use std::time::{Duration, Instant};

const MAX_REQUEST_BYTES: usize = 256 * 1024;
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const MAX_RESULT_ROWS: usize = 500;
const MAX_PEM_BYTES: u64 = 1024 * 1024;

pub struct OpenSearchDriver {
    client: Client,
    base_url: Url,
    username: Option<String>,
    password: Option<String>,
    current_index: RwLock<Option<String>>,
    plugin_id: String,
    /// request_id → running-search scope so `cancel_query_request` can find
    /// the `X-Opaque-Id`-tagged task in `GET /_tasks` and cancel it.
    cancel_registry: RwLock<QueryCancelRegistry>,
}

/// `X-Opaque-Id` tag stamped on request-scoped searches so the `_tasks`
/// API can attribute a server-side task back to the frontend request.
const OPAQUE_ID_PREFIX: &str = "tabler-";

impl OpenSearchDriver {
    fn read_pem(path: &str, label: &str) -> Result<Vec<u8>> {
        let path = Path::new(path);
        let metadata = fs::symlink_metadata(path)
            .map_err(|e| anyhow!("Failed to inspect OpenSearch {label}: {e}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(anyhow!("OpenSearch {label} must be a regular file"));
        }
        if metadata.len() == 0 || metadata.len() > MAX_PEM_BYTES {
            return Err(anyhow!(
                "OpenSearch {label} exceeds the certificate size limit"
            ));
        }
        fs::read(path).map_err(|e| anyhow!("Failed to read OpenSearch {label}: {e}"))
    }

    pub async fn connect(config: &ConnectionConfig, plugin_id: String) -> Result<Self> {
        let host = config
            .host
            .as_deref()
            .map(str::trim)
            .filter(|host| !host.is_empty())
            .ok_or_else(|| anyhow!("OpenSearch host is required"))?;
        let is_loopback = matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]");
        let tls_enabled = !matches!(config.effective_ssl_mode(), SslMode::Disable);
        if !tls_enabled && !is_loopback {
            return Err(anyhow!(
                "OpenSearch driver plugins require TLS for non-loopback hosts"
            ));
        }
        let scheme = if tls_enabled { "https" } else { "http" };
        let port = config.port.unwrap_or(if tls_enabled { 443 } else { 9200 });
        let authority_host = if host.contains(':') && !host.starts_with('[') {
            format!("[{host}]")
        } else {
            host.to_string()
        };
        let base_url = Url::parse(&format!("{scheme}://{authority_host}:{port}/"))
            .map_err(|_| anyhow!("OpenSearch host or port is invalid"))?;
        if base_url.username() != "" || base_url.password().is_some() {
            return Err(anyhow!(
                "OpenSearch credentials cannot be embedded in the host"
            ));
        }

        let mut client_builder = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(12))
            .danger_accept_invalid_certs(config.ssl_skip_host_verification.unwrap_or(false));
        if let Some(ca_path) = config
            .ssl_ca_cert_path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            let certificate =
                reqwest::Certificate::from_pem(&Self::read_pem(ca_path, "CA certificate")?)?;
            client_builder = client_builder.add_root_certificate(certificate);
        }
        match (
            config
                .ssl_client_cert_path
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty()),
            config
                .ssl_client_key_path
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty()),
        ) {
            (Some(cert_path), Some(key_path)) => {
                let mut identity_pem = Self::read_pem(cert_path, "client certificate")?;
                identity_pem.push(b'\n');
                identity_pem.extend(Self::read_pem(key_path, "client key")?);
                client_builder =
                    client_builder.identity(reqwest::Identity::from_pem(&identity_pem)?);
            }
            (None, None) => {}
            _ => {
                return Err(anyhow!(
                    "OpenSearch client certificate and key must be configured together"
                ))
            }
        }
        let client = client_builder.build()?;
        let driver = Self {
            client,
            base_url,
            username: config
                .username
                .clone()
                .filter(|value| !value.trim().is_empty()),
            password: config.password.clone().filter(|value| !value.is_empty()),
            current_index: RwLock::new(
                config
                    .database
                    .clone()
                    .filter(|value| !value.trim().is_empty()),
            ),
            plugin_id,
            cancel_registry: RwLock::new(QueryCancelRegistry::new()),
        };
        driver.ping().await?;
        Ok(driver)
    }

    fn validate_index(value: &str) -> Result<&str> {
        let value = value.trim();
        if value.is_empty()
            || value.len() > 255
            || value.contains("..")
            || value.contains(['/', '\\', '?', '#'])
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-_.*,".contains(&byte))
        {
            return Err(anyhow!("OpenSearch index name or pattern is invalid"));
        }
        Ok(value)
    }

    fn index_for(&self, value: Option<&str>) -> Result<String> {
        if let Some(value) = value.filter(|value| !value.trim().is_empty()) {
            return Ok(Self::validate_index(value)?.to_string());
        }
        let current = self
            .current_index
            .read()
            .map_err(|_| anyhow!("OpenSearch driver state is unavailable"))?
            .clone()
            .unwrap_or_else(|| "_all".to_string());
        Ok(Self::validate_index(&current)?.to_string())
    }

    fn validate_search_body(body: &Value) -> Result<()> {
        fn visit(value: &Value, depth: usize, nodes: &mut usize) -> Result<()> {
            if depth > 32 {
                return Err(anyhow!("OpenSearch query exceeds the nesting limit"));
            }
            *nodes = nodes.saturating_add(1);
            if *nodes > 10_000 {
                return Err(anyhow!("OpenSearch query exceeds the structure limit"));
            }
            match value {
                Value::Object(map) => {
                    for (key, child) in map {
                        if matches!(
                            key.as_str(),
                            "script" | "script_fields" | "runtime_mappings" | "stored_fields"
                        ) {
                            return Err(anyhow!(
                                "OpenSearch driver ABI v1 blocks server-side script and stored-field execution"
                            ));
                        }
                        if key == "size"
                            && child
                                .as_u64()
                                .is_some_and(|size| size > MAX_RESULT_ROWS as u64)
                        {
                            return Err(anyhow!("OpenSearch result size exceeds the driver limit"));
                        }
                        if key == "from" && child.as_u64().is_some_and(|offset| offset > 10_000) {
                            return Err(anyhow!(
                                "OpenSearch result offset exceeds the driver limit"
                            ));
                        }
                        visit(child, depth + 1, nodes)?;
                    }
                }
                Value::Array(values) => {
                    for child in values {
                        visit(child, depth + 1, nodes)?;
                    }
                }
                _ => {}
            }
            Ok(())
        }

        let mut nodes = 0;
        visit(body, 0, &mut nodes)
    }

    fn request(&self, method: Method, path: &str) -> Result<reqwest::RequestBuilder> {
        if path.len() > 1024 || path.contains("..") || path.contains("//") || !path.starts_with('/')
        {
            return Err(anyhow!(
                "OpenSearch request path is outside the driver allowlist"
            ));
        }
        let url = self.base_url.join(path.trim_start_matches('/'))?;
        if url.scheme() != self.base_url.scheme()
            || url.host_str() != self.base_url.host_str()
            || url.port_or_known_default() != self.base_url.port_or_known_default()
        {
            return Err(anyhow!(
                "OpenSearch request escaped the configured endpoint"
            ));
        }
        let request = self.client.request(method, url);
        Ok(match self.username.as_deref() {
            Some(username) => request.basic_auth(username, self.password.as_deref()),
            None => request,
        })
    }
    async fn send_json(&self, method: Method, path: &str, body: Option<&Value>) -> Result<Value> {
        self.send_json_tagged(method, path, body, None).await
    }

    /// `send_json` with an optional `X-Opaque-Id` header so the request shows
    /// up in `GET /_tasks` tagged back to the frontend request that issued it.
    async fn send_json_tagged(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        opaque_id: Option<&str>,
    ) -> Result<Value> {
        if let Some(body) = body {
            if serde_json::to_vec(body)?.len() > MAX_REQUEST_BYTES {
                return Err(anyhow!("OpenSearch query exceeds the plugin request limit"));
            }
        }
        let mut request = self.request(method, path)?;
        if let Some(opaque_id) = opaque_id {
            request = request.header("X-Opaque-Id", opaque_id);
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request.send().await?;
        let status = response.status();
        if response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
        {
            return Err(anyhow!(
                "OpenSearch response exceeds the plugin payload limit"
            ));
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
                return Err(anyhow!(
                    "OpenSearch response exceeds the plugin payload limit"
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        if !status.is_success() {
            let message = String::from_utf8_lossy(&bytes);
            return Err(anyhow!(
                "OpenSearch request failed with {}: {}",
                status.as_u16(),
                message.chars().take(400).collect::<String>()
            ));
        }
        if bytes.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&bytes).map_err(Into::into)
    }

    async fn search(
        &self,
        index: &str,
        body: &Value,
        query_label: String,
        opaque_id: Option<&str>,
    ) -> Result<QueryResult> {
        let started = Instant::now();
        let response = self
            .send_json_tagged(
                Method::POST,
                &format!("/{index}/_search"),
                Some(body),
                opaque_id,
            )
            .await?;
        let hits = response
            .pointer("/hits/hits")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let truncated = response
            .pointer("/hits/total/value")
            .and_then(Value::as_u64)
            .is_some_and(|total| total > hits.len().min(MAX_RESULT_ROWS) as u64);
        Ok(Self::hits_to_result(
            hits,
            started.elapsed().as_millis(),
            query_label,
            truncated,
        ))
    }

    /// Run a search with `"profile": true` and surface the `profile` section
    /// as a single-row JSON result — the same plan-cell shape other drivers
    /// use for EXPLAIN output.
    async fn explain_search(
        &self,
        index: &str,
        body: &Value,
        query_label: String,
        opaque_id: Option<&str>,
    ) -> Result<QueryResult> {
        let mut body = body.clone();
        body["profile"] = json!(true);
        let started = Instant::now();
        let response = self
            .send_json_tagged(
                Method::POST,
                &format!("/{index}/_search"),
                Some(&body),
                opaque_id,
            )
            .await?;
        let profile = response
            .get("profile")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let plan_text =
            serde_json::to_string_pretty(&profile).unwrap_or_else(|_| profile.to_string());
        Ok(QueryResult {
            columns: vec![ColumnInfo {
                name: "query_plan".to_string(),
                data_type: "json".to_string(),
                is_nullable: true,
                is_primary_key: false,
                max_length: None,
                default_value: None,
            }],
            rows: vec![vec![Value::String(plan_text)]],
            affected_rows: 0,
            execution_time_ms: started.elapsed().as_millis(),
            query: query_label,
            sandboxed: true,
            truncated: false,
        })
    }

    /// Strip a leading `EXPLAIN` (and an optional `ANALYZE` — profiling always
    /// executes the search) so the inner JSON body can run with
    /// `"profile": true`. Returns `None` when the text is not an EXPLAIN.
    fn strip_explain_prefix(sql: &str) -> Option<&str> {
        fn strip_keyword<'a>(text: &'a str, keyword: &str) -> Option<&'a str> {
            let head = text.get(..keyword.len())?;
            if !head.eq_ignore_ascii_case(keyword) {
                return None;
            }
            // The keyword must be standalone: `EXPLAINABLE` is not EXPLAIN.
            match text.as_bytes().get(keyword.len()) {
                Some(byte) if byte.is_ascii_alphanumeric() || *byte == b'_' => None,
                _ => Some(text[keyword.len()..].trim_start()),
            }
        }
        let rest = sql.trim_start();
        let mut inner = strip_keyword(rest, "EXPLAIN")?;
        if let Some(after) = strip_keyword(inner, "ANALYZE") {
            inner = after;
        }
        Some(inner)
    }

    /// Parse the query text into `(search_body, is_explain)`. A leading
    /// `EXPLAIN` marks the body for profiling; everything else must be one
    /// JSON search request body.
    fn parse_query_body(sql: &str) -> Result<(Value, bool)> {
        let (text, explain) = match Self::strip_explain_prefix(sql) {
            Some(inner) => (inner, true),
            None => (sql, false),
        };
        let body: Value = serde_json::from_str(text.trim())
            .map_err(|_| anyhow!("OpenSearch queries must be one JSON search request body"))?;
        if !body.is_object() {
            return Err(anyhow!("OpenSearch query body must be a JSON object"));
        }
        Self::validate_search_body(&body)?;
        Ok((body, explain))
    }

    /// `X-Opaque-Id` header value for a request id, or `None` when nothing
    /// header-safe survives sanitization (the task lookup then cannot match,
    /// so cancel degrades to the pending-abort path).
    fn opaque_id_for(request_id: &str) -> Option<String> {
        let sanitized: String = request_id
            .chars()
            .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
            .take(200)
            .collect();
        if sanitized.is_empty() {
            None
        } else {
            Some(format!("{OPAQUE_ID_PREFIX}{sanitized}"))
        }
    }

    /// Task ids (`node_id:task_id`) in a `GET /_tasks` response whose
    /// `headers` carry the given opaque id. Header keys are normalized to
    /// `x_opaque_id` form so `X-Opaque-Id`/`x-opaque-id` spellings all match.
    fn matching_task_ids(tasks_response: &Value, opaque_id: &str) -> Vec<String> {
        let mut ids = Vec::new();
        let Some(nodes) = tasks_response.get("nodes").and_then(Value::as_object) else {
            return ids;
        };
        for node in nodes.values() {
            let Some(tasks) = node.get("tasks").and_then(Value::as_object) else {
                continue;
            };
            for (task_id, task) in tasks {
                let matches =
                    task.get("headers")
                        .and_then(Value::as_object)
                        .is_some_and(|headers| {
                            headers.iter().any(|(name, value)| {
                                name.to_ascii_lowercase().replace('-', "_") == "x_opaque_id"
                                    && value.as_str() == Some(opaque_id)
                            })
                        });
                if matches {
                    ids.push(task_id.clone());
                }
            }
        }
        ids
    }

    /// Find the running search task tagged with this opaque id and cancel it.
    /// Returns `true` when at least one matching task was cancelled.
    async fn cancel_tasks_by_opaque_id(&self, opaque_id: &str) -> Result<bool> {
        let tasks = self
            .send_json(Method::GET, "/_tasks?actions=*search*&detailed", None)
            .await?;
        let ids = Self::matching_task_ids(&tasks, opaque_id);
        if ids.is_empty() {
            return Ok(false);
        }
        for task_id in ids {
            if !task_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b":_-.".contains(&byte))
            {
                return Err(anyhow!(
                    "OpenSearch task id is outside the driver allowlist"
                ));
            }
            self.send_json(Method::POST, &format!("/_tasks/{task_id}/_cancel"), None)
                .await?;
        }
        Ok(true)
    }

    /// Validate a `_source` field name for inline writes. Dotted names are
    /// allowed (OpenSearch expands them into nested objects); metadata fields
    /// (`_id`, `_index`, `_score`, …) are not writable through `_source`.
    fn validate_field_name(column: &str) -> Result<&str> {
        let column = column.trim();
        if column.is_empty()
            || column.len() > 255
            || column.starts_with('_')
            || column.split('.').any(str::is_empty)
            || !column
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b".-_".contains(&byte))
        {
            return Err(anyhow!("OpenSearch field name is invalid"));
        }
        Ok(column)
    }

    /// Validate a document id for use in a `/{index}/_doc/{id}` path segment.
    /// Anything that could break out of the segment (`/`, `?`, `#`, `%`,
    /// control bytes) is rejected rather than percent-mangled.
    fn validate_doc_id(id: &str) -> Result<&str> {
        if id.is_empty()
            || id.len() > 512
            || !id
                .bytes()
                .all(|byte| (byte.is_ascii_graphic() || byte == b' ') && !b"/?#%".contains(&byte))
        {
            return Err(anyhow!("OpenSearch document id is invalid"));
        }
        Ok(id)
    }

    /// Resolve the `(index, document_id)` a pk selector points at. The grid's
    /// pk selector maps to the document `_id` (surfaced as the `_id` column by
    /// `get_table_data`); an optional `_index` selector column overrides the
    /// target index so edits on index patterns hit the concrete index.
    fn document_target(
        &self,
        table: &str,
        database: Option<&str>,
        primary_keys: &[RowKeyValue],
    ) -> Result<(String, String)> {
        let mut doc_id = None;
        let mut index_override = None;
        for key in primary_keys {
            match key.column.as_str() {
                "_id" => {
                    doc_id = Some(
                        key.value
                            .as_str()
                            .ok_or_else(|| anyhow!("OpenSearch _id selector must be a string"))?
                            .to_string(),
                    );
                }
                "_index" => {
                    index_override = Some(
                        key.value
                            .as_str()
                            .ok_or_else(|| anyhow!("OpenSearch _index selector must be a string"))?
                            .to_string(),
                    );
                }
                _ => {}
            }
        }
        let doc_id = Self::validate_doc_id(&doc_id.ok_or_else(|| {
            anyhow!("OpenSearch inline edits require the _id column as the row selector")
        })?)?
        .to_string();
        let index = match index_override {
            Some(index) => Self::validate_index(&index)?.to_string(),
            None => self.index_for(if table.trim().is_empty() {
                database
            } else {
                Some(table)
            })?,
        };
        Ok((index, doc_id))
    }

    /// `POST /{index}/_update/{id}` body for one cell edit: a partial `doc`
    /// merge keyed by the literal `_source` field name the grid displays.
    fn build_update_body(column: &str, value: &Value) -> Result<Value> {
        let column = Self::validate_field_name(column)?;
        let mut doc = Map::new();
        doc.insert(column.to_string(), value.clone());
        let mut body = Map::new();
        body.insert("doc".to_string(), Value::Object(doc));
        Ok(Value::Object(body))
    }

    fn hits_to_result(
        hits: Vec<Value>,
        elapsed: u128,
        query_label: String,
        truncated: bool,
    ) -> QueryResult {
        Self::hits_to_result_capped(hits, elapsed, query_label, truncated, MAX_RESULT_ROWS)
    }

    /// Like [`Self::hits_to_result`] with a caller-chosen row cap so paged
    /// fetches beyond the interactive 500-row default still return data.
    fn hits_to_result_capped(
        hits: Vec<Value>,
        elapsed: u128,
        query_label: String,
        truncated: bool,
        row_cap: usize,
    ) -> QueryResult {
        let mut names = BTreeSet::new();
        names.extend([
            "_index".to_string(),
            "_id".to_string(),
            "_score".to_string(),
        ]);
        for hit in &hits {
            if let Some(source) = hit.get("_source").and_then(Value::as_object) {
                names.extend(source.keys().cloned());
            }
        }
        let names = names.into_iter().collect::<Vec<_>>();
        let rows = hits
            .into_iter()
            .take(row_cap)
            .map(|hit| {
                let source = hit.get("_source").and_then(Value::as_object);
                names
                    .iter()
                    .map(|name| match name.as_str() {
                        "_index" | "_id" | "_score" => {
                            hit.get(name).cloned().unwrap_or(Value::Null)
                        }
                        _ => source
                            .and_then(|map| map.get(name))
                            .cloned()
                            .unwrap_or(Value::Null),
                    })
                    .collect()
            })
            .collect::<Vec<_>>();
        QueryResult {
            columns: names
                .into_iter()
                .map(|name| ColumnInfo {
                    name,
                    data_type: "json".to_string(),
                    is_nullable: true,
                    is_primary_key: false,
                    max_length: None,
                    default_value: None,
                })
                .collect(),
            rows,
            affected_rows: 0,
            execution_time_ms: elapsed,
            query: query_label,
            sandboxed: true,
            truncated,
        }
    }

    /// Shared query path: parse the body, then run it as a plain search or a
    /// `profile: true` explain. `opaque_id` tags the `_search` request so the
    /// `_tasks` API can attribute it to the frontend request.
    async fn execute_query_inner(&self, sql: &str, opaque_id: Option<&str>) -> Result<QueryResult> {
        if sql.len() > MAX_REQUEST_BYTES {
            return Err(anyhow!("OpenSearch query exceeds the plugin request limit"));
        }
        let (body, explain) = Self::parse_query_body(sql)?;
        let index = self.index_for(None)?;
        if explain {
            self.explain_search(&index, &body, sql.to_string(), opaque_id)
                .await
        } else {
            self.search(&index, &body, sql.to_string(), opaque_id).await
        }
    }

    /// Call the OpenSearch security plugin REST API (`/_plugins/_security/...`)
    /// with the connection's configured credentials. Used by the Users & Roles
    /// administration surface, which cannot go through `execute_query` because
    /// that path only accepts search request bodies.
    pub async fn security_api_request(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value> {
        self.send_json(method, path, body).await
    }
}

#[async_trait]
impl DatabaseDriver for OpenSearchDriver {
    async fn ping(&self) -> Result<()> {
        self.send_json(Method::GET, "/", None).await.map(|_| ())
    }

    async fn disconnect(&self) -> Result<()> {
        Ok(())
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        Ok(vec![DatabaseInfo {
            name: self
                .current_database()
                .unwrap_or_else(|| "_all".to_string()),
            size: None,
        }])
    }

    async fn list_tables(&self, _database: Option<&str>) -> Result<Vec<TableInfo>> {
        let value = self
            .send_json(
                Method::GET,
                "/_cat/indices?format=json&h=index,docs.count,status",
                None,
            )
            .await?;
        Ok(value
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|item| {
                let index = item.get("index")?.as_str()?.to_string();
                let row_count = item
                    .get("docs.count")
                    .and_then(Value::as_str)
                    .and_then(|value| value.parse::<i64>().ok());
                Some(TableInfo {
                    create_date: None,
                    name: index,
                    schema: None,
                    table_type: "index".to_string(),
                    row_count,
                    engine: item
                        .get("status")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                })
            })
            .collect())
    }

    async fn list_schema_objects(&self, _database: Option<&str>) -> Result<Vec<SchemaObjectInfo>> {
        Ok(Vec::new())
    }

    async fn get_table_structure(
        &self,
        table: &str,
        _database: Option<&str>,
    ) -> Result<TableStructure> {
        let index = Self::validate_index(table)?;
        let value = self
            .send_json(Method::GET, &format!("/{index}/_mapping"), None)
            .await?;
        let mut fields = HashMap::<String, String>::new();
        fn collect(prefix: &str, value: &Value, output: &mut HashMap<String, String>) {
            let Some(properties) = value.get("properties").and_then(Value::as_object) else {
                return;
            };
            for (name, descriptor) in properties {
                let path = if prefix.is_empty() {
                    name.clone()
                } else {
                    format!("{prefix}.{name}")
                };
                let data_type = descriptor
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("object");
                output.insert(path.clone(), data_type.to_string());
                collect(&path, descriptor, output);
            }
        }
        for mapping in value.as_object().into_iter().flat_map(Map::values) {
            if let Some(root) = mapping.get("mappings") {
                collect("", root, &mut fields);
            }
        }
        let mut columns = fields
            .into_iter()
            .map(|(name, data_type)| ColumnDetail {
                name,
                data_type: data_type.clone(),
                is_nullable: true,
                is_primary_key: false,
                default_value: None,
                extra: None,
                column_type: Some(data_type),
                comment: None,
            })
            .collect::<Vec<_>>();
        columns.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(TableStructure {
            columns,
            indexes: Vec::new(),
            foreign_keys: Vec::new(),
            triggers: Vec::new(),
            view_definition: None,
            object_type: Some("index".to_string()),
        })
    }

    async fn execute_query(&self, sql: &str) -> Result<QueryResult> {
        self.execute_query_inner(sql, None).await
    }

    /// Request-scoped execution: the `_search` request is tagged with
    /// `X-Opaque-Id: tabler-<request_id>` so `cancel_query_request` can find
    /// the matching task in `GET /_tasks` and cancel it server-side.
    async fn execute_query_for_request(&self, request_id: &str, sql: &str) -> Result<QueryResult> {
        if request_id.trim().is_empty() {
            return self.execute_query(sql).await;
        }
        let guard = CancelScopeGuard::begin(&self.cancel_registry, request_id);
        // The task is located by its opaque-id header, not a backend id —
        // registering a marker only resolves the pending-cancel race.
        if guard.register_backend(0) {
            return Err(anyhow!("Query cancelled."));
        }
        let result = self
            .execute_query_inner(sql, Self::opaque_id_for(request_id).as_deref())
            .await;
        drop(guard);
        result
    }

    /// Cancels by listing `GET /_tasks?actions=*search*&detailed`, matching
    /// the task whose `headers` carry this request's `X-Opaque-Id`, and
    /// issuing `POST /_tasks/{task_id}/_cancel` for it.
    async fn cancel_query_request(&self, request_id: &str) -> Result<bool> {
        match request_cancel(&self.cancel_registry, request_id) {
            CancelLookup::NotRunning => Ok(false),
            // Cancel was recorded before the search was sent; the scoped
            // execute path aborts before the request leaves.
            CancelLookup::Pending => Ok(true),
            CancelLookup::Backend(_) => match Self::opaque_id_for(request_id) {
                Some(opaque_id) => self.cancel_tasks_by_opaque_id(&opaque_id).await,
                None => Ok(false),
            },
        }
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
        let index = Self::validate_index(table)?;
        let mut body = json!({
            "query": { "match_all": {} }
        });
        if let Some(filter) = filter.map(str::trim).filter(|value| !value.is_empty()) {
            if filter.len() > 4096 {
                return Err(anyhow!("OpenSearch filter exceeds the driver limit"));
            }
            body["query"] = json!({ "query_string": { "query": filter } });
        }
        if let Some(field) = order_by.map(str::trim).filter(|value| !value.is_empty()) {
            if field.len() > 255
                || !field
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
            {
                return Err(anyhow!("OpenSearch sort field is invalid"));
            }
            let direction = if order_dir.is_some_and(|value| value.eq_ignore_ascii_case("desc")) {
                "desc"
            } else {
                "asc"
            };
            let mut sort = Map::new();
            sort.insert(field.to_string(), json!({ "order": direction }));
            body["sort"] = Value::Array(vec![Value::Object(sort)]);
        }

        // `from`+`size` cannot page past the 10 000-hit window; deeper pages
        // go through the scroll API instead of silently clamping the offset
        // (which used to return the same first rows for every deep page).
        if offset.saturating_add(limit) <= 10_000 {
            body["from"] = json!(offset);
            body["size"] = json!(limit.min(MAX_RESULT_ROWS as u64));
            Self::validate_search_body(&body)?;
            return self
                .search(index, &body, format!("Browse index {index}"), None)
                .await;
        }

        body["size"] = json!(MAX_RESULT_ROWS);
        if body.get("sort").is_none() {
            body["sort"] = json!(["_doc"]);
        }
        Self::validate_search_body(&body)?;

        let started = Instant::now();
        let mut response = self
            .send_json(
                Method::POST,
                &format!("/{index}/_search?scroll=2m"),
                Some(&body),
            )
            .await?;
        let mut collected: Vec<Value> = Vec::new();
        let mut skipped = 0_u64;
        let mut scroll_id = response
            .get("_scroll_id")
            .and_then(Value::as_str)
            .map(str::to_string);
        loop {
            let hits = response
                .pointer("/hits/hits")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if hits.is_empty() {
                break;
            }
            for hit in hits {
                if skipped < offset {
                    skipped += 1;
                    continue;
                }
                if collected.len() as u64 >= limit {
                    break;
                }
                collected.push(hit);
            }
            if collected.len() as u64 >= limit {
                break;
            }
            let Some(id) = scroll_id.clone() else {
                break;
            };
            response = self
                .send_json(
                    Method::POST,
                    "/_search/scroll",
                    Some(&json!({ "scroll": "2m", "scroll_id": id })),
                )
                .await?;
            scroll_id = response
                .get("_scroll_id")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        if let Some(id) = scroll_id {
            let _ = self
                .send_json(
                    Method::DELETE,
                    "/_search/scroll",
                    Some(&json!({ "scroll_id": [id] })),
                )
                .await;
        }
        let truncated = collected.len() as u64 >= limit;
        Ok(Self::hits_to_result_capped(
            collected,
            started.elapsed().as_millis(),
            format!("Browse index {index}"),
            truncated,
            usize::MAX,
        ))
    }

    async fn count_rows(&self, table: &str, _database: Option<&str>) -> Result<i64> {
        let index = Self::validate_index(table)?;
        let value = self
            .send_json(Method::GET, &format!("/{index}/_count"), None)
            .await?;
        value
            .get("count")
            .and_then(Value::as_i64)
            .ok_or_else(|| anyhow!("OpenSearch count response is invalid"))
    }

    fn export_table_rows<'a>(
        &'a self,
        table: &'a str,
        _database: Option<&'a str>,
        batch_size: u64,
        order_by: Option<&'a str>,
        order_dir: Option<&'a str>,
        filter: Option<&'a str>,
    ) -> Pin<Box<dyn Stream<Item = Result<QueryResult>> + Send + 'a>> {
        // Deep paging via `from` is capped at 10k rows, so exports use the
        // scroll API instead; each scroll page becomes one batch.
        let page_size = batch_size.max(1).min(MAX_RESULT_ROWS as u64);
        let setup = async move {
            let index = Self::validate_index(table)?.to_string();
            let mut body = json!({
                "size": page_size,
                "query": { "match_all": {} }
            });
            if let Some(filter) = filter.map(str::trim).filter(|value| !value.is_empty()) {
                if filter.len() > 4096 {
                    return Err(anyhow!("OpenSearch filter exceeds the driver limit"));
                }
                body["query"] = json!({ "query_string": { "query": filter } });
            }
            if let Some(field) = order_by.map(str::trim).filter(|value| !value.is_empty()) {
                if field.len() > 255
                    || !field
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
                {
                    return Err(anyhow!("OpenSearch sort field is invalid"));
                }
                let direction = if order_dir.is_some_and(|value| value.eq_ignore_ascii_case("desc"))
                {
                    "desc"
                } else {
                    "asc"
                };
                let mut sort = Map::new();
                sort.insert(field.to_string(), json!({ "order": direction }));
                body["sort"] = Value::Array(vec![Value::Object(sort)]);
            } else {
                // `_doc` is the cheapest scroll order when the caller does not
                // request a specific one.
                body["sort"] = json!(["_doc"]);
            }
            Self::validate_search_body(&body)?;
            Ok((index, body))
        };

        enum ScrollState {
            Start,
            Scroll(String),
        }

        stream::once(setup)
            .map_ok(move |(index, body)| {
                stream::try_unfold(
                    (ScrollState::Start, index, body),
                    move |(state, index, body)| async move {
                        let response = match &state {
                            ScrollState::Start => {
                                self.send_json(
                                    Method::POST,
                                    &format!("/{index}/_search?scroll=2m"),
                                    Some(&body),
                                )
                                .await?
                            }
                            ScrollState::Scroll(scroll_id) => {
                                self.send_json(
                                    Method::POST,
                                    "/_search/scroll",
                                    Some(&json!({
                                        "scroll": "2m",
                                        "scroll_id": scroll_id,
                                    })),
                                )
                                .await?
                            }
                        };
                        let hits = response
                            .pointer("/hits/hits")
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default();
                        let scroll_id = response
                            .get("_scroll_id")
                            .and_then(Value::as_str)
                            .map(str::to_string);
                        if hits.is_empty() {
                            if let Some(scroll_id) = scroll_id {
                                let _ = self
                                    .send_json(
                                        Method::DELETE,
                                        "/_search/scroll",
                                        Some(&json!({ "scroll_id": [scroll_id] })),
                                    )
                                    .await;
                            }
                            return Ok(None);
                        }
                        let result = Self::hits_to_result(
                            hits,
                            0,
                            format!("Export index {index}"),
                            false,
                        );
                        let next = match scroll_id {
                            Some(scroll_id) => ScrollState::Scroll(scroll_id),
                            None => {
                                // Stopping here would silently truncate the
                                // export — surface it as an error instead.
                                return Err(anyhow!(
                                    "OpenSearch export of '{index}' stopped early: the server did not return a scroll id"
                                ));
                            }
                        };
                        Ok(Some((result, (next, index, body))))
                    },
                )
            })
            .try_flatten()
            .boxed()
    }

    async fn count_null_values(
        &self,
        table: &str,
        _database: Option<&str>,
        column: &str,
    ) -> Result<i64> {
        let index = Self::validate_index(table)?;
        if column.len() > 255
            || !column
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
        {
            return Err(anyhow!("OpenSearch field name is invalid"));
        }
        let body =
            json!({ "query": { "bool": { "must_not": { "exists": { "field": column } } } } });
        let value = self
            .send_json(Method::POST, &format!("/{index}/_count"), Some(&body))
            .await?;
        value
            .get("count")
            .and_then(Value::as_i64)
            .ok_or_else(|| anyhow!("OpenSearch count response is invalid"))
    }

    /// Partial update via `POST /{index}/_update/{id}` with a `doc` merge
    /// body. Row identity is the document `_id` (the grid's pk selector maps
    /// to `_id`; an `_index` selector column overrides the target index).
    async fn update_table_cell(&self, request: &TableCellUpdateRequest) -> Result<u64> {
        let (index, doc_id) = self.document_target(
            &request.table,
            request.database.as_deref(),
            &request.primary_keys,
        )?;
        let body = Self::build_update_body(&request.target_column, &request.value)?;
        let response = self
            .send_json(
                Method::POST,
                &format!("/{index}/_update/{doc_id}"),
                Some(&body),
            )
            .await?;
        Ok(match response.get("result").and_then(Value::as_str) {
            Some("updated") | Some("noop") => 1,
            _ => 0,
        })
    }

    /// Deletes each selected document via `DELETE /{index}/_doc/{id}`; the
    /// `_id` selector column carries the document id.
    async fn delete_table_rows(&self, request: &TableRowDeleteRequest) -> Result<u64> {
        if request.rows.is_empty() {
            return Err(anyhow!("Deleting rows requires at least one selected row"));
        }
        let mut deleted = 0u64;
        for row in &request.rows {
            let (index, doc_id) =
                self.document_target(&request.table, request.database.as_deref(), row)?;
            let response = self
                .send_json(Method::DELETE, &format!("/{index}/_doc/{doc_id}"), None)
                .await?;
            if response.get("result").and_then(Value::as_str) == Some("deleted") {
                deleted += 1;
            }
        }
        Ok(deleted)
    }

    /// Inserts one document. When the row carries an `_id` value it becomes
    /// the document id via `PUT /{index}/_create/{id}` (conflict-safe create);
    /// otherwise `POST /{index}/_doc` lets the server assign one.
    async fn insert_table_row(&self, request: &TableRowInsertRequest) -> Result<u64> {
        let index = self.index_for(if request.table.trim().is_empty() {
            request.database.as_deref()
        } else {
            Some(request.table.as_str())
        })?;
        let mut doc = Map::new();
        let mut doc_id = None;
        for (column, value) in &request.values {
            if column == "_id" {
                doc_id = Some(
                    value
                        .as_str()
                        .ok_or_else(|| anyhow!("OpenSearch _id must be a string"))?
                        .to_string(),
                );
                continue;
            }
            let column = Self::validate_field_name(column)?;
            doc.insert(column.to_string(), value.clone());
        }
        let body = Value::Object(doc);
        let response = match doc_id {
            Some(id) => {
                let id = Self::validate_doc_id(&id)?;
                self.send_json(Method::PUT, &format!("/{index}/_create/{id}"), Some(&body))
                    .await?
            }
            None => {
                self.send_json(Method::POST, &format!("/{index}/_doc"), Some(&body))
                    .await?
            }
        };
        Ok(match response.get("result").and_then(Value::as_str) {
            Some("created") => 1,
            _ => 0,
        })
    }
    async fn use_database(&self, database: &str) -> Result<()> {
        let index = Self::validate_index(database)?.to_string();
        *self
            .current_index
            .write()
            .map_err(|_| anyhow!("OpenSearch driver state is unavailable"))? = Some(index);
        Ok(())
    }
    async fn get_foreign_key_lookup_values(
        &self,
        _referenced_table: &str,
        _referenced_column: &str,
        _display_columns: &[&str],
        _search: Option<&str>,
        _limit: u32,
    ) -> Result<Vec<LookupValue>> {
        Ok(Vec::new())
    }
    fn current_database(&self) -> Option<String> {
        self.current_index
            .read()
            .ok()
            .and_then(|value| value.clone())
    }
    fn driver_name(&self) -> &str {
        &self.plugin_id
    }

    fn as_any(&self) -> Option<&dyn std::any::Any> {
        Some(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        extract::Path,
        http::HeaderMap,
        routing::{delete, get, post, put},
        Json, Router,
    };
    use tokio::net::TcpListener;

    #[test]
    fn rejects_paths_and_index_names_that_can_escape_the_endpoint() {
        assert!(OpenSearchDriver::validate_index("logs-*").is_ok());
        assert!(OpenSearchDriver::validate_index("../_security").is_err());
        assert!(OpenSearchDriver::validate_index("https://example.com").is_err());
    }

    #[test]
    fn blocks_unbounded_or_scripted_search_bodies() {
        assert!(OpenSearchDriver::validate_search_body(&json!({
            "query": { "match_all": {} },
            "size": 100
        }))
        .is_ok());
        assert!(OpenSearchDriver::validate_search_body(&json!({ "size": 501 })).is_err());
        assert!(OpenSearchDriver::validate_search_body(&json!({
            "query": { "script": { "script": "return true" } }
        }))
        .is_err());
    }

    fn test_driver() -> OpenSearchDriver {
        OpenSearchDriver {
            client: Client::new(),
            base_url: Url::parse("http://127.0.0.1:9200/").unwrap(),
            username: None,
            password: None,
            current_index: RwLock::new(Some("logs".to_string())),
            plugin_id: "opensearch-driver".to_string(),
            cancel_registry: RwLock::new(QueryCancelRegistry::new()),
        }
    }

    #[test]
    fn strips_explain_prefixes() {
        assert_eq!(
            OpenSearchDriver::strip_explain_prefix("EXPLAIN {\"size\":1}"),
            Some("{\"size\":1}")
        );
        assert_eq!(
            OpenSearchDriver::strip_explain_prefix("  explain analyze {\"size\":1}"),
            Some("{\"size\":1}")
        );
        assert_eq!(OpenSearchDriver::strip_explain_prefix("{\"size\":1}"), None);
        // "EXPLAIN" must be a standalone keyword, not a JSON key prefix.
        assert_eq!(OpenSearchDriver::strip_explain_prefix("EXPLAINABLE"), None);
    }

    #[test]
    fn parses_explain_bodies() {
        let (body, explain) =
            OpenSearchDriver::parse_query_body("EXPLAIN {\"query\":{\"match_all\":{}}}").unwrap();
        assert!(explain);
        assert_eq!(body["query"]["match_all"], json!({}));
        let (_, explain) =
            OpenSearchDriver::parse_query_body("{\"query\":{\"match_all\":{}}}").unwrap();
        assert!(!explain);
        assert!(OpenSearchDriver::parse_query_body("EXPLAIN not json").is_err());
    }

    #[test]
    fn opaque_ids_are_sanitized() {
        assert_eq!(
            OpenSearchDriver::opaque_id_for("req-1_2.3"),
            Some("tabler-req-1_2.3".to_string())
        );
        assert_eq!(
            OpenSearchDriver::opaque_id_for("a b\tc"),
            Some("tabler-abc".to_string())
        );
        assert_eq!(OpenSearchDriver::opaque_id_for(" \t\n"), None);
    }

    #[test]
    fn matches_tasks_by_opaque_id_header() {
        let response = json!({
            "nodes": {
                "node-a": {
                    "tasks": {
                        "node-a:42": {
                            "action": "indices:data/read/search",
                            "headers": { "X-Opaque-Id": "tabler-req-9" }
                        },
                        "node-a:43": {
                            "action": "indices:data/read/search",
                            "headers": { "x-opaque-id": "tabler-other" }
                        }
                    }
                },
                "node-b": {
                    "tasks": {
                        "node-b:7": {
                            "action": "indices:data/read/search",
                            "headers": { "X_OPAQUE_ID": "tabler-req-9" }
                        }
                    }
                }
            }
        });
        let ids = OpenSearchDriver::matching_task_ids(&response, "tabler-req-9");
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(&"node-a:42".to_string()));
        assert!(ids.contains(&"node-b:7".to_string()));
        assert!(OpenSearchDriver::matching_task_ids(&response, "tabler-missing").is_empty());
        assert!(OpenSearchDriver::matching_task_ids(&json!({}), "tabler-req-9").is_empty());
    }

    #[test]
    fn builds_update_body_as_doc_merge() {
        let body = OpenSearchDriver::build_update_body("message", &json!("hi")).unwrap();
        assert_eq!(body, json!({ "doc": { "message": "hi" } }));
        assert!(OpenSearchDriver::build_update_body("_id", &json!("x")).is_err());
        assert!(OpenSearchDriver::build_update_body("a..b", &json!(1)).is_err());
        assert!(OpenSearchDriver::build_update_body("bad name", &json!(1)).is_err());
    }

    #[test]
    fn resolves_document_targets_from_pk_selectors() {
        let driver = test_driver();
        let keys = vec![
            RowKeyValue {
                column: "_id".to_string(),
                value: json!("doc-1"),
            },
            RowKeyValue {
                column: "level".to_string(),
                value: json!("info"),
            },
        ];
        let (index, id) = driver.document_target("logs", None, &keys).unwrap();
        assert_eq!((index.as_str(), id.as_str()), ("logs", "doc-1"));

        let keys = vec![
            RowKeyValue {
                column: "_id".to_string(),
                value: json!("doc-2"),
            },
            RowKeyValue {
                column: "_index".to_string(),
                value: json!("logs-2026"),
            },
        ];
        let (index, id) = driver.document_target("logs-*", None, &keys).unwrap();
        assert_eq!((index.as_str(), id.as_str()), ("logs-2026", "doc-2"));

        assert!(driver
            .document_target(
                "logs",
                None,
                &[RowKeyValue {
                    column: "level".to_string(),
                    value: json!("info"),
                }]
            )
            .is_err());
        assert!(OpenSearchDriver::validate_doc_id("a/b").is_err());
        assert!(OpenSearchDriver::validate_doc_id("a?b").is_err());
        assert!(OpenSearchDriver::validate_doc_id("plain-id_1.2").is_ok());
    }

    #[tokio::test]
    async fn declarative_driver_browses_a_live_opensearch_contract() {
        let opaque_ids = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::<String>::new()));
        let cancelled_tasks = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::<String>::new()));
        let search_opaque = opaque_ids.clone();
        let cancel_capture = cancelled_tasks.clone();
        let app = Router::new()
            .route(
                "/",
                get(|| async { Json(json!({ "version": { "number": "2.17.0" } })) }),
            )
            .route(
                "/_cat/indices",
                get(|| async {
                    Json(json!([{ "index": "logs", "docs.count": "2", "status": "open" }]))
                }),
            )
            .route(
                "/logs/_mapping",
                get(|| async {
                    Json(json!({
                        "logs": {
                            "mappings": {
                                "properties": {
                                    "level": { "type": "keyword" },
                                    "message": { "type": "text" }
                                }
                            }
                        }
                    }))
                }),
            )
            .route(
                "/logs/_search",
                post(move |headers: HeaderMap, Json(body): Json<Value>| {
                    let capture = search_opaque.clone();
                    async move {
                        if let Some(value) = headers.get("x-opaque-id") {
                            capture
                                .lock()
                                .await
                                .push(value.to_str().unwrap_or("").to_string());
                        }
                        if body.get("profile") == Some(&json!(true)) {
                            return Json(json!({
                                "hits": { "total": { "value": 0 }, "hits": [] },
                                "profile": { "shards": [{ "id": "[node][logs][0]" }] }
                            }));
                        }
                        Json(json!({
                            "hits": {
                                "total": { "value": 2 },
                                "hits": [
                                    {
                                        "_index": "logs",
                                        "_id": "1",
                                        "_score": 1.0,
                                        "_source": { "level": "info", "message": "ready" }
                                    }
                                ]
                            }
                        }))
                    }
                }),
            )
            .route(
                "/logs/_count",
                get(|| async { Json(json!({ "count": 2 })) })
                    .post(|| async { Json(json!({ "count": 1 })) }),
            )
            .route(
                "/logs/_update/:id",
                post(
                    |Path(id): Path<String>, Json(body): Json<Value>| async move {
                        assert_eq!(id, "doc-1");
                        assert_eq!(body, json!({ "doc": { "message": "updated" } }));
                        Json(json!({ "result": "updated" }))
                    },
                ),
            )
            .route(
                "/logs/_doc/:id",
                delete(|Path(id): Path<String>| async move {
                    assert_eq!(id, "doc-1");
                    Json(json!({ "result": "deleted" }))
                })
                .post(
                    |Path(id): Path<String>, Json(body): Json<Value>| async move {
                        assert_eq!(id, "doc-9");
                        assert_eq!(body, json!({ "level": "warn" }));
                        Json(json!({ "result": "created" }))
                    },
                ),
            )
            .route(
                "/logs/_doc",
                post(|Json(body): Json<Value>| async move {
                    assert_eq!(body, json!({ "level": "info" }));
                    Json(json!({ "result": "created", "_id": "generated" }))
                }),
            )
            .route(
                "/logs/_create/:id",
                put(
                    |Path(id): Path<String>, Json(body): Json<Value>| async move {
                        assert_eq!(id, "doc-7");
                        assert_eq!(body, json!({ "level": "error" }));
                        Json(json!({ "result": "created" }))
                    },
                ),
            )
            .route(
                "/_tasks",
                get(|| async {
                    Json(json!({
                        "nodes": {
                            "node-a": {
                                "tasks": {
                                    "node-a:42": {
                                        "action": "indices:data/read/search",
                                        "headers": { "X-Opaque-Id": "tabler-req-cancel" }
                                    }
                                }
                            }
                        }
                    }))
                }),
            )
            .route(
                "/_tasks/:task/_cancel",
                post(move |Path(task): Path<String>| {
                    let capture = cancel_capture.clone();
                    async move {
                        capture.lock().await.push(task);
                        Json(json!({ "nodes": {} }))
                    }
                }),
            );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let config = ConnectionConfig {
            id: "opensearch-test".to_string(),
            name: "OpenSearch test".to_string(),
            db_type: DatabaseType::OpenSearch,
            host: Some("127.0.0.1".to_string()),
            port: Some(port),
            database: Some("logs".to_string()),
            ..ConnectionConfig::default()
        };
        let driver = OpenSearchDriver::connect(&config, "opensearch-driver".to_string())
            .await
            .unwrap();
        let tables = driver.list_tables(None).await.unwrap();
        assert_eq!(tables[0].name, "logs");
        assert_eq!(tables[0].row_count, Some(2));

        let structure = driver.get_table_structure("logs", None).await.unwrap();
        assert_eq!(structure.columns.len(), 2);
        assert!(structure
            .columns
            .iter()
            .any(|column| column.name == "message"));

        let result = driver
            .execute_query(r#"{"query":{"match_all":{}},"size":1}"#)
            .await
            .unwrap();
        assert_eq!(result.rows.len(), 1);
        assert!(result.sandboxed);
        assert!(result.truncated);
        assert_eq!(driver.count_rows("logs", None).await.unwrap(), 2);

        // Inline edit: _update merges the doc body keyed by the literal field.
        let updated = driver
            .update_table_cell(&TableCellUpdateRequest {
                table: "logs".to_string(),
                database: None,
                target_column: "message".to_string(),
                value: json!("updated"),
                primary_keys: vec![RowKeyValue {
                    column: "_id".to_string(),
                    value: json!("doc-1"),
                }],
            })
            .await
            .unwrap();
        assert_eq!(updated, 1);

        let deleted = driver
            .delete_table_rows(&TableRowDeleteRequest {
                table: "logs".to_string(),
                database: None,
                rows: vec![vec![RowKeyValue {
                    column: "_id".to_string(),
                    value: json!("doc-1"),
                }]],
            })
            .await
            .unwrap();
        assert_eq!(deleted, 1);

        // Insert without _id → POST _doc; with _id → PUT _create/{id}.
        let inserted = driver
            .insert_table_row(&TableRowInsertRequest {
                table: "logs".to_string(),
                database: None,
                values: vec![("level".to_string(), json!("info"))],
            })
            .await
            .unwrap();
        assert_eq!(inserted, 1);
        let inserted = driver
            .insert_table_row(&TableRowInsertRequest {
                table: "logs".to_string(),
                database: None,
                values: vec![
                    ("_id".to_string(), json!("doc-7")),
                    ("level".to_string(), json!("error")),
                ],
            })
            .await
            .unwrap();
        assert_eq!(inserted, 1);

        // EXPLAIN wraps the body with "profile": true and returns the plan.
        let plan = driver
            .execute_query(r#"EXPLAIN {"query":{"match_all":{}}}"#)
            .await
            .unwrap();
        assert_eq!(plan.columns[0].name, "query_plan");
        let plan_text = plan.rows[0][0].as_str().unwrap();
        assert!(plan_text.contains("shards"));

        // Request-scoped queries carry the X-Opaque-Id tag.
        driver
            .execute_query_for_request("req-tag", r#"{"query":{"match_all":{}}}"#)
            .await
            .unwrap();
        assert_eq!(
            opaque_ids.lock().await.as_slice(),
            ["tabler-req-tag".to_string()]
        );

        // Cancel: no running request → false; open scope + matching task →
        // the task id is cancelled server-side.
        assert!(!driver.cancel_query_request("req-cancel").await.unwrap());
        {
            let guard = CancelScopeGuard::begin(&driver.cancel_registry, "req-cancel");
            guard.register_backend(0);
            assert!(driver.cancel_query_request("req-cancel").await.unwrap());
            drop(guard);
        }
        assert_eq!(
            cancelled_tasks.lock().await.as_slice(),
            ["node-a:42".to_string()]
        );

        server.abort();
    }
}
