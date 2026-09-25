use super::driver::DatabaseDriver;
use super::models::*;
use super::query_common::{statement_returns_rows, MAX_QUERY_RESULT_ROWS};
use super::safety::{
    normalize_order_dir, qualify_cassandra_table_name, quote_cassandra_identifier,
    quote_cassandra_order_by, sanitize_cassandra_filter_clause,
};
use crate::utils::sql::split_sql_statements;
use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use futures_util::{stream, Stream, StreamExt, TryStreamExt};
use scylla::client::session::Session;
use scylla::client::session_builder::SessionBuilder;
use scylla::cluster::metadata::{ColumnKind, Table};
use scylla::response::query_result::QueryResult as ScyllaQueryResult;
use scylla::statement::batch::{Batch, BatchType};
use scylla::statement::Statement;
use scylla::value::{CqlValue, Row as ScyllaRow};
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::collections::BTreeSet;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock as StdRwLock};
use std::time::Instant;

/// Cap on statements inside one CQL BATCH. Cassandra rejects oversized
/// batches (`batch_size_fail_threshold_in_kb`, 50 KB by default) and logged
/// batches spanning many partitions are expensive, so the driver refuses
/// work that cannot plausibly fit instead of partially applying it.
const CASSANDRA_BATCH_MAX_STATEMENTS: usize = 100;
/// Conservative byte cap on the combined CQL text of one batch, kept well
/// under Cassandra's default 50 KB `batch_size_fail_threshold_in_kb`.
const CASSANDRA_BATCH_MAX_BYTES: usize = 32 * 1024;

pub struct CassandraDriver {
    session: Session,
    current_keyspace: Arc<StdRwLock<Option<String>>>,
}

impl CassandraDriver {
    pub async fn connect(config: &ConnectionConfig) -> Result<Self> {
        if config.use_ssl {
            return Err(anyhow!(
                "Cassandra TLS connections are not enabled in this build yet."
            ));
        }

        let host = config
            .host
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .context("Cassandra host is required")?;
        let port = config.port.unwrap_or(9042);

        let mut builder = SessionBuilder::new().known_node(format!("{host}:{port}"));

        if let Some(username) = config
            .username
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            builder = builder.user(username, config.password.as_deref().unwrap_or(""));
        }

