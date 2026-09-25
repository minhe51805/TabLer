use super::driver::DatabaseDriver;
use super::models::*;
use super::parameterized_query::{compile_parameterized_query, PlaceholderStyle};
use super::query_cancel::{request_cancel, CancelLookup, CancelScopeGuard, QueryCancelRegistry};
use anyhow::{anyhow, Result};
use async_trait::async_trait;
use futures_util::{stream, Stream, StreamExt, TryStreamExt};
use reqwest::{Client, Method, StatusCode, Url};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

const MAX_REQUEST_BYTES: usize = 256 * 1024;
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const MAX_RESULT_ROWS: u64 = 500;
const MAX_PEM_BYTES: u64 = 1024 * 1024;
/// Row identity column. Weaviate object ids are uuids assigned at insert;
/// the grid surfaces them as `_id` and pk selectors map back to the uuid.
const ID_COLUMN: &str = "_id";

/// TableR driver for Weaviate (v1 REST + GraphQL, default port 8080).
///
/// Mapping decisions:
/// - Tables are schema classes (`GET /v1/schema`); columns are class
///   `properties` plus a synthetic `_id` column carrying the object uuid.
/// - Reads go through `GET /v1/objects` (offset paging) when unfiltered and
///   through `POST /v1/graphql` `Get { <Class>(...) }` when the grid filter or
///   the SQL `WHERE` subset needs a `where:` argument. `sort` arguments
///   require Weaviate 1.24+; older servers return the GraphQL error as-is.
/// - The SQL editor accepts a documented SELECT subset —
///   `SELECT <fields|*> FROM <class> [WHERE <and/or of field op literal>]
///   [ORDER BY <field> [ASC|DESC]] [LIMIT n] [OFFSET n]` — compiled to GraphQL
///   `Get`. `NOT` is rejected: Weaviate filters only support `And`/`Or`
///   operand groups and there is no `NotLike`/`NotContainsAny` leaf operator.
///   `CREATE/DROP/ALTER TABLE` map to the `/v1/schema` endpoints; `GET
///   /v1/...` runs read-only REST requests.
/// - There is no transaction primitive anywhere in the API: atomic edit
///   queues and CSV imports are rejected, and `POST /v1/batch/objects` is
///   deliberately not used because it reports per-object results instead of
///   an all-or-nothing commit.
pub struct WeaviateDriver {
    client: Client,
    base_url: Url,
    /// Optional API key (`password` field or `api_key`/`apiKey` additional
    /// field) sent as `Authorization: Bearer <key>`. OIDC flows that need a
    /// refresh grant are out of scope for the REST driver.
    api_key: Option<String>,
    /// request_id → running-query scope. Weaviate cannot kill a running
    /// request server-side; cancel releases the UI and aborts the in-flight
    /// HTTP response stream between chunks.
    cancel_registry: RwLock<QueryCancelRegistry>,
}

#[derive(Debug, Clone, PartialEq)]
enum Scalar {
    Text(String),
    Int(i64),
    Float(f64),
    Bool(bool),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CmpOp {
    Equal,
    NotEqual,
    LessThan,
    LessThanEqual,
    GreaterThan,
    GreaterThanEqual,
}

impl CmpOp {
    fn graphql(self) -> &'static str {
        match self {
            Self::Equal => "Equal",
            Self::NotEqual => "NotEqual",
            Self::LessThan => "LessThan",
            Self::LessThanEqual => "LessThanEqual",
            Self::GreaterThan => "GreaterThan",
            Self::GreaterThanEqual => "GreaterThanEqual",
        }
    }
}

#[derive(Debug, Clone)]
enum Filter {
    And(Vec<Filter>),
    Or(Vec<Filter>),
    Compare {
        path: String,
        op: CmpOp,
        value: Scalar,
    },
    Like {
        path: String,
        pattern: String,
    },
    In {
        path: String,
        values: Vec<Scalar>,
    },
    IsNull {
        path: String,
        is_null: bool,
    },
}

#[derive(Debug, Clone)]
struct SelectQuery {
    class: String,
    /// `None` = `SELECT *` (fields resolved from the class schema).
    fields: Option<Vec<String>>,
    filter: Option<Filter>,
    order: Vec<(String, bool)>,
    limit: Option<u64>,
    offset: u64,
}

#[derive(Debug, Clone)]
enum SchemaStatement {
    Create {
        class: String,
        properties: Vec<(String, String)>,
    },
    Drop {
        class: String,
        if_exists: bool,
    },
    AddProperty {
        class: String,
        name: String,
        data_type: String,
    },
    DropProperty {
        class: String,
        name: String,
    },
}

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Ident(String),
    Str(String),
    Int(i64),
    Float(f64),
    Param,
    Star,
    Comma,
    LParen,
    RParen,
    ArraySuffix,
    Eq,
    NotEq,
    Lt,
    LtEq,
    Gt,
    GtEq,
}

/// Parser over the token stream. `binds` are the positional `?` values
/// supplied by `execute_parameterized_query`; the parser consumes them in
/// order and `execute_select` rejects leftover bindings.
struct Parser<'a> {
    tokens: &'a [Token],
    pos: usize,
    binds: &'a [QueryParameter],
    bind_pos: usize,
}

