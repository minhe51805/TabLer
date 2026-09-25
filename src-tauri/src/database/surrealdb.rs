//! SurrealDB driver over the HTTP REST API.
//!
//! All statements run through `POST /rpc` with the `query` method. That
//! endpoint accepts the same SurrealQL scripts as `POST /sql` plus a typed
//! `vars` object in the request body, which is the only HTTP transport that
//! carries real bind values (`$name` parameters) — `POST /sql` only binds
//! URL query parameters. The response is one `{status, result}` envelope per
//! statement, in order.
//!
//! Authentication modes, resolved from the connection fields:
//!   - username + password → HTTP Basic on every request (the documented
//!     `-u root:secret` pattern; no token round-trip or expiry).
//!   - password only       → the password is treated as a bearer token.
//!   - neither             → unauthenticated (`surreal start --unauthenticated`).
//!
//! The SurrealDB namespace comes from `additional_fields["namespace"]` (or
//! `"ns"`); the database from the standard database field. Both ride on every
//! request as the `Surreal-NS`/`Surreal-DB` headers (legacy `NS`/`DB` aliases
//! are sent alongside for pre-2.x servers).
//!
//! Transactions: SurrealQL supports `BEGIN TRANSACTION` … `COMMIT` / `CANCEL`,
//! but the HTTP API is stateless — a transaction can only live inside a single
//! request. Every atomic operation therefore ships one `BEGIN…COMMIT` script
//! in one `/rpc` call; any statement error or `THROW` rolls the whole
//! transaction back server-side. Write previews use `BEGIN…CANCEL`, which is
//! rollback-only by construction.
//!
//! Row selectors: the primary-key selector column `id` holding a
//! `table:identifier` record link maps to a typed record comparison
//! (`id = type::record($t, $id)` — `type::thing` on SurrealDB < 3). Any other
//! selector column binds as a plain field equality. Numeric, UUID
//! (`person:⟨uuid⟩`), and datetime record-id parts keep their native types.
//!
//! Cancellation is client-side only: the HTTP request can be aborted, but the
//! server has no statement-kill endpoint, so `cancel_query_request` honestly
//! reports `false`.

use super::driver::DatabaseDriver;
use super::models::*;
use super::query_common::{statement_returns_rows, MAX_QUERY_RESULT_ROWS};
use super::safety::{
    normalize_order_dir, quote_clickhouse_identifier, quote_clickhouse_order_by,
    sanitize_clickhouse_filter_clause,
};
use crate::utils::sql::split_sql_statements;
use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use reqwest::{Client, RequestBuilder};
use serde::Deserialize;
use serde_json::{json, Map as JsonMap, Value as JsonValue};
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Instant;

/// Statements that produce a row set the result grid should display.
const ROW_STATEMENT_PREFIXES: &[&str] = &["SELECT", "RETURN", "INFO", "SHOW", "LIVE"];

/// Statements whose array/object `result` counts as affected rows. Envelopes
/// for these are excluded from the "last row-producing statement" display so a
/// trailing `INSERT … RETURN` never shadows a `SELECT` in the same script.
const WRITE_STATEMENT_PREFIXES: &[&str] = &[
    "INSERT", "UPDATE", "UPSERT", "DELETE", "CREATE", "RELATE", "REMOVE",
];

/// How the driver authenticates to the server.
enum SurrealAuth {
    Basic { username: String, password: String },
    Bearer(String),
    None,
}

/// One `{status, result, time}` entry of the `/sql`-style response array. The
/// `query` RPC method returns the same envelope shape wrapped in `{"result":…}`.
#[derive(Debug, Deserialize)]
struct SurrealEnvelope {
    #[serde(default = "default_ok_status")]
    status: String,
    #[serde(default)]
    result: JsonValue,
}

fn default_ok_status() -> String {
    "OK".to_string()
}

/// Named `$pN` binds accumulated while building one SurrealQL script. The
/// `/rpc` `vars` object is built once per request, so a single monotonically
/// increasing index keeps names unique across a whole transaction script.
#[derive(Default)]
struct SurrealBinds {
    vars: JsonMap<String, JsonValue>,
    next_index: u32,
}

impl SurrealBinds {
    /// Bind `value` and return its `$pN` placeholder text.
    fn push(&mut self, value: JsonValue) -> String {
        self.next_index += 1;
        let name = format!("p{}", self.next_index);
        self.vars.insert(name.clone(), value);
        format!("${name}")
    }
}

pub struct SurrealDbDriver {
    client: Client,
    base_url: String,
    auth: SurrealAuth,
    /// SurrealDB namespace from `additional_fields`; optional — a root-level
    /// login can browse namespaces without one.
    namespace: Option<String>,
    current_db: Arc<RwLock<Option<String>>>,
    /// `type::record` on SurrealDB 3.x, `type::thing` on 1.x/2.x — the
    /// function was renamed in the 3.0 breaking changes.
    record_fn: &'static str,
}

impl SurrealDbDriver {
    pub async fn connect(config: &ConnectionConfig) -> Result<Self> {
        let host = config
            .host
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .context("SurrealDB host is required")?;
        let port = config.port.unwrap_or(8000);
        let scheme = if config.use_ssl { "https" } else { "http" };
        // Allow the host field to carry a full URL for gateway deployments.
        let base_url = if host.contains("://") {
            host.trim_end_matches('/').to_string()
        } else {
            format!("{scheme}://{host}:{port}")
        };
        let namespace = config
            .additional_fields
            .get("namespace")
            .or_else(|| config.additional_fields.get("ns"))
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let username = config
            .username
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let password = config
            .password
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let auth = match (username, password) {
            (Some(username), Some(password)) => SurrealAuth::Basic { username, password },
            (None, Some(token)) => SurrealAuth::Bearer(token),
            // A username without a password cannot authenticate; fall back to
            // an unauthenticated session rather than silently guessing.
            _ => SurrealAuth::None,
        };

        let driver = Self {
            client: Client::builder()
                .build()
                .context("Failed to initialize the SurrealDB HTTP client")?,
            base_url,
            auth,
            namespace,
            current_db: Arc::new(RwLock::new(config.database.clone())),
            // SurrealDB 3.x is the current line; when the version probe is
            // inconclusive assume it — a 1.x/2.x server only loses the
            // record-link fast path, not correctness (the server errors).
            record_fn: "type::record",
        };
        let driver = Self {
            record_fn: match driver.server_major_version().await {
                Some(major) if major < 3 => "type::thing",
                _ => driver.record_fn,
            },
            ..driver
        };

        // Cheap verification: RETURN 1 parses and evaluates under the
        // configured namespace/database headers and the resolved auth.
        driver
            .run_script("RETURN 1;", &SurrealBinds::default(), None)
            .await
            .context("SurrealDB connection check failed")?;
        Ok(driver)
    }

    /// `GET /version` answers `surrealdb-X.Y.Z`; the major version selects the
    /// record constructor name (renamed in 3.0). A probe failure is not fatal:
    /// the server may restrict the route, and the driver still works.
    async fn server_major_version(&self) -> Option<u32> {
        let response = self
            .apply_auth(self.client.get(format!("{}/version", self.base_url)))
            .send()
            .await
            .ok()?;
        let text = response.text().await.ok()?;
        let digits: String = text
            .trim()
            .chars()
            .skip_while(|ch| !ch.is_ascii_digit())
            .take_while(|ch| ch.is_ascii_digit() || *ch == '.')
            .collect();
        digits.split('.').next()?.parse().ok()
    }

