//! Typesense driver over the REST JSON API.
//!
//! Collections are surfaced as tables and documents as rows. Searches run
//! through `POST /multi_search` (one search object per request) so query text
//! travels in the JSON body — never interpolated into URLs or filter strings.
//!
//! ## Query surface
//!
//! The SQL editor accepts a documented subset (multi-statement input is split
//! and executed sequentially; the last row-producing statement wins):
//!
//! - `SELECT * | col, ... FROM <collection> [WHERE <predicates>]
//!   [ORDER BY <field>[, ...] [ASC|DESC]] [LIMIT n [OFFSET m]]`
//!   → `documents/search` params `q=*` + `filter_by`/`sort_by`/`page`/`per_page`.
//! - `SEARCH <collection> [FOR '<terms>'] [BY <field,...>]` (same trailing
//!   clauses) → full-text `q` + `query_by`.
//! - `WHERE` predicates: `field =|!=|<|<=|>|>= <literal>`, `field [NOT] IN (...)`,
//!   `field BETWEEN a AND b`, joined by `AND`. `IS [NOT] NULL`, `OR`, `LIKE`
//!   are rejected honestly — Typesense omits optional fields instead of
//!   storing NULLs, so "missing field" filtering is unavailable.
//! - `INSERT/UPDATE/DELETE` map onto the single-document and
//!   `documents?filter_by=` endpoints. `UPDATE`/`DELETE` are also reachable
//!   from inline grid edits keyed by the `id` column.
//! - `CREATE TABLE`/`DROP TABLE`/`ALTER TABLE ... ADD|DROP COLUMN` map onto
//!   the collection schema endpoints; `USE <collection>` switches the grid's
//!   default collection. Anything else is rejected with a clear error.
//!
//! Honesty notes: Typesense has no transaction primitive and no server-side
//! query cancel — `documents/import` is a per-line JSONL batch (partial
//! writes possible), `apply_table_updates_atomically` stays rejected, and
//! cancel only aborts the client-side wait (plus the pre-send race via the
//! shared cancel registry).

use super::driver::DatabaseDriver;
use super::models::*;
use super::query_cancel::{request_cancel, CancelLookup, CancelScopeGuard, QueryCancelRegistry};
use super::query_common::MAX_TABLE_PAGE_ROWS;
use crate::utils::sql::split_sql_statements;
use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use futures_util::{stream, Stream, StreamExt, TryStreamExt};
use reqwest::{Client, Method, Url};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::{BTreeSet, VecDeque};
use std::fs;
use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

const MAX_REQUEST_BYTES: usize = 256 * 1024;
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const MAX_RESULT_ROWS: usize = 500;
const MAX_PEM_BYTES: u64 = 1024 * 1024;
/// Typesense caps `per_page` at 250 documents per search page.
const TYPESENSE_MAX_PAGE: u64 = 250;
/// One `documents/import` batch is bounded so a CSV import cannot produce an
/// unbounded request body; beyond this the import is rejected up front rather
/// than partially applied in multiple batches.
const MAX_IMPORT_LINES: usize = 100_000;
const MAX_IMPORT_BYTES: usize = 4 * 1024 * 1024;
const MAX_FILTER_LEN: usize = 4_096;

#[derive(Debug, Deserialize, Clone)]
struct TypesenseFieldSchema {
    name: String,
    #[serde(rename = "type")]
    field_type: String,
    #[serde(default)]
    optional: bool,
    #[serde(default)]
    facet: bool,
    #[serde(default)]
    sort: bool,
    /// Write-time requests use `index`; retrieval payloads have used both
    /// `index` and `indexed` across server versions, so accept either and
    /// default to true when the flag is absent.
    #[serde(default)]
    index: Option<bool>,
    #[serde(default)]
    indexed: Option<bool>,
}

impl TypesenseFieldSchema {
    fn is_indexed(&self) -> bool {
        self.index.or(self.indexed).unwrap_or(true)
    }
}

#[derive(Debug, Deserialize, Clone)]
struct TypesenseCollection {
    name: String,
    #[serde(default)]
    fields: Vec<TypesenseFieldSchema>,
    #[serde(default)]
    num_documents: i64,
}

#[derive(Debug, Deserialize)]
struct TypesenseSearchHit {
    document: Option<Map<String, Value>>,
}

#[derive(Debug, Deserialize)]
struct TypesenseSearchResult {
    hits: Option<Vec<TypesenseSearchHit>>,
    found: Option<i64>,
    /// A failed search inside a multi_search batch returns
    /// `{"code": N, "error": "..."}` instead of result fields — surface it
    /// rather than silently yielding an empty row set.
    code: Option<i64>,
    error: Option<String>,
}
#[derive(Debug, Deserialize)]
struct TypesenseMultiSearchResponse {
    results: Option<Vec<Option<TypesenseSearchResult>>>,
}

pub struct TypesenseDriver {
    client: Client,
    base_url: Url,
    api_key: String,
    /// Grid's default collection when a statement/browse call omits one.
    current_collection: RwLock<Option<String>>,
    /// request_id → running-query scope so `cancel_query_request` can resolve
    /// the pending-cancel race; Typesense has no server-side cancel.
    cancel_registry: RwLock<QueryCancelRegistry>,
}

/// One parsed `WHERE` predicate. `In` carries the literal list, `Between`
/// `(low, high)`; `negated` covers both leading `NOT field op` and the
/// `field NOT IN`/`field NOT BETWEEN` forms. `IS [NOT] NULL` never reaches
/// this enum — the parser rejects it up front (no NULL storage).
#[derive(Debug, Clone, PartialEq)]
enum PredicateKind {
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    In,
    Between,
}

#[derive(Debug, Clone)]
struct TypesensePredicate {
    field: String,
    kind: PredicateKind,
    values: Vec<Value>,
    negated: bool,
}

#[derive(Debug, Default)]
struct SearchSpec {
    collection: String,
    q: String,
    query_by: Vec<String>,
    include_fields: Vec<String>,
    predicates: Vec<TypesensePredicate>,
    sort_by: Vec<(String, String)>,
    limit: u64,
    offset: u64,
}

#[derive(Debug)]
struct FieldSpec {
    name: String,
    field_type: String,
    optional: bool,
    facet: bool,
    sort: bool,
    index: bool,
}

#[derive(Debug)]
enum FieldAction {
    Add(FieldSpec),
    Drop(String),
}

#[derive(Debug)]
enum TypesenseStatement {
    Search(SearchSpec),
    Insert {
        collection: String,
        documents: Vec<Map<String, Value>>,
    },
    Update {
        collection: String,
        doc_id: String,
        assignments: Vec<(String, Value)>,
    },
    DeleteById {
        collection: String,
        doc_id: String,
    },
    DeleteByFilter {
        collection: String,
        predicates: Vec<TypesensePredicate>,
    },
    CreateCollection {
        name: String,
        fields: Vec<FieldSpec>,
        if_not_exists: bool,
    },
    DropCollection {
        name: String,
        if_exists: bool,
    },
    AlterCollection {
        name: String,
        actions: Vec<FieldAction>,
    },
    Use(String),
}

/// Statements either produce a row set (searches) or an affected count.
#[derive(Debug)]
enum StatementOutcome {
    Rows(QueryResult),
    Affected(u64),
}

impl TypesenseDriver {
    /// Connect, then probe `GET /collections` — `GET /health` reports node
    /// liveness without authentication, so the collection listing is the
    /// first call that actually proves the API key works.
    pub async fn connect(config: &ConnectionConfig) -> Result<Self> {
        let host = config
            .host
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .context("Typesense host is required")?;
        let is_loopback = matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]");
        let tls_enabled = !matches!(config.effective_ssl_mode(), SslMode::Disable);
        if !tls_enabled && !is_loopback {
            return Err(anyhow!(
                "Typesense driver plugins require TLS for non-loopback hosts"
            ));
        }
        let scheme = if tls_enabled { "https" } else { "http" };
        let port = config.port.unwrap_or(if tls_enabled { 443 } else { 8108 });
        let authority_host = if host.contains(':') && !host.starts_with('[') {
            format!("[{host}]")
        } else {
            host.to_string()
        };
        let base_url = Url::parse(&format!("{scheme}://{authority_host}:{port}/"))
            .map_err(|_| anyhow!("Typesense host or port is invalid"))?;
        if base_url.username() != "" || base_url.password().is_some() {
            return Err(anyhow!(
                "Typesense credentials cannot be embedded in the host"
            ));
        }

