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
use scylla::client::session::Session;
use scylla::client::session_builder::SessionBuilder;
use scylla::cluster::metadata::{ColumnKind, Table};
use scylla::value::{CqlValue, Row as ScyllaRow};
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::collections::BTreeSet;
use std::sync::{Arc, RwLock as StdRwLock};
use std::time::Instant;

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
                    .map(|value| value.map(Self::cql_value_to_json).unwrap_or(JsonValue::Null))
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

    async fn query_to_objects(&self, cql: &str) -> Result<Vec<JsonMap<String, JsonValue>>> {
        let result = self.query_to_result(cql, cql).await?;
        Ok(result
            .rows
            .into_iter()
            .map(|row| {
                result
                    .columns
                    .iter()
                    .zip(row.into_iter())
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
                    .map(|value| value.map(Self::cql_value_to_json).unwrap_or(JsonValue::Null))
                    .collect::<Vec<_>>(),
            ),
            CqlValue::UserDefinedType { fields, .. } => JsonValue::Object(
                fields
                    .into_iter()
                    .map(|(name, value)| {
                        (
                            name,
                            value.map(Self::cql_value_to_json).unwrap_or(JsonValue::Null),
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
        let ck_names = table.clustering_key.iter().cloned().collect::<BTreeSet<_>>();
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

        for statement in statements.iter().filter(|statement| !statement.trim().is_empty()) {
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
        let (_, _, qualified_table) = self.resolve_table_target(table, database)?;
        let fetch_limit = offset.saturating_add(limit).saturating_add(1);
        let capped_limit = fetch_limit.min(MAX_QUERY_RESULT_ROWS as u64);

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

        query.push_str(&format!(" LIMIT {capped_limit}"));

        let mut result = self.query_to_result(&query, &query).await?;
        let start = usize::try_from(offset).unwrap_or(usize::MAX);
        let requested = usize::try_from(limit).unwrap_or(usize::MAX);
        let has_more = result.rows.len() > start.saturating_add(requested);
        let trimmed_rows = result
            .rows
            .into_iter()
            .skip(start)
            .take(requested)
            .collect::<Vec<_>>();

        result.rows = trimmed_rows;
        result.truncated = result.truncated || has_more;
        Ok(result)
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
}
