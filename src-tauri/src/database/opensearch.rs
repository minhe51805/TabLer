use super::driver::DatabaseDriver;
use super::models::*;
use anyhow::{anyhow, Result};
use async_trait::async_trait;
use futures_util::StreamExt;
use reqwest::{Client, Method, Url};
use serde_json::{json, Map, Value};
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::Path;
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
}

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
        if let Some(body) = body {
            if serde_json::to_vec(body)?.len() > MAX_REQUEST_BYTES {
                return Err(anyhow!("OpenSearch query exceeds the plugin request limit"));
            }
        }
        let mut request = self.request(method, path)?;
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

    async fn search(&self, index: &str, body: &Value, query_label: String) -> Result<QueryResult> {
        let started = Instant::now();
        let response = self
            .send_json(Method::POST, &format!("/{index}/_search"), Some(body))
            .await?;
        let hits = response
            .pointer("/hits/hits")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
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
            .take(MAX_RESULT_ROWS)
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
        let truncated = response
            .pointer("/hits/total/value")
            .and_then(Value::as_u64)
            .is_some_and(|total| total > rows.len() as u64);
        Ok(QueryResult {
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
            execution_time_ms: started.elapsed().as_millis(),
            query: query_label,
            sandboxed: true,
            truncated,
        })
    }

    fn readonly_error() -> anyhow::Error {
        anyhow!("OpenSearch declarative driver ABI v1 is read-only")
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
        if sql.len() > MAX_REQUEST_BYTES {
            return Err(anyhow!("OpenSearch query exceeds the plugin request limit"));
        }
        let body: Value = serde_json::from_str(sql.trim())
            .map_err(|_| anyhow!("OpenSearch queries must be one JSON search request body"))?;
        if !body.is_object() {
            return Err(anyhow!("OpenSearch query body must be a JSON object"));
        }
        Self::validate_search_body(&body)?;
        let index = self.index_for(None)?;
        self.search(&index, &body, sql.to_string()).await
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
            "from": offset.min(10_000),
            "size": limit.min(MAX_RESULT_ROWS as u64),
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
        Self::validate_search_body(&body)?;
        self.search(index, &body, format!("Browse index {index}"))
            .await
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

    async fn update_table_cell(&self, _request: &TableCellUpdateRequest) -> Result<u64> {
        Err(Self::readonly_error())
    }
    async fn delete_table_rows(&self, _request: &TableRowDeleteRequest) -> Result<u64> {
        Err(Self::readonly_error())
    }
    async fn insert_table_row(&self, _request: &TableRowInsertRequest) -> Result<u64> {
        Err(Self::readonly_error())
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        routing::{get, post},
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

    #[tokio::test]
    async fn mutating_driver_operations_are_isolated_and_rejected() {
        let driver = OpenSearchDriver {
            client: Client::new(),
            base_url: Url::parse("http://127.0.0.1:9200/").unwrap(),
            username: None,
            password: None,
            current_index: RwLock::new(Some("logs".to_string())),
            plugin_id: "opensearch-driver".to_string(),
        };
        let request = TableRowInsertRequest {
            table: "logs".to_string(),
            database: None,
            values: vec![],
        };
        assert!(driver
            .insert_table_row(&request)
            .await
            .unwrap_err()
            .to_string()
            .contains("read-only"));
    }

    #[tokio::test]
    async fn declarative_driver_browses_a_live_opensearch_contract() {
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
                post(|| async {
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
                }),
            )
            .route(
                "/logs/_count",
                get(|| async { Json(json!({ "count": 2 })) })
                    .post(|| async { Json(json!({ "count": 1 })) }),
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

        server.abort();
    }
}