        let api_key = config
            .password
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                anyhow!("Typesense requires an API key (configure it as the connection password)")
            })?
            .to_string();
        // A key with control bytes would corrupt every request header; reject
        // it once here instead of failing later inside `header()`.
        if !api_key
            .bytes()
            .all(|byte| byte.is_ascii() && !byte.is_ascii_control())
        {
            return Err(anyhow!("Typesense API key contains invalid characters"));
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
                    "Typesense client certificate and key must be configured together"
                ))
            }
        }
        let client = client_builder.build()?;
        let driver = Self {
            client,
            base_url,
            api_key,
            current_collection: RwLock::new(
                config
                    .database
                    .clone()
                    .filter(|value| !value.trim().is_empty()),
            ),
            cancel_registry: RwLock::new(QueryCancelRegistry::new()),
        };
        driver.list_tables(None).await?;
        Ok(driver)
    }

    fn read_pem(path: &str, label: &str) -> Result<Vec<u8>> {
        let path = Path::new(path);
        let metadata = fs::symlink_metadata(path)
            .map_err(|e| anyhow!("Failed to inspect Typesense {label}: {e}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(anyhow!("Typesense {label} must be a regular file"));
        }
        if metadata.len() == 0 || metadata.len() > MAX_PEM_BYTES {
            return Err(anyhow!(
                "Typesense {label} exceeds the certificate size limit"
            ));
        }
        fs::read(path).map_err(|e| anyhow!("Failed to read Typesense {label}: {e}"))
    }

    /// Typesense collection names are restricted to [a-zA-Z0-9_-]; reject
    /// anything outside that set rather than percent-mangling a path segment.
    fn validate_collection_name(value: &str) -> Result<&str> {
        let value = value.trim();
        if value.is_empty()
            || value.len() > 255
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
        {
            return Err(anyhow!("Typesense collection name is invalid"));
        }
        Ok(value)
    }

    /// Field names for `query_by`/`filter_by`/`sort_by`/write payloads.
    /// Dotted names address nested object fields; a leading `_` is reserved
    /// for server-managed metadata (`_text_match`, `_vec_query`, …).
    fn validate_field_name(value: &str) -> Result<&str> {
        let value = value.trim();
        if value.is_empty()
            || value.len() > 255
            || value.starts_with('_')
            || value.split('.').any(str::is_empty)
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b".-_".contains(&byte))
        {
            return Err(anyhow!("Typesense field name is invalid"));
        }
        Ok(value)
    }

    /// `sort_by` accepts field names plus the `_text_match` relevance bucket
    /// (allowed here and only here — never as a writable field).
    fn validate_sort_field(value: &str) -> Result<&str> {
        let value = value.trim();
        if value == "_text_match" {
            return Ok(value);
        }
        Self::validate_field_name(value)
    }

    /// Document ids are used verbatim in a URL path segment; anything that
    /// could break out of the segment (`/`, `?`, `#`, `%`, control bytes) is
    /// rejected rather than percent-mangled.
    fn validate_doc_id(id: &str) -> Result<&str> {
        if id.is_empty()
            || id.len() > 512
            || !id
                .bytes()
                .all(|byte| (byte.is_ascii_graphic() || byte == b' ') && !b"/?#%".contains(&byte))
        {
            return Err(anyhow!("Typesense document id is invalid"));
        }
        Ok(id)
    }

    /// The collection a call targets: explicit argument wins, then the grid's
    /// `use_database`/`database` session default. There is no cross-collection
    /// wildcard (unlike OpenSearch's `_all`), so a default is required.
    fn collection_for(&self, value: Option<&str>) -> Result<String> {
        if let Some(value) = value.filter(|value| !value.trim().is_empty()) {
            return Ok(Self::validate_collection_name(value)?.to_string());
        }
        let current = self
            .current_collection
            .read()
            .map_err(|_| anyhow!("Typesense driver state is unavailable"))?
            .clone();
        match current {
            Some(name) => Ok(Self::validate_collection_name(&name)?.to_string()),
            None => Err(anyhow!(
                "Typesense requires a collection name; there is no 'all collections' target"
            )),
        }
    }

    /// Explicit table argument wins over the database/session default; an
    /// empty table falls back to the database override (mirrors the inline
    /// edit paths).
    fn target_collection<'a>(&self, table: &'a str, database: Option<&'a str>) -> Result<String> {
        self.collection_for(if table.trim().is_empty() {
            database
        } else {
            Some(table)
        })
    }

    fn request(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, String)],
    ) -> Result<reqwest::RequestBuilder> {
        if path.len() > 1024 || path.contains("..") || path.contains("//") || !path.starts_with('/')
        {
            return Err(anyhow!(
                "Typesense request path is outside the driver allowlist"
            ));
        }

        let mut url = self.base_url.join(path.trim_start_matches('/'))?;
        if url.scheme() != self.base_url.scheme()
            || url.host_str() != self.base_url.host_str()
            || url.port_or_known_default() != self.base_url.port_or_known_default()
        {
            return Err(anyhow!("Typesense request escaped the configured endpoint"));
        }
        if !query.is_empty() {
            let mut pairs = url.query_pairs_mut();
            for (key, value) in query {
                pairs.append_pair(key, value);
            }
        }
        Ok(self
            .client
            .request(method, url)
            .header("X-TYPESENSE-API-KEY", self.api_key.as_str()))
    }

    /// Read a response body with a hard byte cap; non-2xx surfaces the
    /// server's own `{"message": ...}` where present.
    async fn read_response(response: reqwest::Response) -> Result<Vec<u8>> {
        let status = response.status();
        if response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
        {
            return Err(anyhow!(
                "Typesense response exceeds the driver payload limit"
            ));
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
                return Err(anyhow!(
                    "Typesense response exceeds the driver payload limit"
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        if !status.is_success() {
            let message = match serde_json::from_slice::<Value>(&bytes) {
                Ok(value) => value
                    .get("message")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| {
                        String::from_utf8_lossy(&bytes)
                            .chars()
                            .take(400)
                            .collect::<String>()
                    }),
                Err(_) => String::from_utf8_lossy(&bytes)
                    .chars()
                    .take(400)
                    .collect::<String>(),
            };
            return Err(anyhow!(
                "Typesense request failed with {}: {}",
                status.as_u16(),
                message
            ));
        }
        Ok(bytes)
    }

    async fn send_json(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, String)],
        body: Option<&Value>,
    ) -> Result<Value> {
        if let Some(body) = body {
            if serde_json::to_vec(body)?.len() > MAX_REQUEST_BYTES {
                return Err(anyhow!("Typesense query exceeds the driver request limit"));
            }
        }
        let mut request = self.request(method, path, query)?;
        if let Some(body) = body {
            request = request.json(body);
        }
        let bytes = Self::read_response(request.send().await?).await?;
        if bytes.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&bytes).map_err(Into::into)
    }

    /// Raw-body variant for the JSONL endpoints (`documents/import` request,
    /// `documents/export` response) which are not single JSON documents.
    async fn send_text(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, String)],
        body: Option<Vec<u8>>,
    ) -> Result<Vec<u8>> {
        if body
            .as_ref()
            .is_some_and(|bytes| bytes.len() > MAX_IMPORT_BYTES)
        {
            return Err(anyhow!(
                "Typesense import payload exceeds the driver request limit"
            ));
        }
        let mut request = self.request(method, path, query)?;
        if let Some(body) = body {
            request = request
                .header(reqwest::header::CONTENT_TYPE, "text/plain;charset=utf-8")
                .body(body);
        }
        Self::read_response(request.send().await?).await
    }

    /// Fetch one collection's schema. 404 → `None` so callers can produce a
    /// friendly "collection not found" instead of leaking the HTTP status.
    async fn collection_meta(&self, name: &str) -> Result<Option<TypesenseCollection>> {
        let name = Self::validate_collection_name(name)?;
        let response = self
            .request(Method::GET, &format!("/collections/{name}"), &[])?
            .send()
            .await?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let bytes = Self::read_response(response).await?;
        let collection: TypesenseCollection = serde_json::from_slice(&bytes)
            .map_err(|error| anyhow!("Typesense collection response is invalid: {error}"))?;
        Ok(Some(collection))
    }

    /// Schema fields usable in `query_by`: indexed string or string-array
    /// fields only — numeric/bool fields cannot carry a full-text query and
    /// `id` is the document key, not a searchable string field.
    fn searchable_query_fields(schema: &TypesenseCollection) -> Vec<String> {
        schema
            .fields
            .iter()
            .filter(|field| {
                field.is_indexed()
                    && matches!(field.field_type.as_str(), "string" | "string[]" | "auto")
                    && field.name != "id"
            })
            .map(|field| field.name.clone())
            .collect()
    }

    fn column_info_for(name: &str, schema: Option<&TypesenseCollection>) -> ColumnInfo {
        let field = schema.and_then(|schema| schema.fields.iter().find(|field| field.name == name));
        ColumnInfo {
            name: name.to_string(),
            data_type: field
                .map(|field| field.field_type.clone())
                .unwrap_or_else(|| "json".to_string()),
            is_nullable: field.map(|field| field.optional).unwrap_or(true),
            is_primary_key: name == "id",
            max_length: None,
            default_value: None,
        }
    }

    /// Order result columns: `id` first (the row selector), then every schema
    /// field in declaration order, then any extra keys seen in documents.
    fn result_columns(
        schema: Option<&TypesenseCollection>,
        docs: &[Map<String, Value>],
    ) -> Vec<String> {
        let mut names = BTreeSet::new();
        let mut ordered = Vec::new();
        let push = |name: &str, names: &mut BTreeSet<String>, ordered: &mut Vec<String>| {
            if names.insert(name.to_string()) {
                ordered.push(name.to_string());
            }
        };
        push("id", &mut names, &mut ordered);
        if let Some(schema) = schema {
            for field in &schema.fields {
                if field.name != "id" {
                    push(&field.name, &mut names, &mut ordered);
                }
            }
        }
        for doc in docs {
            for key in doc.keys() {
                push(key, &mut names, &mut ordered);
            }
        }
        ordered
    }

    fn docs_to_result(
        docs: Vec<Map<String, Value>>,
        schema: Option<&TypesenseCollection>,
        elapsed: u128,
        query_label: String,
        truncated: bool,
    ) -> QueryResult {
        let columns = Self::result_columns(schema, &docs);
        let rows = docs
            .iter()
            .map(|doc| {
                columns
                    .iter()
                    .map(|name| doc.get(name).cloned().unwrap_or(Value::Null))
                    .collect()
            })
            .collect();
        QueryResult {
            columns: columns
                .iter()
                .map(|name| Self::column_info_for(name, schema))
                .collect(),
            rows,
            affected_rows: 0,
            execution_time_ms: elapsed,
            query: query_label,
            sandboxed: true,
            truncated,
        }
    }

    /// `POST /multi_search` for a single collection; the request body carries
    /// every parameter so nothing is interpolated into the URL.
    async fn search_docs(
        &self,
        params: Map<String, Value>,
        query_label: &str,
    ) -> Result<(Vec<Map<String, Value>>, i64)> {
        let body = json!({ "searches": [Value::Object(params)] });
        let response: TypesenseMultiSearchResponse = self
            .send_json(Method::POST, "/multi_search", &[], Some(&body))
            .await
            .and_then(|value| {
                serde_json::from_value(value)
                    .map_err(|error| anyhow!("Typesense search response is invalid: {error}"))
            })?;
        let result = response
            .results
            .and_then(|mut results| results.pop())
            .flatten()
            .ok_or_else(|| {
                anyhow!("Typesense search for '{query_label}' returned no result set")
            })?;
        if let Some(error) = result.error {
            return Err(anyhow!(
                "Typesense search for '{query_label}' failed (code {}): {error}",
                result.code.unwrap_or_default()
            ));
        }
        let found = result.found.unwrap_or(0);
        let docs = result
            .hits
            .unwrap_or_default()
            .into_iter()
            .filter_map(|hit| hit.document)
            .collect();
        Ok((docs, found))
    }

    /// Compile a validated `SearchSpec` into the `/multi_search` params object
    /// minus paging keys (added per page by `search_paged`). Field lists and
    /// operators are validated/enumerated, never templated.
    fn build_search_params(
        schema: &TypesenseCollection,
        spec: &SearchSpec,
    ) -> Result<Map<String, Value>> {
        let collection = Self::validate_collection_name(&spec.collection)?.to_string();
        let query_by = if spec.query_by.is_empty() {
            let fields = Self::searchable_query_fields(schema);
            if fields.is_empty() {
                return Err(anyhow!(
                    "Collection '{collection}' has no searchable string fields for query_by"
                ));
            }
            fields
        } else {
            spec.query_by
                .iter()
                .map(|name| Self::validate_field_name(name).map(str::to_string))
                .collect::<Result<Vec<_>>>()?
        };
        let mut params = Map::new();
        params.insert("collection".to_string(), Value::String(collection));
        params.insert("q".to_string(), Value::String(spec.q.clone()));
        params.insert("query_by".to_string(), Value::String(query_by.join(",")));
        let filter_by = compile_filter_by(&spec.predicates)?;
        if !filter_by.is_empty() {
            params.insert("filter_by".to_string(), Value::String(filter_by));
        }
        if !spec.sort_by.is_empty() {
            let sort = spec
                .sort_by
                .iter()
                .map(|(field, dir)| Ok(format!("{}:{}", Self::validate_sort_field(field)?, dir)))
                .collect::<Result<Vec<_>>>()?
                .join(",");
            params.insert("sort_by".to_string(), Value::String(sort));
        }
        if !spec.include_fields.is_empty() {
            // Always carry `id` so grid row selection keeps working even when
            // the SELECT column list omits it.
            let include = spec
                .include_fields
                .iter()
                .map(|name| Self::validate_field_name(name).map(str::to_string))
                .collect::<Result<BTreeSet<_>>>()?
                .into_iter()
                .chain(std::iter::once("id".to_string()))
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect::<Vec<_>>()
                .join(",");
            params.insert("include_fields".to_string(), Value::String(include));
        }
        Ok(params)
    }

    /// Walk `page`/`per_page` (max 250/page) to satisfy `offset`/`limit`;
    /// returns the collected documents plus the server's `found` count.
    async fn search_paged(
        &self,
        mut params: Map<String, Value>,
        offset: u64,
        limit: u64,
        query_label: &str,
    ) -> Result<(Vec<Map<String, Value>>, i64)> {
        if limit == 0 {
            return Ok((Vec::new(), 0));
        }
        let per_page = limit.clamp(1, TYPESENSE_MAX_PAGE);
        let mut page = (offset / per_page) + 1;
        // Rows to skip inside the first fetched page when `offset` does not
        // land on a page boundary.
        let mut skip = (offset % per_page) as usize;
        let mut docs: Vec<Map<String, Value>> = Vec::new();
        let found = loop {
            params.insert("per_page".to_string(), json!(per_page));
            params.insert("page".to_string(), json!(page));
            let (page_docs, page_found) = self.search_docs(params.clone(), query_label).await?;
            let fetched = page_docs.len();
            let skip_now = skip.min(fetched);
            let take = (limit as usize - docs.len()).min(fetched - skip_now);
            docs.extend(page_docs.into_iter().skip(skip_now).take(take));
            skip = 0;
            if docs.len() as u64 >= limit || fetched < per_page as usize {
                break page_found;
            }
            page += 1;
        };
        Ok((docs, found))
    }

    /// Run one search and return up to `spec.limit` documents.
    async fn run_search(&self, spec: &SearchSpec, query_label: String) -> Result<QueryResult> {
        let started = Instant::now();
        let schema = self
            .collection_meta(&spec.collection)
            .await?
            .ok_or_else(|| anyhow!("Typesense collection '{}' was not found", spec.collection))?;
        let params = Self::build_search_params(&schema, spec)?;
        let (docs, found) = self
            .search_paged(params, spec.offset, spec.limit, &query_label)
            .await?;
        let truncated = found > spec.offset as i64 + docs.len() as i64;
        Ok(Self::docs_to_result(
            docs,
            Some(&schema),
            started.elapsed().as_millis(),
            query_label,
            truncated,
        ))
    }

    /// Resolve the `(collection, doc_id)` a pk selector points at. The grid's
    /// row selector is the document `id` column; other key columns are ignored
    /// because Typesense documents are only addressable by `id`.
    fn document_target(
        &self,
        table: &str,
        database: Option<&str>,
        primary_keys: &[RowKeyValue],
    ) -> Result<(String, String)> {
        let doc_id = primary_keys
            .iter()
            .find(|key| key.column == "id")
            .map(|key| match &key.value {
                Value::String(text) => Ok(text.clone()),
                Value::Number(number) => Ok(number.to_string()),
                _ => Err(anyhow!("Typesense document id selector must be a string")),
            })
            .transpose()?
            .ok_or_else(|| {
                anyhow!("Typesense inline edits require the 'id' column as the row selector")
            })?;
        let doc_id = Self::validate_doc_id(&doc_id)?.to_string();
        let collection = self.target_collection(table, database)?;
        Ok((collection, doc_id))
    }

    /// `WHERE`-clause → document-id for `UPDATE`/`DELETE` statements, which
    /// only accept `WHERE id = <literal>` (Typesense has no UPDATE-by-filter).
    fn doc_id_from_predicates(predicates: &[TypesensePredicate]) -> Result<String> {
        let [predicate] = predicates else {
            bail!("Typesense UPDATE/DELETE requires exactly one predicate: WHERE id = <value>");
        };
        if predicate.field != "id" || predicate.kind != PredicateKind::Eq || predicate.negated {
            bail!("Typesense UPDATE/DELETE by id only supports WHERE id = <value>");
        }
        let [value] = predicate.values.as_slice() else {
            bail!("Typesense id predicate needs exactly one literal");
        };
        let doc_id = match value {
            Value::String(text) => text.clone(),
            Value::Number(number) => number.to_string(),
            _ => bail!("Typesense document id must be a string or number literal"),
        };
        Ok(Self::validate_doc_id(&doc_id)?.to_string())
    }

    /// The server-facing comparison prefix. A negated `=` maps to `:!=` and
    /// vice versa; `IN`/`NOT IN` use `:=`/`!=` with a value list; `BETWEEN`
    /// expands to `>= && <=` before this is called.
    fn filter_operator(kind: &PredicateKind, negated: bool) -> &'static str {
        match (kind, negated) {
            (PredicateKind::Eq, false) => ":=",
            (PredicateKind::Eq, true) | (PredicateKind::Ne, false) => ":!=",
            (PredicateKind::Ne, true) => ":=",
            (PredicateKind::Lt, false) => ":<",
            (PredicateKind::Lt, true) => ":>=",
            (PredicateKind::Le, false) => ":<=",
            (PredicateKind::Le, true) => ":>",
            (PredicateKind::Gt, false) => ":>",
            (PredicateKind::Gt, true) => ":<=",
            (PredicateKind::Ge, false) => ":>=",
            (PredicateKind::Ge, true) => ":<",
            (PredicateKind::In, false) => ":=",
            (PredicateKind::In, true) => ":!=",
            // Between expands to two comparisons before this is called.
            (PredicateKind::Between, _) => unreachable!(),
        }
    }

    /// One JSON literal → a `filter_by` operand. Strings are backtick-quoted
    /// (Typesense's string-literal form); a backtick inside a string literal
    /// cannot be escaped per the documented grammar, so it is rejected.
    fn filter_operand(value: &Value) -> Result<String> {
        match value {
            Value::Bool(flag) => Ok(flag.to_string()),
            Value::Number(number) => Ok(number.to_string()),
            Value::String(text) => {
                if text.contains('`') {
                    return Err(anyhow!("Typesense filter strings cannot contain backticks"));
                }
                Ok(format!("`{text}`"))
            }
            _ => Err(anyhow!(
                "Typesense filters accept string, number, or boolean literals only"
            )),
        }
    }

    /// Execute one parsed statement; searches produce a row set, everything
    /// else returns an affected count.
    async fn run_statement(
        &self,
        statement: &TypesenseStatement,
        query_label: String,
    ) -> Result<StatementOutcome> {
        match statement {
            TypesenseStatement::Search(spec) => Ok(StatementOutcome::Rows(
                self.run_search(spec, query_label).await?,
            )),
            TypesenseStatement::Insert {
                collection,
                documents,
            } => {
                let collection = Self::validate_collection_name(collection)?;
                let affected = if documents.len() == 1 {
                    let body = Value::Object(documents[0].clone());
                    self.send_json(
                        Method::POST,
                        &format!("/collections/{collection}/documents"),
                        &[],
                        Some(&body),
                    )
                    .await?;
                    1
                } else {
                    let lines = documents
                        .iter()
                        .map(|doc| serde_json::to_string(&Value::Object(doc.clone())))
                        .collect::<Result<Vec<_>, _>>()?;
                    // INSERT semantics are create-only: a duplicate id fails
                    // the line instead of silently upserting.
                    self.import_jsonl(collection, &lines, "create").await?
                };
                Ok(StatementOutcome::Affected(affected))
            }
            TypesenseStatement::Update {
                collection,
                doc_id,
                assignments,
            } => {
                let collection = Self::validate_collection_name(collection)?;
                let doc_id = Self::validate_doc_id(doc_id)?;
                let mut patch = Map::new();
                for (field, value) in assignments {
                    let field = Self::validate_field_name(field)?;
                    patch.insert(field.to_string(), value.clone());
                }
                if patch.is_empty() {
                    return Err(anyhow!("Typesense UPDATE requires at least one assignment"));
                }
                self.send_json(
                    Method::PATCH,
                    &format!("/collections/{collection}/documents/{doc_id}"),
                    &[],
                    Some(&Value::Object(patch)),
                )
                .await?;
                Ok(StatementOutcome::Affected(1))
            }
            TypesenseStatement::DeleteById { collection, doc_id } => {
                let collection = Self::validate_collection_name(collection)?;
                let doc_id = Self::validate_doc_id(doc_id)?;
                self.send_json(
                    Method::DELETE,
                    &format!("/collections/{collection}/documents/{doc_id}"),
                    &[],
                    None,
                )
                .await?;
                Ok(StatementOutcome::Affected(1))
            }
            TypesenseStatement::DeleteByFilter {
                collection,
                predicates,
            } => {
                let collection = Self::validate_collection_name(collection)?;
                let filter_by = compile_filter_by(predicates)?;
                if filter_by.is_empty() {
                    return Err(anyhow!("Typesense DELETE requires a WHERE clause"));
                }
                let response = self
                    .send_json(
                        Method::DELETE,
                        &format!("/collections/{collection}/documents"),
                        &[("filter_by", filter_by)],
                        None,
                    )
                    .await?;
                let deleted = response
                    .get("num_deleted")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                Ok(StatementOutcome::Affected(deleted))
            }
            TypesenseStatement::CreateCollection {
                name,
                fields,
                if_not_exists,
            } => {
                let name = Self::validate_collection_name(name)?;
                if *if_not_exists && self.collection_meta(name).await?.is_some() {
                    return Ok(StatementOutcome::Affected(0));
                }
                let body = json!({
                    "name": name,
                    "fields": fields.iter().map(field_spec_json).collect::<Vec<_>>(),
                });
                self.send_json(Method::POST, "/collections", &[], Some(&body))
                    .await?;
                Ok(StatementOutcome::Affected(1))
            }
            TypesenseStatement::DropCollection { name, if_exists } => {
                let name = Self::validate_collection_name(name)?;
                if *if_exists && self.collection_meta(name).await?.is_none() {
                    return Ok(StatementOutcome::Affected(0));
                }
                self.send_json(Method::DELETE, &format!("/collections/{name}"), &[], None)
                    .await?;
                Ok(StatementOutcome::Affected(1))
            }
            TypesenseStatement::AlterCollection { name, actions } => {
                let name = Self::validate_collection_name(name)?;
                let body = json!({
                    "fields": actions.iter().map(field_action_json).collect::<Vec<_>>(),
                });
                self.send_json(
                    Method::PATCH,
                    &format!("/collections/{name}"),
                    &[],
                    Some(&body),
                )
                .await?;
                Ok(StatementOutcome::Affected(1))
            }
            TypesenseStatement::Use(collection) => {
                let name = Self::validate_collection_name(collection)?.to_string();
                *self
                    .current_collection
                    .write()
                    .map_err(|_| anyhow!("Typesense driver state is unavailable"))? = Some(name);
                Ok(StatementOutcome::Affected(0))
            }
        }
    }

    /// `POST /collections/{c}/documents/import?action=<action>` for a JSONL
    /// batch (`create` for statement inserts, `emplace` for CSV upserts). The
    /// response is one JSON line per input line — the endpoint is NOT
    /// transactional, so a per-line failure is reported honestly with the
    /// count of lines the server already accepted.
    async fn import_jsonl(&self, collection: &str, lines: &[String], action: &str) -> Result<u64> {
        let body = lines.join("\n").into_bytes();
        let response = self
            .send_text(
                Method::POST,
                &format!("/collections/{collection}/documents/import"),
                &[("action", action.to_string())],
                Some(body),
            )
            .await?;
        let text = String::from_utf8(response)
            .map_err(|_| anyhow!("Typesense import response is not UTF-8"))?;
        let mut succeeded = 0_u64;
        for (index, line) in text.lines().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            let entry: Value = serde_json::from_str(line).map_err(|_| {
                anyhow!(
                    "Typesense import returned an unreadable result line {}",
                    index + 1
                )
            })?;
            match entry.get("success").and_then(Value::as_bool) {
                Some(true) => succeeded += 1,
                _ => {
                    let detail = entry
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown error");
                    return Err(anyhow!(
                        "Typesense import failed on line {} ({detail}); \
                         {succeeded} of {} documents were imported — the batch is not transactional",
                        index + 1,
                        lines.len()
                    ));
                }
            }
        }
        Ok(succeeded)
    }

    /// Shared query body: split multi-statement input, run each statement in
    /// order, keep the last row-producing result, accumulate affected counts.
    /// `cancel_flag` aborts between statements; an in-flight request can only
    /// be abandoned client-side (Typesense has no server-side cancel).
    async fn execute_query_inner(
        &self,
        sql: &str,
        cancel_flag: Option<Arc<AtomicBool>>,
    ) -> Result<QueryResult> {
        if sql.len() > MAX_REQUEST_BYTES {
            return Err(anyhow!("Typesense query exceeds the driver request limit"));
        }
        let started = Instant::now();
        let statements = split_sql_statements(sql);
        let mut total_affected = 0u64;
        let mut last_result: Option<QueryResult> = None;

        for statement in statements
            .iter()
            .filter(|statement| !statement.trim().is_empty())
        {
            if cancel_flag
                .as_ref()
                .is_some_and(|flag| flag.load(Ordering::SeqCst))
            {
                return Err(anyhow!("Query cancelled."));
            }
            let parsed = parse_statement(statement)?;
            match self.run_statement(&parsed, sql.to_string()).await? {
                StatementOutcome::Rows(mut result) => {
                    result.query = sql.to_string();
                    last_result = Some(result);
                }
                StatementOutcome::Affected(count) => {
                    total_affected = total_affected.saturating_add(count);
                }
            }
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
            sandboxed: true,
            truncated: false,
        })
    }

    /// The grid's raw filter box is a Typesense `filter_by` expression
    /// verbatim — it travels as a JSON param/query value, never as spliced
    /// SQL text.
    fn raw_filter_by(filter: Option<&str>) -> Result<Option<String>> {
        match filter.map(str::trim).filter(|value| !value.is_empty()) {
            Some(filter) if filter.len() <= MAX_FILTER_LEN => Ok(Some(filter.to_string())),
            Some(_) => Err(anyhow!("Typesense filter exceeds the driver limit")),
            None => Ok(None),
        }
    }

    /// `documents/export` JSONL → parsed documents (one bounded response).
    async fn export_docs_jsonl(
        &self,
        collection: &str,
        filter_by: Option<String>,
    ) -> Result<Vec<Map<String, Value>>> {
        let query: Vec<(&str, String)> = filter_by
            .into_iter()
            .map(|value| ("filter_by", value))
            .collect();
        let bytes = self
            .send_text(
                Method::GET,
                &format!("/collections/{collection}/documents/export"),
                &query,
                None,
            )
            .await?;
        let text = String::from_utf8(bytes)
            .map_err(|_| anyhow!("Typesense export response is not UTF-8"))?;
        let mut docs = Vec::new();
        for line in text.lines() {
            if line.trim().is_empty() {
                continue;
            }
            docs.push(
                serde_json::from_str::<Map<String, Value>>(line)
                    .map_err(|_| anyhow!("Typesense export returned an unreadable document"))?,
            );
        }
        Ok(docs)
    }
}