    fn resolve_db(&self, database: Option<&str>) -> Option<String> {
        database
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| self.current_db.read().ok().and_then(|guard| guard.clone()))
    }

    fn require_db(&self, database: Option<&str>) -> Result<String> {
        self.resolve_db(database).ok_or_else(|| {
            anyhow!(
                "SurrealDB requires a database selection: set the database field on the connection or call use_database first"
            )
        })
    }

    /// Bearer token or HTTP Basic on every request, plus the JSON accept type.
    fn apply_auth(&self, request: RequestBuilder) -> RequestBuilder {
        let request = request.header("Accept", "application/json");
        match &self.auth {
            SurrealAuth::Basic { username, password } => {
                request.basic_auth(username, Some(password))
            }
            SurrealAuth::Bearer(token) => request.bearer_auth(token),
            SurrealAuth::None => request,
        }
    }

    /// `POST /rpc` with `{"method":"query","params":[sql, vars]}`. The `vars`
    /// object is how SurrealQL `$name` parameters receive typed values — this
    /// is the only place the driver ever attaches values to a query.
    fn rpc_request(
        &self,
        sql: &str,
        vars: &SurrealBinds,
        database: Option<&str>,
    ) -> RequestBuilder {
        let mut request = self
            .apply_auth(self.client.post(format!("{}/rpc", self.base_url)))
            .header("Content-Type", "application/json")
            .json(&json!({
                "id": 1,
                "method": "query",
                "params": [sql, JsonValue::Object(vars.vars.clone())],
            }));
        if let Some(namespace) = &self.namespace {
            request = request
                .header("Surreal-NS", namespace)
                .header("NS", namespace);
        }
        if let Some(database) = database {
            request = request
                .header("Surreal-DB", database)
                .header("DB", database);
        }
        request
    }

    /// Send one script and return the per-statement envelopes. Transport and
    /// RPC-level failures surface here; statement-level `ERR` envelopes are
    /// checked by the caller (they name the failing statement).
    async fn send_script(
        &self,
        sql: &str,
        vars: &SurrealBinds,
        database: Option<&str>,
    ) -> Result<Vec<SurrealEnvelope>> {
        let response = self
            .rpc_request(sql, vars, database)
            .send()
            .await
            .context("Failed to reach the SurrealDB server")?;
        let status = response.status();
        let body = response
            .text()
            .await
            .context("Failed to read the SurrealDB response")?;
        let parsed: Option<JsonValue> = serde_json::from_str(&body).ok();
        if !status.is_success() {
            bail!(
                "SurrealDB request failed with status {}: {}",
                status.as_u16(),
                error_detail(parsed.as_ref(), &body)
            );
        }
        let value = parsed.context("SurrealDB returned a non-JSON response")?;
        // The `query` method wraps envelopes in {"result":[…]}; {"error":…}
        // carries RPC-level failures. A bare envelope array is also accepted
        // for forward compatibility with plain /sql-shaped answers.
        if let Some(error) = value.get("error") {
            bail!(
                "SurrealDB query failed: {}",
                error_detail(Some(error), &body)
            );
        }
        let payload = value.get("result").cloned().unwrap_or(value);
        let JsonValue::Array(envelopes) = payload else {
            bail!("SurrealDB returned an unexpected response shape");
        };
        serde_json::from_value(JsonValue::Array(envelopes))
            .context("Failed to parse the SurrealDB response")
    }

    /// Bail on the first statement envelope reporting an error. Inside a
    /// `BEGIN…COMMIT` script the engine already rolled the transaction back
    /// when the statement failed, so reporting it is all that remains.
    fn check_envelopes(envelopes: &[SurrealEnvelope], context: &str) -> Result<()> {
        for (index, envelope) in envelopes.iter().enumerate() {
            if !envelope.status.eq_ignore_ascii_case("ok") {
                bail!(
                    "{context}: SurrealDB statement {} failed: {}",
                    index + 1,
                    envelope.result
                );
            }
        }
        Ok(())
    }

    /// Send a script, then fail on the first `ERR` statement envelope.
    async fn run_script(
        &self,
        sql: &str,
        vars: &SurrealBinds,
        database: Option<&str>,
    ) -> Result<Vec<SurrealEnvelope>> {
        let envelopes = self.send_script(sql, vars, database).await?;
        Self::check_envelopes(&envelopes, "Query")?;
        Ok(envelopes)
    }

    /// Last envelope's `result` — metadata statements run as a single-statement
    /// script, so the last envelope is the answer.
    async fn query_last_result(
        &self,
        sql: &str,
        vars: &SurrealBinds,
        database: Option<&str>,
    ) -> Result<JsonValue> {
        Ok(self
            .run_script(sql, vars, database)
            .await?
            .pop()
            .map(|envelope| envelope.result)
            .unwrap_or(JsonValue::Null))
    }

    /// Map envelopes onto a `QueryResult`: the displayed rows come from the
    /// last statement classified as row-producing (falling back to any
    /// envelope that returned rows), and `affected_rows` sums the write
    /// statements' result sizes.
    fn build_result(
        &self,
        envelopes: Vec<SurrealEnvelope>,
        sql: &str,
        elapsed_ms: u128,
        row_cap: usize,
    ) -> QueryResult {
        let statements = split_sql_statements(sql);
        let paired = statements.len().min(envelopes.len());
        let mut affected_rows = 0u64;
        let mut display: Option<usize> = None;
        for index in 0..paired {
            if statement_returns_rows(&statements[index], ROW_STATEMENT_PREFIXES) {
                display = Some(index);
            } else if statement_returns_rows(&statements[index], WRITE_STATEMENT_PREFIXES) {
                affected_rows =
                    affected_rows.saturating_add(surreal_affected(&envelopes[index].result));
            }
        }
        if display.is_none() {
            // No statement was classified row-producing — show the last
            // envelope that actually returned rows (e.g. a bare `UPDATE …
            // RETURN AFTER` typed into the editor).
            display = envelopes
                .iter()
                .rposition(|envelope| !surreal_result_rows(&envelope.result).0.is_empty());
        }
        let (columns, rows, truncated) = match display {
            Some(index) => {
                let (columns, rows) = surreal_result_rows(&envelopes[index].result);
                let truncated = rows.len() > row_cap;
                (columns, rows, truncated)
            }
            None => (Vec::new(), Vec::new(), false),
        };
        QueryResult {
            columns: columns
                .iter()
                .enumerate()
                .map(|(position, name)| ColumnInfo {
                    name: name.clone(),
                    data_type: rows
                        .iter()
                        .find_map(|row| row.get(position))
                        .map_or_else(|| "any".to_string(), surreal_type_name),
                    is_nullable: true,
                    is_primary_key: name == "id",
                    max_length: None,
                    default_value: None,
                })
                .collect(),
            rows: rows.into_iter().take(row_cap).collect(),
            affected_rows,
            execution_time_ms: elapsed_ms,
            query: sql.to_string(),
            sandboxed: false,
            truncated,
        }
    }

    /// Shared body of `execute_query` and `execute_parameterized_query`:
    /// one `/rpc` round trip carrying the full SurrealQL script — the server
    /// executes the statements in order and answers one envelope each.
    async fn execute_inner(&self, sql: &str, vars: &SurrealBinds) -> Result<QueryResult> {
        let start = Instant::now();
        let envelopes = self
            .run_script(sql, vars, self.resolve_db(None).as_deref())
            .await?;
        Ok(self.build_result(
            envelopes,
            sql,
            start.elapsed().as_millis(),
            MAX_QUERY_RESULT_ROWS,
        ))
    }

    /// `UPDATE` for one cell edit plus, for atomic queues, an existence gate.
    /// The gate runs inside the same transaction and `THROW`s when the
    /// primary-key selector matches nothing, rolling the whole queue back —
    /// an `UPDATE` touching zero rows is otherwise a silent success.
    fn update_statements(
        &self,
        request: &TableCellUpdateRequest,
        binds: &mut SurrealBinds,
    ) -> Result<Vec<String>> {
        if request.primary_keys.is_empty() {
            return Err(anyhow!(
                "Inline update requires at least one primary key column"
            ));
        }
        let table = qualify_surreal_table(&request.table)?;
        let condition = self.pk_condition(&request.primary_keys, &request.table, binds)?;
        let set_placeholder = binds.push(request.value.clone());
        let update = format!(
            "UPDATE {table} SET {} = {set_placeholder} WHERE {condition} RETURN AFTER",
            quote_surreal_identifier(&request.target_column)?,
        );
        let check = format!(
            "IF array::len((SELECT VALUE id FROM {table} WHERE {condition} LIMIT 1)) = 0 \
             {{ THROW 'An edit queue row no longer matches its primary-key selector' }}"
        );
        Ok(vec![check, update])
    }

    /// `INSERT INTO t (cols) VALUES ($p…)` with every value bound, sharing the
    /// caller's bind map so a transaction script gets unique `$pN` names.
    fn insert_statement_into(
        &self,
        request: &TableRowInsertRequest,
        binds: &mut SurrealBinds,
    ) -> Result<String> {
        if request.values.is_empty() {
            return Err(anyhow!("Insert requires at least one column value"));
        }
        let mut columns = Vec::with_capacity(request.values.len());
        let mut placeholders = Vec::with_capacity(request.values.len());
        for (column, value) in &request.values {
            columns.push(quote_surreal_identifier(column)?);
            placeholders.push(binds.push(value.clone()));
        }
        Ok(format!(
            "INSERT INTO {} ({}) VALUES ({}) RETURN AFTER",
            qualify_surreal_table(&request.table)?,
            columns.join(", "),
            placeholders.join(", "),
        ))
    }

    /// `BEGIN TRANSACTION ; stmt1 ; … ; tail` — a transaction can only live
    /// inside one HTTP request, so the whole batch ships as one script.
    fn transaction_script(pieces: &[String], tail: &str) -> String {
        let mut script = String::from("BEGIN TRANSACTION");
        for piece in pieces {
            script.push_str(";\n");
            script.push_str(piece);
        }
        script.push_str(";\n");
        script.push_str(tail);
        script
    }

    /// Primary-key selector → SurrealQL condition. An `id` key holding a
    /// `table:identifier` record link compiles to a typed record comparison
    /// (the table part must match the edited table); every other selector
    /// binds as field equality, `NONE`/`NULL` matching both a missing field
    /// and a stored `null`.
    fn pk_condition(
        &self,
        keys: &[RowKeyValue],
        table: &str,
        binds: &mut SurrealBinds,
    ) -> Result<String> {
        let expected = unquote_surreal_name(table);
        let mut conditions = Vec::with_capacity(keys.len());
        for key in keys {
            let column = quote_surreal_identifier(&key.column)?;
            if key.value.is_null() {
                conditions.push(format!("({column} IS NONE OR {column} IS NULL)"));
                continue;
            }
            if key.column.eq_ignore_ascii_case("id") {
                if let Some(record_id) = key.value.as_str() {
                    if let Some((record_table, record_part)) = record_id.split_once(':') {
                        if !record_table.eq_ignore_ascii_case(&expected) {
                            return Err(anyhow!(
                                "Record id '{record_id}' does not match table '{table}'"
                            ));
                        }
                        let table_bind = binds.push(JsonValue::String(record_table.to_string()));
                        let record_expr = record_id_expr(record_part, binds);
                        conditions.push(format!(
                            "id = {}({table_bind}, {record_expr})",
                            self.record_fn
                        ));
                        continue;
                    }
                }
            }
            let placeholder = binds.push(key.value.clone());
            conditions.push(format!("{column} = {placeholder}"));
        }
        Ok(conditions.join(" AND "))
    }

    /// Run a `BEGIN…COMMIT` script; on any `ERR` envelope the engine has
    /// already rolled the transaction back, so the error just propagates.
    async fn run_transaction(
        &self,
        pieces: Vec<String>,
        binds: &SurrealBinds,
        database: Option<&str>,
    ) -> Result<Vec<SurrealEnvelope>> {
        let script = Self::transaction_script(&pieces, "COMMIT TRANSACTION");
        let envelopes = self
            .send_script(&script, binds, database)
            .await
            .context("SurrealDB transaction request failed")?;
        Self::check_envelopes(&envelopes, "SurrealDB transaction rolled back")?;
        Ok(envelopes)
    }
}