impl<'a> Parser<'a> {
    fn new(tokens: &'a [Token], binds: Option<&'a [QueryParameter]>) -> Self {
        Self {
            tokens,
            pos: 0,
            binds: binds.unwrap_or(&[]),
            bind_pos: 0,
        }
    }

    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.pos)
    }

    fn next(&mut self) -> Option<&Token> {
        let token = self.tokens.get(self.pos);
        self.pos += usize::from(token.is_some());
        token
    }

    fn peek_keyword(&self, keyword: &str) -> bool {
        matches!(
            self.peek(),
            Some(Token::Ident(word)) if word.eq_ignore_ascii_case(keyword)
        )
    }

    fn eat_keyword(&mut self, keyword: &str) -> bool {
        if self.peek_keyword(keyword) {
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
            Err(anyhow!("Weaviate query expected '{keyword}'"))
        }
    }

    fn expect_ident(&mut self, what: &str) -> Result<String> {
        match self.next() {
            Some(Token::Ident(name)) => Ok(name.clone()),
            _ => Err(anyhow!("Weaviate query expected {what}")),
        }
    }

    fn expect_count(&mut self, what: &str) -> Result<u64> {
        match self.next() {
            Some(Token::Int(value)) if *value >= 0 => Ok(*value as u64),
            _ => Err(anyhow!("Weaviate query expected {what}")),
        }
    }

    fn expect_end(&self) -> Result<()> {
        if self.pos == self.tokens.len() {
            Ok(())
        } else {
            Err(anyhow!("Weaviate query has trailing tokens"))
        }
    }

    /// `SELECT <fields|*> FROM <class> [WHERE ...] [ORDER BY f [ASC|DESC], ...]
    /// [LIMIT n] [OFFSET n]` — the documented GraphQL-mapping subset.
    fn parse_select(&mut self) -> Result<SelectQuery> {
        self.expect_keyword("select")?;
        let fields = if matches!(self.peek(), Some(Token::Star)) {
            self.pos += 1;
            None
        } else {
            let mut names = vec![self.expect_ident("a field name")?];
            while matches!(self.peek(), Some(Token::Comma)) {
                self.pos += 1;
                names.push(self.expect_ident("a field name")?);
            }
            Some(names)
        };
        self.expect_keyword("from")?;
        let class = self.expect_ident("a class name")?;

        let mut query = SelectQuery {
            class,
            fields,
            filter: None,
            order: Vec::new(),
            limit: None,
            offset: 0,
        };
        loop {
            if self.eat_keyword("where") {
                query.filter = Some(self.parse_or()?);
            } else if self.eat_keyword("order") {
                self.expect_keyword("by")?;
                loop {
                    let path = self.expect_ident("a sort field")?;
                    let desc = if self.eat_keyword("desc") {
                        true
                    } else {
                        self.eat_keyword("asc");
                        false
                    };
                    query.order.push((path, desc));
                    if !matches!(self.peek(), Some(Token::Comma)) {
                        break;
                    }
                    self.pos += 1;
                }
            } else if self.eat_keyword("limit") {
                query.limit = Some(self.expect_count("a LIMIT value")?);
            } else if self.eat_keyword("offset") {
                query.offset = self.expect_count("an OFFSET value")?;
            } else {
                break;
            }
        }
        self.expect_end()?;
        Ok(query)
    }

    fn parse_or(&mut self) -> Result<Filter> {
        let mut parts = vec![self.parse_and()?];
        while self.eat_keyword("or") {
            parts.push(self.parse_and()?);
        }
        Ok(if parts.len() == 1 {
            parts.pop().unwrap()
        } else {
            Filter::Or(parts)
        })
    }

    fn parse_and(&mut self) -> Result<Filter> {
        let mut parts = vec![self.parse_operand()?];
        while self.eat_keyword("and") {
            parts.push(self.parse_operand()?);
        }
        Ok(if parts.len() == 1 {
            parts.pop().unwrap()
        } else {
            Filter::And(parts)
        })
    }

    fn parse_operand(&mut self) -> Result<Filter> {
        if self.peek_keyword("not") {
            // Weaviate where groups support And/Or only; there is no Not
            // operator and no NotLike/NotContainsAny leaf. `IS NOT NULL` is
            // handled inside the predicate, `!=` covers negated equality.
            return Err(anyhow!(
                "Weaviate filters do not support NOT; use != or IS NOT NULL"
            ));
        }
        if matches!(self.peek(), Some(Token::LParen)) {
            self.pos += 1;
            let inner = self.parse_or()?;
            match self.next() {
                Some(Token::RParen) => return Ok(inner),
                _ => return Err(anyhow!("Weaviate query expected ')'")),
            }
        }
        self.parse_predicate()
    }

    /// Field path for filters. The synthetic `_id` column maps to the object
    /// `id` path Weaviate filters on; everything else is a property name.
    fn filter_path(&mut self) -> Result<String> {
        let raw = self.expect_ident("a field name")?;
        if raw == ID_COLUMN {
            return Ok("id".to_string());
        }
        Ok(WeaviateDriver::validate_property(&raw)?.to_string())
    }

    fn parse_predicate(&mut self) -> Result<Filter> {
        let path = self.filter_path()?;
        if self.eat_keyword("is") {
            let negated = self.eat_keyword("not");
            self.expect_keyword("null")?;
            return Ok(Filter::IsNull {
                path,
                is_null: !negated,
            });
        }
        if self.eat_keyword("like") {
            return Ok(Filter::Like {
                path,
                pattern: self.parse_text_scalar()?,
            });
        }
        if self.eat_keyword("in") {
            match self.next() {
                Some(Token::LParen) => {}
                _ => return Err(anyhow!("Weaviate query expected '(' after IN")),
            }
            let mut values = vec![self.parse_scalar()?];
            while matches!(self.peek(), Some(Token::Comma)) {
                self.pos += 1;
                values.push(self.parse_scalar()?);
            }
            match self.next() {
                Some(Token::RParen) => {}
                _ => return Err(anyhow!("Weaviate query expected ')' after IN list")),
            }
            // Validate the array operand eagerly so a mixed-type list fails
            // here instead of reaching the GraphQL compiler.
            WeaviateDriver::scalar_array_binding(&values)?;
            return Ok(Filter::In { path, values });
        }
        if self.peek_keyword("not") {
            return Err(anyhow!("Weaviate filters do not support NOT LIKE / NOT IN"));
        }
        let op = match self.next() {
            Some(Token::Eq) => CmpOp::Equal,
            Some(Token::NotEq) => CmpOp::NotEqual,
            Some(Token::Lt) => CmpOp::LessThan,
            Some(Token::LtEq) => CmpOp::LessThanEqual,
            Some(Token::Gt) => CmpOp::GreaterThan,
            Some(Token::GtEq) => CmpOp::GreaterThanEqual,
            _ => {
                return Err(anyhow!(
                    "Weaviate query expected a comparison operator after '{path}'"
                ))
            }
        };
        let value = self.parse_scalar()?;
        Ok(Filter::Compare { path, op, value })
    }

    fn parse_text_scalar(&mut self) -> Result<String> {
        match self.parse_scalar()? {
            Scalar::Text(text) => Ok(text),
            _ => Err(anyhow!("Weaviate LIKE requires a string pattern")),
        }
    }

    /// One filter value: a literal, `TRUE`/`FALSE`, or the next `?` bind
    /// value from `execute_parameterized_query`.
    fn parse_scalar(&mut self) -> Result<Scalar> {
        match self.next() {
            Some(Token::Str(value)) => Ok(Scalar::Text(value.clone())),
            Some(Token::Int(value)) => Ok(Scalar::Int(*value)),
            Some(Token::Float(value)) => Ok(Scalar::Float(*value)),
            Some(Token::Ident(word)) if word.eq_ignore_ascii_case("true") => Ok(Scalar::Bool(true)),
            Some(Token::Ident(word)) if word.eq_ignore_ascii_case("false") => {
                Ok(Scalar::Bool(false))
            }
            Some(Token::Ident(word)) if word.eq_ignore_ascii_case("null") => Err(anyhow!(
                "Weaviate comparisons use IS NULL / IS NOT NULL, not = NULL"
            )),
            Some(Token::Param) => {
                let parameter = self.binds.get(self.bind_pos).ok_or_else(|| {
                    anyhow!("Weaviate query has more '?' markers than bound parameters")
                })?;
                self.bind_pos += 1;
                Self::scalar_from_parameter(parameter)
            }
            _ => Err(anyhow!("Weaviate query expected a value")),
        }
    }

    fn scalar_from_parameter(parameter: &QueryParameter) -> Result<Scalar> {
        match &parameter.value {
            Value::String(text) => Ok(Scalar::Text(text.clone())),
            Value::Bool(flag) => Ok(Scalar::Bool(*flag)),
            Value::Number(number) => {
                if let Some(int) = number.as_i64() {
                    Ok(Scalar::Int(int))
                } else if let Some(float) = number.as_f64() {
                    Ok(Scalar::Float(float))
                } else {
                    Err(anyhow!("Weaviate parameter number is out of range"))
                }
            }
            Value::Null => Err(anyhow!(
                "Weaviate parameters cannot be NULL; use IS NULL / IS NOT NULL"
            )),
            _ => Err(anyhow!("Weaviate parameters only bind scalar values")),
        }
    }

    /// `CREATE TABLE|CLASS <name> [(prop type, ...)]` /
    /// `DROP TABLE|CLASS [IF EXISTS] <name>` /
    /// `ALTER TABLE <name> ADD [COLUMN|PROPERTY] <prop> <type>` /
    /// `ALTER TABLE <name> DROP COLUMN|PROPERTY <prop>` — the schema-edit
    /// subset mapped to `/v1/schema` endpoints.
    fn parse_schema_statement(&mut self) -> Result<SchemaStatement> {
        if self.eat_keyword("create") {
            if !(self.eat_keyword("table") || self.eat_keyword("class")) {
                return Err(anyhow!(
                    "Weaviate schema edits support CREATE TABLE <name> (prop type, ...)"
                ));
            }
            let class = self.expect_ident("a class name")?;
            let mut properties = Vec::new();
            if matches!(self.peek(), Some(Token::LParen)) {
                self.pos += 1;
                loop {
                    let name = self.expect_ident("a property name")?;
                    let data_type = self.parse_data_type()?;
                    properties.push((name, data_type));
                    match self.next() {
                        Some(Token::Comma) => continue,
                        Some(Token::RParen) => break,
                        _ => return Err(anyhow!("Weaviate CREATE TABLE expected ',' or ')'")),
                    }
                }
            }
            self.expect_end()?;
            return Ok(SchemaStatement::Create { class, properties });
        }
        if self.eat_keyword("drop") {
            if !(self.eat_keyword("table") || self.eat_keyword("class")) {
                return Err(anyhow!("Weaviate schema edits support DROP TABLE <name>"));
            }
            let if_exists = if self.eat_keyword("if") {
                self.expect_keyword("exists")?;
                true
            } else {
                false
            };
            let class = self.expect_ident("a class name")?;
            self.expect_end()?;
            return Ok(SchemaStatement::Drop { class, if_exists });
        }
        if self.eat_keyword("alter") {
            self.expect_keyword("table")?;
            let class = self.expect_ident("a class name")?;
            if self.eat_keyword("add") {
                // `ADD COLUMN|PROPERTY <name> <type>` and bare
                // `ADD <name> <type>` are both accepted.
                let _ = self.eat_keyword("column") || self.eat_keyword("property");
                let name = self.expect_ident("a property name")?;
                let data_type = self.parse_data_type()?;
                self.expect_end()?;
                return Ok(SchemaStatement::AddProperty {
                    class,
                    name,
                    data_type,
                });
            }
            if self.eat_keyword("drop") {
                if !(self.eat_keyword("column") || self.eat_keyword("property")) {
                    return Err(anyhow!(
                        "Weaviate ALTER TABLE DROP requires COLUMN or PROPERTY"
                    ));
                }
                let name = self.expect_ident("a property name")?;
                self.expect_end()?;
                return Ok(SchemaStatement::DropProperty { class, name });
            }
            return Err(anyhow!(
                "Weaviate ALTER TABLE supports ADD/DROP COLUMN only"
            ));
        }
        Err(anyhow!(
            "Weaviate schema edits support CREATE TABLE, DROP TABLE, and ALTER TABLE ADD/DROP COLUMN"
        ))
    }

    /// SQL type name → Weaviate `dataType` entry. `T[]` or `T ARRAY` map to
    /// Weaviate array types; an optional `(n)` length qualifier is ignored.
    fn parse_data_type(&mut self) -> Result<String> {
        let base = self.expect_ident("a data type")?;
        // Optional length qualifier: `varchar(255)`.
        if matches!(self.peek(), Some(Token::LParen)) {
            self.pos += 1;
            self.expect_count("a length")?;
            match self.next() {
                Some(Token::RParen) => {}
                _ => return Err(anyhow!("Weaviate type length expected ')'")),
            }
        }
        let is_array =
            matches!(self.peek(), Some(Token::ArraySuffix)) || self.peek_keyword("array");
        if is_array {
            self.pos += 1;
        }
        let mapped = match base.to_ascii_lowercase().as_str() {
            "text" | "string" | "varchar" | "char" | "character" => "text",
            "int" | "integer" | "bigint" | "smallint" => "int",
            "number" | "float" | "double" | "decimal" | "real" => "number",
            "bool" | "boolean" => "boolean",
            "date" | "datetime" | "timestamp" => "date",
            "uuid" => "uuid",
            "geocoordinates" | "geo" => "geoCoordinates",
            "phonenumber" | "phone" => "phoneNumber",
            "blob" => "blob",
            "object" => "object",
            other => {
                return Err(anyhow!(
                    "Weaviate type '{other}' is not supported; use text, int, number, boolean, date, uuid, geoCoordinates, phoneNumber, blob, or object"
                ))
            }
        };
        Ok(if is_array {
            format!("{mapped}[]")
        } else {
            mapped.to_string()
        })
    }
}