/// `filter_by` string for a predicate list (`&&`-joined per the Typesense
/// grammar). Values are serialized as JSON-mapped operands — never spliced
/// raw text — and `BETWEEN` expands to a `low && high` pair before compile.
fn compile_filter_by(predicates: &[TypesensePredicate]) -> Result<String> {
    let mut clauses = Vec::new();
    for predicate in predicates {
        let field = TypesenseDriver::validate_field_name(&predicate.field)?;
        match predicate.kind {
            PredicateKind::Between => {
                if predicate.negated {
                    return Err(anyhow!(
                        "Typesense cannot express NOT BETWEEN in a single filter clause"
                    ));
                }
                let [low, high] = predicate.values.as_slice() else {
                    return Err(anyhow!("BETWEEN requires two literals"));
                };
                clauses.push(format!(
                    "{field}:>={}",
                    TypesenseDriver::filter_operand(low)?
                ));
                clauses.push(format!(
                    "{field}:<={}",
                    TypesenseDriver::filter_operand(high)?
                ));
            }
            PredicateKind::In => {
                let operands = predicate
                    .values
                    .iter()
                    .map(TypesenseDriver::filter_operand)
                    .collect::<Result<Vec<_>>>()?;
                if operands.is_empty() {
                    return Err(anyhow!("IN requires at least one literal"));
                }
                let operator = TypesenseDriver::filter_operator(&predicate.kind, predicate.negated);
                clauses.push(format!("{field}{operator}[{}]", operands.join(",")));
            }
            _ => {
                let [value] = predicate.values.as_slice() else {
                    return Err(anyhow!("A comparison predicate needs exactly one literal"));
                };
                let operator = TypesenseDriver::filter_operator(&predicate.kind, predicate.negated);
                clauses.push(format!(
                    "{field}{operator}{}",
                    TypesenseDriver::filter_operand(value)?
                ));
            }
        }
    }
    Ok(clauses.join(" && "))
}