        let initial_keyspace = config
            .database
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);

        if let Some(keyspace) = initial_keyspace.as_deref() {
            builder = builder.use_keyspace(keyspace, false);
        }

        let session = builder
            .build()
            .await
            .context("Failed to connect to Cassandra")?;

        session
            .query_unpaged("SELECT release_version FROM system.local", &[])
            .await
            .context("Cassandra ping failed during connect")?;

        Ok(Self {
            session,
            current_keyspace: Arc::new(StdRwLock::new(initial_keyspace)),
        })
    }

    fn query_returns_rows(sql: &str) -> bool {
        statement_returns_rows(sql, &["SELECT"])
    }

    fn current_keyspace_name(&self) -> Option<String> {
        self.current_keyspace
            .read()
            .ok()
            .and_then(|guard| guard.clone())
    }

    fn parse_use_statement(sql: &str) -> Option<String> {
        let trimmed = sql.trim().trim_end_matches(';').trim();
        if trimmed.len() <= 3 || !trimmed[..3].eq_ignore_ascii_case("USE") {
            return None;
        }

        let remainder = trimmed[3..].trim();
        if remainder.is_empty() {
            return None;
        }

        Some(remainder.trim_matches('"').to_string())
    }

    fn resolve_keyspace_name(&self, database: Option<&str>) -> Result<String> {
        database
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| self.current_keyspace_name())
            .ok_or_else(|| anyhow!("A Cassandra keyspace must be selected first"))
    }

    fn parse_table_reference<'a>(&self, table: &'a str) -> Result<(Option<&'a str>, &'a str)> {
        let parts = table
            .split('.')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>();

        match parts.as_slice() {
            [table_name] => Ok((None, table_name)),
            [keyspace, table_name] => Ok((Some(keyspace), table_name)),
            _ => Err(anyhow!("Only keyspace.table style names are supported")),
        }
    }

    fn resolve_table_target(
        &self,
        table: &str,
        database: Option<&str>,
    ) -> Result<(String, String, String)> {
        let (explicit_keyspace, table_name) = self.parse_table_reference(table)?;
        let keyspace = explicit_keyspace
            .map(str::to_string)
            .unwrap_or(self.resolve_keyspace_name(database)?);
        let qualified = qualify_cassandra_table_name(
            if explicit_keyspace.is_some() {
                table
            } else {
                table_name
            },
            &keyspace,
        )?;
        Ok((keyspace, table_name.to_string(), qualified))
    }

    async fn refresh_metadata(&self) -> Result<()> {
        self.session
            .refresh_metadata()
            .await
            .context("Failed to refresh Cassandra schema metadata")
    }

    async fn query_to_result(&self, cql: &str, original_query: &str) -> Result<QueryResult> {
        let started_at = Instant::now();
        let response = self
            .session
            .query_unpaged(cql, &[])
            .await
            .with_context(|| format!("Cassandra query failed: {cql}"))?;

        Self::query_response_to_result(response, original_query, started_at)
    }

    fn query_response_to_result(
        response: ScyllaQueryResult,
        original_query: &str,
        started_at: Instant,
    ) -> Result<QueryResult> {
        let rows_result = match response.into_rows_result() {
            Ok(rows) => rows,
            Err(_) => {
                return Ok(QueryResult {
                    columns: Vec::new(),
                    rows: Vec::new(),
                    affected_rows: 0,
                    execution_time_ms: started_at.elapsed().as_millis(),
                    query: original_query.to_string(),
                    sandboxed: false,
                    truncated: false,
                });
            }
        };

        let columns = rows_result
            .column_specs()
            .iter()
            .map(|spec| ColumnInfo {
                name: spec.name().to_string(),
                data_type: format!("{:?}", spec.typ()),
                is_nullable: true,
                is_primary_key: false,
                max_length: None,
                default_value: None,
            })
            .collect::<Vec<_>>();

        let mut rows = Vec::new();
        let mut truncated = false;
        for row in rows_result
            .rows::<ScyllaRow>()
            .context("Failed to deserialize Cassandra rows")?
        {
            if rows.len() == MAX_QUERY_RESULT_ROWS {
                truncated = true;
                break;
            }

            let row = row.context("Failed to deserialize a Cassandra row")?;
            rows.push(
                row.columns
                    .into_iter()
                    .map(|value| {
                        value
                            .map(Self::cql_value_to_json)
                            .unwrap_or(JsonValue::Null)
                    })
                    .collect::<Vec<_>>(),
            );
        }

        Ok(QueryResult {
            columns,
            rows,
            affected_rows: 0,
            execution_time_ms: started_at.elapsed().as_millis(),
            query: original_query.to_string(),
            sandboxed: false,
            truncated,
        })
    }

    /// Map a bound parameter to a CQL value. `None` serializes as NULL, so
    /// values travel through the binary protocol — never into the CQL text.
    fn json_to_cql_value(parameter: &QueryParameter) -> Result<Option<CqlValue>> {
        match parameter.data_type {
            QueryParameterType::Text => parameter
                .value
                .as_str()
                .map(|value| Some(CqlValue::Text(value.to_string())))
                .ok_or_else(|| anyhow!("Parameter '{}' must be a string.", parameter.name)),
            QueryParameterType::Integer => parameter
                .value
                .as_i64()
                .map(|value| Some(CqlValue::BigInt(value)))
                .ok_or_else(|| anyhow!("Parameter '{}' must be an integer.", parameter.name)),
            QueryParameterType::Decimal => parameter
                .value
                .as_f64()
                .map(|value| Some(CqlValue::Double(value)))
                .ok_or_else(|| anyhow!("Parameter '{}' must be a number.", parameter.name)),
            QueryParameterType::Boolean => parameter
                .value
                .as_bool()
                .map(|value| Some(CqlValue::Boolean(value)))
                .ok_or_else(|| anyhow!("Parameter '{}' must be boolean.", parameter.name)),
            QueryParameterType::Json => Ok(Some(CqlValue::Text(parameter.value.to_string()))),
            QueryParameterType::Null => Ok(None),
        }
    }

    async fn query_to_objects(&self, cql: &str) -> Result<Vec<JsonMap<String, JsonValue>>> {
        let result = self.query_to_result(cql, cql).await?;
        Ok(result
            .rows
            .into_iter()
            .map(|row| {
                result
                    .columns
                    .iter()
                    .zip(row)
                    .map(|(column, value)| (column.name.clone(), value))
                    .collect::<JsonMap<String, JsonValue>>()
            })
            .collect::<Vec<_>>())
    }

    fn cql_value_to_json(value: CqlValue) -> JsonValue {
        match value {
            CqlValue::Ascii(value) | CqlValue::Text(value) => JsonValue::String(value),
            CqlValue::Boolean(value) => JsonValue::Bool(value),
            CqlValue::TinyInt(value) => JsonValue::from(value),
            CqlValue::SmallInt(value) => JsonValue::from(value),
            CqlValue::Int(value) => JsonValue::from(value),
            CqlValue::BigInt(value) => JsonValue::from(value),
            CqlValue::Counter(value) => JsonValue::String(format!("{value:?}")),
            CqlValue::Float(value) => JsonValue::from(value as f64),
            CqlValue::Double(value) => JsonValue::from(value),
            CqlValue::List(values) | CqlValue::Set(values) => JsonValue::Array(
                values
                    .into_iter()
                    .map(Self::cql_value_to_json)
                    .collect::<Vec<_>>(),
            ),
            CqlValue::Map(entries) => {
                let mut object = JsonMap::new();
                let mut all_keys_are_unique_strings = true;

                for (key, value) in entries.iter() {
                    match Self::cql_value_to_json(key.clone()) {
                        JsonValue::String(key_text) if !object.contains_key(&key_text) => {
                            object.insert(key_text, Self::cql_value_to_json(value.clone()));
                        }
                        _ => {
                            all_keys_are_unique_strings = false;
                            break;
                        }
                    }
                }

                if all_keys_are_unique_strings {
                    JsonValue::Object(object)
                } else {
                    JsonValue::Array(
                        entries
                            .into_iter()
                            .map(|(key, value)| {
                                JsonValue::Object(
                                    [
                                        ("key".to_string(), Self::cql_value_to_json(key)),
                                        ("value".to_string(), Self::cql_value_to_json(value)),
                                    ]
                                    .into_iter()
                                    .collect(),
                                )
                            })
                            .collect::<Vec<_>>(),
                    )
                }
            }
            CqlValue::Tuple(values) => JsonValue::Array(
                values
                    .into_iter()
                    .map(|value| {
                        value
                            .map(Self::cql_value_to_json)
                            .unwrap_or(JsonValue::Null)
                    })
                    .collect::<Vec<_>>(),
            ),
            CqlValue::UserDefinedType { fields, .. } => JsonValue::Object(
                fields
                    .into_iter()
                    .map(|(name, value)| {
                        (
                            name,
                            value
                                .map(Self::cql_value_to_json)
                                .unwrap_or(JsonValue::Null),
                        )
                    })
                    .collect(),
            ),
            CqlValue::Empty => JsonValue::Null,
            other => JsonValue::String(format!("{other:?}")),
        }
    }

    fn json_to_cql_term(value: &JsonValue, allow_null: bool) -> Result<String> {
        if value.is_null() {
            if allow_null {
                return Ok("null".to_string());
            }
            return Err(anyhow!("Primary key values cannot be NULL"));
        }

        let json = serde_json::to_string(value).context("Failed to serialize JSON value")?;
        Ok(format!("fromJson('{}')", json.replace('\'', "''")))
    }

    fn quote_string_literal(value: &str) -> String {
        format!("'{}'", value.replace('\'', "''"))
    }

    fn build_where_clause(primary_keys: &[RowKeyValue]) -> Result<String> {
        if primary_keys.is_empty() {
            return Err(anyhow!(
                "Cassandra row operations require the full primary key selector"
            ));
        }

        Ok(primary_keys
            .iter()
            .map(|key| {
                Ok(format!(
                    "{} = {}",
                    quote_cassandra_identifier(&key.column)?,
                    Self::json_to_cql_term(&key.value, false)?,
                ))
            })
            .collect::<Result<Vec<_>>>()?
            .join(" AND "))
    }

    fn build_columns_from_table(table: &Table) -> Vec<ColumnDetail> {
        let pk_names = table.partition_key.iter().cloned().collect::<BTreeSet<_>>();
        let ck_names = table
            .clustering_key
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>();
        let mut ordered_names = Vec::new();

        for name in &table.partition_key {
            if table.columns.contains_key(name) {
                ordered_names.push(name.clone());
            }
        }
        for name in &table.clustering_key {
            if table.columns.contains_key(name) && !ordered_names.contains(name) {
                ordered_names.push(name.clone());
            }
        }

        let mut remaining = table
            .columns
            .keys()
            .filter(|name| !pk_names.contains(*name) && !ck_names.contains(*name))
            .cloned()
            .collect::<Vec<_>>();
        remaining.sort();
        ordered_names.extend(remaining);

        ordered_names
            .into_iter()
            .filter_map(|name| {
                table.columns.get(&name).map(|column| ColumnDetail {
                    name,
                    data_type: format!("{:?}", column.typ),
                    is_nullable: !matches!(
                        column.kind,
                        ColumnKind::PartitionKey | ColumnKind::Clustering
                    ),
                    is_primary_key: matches!(
                        column.kind,
                        ColumnKind::PartitionKey | ColumnKind::Clustering
                    ),
                    default_value: None,
                    extra: Some(format!("{:?}", column.kind).to_lowercase()),
                    column_type: Some(format!("{:?}", column.typ)),
                    comment: None,
                })
            })
            .collect::<Vec<_>>()
    }

    async fn fetch_table_indexes(&self, keyspace: &str, table: &str) -> Result<Vec<IndexInfo>> {
        let query = format!(
            "SELECT index_name, kind, options FROM system_schema.indexes WHERE keyspace_name = {} AND table_name = {}",
            Self::quote_string_literal(keyspace),
            Self::quote_string_literal(table),
        );

        let rows = self.query_to_objects(&query).await?;
        Ok(rows
            .into_iter()
            .map(|row| {
                let columns = row
                    .get("options")
                    .and_then(JsonValue::as_object)
                    .and_then(|options| options.get("target"))
                    .and_then(JsonValue::as_str)
                    .map(|target| vec![target.to_string()])
                    .unwrap_or_default();

                IndexInfo {
                    name: row
                        .get("index_name")
                        .and_then(JsonValue::as_str)
                        .unwrap_or("unnamed_index")
                        .to_string(),
                    columns,
                    is_unique: false,
                    index_type: row
                        .get("kind")
                        .and_then(JsonValue::as_str)
                        .map(str::to_string),
                }
            })
            .collect::<Vec<_>>())
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
            .or_else(|| value.as_str().and_then(|raw| raw.parse::<i64>().ok()))
            .ok_or_else(|| anyhow!("Expected a numeric scalar value"))
    }

    /// Build one `UPDATE … SET col = term WHERE pk = term …` CQL statement
    /// for a primary-key based cell edit. Values use `fromJson` terms, the
    /// same coercion mechanism as `update_table_cell`.
    fn build_cell_update_statement(&self, request: &TableCellUpdateRequest) -> Result<String> {
        if request.primary_keys.is_empty() {
            return Err(anyhow!(
                "Inline update requires at least one primary key column"
            ));
        }
        let (_, _, qualified_table) =
            self.resolve_table_target(&request.table, request.database.as_deref())?;
        Ok(format!(
            "UPDATE {qualified_table} SET {} = {} WHERE {}",
            quote_cassandra_identifier(&request.target_column)?,
            Self::json_to_cql_term(&request.value, true)?,
            Self::build_where_clause(&request.primary_keys)?,
        ))
    }

    /// Build one `INSERT INTO … VALUES (…)` CQL statement for a CSV import
    /// row, using `fromJson` terms like `insert_table_row`.
    fn build_row_insert_statement(&self, request: &TableRowInsertRequest) -> Result<String> {
        if request.values.is_empty() {
            return Err(anyhow!("Each CSV row requires at least one column value"));
        }
        let (_, _, qualified_table) =
            self.resolve_table_target(&request.table, request.database.as_deref())?;
        let columns = request
            .values
            .iter()
            .map(|(name, _)| quote_cassandra_identifier(name))
            .collect::<Result<Vec<_>>>()?;
        let values = request
            .values
            .iter()
            .map(|(_, value)| Self::json_to_cql_term(value, true))
            .collect::<Result<Vec<_>>>()?;
        Ok(format!(
            "INSERT INTO {qualified_table} ({}) VALUES ({})",
            columns.join(", "),
            values.join(", "),
        ))
    }

    /// Reject work that cannot plausibly fit inside one CQL BATCH. Cassandra
    /// fails batches over `batch_size_fail_threshold_in_kb` (50 KB default)
    /// and warns past 5 KB; the caps here stay under both so a batch never
    /// half-applies because it was too large to send.
    fn ensure_batch_fits(statements: &[String]) -> Result<()> {
        if statements.len() > CASSANDRA_BATCH_MAX_STATEMENTS {
            return Err(anyhow!(
                "Cassandra batches are limited to {CASSANDRA_BATCH_MAX_STATEMENTS} statements; \
                 {} were requested. Split the operation into smaller groups.",
                statements.len()
            ));
        }
        let total_bytes: usize = statements.iter().map(|statement| statement.len()).sum();
        if total_bytes > CASSANDRA_BATCH_MAX_BYTES {
            return Err(anyhow!(
                "Cassandra batch of {} statements is {total_bytes} bytes, over the \
                 {CASSANDRA_BATCH_MAX_BYTES}-byte driver cap. Split the operation into \
                 smaller groups.",
                statements.len()
            ));
        }
        Ok(())
    }

    /// Execute statements inside one logged CQL BATCH.
    ///
    /// Semantics caveat: a LOGGED batch is atomic — either all mutations are
    /// applied or none are — but it is *not* isolated; concurrent readers can
    /// observe a partially applied batch. Batches spanning multiple
    /// partitions also pay a batchlog round-trip, which is why the statement
    /// and byte caps above keep batches small.
    async fn execute_logged_batch(&self, statements: &[String]) -> Result<()> {
        Self::ensure_batch_fits(statements)?;

        let mut batch = Batch::new(BatchType::Logged);
        for statement in statements {
            batch.append_statement(statement.as_str());
        }

        // One empty value row per statement — the CQL text carries `fromJson`
        // terms, so there are no `?` markers to bind.
        let values = vec![(); statements.len()];
        self.session
            .batch(&batch, values)
            .await
            .context("Cassandra logged batch failed")?;
        Ok(())
    }

    /// Resolve a snapshot table entry to a concrete `(keyspace, table)` pair.
    /// A `keyspace.table` name wins; otherwise the entry's `schema` (the
    /// exporting keyspace) is used, then the connection's current keyspace.
    /// Both pieces are validated as identifier parts — never interpolated
    /// raw into CQL text.
    fn snapshot_table_target(
        name: &str,
        schema: Option<&str>,
        default_keyspace: Option<&str>,
    ) -> Result<(String, String)> {
        let parts = name
            .split('.')
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>();
        let (explicit_keyspace, table_name) = match parts.as_slice() {
            [table_name] => (None, *table_name),
            [keyspace, table_name] => (Some(*keyspace), *table_name),
            _ => {
                return Err(anyhow!(
                    "Snapshot table name '{name}' is not a keyspace.table reference"
                ))
            }
        };
        let keyspace = explicit_keyspace
            .or(schema)
            .or(default_keyspace)
            .ok_or_else(|| {
                anyhow!(
                    "Snapshot table '{name}' has no keyspace and no Cassandra keyspace is selected"
                )
            })?;
        // Validate both parts now; the qualified name quotes them.
        quote_cassandra_identifier(keyspace)?;
        quote_cassandra_identifier(table_name)?;
        Ok((keyspace.to_string(), table_name.to_string()))
    }

    /// Column names for array-shaped snapshot rows: the exported
    /// `structure.columns` first (ColumnDetail serializes `name`), then a
    /// flat `columns` string array for snapshots written by other
    /// producers.
    fn snapshot_column_names(table: &JsonValue) -> Vec<String> {
        let from_structure = table
            .get("structure")
            .and_then(|structure| structure.get("columns"))
            .and_then(JsonValue::as_array)
            .map(|columns| {
                columns
                    .iter()
                    .filter_map(|column| {
                        column
                            .get("name")
                            .and_then(JsonValue::as_str)
                            .map(str::to_string)
                    })
                    .collect::<Vec<_>>()
            });
        if let Some(names) = from_structure.filter(|names| !names.is_empty()) {
            return names;
        }
        table
            .get("columns")
            .and_then(JsonValue::as_array)
            .map(|columns| {
                columns
                    .iter()
                    .filter_map(JsonValue::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    }

    /// Turn one snapshot row into `(column, value)` entries. Object rows
    /// (the shape `row_to_object` writes) map keys verbatim; array rows zip
    /// cells with the exported column list. Values become
    /// `Option<CqlValue>` binds: `None` for JSON null, otherwise the
    /// serialized JSON text that `fromJson(?)` coerces server-side — so
    /// strings, numbers, booleans, collections, UDTs, and timestamp/uuid
    /// textual forms all round-trip through the binary protocol, never
    /// through CQL text.
    fn snapshot_row_to_entries(
        name: &str,
        row: &JsonValue,
        column_names: &[String],
    ) -> Result<Vec<(String, Option<CqlValue>)>> {
        let pairs: Vec<(&str, &JsonValue)> = match row {
            JsonValue::Object(map) => map
                .iter()
                .map(|(key, value)| (key.as_str(), value))
                .collect(),
            JsonValue::Array(cells) => {
                if column_names.is_empty() {
                    return Err(anyhow!(
                        "Snapshot table '{name}' has array-shaped rows but no column list"
                    ));
                }
                let mut pairs = Vec::with_capacity(cells.len());
                for (index, cell) in cells.iter().enumerate() {
                    let column = column_names.get(index).ok_or_else(|| {
                        anyhow!(
                            "Snapshot row for '{name}' has more cells than the exported column list"
                        )
                    })?;
                    pairs.push((column.as_str(), cell));
                }
                pairs
            }
            _ => {
                return Err(anyhow!(
                    "Snapshot row for '{name}' is not a JSON object or array"
                ))
            }
        };
        if pairs.is_empty() {
            return Err(anyhow!("Snapshot row for '{name}' has no values"));
        }
        pairs
            .into_iter()
            .map(|(column, value)| {
                let bound = if value.is_null() {
                    None
                } else {
                    Some(CqlValue::Text(
                        serde_json::to_string(value)
                            .context("Failed to serialize a snapshot value")?,
                    ))
                };
                Ok((column.to_string(), bound))
            })
            .collect()
    }

    /// Classify a restore payload the way the Redis/MongoDB drivers do: a
    /// TableR JSON snapshot (`meta.format == "json-snapshot"`) becomes a
    /// replay plan of per-table CQL INSERTs with bound values (`Some`);
    /// anything not starting with `{` returns `None` so the caller keeps
    /// the sequential CQL statement path. Payloads that look like a
    /// snapshot but are not (`meta.format` mismatch, missing `tables`,
    /// malformed rows) are hard errors — guessing CQL around a half-valid
    /// snapshot would corrupt data.
    ///
    /// Each plan row is one `INSERT INTO "ks"."table" ("cols"…) VALUES
    /// (fromJson(?), …)` statement plus the bound `Option<CqlValue>` row:
    /// `None` for NULL, otherwise the JSON text `fromJson` parses into the
    /// target column type. Identifiers are quoted; values are only ever
    /// bind markers, so no snapshot value reaches the wire as CQL text.
    fn snapshot_restore_inserts(
        statements: &[String],
        default_keyspace: Option<&str>,
    ) -> Result<Option<Vec<(String, Vec<Vec<Option<CqlValue>>>)>>> {
        // `split_sql_statements` keeps a JSON document inside one
        // statement, but join for robustness — hand-edited payloads may not
        // survive splitting intact.
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

        // Plan shape: one entry per `INSERT` text, holding every bind row
        // that shares it. Rows with different column sets produce
        // different statements and land as separate entries; the executor
        // prepares each distinct statement once.
        let mut plans: Vec<(String, Vec<Vec<Option<CqlValue>>>)> = Vec::new();
        for table in tables {
            let name = table
                .get("name")
                .and_then(JsonValue::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .ok_or_else(|| anyhow!("A snapshot table entry is missing its table name"))?;
            let schema = table
                .get("schema")
                .and_then(JsonValue::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let (keyspace, table_name) =
                Self::snapshot_table_target(name, schema, default_keyspace)?;
            let qualified = qualify_cassandra_table_name(&table_name, &keyspace)?;

            let column_names = Self::snapshot_column_names(table);
            let rows = table
                .get("rows")
                .and_then(JsonValue::as_array)
                .ok_or_else(|| anyhow!("Snapshot table '{name}' is missing its 'rows' array"))?;

            for row in rows {
                let entries = Self::snapshot_row_to_entries(name, row, &column_names)
                    .with_context(|| format!("Cannot replay a snapshot row for '{name}'"))?;
                let mut columns_sql = String::new();
                let mut values_sql = String::new();
                for (index, (column, _)) in entries.iter().enumerate() {
                    if index > 0 {
                        columns_sql.push_str(", ");
                        values_sql.push_str(", ");
                    }
                    columns_sql.push_str(&quote_cassandra_identifier(column)?);
                    values_sql.push_str("fromJson(?)");
                }
                let cql = format!("INSERT INTO {qualified} ({columns_sql}) VALUES ({values_sql})");
                let binds = entries
                    .into_iter()
                    .map(|(_, value)| value)
                    .collect::<Vec<_>>();
                match plans.iter_mut().find(|(existing, _)| existing == &cql) {
                    Some((_, grouped)) => grouped.push(binds),
                    None => plans.push((cql, vec![binds])),
                }
            }
        }
        Ok(Some(plans))
    }
}

#[async_trait]
impl DatabaseDriver for CassandraDriver {
    async fn ping(&self) -> Result<()> {
        self.session
            .query_unpaged("SELECT release_version FROM system.local", &[])
            .await
            .context("Cassandra ping failed")?;
        Ok(())
    }

    async fn disconnect(&self) -> Result<()> {
        Ok(())
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        self.refresh_metadata().await?;
        let cluster_state = self.session.get_cluster_state();
        let mut databases = cluster_state
            .keyspaces_iter()
            .map(|(name, _)| DatabaseInfo {
                name: name.to_string(),
                size: None,
            })
            .collect::<Vec<_>>();
        databases.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(databases)
    }

    async fn list_tables(&self, database: Option<&str>) -> Result<Vec<TableInfo>> {
        let keyspace = self.resolve_keyspace_name(database)?;
        self.refresh_metadata().await?;
        let cluster_state = self.session.get_cluster_state();
        let keyspace_meta = cluster_state
            .get_keyspace(&keyspace)
            .ok_or_else(|| anyhow!("Cassandra keyspace '{}' was not found", keyspace))?;

        let mut tables = keyspace_meta
            .tables
            .keys()
            .map(|table_name| TableInfo {
                create_date: None,
                name: table_name.clone(),
                schema: Some(keyspace.clone()),
                table_type: "TABLE".to_string(),
                row_count: None,
                engine: Some("Cassandra".to_string()),
            })
            .collect::<Vec<_>>();

        tables.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(tables)
    }

    async fn list_schema_objects(&self, database: Option<&str>) -> Result<Vec<SchemaObjectInfo>> {
        let keyspace = self.resolve_keyspace_name(database)?;
        self.refresh_metadata().await?;
        let cluster_state = self.session.get_cluster_state();
        let keyspace_meta = cluster_state
            .get_keyspace(&keyspace)
            .ok_or_else(|| anyhow!("Cassandra keyspace '{}' was not found", keyspace))?;

        let mut objects = keyspace_meta
            .views
            .iter()
            .map(|(name, view)| SchemaObjectInfo {
                create_date: None,
                name: name.clone(),
                schema: Some(keyspace.clone()),
                object_type: "VIEW".to_string(),
                related_table: Some(view.base_table_name.clone()),
                definition: None,
            })
            .collect::<Vec<_>>();

        objects.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(objects)
    }

    async fn get_table_structure(
        &self,
        table: &str,
        database: Option<&str>,
    ) -> Result<TableStructure> {
        let (keyspace, table_name, _) = self.resolve_table_target(table, database)?;
        self.refresh_metadata().await?;
        let cluster_state = self.session.get_cluster_state();
        let keyspace_meta = cluster_state
            .get_keyspace(&keyspace)
            .ok_or_else(|| anyhow!("Cassandra keyspace '{}' was not found", keyspace))?;

        if let Some(table_meta) = keyspace_meta.tables.get(&table_name) {
            return Ok(TableStructure {
                columns: Self::build_columns_from_table(table_meta),
                indexes: self.fetch_table_indexes(&keyspace, &table_name).await?,
                foreign_keys: Vec::new(),
                triggers: Vec::new(),
                view_definition: None,
                object_type: Some("TABLE".to_string()),
            });
        }

        if let Some(view_meta) = keyspace_meta.views.get(&table_name) {
            return Ok(TableStructure {
                columns: Self::build_columns_from_table(&view_meta.view_metadata),
                indexes: self.fetch_table_indexes(&keyspace, &table_name).await?,
                foreign_keys: Vec::new(),
                triggers: Vec::new(),
                view_definition: Some(format!("Base table: {}", view_meta.base_table_name)),
                object_type: Some("MATERIALIZED VIEW".to_string()),
            });
        }

        Err(anyhow!(
            "Cassandra table or materialized view '{}.{}' was not found",
            keyspace,
            table_name
        ))
    }

    async fn execute_query(&self, sql: &str) -> Result<QueryResult> {
        let started_at = Instant::now();
        let statements = split_sql_statements(sql);

        if statements.len() <= 1 && Self::query_returns_rows(sql) {
            return self.query_to_result(sql, sql).await;
        }

        let affected_rows = 0u64;
        let mut last_result = None;

        for statement in statements
            .iter()
            .filter(|statement| !statement.trim().is_empty())
        {
            if let Some(keyspace) = Self::parse_use_statement(statement) {
                self.use_database(&keyspace).await?;
                continue;
            }

            if Self::query_returns_rows(statement) {
                let mut result = self.query_to_result(statement, sql).await?;
                result.affected_rows = affected_rows;
                last_result = Some(result);
            } else {
                self.session
                    .query_unpaged(statement.as_str(), &[])
                    .await
                    .with_context(|| format!("Cassandra query failed: {statement}"))?;
            }
        }

        let elapsed = started_at.elapsed().as_millis();
        if let Some(mut result) = last_result {
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
        // CQL uses `?` markers natively; the compiled SQL is prepared as-is and
        // values are bound through the binary protocol.
        let prepared = self
            .session
            .prepare(sql)
            .await
            .with_context(|| format!("Failed to prepare Cassandra query: {sql}"))?;
        let values = parameters
            .iter()
            .map(Self::json_to_cql_value)
            .collect::<Result<Vec<_>>>()?;
        let response = self
            .session
            .execute_unpaged(&prepared, values)
            .await
            .with_context(|| format!("Cassandra query failed: {sql}"))?;

        Self::query_response_to_result(response, sql, started_at)
    }

    /// Restore a reviewed payload. A TableR JSON snapshot replays as
    /// prepared `INSERT` statements with every value bound as a
    /// `fromJson(?)` marker — no snapshot value is ever interpolated into
    /// CQL text. Each distinct insert statement is prepared once and
    /// executed sequentially per row.
    ///
    /// Atomicity caveat: CQL has no multi-table transaction and BATCH is
    /// only used for the bounded edit/import paths (`ensure_batch_fits`
    /// caps), not here — a checkpoint can legitimately exceed any batch
    /// cap. A failed replay therefore leaves earlier rows applied, which
    /// is honest: INSERT in Cassandra is an upsert keyed by primary key,
    /// so a snapshot overlays data rather than rebuilding it. Anything
    /// that is not a JSON snapshot keeps the default sequential statement
    /// path.
    async fn execute_restore_statements(&self, statements: &[String]) -> Result<u64> {
        let Some(plans) =
            Self::snapshot_restore_inserts(statements, self.current_keyspace_name().as_deref())?
        else {
            return self.execute_structure_statements(statements).await;
        };

        let mut total_affected = 0_u64;
        for (cql, bind_rows) in plans {
            if bind_rows.is_empty() {
                continue;
            }
            let prepared =
                self.session.prepare(cql.as_str()).await.with_context(|| {
                    format!("Failed to prepare Cassandra restore insert: {cql}")
                })?;
            for binds in bind_rows {
                self.session
                    .execute_unpaged(&prepared, binds)
                    .await
                    .with_context(|| format!("Cassandra restore insert failed: {cql}"))?;
                total_affected += 1;
            }
        }
        Ok(total_affected)
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
        let started_at = Instant::now();
        let (_, _, qualified_table) = self.resolve_table_target(table, database)?;
        // CQL has no OFFSET, so the page is produced by streaming rows and
        // skipping `offset` of them. A CQL LIMIT bounds how much the server
        // sends; the +1 row detects whether another page exists. Paging goes
        // through query_iter (not the 500-row capped query_to_result) so
        // offsets beyond the interactive cap still return data.
        let fetch_limit = offset.saturating_add(limit).saturating_add(1);

        let mut query = format!("SELECT * FROM {qualified_table}");

        if let Some(filter_clause) = sanitize_cassandra_filter_clause(filter)? {
            query.push_str(&format!(" WHERE {filter_clause}"));
            query.push_str(" ALLOW FILTERING");
        }

        if let Some(order_column) = order_by {
            let direction = normalize_order_dir(order_dir)?;
            query.push_str(&format!(
                " ORDER BY {} {}",
                quote_cassandra_order_by(order_column)?,
                direction
            ));
        }

        query.push_str(&format!(" LIMIT {fetch_limit}"));

        let page_size = i32::try_from(fetch_limit.clamp(1, 5_000)).unwrap_or(5_000);
        let statement = Statement::new(query.clone()).with_page_size(page_size);
        let pager = self
            .session
            .query_iter(statement, &[])
            .await
            .with_context(|| format!("Cassandra query failed: {query}"))?;
        let columns = pager
            .column_specs()
            .as_slice()
            .iter()
            .map(|spec| ColumnInfo {
                name: spec.name().to_string(),
                data_type: format!("{:?}", spec.typ()),
                is_nullable: true,
                is_primary_key: false,
                max_length: None,
                default_value: None,
            })
            .collect::<Vec<_>>();
        let mut rows_stream = pager
            .rows_stream::<ScyllaRow>()
            .context("Failed to deserialize Cassandra rows")?;

        let start = usize::try_from(offset).unwrap_or(usize::MAX);
        let requested = usize::try_from(limit).unwrap_or(usize::MAX);
        let mut rows = Vec::new();
        let mut seen = 0usize;
        let mut truncated = false;
        while let Some(row) = rows_stream.next().await {
            let row = row.context("Failed to deserialize a Cassandra row")?;
            if seen < start {
                seen += 1;
                continue;
            }
            if rows.len() == requested {
                truncated = true;
                break;
            }
            rows.push(
                row.columns
                    .into_iter()
                    .map(|value| {
                        value
                            .map(Self::cql_value_to_json)
                            .unwrap_or(JsonValue::Null)
                    })
                    .collect::<Vec<_>>(),
            );
            seen += 1;
        }

        Ok(QueryResult {
            columns,
            rows,
            affected_rows: 0,
            execution_time_ms: started_at.elapsed().as_millis(),
            query,
            sandboxed: false,
            truncated,
        })
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
        let batch_size = usize::try_from(batch_size.max(1)).unwrap_or(usize::MAX);
        let setup = async move {
            let (_, _, qualified_table) = self.resolve_table_target(table, database)?;
            let mut query = format!("SELECT * FROM {qualified_table}");

            if let Some(filter_clause) = sanitize_cassandra_filter_clause(filter)? {
                query.push_str(&format!(" WHERE {filter_clause}"));
                query.push_str(" ALLOW FILTERING");
            }

            if let Some(order_column) = order_by {
                let direction = normalize_order_dir(order_dir)?;
                query.push_str(&format!(
                    " ORDER BY {} {}",
                    quote_cassandra_order_by(order_column)?,
                    direction
                ));
            }

            // CQL has no OFFSET; page through the whole result set natively so
            // exports are not bounded by the interactive row cap.
            let page_size = i32::try_from(batch_size).unwrap_or(i32::MAX);
            let statement = Statement::new(query.clone()).with_page_size(page_size);
            let pager = self
                .session
                .query_iter(statement, &[])
                .await
                .with_context(|| format!("Cassandra export query failed: {query}"))?;
            let columns = pager
                .column_specs()
                .as_slice()
                .iter()
                .map(|spec| ColumnInfo {
                    name: spec.name().to_string(),
                    data_type: format!("{:?}", spec.typ()),
                    is_nullable: true,
                    is_primary_key: false,
                    max_length: None,
                    default_value: None,
                })
                .collect::<Vec<_>>();
            let rows = pager
                .rows_stream::<ScyllaRow>()
                .context("Failed to deserialize Cassandra export rows")?;
            Ok::<_, anyhow::Error>(stream::try_unfold(
                (columns, rows, query),
                move |(columns, mut rows, query)| async move {
                    let mut batch = Vec::new();
                    while batch.len() < batch_size {
                        let Some(row) = rows.next().await else {
                            break;
                        };
                        let row = row.context("Failed to deserialize a Cassandra row")?;
                        batch.push(
                            row.columns
                                .into_iter()
                                .map(|value| {
                                    value
                                        .map(Self::cql_value_to_json)
                                        .unwrap_or(JsonValue::Null)
                                })
                                .collect::<Vec<_>>(),
                        );
                    }
                    if batch.is_empty() {
                        return Ok(None);
                    }
                    let result = QueryResult {
                        columns: columns.clone(),
                        rows: batch,
                        affected_rows: 0,
                        execution_time_ms: 0,
                        query: query.clone(),
                        sandboxed: false,
                        truncated: false,
                    };
                    Ok(Some((result, (columns, rows, query))))
                },
            ))
        };
        stream::once(setup).try_flatten().boxed()
    }

    async fn count_rows(&self, table: &str, database: Option<&str>) -> Result<i64> {
        let (_, _, qualified_table) = self.resolve_table_target(table, database)?;
        let result = self
            .query_to_result(
                &format!("SELECT COUNT(*) AS count FROM {qualified_table}"),
                "SELECT COUNT(*)",
            )
            .await?;
        Self::scalar_i64(&result)
    }

    async fn count_null_values(
        &self,
        _table: &str,
        _database: Option<&str>,
        _column: &str,
    ) -> Result<i64> {
        Err(anyhow!(
            "Counting NULL values is not supported for Cassandra because NULLs are not stored explicitly."
        ))
    }

    async fn update_table_cell(&self, request: &TableCellUpdateRequest) -> Result<u64> {
        let (_, _, qualified_table) =
            self.resolve_table_target(&request.table, request.database.as_deref())?;
        let where_clause = Self::build_where_clause(&request.primary_keys)?;
        let query = format!(
            "UPDATE {qualified_table} SET {} = {} WHERE {}",
            quote_cassandra_identifier(&request.target_column)?,
            Self::json_to_cql_term(&request.value, true)?,
            where_clause,
        );

        self.session
            .query_unpaged(query, &[])
            .await
            .context("Failed to update Cassandra table cell")?;
        Ok(1)
    }

    async fn delete_table_rows(&self, request: &TableRowDeleteRequest) -> Result<u64> {
        let (_, _, qualified_table) =
            self.resolve_table_target(&request.table, request.database.as_deref())?;
        let mut deleted = 0u64;

        for row in &request.rows {
            let where_clause = Self::build_where_clause(row)?;
            self.session
                .query_unpaged(
                    format!("DELETE FROM {qualified_table} WHERE {where_clause}"),
                    &[],
                )
                .await
                .context("Failed to delete Cassandra row")?;
            deleted += 1;
        }

        Ok(deleted)
    }

    async fn insert_table_row(&self, request: &TableRowInsertRequest) -> Result<u64> {
        if request.values.is_empty() {
            return Err(anyhow!("Cannot insert an empty Cassandra row"));
        }

        let (_, _, qualified_table) =
            self.resolve_table_target(&request.table, request.database.as_deref())?;
        let columns = request
            .values
            .iter()
            .map(|(name, _)| quote_cassandra_identifier(name))
            .collect::<Result<Vec<_>>>()?;
        let values = request
            .values
            .iter()
            .map(|(_, value)| Self::json_to_cql_term(value, true))
            .collect::<Result<Vec<_>>>()?;

        let query = format!(
            "INSERT INTO {qualified_table} ({}) VALUES ({})",
            columns.join(", "),
            values.join(", "),
        );

        self.session
            .query_unpaged(query, &[])
            .await
            .context("Failed to insert Cassandra row")?;
        Ok(1)
    }

    /// Apply the edit queue inside one logged CQL BATCH — atomic (all
    /// mutations apply or none do) though not isolated, and capped by
    /// `ensure_batch_fits` so oversized queues are rejected rather than
    /// partially applied.
    async fn apply_table_updates_atomically(
        &self,
        updates: &[TableCellUpdateRequest],
    ) -> Result<u64> {
        if updates.is_empty() {
            return Err(anyhow!("Atomic edit queue requires at least one update"));
        }

        let statements = updates
            .iter()
            .map(|update| self.build_cell_update_statement(update))
            .collect::<Result<Vec<_>>>()?;
        self.execute_logged_batch(&statements).await?;
        Ok(updates.len() as u64)
    }

    /// Import CSV rows inside one logged CQL BATCH. Imports larger than the
    /// documented batch caps are rejected up front — Cassandra has no
    /// transaction spanning multiple batches, so chunking would break the
    /// all-or-nothing contract.
    async fn insert_table_rows_atomically(
        &self,
        requests: &[TableRowInsertRequest],
        cancelled: Arc<AtomicBool>,
    ) -> Result<u64> {
        if requests.is_empty() {
            return Err(anyhow!("CSV import requires at least one row"));
        }
        if cancelled.load(Ordering::Relaxed) {
            return Err(anyhow!("CSV import cancelled; all rows were rolled back"));
        }

        let statements = requests
            .iter()
            .map(|request| self.build_row_insert_statement(request))
            .collect::<Result<Vec<_>>>()?;
        self.execute_logged_batch(&statements).await?;
        Ok(requests.len() as u64)
    }

    /// Consume the row stream, then commit it as one logged batch. Nothing is
    /// written until every row parses, so a parse failure, cancellation, or
    /// early channel close leaves the table untouched.
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
        }
        self.insert_table_rows_atomically(&requests, cancelled)
            .await
    }

    async fn use_database(&self, database: &str) -> Result<()> {
        let trimmed = database.trim();
        if trimmed.is_empty() {
            return Err(anyhow!("Cassandra keyspace name cannot be empty"));
        }

        self.session
            .use_keyspace(trimmed, false)
            .await
            .with_context(|| format!("Failed to switch Cassandra keyspace to {trimmed}"))?;

        let mut guard = self
            .current_keyspace
            .write()
            .map_err(|_| anyhow!("Cassandra keyspace state lock was poisoned"))?;
        *guard = Some(trimmed.to_string());
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
        self.current_keyspace_name()
    }

    fn driver_name(&self) -> &str {
        "cassandra"
    }
}

#[cfg(test)]
mod tests {
    use super::CassandraDriver;
    use serde_json::json;

    #[test]
    fn parses_use_statement() {
        assert_eq!(
            CassandraDriver::parse_use_statement("USE analytics;"),
            Some("analytics".to_string())
        );
        assert_eq!(
            CassandraDriver::parse_use_statement("use \"CaseSensitiveKs\""),
            Some("CaseSensitiveKs".to_string())
        );
        assert_eq!(CassandraDriver::parse_use_statement("SELECT 1"), None);
    }

    #[test]
    fn wraps_json_term_for_cql() {
        assert_eq!(
            CassandraDriver::json_to_cql_term(&json!({"id": 1, "tags": ["a"]}), true).unwrap(),
            "fromJson('{\"id\":1,\"tags\":[\"a\"]}')"
        );
        assert_eq!(
            CassandraDriver::json_to_cql_term(&json!(null), true).unwrap(),
            "null"
        );
    }

    #[test]
    fn batch_caps_reject_oversized_work() {
        // Statement-count cap: one over the limit is rejected.
        let too_many = vec!["UPDATE t SET c = 1 WHERE k = 1".to_string(); 101];
        assert!(CassandraDriver::ensure_batch_fits(&too_many).is_err());
        let at_cap = vec!["UPDATE t SET c = 1 WHERE k = 1".to_string(); 100];
        assert!(CassandraDriver::ensure_batch_fits(&at_cap).is_ok());

        // Byte cap: few statements can still exceed the batch byte budget.
        let oversized = vec!["x".repeat(40 * 1024)];
        assert!(CassandraDriver::ensure_batch_fits(&oversized).is_err());
    }

    #[test]
    fn snapshot_payload_maps_to_bound_inserts() {
        let snapshot = json!({
            "meta": {"format": "json-snapshot", "engine": "cassandra"},
            "tables": [
                {
                    "name": "users",
                    "schema": "analytics",
                    "rows": [
                        {"id": 1, "name": "amy"},
                        {"id": 2, "name": "bob", "deleted": null}
                    ]
                },
                {
                    "name": "orders",
                    "schema": "analytics",
                    "rows": [{"id": 9, "total": 12.5}]
                }
            ]
        })
        .to_string();

        let plans = CassandraDriver::snapshot_restore_inserts(&[snapshot], None)
            .unwrap()
            .expect("a json-snapshot payload produces a replay plan");
        // Three distinct key sets → three prepared statements.
        assert_eq!(plans.len(), 3);
        let (first_cql, first_binds) = &plans[0];
        assert_eq!(
            first_cql,
            r#"INSERT INTO "analytics"."users" ("id", "name") VALUES (fromJson(?), fromJson(?))"#
        );
        assert_eq!(
            first_binds,
            &vec![vec![
                Some(scylla::value::CqlValue::Text("1".to_string())),
                Some(scylla::value::CqlValue::Text("\"amy\"".to_string())),
            ]]
        );
        // Null binds as a real CQL NULL (`None`), not the string "null".
        let (nullable_cql, nullable_binds) = &plans[1];
        assert!(nullable_cql.contains("\"deleted\""));
        assert_eq!(nullable_binds[0][2], None);
        // `schema` supplies the keyspace when the name is bare.
        assert!(plans[2]
            .0
            .starts_with(r#"INSERT INTO "analytics"."orders""#));
    }

    #[test]
    fn snapshot_array_rows_zip_the_column_list() {
        let snapshot = json!({
            "meta": {"format": "json-snapshot"},
            "tables": [{
                "name": "metrics",
                "columns": ["pk", "value"],
                "rows": [["m1", 7]]
            }]
        })
        .to_string();

        let plans = CassandraDriver::snapshot_restore_inserts(&[snapshot], Some("default_ks"))
            .unwrap()
            .unwrap();
        assert_eq!(
            plans[0].0,
            r#"INSERT INTO "default_ks"."metrics" ("pk", "value") VALUES (fromJson(?), fromJson(?))"#
        );
        assert_eq!(plans[0].1[0].len(), 2);

        // More cells than the exported column list is corrupt input.
        let bad = json!({
            "meta": {"format": "json-snapshot"},
            "tables": [{
                "name": "metrics",
                "columns": ["pk"],
                "rows": [["m1", "extra"]]
            }]
        })
        .to_string();
        assert!(CassandraDriver::snapshot_restore_inserts(&[bad], Some("default_ks")).is_err());

        // Array rows with no column list at all cannot be replayed.
        let no_columns = json!({
            "meta": {"format": "json-snapshot"},
            "tables": [{"name": "metrics", "rows": [["m1", 7]]}]
        })
        .to_string();
        assert!(
            CassandraDriver::snapshot_restore_inserts(&[no_columns], Some("default_ks")).is_err()
        );
    }

    #[test]
    fn non_snapshot_payloads_stay_on_the_cql_path_or_fail() {
        // Plain CQL is not a snapshot → None keeps the sequential path.
        let cql = vec!["INSERT INTO ks.t (id) VALUES (1)".to_string()];
        assert!(CassandraDriver::snapshot_restore_inserts(&cql, None)
            .unwrap()
            .is_none());

        // `{`-led JSON that is not a json-snapshot is a hard error.
        let wrong_format = json!({"meta": {"format": "csv-dump"}, "tables": []}).to_string();
        assert!(CassandraDriver::snapshot_restore_inserts(&[wrong_format], None).is_err());

        // Missing `tables` array.
        let no_tables = json!({"meta": {"format": "json-snapshot"}}).to_string();
        assert!(CassandraDriver::snapshot_restore_inserts(&[no_tables], None).is_err());

        // Unparseable JSON.
        assert!(
            CassandraDriver::snapshot_restore_inserts(&["{not json".to_string()], None).is_err()
        );

        // No keyspace anywhere → the snapshot cannot resolve a target.
        let no_keyspace = json!({
            "meta": {"format": "json-snapshot"},
            "tables": [{"name": "t", "rows": [{"id": 1}]}]
        })
        .to_string();
        assert!(CassandraDriver::snapshot_restore_inserts(&[no_keyspace], None).is_err());
    }
}