/// SurrealQL expression for the id part of a `table:id` record link. Numbers
/// keep their numeric id, `⟨uuid⟩` shapes become real UUIDs, `⟨d'…'⟩`
/// datetimes keep theirs; anything else is a string id.
fn record_id_expr(id_part: &str, binds: &mut SurrealBinds) -> String {
    let inner = unquote_surreal_name(id_part);
    if let Some(datetime) = inner
        .strip_prefix("d'")
        .and_then(|rest| rest.strip_suffix('\''))
    {
        let placeholder = binds.push(JsonValue::String(datetime.to_string()));
        return format!("type::datetime({placeholder})");
    }
    if is_uuid_shape(&inner) {
        let placeholder = binds.push(JsonValue::String(inner));
        return format!("type::uuid({placeholder})");
    }
    if let Ok(number) = inner.parse::<i64>() {
        return binds.push(JsonValue::from(number));
    }
    if let Ok(number) = inner.parse::<u64>() {
        return binds.push(JsonValue::from(number));
    }
    binds.push(JsonValue::String(inner))
}

/// Extract a readable error message out of a failed HTTP/RPC response body.
fn error_detail<'a>(parsed: Option<&'a JsonValue>, raw: &'a str) -> String {
    if let Some(value) = parsed {
        for key in ["message", "description", "information", "details"] {
            if let Some(text) = value.get(key).and_then(|v| v.as_str()) {
                return text.to_string();
            }
        }
        if let Some(text) = value.as_str() {
            return text.to_string();
        }
        return value.to_string();
    }
    raw.trim().to_string()
}

/// Affected-row count for one statement envelope: array results carry one
/// entry per affected/returned record; a single object means one record.
fn surreal_affected(result: &JsonValue) -> u64 {
    match result {
        JsonValue::Array(rows) => rows.len() as u64,
        JsonValue::Object(_) => 1,
        _ => 0,
    }
}

/// Map one envelope's `result` value to `(column names, row vectors)`.
/// Arrays of objects become a column-per-key grid (union of keys, first-seen
/// order, missing keys padded with `null`); anything else collapses to a
/// single `result` column.
fn surreal_result_rows(result: &JsonValue) -> (Vec<String>, Vec<Vec<JsonValue>>) {
    match result {
        JsonValue::Array(items) if items.iter().all(|item| item.is_object()) => {
            let mut columns: Vec<String> = Vec::new();
            let mut seen = BTreeSet::new();
            for item in items {
                if let JsonValue::Object(map) = item {
                    for key in map.keys() {
                        if seen.insert(key.clone()) {
                            columns.push(key.clone());
                        }
                    }
                }
            }
            let rows = items
                .iter()
                .map(|item| {
                    let JsonValue::Object(map) = item else {
                        return Vec::new();
                    };
                    columns
                        .iter()
                        .map(|column| map.get(column).cloned().unwrap_or(JsonValue::Null))
                        .collect()
                })
                .collect();
            (columns, rows)
        }
        JsonValue::Array(items) => (
            vec!["result".to_string()],
            items.iter().map(|item| vec![item.clone()]).collect(),
        ),
        JsonValue::Object(map) => {
            let columns: Vec<String> = map.keys().cloned().collect();
            let rows = vec![columns
                .iter()
                .map(|column| map.get(column).cloned().unwrap_or(JsonValue::Null))
                .collect()];
            (columns, rows)
        }
        JsonValue::Null => (Vec::new(), Vec::new()),
        scalar => (vec!["result".to_string()], vec![vec![scalar.clone()]]),
    }
}

/// Loose type name for a JSON value, used to fill `ColumnInfo.data_type`.
/// Serialized record links arrive as `"table:identifier"` strings.
fn surreal_type_name(value: &JsonValue) -> String {
    match value {
        JsonValue::Null => "null",
        JsonValue::Bool(_) => "bool",
        JsonValue::Number(number) if number.is_i64() || number.is_u64() => "int",
        JsonValue::Number(_) => "float",
        JsonValue::String(text) if is_record_link_text(text) => "record",
        JsonValue::String(_) => "string",
        JsonValue::Array(_) => "array",
        JsonValue::Object(_) => "object",
    }
    .to_string()
}

/// `name:id` record-link shape: a bare identifier, one colon, and a non-empty
/// id part (numbers, words, `⟨…⟩`, `u'…'`, `d'…'` all qualify).
fn is_record_link_text(text: &str) -> bool {
    let Some((table, id)) = text.split_once(':') else {
        return false;
    };
    !id.is_empty()
        && !id.contains(':')
        && !table.is_empty()
        && table
            .chars()
            .all(|ch| ch.is_alphanumeric() || matches!(ch, '_' | '-'))
}

/// Quote a SurrealQL identifier. Backticks are the standard delimiter; a name
/// containing a backtick falls back to `⟨…⟩` bracket quoting (which SurrealQL
/// accepts for both record ids and identifiers).
fn quote_surreal_identifier(value: &str) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("Identifier cannot be empty"));
    }
    if trimmed.contains('⟨') || trimmed.contains('⟩') {
        return Err(anyhow!("Identifier contains invalid bracket characters"));
    }
    if trimmed
        .chars()
        .any(|ch| matches!(ch, '\0' | '\r' | '\n' | '\t'))
    {
        return Err(anyhow!("Identifier contains invalid control characters"));
    }
    if trimmed.contains('`') {
        Ok(format!("⟨{trimmed}⟩"))
    } else {
        quote_clickhouse_identifier(trimmed)
    }
}

/// Quote a table reference; SurrealDB has no schema qualifier, so `db.table`
/// input is rejected rather than silently truncated.
fn qualify_surreal_table(table: &str) -> Result<String> {
    let parts: Vec<&str> = table
        .split('.')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect();
    match parts.as_slice() {
        [name] => quote_surreal_identifier(name),
        _ => Err(anyhow!(
            "SurrealDB table names do not support schema qualification"
        )),
    }
}

/// Quote an ORDER BY column reference (`col` or `alias.col`).
fn quote_surreal_order_by(column: &str) -> Result<String> {
    // Reuse the clickhouse-shaped dotted-name quoting; per-segment backtick
    // quoting is exactly what SurrealQL expects.
    if column.contains('`') || column.contains('⟨') {
        return quote_surreal_identifier(column.trim());
    }
    quote_clickhouse_order_by(column)
}

/// Reverse a backtick/`⟨⟩`-quoted name back to its bare form, as produced by
/// `INFO FOR` maps and needed to compare `table:id` record-link table parts.
fn unquote_surreal_name(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.starts_with('⟨') && trimmed.ends_with('⟩') && trimmed.len() >= "⟨⟩".len() {
        return trimmed["⟨".len()..trimmed.len() - "⟩".len()].to_string();
    }
    if trimmed.starts_with('`') && trimmed.ends_with('`') && trimmed.len() >= 2 {
        return trimmed[1..trimmed.len() - 1]
            .replace("\\`", "`")
            .replace("\\\\", "\\");
    }
    trimmed.to_string()
}