/// Map a SQL-ish column type onto a Typesense field type; a trailing `[]` or
/// `ARRAY` array marker is preserved on the mapped scalar.
fn map_sql_type(raw: &str) -> Result<String> {
    let trimmed = raw.trim();
    let (scalar, array) = if let Some(scalar) = trimmed.strip_suffix("[]") {
        (scalar.trim(), true)
    } else if trimmed.to_ascii_lowercase().ends_with(" array") {
        (trimmed[..trimmed.len() - " array".len()].trim(), true)
    } else {
        (trimmed, false)
    };
    let mapped = match scalar.to_ascii_lowercase().as_str() {
        "string" | "text" | "varchar" | "char" | "json" | "jsonb" => "string",
        "int32" | "int" | "integer" | "smallint" | "mediumint" => "int32",
        "int64" | "bigint" | "long" | "bigserial" | "serial" => "int64",
        "float" | "double" | "real" | "decimal" | "numeric" | "float64" => "float",
        "bool" | "boolean" => "bool",
        "object" => "object",
        "geopoint" => "geopoint",
        "auto" => "auto",
        "string*" | "image" => "string*",
        other => {
            return Err(anyhow!(
                "Typesense does not support column type '{other}'; \
                 use string, int32, int64, float, bool, object, geopoint, or auto \
                 (append [] for arrays)"
            ))
        }
    };
    Ok(if array {
        format!("{mapped}[]")
    } else {
        mapped.to_string()
    })
}

fn field_spec_json(spec: &FieldSpec) -> Value {
    let mut field = Map::new();
    field.insert("name".to_string(), Value::String(spec.name.clone()));
    field.insert("type".to_string(), Value::String(spec.field_type.clone()));
    if spec.optional {
        field.insert("optional".to_string(), json!(true));
    }
    if spec.facet {
        field.insert("facet".to_string(), json!(true));
    }
    if spec.sort {
        field.insert("sort".to_string(), json!(true));
    }
    if !spec.index {
        field.insert("index".to_string(), json!(false));
    }
    Value::Object(field)
}

fn field_action_json(action: &FieldAction) -> Value {
    match action {
        FieldAction::Add(spec) => field_spec_json(spec),
        FieldAction::Drop(name) => json!({ "name": name, "drop": true }),
    }
}

// ---------------------------------------------------------------------------
// Statement parser: tokenizes the documented subset and builds a typed AST.
// Nothing from user input is concatenated into API text; parse output feeds
// the JSON params/payload builders above.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Ident(String),
    Str(String),
    Num(String),
    Op(String),
    LParen,
    RParen,
    Comma,
    Star,
}

fn tokenize(input: &str) -> Result<Vec<Token>> {
    let bytes = input.as_bytes();
    let mut tokens = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        match byte {
            b' ' | b'\t' | b'\r' | b'\n' => index += 1,
            b'-' if bytes.get(index + 1) == Some(&b'-') => {
                // `--` line comment.
                while index < bytes.len() && bytes[index] != b'\n' {
                    index += 1;
                }
            }
            b'#' => {
                // `#` line comment.
                while index < bytes.len() && bytes[index] != b'\n' {
                    index += 1;
                }
            }
            b'/' if bytes.get(index + 1) == Some(&b'*') => {
                // `/* */` block comment.
                index += 2;
                match input[index..].find("*/") {
                    Some(end) => index += end + 2,
                    None => return Err(anyhow!("Unterminated block comment")),
                }
            }
            b'\'' | b'"' => {
                let quote = byte;
                index += 1;
                let mut value = String::new();
                // Walk chars (not bytes) so multi-byte UTF-8 survives intact.
                loop {
                    let mut chars = input[index..].chars();
                    match chars.next() {
                        Some(next) if next == quote as char => {
                            if chars.next() == Some(quote as char) {
                                value.push(quote as char);
                                index += 2;
                            } else {
                                index += 1;
                                break;
                            }
                        }
                        Some(next) => {
                            value.push(next);
                            index += next.len_utf8();
                        }
                        None => return Err(anyhow!("Unterminated string literal")),
                    }
                }
                tokens.push(Token::Str(value));
            }
            b'(' => {
                tokens.push(Token::LParen);
                index += 1;
            }
            b')' => {
                tokens.push(Token::RParen);
                index += 1;
            }
            b',' => {
                tokens.push(Token::Comma);
                index += 1;
            }
            b'*' => {
                tokens.push(Token::Star);
                index += 1;
            }
            b'=' | b'!' | b'<' | b'>' => {
                let two = bytes.get(index + 1).copied();
                let op = match (byte, two) {
                    (b'!', Some(b'=')) => "!=",
                    (b'<', Some(b'=')) => "<=",
                    (b'>', Some(b'=')) => ">=",
                    (b'<', Some(b'>')) => "!=",
                    (b'=', _) => "=",
                    (b'!', _) => return Err(anyhow!("Expected != but found !")),
                    (b'<', _) => "<",
                    (b'>', _) => ">",
                    _ => unreachable!(),
                };
                index += op.len();
                tokens.push(Token::Op(op.to_string()));
            }
            _ if byte.is_ascii_digit()
                || (byte == b'-'
                    && bytes
                        .get(index + 1)
                        .is_some_and(|next| next.is_ascii_digit() || *next == b'.'))
                || (byte == b'.'
                    && bytes
                        .get(index + 1)
                        .is_some_and(|next| next.is_ascii_digit())) =>
            {
                let start = index;
                index += 1;
                while index < bytes.len()
                    && matches!(bytes[index], b'0'..=b'9' | b'.' | b'e' | b'E' | b'+' | b'-')
                {
                    index += 1;
                }
                tokens.push(Token::Num(input[start..index].to_string()));
            }
            _ if byte.is_ascii_alphanumeric() || byte == b'_' || byte >= 0x80 => {
                let start = index;
                index += 1;
                while index < bytes.len()
                    && (bytes[index].is_ascii_alphanumeric()
                        || matches!(bytes[index], b'_' | b'.' | b'-' | b'[' | b']')
                        || bytes[index] >= 0x80)
                {
                    index += 1;
                }
                tokens.push(Token::Ident(input[start..index].to_string()));
            }
            _ => {
                return Err(anyhow!(
                    "Typesense query contains an unsupported character '{}'",
                    byte as char
                ))
            }
        }
    }
    Ok(tokens)
}

/// Keywords that can never be used as bare identifiers in the grammar; the
/// parser checks this so `SELECT FROM t` errors instead of creating a field.
const RESERVED: &[&str] = &[
    "SELECT",
    "FROM",
    "WHERE",
    "ORDER",
    "BY",
    "ASC",
    "DESC",
    "LIMIT",
    "OFFSET",
    "AND",
    "OR",
    "NOT",
    "IN",
    "BETWEEN",
    "IS",
    "NULL",
    "TRUE",
    "FALSE",
    "INSERT",
    "INTO",
    "VALUES",
    "UPDATE",
    "SET",
    "DELETE",
    "CREATE",
    "TABLE",
    "COLLECTION",
    "DROP",
    "ALTER",
    "ADD",
    "COLUMN",
    "FIELD",
    "USE",
    "SEARCH",
    "FOR",
    "IF",
    "EXISTS",
    "FACET",
    "SORT",
    "OPTIONAL",
    "INDEX",
    "NO",
    "LIKE",
    "DISTINCT",
    "ALL",
    "AS",
    "ON",
    "GROUP",
    "HAVING",
    "JOIN",
    "UNION",
    "DEFAULT",
    "PRIMARY",
    "KEY",
    "ARRAY",
];

struct Parser<'a> {
    tokens: &'a [Token],
    pos: usize,
}