impl WeaviateDriver {
    fn read_pem(path: &str, label: &str) -> Result<Vec<u8>> {
        let path = Path::new(path);
        let metadata = fs::symlink_metadata(path)
            .map_err(|e| anyhow!("Failed to inspect Weaviate {label}: {e}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(anyhow!("Weaviate {label} must be a regular file"));
        }
        if metadata.len() == 0 || metadata.len() > MAX_PEM_BYTES {
            return Err(anyhow!(
                "Weaviate {label} exceeds the certificate size limit"
            ));
        }
        fs::read(path).map_err(|e| anyhow!("Failed to read Weaviate {label}: {e}"))
    }

    pub async fn connect(config: &ConnectionConfig) -> Result<Self> {
        let host = config
            .host
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow!("Weaviate host is required"))?;
        let tls_enabled = !matches!(config.effective_ssl_mode(), SslMode::Disable);
        let scheme = if tls_enabled { "https" } else { "http" };
        let port = config.port.unwrap_or(if tls_enabled { 443 } else { 8080 });
        let authority_host = if host.contains(':') && !host.starts_with('[') {
            format!("[{host}]")
        } else {
            host.to_string()
        };
        let base_url = Url::parse(&format!("{scheme}://{authority_host}:{port}/"))
            .map_err(|_| anyhow!("Weaviate host or port is invalid"))?;
        if base_url.username() != "" || base_url.password().is_some() {
            return Err(anyhow!(
                "Weaviate credentials cannot be embedded in the host"
            ));
        }
        if let Some(database) = config
            .database
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            if !database.eq_ignore_ascii_case("default") {
                return Err(anyhow!(
                    "Weaviate exposes a single schema; leave the database empty or set it to 'default'"
                ));
            }
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
                    "Weaviate client certificate and key must be configured together"
                ))
            }
        }
        let api_key = config
            .password
            .clone()
            .filter(|value| !value.is_empty())
            .or_else(|| {
                config
                    .additional_fields
                    .get("api_key")
                    .or_else(|| config.additional_fields.get("apiKey"))
                    .cloned()
                    .filter(|value| !value.trim().is_empty())
            });
        let driver = Self {
            client: client_builder.build()?,
            base_url,
            api_key,
            cancel_registry: RwLock::new(QueryCancelRegistry::new()),
        };
        driver.ping().await?;
        Ok(driver)
    }

    /// Class names must be GraphQL-safe and path-safe: they are interpolated
    /// into the `Get { <Class>(...) }` query text and into `/v1/schema/<c>`
    /// path segments, so only the unquoted-identifier charset is allowed.
    fn validate_class(value: &str) -> Result<&str> {
        let value = value.trim();
        if value.is_empty()
            || value.len() > 128
            || !value
                .bytes()
                .next()
                .is_some_and(|b| b.is_ascii_alphabetic())
            || !value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_')
        {
            return Err(anyhow!("Weaviate class name '{value}' is invalid"));
        }
        Ok(value)
    }

    /// Property names become GraphQL `path: ["name"]` entries and property
    /// keys inside `properties` bodies; same charset as class names.
    fn validate_property(value: &str) -> Result<&str> {
        let value = value.trim();
        if value.is_empty()
            || value.len() > 128
            || !value
                .bytes()
                .next()
                .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
            || !value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_')
        {
            return Err(anyhow!("Weaviate property name '{value}' is invalid"));
        }
        Ok(value)
    }

    /// Weaviate object ids are canonical `8-4-4-4-12` uuids; they go into
    /// `/v1/objects/<id>` path segments, so the shape is checked strictly.
    fn validate_uuid(value: &str) -> Result<&str> {
        let bytes = value.as_bytes();
        let shape_ok = bytes.len() == 36
            && bytes.iter().enumerate().all(|(index, byte)| {
                if matches!(index, 8 | 13 | 18 | 23) {
                    *byte == b'-'
                } else {
                    byte.is_ascii_hexdigit()
                }
            });
        if !shape_ok {
            return Err(anyhow!("Weaviate object id '{value}' is not a uuid"));
        }
        Ok(value)
    }

    /// Quote a string for GraphQL query text. GraphQL string escapes are the
    /// JSON escapes, so `serde_json` provides the escaping; the value is
    /// always data, never structure.
    fn graphql_string(value: &str) -> String {
        serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
    }

    /// Path allowlist like the other HTTP plugin drivers: the request can only
    /// address the configured host, and the path cannot escape upward.
    fn request(&self, method: Method, path: &str) -> Result<reqwest::RequestBuilder> {
        if path.len() > 1024 || path.contains("..") || path.contains("//") || !path.starts_with('/')
        {
            return Err(anyhow!(
                "Weaviate request path is outside the driver allowlist"
            ));
        }
        let url = self.base_url.join(path.trim_start_matches('/'))?;
        if url.scheme() != self.base_url.scheme()
            || url.host_str() != self.base_url.host_str()
            || url.port_or_known_default() != self.base_url.port_or_known_default()
        {
            return Err(anyhow!("Weaviate request escaped the configured endpoint"));
        }
        let mut request = self.client.request(method, url);
        if let Some(key) = self.api_key.as_deref() {
            request = request.bearer_auth(key);
        }
        Ok(request)
    }

    /// Send a request and return `(status, body bytes)` with the response
    /// bounded to `MAX_RESPONSE_BYTES`. `cancel` is polled between chunks:
    /// Weaviate cannot abort a request server-side, but dropping the stream
    /// stops the read immediately.
    async fn send(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        cancel: Option<&AtomicBool>,
    ) -> Result<(StatusCode, Vec<u8>)> {
        if cancel.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
            return Err(anyhow!("Query cancelled."));
        }
        if let Some(body) = body {
            if serde_json::to_vec(body)?.len() > MAX_REQUEST_BYTES {
                return Err(anyhow!("Weaviate request exceeds the plugin request limit"));
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
                "Weaviate response exceeds the plugin payload limit"
            ));
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
                return Err(anyhow!(
                    "Weaviate response exceeds the plugin payload limit"
                ));
            }
            bytes.extend_from_slice(&chunk);
            if cancel.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
                return Err(anyhow!("Query cancelled."));
            }
        }
        Ok((status, bytes))
    }

    fn status_error(status: StatusCode, bytes: &[u8]) -> anyhow::Error {
        anyhow!(
            "Weaviate request failed with {}: {}",
            status.as_u16(),
            String::from_utf8_lossy(bytes)
                .chars()
                .take(400)
                .collect::<String>()
        )
    }

    async fn send_json(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        cancel: Option<&AtomicBool>,
    ) -> Result<Value> {
        let (status, bytes) = self.send(method, path, body, cancel).await?;
        if !status.is_success() {
            return Err(Self::status_error(status, &bytes));
        }
        if bytes.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&bytes).map_err(Into::into)
    }

    /// `send_json` with a 404 → `None` mapping for existence probes
    /// (`GET /v1/schema/<class>`).
    async fn send_json_opt(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Option<Value>> {
        let (status, bytes) = self.send(method, path, body, None).await?;
        if status == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !status.is_success() {
            return Err(Self::status_error(status, &bytes));
        }
        if bytes.is_empty() {
            return Ok(Some(Value::Null));
        }
        serde_json::from_slice(&bytes).map(Some).map_err(Into::into)
    }

    /// POST a GraphQL query and return the `data` payload, surfacing the
    /// server's `errors[].message` instead of a bare transport error.
    async fn graphql(&self, query: &str, cancel: Option<&AtomicBool>) -> Result<Value> {
        let body = json!({ "query": query });
        let response = self
            .send_json(Method::POST, "/v1/graphql", Some(&body), cancel)
            .await?;
        if let Some(errors) = response
            .get("errors")
            .and_then(Value::as_array)
            .filter(|errors| !errors.is_empty())
        {
            let message = errors
                .iter()
                .filter_map(|error| error.get("message").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("; ");
            return Err(anyhow!(
                "Weaviate GraphQL error: {}",
                if message.is_empty() {
                    serde_json::to_string(errors).unwrap_or_else(|_| "unknown error".to_string())
                } else {
                    message
                }
            ));
        }
        Ok(response.get("data").cloned().unwrap_or(Value::Null))
    }

    /// `GET /v1/schema/<class>`; `None` when the class does not exist.
    async fn class_schema(&self, class: &str) -> Result<Option<Value>> {
        self.send_json_opt(Method::GET, &format!("/v1/schema/{class}"), None)
            .await
    }

    /// `(name, dataType)` pairs for one class. A class without declared
    /// properties falls back to sampling one object so schemaless data still
    /// gets a usable column list.
    async fn property_specs(&self, class: &str) -> Result<Vec<(String, String)>> {
        if let Some(schema) = self.class_schema(class).await? {
            let specs = schema
                .get("properties")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|property| {
                    let name = property.get("name")?.as_str()?.to_string();
                    Some((name, Self::property_data_type(property)))
                })
                .collect::<Vec<_>>();
            if !specs.is_empty() {
                return Ok(specs);
            }
        }
        let sample = self
            .send_json(
                Method::GET,
                &format!("/v1/objects?class={class}&limit=1"),
                None,
                None,
            )
            .await?;
        let mut specs = Vec::new();
        if let Some(properties) = sample
            .pointer("/objects/0/properties")
            .and_then(Value::as_object)
        {
            for (name, value) in properties {
                specs.push((name.clone(), Self::infer_data_type(value).to_string()));
            }
        }
        Ok(specs)
    }

    /// Display form of a class property's `dataType` array. Cross-references
    /// keep their target class names so `["Article"]` shows as `Article`.
    fn property_data_type(property: &Value) -> String {
        property
            .get("dataType")
            .and_then(Value::as_array)
            .map(|types| {
                types
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .or_else(|| {
                property
                    .get("dataType")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "text".to_string())
    }

    fn infer_data_type(value: &Value) -> &'static str {
        match value {
            Value::String(_) => "text",
            Value::Bool(_) => "boolean",
            Value::Number(number) if number.is_i64() || number.is_u64() => "int",
            Value::Number(_) => "number",
            Value::Array(_) => "array",
            Value::Object(_) => "object",
            Value::Null => "text",
        }
    }

    /// Fetch one cell of a REST object or GraphQL `Get` row. REST returns
    /// `{id, properties: {...}}`; GraphQL returns `{<field>, _additional:{id}}`
    /// with fields flattened at the top level — both shapes converge here.
    fn object_cell(object: &Value, column: &str) -> Value {
        if column == ID_COLUMN {
            return object
                .get("id")
                .cloned()
                .or_else(|| object.pointer("/_additional/id").cloned())
                .unwrap_or(Value::Null);
        }
        object
            .get("properties")
            .and_then(|properties| properties.get(column))
            .cloned()
            .or_else(|| object.get(column).cloned())
            .unwrap_or(Value::Null)
    }

    fn objects_to_result(
        columns: &[(String, String)],
        objects: Vec<Value>,
        elapsed: u128,
        query_label: String,
        truncated: bool,
    ) -> QueryResult {
        let rows = objects
            .iter()
            .map(|object| {
                columns
                    .iter()
                    .map(|(name, _)| Self::object_cell(object, name))
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        QueryResult {
            columns: columns
                .iter()
                .map(|(name, data_type)| ColumnInfo {
                    name: name.clone(),
                    data_type: data_type.clone(),
                    is_nullable: name != ID_COLUMN,
                    is_primary_key: name == ID_COLUMN,
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

    /// Objects array out of a `Get` response: `data.Get.<Class>` may be an
    /// array (normal) or `null` (empty class).
    fn get_objects<'a>(data: &'a Value, class: &str) -> &'a [Value] {
        data.get("Get")
            .and_then(|get| get.get(class))
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    /// `Aggregate { <Class>(where?) { meta { count } } }` — used for row
    /// counts and null counts. The aggregate payload is an object on current
    /// servers and an array on older ones; both are unwrapped.
    async fn aggregate_count(&self, class: &str, where_arg: Option<String>) -> Result<i64> {
        let args = where_arg
            .map(|filter| format!("(where: {filter})"))
            .unwrap_or_default();
        let query = format!("{{ Aggregate {{ {class}{args} {{ meta {{ count }} }} }} }}");
        let data = self.graphql(&query, None).await?;
        let aggregate = data.get("Aggregate").and_then(|a| a.get(class));
        let meta = match aggregate {
            Some(Value::Array(items)) => items.first(),
            other => other,
        };
        meta.and_then(|value| value.get("meta"))
            .and_then(|meta| meta.get("count"))
            .and_then(|count| count.as_i64().or_else(|| count.as_f64().map(|n| n as i64)))
            .ok_or_else(|| anyhow!("Weaviate aggregate count response for '{class}' is invalid"))
    }

    // ---------------------------------------------------------------------
    // SQL subset → GraphQL
    // ---------------------------------------------------------------------

    /// Tokenize the SELECT/DDL subset. `'...'` is a string literal (`''`
    /// escapes), `"..."` or `` `...` `` are quoted identifiers, `?` is a
    /// positional bind slot, `[]` follows a type name as the array suffix.
    /// `--` and `/* */` comments are skipped.
    fn tokenize(text: &str) -> Result<Vec<Token>> {
        let chars = text.chars().collect::<Vec<_>>();
        let mut tokens = Vec::new();
        let mut index = 0;
        while index < chars.len() {
            let current = chars[index];
            match current {
                c if c.is_whitespace() => index += 1,
                '-' if chars.get(index + 1) == Some(&'-') => {
                    while index < chars.len() && chars[index] != '\n' {
                        index += 1;
                    }
                }
                '/' if chars.get(index + 1) == Some(&'*') => {
                    index += 2;
                    while index + 1 < chars.len()
                        && !(chars[index] == '*' && chars[index + 1] == '/')
                    {
                        index += 1;
                    }
                    if index + 1 >= chars.len() {
                        return Err(anyhow!("Unterminated block comment in Weaviate query"));
                    }
                    index += 2;
                }
                '\'' => {
                    index += 1;
                    let mut value = String::new();
                    loop {
                        match chars.get(index) {
                            Some('\'') if chars.get(index + 1) == Some(&'\'') => {
                                value.push('\'');
                                index += 2;
                            }
                            Some('\'') => {
                                index += 1;
                                break;
                            }
                            Some(c) => {
                                value.push(*c);
                                index += 1;
                            }
                            None => {
                                return Err(anyhow!(
                                    "Unterminated string literal in Weaviate query"
                                ))
                            }
                        }
                    }
                    tokens.push(Token::Str(value));
                }
                '"' | '`' => {
                    index += 1;
                    let mut value = String::new();
                    loop {
                        match chars.get(index) {
                            Some(c) if *c == current => {
                                index += 1;
                                break;
                            }
                            Some(c) => {
                                value.push(*c);
                                index += 1;
                            }
                            None => {
                                return Err(anyhow!(
                                    "Unterminated quoted identifier in Weaviate query"
                                ))
                            }
                        }
                    }
                    tokens.push(Token::Ident(value));
                }
                c if c.is_ascii_digit()
                    || (c == '-'
                        && chars
                            .get(index + 1)
                            .is_some_and(|next| next.is_ascii_digit())) =>
                {
                    let start = index;
                    index += 1;
                    let mut seen_dot = false;
                    while let Some(next) = chars.get(index) {
                        if next.is_ascii_digit() {
                            index += 1;
                        } else if *next == '.' && !seen_dot {
                            seen_dot = true;
                            index += 1;
                        } else {
                            break;
                        }
                    }
                    let literal: String = chars[start..index].iter().collect();
                    if seen_dot {
                        let number = literal.parse::<f64>().map_err(|_| {
                            anyhow!("Weaviate query has invalid number literal '{literal}'")
                        })?;
                        tokens.push(Token::Float(number));
                    } else {
                        let number = literal.parse::<i64>().map_err(|_| {
                            anyhow!("Weaviate query has invalid integer literal '{literal}'")
                        })?;
                        tokens.push(Token::Int(number));
                    }
                }
                '?' => {
                    tokens.push(Token::Param);
                    index += 1;
                }
                '*' => {
                    tokens.push(Token::Star);
                    index += 1;
                }
                ',' => {
                    tokens.push(Token::Comma);
                    index += 1;
                }
                '(' => {
                    tokens.push(Token::LParen);
                    index += 1;
                }
                ')' => {
                    tokens.push(Token::RParen);
                    index += 1;
                }
                '[' if chars.get(index + 1) == Some(&']') => {
                    tokens.push(Token::ArraySuffix);
                    index += 2;
                }
                '=' => {
                    tokens.push(Token::Eq);
                    index += 1;
                }
                '!' if chars.get(index + 1) == Some(&'=') => {
                    tokens.push(Token::NotEq);
                    index += 2;
                }
                '<' if chars.get(index + 1) == Some(&'=') => {
                    tokens.push(Token::LtEq);
                    index += 2;
                }
                '<' if chars.get(index + 1) == Some(&'>') => {
                    tokens.push(Token::NotEq);
                    index += 2;
                }
                '<' => {
                    tokens.push(Token::Lt);
                    index += 1;
                }
                '>' if chars.get(index + 1) == Some(&'=') => {
                    tokens.push(Token::GtEq);
                    index += 2;
                }
                '>' => {
                    tokens.push(Token::Gt);
                    index += 1;
                }
                c if c.is_ascii_alphabetic() || c == '_' => {
                    let start = index;
                    while chars
                        .get(index)
                        .is_some_and(|next| next.is_ascii_alphanumeric() || *next == '_')
                    {
                        index += 1;
                    }
                    tokens.push(Token::Ident(chars[start..index].iter().collect()));
                }
                other => {
                    return Err(anyhow!(
                        "Weaviate query has an unexpected character '{other}'"
                    ))
                }
            }
        }
        Ok(tokens)
    }

    /// Reduce a statement to a single SQL sentence: a trailing `;` is
    /// stripped, any `;` inside the statement (outside quotes) is rejected.
    fn single_statement(sql: &str) -> Result<&str> {
        let text = sql.trim();
        let mut quote: Option<char> = None;
        let mut iter = text.char_indices().peekable();
        while let Some((index, current)) = iter.next() {
            match quote {
                Some(closer) => {
                    if current == closer {
                        if closer == '\'' && iter.peek().is_some_and(|&(_, next)| next == '\'') {
                            iter.next(); // '' escape
                        } else {
                            quote = None;
                        }
                    }
                }
                None => {
                    if matches!(current, '\'' | '"' | '`') {
                        quote = Some(current);
                    } else if current == ';' {
                        if text[index + 1..].trim().is_empty() {
                            return Ok(text[..index].trim_end());
                        }
                        return Err(anyhow!("Weaviate executes one statement per request"));
                    }
                }
            }
        }
        Ok(text)
    }

    /// Strip a leading `GET ` so read-only REST endpoints (`GET /v1/meta`,
    /// `GET /v1/schema`, `GET /v1/objects?...`) share the query surface.
    fn strip_get_prefix(sql: &str) -> Option<&str> {
        let rest = sql.trim_start();
        let head = rest.get(..3)?;
        if !head.eq_ignore_ascii_case("GET") {
            return None;
        }
        match rest.as_bytes().get(3) {
            Some(byte) if byte.is_ascii_whitespace() => Some(rest[3..].trim_start()),
            _ => None,
        }
    }

    /// Convert a scalar JSON value into the typed operand the GraphQL `where`
    /// argument needs. Values never interpolate into query text — the GraphQL
    /// string is escaped via [`Self::graphql_string`].
    fn scalar_binding(value: &Scalar) -> String {
        match value {
            Scalar::Text(text) => format!("valueText: {}", Self::graphql_string(text)),
            Scalar::Int(number) => format!("valueInt: {number}"),
            Scalar::Float(number) => format!("valueNumber: {}", json!(number)),
            Scalar::Bool(flag) => format!("valueBoolean: {flag}"),
        }
    }

    /// `IN (...)` compiles to Weaviate's `ContainsAny` operator with the typed
    /// `*Array` value key. Mixed-type lists are rejected because Weaviate
    /// offers no mixed array operand.
    fn scalar_array_binding(values: &[Scalar]) -> Result<String> {
        let mut kind: Option<&'static str> = None;
        for value in values {
            let current = match value {
                Scalar::Text(_) => "text",
                Scalar::Int(_) => "int",
                Scalar::Float(_) => "number",
                Scalar::Bool(_) => "boolean",
            };
            match kind {
                None => kind = Some(current),
                Some(existing) if existing != current => {
                    return Err(anyhow!("Weaviate IN lists must contain values of one type"))
                }
                _ => {}
            }
        }
        let list = |render_one: &dyn Fn(&Scalar) -> String| {
            format!(
                "[{}]",
                values.iter().map(render_one).collect::<Vec<_>>().join(", ")
            )
        };
        match kind {
            Some("text") => Ok(format!(
                "valueTextArray: {}",
                list(&|value| match value {
                    Scalar::Text(text) => Self::graphql_string(text),
                    _ => String::new(),
                })
            )),
            Some("int") => Ok(format!(
                "valueIntArray: {}",
                list(&|value| match value {
                    Scalar::Int(number) => number.to_string(),
                    _ => String::new(),
                })
            )),
            Some("number") => Ok(format!(
                "valueNumberArray: {}",
                list(&|value| match value {
                    Scalar::Int(number) => number.to_string(),
                    Scalar::Float(number) => json!(number).to_string(),
                    _ => String::new(),
                })
            )),
            Some("boolean") => Ok(format!(
                "valueBooleanArray: {}",
                list(&|value| match value {
                    Scalar::Bool(flag) => flag.to_string(),
                    _ => String::new(),
                })
            )),
            _ => Err(anyhow!("Weaviate IN requires at least one value")),
        }
    }

    /// SQL `LIKE` wildcards (`%`, `_`) map to Weaviate's `Like` wildcards
    /// (`*`, `?`). Weaviate has no wildcard escape, so a literal `%`/`_`
    /// cannot be expressed — documented limitation.
    fn like_pattern(pattern: &str) -> String {
        pattern
            .chars()
            .map(|c| match c {
                '%' => '*',
                '_' => '?',
                other => other,
            })
            .collect()
    }

    /// Compile the parsed filter tree to a GraphQL `where:` argument value.
    /// Groups map to `{operator: And|Or, operands: [...]}`; leaves map to
    /// `{path: [...], operator: X, valueY: ...}`.
    fn filter_to_graphql(filter: &Filter) -> String {
        match filter {
            Filter::And(parts) => format!(
                "{{operator: And, operands: [{}]}}",
                parts
                    .iter()
                    .map(Self::filter_to_graphql)
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            Filter::Or(parts) => format!(
                "{{operator: Or, operands: [{}]}}",
                parts
                    .iter()
                    .map(Self::filter_to_graphql)
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            Filter::Compare { path, op, value } => format!(
                "{{path: [{}], operator: {}, {}}}",
                Self::graphql_string(path),
                op.graphql(),
                Self::scalar_binding(value)
            ),
            Filter::Like { path, pattern } => format!(
                "{{path: [{}], operator: Like, valueText: {}}}",
                Self::graphql_string(path),
                Self::graphql_string(&Self::like_pattern(pattern))
            ),
            Filter::In { path, values } => format!(
                "{{path: [{}], operator: ContainsAny, {}}}",
                Self::graphql_string(path),
                // IN lists are validated at parse time; an unreachable empty
                // list falls back to an empty text array (matches nothing).
                Self::scalar_array_binding(values)
                    .unwrap_or_else(|_| "valueTextArray: []".to_string())
            ),
            Filter::IsNull { path, is_null } => format!(
                "{{path: [{}], operator: IsNull, valueBoolean: {}}}",
                Self::graphql_string(path),
                is_null
            ),
        }
    }

    /// `limit/offset/where/sort/after` argument list for a `Get` call.
    fn get_args(
        filter: Option<&Filter>,
        order: &[(String, bool)],
        limit: Option<u64>,
        offset: u64,
        after: Option<&str>,
    ) -> String {
        // `None` means an unbounded interactive read → the default page cap;
        // explicit limits (SELECT n, grid page size, export batch) pass
        // through unclamped so exports can fetch 10k-object pages.
        let limit = limit.unwrap_or(MAX_RESULT_ROWS).max(1);
        let mut parts = vec![format!("limit: {limit}")];
        if offset > 0 {
            parts.push(format!("offset: {offset}"));
        }
        if let Some(filter) = filter {
            parts.push(format!("where: {}", Self::filter_to_graphql(filter)));
        }
        if !order.is_empty() {
            let sort = order
                .iter()
                .map(|(path, desc)| {
                    format!(
                        "{{path: [{}], order: {}}}",
                        Self::graphql_string(path),
                        if *desc { "desc" } else { "asc" }
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            parts.push(format!("sort: [{sort}]"));
        }
        if let Some(after) = after {
            parts.push(format!("after: {}", Self::graphql_string(after)));
        }
        parts.join(" ")
    }

    fn build_get_query(class: &str, fields: &[String], args: &str) -> String {
        let selection = if fields.is_empty() {
            String::new()
        } else {
            format!("{} ", fields.join(" "))
        };
        format!("{{ Get {{ {class}({args}) {{ {selection}_additional {{ id }} }} }} }}")
    }

    /// Grid sort fields map to GraphQL `sort` paths; `_id` sorts on the
    /// object `id` path.
    fn sort_path(column: &str) -> Result<String> {
        if column.trim() == ID_COLUMN {
            return Ok("id".to_string());
        }
        Ok(Self::validate_property(column)?.to_string())
    }

    /// Parse a standalone WHERE expression (the grid's filter bar text) with
    /// the same grammar as the SELECT subset.
    fn parse_filter_expression(text: &str, binds: Option<&[QueryParameter]>) -> Result<Filter> {
        let tokens = Self::tokenize(text)?;
        let mut parser = Parser::new(&tokens, binds);
        let filter = parser.parse_or()?;
        parser.expect_end()?;
        if parser.bind_pos < parser.binds.len() {
            return Err(anyhow!(
                "Weaviate filter received more bound parameters than '?' markers"
            ));
        }
        Ok(filter)
    }

    /// `(class, object_uuid)` for a pk selector. The grid's `_id`/`id`
    /// selector column carries the object uuid.
    fn object_target(&self, table: &str, primary_keys: &[RowKeyValue]) -> Result<(String, String)> {
        let class = Self::validate_class(table)?.to_string();
        let mut id: Option<String> = None;
        for key in primary_keys {
            if key.column == ID_COLUMN || key.column == "id" {
                id = Some(
                    key.value
                        .as_str()
                        .ok_or_else(|| anyhow!("Weaviate {ID_COLUMN} selector must be a string"))?
                        .to_string(),
                );
            }
        }
        let id = Self::validate_uuid(&id.ok_or_else(|| {
            anyhow!("Weaviate inline edits require the {ID_COLUMN} column as the row selector")
        })?)?
        .to_string();
        Ok((class, id))
    }

    /// Property name for a write path, rejecting the synthetic columns and
    /// the reserved object fields that are not plain `properties` keys.
    fn writable_property(value: &str) -> Result<&str> {
        let value = value.trim();
        if matches!(
            value,
            ID_COLUMN | "id" | "vector" | "tenant" | "_additional" | "properties" | "class"
        ) {
            return Err(anyhow!(
                "Weaviate column '{value}' is managed by the server and cannot be edited"
            ));
        }
        Self::validate_property(value)
    }

    /// Shared SELECT execution: parse the subset, resolve fields (schema for
    /// `*`), compile the `Get` GraphQL call, and shape rows as `_id` +
    /// properties.
    async fn execute_select(
        &self,
        statement: &str,
        parameters: Option<&[QueryParameter]>,
        cancel: Option<Arc<AtomicBool>>,
    ) -> Result<QueryResult> {
        let started = Instant::now();
        let tokens = Self::tokenize(statement)?;
        let mut parser = Parser::new(&tokens, parameters);
        let select = parser.parse_select()?;
        if parser.bind_pos < parser.binds.len() {
            return Err(anyhow!(
                "Weaviate query received more bound parameters than '?' markers"
            ));
        }
        let class = Self::validate_class(&select.class)?.to_string();

        // One schema fetch covers `SELECT *` field expansion and the column
        // type map for the result header.
        let specs = self.property_specs(&class).await?;
        let fields: Vec<String> = match &select.fields {
            Some(fields) => fields
                .iter()
                .map(|field| Self::validate_property(field).map(str::to_string))
                .collect::<Result<Vec<_>>>()?,
            None => specs.iter().map(|(name, _)| name.clone()).collect(),
        };
        // `id`/`_id` are not GraphQL-selectable fields — they are served by
        // `_additional { id }`, which is always selected, and surfaced via
        // the `_id` column.
        let select_fields: Vec<String> = fields
            .iter()
            .filter(|field| field.as_str() != ID_COLUMN && field.as_str() != "id")
            .cloned()
            .collect();
        let mut columns = vec![(ID_COLUMN.to_string(), "uuid".to_string())];
        for field in &select_fields {
            let data_type = specs
                .iter()
                .find(|(name, _)| name == field)
                .map(|(_, ty)| ty.clone())
                .unwrap_or_else(|| "json".to_string());
            columns.push((field.clone(), data_type));
        }

        let mut order = Vec::new();
        for (path, desc) in &select.order {
            order.push((Self::sort_path(path)?, *desc));
        }
        let args = Self::get_args(
            select.filter.as_ref(),
            &order,
            select.limit,
            select.offset,
            None,
        );
        let query = Self::build_get_query(&class, &select_fields, &args);
        let data = self.graphql(&query, cancel.as_deref()).await?;
        let objects = Self::get_objects(&data, &class).to_vec();
        let effective_limit = select.limit.unwrap_or(MAX_RESULT_ROWS).max(1);
        let truncated = objects.len() as u64 >= effective_limit;
        Ok(Self::objects_to_result(
            &columns,
            objects,
            started.elapsed().as_millis(),
            statement.to_string(),
            truncated,
        ))
    }

    /// `CREATE TABLE` → `POST /v1/schema`, `DROP TABLE` → `DELETE
    /// /v1/schema/<class>`, `ALTER TABLE ADD/DROP COLUMN` → the per-class
    /// properties endpoints.
    async fn execute_schema_statement(&self, statement: &str) -> Result<QueryResult> {
        let started = Instant::now();
        let tokens = Self::tokenize(statement)?;
        let mut parser = Parser::new(&tokens, None);
        let schema_statement = parser.parse_schema_statement()?;
        let affected = match &schema_statement {
            SchemaStatement::Create { class, properties } => {
                let class = Self::validate_class(class)?;
                let properties = properties
                    .iter()
                    .map(|(name, data_type)| {
                        let name = Self::writable_property(name)?;
                        Ok(json!({
                            "name": name,
                            "dataType": [data_type],
                        }))
                    })
                    .collect::<Result<Vec<_>>>()?;
                let body = json!({
                    "class": class,
                    "properties": properties,
                });
                self.send_json(Method::POST, "/v1/schema", Some(&body), None)
                    .await?;
                1
            }
            SchemaStatement::Drop { class, if_exists } => {
                let class = Self::validate_class(class)?;
                let (status, bytes) = self
                    .send(Method::DELETE, &format!("/v1/schema/{class}"), None, None)
                    .await?;
                match status {
                    status if status.is_success() => 1,
                    StatusCode::NOT_FOUND if *if_exists => 0,
                    _ => return Err(Self::status_error(status, &bytes)),
                }
            }
            SchemaStatement::AddProperty {
                class,
                name,
                data_type,
            } => {
                let class = Self::validate_class(class)?;
                let name = Self::writable_property(name)?;
                let body = json!({
                    "name": name,
                    "dataType": [data_type],
                });
                self.send_json(
                    Method::POST,
                    &format!("/v1/schema/{class}/properties"),
                    Some(&body),
                    None,
                )
                .await?;
                1
            }
            SchemaStatement::DropProperty { class, name } => {
                let class = Self::validate_class(class)?;
                let name = Self::validate_property(name)?;
                self.send_json(
                    Method::DELETE,
                    &format!("/v1/schema/{class}/properties/{name}"),
                    None,
                    None,
                )
                .await?;
                1
            }
        };
        Ok(QueryResult {
            columns: vec![],
            rows: vec![],
            affected_rows: affected,
            execution_time_ms: started.elapsed().as_millis(),
            query: statement.to_string(),
            sandboxed: true,
            truncated: false,
        })
    }

    /// `GET /v1/...` read-only REST requests return the JSON body as a
    /// single-row result, the same shape the OpenSearch driver uses.
    async fn execute_get_request(&self, path: &str, query_label: String) -> Result<QueryResult> {
        if !path.starts_with("/v1/")
            || !path
                .bytes()
                .all(|byte| byte.is_ascii_graphic() && !b" \"'<>`{}".contains(&byte))
        {
            return Err(anyhow!(
                "Weaviate GET requests are limited to read-only /v1/ endpoints"
            ));
        }
        let started = Instant::now();
        let value = self.send_json(Method::GET, path, None, None).await?;
        let text = serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string());
        Ok(QueryResult {
            columns: vec![ColumnInfo {
                name: "response".to_string(),
                data_type: "json".to_string(),
                is_nullable: true,
                is_primary_key: false,
                max_length: None,
                default_value: None,
            }],
            rows: vec![vec![Value::String(text)]],
            affected_rows: 0,
            execution_time_ms: started.elapsed().as_millis(),
            query: query_label,
            sandboxed: true,
            truncated: false,
        })
    }

    async fn execute_query_inner(
        &self,
        sql: &str,
        parameters: Option<&[QueryParameter]>,
        cancel: Option<Arc<AtomicBool>>,
    ) -> Result<QueryResult> {
        if sql.len() > MAX_REQUEST_BYTES {
            return Err(anyhow!("Weaviate query exceeds the plugin request limit"));
        }
        let statement = Self::single_statement(sql)?;
        if statement.is_empty() {
            return Err(anyhow!("Weaviate query cannot be empty"));
        }
        if let Some(path) = Self::strip_get_prefix(statement) {
            return self.execute_get_request(path, statement.to_string()).await;
        }
        let first = statement
            .split(|c: char| c.is_whitespace())
            .next()
            .unwrap_or_default();
        match first.to_ascii_lowercase().as_str() {
            "select" => self.execute_select(statement, parameters, cancel).await,
            "create" | "drop" | "alter" => {
                if parameters.is_some() {
                    return Err(anyhow!(
                        "Weaviate schema statements cannot use bound parameters"
                    ));
                }
                self.execute_schema_statement(statement).await
            }
            _ => Err(anyhow!(
                "Weaviate accepts a SELECT subset (SELECT fields FROM <class> [WHERE field op literal [AND|OR ...]] [ORDER BY field] [LIMIT n]), CREATE/DROP/ALTER TABLE schema statements, or read-only GET /v1/... requests"
            )),
        }
    }
}

#[async_trait]
impl DatabaseDriver for WeaviateDriver {
    /// Probe `GET /v1/meta`; deployments that lack the meta endpoint fall
    /// back to `GET /v1/schema`.
    async fn ping(&self) -> Result<()> {
        match self.send_json(Method::GET, "/v1/meta", None, None).await {
            Ok(_) => Ok(()),
            Err(meta_error) => self
                .send_json(Method::GET, "/v1/schema", None, None)
                .await
                .map(|_| ())
                .map_err(|_| meta_error),
        }
    }

    async fn disconnect(&self) -> Result<()> {
        Ok(())
    }

    /// Weaviate has a single schema; the "database" is a fixed `default`.
    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        Ok(vec![DatabaseInfo {
            name: "default".to_string(),
            size: None,
        }])
    }

    /// `GET /v1/schema` classes → tables. Row counts are not fetched here
    /// (an `Aggregate` per class would be an N+1 cost for a list view).
    async fn list_tables(&self, _database: Option<&str>) -> Result<Vec<TableInfo>> {
        let value = self
            .send_json(Method::GET, "/v1/schema", None, None)
            .await?;
        Ok(value
            .get("classes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|class| {
                Some(TableInfo {
                    name: class.get("class")?.as_str()?.to_string(),
                    schema: None,
                    table_type: "class".to_string(),
                    row_count: None,
                    engine: class
                        .get("vectorizer")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    create_date: None,
                })
            })
            .collect())
    }

    async fn list_schema_objects(&self, _database: Option<&str>) -> Result<Vec<SchemaObjectInfo>> {
        Ok(Vec::new())
    }

    /// `GET /v1/schema/<class>` properties → columns, plus the synthetic
    /// `_id` uuid primary-key column.
    async fn get_table_structure(
        &self,
        table: &str,
        _database: Option<&str>,
    ) -> Result<TableStructure> {
        let class = Self::validate_class(table)?;
        let schema = self
            .class_schema(class)
            .await?
            .ok_or_else(|| anyhow!("Weaviate class '{class}' does not exist"))?;
        let mut columns = vec![ColumnDetail {
            name: ID_COLUMN.to_string(),
            data_type: "uuid".to_string(),
            is_nullable: false,
            is_primary_key: true,
            default_value: None,
            extra: None,
            column_type: Some("uuid".to_string()),
            comment: Some("Weaviate object id".to_string()),
        }];
        for property in schema
            .get("properties")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(name) = property.get("name").and_then(Value::as_str) else {
                continue;
            };
            let data_type = Self::property_data_type(property);
            let is_reference = property
                .get("dataType")
                .and_then(Value::as_array)
                .is_some_and(|types| {
                    types.iter().any(|entry| {
                        entry
                            .as_str()
                            .is_some_and(|ty| ty.chars().next().is_some_and(|c| c.is_uppercase()))
                    })
                });
            columns.push(ColumnDetail {
                name: name.to_string(),
                data_type: data_type.clone(),
                is_nullable: true,
                is_primary_key: false,
                default_value: None,
                extra: None,
                column_type: Some(data_type),
                comment: is_reference.then(|| "cross-reference".to_string()),
            });
        }
        Ok(TableStructure {
            columns,
            indexes: Vec::new(),
            foreign_keys: Vec::new(),
            triggers: Vec::new(),
            view_definition: None,
            object_type: Some("class".to_string()),
        })
    }

    async fn execute_query(&self, sql: &str) -> Result<QueryResult> {
        self.execute_query_inner(sql, None, None).await
    }

    /// Request-scoped execution: the registry resolves the pending-cancel
    /// race and the shared flag aborts the HTTP response stream between
    /// chunks — Weaviate offers no server-side cancel.
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
            // The flag is already flipped; the next streamed chunk or the
            // next HTTP call aborts the request client-side.
            CancelLookup::Pending | CancelLookup::Backend(_) => Ok(true),
        }
    }

    /// `:name`/`$name`/`@name` markers compile to `?` slots which bind into
    /// `where:` operand values — never interpolated into query text.
    async fn execute_parameterized_query(
        &self,
        sql: &str,
        parameters: &[QueryParameter],
    ) -> Result<QueryResult> {
        let compiled =
            compile_parameterized_query(sql, parameters, PlaceholderStyle::QuestionMark)?;
        self.execute_query_inner(&compiled.sql, Some(&compiled.parameters), None)
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
        let compiled =
            compile_parameterized_query(sql, parameters, PlaceholderStyle::QuestionMark)?;
        let guard = CancelScopeGuard::begin(&self.cancel_registry, request_id);
        if guard.register_backend(0) {
            return Err(anyhow!("Query cancelled."));
        }
        let flag = guard.cancel_flag();
        let result = self
            .execute_query_inner(&compiled.sql, Some(&compiled.parameters), flag)
            .await;
        drop(guard);
        result
    }

    /// Unfiltered browse uses `GET /v1/objects?class&limit&offset&sort&order`;
    /// a grid filter compiles to a GraphQL `Get` with a `where:` argument.
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
        let started = Instant::now();
        let class = Self::validate_class(table)?.to_string();
        let limit = limit.max(1);
        let filter_text = filter.map(str::trim).filter(|value| !value.is_empty());

        if filter_text.is_none() {
            let mut path = format!("/v1/objects?class={class}&limit={limit}&offset={offset}");
            if let Some(field) = order_by.map(str::trim).filter(|value| !value.is_empty()) {
                let direction = if order_dir.is_some_and(|dir| dir.eq_ignore_ascii_case("desc")) {
                    "desc"
                } else {
                    "asc"
                };
                path.push_str(&format!(
                    "&sort={}&order={direction}",
                    Self::sort_path(field)?
                ));
            }
            let data = self.send_json(Method::GET, &path, None, None).await?;
            let objects = data
                .get("objects")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let total = data.get("totalResults").and_then(Value::as_i64);
            let truncated = match total {
                Some(total) => offset.saturating_add(objects.len() as u64) < total.max(0) as u64,
                None => objects.len() as u64 >= limit,
            };
            let mut columns = vec![(ID_COLUMN.to_string(), "uuid".to_string())];
            columns.extend(self.property_specs(&class).await?);
            return Ok(Self::objects_to_result(
                &columns,
                objects,
                started.elapsed().as_millis(),
                format!("Browse class {class}"),
                truncated,
            ));
        }

        // Filtered browse: the filter text compiles to a `where:` argument.
        let filter_expr = Self::parse_filter_expression(filter_text.unwrap_or_default(), None)?;
        let mut order = Vec::new();
        if let Some(field) = order_by.map(str::trim).filter(|value| !value.is_empty()) {
            let desc = order_dir.is_some_and(|dir| dir.eq_ignore_ascii_case("desc"));
            order.push((Self::sort_path(field)?, desc));
        }
        let specs = self.property_specs(&class).await?;
        let fields = specs
            .iter()
            .map(|(name, _)| name.clone())
            .collect::<Vec<_>>();
        let args = Self::get_args(Some(&filter_expr), &order, Some(limit), offset, None);
        let query = Self::build_get_query(&class, &fields, &args);
        let data = self.graphql(&query, None).await?;
        let objects = Self::get_objects(&data, &class).to_vec();
        let truncated = objects.len() as u64 >= limit;
        let mut columns = vec![(ID_COLUMN.to_string(), "uuid".to_string())];
        columns.extend(specs);
        Ok(Self::objects_to_result(
            &columns,
            objects,
            started.elapsed().as_millis(),
            format!("Browse class {class}"),
            truncated,
        ))
    }

    /// Cursor-paged export: unsorted exports page GraphQL `Get` with
    /// `after: <last uuid>` so deep exports stay O(page) on the server.
    /// Sorted exports fall back to `offset` paging, which honors `sort`.
    fn export_table_rows<'a>(
        &'a self,
        table: &'a str,
        _database: Option<&'a str>,
        batch_size: u64,
        order_by: Option<&'a str>,
        order_dir: Option<&'a str>,
        filter: Option<&'a str>,
    ) -> Pin<Box<dyn Stream<Item = Result<QueryResult>> + Send + 'a>> {
        let page_size = batch_size.clamp(1, 10_000);
        let setup = async move {
            let class = Self::validate_class(table)?.to_string();
            let mut order = Vec::new();
            if let Some(field) = order_by.map(str::trim).filter(|value| !value.is_empty()) {
                let desc = order_dir.is_some_and(|dir| dir.eq_ignore_ascii_case("desc"));
                order.push((Self::sort_path(field)?, desc));
            }
            let filter = filter
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|text| Self::parse_filter_expression(text, None))
                .transpose()?;
            let specs = self.property_specs(&class).await?;
            Ok::<_, anyhow::Error>((class, order, filter, specs))
        };
        stream::once(setup)
            .map_ok(move |(class, order, filter, specs)| {
                // GraphQL `sort` and the `after` cursor cannot be combined on
                // every version, so sorted exports offset-page (honors `sort`)
                // and unsorted exports cursor-page (stable, O(page)).
                let use_cursor = order.is_empty();
                struct ExportState {
                    class: String,
                    order: Vec<(String, bool)>,
                    filter: Option<Filter>,
                    fields: Vec<String>,
                    columns: Vec<(String, String)>,
                    offset: u64,
                    after: Option<String>,
                    done: bool,
                }
                let fields = specs
                    .iter()
                    .map(|(name, _)| name.clone())
                    .collect::<Vec<_>>();
                let mut columns = vec![(ID_COLUMN.to_string(), "uuid".to_string())];
                columns.extend(specs);
                let initial = ExportState {
                    class,
                    order,
                    filter,
                    fields,
                    columns,
                    offset: 0,
                    after: None,
                    done: false,
                };
                stream::try_unfold(initial, move |state| {
                    let ExportState {
                        class,
                        order,
                        filter,
                        fields,
                        columns,
                        offset,
                        after,
                        done,
                    } = state;
                    async move {
                        if done {
                            return Ok(None);
                        }
                        let args = Self::get_args(
                            filter.as_ref(),
                            &order,
                            Some(page_size),
                            if use_cursor { 0 } else { offset },
                            if use_cursor { after.as_deref() } else { None },
                        );
                        let query = Self::build_get_query(&class, &fields, &args);
                        let data = self.graphql(&query, None).await?;
                        let objects = Self::get_objects(&data, &class).to_vec();
                        if objects.is_empty() {
                            return Ok(None);
                        }
                        let fetched = objects.len() as u64;
                        let next_after = if use_cursor {
                            objects
                                .last()
                                .and_then(|object| object.pointer("/_additional/id"))
                                .and_then(Value::as_str)
                                .map(str::to_string)
                        } else {
                            None
                        };
                        let finished = fetched < page_size || (use_cursor && next_after.is_none());
                        let result = Self::objects_to_result(
                            &columns,
                            objects,
                            0,
                            format!("Export class {class}"),
                            false,
                        );
                        Ok(Some((
                            result,
                            ExportState {
                                class,
                                order,
                                filter,
                                fields,
                                columns,
                                offset: offset + fetched,
                                after: next_after,
                                done: finished,
                            },
                        )))
                    }
                })
            })
            .try_flatten()
            .boxed()
    }

    /// `GET /v1/objects?class&limit=0` → `totalResults`; servers that omit
    /// the field fall back to the `Aggregate` GraphQL count.
    async fn count_rows(&self, table: &str, _database: Option<&str>) -> Result<i64> {
        let class = Self::validate_class(table)?.to_string();
        let value = self
            .send_json(
                Method::GET,
                &format!("/v1/objects?class={class}&limit=0"),
                None,
                None,
            )
            .await?;
        if let Some(total) = value.get("totalResults").and_then(Value::as_i64) {
            return Ok(total);
        }
        self.aggregate_count(&class, None).await
    }

    /// `Aggregate` with `{path: [col], operator: IsNull, valueBoolean: true}`.
    async fn count_null_values(
        &self,
        table: &str,
        _database: Option<&str>,
        column: &str,
    ) -> Result<i64> {
        let class = Self::validate_class(table)?.to_string();
        let path = if column.trim() == ID_COLUMN {
            "id".to_string()
        } else {
            Self::validate_property(column)?.to_string()
        };
        let filter = Filter::IsNull {
            path,
            is_null: true,
        };
        self.aggregate_count(&class, Some(Self::filter_to_graphql(&filter)))
            .await
    }

    /// `PATCH /v1/objects/<id>` with `{class, properties: {field: value}}` —
    /// a merge of the named properties only.
    async fn update_table_cell(&self, request: &TableCellUpdateRequest) -> Result<u64> {
        let (class, id) = self.object_target(&request.table, &request.primary_keys)?;
        let property = Self::writable_property(&request.target_column)?;
        let body = json!({
            "class": class,
            "properties": { property: request.value.clone() },
        });
        let (status, bytes) = self
            .send(
                Method::PATCH,
                &format!("/v1/objects/{id}"),
                Some(&body),
                None,
            )
            .await?;
        match status {
            status if status.is_success() => Ok(1),
            StatusCode::NOT_FOUND => Ok(0),
            status => Err(Self::status_error(status, &bytes)),
        }
    }

    /// `DELETE /v1/objects/<id>` per selected row; a 404 row counts as not
    /// deleted rather than aborting the batch.
    async fn delete_table_rows(&self, request: &TableRowDeleteRequest) -> Result<u64> {
        if request.rows.is_empty() {
            return Err(anyhow!("Deleting rows requires at least one selected row"));
        }
        let mut deleted = 0_u64;
        for row in &request.rows {
            let (class, id) = self.object_target(&request.table, row)?;
            let (status, bytes) = self
                .send(
                    Method::DELETE,
                    &format!("/v1/objects/{id}?class={class}"),
                    None,
                    None,
                )
                .await?;
            match status {
                status if status.is_success() => deleted += 1,
                StatusCode::NOT_FOUND => {}
                status => return Err(Self::status_error(status, &bytes)),
            }
        }
        Ok(deleted)
    }

    /// `POST /v1/objects` with `{class, properties}`; an `_id`/`id` value in
    /// the row becomes the object uuid (Weaviate rejects malformed uuids).
    async fn insert_table_row(&self, request: &TableRowInsertRequest) -> Result<u64> {
        let class = Self::validate_class(&request.table)?.to_string();
        let mut properties = Map::new();
        let mut id: Option<String> = None;
        for (column, value) in &request.values {
            if column == ID_COLUMN || column == "id" {
                let candidate = value
                    .as_str()
                    .ok_or_else(|| anyhow!("Weaviate {ID_COLUMN} must be a uuid string"))?;
                id = Some(Self::validate_uuid(candidate)?.to_string());
                continue;
            }
            let property = Self::writable_property(column)?;
            properties.insert(property.to_string(), value.clone());
        }
        let mut body = json!({
            "class": class,
            "properties": Value::Object(properties),
        });
        if let Some(id) = id {
            body["id"] = Value::String(id);
        }
        self.send_json(Method::POST, "/v1/objects", Some(&body), None)
            .await?;
        Ok(1)
    }

    /// `POST /v1/batch/objects` exists but reports per-object results — it is
    /// not atomic, so the CSV import contract rejects it honestly instead of
    /// partially loading a file.
    async fn insert_table_rows_atomically(
        &self,
        _requests: &[TableRowInsertRequest],
        _cancelled: Arc<AtomicBool>,
    ) -> Result<u64> {
        Err(anyhow!(
            "Weaviate batch inserts (POST /v1/batch/objects) return per-object results without a transaction; TableR refuses a partial CSV import"
        ))
    }

    async fn use_database(&self, database: &str) -> Result<()> {
        if database.trim().eq_ignore_ascii_case("default") {
            Ok(())
        } else {
            Err(anyhow!(
                "Weaviate exposes a single schema ('default'); multi-tenancy is per-class, not per-database"
            ))
        }
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
        Some("default".to_string())
    }

    fn driver_name(&self) -> &str {
        "weaviate"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        extract::{Path as AxumPath, Query},
        http::HeaderMap,
        routing::{get, patch},
        Json, Router,
    };
    use std::collections::HashMap;
    use tokio::net::TcpListener;

    fn parse_select(sql: &str) -> SelectQuery {
        let tokens = WeaviateDriver::tokenize(sql).unwrap();
        let mut parser = Parser::new(&tokens, None);
        parser.parse_select().unwrap()
    }

    #[test]
    fn select_subset_compiles_to_get_graphql() {
        let select = parse_select(
            "SELECT title, price FROM Product WHERE price >= 9.5 AND title LIKE 'A%' ORDER BY price DESC LIMIT 10 OFFSET 5",
        );
        assert_eq!(select.class, "Product");
        assert_eq!(
            select.fields.as_deref(),
            Some(&["title".to_string(), "price".to_string()][..])
        );
        assert_eq!(select.limit, Some(10));
        assert_eq!(select.offset, 5);
        let args = WeaviateDriver::get_args(
            select.filter.as_ref(),
            &[(WeaviateDriver::sort_path("price").unwrap(), true)],
            select.limit,
            select.offset,
            None,
        );
        assert_eq!(
            args,
            "limit: 10 offset: 5 where: {operator: And, operands: [{path: [\"price\"], operator: GreaterThanEqual, valueNumber: 9.5}, {path: [\"title\"], operator: Like, valueText: \"A*\"}]} sort: [{path: [\"price\"], order: desc}]"
        );
        assert_eq!(
            WeaviateDriver::build_get_query("Product", &["title".to_string()], &args),
            format!("{{ Get {{ Product({args}) {{ title _additional {{ id }} }} }} }}")
        );
    }

    #[test]
    fn select_star_and_defaults() {
        let select = parse_select("select * from Article");
        assert!(select.fields.is_none());
        assert_eq!(
            WeaviateDriver::get_args(None, &[], select.limit, select.offset, None),
            "limit: 500"
        );
    }

    #[test]
    fn where_tree_maps_operators_and_types() {
        let filter = WeaviateDriver::parse_filter_expression(
            "age IN (1, 2, 3) OR (name = 'Bob' AND deleted IS NOT NULL)",
            None,
        )
        .unwrap();
        assert_eq!(
            WeaviateDriver::filter_to_graphql(&filter),
            "{operator: Or, operands: [{path: [\"age\"], operator: ContainsAny, valueIntArray: [1, 2, 3]}, {operator: And, operands: [{path: [\"name\"], operator: Equal, valueText: \"Bob\"}, {path: [\"deleted\"], operator: IsNull, valueBoolean: false}]}]}"
        );
        // `_id` normalizes to the `id` filter path.
        let filter = WeaviateDriver::parse_filter_expression(
            "_id = '36b8f84d-df4e-4d49-b662-bcde71a8764f'",
            None,
        )
        .unwrap();
        assert_eq!(
            WeaviateDriver::filter_to_graphql(&filter),
            "{path: [\"id\"], operator: Equal, valueText: \"36b8f84d-df4e-4d49-b662-bcde71a8764f\"}"
        );
    }

    #[test]
    fn rejects_not_and_null_equality() {
        assert!(WeaviateDriver::parse_filter_expression("NOT a = 1", None).is_err());
        assert!(WeaviateDriver::parse_filter_expression("a NOT IN (1)", None).is_err());
        assert!(WeaviateDriver::parse_filter_expression("a = NULL", None).is_err());
        assert!(WeaviateDriver::parse_filter_expression("a IN (1, 'x')", None).is_err());
        assert!(WeaviateDriver::parse_filter_expression("a IN ()", None).is_err());
    }

    #[test]
    fn graphql_strings_are_escaped() {
        assert_eq!(
            WeaviateDriver::graphql_string("a\"b\nc\\d"),
            "\"a\\\"b\\nc\\\\d\""
        );
        let filter = WeaviateDriver::parse_filter_expression("name = 'O''Neil'", None).unwrap();
        assert_eq!(
            WeaviateDriver::filter_to_graphql(&filter),
            "{path: [\"name\"], operator: Equal, valueText: \"O'Neil\"}"
        );
    }

    #[test]
    fn binds_consume_parameters_in_order() {
        let binds = [
            QueryParameter {
                name: "min".to_string(),
                value: json!(5),
                data_type: QueryParameterType::Integer,
            },
            QueryParameter {
                name: "term".to_string(),
                value: json!("x"),
                data_type: QueryParameterType::Text,
            },
        ];
        let filter =
            WeaviateDriver::parse_filter_expression("age > ? AND name = ?", Some(&binds)).unwrap();
        assert_eq!(
            WeaviateDriver::filter_to_graphql(&filter),
            "{operator: And, operands: [{path: [\"age\"], operator: GreaterThan, valueInt: 5}, {path: [\"name\"], operator: Equal, valueText: \"x\"}]}"
        );
        assert!(
            WeaviateDriver::parse_filter_expression("a = ? AND b = ?", Some(&binds[..1])).is_err()
        );
        assert!(WeaviateDriver::parse_filter_expression("a = ?", Some(&binds)).is_err());
    }

    #[test]
    fn validates_identifiers_and_uuids() {
        assert!(WeaviateDriver::validate_class("Article").is_ok());
        assert!(WeaviateDriver::validate_class("9lives").is_err());
        assert!(WeaviateDriver::validate_class("a'b").is_err());
        assert!(WeaviateDriver::validate_property("_ok_name").is_ok());
        assert!(WeaviateDriver::validate_uuid("36b8f84d-df4e-4d49-b662-bcde71a8764f").is_ok());
        assert!(WeaviateDriver::validate_uuid("not-a-uuid").is_err());
        assert!(WeaviateDriver::validate_uuid("36b8f84d-df4e-4d49-b662-bcde71a8764f/x").is_err());
    }

    #[test]
    fn parses_schema_statements() {
        let tokens =
            WeaviateDriver::tokenize("CREATE TABLE Article (title text, tags text[], count int)")
                .unwrap();
        let statement = Parser::new(&tokens, None).parse_schema_statement().unwrap();
        match statement {
            SchemaStatement::Create { class, properties } => {
                assert_eq!(class, "Article");
                assert_eq!(
                    properties,
                    vec![
                        ("title".to_string(), "text".to_string()),
                        ("tags".to_string(), "text[]".to_string()),
                        ("count".to_string(), "int".to_string())
                    ]
                );
            }
            _ => panic!("expected Create"),
        }

        let tokens = WeaviateDriver::tokenize("DROP TABLE IF EXISTS Article").unwrap();
        match Parser::new(&tokens, None).parse_schema_statement().unwrap() {
            SchemaStatement::Drop { class, if_exists } => {
                assert_eq!((class.as_str(), if_exists), ("Article", true));
            }
            _ => panic!("expected Drop"),
        }

        let tokens =
            WeaviateDriver::tokenize("ALTER TABLE Article ADD COLUMN summary varchar(255)")
                .unwrap();
        match Parser::new(&tokens, None).parse_schema_statement().unwrap() {
            SchemaStatement::AddProperty {
                class,
                name,
                data_type,
            } => {
                assert_eq!(
                    (class.as_str(), name.as_str(), data_type.as_str()),
                    ("Article", "summary", "text")
                );
            }
            _ => panic!("expected AddProperty"),
        }
    }

    #[test]
    fn object_cells_cover_rest_and_graphql_shapes() {
        let rest = json!({
            "id": "u-1",
            "properties": { "title": "hello" }
        });
        let graphql = json!({
            "title": "hello",
            "_additional": { "id": "u-1" }
        });
        for object in [rest, graphql] {
            assert_eq!(WeaviateDriver::object_cell(&object, "_id"), json!("u-1"));
            assert_eq!(
                WeaviateDriver::object_cell(&object, "title"),
                json!("hello")
            );
            assert_eq!(WeaviateDriver::object_cell(&object, "missing"), Value::Null);
        }
    }

    #[test]
    fn single_statement_strips_one_trailing_semicolon() {
        assert_eq!(
            WeaviateDriver::single_statement("SELECT a FROM B;  ").unwrap(),
            "SELECT a FROM B"
        );
        assert!(WeaviateDriver::single_statement("SELECT a FROM B; SELECT 1").is_err());
        assert_eq!(
            WeaviateDriver::single_statement("SELECT 'x;y' FROM B").unwrap(),
            "SELECT 'x;y' FROM B"
        );
    }

    #[tokio::test]
    async fn driver_talks_to_a_live_weaviate_contract() {
        let app = Router::new()
            .route(
                "/v1/meta",
                get(|| async { Json(json!({ "version": "1.25.0" })) }),
            )
            .route(
                "/v1/schema",
                get(|| async {
                    Json(json!({
                        "classes": [{
                            "class": "Article",
                            "vectorizer": "text2vec-openai",
                            "properties": [
                                { "name": "title", "dataType": ["text"] },
                                { "name": "views", "dataType": ["int"] }
                            ]
                        }]
                    }))
                })
                .post(|Json(body): Json<Value>| async move {
                    assert_eq!(body["class"], json!("Comment"));
                    Json(json!({ "class": "Comment" }))
                }),
            )
            .route(
                "/v1/schema/Article",
                get(|| async {
                    Json(json!({
                        "class": "Article",
                        "properties": [
                            { "name": "title", "dataType": ["text"] },
                            { "name": "views", "dataType": ["int"] }
                        ]
                    }))
                }),
            )
            .route(
                "/v1/objects",
                get(|Query(params): Query<HashMap<String, String>>| async move {
                    if params.get("limit").map(String::as_str) == Some("0") {
                        return Json(json!({ "objects": [], "totalResults": 3 }));
                    }
                    Json(json!({
                        "objects": [
                            {
                                "id": "36b8f84d-df4e-4d49-b662-bcde71a8764f",
                                "class": "Article",
                                "properties": { "title": "one" }
                            }
                        ],
                        "totalResults": 3
                    }))
                })
                .post(|Json(body): Json<Value>| async move {
                    assert_eq!(body["class"], json!("Article"));
                    assert_eq!(body["properties"]["title"], json!("two"));
                    Json(json!({
                        "id": "36b8f84d-df4e-4d49-b662-bcde71a8764f",
                        "class": "Article"
                    }))
                }),
            )
            .route(
                "/v1/objects/:id",
                patch(
                    |AxumPath(id): AxumPath<String>, Json(body): Json<Value>| async move {
                        assert_eq!(id, "36b8f84d-df4e-4d49-b662-bcde71a8764f");
                        assert_eq!(body["properties"]["title"], json!("edited"));
                        Json(json!({}))
                    },
                )
                .delete(|AxumPath(id): AxumPath<String>| async move {
                    assert_eq!(id, "36b8f84d-df4e-4d49-b662-bcde71a8764f");
                    Json(json!({}))
                }),
            )
            .route(
                "/v1/graphql",
                axum::routing::post(
                    |headers: HeaderMap, Json(body): Json<Value>| async move {
                        assert!(headers.get("authorization").is_some_and(|value| {
                            value.to_str().unwrap_or("") == "Bearer test-key"
                        }));
                        let query = body["query"].as_str().unwrap_or_default().to_string();
                        if query.contains("Aggregate") {
                            return Json(json!({
                                "data": { "Aggregate": { "Article": { "meta": { "count": 7 } } } }
                            }));
                        }
                        assert!(query.contains("Get"));
                        assert!(query.contains("_additional"));
                        Json(json!({
                            "data": {
                                "Get": {
                                    "Article": [
                                        {
                                            "title": "one",
                                            "views": 5,
                                            "_additional": { "id": "36b8f84d-df4e-4d49-b662-bcde71a8764f" }
                                        }
                                    ]
                                }
                            }
                        }))
                    },
                ),
            );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let config = ConnectionConfig {
            id: "weaviate-test".to_string(),
            name: "Weaviate test".to_string(),
            host: Some("127.0.0.1".to_string()),
            port: Some(port),
            password: Some("test-key".to_string()),
            ..ConnectionConfig::default()
        };
        let driver = WeaviateDriver::connect(&config).await.unwrap();

        let tables = driver.list_tables(None).await.unwrap();
        assert_eq!(tables.len(), 1);
        assert_eq!(tables[0].name, "Article");
        assert_eq!(tables[0].engine.as_deref(), Some("text2vec-openai"));

        let structure = driver.get_table_structure("Article", None).await.unwrap();
        assert_eq!(structure.columns[0].name, "_id");
        assert!(structure.columns[0].is_primary_key);
        assert_eq!(structure.columns.len(), 3);

        let page = driver
            .get_table_data("Article", None, 0, 50, None, None, None)
            .await
            .unwrap();
        assert_eq!(page.rows.len(), 1);
        assert_eq!(
            page.rows[0][0],
            json!("36b8f84d-df4e-4d49-b662-bcde71a8764f")
        );
        assert!(page.truncated); // totalResults 3 > 1 fetched

        let result = driver
            .execute_query("SELECT title, views FROM Article WHERE views > 1 LIMIT 5")
            .await
            .unwrap();
        assert_eq!(result.rows.len(), 1);
        assert_eq!(result.columns[0].name, "_id");
        assert_eq!(result.rows[0][1], json!("one"));

        // INSERT → POST /v1/objects; PATCH → merge body; DELETE counts.
        let inserted = driver
            .insert_table_row(&TableRowInsertRequest {
                table: "Article".to_string(),
                database: None,
                values: vec![("title".to_string(), json!("two"))],
            })
            .await
            .unwrap();
        assert_eq!(inserted, 1);
        let updated = driver
            .update_table_cell(&TableCellUpdateRequest {
                table: "Article".to_string(),
                database: None,
                target_column: "title".to_string(),
                value: json!("edited"),
                primary_keys: vec![RowKeyValue {
                    column: "_id".to_string(),
                    value: json!("36b8f84d-df4e-4d49-b662-bcde71a8764f"),
                }],
            })
            .await
            .unwrap();
        assert_eq!(updated, 1);
        let deleted = driver
            .delete_table_rows(&TableRowDeleteRequest {
                table: "Article".to_string(),
                database: None,
                rows: vec![vec![RowKeyValue {
                    column: "_id".to_string(),
                    value: json!("36b8f84d-df4e-4d49-b662-bcde71a8764f"),
                }]],
            })
            .await
            .unwrap();
        assert_eq!(deleted, 1);

        let ddl = driver
            .execute_query("CREATE TABLE Comment (body text)")
            .await
            .unwrap();
        assert_eq!(ddl.affected_rows, 1);

        server.abort();
    }
}