fn is_uuid_shape(value: &str) -> bool {
    let mut groups = 0usize;
    let mut count = 0usize;
    for ch in value.chars() {
        if ch == '-' {
            groups += 1;
            continue;
        }
        if !ch.is_ascii_hexdigit() {
            return false;
        }
        count += 1;
    }
    groups == 4 && count == 32
}

/// Escape a SurrealQL single-quoted string literal.
fn surreal_string_literal(value: &str) -> String {
    let escaped = value.replace('\\', "\\\\").replace('\'', "\\'");
    format!("'{escaped}'")
}

/// Undo the `''` doubling the shared filter parser preserves inside string
/// literals, yielding the raw text.
fn unescape_filter_literal(literal: &str) -> Option<String> {
    let inner = literal.strip_prefix('\'')?.strip_suffix('\'')?;
    Some(inner.replace("''", "'"))
}

/// Translate the sanitized `identifier op literal` filter grammar into
/// SurrealQL. The shared parser emits canonical `LIKE` and `<>` operators;
/// SurrealQL has neither, so they map to `string::starts_with` /
/// `string::ends_with` / `string::contains` (wildcard position decides) and
/// `!=`. Non-`%`/`%…%` LIKE shapes (single-char `_`, interior wildcards) are
/// rejected rather than mistranslated.
fn translate_surreal_filter(filter: Option<&str>) -> Result<Option<String>> {
    let Some(clause) = sanitize_clickhouse_filter_clause(filter)? else {
        return Ok(None);
    };
    Ok(Some(translate_surreal_clause(&clause)?))
}

/// Split on top-level AND/OR connectors (quote-aware) and translate each
/// `identifier op literal` condition.
fn translate_surreal_clause(clause: &str) -> Result<String> {
    let mut output = String::new();
    let mut rest = clause.trim();
    loop {
        let (condition, connector) = split_filter_condition(rest)?;
        output.push_str(&translate_surreal_condition(condition.trim())?);
        match connector {
            Some((word, after)) => {
                output.push(' ');
                output.push_str(word);
                output.push(' ');
                rest = after.trim_start();
            }
            None => break,
        }
    }
    Ok(output)
}

/// Find the next top-level ` AND `/` OR ` outside quotes. Returns the
/// condition text and, when found, the connector word plus the remainder.
fn split_filter_condition(input: &str) -> Result<(&str, Option<(&'static str, &str)>)> {
    let bytes = input.as_bytes();
    let mut in_string = false;
    let mut index = 0usize;
    while index < bytes.len() {
        let byte = bytes[index];
        if in_string {
            if byte == b'\'' {
                // The shared parser doubles quotes inside literals.
                if bytes.get(index + 1) == Some(&b'\'') {
                    index += 2;
                    continue;
                }
                in_string = false;
            }
            index += 1;
            continue;
        }
        if byte == b'\'' {
            in_string = true;
            index += 1;
            continue;
        }
        if byte.is_ascii_whitespace() {
            let tail = &input[index..];
            for word in ["AND", "OR"] {
                let probe = tail.trim_start_matches(|c: char| c.is_ascii_whitespace());
                if probe.len() > word.len()
                    && probe[..word.len()].eq_ignore_ascii_case(word)
                    && probe.as_bytes()[word.len()].is_ascii_whitespace()
                {
                    let word_static: &'static str = if word == "AND" { "AND" } else { "OR" };
                    let connector_start = index + (tail.len() - probe.len());
                    return Ok((
                        input[..index].trim_end(),
                        Some((word_static, &input[connector_start + word.len()..])),
                    ));
                }
            }
        }
        index += 1;
    }
    Ok((input, None))
}

/// Translate one `identifier op literal` condition; non-LIKE/non-`<>` clauses
/// pass through unchanged (the sanitizer already proved their grammar).
/// Scans are char-wise so UTF-8 literal text is never mangled.
fn translate_surreal_condition(condition: &str) -> Result<String> {
    let chars: Vec<char> = condition.chars().collect();
    let next_char = |index: usize| chars.get(index + 1).copied();

    // Pass 1: `<>` → `!=` outside quoted literals.
    let mut cleaned = String::with_capacity(condition.len());
    let mut in_string = false;
    let mut index = 0usize;
    while index < chars.len() {
        let ch = chars[index];
        if in_string {
            cleaned.push(ch);
            if ch == '\'' {
                // The shared parser doubles quotes inside literals.
                if next_char(index) == Some('\'') {
                    cleaned.push('\'');
                    index += 2;
                    continue;
                }
                in_string = false;
            }
            index += 1;
            continue;
        }
        if ch == '\'' {
            in_string = true;
            cleaned.push(ch);
            index += 1;
            continue;
        }
        if ch == '<' && next_char(index) == Some('>') {
            cleaned.push_str("!=");
            index += 2;
            continue;
        }
        cleaned.push(ch);
        index += 1;
    }

    // Pass 2: find ` LIKE ` outside quoted literals and translate it.
    let chars: Vec<char> = cleaned.chars().collect();
    let mut in_string = false;
    let mut index = 0usize;
    while index < chars.len() {
        let ch = chars[index];
        if in_string {
            if ch == '\'' {
                if chars.get(index + 1) == Some(&'\'') {
                    index += 2;
                    continue;
                }
                in_string = false;
            }
            index += 1;
            continue;
        }
        if ch == '\'' {
            in_string = true;
            index += 1;
            continue;
        }
        if ch.is_ascii_whitespace() {
            let probe: String = chars[index..]
                .iter()
                .skip_while(|c| c.is_ascii_whitespace())
                .collect();
            let keyword: String = probe.chars().take(4).collect();
            let bounded = probe
                .chars()
                .nth(4)
                .is_none_or(|next| next.is_ascii_whitespace());
            if bounded && keyword.eq_ignore_ascii_case("LIKE") {
                let identifier: String = chars[..index].iter().collect();
                let literal = probe[4..].trim_start();
                return translate_like(identifier.trim(), literal);
            }
        }
        index += 1;
    }
    Ok(cleaned)
}

/// `ident LIKE 'lit'` → the `string::*` function matching the wildcard shape.
fn translate_like(identifier: &str, literal: &str) -> Result<String> {
    let raw = unescape_filter_literal(literal)
        .ok_or_else(|| anyhow!("LIKE only supports quoted string patterns"))?;
    let leading = raw.starts_with('%');
    let trailing = raw.ends_with('%') && raw.len() > 1;
    let pattern = raw
        .trim_start_matches('%')
        .trim_end_matches('%')
        .to_string();
    if pattern.contains('%') || pattern.contains('_') {
        return Err(anyhow!(
            "SurrealDB filters only support %%…%%, %%…, and …%% LIKE patterns"
        ));
    }
    let value = surreal_string_literal(&pattern);
    Ok(match (leading, trailing) {
        (true, true) => format!("string::contains({identifier}, {value})"),
        (false, true) => format!("string::starts_with({identifier}, {value})"),
        (true, false) => format!("string::ends_with({identifier}, {value})"),
        (false, false) => format!("{identifier} = {value}"),
    })
}

/// Rewrite positional `?` markers to `$p1..$pN` names, scanning past string
/// literals (`'`/`"`), comments (`--`, `//`, `#`, `/* */`), record ids
/// (`⟨…⟩`), and `?`-prefixed SurrealQL operators (`?=`, `?~`, `??`).
fn rewrite_question_marks(sql: &str) -> Result<(String, usize)> {
    let mut output = String::with_capacity(sql.len());
    let mut count = 0usize;
    let mut in_string: Option<char> = None;
    let mut in_line_comment = false;
    let mut in_block_comment = false;
    let mut in_record_id = false;
    let chars: Vec<char> = sql.chars().collect();
    let mut index = 0usize;
    while index < chars.len() {
        let ch = chars[index];
        let next = chars.get(index + 1).copied();
        if in_line_comment {
            output.push(ch);
            if ch == '\n' {
                in_line_comment = false;
            }
            index += 1;
            continue;
        }
        if in_block_comment {
            output.push(ch);
            if ch == '*' && next == Some('/') {
                output.push('/');
                index += 2;
                in_block_comment = false;
                continue;
            }
            index += 1;
            continue;
        }
        if let Some(quote) = in_string {
            output.push(ch);
            if ch == '\\' {
                if let Some(escaped) = next {
                    output.push(escaped);
                    index += 2;
                    continue;
                }
            }
            if ch == quote {
                in_string = None;
            }
            index += 1;
            continue;
        }
        if in_record_id {
            output.push(ch);
            if ch == '⟩' {
                in_record_id = false;
            }
            index += 1;
            continue;
        }
        if ch == '-' && next == Some('-') || ch == '/' && next == Some('/') || ch == '#' {
            in_line_comment = true;
            output.push(ch);
            index += 1;
            continue;
        }
        if ch == '/' && next == Some('*') {
            in_block_comment = true;
            output.push(ch);
            index += 1;
            continue;
        }
        if matches!(ch, '\'' | '"') {
            in_string = Some(ch);
            output.push(ch);
            index += 1;
            continue;
        }
        if ch == '?' {
            // `?=` (any-equals), `?~` (any fuzzy match) and `?!` are operators,
            // and `??` is the coalescing operator — none are bind markers.
            match next {
                Some('?') => {
                    output.push_str("??");
                    index += 2;
                    continue;
                }
                Some('=') | Some('~') | Some('!') => {
                    output.push('?');
                    index += 1;
                    continue;
                }
                _ => {
                    count += 1;
                    output.push_str(&format!("$p{count}"));
                    index += 1;
                    continue;
                }
            }
        }
        output.push(ch);
        index += 1;
    }
    Ok((output, count))
}

/// Find a key in an `INFO FOR` object tolerating both the current long names
/// (`tables`, `fields`, `indexes`, `functions`, `databases`, `namespaces`)
/// and the abbreviated aliases older builds serialized (`tb`, `fd`, `ix`,
/// `fn`, `db`, `ns`).
fn info_section<'a>(info: &'a JsonValue, names: &[&str]) -> Option<&'a JsonMap<String, JsonValue>> {
    for name in names {
        if let Some(section) = info.get(*name).and_then(|value| value.as_object()) {
            return Some(section);
        }
    }
    None
}