impl<'a> Parser<'a> {
    fn new(tokens: &'a [Token]) -> Self {
        Self { tokens, pos: 0 }
    }

    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.pos)
    }

    fn next(&mut self) -> Option<Token> {
        let token = self.tokens.get(self.pos).cloned();
        if token.is_some() {
            self.pos += 1;
        }
        token
    }

    fn at_end(&self) -> bool {
        self.pos >= self.tokens.len()
    }

    fn keyword_is(&self, keyword: &str) -> bool {
        matches!(
            self.peek(),
            Some(Token::Ident(word)) if word.eq_ignore_ascii_case(keyword)
        )
    }

    fn eat_keyword(&mut self, keyword: &str) -> bool {
        if self.keyword_is(keyword) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    fn expect_keyword(&mut self, keyword: &str) -> Result<()> {
        if self.eat_keyword(keyword) {
            Ok(())
        } else {
            Err(anyhow!("Expected {keyword}"))
        }
    }

    fn ident(&mut self) -> Result<String> {
        match self.next() {
            Some(Token::Ident(name)) => {
                if RESERVED
                    .iter()
                    .any(|keyword| name.eq_ignore_ascii_case(keyword))
                {
                    Err(anyhow!("Expected an identifier, found keyword '{name}'"))
                } else {
                    Ok(name)
                }
            }
            _ => Err(anyhow!("Expected an identifier")),
        }
    }

    fn literal(&mut self) -> Result<Value> {
        match self.next() {
            Some(Token::Str(text)) => Ok(Value::String(text)),
            Some(Token::Num(text)) => serde_json::from_str::<Value>(&text)
                .map_err(|_| anyhow!("Invalid numeric literal '{text}'")),
            Some(Token::Ident(word)) if word.eq_ignore_ascii_case("true") => Ok(Value::Bool(true)),
            Some(Token::Ident(word)) if word.eq_ignore_ascii_case("false") => {
                Ok(Value::Bool(false))
            }
            Some(Token::Ident(word)) if word.eq_ignore_ascii_case("null") => Ok(Value::Null),
            _ => Err(anyhow!("Expected a literal value")),
        }
    }

    fn comma_list<T>(&mut self, mut item: impl FnMut(&mut Self) -> Result<T>) -> Result<Vec<T>> {
        let mut items = vec![item(self)?];
        while matches!(self.peek(), Some(Token::Comma)) {
            self.pos += 1;
            items.push(item(self)?);
        }
        Ok(items)
    }

    fn expect_punct(&mut self, punct: char) -> Result<()> {
        let expected = match punct {
            '(' => Token::LParen,
            ')' => Token::RParen,
            ',' => Token::Comma,
            '*' => Token::Star,
            _ => unreachable!(),
        };
        if self.peek() == Some(&expected) {
            self.pos += 1;
            Ok(())
        } else {
            Err(anyhow!("Expected '{punct}'"))
        }
    }

    /// `WHERE`-clause predicate list shared by SELECT/UPDATE/DELETE/SEARCH.
    /// Both `NOT field op` and `field NOT IN|BETWEEN` are recognized; the two
    /// negations combine so `NOT ... NOT IN` is a double negation.
    fn predicate_list(&mut self) -> Result<Vec<TypesensePredicate>> {
        let mut predicates = Vec::new();
        loop {
            let leading_not = self.eat_keyword("NOT");
            let field = self.ident()?;
            if self.eat_keyword("IS") {
                // Optional fields are omitted rather than stored NULL, so
                // IS [NOT] NULL has no filter equivalent — reject honestly.
                let _ = self.eat_keyword("NOT");
                self.expect_keyword("NULL")?;
                return Err(anyhow!(
                    "Typesense cannot filter on missing fields: IS [NOT] NULL is unsupported"
                ));
            }
            let mut inner_not = false;
            let kind = if self.eat_keyword("IN") {
                PredicateKind::In
            } else if self.keyword_is("NOT") {
                self.pos += 1;
                inner_not = true;
                if self.eat_keyword("IN") {
                    PredicateKind::In
                } else if self.eat_keyword("BETWEEN") {
                    PredicateKind::Between
                } else {
                    return Err(anyhow!("Expected IN or BETWEEN after NOT"));
                }
            } else if self.eat_keyword("BETWEEN") {
                PredicateKind::Between
            } else {
                match self.next() {
                    Some(Token::Op(op)) => match op.as_str() {
                        "=" => PredicateKind::Eq,
                        "!=" => PredicateKind::Ne,
                        "<" => PredicateKind::Lt,
                        "<=" => PredicateKind::Le,
                        ">" => PredicateKind::Gt,
                        ">=" => PredicateKind::Ge,
                        other => return Err(anyhow!("Unsupported operator '{other}'")),
                    },
                    Some(Token::Ident(word)) if word.eq_ignore_ascii_case("LIKE") => {
                        return Err(anyhow!(
                            "LIKE is unsupported; use SEARCH <collection> FOR '<terms>' for text matching"
                        ));
                    }
                    _ => return Err(anyhow!("Expected a comparison operator")),
                }
            };
            let negated = leading_not ^ inner_not;
            match kind {
                PredicateKind::In => {
                    self.expect_punct('(')?;
                    let values = self.comma_list(Self::literal)?;
                    self.expect_punct(')')?;
                    predicates.push(TypesensePredicate {
                        field,
                        kind,
                        values,
                        negated,
                    });
                }
                PredicateKind::Between => {
                    let low = self.literal()?;
                    self.expect_keyword("AND")?;
                    let high = self.literal()?;
                    predicates.push(TypesensePredicate {
                        field,
                        kind,
                        values: vec![low, high],
                        negated,
                    });
                }
                _ => {
                    let value = self.literal()?;
                    predicates.push(TypesensePredicate {
                        field,
                        kind,
                        values: vec![value],
                        negated,
                    });
                }
            }
            if !self.eat_keyword("AND") {
                break;
            }
        }
        Ok(predicates)
    }

    fn optional_where(&mut self) -> Result<Vec<TypesensePredicate>> {
        if self.eat_keyword("WHERE") {
            self.predicate_list()
        } else {
            Ok(Vec::new())
        }
    }

    fn optional_order_limit(&mut self, spec: &mut SearchSpec) -> Result<()> {
        if self.eat_keyword("ORDER") {
            self.expect_keyword("BY")?;
            spec.sort_by = self.comma_list(|parser| {
                let field = parser.ident()?;
                TypesenseDriver::validate_sort_field(&field)?;
                let dir = if parser.eat_keyword("DESC") {
                    "desc"
                } else {
                    let _ = parser.eat_keyword("ASC");
                    "asc"
                };
                Ok((field, dir.to_string()))
            })?;
        }
        if self.eat_keyword("LIMIT") {
            match self.next() {
                Some(Token::Num(text)) => {
                    spec.limit = text
                        .parse::<u64>()
                        .map_err(|_| anyhow!("LIMIT must be a non-negative integer"))?;
                }
                _ => return Err(anyhow!("LIMIT must be a non-negative integer")),
            }
        }
        if self.eat_keyword("OFFSET") {
            match self.next() {
                Some(Token::Num(text)) => {
                    spec.offset = text
                        .parse::<u64>()
                        .map_err(|_| anyhow!("OFFSET must be a non-negative integer"))?;
                }
                _ => return Err(anyhow!("OFFSET must be a non-negative integer")),
            }
        }
        Ok(())
    }

    fn parse_select(&mut self) -> Result<TypesenseStatement> {
        self.expect_keyword("SELECT")?;
        let include_fields = if matches!(self.peek(), Some(Token::Star)) {
            self.pos += 1;
            Vec::new()
        } else {
            self.comma_list(Self::ident)?
        };
        self.expect_keyword("FROM")?;
        let collection = self.ident()?;
        let mut spec = SearchSpec {
            collection,
            q: "*".to_string(),
            limit: MAX_RESULT_ROWS as u64,
            include_fields,
            ..SearchSpec::default()
        };
        spec.predicates = self.optional_where()?;
        self.optional_order_limit(&mut spec)?;
        Ok(TypesenseStatement::Search(spec))
    }

    /// `SEARCH <collection> [FOR '<terms>'] [BY <field,...>]` — the dedicated
    /// full-text surface. FOR defaults to `*`; BY defaults to every indexed
    /// string field in the collection schema.
    fn parse_search(&mut self) -> Result<TypesenseStatement> {
        self.expect_keyword("SEARCH")?;
        let collection = self.ident()?;
        let mut spec = SearchSpec {
            collection,
            q: "*".to_string(),
            limit: MAX_RESULT_ROWS as u64,
            ..SearchSpec::default()
        };
        if self.eat_keyword("FOR") {
            match self.next() {
                Some(Token::Str(terms)) => spec.q = terms,
                Some(Token::Ident(terms)) => spec.q = terms,
                _ => return Err(anyhow!("SEARCH FOR expects a quoted search string")),
            }
        }
        if self.eat_keyword("BY") {
            spec.query_by = self.comma_list(Self::ident)?;
        }
        spec.predicates = self.optional_where()?;
        self.optional_order_limit(&mut spec)?;
        Ok(TypesenseStatement::Search(spec))
    }

    fn parse_insert(&mut self) -> Result<TypesenseStatement> {
        self.expect_keyword("INSERT")?;
        self.expect_keyword("INTO")?;
        let collection = self.ident()?;
        self.expect_punct('(')?;
        let columns = self.comma_list(Self::ident)?;
        for column in &columns {
            TypesenseDriver::validate_field_name(column)?;
        }
        self.expect_punct(')')?;
        self.expect_keyword("VALUES")?;
        let mut documents = Vec::new();
        loop {
            self.expect_punct('(')?;
            let values = self.comma_list(Self::literal)?;
            self.expect_punct(')')?;
            if values.len() != columns.len() {
                return Err(anyhow!(
                    "INSERT has {} columns but {} values",
                    columns.len(),
                    values.len()
                ));
            }
            let mut doc = Map::new();
            for (column, value) in columns.iter().zip(values) {
                if column == "id" && !value.is_string() {
                    return Err(anyhow!("Typesense document ids must be strings"));
                }
                // NULL is not stored — inserting NULL omits the field, which
                // matches how Typesense represents "no value".
                if !value.is_null() {
                    doc.insert(column.clone(), value);
                }
            }
            documents.push(doc);
            if matches!(self.peek(), Some(Token::Comma)) {
                self.pos += 1;
            } else {
                break;
            }
        }
        Ok(TypesenseStatement::Insert {
            collection,
            documents,
        })
    }

    fn parse_update(&mut self) -> Result<TypesenseStatement> {
        self.expect_keyword("UPDATE")?;
        let collection = self.ident()?;
        self.expect_keyword("SET")?;
        let assignments = self.comma_list(|parser| {
            let field = parser.ident()?;
            if field == "id" {
                return Err(anyhow!("Typesense document ids are immutable"));
            }
            TypesenseDriver::validate_field_name(&field)?;
            match parser.next() {
                Some(Token::Op(op)) if op == "=" => {}
                _ => return Err(anyhow!("Expected = in UPDATE assignment")),
            }
            let value = parser.literal()?;
            if value.is_null() {
                return Err(anyhow!(
                    "Typesense cannot clear a field via PATCH — set an explicit value instead"
                ));
            }
            Ok((field, value))
        })?;
        self.expect_keyword("WHERE")?;
        let predicates = self.predicate_list()?;
        let doc_id = TypesenseDriver::doc_id_from_predicates(&predicates)?;
        Ok(TypesenseStatement::Update {
            collection,
            doc_id,
            assignments,
        })
    }

    fn parse_delete(&mut self) -> Result<TypesenseStatement> {
        self.expect_keyword("DELETE")?;
        self.expect_keyword("FROM")?;
        let collection = self.ident()?;
        self.expect_keyword("WHERE")?;
        let predicates = self.predicate_list()?;
        match TypesenseDriver::doc_id_from_predicates(&predicates) {
            Ok(doc_id) => Ok(TypesenseStatement::DeleteById { collection, doc_id }),
            Err(_) => Ok(TypesenseStatement::DeleteByFilter {
                collection,
                predicates,
            }),
        }
    }

    /// One `<name> <type> [OPTIONAL|NOT NULL|NULL] [FACET] [SORT] [NO INDEX]`
    /// field definition used by CREATE TABLE and ALTER ... ADD COLUMN.
    fn parse_field_spec(&mut self) -> Result<FieldSpec> {
        let name = self.ident()?;
        if name == "id" {
            return Err(anyhow!(
                "Typesense supplies the 'id' field implicitly; it cannot be declared"
            ));
        }
        TypesenseDriver::validate_field_name(&name)?;
        let mut raw_type = match self.next() {
            Some(Token::Ident(word)) => word,
            _ => return Err(anyhow!("Expected a field type")),
        };
        if self.eat_keyword("ARRAY") {
            raw_type.push_str(" array");
        }
        if self.eat_keyword("DEFAULT") {
            return Err(anyhow!("Field defaults are unsupported by Typesense"));
        }
        let field_type = map_sql_type(&raw_type)?;
        let mut spec = FieldSpec {
            name,
            field_type,
            optional: false,
            facet: false,
            sort: false,
            index: true,
        };
        // Optional field flags in any order; NOT NULL marks a required field.
        loop {
            if self.eat_keyword("OPTIONAL") || self.eat_keyword("NULL") {
                spec.optional = true;
            } else if self.eat_keyword("NOT") {
                self.expect_keyword("NULL")?;
                spec.optional = false;
            } else if self.eat_keyword("FACET") {
                spec.facet = true;
            } else if self.eat_keyword("SORT") {
                spec.sort = true;
            } else if self.eat_keyword("NO") {
                self.expect_keyword("INDEX")?;
                spec.index = false;
            } else {
                break;
            }
        }
        Ok(spec)
    }

    fn parse_create(&mut self) -> Result<TypesenseStatement> {
        self.expect_keyword("CREATE")?;
        if !(self.eat_keyword("TABLE") || self.eat_keyword("COLLECTION")) {
            return Err(anyhow!(
                "Typesense only supports CREATE TABLE <collection> (fields...) — \
                 indexes, synonyms, and aliases are managed by the server"
            ));
        }
        let if_not_exists = if self.eat_keyword("IF") {
            self.expect_keyword("NOT")?;
            self.expect_keyword("EXISTS")?;
            true
        } else {
            false
        };
        let name = self.ident()?;
        self.expect_punct('(')?;
        let fields = self.comma_list(Self::parse_field_spec)?;
        self.expect_punct(')')?;
        Ok(TypesenseStatement::CreateCollection {
            name,
            fields,
            if_not_exists,
        })
    }

    fn parse_drop(&mut self) -> Result<TypesenseStatement> {
        self.expect_keyword("DROP")?;
        if !(self.eat_keyword("TABLE") || self.eat_keyword("COLLECTION")) {
            return Err(anyhow!("Typesense only supports DROP TABLE <collection>"));
        }
        let if_exists = if self.eat_keyword("IF") {
            self.expect_keyword("EXISTS")?;
            true
        } else {
            false
        };
        let name = self.ident()?;
        Ok(TypesenseStatement::DropCollection { name, if_exists })
    }

    fn parse_alter(&mut self) -> Result<TypesenseStatement> {
        self.expect_keyword("ALTER")?;
        if !(self.eat_keyword("TABLE") || self.eat_keyword("COLLECTION")) {
            return Err(anyhow!("Typesense only supports ALTER TABLE <collection>"));
        }
        let name = self.ident()?;
        let actions = self.comma_list(|parser| {
            if parser.eat_keyword("ADD") {
                let _ = parser.eat_keyword("COLUMN") || parser.eat_keyword("FIELD");
                Ok(FieldAction::Add(parser.parse_field_spec()?))
            } else if parser.eat_keyword("DROP") {
                let _ = parser.eat_keyword("COLUMN") || parser.eat_keyword("FIELD");
                let field = parser.ident()?;
                if field == "id" {
                    return Err(anyhow!("Typesense's implicit 'id' field cannot be dropped"));
                }
                TypesenseDriver::validate_field_name(&field)?;
                Ok(FieldAction::Drop(field))
            } else {
                Err(anyhow!(
                    "ALTER TABLE supports ADD COLUMN and DROP COLUMN only"
                ))
            }
        })?;
        Ok(TypesenseStatement::AlterCollection { name, actions })
    }

    fn parse_use(&mut self) -> Result<TypesenseStatement> {
        self.expect_keyword("USE")?;
        let name = self.ident()?;
        Ok(TypesenseStatement::Use(name))
    }
}

/// Entry point: dispatch on the leading keyword, build the typed statement,
/// and reject trailing garbage — anything outside the documented subset fails
/// here with a precise error instead of reaching the API.
fn parse_statement(statement: &str) -> Result<TypesenseStatement> {
    let tokens = tokenize(statement)?;
    if tokens.is_empty() {
        return Err(anyhow!("Empty statement"));
    }
    let mut parser = Parser::new(&tokens);
    let parsed = match parser.peek() {
        Some(Token::Ident(word)) if word.eq_ignore_ascii_case("SELECT") => parser.parse_select(),
        Some(Token::Ident(word)) if word.eq_ignore_ascii_case("SEARCH") => parser.parse_search(),
        Some(Token::Ident(word)) if word.eq_ignore_ascii_case("INSERT") => parser.parse_insert(),
        Some(Token::Ident(word)) if word.eq_ignore_ascii_case("UPDATE") => parser.parse_update(),
        Some(Token::Ident(word)) if word.eq_ignore_ascii_case("DELETE") => parser.parse_delete(),
        Some(Token::Ident(word)) if word.eq_ignore_ascii_case("CREATE") => parser.parse_create(),
        Some(Token::Ident(word)) if word.eq_ignore_ascii_case("DROP") => parser.parse_drop(),
        Some(Token::Ident(word)) if word.eq_ignore_ascii_case("ALTER") => parser.parse_alter(),
        Some(Token::Ident(word)) if word.eq_ignore_ascii_case("USE") => parser.parse_use(),
        _ => Err(anyhow!(
            "Typesense supports a limited statement set: SELECT … FROM, \
             SEARCH <collection> FOR '<terms>', INSERT/UPDATE/DELETE, \
             CREATE/DROP/ALTER TABLE, and USE"
        )),
    }?;
    if !parser.at_end() {
        return Err(anyhow!("Unexpected trailing tokens in statement"));
    }
    Ok(parsed)
}

#[async_trait]
impl DatabaseDriver for TypesenseDriver {
    async fn ping(&self) -> Result<()> {
        self.send_json(Method::GET, "/health", &[], None)
            .await
            .map(|_| ())
    }

    async fn disconnect(&self) -> Result<()> {
        Ok(())
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        Ok(vec![DatabaseInfo {
            name: self
                .current_database()
                .unwrap_or_else(|| "collections".to_string()),
            size: None,
        }])
    }

    async fn list_tables(&self, _database: Option<&str>) -> Result<Vec<TableInfo>> {
        let value = self
            .send_json(Method::GET, "/collections", &[], None)
            .await?;
        let collections: Vec<TypesenseCollection> = serde_json::from_value(value)
            .map_err(|error| anyhow!("Typesense collections response is invalid: {error}"))?;
        Ok(collections
            .into_iter()
            .map(|collection| TableInfo {
                name: collection.name,
                schema: None,
                table_type: "collection".to_string(),
                row_count: Some(collection.num_documents),
                engine: Some("typesense".to_string()),
                create_date: None,
            })
            .collect())
    }