/// Whitespace-split a `DEFINE` statement into tokens without breaking quoted
/// names (`` `…` ``/`⟨…⟩`) or generic types (`option<record<user>>`).
fn surreal_tokens(definition: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut backtick = false;
    let mut bracket = false;
    let mut angle_depth = 0usize;
    for ch in definition.chars() {
        if backtick {
            current.push(ch);
            if ch == '`' {
                backtick = false;
            }
            continue;
        }
        if bracket {
            current.push(ch);
            if ch == '⟩' {
                bracket = false;
            }
            continue;
        }
        match ch {
            '`' => {
                backtick = true;
                current.push(ch);
            }
            '⟨' => {
                bracket = true;
                current.push(ch);
            }
            '<' => {
                angle_depth += 1;
                current.push(ch);
            }
            '>' => {
                angle_depth = angle_depth.saturating_sub(1);
                current.push(ch);
            }
            _ if ch.is_whitespace() && angle_depth == 0 => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(ch),
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

/// Position of a keyword inside a token stream (case-insensitive).
fn token_index(tokens: &[String], keyword: &str) -> Option<usize> {
    tokens
        .iter()
        .position(|token| token.eq_ignore_ascii_case(keyword))
}

/// Position of a keyword at or after `start` inside a token stream
/// (case-insensitive) — keywords must never match a field/index name they
/// precede in the definition text.
fn token_index_after(tokens: &[String], keyword: &str, start: usize) -> Option<usize> {
    tokens
        .iter()
        .skip(start)
        .position(|token| token.eq_ignore_ascii_case(keyword))
        .map(|position| position + start)
}

/// Parse one `DEFINE FIELD name ON TABLE t TYPE kind [DEFAULT expr] …`
/// definition into a `ColumnDetail`.
fn parse_define_field(definition: &str) -> Option<ColumnDetail> {
    let tokens = surreal_tokens(definition);
    if tokens.len() < 3 || !tokens.first()?.eq_ignore_ascii_case("DEFINE") {
        return None;
    }
    if !token_index(&tokens, "FIELD").is_some_and(|index| index == 1) {
        return None;
    }
    let name = unquote_surreal_name(tokens.get(2)?);
    let type_index = token_index_after(&tokens, "TYPE", 3);
    // The type runs until the next clause keyword; every candidate must sit
    // after TYPE so a `default`-named field cannot truncate the type text.
    let after_type = type_index.map(|index| index + 1).unwrap_or(3);
    let end_clause = [
        "DEFAULT",
        "VALUE",
        "ASSERT",
        "PERMISSIONS",
        "COMMENT",
        "REFERENCE",
        "READONLY",
    ]
    .into_iter()
    .filter_map(|keyword| token_index_after(&tokens, keyword, after_type))
    .min()
    .unwrap_or(tokens.len());
    let data_type = match type_index {
        Some(index) => tokens[index + 1..end_clause].join(" "),
        None => "any".to_string(),
    };
    let nullable = data_type.is_empty()
        || data_type.eq_ignore_ascii_case("any")
        || data_type.to_ascii_lowercase().starts_with("option<");
    let default_value = token_index_after(&tokens, "DEFAULT", after_type).map(|index| {
        let value_end = [
            "VALUE",
            "ASSERT",
            "PERMISSIONS",
            "COMMENT",
            "REFERENCE",
            "READONLY",
        ]
        .into_iter()
        .filter_map(|keyword| token_index_after(&tokens, keyword, index + 1))
        .min()
        .unwrap_or(tokens.len());
        tokens[index + 1..value_end].join(" ")
    });
    Some(ColumnDetail {
        is_primary_key: name == "id",
        name,
        data_type: if data_type.is_empty() {
            "any".to_string()
        } else {
            data_type
        },
        is_nullable: nullable,
        default_value,
        extra: None,
        column_type: None,
        comment: None,
    })
}

/// Parse one `DEFINE INDEX name ON TABLE t (FIELDS|COLUMNS) a, b [UNIQUE]`.
fn parse_define_index(definition: &str) -> Option<IndexInfo> {
    let tokens = surreal_tokens(definition);
    if tokens.len() < 3 || !token_index(&tokens, "INDEX").is_some_and(|index| index == 1) {
        return None;
    }
    let name = unquote_surreal_name(tokens.get(2)?);
    let fields_index =
        token_index(&tokens, "FIELDS").or_else(|| token_index(&tokens, "COLUMNS"))?;
    // Clause keywords only count after the first field token, so a field
    // named `unique`/`search` cannot truncate its own column list.
    let stop = ["UNIQUE", "SEARCH", "COMMENT", "WITH", "MTREE", "HNSW"]
        .into_iter()
        .filter_map(|keyword| token_index_after(&tokens, keyword, fields_index + 2))
        .min()
        .unwrap_or(tokens.len());
    let unique = token_index_after(&tokens, "UNIQUE", fields_index + 1).is_some();
    // Field lists are comma separated and may carry per-field suffixes
    // (COUNT/ASC/DESC/COLLATE/ANALYZER) that do not belong in the column list.
    let columns: Vec<String> = tokens[fields_index + 1..stop]
        .join(" ")
        .split(',')
        .map(|part| {
            let field = part.trim();
            let cut = field
                .find(|ch: char| ch.is_ascii_whitespace())
                .unwrap_or(field.len());
            unquote_surreal_name(&field[..cut])
        })
        .filter(|name| !name.is_empty())
        .collect();
    Some(IndexInfo {
        name,
        columns,
        is_unique: unique,
        index_type: None,
    })
}

/// Parse one `DEFINE EVENT name ON TABLE t WHEN … THEN …` into a trigger row.
fn parse_define_event(definition: &str) -> Option<TriggerInfo> {
    let tokens = surreal_tokens(definition);
    if !token_index(&tokens, "EVENT").is_some_and(|index| index == 1) {
        return None;
    }
    let name = unquote_surreal_name(tokens.get(2)?);
    let table = token_index(&tokens, "TABLE")
        .and_then(|index| tokens.get(index + 1))
        .map(|value| unquote_surreal_name(value));
    Some(TriggerInfo {
        name,
        timing: None,
        event: None,
        related_table: table,
        definition: Some(definition.to_string()),
    })
}

/// `DEFINE TABLE` text carrying `AS SELECT` is a materialized view table.
fn surreal_table_type(definition: &str) -> &'static str {
    let tokens = surreal_tokens(definition);
    let as_index = token_index(&tokens, "AS");
    if as_index.is_some_and(|index| {
        tokens
            .get(index + 1)
            .is_some_and(|token| token.eq_ignore_ascii_case("SELECT"))
    }) {
        "VIEW"
    } else {
        "TABLE"
    }
}

#[async_trait]
impl DatabaseDriver for SurrealDbDriver {
    async fn ping(&self) -> Result<()> {
        self.run_script("RETURN 1;", &SurrealBinds::default(), None)
            .await
            .context("SurrealDB ping failed")?;
        Ok(())
    }

    async fn disconnect(&self) -> Result<()> {
        // The HTTP API is stateless; there is nothing server-side to release.
        Ok(())
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        // With a namespace configured, `INFO FOR NS` lists its databases;
        // without one, `INFO FOR ROOT` lists the namespaces (the closest
        // thing SurrealDB has to a database list at root scope).
        let (sql, keys) = if self.namespace.is_some() {
            ("INFO FOR NS", &["databases", "db"][..])
        } else {
            ("INFO FOR ROOT", &["namespaces", "ns"][..])
        };
        let info = self
            .query_last_result(sql, &SurrealBinds::default(), None)
            .await
            .with_context(|| format!("SurrealDB '{sql}' failed"))?;
        let section = info_section(&info, keys);
        let mut names: Vec<String> = section
            .map(|section| section.keys().cloned().collect())
            .unwrap_or_default();
        names.sort();
        Ok(names
            .into_iter()
            .map(|name| DatabaseInfo { name, size: None })
            .collect())
    }

    async fn list_tables(&self, database: Option<&str>) -> Result<Vec<TableInfo>> {
        let database = self.require_db(database)?;
        let info = self
            .query_last_result("INFO FOR DB", &SurrealBinds::default(), Some(&database))
            .await
            .context("SurrealDB 'INFO FOR DB' failed")?;
        let Some(tables) = info_section(&info, &["tables", "tb"]) else {
            return Ok(Vec::new());
        };
        let mut entries: Vec<TableInfo> = tables
            .iter()
            .map(|(name, definition)| TableInfo {
                name: unquote_surreal_name(name),
                schema: self.namespace.clone(),
                table_type: definition
                    .as_str()
                    .map_or("TABLE", surreal_table_type)
                    .to_string(),
                row_count: None,
                engine: None,
                create_date: None,
            })
            .collect();
        entries.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(entries)
    }

    async fn list_schema_objects(&self, database: Option<&str>) -> Result<Vec<SchemaObjectInfo>> {
        let database = self.require_db(database)?;
        let info = self
            .query_last_result("INFO FOR DB", &SurrealBinds::default(), Some(&database))
            .await
            .context("SurrealDB 'INFO FOR DB' failed")?;
        let mut objects = Vec::new();
        if let Some(tables) = info_section(&info, &["tables", "tb"]) {
            for (name, definition) in tables {
                let Some(definition) = definition.as_str() else {
                    continue;
                };
                if surreal_table_type(definition) == "VIEW" {
                    objects.push(SchemaObjectInfo {
                        name: unquote_surreal_name(name),
                        schema: self.namespace.clone(),
                        object_type: "VIEW".to_string(),
                        related_table: None,
                        definition: Some(definition.to_string()),
                        create_date: None,
                    });
                }
            }
        }
        if let Some(functions) = info_section(&info, &["functions", "fn"]) {
            for (name, definition) in functions {
                objects.push(SchemaObjectInfo {
                    name: unquote_surreal_name(name),
                    schema: self.namespace.clone(),
                    object_type: "FUNCTION".to_string(),
                    related_table: None,
                    definition: definition.as_str().map(str::to_string),
                    create_date: None,
                });
            }
        }
        objects.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(objects)
    }

    async fn get_table_structure(
        &self,
        table: &str,
        database: Option<&str>,
    ) -> Result<TableStructure> {
        let database = self.require_db(database)?;
        let sql = format!("INFO FOR TABLE {}", qualify_surreal_table(table)?);
        let info = self
            .query_last_result(&sql, &SurrealBinds::default(), Some(&database))
            .await
            .with_context(|| format!("SurrealDB 'INFO FOR TABLE {table}' failed"))?;

        let mut columns: Vec<ColumnDetail> = info_section(&info, &["fields", "fd"])
            .map(|fields| {
                fields
                    .values()
                    .filter_map(|definition| definition.as_str())
                    .filter_map(parse_define_field)
                    .collect()
            })
            .unwrap_or_default();
        columns.sort_by(|left, right| left.name.cmp(&right.name));
        if columns.is_empty() {
            // Schemaless table: every record still carries a record link id.
            columns.push(ColumnDetail {
                name: "id".to_string(),
                data_type: "record".to_string(),
                is_nullable: false,
                is_primary_key: true,
                default_value: None,
                extra: None,
                column_type: None,
                comment: None,
            });
        }
        let mut indexes: Vec<IndexInfo> = info_section(&info, &["indexes", "ix"])
            .map(|indexes| {
                indexes
                    .values()
                    .filter_map(|definition| definition.as_str())
                    .filter_map(parse_define_index)
                    .collect()
            })
            .unwrap_or_default();
        indexes.sort_by(|left, right| left.name.cmp(&right.name));
        let mut triggers: Vec<TriggerInfo> = info_section(&info, &["events", "ev"])
            .map(|events| {
                events
                    .values()
                    .filter_map(|definition| definition.as_str())
                    .filter_map(parse_define_event)
                    .collect()
            })
            .unwrap_or_default();
        triggers.sort_by(|left, right| left.name.cmp(&right.name));

        Ok(TableStructure {
            columns,
            indexes,
            foreign_keys: Vec::new(),
            triggers,
            view_definition: None,
            object_type: Some("TABLE".to_string()),
        })
    }

    async fn execute_query(&self, sql: &str) -> Result<QueryResult> {
        self.execute_inner(sql, &SurrealBinds::default()).await
    }

    /// `?` markers compile to `$pN` names bound through the `vars` object —
    /// values travel inside the request body's typed params, never inside the
    /// SurrealQL text.
    async fn execute_parameterized_query(
        &self,
        sql: &str,
        parameters: &[QueryParameter],
    ) -> Result<QueryResult> {
        let (rewritten, marker_count) = rewrite_question_marks(sql)?;
        if marker_count != parameters.len() {
            return Err(anyhow!(
                "SurrealDB parameterized query expected {marker_count} values but {} were supplied",
                parameters.len()
            ));
        }
        let mut binds = SurrealBinds::default();
        for parameter in parameters {
            binds.push(parameter.value.clone());
        }
        self.execute_inner(&rewritten, &binds).await
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
        let database = self.require_db(database)?;
        let mut sql = format!("SELECT * FROM {}", qualify_surreal_table(table)?);
        // The sanitizer emits the shared identifier-op-literal grammar;
        // SurrealQL dialect differences (LIKE, <>) are translated after.
        if let Some(filter_clause) = translate_surreal_filter(filter)? {
            sql.push_str(&format!(" WHERE {filter_clause}"));
        }
        if let Some(order_by) = order_by {
            let direction = normalize_order_dir(order_dir)?;
            sql.push_str(&format!(
                " ORDER BY {} {}",
                quote_surreal_order_by(order_by)?,
                direction
            ));
        }
        // SurrealQL paginates with LIMIT n START n (its START = SQL OFFSET).
        sql.push_str(&format!(" LIMIT {limit} START {offset}"));
        let start = Instant::now();
        let envelopes = self
            .run_script(&sql, &SurrealBinds::default(), Some(&database))
            .await?;
        Ok(self.build_result(envelopes, &sql, start.elapsed().as_millis(), usize::MAX))
    }

    async fn count_rows(&self, table: &str, database: Option<&str>) -> Result<i64> {
        let database = self.require_db(database)?;
        let sql = format!(
            "SELECT count() AS count FROM {} GROUP ALL",
            qualify_surreal_table(table)?
        );
        let result = self
            .query_last_result(&sql, &SurrealBinds::default(), Some(&database))
            .await?;
        result
            .as_array()
            .and_then(|rows| rows.first())
            .and_then(|row| row.get("count"))
            .and_then(JsonValue::as_i64)
            .or_else(|| result.as_i64())
            .ok_or_else(|| anyhow!("SurrealDB count query returned no rows"))
    }

    async fn count_null_values(
        &self,
        table: &str,
        database: Option<&str>,
        column: &str,
    ) -> Result<i64> {
        let database = self.require_db(database)?;
        let column = quote_surreal_identifier(column)?;
        // SurrealDB distinguishes a stored `null` (NULL) from a missing field
        // (NONE); the UI's NULL count treats either as "no value".
        let sql = format!(
            "SELECT count() AS count FROM {} WHERE ({column} IS NONE OR {column} IS NULL) GROUP ALL",
            qualify_surreal_table(table)?,
        );
        let result = self
            .query_last_result(&sql, &SurrealBinds::default(), Some(&database))
            .await?;
        result
            .as_array()
            .and_then(|rows| rows.first())
            .and_then(|row| row.get("count"))
            .and_then(JsonValue::as_i64)
            .or_else(|| result.as_i64())
            .ok_or_else(|| anyhow!("SurrealDB null-count query returned no rows"))
    }

    async fn update_table_cell(&self, request: &TableCellUpdateRequest) -> Result<u64> {
        let database = self.resolve_db(request.database.as_deref());
        let mut binds = SurrealBinds::default();
        let statements = self.update_statements(request, &mut binds)?;
        // Standalone edits skip the existence gate — the returned row count
        // already tells the caller whether the selector matched.
        let update = statements.last().cloned().unwrap_or_default();
        let envelopes = self
            .run_script(&update, &binds, database.as_deref())
            .await?;
        Ok(envelopes
            .last()
            .map(|envelope| surreal_affected(&envelope.result))
            .unwrap_or(0))
    }

    /// Edit queue → one `BEGIN…COMMIT` script. Each update is preceded by an
    /// existence `IF … THROW` so a selector that no longer matches rolls back
    /// the whole queue instead of silently updating nothing.
    async fn apply_table_updates_atomically(
        &self,
        updates: &[TableCellUpdateRequest],
    ) -> Result<u64> {
        if updates.is_empty() {
            return Err(anyhow!("An edit queue requires at least one cell update"));
        }
        let database = self.resolve_db(
            updates
                .first()
                .and_then(|request| request.database.as_deref()),
        );
        let mut binds = SurrealBinds::default();
        let mut pieces = Vec::with_capacity(updates.len() * 2);
        for request in updates {
            pieces.extend(self.update_statements(request, &mut binds)?);
        }
        let envelopes = self
            .run_transaction(pieces, &binds, database.as_deref())
            .await?;
        // Envelope 0 is BEGIN; each update contributes an IF gate and an
        // UPDATE, so the affected-record envelopes sit at 2, 4, 6, …
        let affected = envelopes
            .iter()
            .skip(2)
            .step_by(2)
            .map(|envelope| surreal_affected(&envelope.result))
            .sum();
        Ok(affected)
    }

    async fn delete_table_rows(&self, request: &TableRowDeleteRequest) -> Result<u64> {
        if request.rows.is_empty() {
            return Err(anyhow!("Deleting rows requires at least one selected row"));
        }
        let database = self.resolve_db(request.database.as_deref());
        let mut binds = SurrealBinds::default();
        let mut predicates = Vec::with_capacity(request.rows.len());
        for row_keys in &request.rows {
            if row_keys.is_empty() {
                return Err(anyhow!(
                    "Each deleted row must include at least one primary key value"
                ));
            }
            let condition = self.pk_condition(row_keys, &request.table, &mut binds)?;
            predicates.push(format!("({condition})"));
        }
        let sql = format!(
            "DELETE FROM {} WHERE {} RETURN BEFORE",
            qualify_surreal_table(&request.table)?,
            predicates.join(" OR ")
        );
        let envelopes = self.run_script(&sql, &binds, database.as_deref()).await?;
        Ok(envelopes
            .last()
            .map(|envelope| surreal_affected(&envelope.result))
            .unwrap_or(0))
    }

    async fn insert_table_row(&self, request: &TableRowInsertRequest) -> Result<u64> {
        let database = self.resolve_db(request.database.as_deref());
        let mut binds = SurrealBinds::default();
        let sql = self.insert_statement_into(request, &mut binds)?;
        let envelopes = self.run_script(&sql, &binds, database.as_deref()).await?;
        Ok(envelopes
            .last()
            .map(|envelope| surreal_affected(&envelope.result))
            .unwrap_or(0))
    }

    /// CSV import → one `BEGIN…COMMIT` script: all rows land or none do.
    /// The cancel flag is checked before the request is sent; the HTTP body
    /// cap (`SURREAL_HTTP_MAX_SQL_BODY_SIZE`, 1–4 MiB) bounds the script.
    async fn insert_table_rows_atomically(
        &self,
        requests: &[TableRowInsertRequest],
        cancelled: Arc<AtomicBool>,
    ) -> Result<u64> {
        if requests.is_empty() {
            return Err(anyhow!("CSV import requires at least one row"));
        }
        if cancelled.load(Ordering::Relaxed) {
            bail!("CSV import cancelled; no rows were inserted");
        }
        let database = self.resolve_db(
            requests
                .first()
                .and_then(|request| request.database.as_deref()),
        );
        let mut binds = SurrealBinds::default();
        let mut pieces = Vec::with_capacity(requests.len());
        for request in requests {
            pieces.push(self.insert_statement_into(request, &mut binds)?);
        }
        let envelopes = self
            .run_transaction(pieces, &binds, database.as_deref())
            .await?;
        Ok(envelopes
            .iter()
            .skip(1)
            .take(requests.len())
            .map(|envelope| surreal_affected(&envelope.result))
            .sum())
    }

    /// Streaming import: the channel drains into the same single
    /// `BEGIN…COMMIT` script — SurrealDB transactions cannot span requests, so
    /// chunking is impossible without giving up atomicity.
    async fn insert_table_row_stream_atomically(
        &self,
        mut rows: tokio::sync::mpsc::Receiver<crate::database::models::CsvImportRow>,
        cancelled: Arc<AtomicBool>,
    ) -> Result<u64> {
        let mut requests = Vec::new();
        while let Some(row) = rows.recv().await {
            if cancelled.load(Ordering::Relaxed) {
                bail!("CSV import cancelled; no rows were inserted");
            }
            requests.push(row.map_err(anyhow::Error::msg)?);
        }
        self.insert_table_rows_atomically(&requests, cancelled)
            .await
    }

    /// Write preview → `BEGIN…CANCEL`: statements execute inside a real
    /// transaction that is always rolled back, so the returned envelopes are a
    /// faithful what-if. The `CANCEL`/`BEGIN` envelopes are stripped, leaving
    /// one `QueryResult` per reviewed statement.
    async fn preview_write_transaction(&self, statements: &[String]) -> Result<Vec<QueryResult>> {
        let mut pieces = Vec::new();
        for entry in statements {
            for statement in split_sql_statements(entry) {
                if !statement.trim().is_empty() {
                    pieces.push(statement);
                }
            }
        }
        let script = Self::transaction_script(&pieces, "CANCEL TRANSACTION");
        let database = self.resolve_db(None);
        let envelopes = self
            .send_script(&script, &SurrealBinds::default(), database.as_deref())
            .await
            .context("SurrealDB write preview failed")?;
        // The transaction aborts on the first failing statement, so report it
        // directly — everything before it was already rolled back.
        Self::check_envelopes(&envelopes, "SurrealDB write preview")?;

        let mut results = Vec::with_capacity(pieces.len());
        for (index, statement) in pieces.iter().enumerate() {
            let Some(envelope) = envelopes.get(index + 1) else {
                break;
            };
            let (columns, rows) = surreal_result_rows(&envelope.result);
            let truncated = rows.len() > MAX_QUERY_RESULT_ROWS;
            results.push(QueryResult {
                columns: columns
                    .iter()
                    .enumerate()
                    .map(|(position, name)| ColumnInfo {
                        name: name.clone(),
                        data_type: rows
                            .iter()
                            .find_map(|row| row.get(position))
                            .map_or_else(|| "any".to_string(), surreal_type_name),
                        is_nullable: true,
                        is_primary_key: name == "id",
                        max_length: None,
                        default_value: None,
                    })
                    .collect(),
                rows: rows.into_iter().take(MAX_QUERY_RESULT_ROWS).collect(),
                affected_rows: surreal_affected(&envelope.result),
                execution_time_ms: 0,
                query: statement.clone(),
                sandboxed: true,
                truncated,
            });
        }
        Ok(results)
    }

    async fn use_database(&self, database: &str) -> Result<()> {
        let name = database.trim();
        if name.is_empty() {
            return Err(anyhow!("SurrealDB database name cannot be empty"));
        }
        let mut current = self
            .current_db
            .write()
            .map_err(|_| anyhow!("Failed to access SurrealDB database state"))?;
        *current = Some(name.to_string());
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
        let database = self.require_db(None)?;
        let column = quote_surreal_identifier(referenced_column)?;
        let mut projections = vec![format!("{column} AS value")];
        for display in display_columns {
            projections.push(quote_surreal_identifier(display)?);
        }
        let mut binds = SurrealBinds::default();
        let mut sql = format!(
            "SELECT {} FROM {}",
            projections.join(", "),
            qualify_surreal_table(referenced_table)?
        );
        if let Some(search) = search.map(str::trim).filter(|value| !value.is_empty()) {
            let placeholder = binds.push(JsonValue::String(search.to_string()));
            sql.push_str(&format!(
                " WHERE string::contains(type::string({column}), {placeholder})"
            ));
        }
        sql.push_str(&format!(" ORDER BY value LIMIT {limit}"));
        let result = self
            .query_last_result(&sql, &binds, Some(&database))
            .await?;
        let rows = result.as_array().cloned().unwrap_or_default();
        Ok(rows
            .iter()
            .filter_map(|row| {
                let map = row.as_object()?;
                let value = map.get("value").cloned().unwrap_or(JsonValue::Null);
                let label = display_columns
                    .iter()
                    .filter_map(|column| map.get(*column))
                    .filter(|value| !value.is_null())
                    .map(|value| match value {
                        JsonValue::String(text) => text.clone(),
                        other => other.to_string(),
                    })
                    .collect::<Vec<_>>()
                    .join(" ");
                let label = if label.is_empty() {
                    match &value {
                        JsonValue::String(text) => text.clone(),
                        other => other.to_string(),
                    }
                } else {
                    label
                };
                Some(LookupValue { value, label })
            })
            .collect())
    }

    fn current_database(&self) -> Option<String> {
        self.current_db.read().ok()?.clone()
    }

    fn driver_name(&self) -> &str {
        "surrealdb"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rewrite_question_marks_replaces_only_real_markers() {
        let (rewritten, count) = rewrite_question_marks(
            "SELECT * FROM t WHERE a = ? AND b ?= ? AND c = 'x?' -- ?\n AND d = ?",
        )
        .expect("rewrite");
        assert_eq!(count, 3);
        assert_eq!(
            rewritten,
            "SELECT * FROM t WHERE a = $p1 AND b ?= $p2 AND c = 'x?' -- ?\n AND d = $p3"
        );
    }

    #[test]
    fn rewrite_question_marks_skips_fuzzy_and_coalesce_operators() {
        let (rewritten, count) =
            rewrite_question_marks("SELECT * FROM t WHERE name ?~ 'a' AND x ?? ?")
                .expect("rewrite");
        assert_eq!(count, 1);
        assert_eq!(rewritten, "SELECT * FROM t WHERE name ?~ 'a' AND x ?? $p1");
    }

    #[test]
    fn identifier_quoting_handles_backticks_and_brackets() {
        assert_eq!(quote_surreal_identifier("plain").unwrap(), "`plain`");
        assert_eq!(quote_surreal_identifier("we`ird").unwrap(), "⟨we`ird⟩");
        assert!(quote_surreal_identifier("bad⟨name").is_err());
        assert!(quote_surreal_identifier("").is_err());
    }

    #[test]
    fn table_qualification_rejects_dotted_names() {
        assert_eq!(qualify_surreal_table("person").unwrap(), "`person`");
        assert!(qualify_surreal_table("db.person").is_err());
    }

    #[test]
    fn like_translation_picks_the_string_function_for_each_wildcard_shape() {
        assert_eq!(
            translate_like("`name`", "'%ali%'").unwrap(),
            "string::contains(`name`, 'ali')"
        );
        assert_eq!(
            translate_like("`name`", "'ali%'").unwrap(),
            "string::starts_with(`name`, 'ali')"
        );
        assert_eq!(
            translate_like("`name`", "'%ali'").unwrap(),
            "string::ends_with(`name`, 'ali')"
        );
        assert_eq!(translate_like("`name`", "'ali'").unwrap(), "`name` = 'ali'");
        assert!(translate_like("`name`", "'a_i'").is_err());
    }

    #[test]
    fn filter_translation_rewrites_like_and_not_equal_outside_strings() {
        let clause = translate_surreal_filter(Some("name LIKE '%a%' AND age <> 3")).unwrap();
        assert_eq!(
            clause.as_deref(),
            Some("string::contains(`name`, 'a') AND `age` != 3")
        );
        let untouched = translate_surreal_filter(Some("note = 'a<>b'")).unwrap();
        assert_eq!(untouched.as_deref(), Some("`note` = 'a<>b'"));
    }

    #[test]
    fn filter_translation_escapes_surreal_string_quotes() {
        let clause = translate_surreal_filter(Some("name LIKE '%it''s%'")).unwrap();
        assert_eq!(
            clause.as_deref(),
            Some("string::contains(`name`, 'it\\'s')")
        );
    }

    #[test]
    fn pk_condition_uses_record_link_for_id_selector() {
        let driver = test_driver();
        let mut binds = SurrealBinds::default();
        let keys = vec![RowKeyValue {
            column: "id".to_string(),
            value: json!("person:42"),
        }];
        let condition = driver
            .pk_condition(&keys, "person", &mut binds)
            .expect("pk condition");
        assert_eq!(condition, "id = type::record($p1, $p2)");
        assert_eq!(binds.vars.get("p1"), Some(&json!("person")));
        assert_eq!(binds.vars.get("p2"), Some(&json!(42)));
    }

    #[test]
    fn pk_condition_rejects_a_record_link_for_another_table() {
        let driver = test_driver();
        let mut binds = SurrealBinds::default();
        let keys = vec![RowKeyValue {
            column: "id".to_string(),
            value: json!("other:42"),
        }];
        assert!(driver.pk_condition(&keys, "person", &mut binds).is_err());
    }

    #[test]
    fn pk_condition_binds_plain_field_selectors() {
        let driver = test_driver();
        let mut binds = SurrealBinds::default();
        let keys = vec![
            RowKeyValue {
                column: "name".to_string(),
                value: json!("a'b"),
            },
            RowKeyValue {
                column: "deleted".to_string(),
                value: JsonValue::Null,
            },
        ];
        let condition = driver
            .pk_condition(&keys, "person", &mut binds)
            .expect("pk condition");
        assert_eq!(
            condition,
            "`name` = $p1 AND (`deleted` IS NONE OR `deleted` IS NULL)"
        );
        assert_eq!(binds.vars.get("p1"), Some(&json!("a'b")));
    }

    #[test]
    fn record_id_expr_classifies_id_part_types() {
        let mut binds = SurrealBinds::default();
        assert_eq!(record_id_expr("42", &mut binds), "$p1");
        assert_eq!(binds.vars.get("p1"), Some(&json!(42)));
        assert_eq!(
            record_id_expr("⟨550e8400-e29b-41d4-a716-446655440000⟩", &mut binds),
            "type::uuid($p2)"
        );
        assert_eq!(
            binds.vars.get("p2"),
            Some(&json!("550e8400-e29b-41d4-a716-446655440000"))
        );
        assert_eq!(record_id_expr("plain-id", &mut binds), "$p3");
        assert_eq!(binds.vars.get("p3"), Some(&json!("plain-id")));
    }

    /// A driver handle for bind/statement builders — no network is touched.
    fn test_driver() -> SurrealDbDriver {
        SurrealDbDriver {
            client: Client::new(),
            base_url: "http://localhost:8000".to_string(),
            auth: SurrealAuth::None,
            namespace: None,
            current_db: Arc::new(RwLock::new(None)),
            record_fn: "type::record",
        }
    }

    #[test]
    fn define_field_parsing_extracts_type_nullable_and_default() {
        let column = parse_define_field(
            "DEFINE FIELD name ON TABLE person TYPE option<string> DEFAULT 'anon'",
        )
        .expect("field");
        assert_eq!(column.name, "name");
        assert_eq!(column.data_type, "option<string>");
        assert!(column.is_nullable);
        assert_eq!(column.default_value.as_deref(), Some("'anon'"));

        let id = parse_define_field("DEFINE FIELD `id` ON TABLE person TYPE record<person>")
            .expect("id field");
        assert_eq!(id.name, "id");
        assert!(id.is_primary_key);
        assert!(!id.is_nullable);
    }

    #[test]
    fn define_index_parsing_collects_columns_and_uniqueness() {
        let index =
            parse_define_index("DEFINE INDEX name_idx ON TABLE person COLUMNS name, age UNIQUE")
                .expect("index");
        assert_eq!(index.name, "name_idx");
        assert_eq!(index.columns, vec!["name".to_string(), "age".to_string()]);
        assert!(index.is_unique);
    }

    #[test]
    fn define_event_parsing_finds_related_table() {
        let trigger = parse_define_event(
            "DEFINE EVENT audit ON TABLE person WHEN $event = 'CREATE' THEN (CREATE log SET v = 1)",
        )
        .expect("event");
        assert_eq!(trigger.name, "audit");
        assert_eq!(trigger.related_table.as_deref(), Some("person"));
    }

    #[test]
    fn view_detection_reads_define_table_as_select() {
        assert_eq!(
            surreal_table_type("DEFINE TABLE people_view AS SELECT * FROM person"),
            "VIEW"
        );
        assert_eq!(
            surreal_table_type("DEFINE TABLE person SCHEMALESS PERMISSIONS FULL"),
            "TABLE"
        );
    }

    #[test]
    fn result_rows_maps_object_arrays_to_columns() {
        let (columns, rows) = surreal_result_rows(&json!([
            {"id": "person:1", "name": "a"},
            {"id": "person:2", "extra": 5}
        ]));
        assert_eq!(
            columns,
            vec!["id".to_string(), "name".to_string(), "extra".to_string()]
        );
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows[0],
            vec![json!("person:1"), json!("a"), JsonValue::Null]
        );
        assert_eq!(rows[1], vec![json!("person:2"), JsonValue::Null, json!(5)]);
    }

    #[test]
    fn envelope_error_detection_reports_statement_position() {
        let envelopes = vec![
            SurrealEnvelope {
                status: "OK".into(),
                result: json!(null),
            },
            SurrealEnvelope {
                status: "ERR".into(),
                result: json!("boom"),
            },
        ];
        let error = SurrealDbDriver::check_envelopes(&envelopes, "ctx").unwrap_err();
        assert!(error.to_string().contains("statement 2"));
        assert!(error.to_string().contains("boom"));
    }
}