    async fn list_schema_objects(&self, _database: Option<&str>) -> Result<Vec<SchemaObjectInfo>> {
        // Collection aliases are the only named schema-level objects Typesense
        // exposes; a server too old to know /aliases degrades to an empty list
        // with a warning rather than breaking the schema panel.
        let bytes = match self.send_text(Method::GET, "/aliases", &[], None).await {
            Ok(bytes) => bytes,
            Err(error) => {
                log::warn!("Typesense /aliases listing failed: {error}");
                return Ok(Vec::new());
            }
        };
        let value: Value = match serde_json::from_slice(&bytes) {
            Ok(value) => value,
            Err(error) => {
                log::warn!("Typesense /aliases response is unreadable: {error}");
                return Ok(Vec::new());
            }
        };
        Ok(value
            .get("aliases")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|alias| {
                Some(SchemaObjectInfo {
                    name: alias.get("name")?.as_str()?.to_string(),
                    schema: None,
                    object_type: "alias".to_string(),
                    related_table: alias
                        .get("collection_name")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    definition: None,
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
        let collection = self.target_collection(table, database)?;
        let schema = self
            .collection_meta(&collection)
            .await?
            .ok_or_else(|| anyhow!("Typesense collection '{collection}' was not found"))?;
        let mut columns = Vec::with_capacity(schema.fields.len() + 1);
        // `id` is implicit in every document and doubles as the row selector.
        columns.push(ColumnDetail {
            name: "id".to_string(),
            data_type: "string".to_string(),
            is_nullable: false,
            is_primary_key: true,
            default_value: None,
            extra: Some("document id".to_string()),
            column_type: Some("string".to_string()),
            comment: None,
        });
        for field in &schema.fields {
            if field.name == "id" {
                continue;
            }
            let mut hints = Vec::new();
            if field.facet {
                hints.push("facet");
            }
            if field.sort {
                hints.push("sortable");
            }
            if !field.is_indexed() {
                hints.push("not indexed");
            }
            columns.push(ColumnDetail {
                name: field.name.clone(),
                data_type: field.field_type.clone(),
                is_nullable: field.optional,
                is_primary_key: false,
                default_value: None,
                extra: if hints.is_empty() {
                    None
                } else {
                    Some(hints.join(", "))
                },
                column_type: Some(field.field_type.clone()),
                comment: None,
            });
        }
        // Every indexed field participates in the search index; present them
        // as the closest index metadata the engine actually has.
        let indexes = schema
            .fields
            .iter()
            .filter(|field| field.is_indexed() && field.name != "id")
            .map(|field| IndexInfo {
                name: format!("{} (search index)", field.name),
                columns: vec![field.name.clone()],
                is_unique: false,
                index_type: Some("inverted".to_string()),
            })
            .collect();
        Ok(TableStructure {
            columns,
            indexes,
            foreign_keys: Vec::new(),
            triggers: Vec::new(),
            view_definition: None,
            object_type: Some("collection".to_string()),
        })
    }

    async fn execute_query(&self, sql: &str) -> Result<QueryResult> {
        self.execute_query_inner(sql, None).await
    }

    /// Request-scoped execution mirrors the OpenSearch pattern: a shared slot
    /// resolves the cancel race before the HTTP request leaves. Typesense has
    /// no server-side task to kill mid-flight, so cancel only covers the
    /// pre-send window and the between-statement checks.
    async fn execute_query_for_request(&self, request_id: &str, sql: &str) -> Result<QueryResult> {
        if request_id.trim().is_empty() {
            return self.execute_query(sql).await;
        }
        let guard = CancelScopeGuard::begin(&self.cancel_registry, request_id);
        // There is no backend id to register; a marker only resolves the
        // pending-cancel race so `cancel_query_request` reports Pending.
        if guard.register_backend(0) {
            return Err(anyhow!("Query cancelled."));
        }
        let flag = guard.cancel_flag();
        let result = self.execute_query_inner(sql, flag).await;
        drop(guard);
        result
    }

    /// Client-side abort only: pre-send cancels are honoured through the
    /// registry, but Typesense offers no endpoint to kill a running search.
    async fn cancel_query_request(&self, request_id: &str) -> Result<bool> {
        match request_cancel(&self.cancel_registry, request_id) {
            CancelLookup::NotRunning => Ok(false),
            CancelLookup::Pending | CancelLookup::Backend(_) => Ok(true),
        }
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
        let collection = self.target_collection(table, database)?;
        let filter_by = Self::raw_filter_by(filter)?;
        let mut spec = SearchSpec {
            collection,
            q: "*".to_string(),
            limit: limit.clamp(1, MAX_TABLE_PAGE_ROWS),
            offset,
            ..SearchSpec::default()
        };
        if let Some(field) = order_by.map(str::trim).filter(|value| !value.is_empty()) {
            let dir = match order_dir {
                Some(dir) if dir.eq_ignore_ascii_case("desc") => "desc",
                _ => "asc",
            };
            spec.sort_by.push((field.to_string(), dir.to_string()));
        }
        let schema = self
            .collection_meta(&spec.collection)
            .await?
            .ok_or_else(|| anyhow!("Typesense collection '{}' was not found", spec.collection))?;
        let mut params = Self::build_search_params(&schema, &spec)?;
        if let Some(filter_by) = filter_by {
            params.insert("filter_by".to_string(), Value::String(filter_by));
        }
        let started = Instant::now();
        let (docs, found) = self
            .search_paged(params, spec.offset, spec.limit, "browse")
            .await?;
        let truncated = found > spec.offset as i64 + docs.len() as i64;
        Ok(Self::docs_to_result(
            docs,
            Some(&schema),
            started.elapsed().as_millis(),
            format!("Browse collection {}", spec.collection),
            truncated,
        ))
    }

    async fn count_rows(&self, table: &str, database: Option<&str>) -> Result<i64> {
        let collection = self.target_collection(table, database)?;
        let schema = self
            .collection_meta(&collection)
            .await?
            .ok_or_else(|| anyhow!("Typesense collection '{collection}' was not found"))?;
        Ok(schema.num_documents)
    }

    /// Typesense has no NULL storage — optional fields are absent from the
    /// document — so a missing-field count cannot be produced server-side.
    async fn count_null_values(
        &self,
        _table: &str,
        _database: Option<&str>,
        _column: &str,
    ) -> Result<i64> {
        Err(anyhow!(
            "Typesense cannot count NULL values: optional fields are omitted from documents rather than stored as NULL"
        ))
    }

    /// Partial update via `PATCH /collections/{c}/documents/{id}` — a merge
    /// patch keyed by the field name; the `id` selector identifies the row.
    async fn update_table_cell(&self, request: &TableCellUpdateRequest) -> Result<u64> {
        let (collection, doc_id) = self.document_target(
            &request.table,
            request.database.as_deref(),
            &request.primary_keys,
        )?;
        if request.target_column == "id" {
            return Err(anyhow!("Typesense document ids are immutable"));
        }
        if request.value.is_null() {
            return Err(anyhow!(
                "Typesense cannot clear a field via PATCH — set an explicit value instead"
            ));
        }
        let field = Self::validate_field_name(&request.target_column)?;
        let mut patch = Map::new();
        patch.insert(field.to_string(), request.value.clone());
        self.send_json(
            Method::PATCH,
            &format!("/collections/{collection}/documents/{doc_id}"),
            &[],
            Some(&Value::Object(patch)),
        )
        .await?;
        Ok(1)
    }

    /// Deletes each selected document via `DELETE .../documents/{id}`; the
    /// `id` selector column carries the document id. A mid-batch failure
    /// leaves earlier rows deleted and surfaces the error (no transactions).
    async fn delete_table_rows(&self, request: &TableRowDeleteRequest) -> Result<u64> {
        if request.rows.is_empty() {
            return Err(anyhow!("Deleting rows requires at least one selected row"));
        }
        let mut deleted = 0u64;
        for row in &request.rows {
            let (collection, doc_id) =
                self.document_target(&request.table, request.database.as_deref(), row)?;
            self.send_json(
                Method::DELETE,
                &format!("/collections/{collection}/documents/{doc_id}"),
                &[],
                None,
            )
            .await?;
            deleted += 1;
        }
        Ok(deleted)
    }

    /// Inserts one document via `POST /collections/{c}/documents`; an `id`
    /// value in the row becomes the document id, otherwise the server
    /// assigns one for schemas that allow implicit ids.
    async fn insert_table_row(&self, request: &TableRowInsertRequest) -> Result<u64> {
        let collection = self.target_collection(&request.table, request.database.as_deref())?;
        let mut doc = Map::new();
        for (column, value) in &request.values {
            if column == "id" {
                let id = value
                    .as_str()
                    .ok_or_else(|| anyhow!("Typesense document ids must be strings"))?;
                Self::validate_doc_id(id)?;
                doc.insert("id".to_string(), Value::String(id.to_string()));
                continue;
            }
            Self::validate_field_name(column)?;
            if !value.is_null() {
                doc.insert(column.clone(), value.clone());
            }
        }
        self.send_json(
            Method::POST,
            &format!("/collections/{collection}/documents"),
            &[],
            Some(&Value::Object(doc)),
        )
        .await?;
        Ok(1)
    }

    /// Batch CSV import through `POST .../documents/import?action=emplace`.
    ///
    /// HONEST CONTRACT: the endpoint is a per-line JSONL pipeline, NOT a
    /// transaction — a failure leaves the lines the server already accepted
    /// applied. This is why the capability profile marks `atomic_csv_import`
    /// as Limited rather than Supported. Cancellation is honoured before the
    /// single request is sent; an in-flight import cannot be rolled back.
    async fn insert_table_rows_atomically(
        &self,
        requests: &[TableRowInsertRequest],
        cancelled: Arc<AtomicBool>,
    ) -> Result<u64> {
        if requests.is_empty() {
            return Err(anyhow!("CSV import requires at least one row"));
        }
        if requests.len() > MAX_IMPORT_LINES {
            return Err(anyhow!(
                "CSV import exceeds the {}-document batch limit for one Typesense import",
                MAX_IMPORT_LINES
            ));
        }
        // One collection per batch: a mixed-table import would split into
        // per-collection calls, weakening the already non-transactional batch.
        let collection =
            self.target_collection(&requests[0].table, requests[0].database.as_deref())?;
        for request in requests {
            let target = self.target_collection(&request.table, request.database.as_deref())?;
            if target != collection {
                return Err(anyhow!(
                    "Typesense CSV import requires all rows to target one collection"
                ));
            }
        }

        let mut lines = Vec::with_capacity(requests.len());
        let mut bytes = 0usize;
        for request in requests {
            if cancelled.load(Ordering::Relaxed) {
                return Err(anyhow!("CSV import cancelled before any document was sent"));
            }
            let mut doc = Map::new();
            for (column, value) in &request.values {
                if column == "id" {
                    let id = value
                        .as_str()
                        .ok_or_else(|| anyhow!("Typesense document ids must be strings"))?;
                    Self::validate_doc_id(id)?;
                    doc.insert("id".to_string(), Value::String(id.to_string()));
                    continue;
                }
                Self::validate_field_name(column)?;
                if !value.is_null() {
                    doc.insert(column.clone(), value.clone());
                }
            }
            let line = serde_json::to_string(&Value::Object(doc))?;
            bytes += line.len() + 1;
            if bytes > MAX_IMPORT_BYTES {
                return Err(anyhow!(
                    "CSV import exceeds the {} MiB Typesense batch limit",
                    MAX_IMPORT_BYTES / 1024 / 1024
                ));
            }
            lines.push(line);
        }
        if cancelled.load(Ordering::Relaxed) {
            return Err(anyhow!("CSV import cancelled before any document was sent"));
        }
        self.import_jsonl(&collection, &lines, "emplace").await
    }

    /// Streaming import buffers rows and flushes one batch — the same honesty
    /// caveat as `insert_table_rows_atomically` applies: nothing is written
    /// until the single import request fires, but a mid-batch server failure
    /// leaves earlier lines applied (surfaced in the error message).
    async fn insert_table_row_stream_atomically(
        &self,
        mut rows: tokio::sync::mpsc::Receiver<CsvImportRow>,
        cancelled: Arc<AtomicBool>,
    ) -> Result<u64> {
        let mut requests = Vec::new();
        while let Some(row) = rows.recv().await {
            if cancelled.load(Ordering::Relaxed) {
                return Err(anyhow!("CSV import cancelled before any document was sent"));
            }
            requests.push(row.map_err(anyhow::Error::msg)?);
            if requests.len() > MAX_IMPORT_LINES {
                return Err(anyhow!(
                    "CSV import exceeds the {}-document batch limit; \
                     Typesense cannot split it into multiple best-effort batches atomically",
                    MAX_IMPORT_LINES
                ));
            }
        }
        self.insert_table_rows_atomically(&requests, cancelled)
            .await
    }

    /// Export path: unordered exports stream `GET .../documents/export` JSONL
    /// (a single bounded response with no `query_by` requirement — it works
    /// even when a collection has no searchable string fields); ORDERED
    /// exports fall back to `multi_search` pages because the export endpoint
    /// ignores sort order. `filter` is a verbatim `filter_by` expression.
    fn export_table_rows<'a>(
        &'a self,
        table: &'a str,
        database: Option<&'a str>,
        batch_size: u64,
        order_by: Option<&'a str>,
        order_dir: Option<&'a str>,
        filter: Option<&'a str>,
    ) -> Pin<Box<dyn Stream<Item = Result<QueryResult>> + Send + 'a>> {
        let batch_size = batch_size.clamp(1, TYPESENSE_MAX_PAGE);
        let setup = async move {
            let collection = self.target_collection(table, database)?;
            let schema = self
                .collection_meta(&collection)
                .await?
                .ok_or_else(|| anyhow!("Typesense collection '{collection}' was not found"))?;
            let filter_by = Self::raw_filter_by(filter)?;
            let sort = match order_by.map(str::trim).filter(|value| !value.is_empty()) {
                Some(field) => {
                    Self::validate_sort_field(field)?;
                    let dir = match order_dir {
                        Some(dir) if dir.eq_ignore_ascii_case("desc") => "desc",
                        _ => "asc",
                    };
                    Some(format!("{field}:{dir}"))
                }
                None => None,
            };
            Ok::<_, anyhow::Error>((collection, schema, filter_by, sort))
        };

        stream::once(setup)
            .map_ok(move |(collection, schema, filter_by, sort)| {
                match sort {
                    None => {
                        // Unordered: one JSONL export read re-chunked into the
                        // caller's batch size.
                        stream::try_unfold(
                            (VecDeque::<Map<String, Value>>::new(), false),
                            move |(mut buffer, fetched)| {
                                // Clone into the future — an FnMut closure
                                // cannot lend its captures to an async block.
                                let collection = collection.clone();
                                let schema = schema.clone();
                                let filter_by = filter_by.clone();
                                async move {
                                    if buffer.is_empty() {
                                        if fetched {
                                            return Ok(None);
                                        }
                                        buffer = self
                                            .export_docs_jsonl(&collection, filter_by)
                                            .await?
                                            .into();
                                        if buffer.is_empty() {
                                            return Ok(None);
                                        }
                                    }
                                    let take = buffer.len().min(batch_size as usize);
                                    let chunk: Vec<Map<String, Value>> =
                                        buffer.drain(..take).collect();
                                    let result = Self::docs_to_result(
                                        chunk,
                                        Some(&schema),
                                        0,
                                        format!("Export collection {collection}"),
                                        false,
                                    );
                                    Ok(Some((result, (buffer, true))))
                                }
                            },
                        )
                        .boxed()
                    }
                    Some(sort) => {
                        // Ordered: page through multi_search; each page is one
                        // batch. The found-count cross-check catches gaps.
                        stream::try_unfold(
                            (1_u64, collection, schema, filter_by),
                            move |(page, collection, schema, filter_by)| {
                                let sort = sort.clone();
                                async move {
                                    let spec = SearchSpec {
                                        collection: collection.clone(),
                                        q: "*".to_string(),
                                        ..SearchSpec::default()
                                    };
                                    let mut params = Self::build_search_params(&schema, &spec)?;
                                    if let Some(filter_by) = filter_by.clone() {
                                        params.insert(
                                            "filter_by".to_string(),
                                            Value::String(filter_by),
                                        );
                                    }
                                    params.insert("sort_by".to_string(), Value::String(sort));
                                    let (docs, _found) = self
                                        .search_paged(
                                            params,
                                            (page - 1) * batch_size,
                                            batch_size,
                                            "export",
                                        )
                                        .await?;
                                    if docs.is_empty() {
                                        return Ok(None);
                                    }
                                    let result = Self::docs_to_result(
                                        docs,
                                        Some(&schema),
                                        0,
                                        format!("Export collection {collection}"),
                                        false,
                                    );
                                    Ok(Some((result, (page + 1, collection, schema, filter_by))))
                                }
                            },
                        )
                        .boxed()
                    }
                }
            })
            .try_flatten()
            .boxed()
    }

    async fn use_database(&self, database: &str) -> Result<()> {
        let collection = Self::validate_collection_name(database)?.to_string();
        *self
            .current_collection
            .write()
            .map_err(|_| anyhow!("Typesense driver state is unavailable"))? = Some(collection);
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
        // Typesense has no foreign keys; collection references are stored
        // client-side only.
        Ok(Vec::new())
    }

    fn current_database(&self) -> Option<String> {
        self.current_collection
            .read()
            .ok()
            .and_then(|value| value.clone())
    }

    fn driver_name(&self) -> &str {
        "typesense"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> SearchSpec {
        SearchSpec {
            collection: "books".to_string(),
            q: "*".to_string(),
            limit: 10,
            ..SearchSpec::default()
        }
    }

    fn schema() -> TypesenseCollection {
        serde_json::from_value(json!({
            "name": "books",
            "num_documents": 3,
            "fields": [
                { "name": "title", "type": "string" },
                { "name": "authors", "type": "string[]", "facet": true },
                { "name": "year", "type": "int32", "sort": true },
                { "name": "price", "type": "float", "optional": true },
                { "name": "blob", "type": "object", "index": false }
            ]
        }))
        .unwrap()
    }

    #[test]
    fn search_params_carry_typed_values_not_interpolated_text() {
        let mut spec = spec();
        spec.predicates = vec![TypesensePredicate {
            field: "year".to_string(),
            kind: PredicateKind::Ge,
            values: vec![json!(2000)],
            negated: false,
        }];
        let params = TypesenseDriver::build_search_params(&schema(), &spec).unwrap();
        assert_eq!(params["collection"], json!("books"));
        assert_eq!(params["q"], json!("*"));
        // query_by is derived from the schema's searchable string fields.
        assert_eq!(params["query_by"], json!("title,authors"));
        // filter_by is the only string-shaped fragment; its operands are
        // compiled literals, not raw SQL text.
        assert_eq!(params["filter_by"], json!("year:>=2000"));
        assert!(!params.contains_key("page"));
    }

    #[test]
    fn filter_operands_are_compiled_not_spliced() {
        // A string containing injection-looking text stays inside one
        // backtick-quoted operand.
        let predicates = vec![
            TypesensePredicate {
                field: "title".to_string(),
                kind: PredicateKind::Eq,
                values: vec![json!("x) && year:>0 || true")],
                negated: false,
            },
            TypesensePredicate {
                field: "year".to_string(),
                kind: PredicateKind::In,
                values: vec![json!(2001), json!(2002)],
                negated: false,
            },
            TypesensePredicate {
                field: "price".to_string(),
                kind: PredicateKind::Between,
                values: vec![json!(10), json!(20)],
                negated: false,
            },
            TypesensePredicate {
                field: "year".to_string(),
                kind: PredicateKind::Eq,
                values: vec![json!(1999)],
                negated: true,
            },
        ];
        let filter = compile_filter_by(&predicates).unwrap();
        assert_eq!(
            filter,
            "title:=`x) && year:>0 || true` && year:=[2001,2002] \
             && price:>=10 && price:<=20 && year:!=1999"
        );
        // Backticks inside string literals cannot be escaped → rejected.
        let bad = vec![TypesensePredicate {
            field: "title".to_string(),
            kind: PredicateKind::Eq,
            values: vec![json!("a`b")],
            negated: false,
        }];
        assert!(compile_filter_by(&bad).is_err());
    }

    #[test]
    fn parser_maps_select_and_search_to_search_specs() {
        let parsed = parse_statement(
            "SELECT title, year FROM books WHERE year >= 2000 AND authors IN ('a','b') \
             ORDER BY year DESC LIMIT 25 OFFSET 5",
        )
        .unwrap();
        let TypesenseStatement::Search(spec) = parsed else {
            panic!("expected a search statement");
        };
        assert_eq!(spec.collection, "books");
        assert_eq!(spec.q, "*");
        assert_eq!(spec.include_fields, vec!["title", "year"]);
        assert_eq!(spec.predicates.len(), 2);
        assert_eq!(spec.predicates[0].kind, PredicateKind::Ge);
        assert_eq!(spec.predicates[1].kind, PredicateKind::In);
        assert_eq!(spec.sort_by, vec![("year".to_string(), "desc".to_string())]);
        assert_eq!(spec.limit, 25);
        assert_eq!(spec.offset, 5);

        // `year:>=2000` is Typesense-native filter syntax, not the SQL
        // subset — the parser must reject it instead of mishandling it.
        assert!(parse_statement(
            "SEARCH books FOR 'harry potter' BY title WHERE year:>=2000 LIMIT 10"
        )
        .is_err());

        let parsed =
            parse_statement("SEARCH books FOR 'harry potter' BY title WHERE year >= 2000").unwrap();
        let TypesenseStatement::Search(spec) = parsed else {
            panic!("expected a search statement");
        };
        assert_eq!(spec.q, "harry potter");
        assert_eq!(spec.query_by, vec!["title"]);
        assert_eq!(spec.predicates.len(), 1);

        // NOT and NOT IN compile to the negated operators.
        let parsed = parse_statement("SELECT * FROM books WHERE year NOT IN (2000, 2001)").unwrap();
        let TypesenseStatement::Search(spec) = parsed else {
            panic!("expected a search statement");
        };
        let filter = compile_filter_by(&spec.predicates).unwrap();
        assert_eq!(filter, "year:!=[2000,2001]");
    }

    #[test]
    fn parser_rejects_out_of_subset_constructs() {
        // OR / LIKE / IS NULL / aggregates / aliases all fail loudly.
        assert!(parse_statement("SELECT * FROM books WHERE year = 2000 OR year = 2001").is_err());
        assert!(parse_statement("SELECT * FROM books WHERE title LIKE 'harry'").is_err());
        assert!(parse_statement("SELECT * FROM books WHERE price IS NULL").is_err());
        assert!(parse_statement("SELECT COUNT(*) FROM books").is_err());
        assert!(parse_statement("SELECT b.title FROM books b").is_err());
        assert!(parse_statement("DROP TABLE").is_err());
        assert!(parse_statement("GRANT SELECT ON books TO x").is_err());
        // UPDATE without WHERE cannot resolve a document id.
        assert!(parse_statement("UPDATE books SET year = 2001").is_err());
        // Keywords are never usable as identifiers.
        assert!(parse_statement("SELECT FROM FROM books").is_err());
    }

    #[test]
    fn parser_maps_writes_and_ddl() {
        let parsed =
            parse_statement("UPDATE books SET year = 2001, price = 9.99 WHERE id = '42'").unwrap();
        let TypesenseStatement::Update {
            collection,
            doc_id,
            assignments,
        } = parsed
        else {
            panic!("expected update");
        };
        assert_eq!(collection, "books");
        assert_eq!(doc_id, "42");
        assert_eq!(assignments.len(), 2);

        let parsed = parse_statement("DELETE FROM books WHERE id = '42'").unwrap();
        assert!(matches!(parsed, TypesenseStatement::DeleteById { .. }));

        let parsed = parse_statement("DELETE FROM books WHERE year < 1970").unwrap();
        assert!(matches!(parsed, TypesenseStatement::DeleteByFilter { .. }));

        let parsed = parse_statement(
            "INSERT INTO books (id, title, year) VALUES ('1', 'Dune', 1965), ('2', 'Emma', 1815)",
        )
        .unwrap();
        let TypesenseStatement::Insert { documents, .. } = parsed else {
            panic!("expected insert");
        };
        assert_eq!(documents.len(), 2);
        assert_eq!(documents[0]["id"], json!("1"));

        let parsed = parse_statement(
            "CREATE TABLE books (title STRING, year INT32 OPTIONAL FACET SORT, \
             ratings FLOAT[] NO INDEX)",
        )
        .unwrap();
        let TypesenseStatement::CreateCollection { name, fields, .. } = parsed else {
            panic!("expected create");
        };
        assert_eq!(name, "books");
        assert_eq!(fields.len(), 3);
        assert_eq!(fields[1].field_type, "int32");
        assert!(fields[1].optional && fields[1].facet && fields[1].sort);
        assert_eq!(fields[2].field_type, "float[]");
        assert!(!fields[2].index);
        // The JSON payload is assembled from typed fields, not raw text.
        let payload = field_spec_json(&fields[1]);
        assert_eq!(
            payload,
            json!({
                "name": "year", "type": "int32",
                "optional": true, "facet": true, "sort": true
            })
        );

        let parsed =
            parse_statement("ALTER TABLE books ADD COLUMN summary STRING OPTIONAL").unwrap();
        assert!(matches!(parsed, TypesenseStatement::AlterCollection { .. }));
        let parsed = parse_statement("DROP TABLE IF EXISTS books").unwrap();
        let TypesenseStatement::DropCollection { if_exists, .. } = parsed else {
            panic!("expected drop");
        };
        assert!(if_exists);
    }

    #[test]
    fn field_and_collection_validation_rejects_path_escape() {
        assert!(TypesenseDriver::validate_collection_name("books").is_ok());
        assert!(TypesenseDriver::validate_collection_name("../health").is_err());
        assert!(TypesenseDriver::validate_collection_name("a/b").is_err());
        assert!(TypesenseDriver::validate_field_name("title").is_ok());
        assert!(TypesenseDriver::validate_field_name("meta.score").is_ok());
        assert!(TypesenseDriver::validate_field_name("_text_match").is_err());
        assert_eq!(
            TypesenseDriver::validate_sort_field("_text_match").unwrap(),
            "_text_match"
        );
        assert!(TypesenseDriver::validate_field_name("a b").is_err());
        assert!(TypesenseDriver::validate_doc_id("doc-1").is_ok());
        assert!(TypesenseDriver::validate_doc_id("a/b").is_err());
        assert!(TypesenseDriver::validate_doc_id("a%2fb").is_err());
    }

    #[test]
    fn sql_types_map_to_typesense_types() {
        assert_eq!(map_sql_type("string").unwrap(), "string");
        assert_eq!(map_sql_type("INT[]").unwrap(), "int32[]");
        assert_eq!(map_sql_type("varchar").unwrap(), "string");
        assert_eq!(map_sql_type("bigint").unwrap(), "int64");
        assert_eq!(map_sql_type("BOOLEAN").unwrap(), "bool");
        assert_eq!(map_sql_type("string ARRAY").unwrap(), "string[]");
        assert!(map_sql_type("timestamp").is_err());
        assert!(map_sql_type("uuid").is_err());
    }

    #[test]
    fn update_and_delete_require_an_id_selector() {
        assert_eq!(
            TypesenseDriver::doc_id_from_predicates(&[TypesensePredicate {
                field: "id".to_string(),
                kind: PredicateKind::Eq,
                values: vec![json!("42")],
                negated: false,
            }])
            .unwrap(),
            "42"
        );
        // Non-id or multi-predicate selectors cannot resolve a document.
        assert!(
            TypesenseDriver::doc_id_from_predicates(&[TypesensePredicate {
                field: "year".to_string(),
                kind: PredicateKind::Eq,
                values: vec![json!(2000)],
                negated: false,
            }])
            .is_err()
        );
    }
}
