use super::driver::DatabaseDriver;
use super::models::*;
use super::query_cancel::{
    cancel_flag, request_cancel, CancelLookup, CancelScopeGuard, QueryCancelRegistry,
};
use super::query_common::{statement_returns_rows, MAX_QUERY_RESULT_ROWS};
use super::safety::{
    normalize_order_dir, quote_snowflake_identifier, quote_snowflake_order_by,
    sanitize_snowflake_filter_clause,
};
use super::snowflake_support::{
    SnowflakeApiResponse, SnowflakeStatementBinding, SnowflakeStatementContext,
    SnowflakeStatementParameters, SnowflakeStatementRequest,
};
use crate::utils::sql::split_sql_statements;
use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use reqwest::Client;
use serde_json::Value as JsonValue;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock as StdRwLock};
use std::time::Instant;
use tokio::sync::RwLock;

pub(super) const SNOWFLAKE_QUERY_TIMEOUT_SECS: u64 = 45;
pub(super) const SNOWFLAKE_POLL_INTERVAL_MS: u64 = 300;
pub(super) const SNOWFLAKE_POLL_ATTEMPTS: usize = 400;
pub(super) const SNOWFLAKE_USER_AGENT: &str = "TableR/0.1";

pub(super) fn snowflake_query_returns_rows(sql: &str) -> bool {
    statement_returns_rows(sql, &["SELECT", "SHOW", "DESCRIBE", "EXPLAIN", "WITH"])
}

pub struct SnowflakeDriver {
    pub(super) client: Client,
    pub(super) root_url: String,
    pub(super) statements_url: String,
    pub(super) access_token: String,
    pub(super) current_db: Arc<RwLock<Option<String>>>,
    pub(super) current_schema: Arc<RwLock<Option<String>>>,
    pub(super) warehouse: Option<String>,
    pub(super) role: Option<String>,
    /// request_id → running-query scope so `cancel_query_request` can abort
    /// the in-flight statement over a second HTTP request.
    cancel_registry: StdRwLock<QueryCancelRegistry>,
    /// request_id → Snowflake statement handle (the query id) of the
    /// statement currently in flight for that request.
    pending_handles: Mutex<HashMap<String, String>>,
}

impl SnowflakeDriver {
    pub async fn connect(config: &ConnectionConfig) -> Result<Self> {
        let (root_url, statements_url) = Self::build_urls(config)?;
        let access_token = config
            .password
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .context("Snowflake auth token is required")?
            .to_string();

        let driver = Self {
            client: Client::builder()
                .build()
                .context("Failed to initialize Snowflake HTTP client")?,
            root_url,
            statements_url,
            access_token,
            current_db: Arc::new(RwLock::new(
                config
                    .database
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string),
            )),
            current_schema: Arc::new(RwLock::new(
                config
                    .additional_fields
                    .get("schema")
                    .map(String::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string),
            )),
            warehouse: config
                .additional_fields
                .get("warehouse")
                .map(String::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
            role: config
                .additional_fields
                .get("role")
                .map(String::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
            cancel_registry: StdRwLock::new(QueryCancelRegistry::new()),
            pending_handles: Mutex::new(HashMap::new()),
        };

        driver.ping().await?;
        driver.refresh_session_namespace().await?;
        Ok(driver)
    }

    pub(super) fn current_database_name(&self) -> Option<String> {
        self.current_db
            .try_read()
            .ok()
            .and_then(|guard| guard.clone())
    }

    pub(super) fn current_schema_name(&self) -> Option<String> {
        self.current_schema
            .try_read()
            .ok()
            .and_then(|guard| guard.clone())
    }

    pub(super) fn build_statement_context(
        &self,
        database_override: Option<&str>,
    ) -> SnowflakeStatementContext {
        SnowflakeStatementContext {
            database: database_override
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .or_else(|| self.current_database_name()),
            schema: self.current_schema_name(),
            warehouse: self.warehouse.clone(),
            role: self.role.clone(),
        }
    }

    pub(super) fn build_statement_request(
        &self,
        statement: &str,
        database_override: Option<&str>,
    ) -> SnowflakeStatementRequest {
        let context = self.build_statement_context(database_override);
        SnowflakeStatementRequest {
            statement: statement.trim().to_string(),
            timeout: SNOWFLAKE_QUERY_TIMEOUT_SECS,
            database: context.database,
            schema: context.schema,
            warehouse: context.warehouse,
            role: context.role,
            bindings: None,
            parameters: SnowflakeStatementParameters {
                rows_per_resultset: MAX_QUERY_RESULT_ROWS + 1,
                date_output_format: "YYYY-MM-DD",
                time_output_format: "HH24:MI:SS.FF3",
                timestamp_ltz_output_format: "YYYY-MM-DD HH24:MI:SS.FF3 TZHTZM",
                timestamp_ntz_output_format: "YYYY-MM-DD HH24:MI:SS.FF3",
                timestamp_tz_output_format: "YYYY-MM-DD HH24:MI:SS.FF3 TZHTZM",
                timezone: "UTC",
                use_cached_result: true,
            },
        }
    }

    pub(super) fn apply_common_headers(
        &self,
        request: reqwest::RequestBuilder,
    ) -> reqwest::RequestBuilder {
        request
            .bearer_auth(&self.access_token)
            .header("Accept", "application/json")
            .header("User-Agent", SNOWFLAKE_USER_AGENT)
    }

    pub(super) fn build_status_url_from_handle(&self, handle: &str) -> String {
        format!(
            "{}/api/v2/statements/{}",
            self.root_url.trim_end_matches('/'),
            handle
        )
    }

    pub(super) fn normalize_status_url(&self, raw_url: &str) -> String {
        let trimmed = raw_url.trim();
        if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
            trimmed.to_string()
        } else if trimmed.starts_with('/') {
            format!("{}{}", self.root_url.trim_end_matches('/'), trimmed)
        } else {
            format!("{}/{}", self.root_url.trim_end_matches('/'), trimmed)
        }
    }

    /// Whether a cancel was already requested for this request scope.
    fn cancel_requested(&self, request_id: &str) -> bool {
        cancel_flag(&self.cancel_registry, request_id)
            .map(|flag| flag.load(Ordering::SeqCst))
            .unwrap_or(false)
    }

    fn store_pending_handle(&self, request_id: &str, handle: &str) {
        let mut handles = self
            .pending_handles
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        handles.insert(request_id.to_string(), handle.to_string());
    }

    fn take_pending_handle(&self, request_id: &str) -> Option<String> {
        let mut handles = self
            .pending_handles
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        handles.remove(request_id)
    }

    /// URL of the SQL API's dedicated cancel endpoint for one statement
    /// handle (`POST /api/v2/statements/{handle}/cancel`).
    fn statement_cancel_url(&self, handle: &str) -> String {
        format!("{}/{}/cancel", self.statements_url, handle)
    }

    /// Abort a running statement through the SQL API's dedicated cancel
    /// endpoint (`POST /api/v2/statements/{handle}/cancel`). The statement
    /// handle returned by the statements API is the server-side query id, so
    /// this is equivalent to `SYSTEM$CANCEL_QUERY` without needing a second
    /// statement execution (and a session/warehouse) to run it.
    ///
    /// A session `QUERY_TAG` + `QUERY_HISTORY_BY_SESSION` lookup was
    /// considered and rejected: the SQL API is stateless, so `ALTER SESSION`
    /// would not reliably land on the same session as the query being
    /// cancelled.
    async fn cancel_statement_handle(&self, handle: &str) -> Result<()> {
        let url = self.statement_cancel_url(handle);
        let response = self
            .apply_common_headers(self.client.post(&url))
            .send()
            .await
            .with_context(|| format!("Failed to reach Snowflake cancel endpoint {url}"))?;
        let status = response.status();
        let body = response
            .text()
            .await
            .context("Failed to read Snowflake cancel response")?;

        if status.is_success() {
            return Ok(());
        }

        // A statement that already finished cannot be cancelled, but the
        // caller's goal — nothing left running — is still met.
        let lowered = body.to_ascii_lowercase();
        if lowered.contains("not found")
            || lowered.contains("already")
            || lowered.contains("completed")
            || lowered.contains("no longer running")
        {
            return Ok(());
        }

        Err(anyhow!(
            "{}",
            Self::format_api_error(status.as_u16(), &body)
        ))
    }

    /// `execute_bound_query` scoped to a request: the statement handle is
    /// registered as soon as the statements API returns it (before polling)
    /// so `cancel_query_request` can abort the in-flight statement.
    async fn execute_bound_query_scoped(
        &self,
        request_id: &str,
        sql: &str,
        database_override: Option<&str>,
        preserve_query_text: &str,
        bindings: Option<std::collections::BTreeMap<String, SnowflakeStatementBinding>>,
    ) -> Result<QueryResult> {
        let trimmed_sql = sql.trim();
        if trimmed_sql.is_empty() {
            return Err(anyhow!("Snowflake query cannot be empty"));
        }
        if self.cancel_requested(request_id) {
            return Err(anyhow!("Query cancelled."));
        }

        let started_at = Instant::now();
        let initial = self
            .post_statement(trimmed_sql, database_override, bindings)
            .await?;

        // The POST response carries the statement handle immediately, even
        // while the statement is still running — register it before polling.
        let handle = match &initial {
            SnowflakeApiResponse::Pending(status) => status.statement_handle.clone(),
            SnowflakeApiResponse::Ready(result_set) => result_set.statement_handle.clone(),
        };
        if let Some(handle) = handle.as_deref() {
            self.store_pending_handle(request_id, handle);
        }

        // A cancel that raced ahead of the handle registration still reaches
        // the statement: abort it now instead of polling to completion.
        if self.cancel_requested(request_id) {
            if let Some(handle) = handle.as_deref() {
                if let Err(error) = self.cancel_statement_handle(handle).await {
                    log::warn!("Snowflake cancel for {handle} failed: {error}");
                }
            }
            self.take_pending_handle(request_id);
            return Err(anyhow!("Query cancelled."));
        }

        let result = self.await_result_set(initial).await;
        self.take_pending_handle(request_id);
        let result_set = result?;
        self.result_set_to_query_result(result_set, preserve_query_text, started_at)
            .await
    }

    /// `execute_query` scoped to a request: every statement of a
    /// multi-statement script registers its own handle so a cancel aborts
    /// whichever statement is currently running.
    async fn execute_query_scoped(&self, request_id: &str, sql: &str) -> Result<QueryResult> {
        let started_at = Instant::now();
        let statements = split_sql_statements(sql);

        if statements.len() <= 1 {
            return self
                .execute_bound_query_scoped(request_id, sql, None, sql, None)
                .await;
        }

        let mut total_affected = 0u64;
        let mut last_result = None;

        for statement in statements
            .iter()
            .filter(|statement| !statement.trim().is_empty())
        {
            let result = self
                .execute_bound_query_scoped(request_id, statement, None, sql, None)
                .await?;
            total_affected += result.affected_rows;

            if Self::query_returns_rows(statement) || !result.rows.is_empty() {
                last_result = Some(result);
            }
        }

        if let Some(mut result) = last_result {
            result.execution_time_ms = started_at.elapsed().as_millis();
            result.affected_rows = total_affected;
            return Ok(result);
        }

        Ok(QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            affected_rows: total_affected,
            execution_time_ms: started_at.elapsed().as_millis(),
            query: sql.to_string(),
            sandboxed: false,
            truncated: false,
        })
    }
}

#[async_trait]
impl DatabaseDriver for SnowflakeDriver {
    async fn ping(&self) -> Result<()> {
        let result = self
            .execute_single_query("SELECT 1 AS ok", None, "SELECT 1 AS ok")
            .await
            .context("Snowflake ping failed")?;
        let _ = Self::scalar_i64(&result)?;
        Ok(())
    }

    async fn disconnect(&self) -> Result<()> {
        Ok(())
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        let sql = "SHOW TERSE DATABASES";
        let result = self.execute_single_query(sql, None, sql).await?;
        let mut databases = result
            .rows
            .iter()
            .filter_map(|row| Self::cell_as_string(row, &result.columns, &["name"]))
            .map(|name| DatabaseInfo { name, size: None })
            .collect::<Vec<_>>();
        databases.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(databases)
    }

    async fn list_tables(&self, database: Option<&str>) -> Result<Vec<TableInfo>> {
        let database_name = self.resolve_database_name(database)?;
        let sql = format!(
            "SELECT TABLE_SCHEMA AS schema_name, TABLE_NAME AS table_name, TABLE_TYPE AS table_type \
             FROM {} \
             WHERE TABLE_SCHEMA <> 'INFORMATION_SCHEMA' \
             ORDER BY TABLE_SCHEMA, TABLE_NAME",
            Self::info_schema_relation(&database_name, "TABLES")?,
        );
        let result = self
            .execute_single_query(&sql, Some(&database_name), &sql)
            .await?;

        Ok(result
            .rows
            .iter()
            .map(|row| TableInfo {
                create_date: None,
                name: Self::cell_as_string(row, &result.columns, &["table_name"])
                    .unwrap_or_else(|| "table".to_string()),
                schema: Self::cell_as_string(row, &result.columns, &["schema_name"]),
                table_type: Self::cell_as_string(row, &result.columns, &["table_type"])
                    .map(|value| Self::object_type_from_table_type(&value))
                    .unwrap_or_else(|| "TABLE".to_string()),
                row_count: None,
                engine: Some("Snowflake".to_string()),
            })
            .collect())
    }

    async fn list_schema_objects(&self, database: Option<&str>) -> Result<Vec<SchemaObjectInfo>> {
        let database_name = self.resolve_database_name(database)?;
        let views_sql = format!(
            "SELECT TABLE_SCHEMA AS schema_name, TABLE_NAME AS object_name, VIEW_DEFINITION AS definition \
             FROM {} \
             WHERE TABLE_SCHEMA <> 'INFORMATION_SCHEMA' \
             ORDER BY TABLE_SCHEMA, TABLE_NAME",
            Self::info_schema_relation(&database_name, "VIEWS")?,
        );
        let views_result = self
            .execute_single_query(&views_sql, Some(&database_name), &views_sql)
            .await?;

        let mut objects = views_result
            .rows
            .iter()
            .map(|row| SchemaObjectInfo {
                create_date: None,
                name: Self::cell_as_string(row, &views_result.columns, &["object_name"])
                    .unwrap_or_else(|| "view".to_string()),
                schema: Self::cell_as_string(row, &views_result.columns, &["schema_name"]),
                object_type: "VIEW".to_string(),
                related_table: None,
                definition: Self::cell_as_string(row, &views_result.columns, &["definition"]),
            })
            .collect::<Vec<_>>();

        let materialized_sql = format!(
            "SELECT TABLE_SCHEMA AS schema_name, TABLE_NAME AS object_name, TABLE_TYPE AS object_type \
             FROM {} \
             WHERE TABLE_TYPE = 'MATERIALIZED VIEW' \
               AND TABLE_SCHEMA <> 'INFORMATION_SCHEMA' \
             ORDER BY TABLE_SCHEMA, TABLE_NAME",
            Self::info_schema_relation(&database_name, "TABLES")?,
        );
        let materialized_result = self
            .execute_single_query(&materialized_sql, Some(&database_name), &materialized_sql)
            .await?;
        objects.extend(materialized_result.rows.iter().map(|row| {
            SchemaObjectInfo {
                create_date: None,
                name: Self::cell_as_string(row, &materialized_result.columns, &["object_name"])
                    .unwrap_or_else(|| "materialized_view".to_string()),
                schema: Self::cell_as_string(row, &materialized_result.columns, &["schema_name"]),
                object_type: Self::cell_as_string(
                    row,
                    &materialized_result.columns,
                    &["object_type"],
                )
                .map(|value| value.to_ascii_uppercase())
                .unwrap_or_else(|| "MATERIALIZED VIEW".to_string()),
                related_table: None,
                definition: None,
            }
        }));

        let routines_sql = format!(
            "SELECT ROUTINE_SCHEMA AS schema_name, ROUTINE_NAME AS object_name, ROUTINE_TYPE AS object_type, ROUTINE_DEFINITION AS definition \
             FROM {} \
             WHERE ROUTINE_SCHEMA <> 'INFORMATION_SCHEMA' \
             ORDER BY ROUTINE_SCHEMA, ROUTINE_NAME",
            Self::info_schema_relation(&database_name, "ROUTINES")?,
        );
        if let Ok(routines_result) = self
            .execute_single_query(&routines_sql, Some(&database_name), &routines_sql)
            .await
        {
            objects.extend(routines_result.rows.iter().map(|row| {
                SchemaObjectInfo {
                    create_date: None,
                    name: Self::cell_as_string(row, &routines_result.columns, &["object_name"])
                        .unwrap_or_else(|| "routine".to_string()),
                    schema: Self::cell_as_string(row, &routines_result.columns, &["schema_name"]),
                    object_type: Self::cell_as_string(
                        row,
                        &routines_result.columns,
                        &["object_type"],
                    )
                    .map(|value| value.to_ascii_uppercase())
                    .unwrap_or_else(|| "ROUTINE".to_string()),
                    related_table: None,
                    definition: Self::cell_as_string(
                        row,
                        &routines_result.columns,
                        &["definition"],
                    ),
                }
            }));
        }

        objects.sort_by(|left, right| {
            left.schema
                .cmp(&right.schema)
                .then(left.name.cmp(&right.name))
        });
        Ok(objects)
    }

    async fn get_table_structure(
        &self,
        table: &str,
        database: Option<&str>,
    ) -> Result<TableStructure> {
        let table_reference = self.parse_table_reference(table, database)?;
        let database_name = table_reference.database.clone();
        let schema_literal = Self::sql_string_literal(&table_reference.schema);
        let table_literal = Self::sql_string_literal(&table_reference.table);

        let columns_sql = format!(
            "SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type, IS_NULLABLE AS is_nullable, COLUMN_DEFAULT AS column_default, COMMENT AS comment \
             FROM {} \
             WHERE TABLE_SCHEMA ILIKE {} AND TABLE_NAME ILIKE {} \
             ORDER BY ORDINAL_POSITION",
            Self::info_schema_relation(&database_name, "COLUMNS")?,
            schema_literal,
            table_literal,
        );
        let columns_result = self
            .execute_single_query(&columns_sql, Some(&database_name), &columns_sql)
            .await?;

        let primary_keys_sql = format!(
            "SELECT kcu.COLUMN_NAME AS column_name \
             FROM {} tc \
             JOIN {} kcu \
               ON tc.CONSTRAINT_CATALOG = kcu.CONSTRAINT_CATALOG \
              AND tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA \
              AND tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME \
             WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' \
               AND tc.TABLE_SCHEMA ILIKE {} \
               AND tc.TABLE_NAME ILIKE {} \
             ORDER BY kcu.ORDINAL_POSITION",
            Self::info_schema_relation(&database_name, "TABLE_CONSTRAINTS")?,
            Self::info_schema_relation(&database_name, "KEY_COLUMN_USAGE")?,
            schema_literal,
            table_literal,
        );
        let primary_keys_result = self
            .execute_single_query(&primary_keys_sql, Some(&database_name), &primary_keys_sql)
            .await?;
        let primary_keys = primary_keys_result
            .rows
            .iter()
            .filter_map(|row| {
                Self::cell_as_string(row, &primary_keys_result.columns, &["column_name"])
            })
            .collect::<HashSet<_>>();

        let columns = columns_result
            .rows
            .iter()
            .map(|row| {
                let column_name =
                    Self::cell_as_string(row, &columns_result.columns, &["column_name"])
                        .unwrap_or_else(|| "column".to_string());
                let is_nullable =
                    Self::cell_as_string(row, &columns_result.columns, &["is_nullable"])
                        .map(|value| value.eq_ignore_ascii_case("YES"))
                        .unwrap_or(true);
                let data_type = Self::cell_as_string(row, &columns_result.columns, &["data_type"])
                    .unwrap_or_else(|| "TEXT".to_string());

                ColumnDetail {
                    name: column_name.clone(),
                    data_type: data_type.clone(),
                    is_nullable,
                    is_primary_key: primary_keys.contains(&column_name),
                    default_value: Self::cell_as_string(
                        row,
                        &columns_result.columns,
                        &["column_default"],
                    ),
                    extra: None,
                    column_type: Some(data_type),
                    comment: Self::cell_as_string(row, &columns_result.columns, &["comment"]),
                }
            })
            .collect::<Vec<_>>();

        let foreign_keys_sql = format!(
            "SELECT \
                kcu.CONSTRAINT_NAME AS constraint_name, \
                kcu.COLUMN_NAME AS column_name, \
                ccu.TABLE_SCHEMA AS referenced_schema, \
                ccu.TABLE_NAME AS referenced_table, \
                ccu.COLUMN_NAME AS referenced_column, \
                rc.UPDATE_RULE AS update_rule, \
                rc.DELETE_RULE AS delete_rule \
             FROM {} tc \
             JOIN {} kcu \
               ON tc.CONSTRAINT_CATALOG = kcu.CONSTRAINT_CATALOG \
              AND tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA \
              AND tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME \
             JOIN {} rc \
               ON tc.CONSTRAINT_CATALOG = rc.CONSTRAINT_CATALOG \
              AND tc.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA \
              AND tc.CONSTRAINT_NAME = rc.CONSTRAINT_NAME \
             JOIN {} ccu \
               ON rc.UNIQUE_CONSTRAINT_CATALOG = ccu.CONSTRAINT_CATALOG \
              AND rc.UNIQUE_CONSTRAINT_SCHEMA = ccu.CONSTRAINT_SCHEMA \
              AND rc.UNIQUE_CONSTRAINT_NAME = ccu.CONSTRAINT_NAME \
              AND COALESCE(ccu.ORDINAL_POSITION, 0) = COALESCE(kcu.POSITION_IN_UNIQUE_CONSTRAINT, ccu.ORDINAL_POSITION, 0) \
             WHERE tc.CONSTRAINT_TYPE = 'FOREIGN KEY' \
               AND tc.TABLE_SCHEMA ILIKE {} \
               AND tc.TABLE_NAME ILIKE {} \
             ORDER BY kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION",
            Self::info_schema_relation(&database_name, "TABLE_CONSTRAINTS")?,
            Self::info_schema_relation(&database_name, "KEY_COLUMN_USAGE")?,
            Self::info_schema_relation(&database_name, "REFERENTIAL_CONSTRAINTS")?,
            Self::info_schema_relation(&database_name, "KEY_COLUMN_USAGE")?,
            schema_literal,
            table_literal,
        );
        let foreign_keys = match self
            .execute_single_query(&foreign_keys_sql, Some(&database_name), &foreign_keys_sql)
            .await
        {
            Ok(result) => result
                .rows
                .iter()
                .map(|row| {
                    let referenced_schema =
                        Self::cell_as_string(row, &result.columns, &["referenced_schema"]);
                    let referenced_table =
                        Self::cell_as_string(row, &result.columns, &["referenced_table"])
                            .unwrap_or_default();
                    ForeignKeyInfo {
                        name: Self::cell_as_string(row, &result.columns, &["constraint_name"])
                            .unwrap_or_else(|| "fk".to_string()),
                        column: Self::cell_as_string(row, &result.columns, &["column_name"])
                            .unwrap_or_default(),
                        referenced_table: referenced_schema
                            .filter(|schema| !schema.is_empty())
                            .map(|schema| format!("{schema}.{referenced_table}"))
                            .unwrap_or(referenced_table),
                        referenced_column: Self::cell_as_string(
                            row,
                            &result.columns,
                            &["referenced_column"],
                        )
                        .unwrap_or_default(),
                        on_update: Self::cell_as_string(row, &result.columns, &["update_rule"]),
                        on_delete: Self::cell_as_string(row, &result.columns, &["delete_rule"]),
                    }
                })
                .collect::<Vec<_>>(),
            Err(_) => Vec::new(),
        };

        let object_sql = format!(
            "SELECT TABLE_TYPE AS table_type \
             FROM {} \
             WHERE TABLE_SCHEMA ILIKE {} AND TABLE_NAME ILIKE {} \
             LIMIT 1",
            Self::info_schema_relation(&database_name, "TABLES")?,
            schema_literal,
            table_literal,
        );
        let object_result = self
            .execute_single_query(&object_sql, Some(&database_name), &object_sql)
            .await?;
        let object_type = object_result
            .rows
            .first()
            .and_then(|row| Self::cell_as_string(row, &object_result.columns, &["table_type"]))
            .map(|value| Self::object_type_from_table_type(&value));

        let view_definition = if object_type.as_deref() == Some("VIEW") {
            let view_sql = format!(
                "SELECT VIEW_DEFINITION AS definition \
                 FROM {} \
                 WHERE TABLE_SCHEMA ILIKE {} AND TABLE_NAME ILIKE {} \
                 LIMIT 1",
                Self::info_schema_relation(&database_name, "VIEWS")?,
                schema_literal,
                table_literal,
            );
            self.execute_single_query(&view_sql, Some(&database_name), &view_sql)
                .await
                .ok()
                .and_then(|result| {
                    result
                        .rows
                        .first()
                        .and_then(|row| Self::cell_as_string(row, &result.columns, &["definition"]))
                })
        } else {
            None
        };

        Ok(TableStructure {
            columns,
            indexes: Vec::new(),
            foreign_keys,
            triggers: Vec::new(),
            view_definition,
            object_type,
        })
    }

    async fn execute_query(&self, sql: &str) -> Result<QueryResult> {
        let started_at = Instant::now();
        let statements = split_sql_statements(sql);

        if statements.len() <= 1 {
            return self.execute_single_query(sql, None, sql).await;
        }

        let mut total_affected = 0u64;
        let mut last_result = None;

        for statement in statements
            .iter()
            .filter(|statement| !statement.trim().is_empty())
        {
            let result = self.execute_single_query(statement, None, sql).await?;
            total_affected += result.affected_rows;

            if Self::query_returns_rows(statement) || !result.rows.is_empty() {
                last_result = Some(result);
            }
        }

        if let Some(mut result) = last_result {
            result.execution_time_ms = started_at.elapsed().as_millis();
            result.affected_rows = total_affected;
            return Ok(result);
        }

        Ok(QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            affected_rows: total_affected,
            execution_time_ms: started_at.elapsed().as_millis(),
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
        let bindings = Self::statement_bindings(parameters)?;
        self.execute_bound_query(sql, None, sql, Some(bindings))
            .await
    }

    /// Request-scoped execution: the statement handle (Snowflake's query id)
    /// is captured from the POST response before polling so
    /// `cancel_query_request` can abort the in-flight statement over a second
    /// HTTP request.
    async fn execute_query_for_request(&self, request_id: &str, sql: &str) -> Result<QueryResult> {
        if request_id.trim().is_empty() {
            return self.execute_query(sql).await;
        }
        let guard = CancelScopeGuard::begin(&self.cancel_registry, request_id);
        // The backend id is a string handle tracked in `pending_handles`, so
        // registering a marker only resolves the pending race.
        if guard.register_backend(0) {
            return Err(anyhow!("Query cancelled."));
        }
        let result = self.execute_query_scoped(request_id, sql).await;
        drop(guard);
        result
    }

    /// Cancels by POSTing to `/api/v2/statements/{handle}/cancel` — the
    /// statement handle stored by `execute_query_for_request` is the
    /// server-side query id. The in-flight request is blocked polling, so the
    /// cancel rides a second HTTP request.
    async fn cancel_query_request(&self, request_id: &str) -> Result<bool> {
        match request_cancel(&self.cancel_registry, request_id) {
            CancelLookup::NotRunning => Ok(false),
            // Cancel was recorded before the statement handle landed; the
            // scoped execute path aborts as soon as the handle arrives.
            CancelLookup::Pending => Ok(true),
            CancelLookup::Backend(_) => {
                match self.take_pending_handle(request_id) {
                    Some(handle) => {
                        self.cancel_statement_handle(&handle).await?;
                        Ok(true)
                    }
                    // The statement finished between the POST and the cancel;
                    // nothing is left running.
                    None => Ok(true),
                }
            }
        }
    }

    /// Request-scoped parameterized execution: same handle registration as
    /// `execute_query_for_request`, with bind values travelling through the
    /// statements API `bindings` object.
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
        let result = async {
            let bindings = Self::statement_bindings(parameters)?;
            self.execute_bound_query_scoped(request_id, sql, None, sql, Some(bindings))
                .await
        }
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
        let table_reference = self.parse_table_reference(table, database)?;
        let database_name = table_reference.database.clone();
        let mut sql = format!(
            "SELECT * FROM {}",
            Self::qualify_table_name(&table_reference)?
        );

        if let Some(filter_clause) = sanitize_snowflake_filter_clause(filter)? {
            sql.push_str(&format!(" WHERE {filter_clause}"));
        }

        if let Some(order_column) = order_by {
            let direction = normalize_order_dir(order_dir)?;
            sql.push_str(&format!(
                " ORDER BY {} {}",
                quote_snowflake_order_by(order_column)?,
                direction
            ));
        }

        sql.push_str(&format!(" LIMIT {limit} OFFSET {offset}"));
        self.execute_single_query(&sql, Some(&database_name), &sql)
            .await
    }

    async fn count_rows(&self, table: &str, database: Option<&str>) -> Result<i64> {
        let table_reference = self.parse_table_reference(table, database)?;
        let database_name = table_reference.database.clone();
        let sql = format!(
            "SELECT COUNT(*) AS count FROM {}",
            Self::qualify_table_name(&table_reference)?,
        );
        let result = self
            .execute_single_query(&sql, Some(&database_name), &sql)
            .await?;
        Self::scalar_i64(&result)
    }

    async fn count_null_values(
        &self,
        table: &str,
        database: Option<&str>,
        column: &str,
    ) -> Result<i64> {
        let table_reference = self.parse_table_reference(table, database)?;
        let database_name = table_reference.database.clone();
        let sql = format!(
            "SELECT COUNT(*) AS count FROM {} WHERE {} IS NULL",
            Self::qualify_table_name(&table_reference)?,
            quote_snowflake_order_by(column)?,
        );
        let result = self
            .execute_single_query(&sql, Some(&database_name), &sql)
            .await?;
        Self::scalar_i64(&result)
    }

    async fn update_table_cell(&self, request: &TableCellUpdateRequest) -> Result<u64> {
        if request.primary_keys.is_empty() {
            return Err(anyhow!(
                "Inline update requires at least one primary key column"
            ));
        }

        let table_reference =
            self.parse_table_reference(&request.table, request.database.as_deref())?;
        let database_name = table_reference.database.clone();
        let sql = format!(
            "UPDATE {} SET {} = {} WHERE {}",
            Self::qualify_table_name(&table_reference)?,
            quote_snowflake_order_by(&request.target_column)?,
            Self::quote_sql_literal(&request.value)?,
            Self::build_where_clause(&request.primary_keys)?,
        );
        let result = self
            .execute_single_query(&sql, Some(&database_name), &sql)
            .await?;
        Ok(result.affected_rows)
    }

    /// Apply the staged edit queue inside one transaction: BEGIN, one bound
    /// UPDATE per request, COMMIT. The SQL API session persists via the auth
    /// token, so sequential requests share the transaction — a failed BEGIN
    /// (e.g. a sessionless token) rejects the queue instead of applying it
    /// non-atomically. A row that no longer matches its primary-key selector
    /// rolls the whole queue back.
    async fn apply_table_updates_atomically(
        &self,
        updates: &[TableCellUpdateRequest],
    ) -> Result<u64> {
        self.run_atomic_transaction(|| async {
            let mut affected_rows = 0u64;
            for request in updates {
                let (sql, parameters) = self.build_bound_update(request)?;
                let result = self
                    .execute_bound_query(
                        &sql,
                        None,
                        &sql,
                        Some(Self::statement_bindings(&parameters)?),
                    )
                    .await?;
                if result.affected_rows == 0 {
                    return Err(anyhow!(
                        "An edit queue row no longer matches its primary-key selector"
                    ));
                }
                affected_rows += result.affected_rows;
            }
            Ok(affected_rows)
        })
        .await
    }

    async fn delete_table_rows(&self, request: &TableRowDeleteRequest) -> Result<u64> {
        if request.rows.is_empty() {
            return Err(anyhow!("Deleting rows requires at least one selected row"));
        }

        let table_reference =
            self.parse_table_reference(&request.table, request.database.as_deref())?;
        let database_name = table_reference.database.clone();
        let predicates = request
            .rows
            .iter()
            .map(|row_keys| {
                if row_keys.is_empty() {
                    return Err(anyhow!(
                        "Each deleted row must include at least one primary key value"
                    ));
                }

                Ok(format!("({})", Self::build_where_clause(row_keys)?))
            })
            .collect::<Result<Vec<_>>>()?;

        let sql = format!(
            "DELETE FROM {} WHERE {}",
            Self::qualify_table_name(&table_reference)?,
            predicates.join(" OR "),
        );
        let result = self
            .execute_single_query(&sql, Some(&database_name), &sql)
            .await?;
        Ok(result.affected_rows)
    }

    async fn insert_table_row(&self, request: &TableRowInsertRequest) -> Result<u64> {
        if request.values.is_empty() {
            return Err(anyhow!("Insert requires at least one column value"));
        }

        let table_reference =
            self.parse_table_reference(&request.table, request.database.as_deref())?;
        let database_name = table_reference.database.clone();
        let columns = request
            .values
            .iter()
            .map(|(column, _)| quote_snowflake_identifier(column))
            .collect::<Result<Vec<_>>>()?;
        let values = request
            .values
            .iter()
            .map(|(_, value)| Self::quote_sql_literal(value))
            .collect::<Result<Vec<_>>>()?;

        let sql = format!(
            "INSERT INTO {} ({}) VALUES ({})",
            Self::qualify_table_name(&table_reference)?,
            columns.join(", "),
            values.join(", "),
        );
        let result = self
            .execute_single_query(&sql, Some(&database_name), &sql)
            .await?;
        Ok(result.affected_rows)
    }

    /// Insert every staged row inside one transaction: BEGIN, one bound
    /// INSERT per request, COMMIT. The SQL API session persists via the auth
    /// token, so sequential requests share the transaction — a failed BEGIN
    /// (e.g. a sessionless token) rejects the import instead of applying it
    /// non-atomically. Cancellation or any row failure rolls the whole file
    /// back.
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

        self.run_atomic_transaction(|| async {
            let mut affected_rows = 0u64;
            for request in requests {
                if cancelled.load(Ordering::Relaxed) {
                    return Err(anyhow!("CSV import cancelled; all rows were rolled back"));
                }
                let (sql, parameters) = self.build_bound_insert(request)?;
                let result = self
                    .execute_bound_query(
                        &sql,
                        None,
                        &sql,
                        Some(Self::statement_bindings(&parameters)?),
                    )
                    .await?;
                affected_rows += result.affected_rows;
            }
            Ok(affected_rows)
        })
        .await
    }

    /// Streamed CSV import: the transaction opens before the first row and
    /// each parsed row is inserted as it arrives, so a parse error, a cancel,
    /// or an early channel close rolls every inserted row back instead of
    /// leaving a partial import behind.
    async fn insert_table_row_stream_atomically(
        &self,
        mut rows: tokio::sync::mpsc::Receiver<crate::database::models::CsvImportRow>,
        cancelled: Arc<AtomicBool>,
    ) -> Result<u64> {
        if cancelled.load(Ordering::Relaxed) {
            return Err(anyhow!("CSV import cancelled; all rows were rolled back"));
        }

        self.run_atomic_transaction(|| async {
            let mut affected_rows = 0u64;
            let mut received = 0usize;
            while let Some(row) = rows.recv().await {
                if cancelled.load(Ordering::Relaxed) {
                    return Err(anyhow!("CSV import cancelled; all rows were rolled back"));
                }
                let request = row.map_err(anyhow::Error::msg)?;
                received += 1;
                let (sql, parameters) = self.build_bound_insert(&request)?;
                let result = self
                    .execute_bound_query(
                        &sql,
                        None,
                        &sql,
                        Some(Self::statement_bindings(&parameters)?),
                    )
                    .await?;
                affected_rows += result.affected_rows;
            }
            if received == 0 {
                return Err(anyhow!("CSV import requires at least one row"));
            }
            Ok(affected_rows)
        })
        .await
    }

    /// Write preview: BEGIN, run each statement inside the transaction, then
    /// ALWAYS ROLLBACK so nothing persists. A failed rollback is surfaced —
    /// reporting a clean preview whose writes may have committed would be a
    /// lie.
    async fn preview_write_transaction(&self, statements: &[String]) -> Result<Vec<QueryResult>> {
        self.run_transaction_control("BEGIN").await?;
        let mut results = Vec::with_capacity(statements.len());
        let execution = async {
            for statement in statements {
                let mut result = self
                    .execute_single_query(statement, None, statement)
                    .await?;
                result.sandboxed = true;
                results.push(result);
            }
            Ok::<_, anyhow::Error>(())
        }
        .await;

        let rollback = self.run_transaction_control("ROLLBACK").await;
        execution?;
        if let Err(error) = rollback {
            log::error!("Snowflake write-preview rollback failed: {error}");
            return Err(anyhow!(
                "Write preview rollback failed; the previewed statements may have been committed: {error}"
            ));
        }
        Ok(results)
    }

    async fn use_database(&self, database: &str) -> Result<()> {
        let trimmed = database.trim();
        if trimmed.is_empty() {
            return Err(anyhow!("Snowflake database name cannot be empty"));
        }

        let resolved_database = self.find_database_name(trimmed).await?;
        let default_schema = self
            .first_schema_in_database(&resolved_database)
            .await
            .ok()
            .flatten();

        let mut current_db = self.current_db.write().await;
        *current_db = Some(resolved_database);
        drop(current_db);

        let mut current_schema = self.current_schema.write().await;
        *current_schema = default_schema;
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
        let table_reference = self.parse_table_reference(referenced_table, None)?;
        let database_name = table_reference.database.clone();
        let value_expr = quote_snowflake_order_by(referenced_column)?;
        let label_expr = Self::lookup_label_expression(display_columns, referenced_column)?;

        let mut sql = format!(
            "SELECT {} AS value, {} AS label FROM {}",
            value_expr,
            label_expr,
            Self::qualify_table_name(&table_reference)?,
        );

        if let Some(search_term) = search.map(str::trim).filter(|value| !value.is_empty()) {
            sql.push_str(&format!(
                " WHERE TO_VARCHAR({}) ILIKE {}",
                value_expr,
                Self::sql_string_literal(&format!("%{search_term}%")),
            ));
        }

        sql.push_str(&format!(" ORDER BY {} LIMIT {}", value_expr, limit));
        let result = self
            .execute_single_query(&sql, Some(&database_name), &sql)
            .await?;

        Ok(result
            .rows
            .into_iter()
            .map(|row| LookupValue {
                value: row.first().cloned().unwrap_or(JsonValue::Null),
                label: row
                    .get(1)
                    .map(ToString::to_string)
                    .unwrap_or_else(|| row.first().map(ToString::to_string).unwrap_or_default()),
            })
            .collect())
    }

    fn current_database(&self) -> Option<String> {
        self.current_database_name()
    }

    fn driver_name(&self) -> &str {
        "Snowflake"
    }
}

#[cfg(test)]
mod tests {
    use super::super::driver::DatabaseDriver;
    use super::super::models::{QueryParameter, QueryParameterType};
    use super::SnowflakeDriver;
    use serde_json::json;
    use std::sync::atomic::AtomicBool;
    use std::sync::Mutex;

    fn test_driver() -> SnowflakeDriver {
        use super::super::query_cancel::QueryCancelRegistry;
        use std::collections::HashMap;
        use std::sync::{Mutex, RwLock as StdRwLock};
        use tokio::sync::RwLock;

        SnowflakeDriver {
            client: reqwest::Client::new(),
            root_url: "https://acct.snowflakecomputing.com".to_string(),
            statements_url: "https://acct.snowflakecomputing.com/api/v2/statements".to_string(),
            access_token: "token".to_string(),
            current_db: std::sync::Arc::new(RwLock::new(None)),
            current_schema: std::sync::Arc::new(RwLock::new(None)),
            warehouse: None,
            role: None,
            cancel_registry: StdRwLock::new(QueryCancelRegistry::new()),
            pending_handles: Mutex::new(HashMap::new()),
        }
    }

    #[test]
    fn builds_statement_cancel_url() {
        let driver = test_driver();
        assert_eq!(
            driver.statement_cancel_url("01ab-cdef"),
            "https://acct.snowflakecomputing.com/api/v2/statements/01ab-cdef/cancel"
        );
    }

    #[test]
    fn pending_handles_roundtrip_per_request() {
        let driver = test_driver();
        driver.store_pending_handle("req-1", "handle-1");
        driver.store_pending_handle("req-2", "handle-2");

        assert_eq!(
            driver.take_pending_handle("req-1").as_deref(),
            Some("handle-1")
        );
        // Taking a handle removes only that request's entry.
        assert_eq!(driver.take_pending_handle("req-1"), None);
        assert_eq!(
            driver.take_pending_handle("req-2").as_deref(),
            Some("handle-2")
        );
    }

    #[test]
    fn serializes_variant_values_for_sql_literals() {
        assert_eq!(
            SnowflakeDriver::quote_sql_literal(&json!(null)).unwrap(),
            "NULL"
        );
        assert_eq!(
            SnowflakeDriver::quote_sql_literal(&json!(true)).unwrap(),
            "TRUE"
        );
        assert_eq!(
            SnowflakeDriver::quote_sql_literal(&json!("O'Reilly")).unwrap(),
            "'O''Reilly'"
        );
        assert_eq!(
            SnowflakeDriver::quote_sql_literal(&json!({"id": 1})).unwrap(),
            "PARSE_JSON('{\"id\":1}')"
        );
    }

    fn parameter(value: serde_json::Value, data_type: QueryParameterType) -> QueryParameter {
        QueryParameter {
            name: "p".to_string(),
            value,
            data_type,
        }
    }

    #[test]
    fn builds_positional_statement_bindings() {
        let bindings = SnowflakeDriver::statement_bindings(&[
            parameter(json!("O'Reilly"), QueryParameterType::Text),
            parameter(json!(42), QueryParameterType::Integer),
            parameter(json!(2.5), QueryParameterType::Decimal),
            parameter(json!(true), QueryParameterType::Boolean),
            parameter(json!({"id": 1}), QueryParameterType::Json),
            parameter(json!(null), QueryParameterType::Null),
        ])
        .unwrap();

        assert_eq!(
            serde_json::to_value(&bindings).unwrap(),
            json!({
                "1": { "type": "TEXT", "value": "O'Reilly" },
                "2": { "type": "FIXED", "value": "42" },
                "3": { "type": "REAL", "value": "2.5" },
                "4": { "type": "BOOLEAN", "value": "true" },
                "5": { "type": "TEXT", "value": "{\"id\":1}" },
                "6": { "type": "TEXT", "value": null }
            })
        );

        assert!(SnowflakeDriver::statement_bindings(&[parameter(
            json!("nope"),
            QueryParameterType::Integer,
        )])
        .is_err());
    }

    #[test]
    fn builds_bound_update_with_positional_parameters() {
        use super::super::models::{RowKeyValue, TableCellUpdateRequest};

        let driver = test_driver();
        let request = TableCellUpdateRequest {
            table: "TESTDB.PUBLIC.ITEMS".to_string(),
            database: None,
            target_column: "name".to_string(),
            value: json!("O'Reilly"),
            primary_keys: vec![
                RowKeyValue {
                    column: "id".to_string(),
                    value: json!(7),
                },
                RowKeyValue {
                    column: "deleted_at".to_string(),
                    value: json!(null),
                },
            ],
        };

        let (sql, parameters) = driver.build_bound_update(&request).unwrap();
        assert_eq!(
            sql,
            "UPDATE \"TESTDB\".\"PUBLIC\".\"ITEMS\" SET \"name\" = ? WHERE \"id\" = ? AND \"deleted_at\" IS NULL"
        );
        assert_eq!(parameters.len(), 2);
        assert_eq!(parameters[0].value, json!("O'Reilly"));
        assert_eq!(parameters[1].value, json!(7));
    }

    #[test]
    fn builds_bound_insert_with_parse_json_for_variant() {
        use super::super::models::TableRowInsertRequest;

        let driver = test_driver();
        let request = TableRowInsertRequest {
            table: "TESTDB.PUBLIC.ITEMS".to_string(),
            database: None,
            values: vec![
                ("id".to_string(), json!(3)),
                ("payload".to_string(), json!({"a": 1})),
            ],
        };

        let (sql, parameters) = driver.build_bound_insert(&request).unwrap();
        assert_eq!(
            sql,
            "INSERT INTO \"TESTDB\".\"PUBLIC\".\"ITEMS\" (\"id\", \"payload\") VALUES (?, PARSE_JSON(?))"
        );
        assert_eq!(parameters.len(), 2);
        assert_eq!(parameters[1].data_type, QueryParameterType::Json);
    }

    /// Minimal SQL API stub: records every submitted statement and returns a
    /// ready result set (or a canned failure) so transaction sequencing can
    /// be asserted without a live account.
    struct MockSnowflake {
        statements: Mutex<Vec<String>>,
        fail_on: Option<String>,
        /// Statements containing this needle report zero affected rows —
        /// simulates a stale primary-key selector without a server error.
        zero_rows_on: Option<String>,
    }

    async fn mock_statement(
        axum::extract::State(state): axum::extract::State<std::sync::Arc<MockSnowflake>>,
        axum::Json(payload): axum::Json<serde_json::Value>,
    ) -> (axum::http::StatusCode, axum::Json<serde_json::Value>) {
        let statement = payload
            .get("statement")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string();
        state
            .statements
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(statement.clone());

        if state
            .fail_on
            .as_deref()
            .map(|needle| statement.contains(needle))
            .unwrap_or(false)
        {
            return (
                axum::http::StatusCode::UNPROCESSABLE_ENTITY,
                axum::Json(json!({
                    "code": "1003",
                    "sqlState": "42000",
                    "message": format!("mock failure for: {statement}"),
                })),
            );
        }

        let stats = if state
            .zero_rows_on
            .as_deref()
            .map(|needle| statement.contains(needle))
            .unwrap_or(false)
        {
            json!({"numRowsUpdated": 0, "numRowsInserted": 0})
        } else if statement.starts_with("UPDATE") {
            json!({"numRowsUpdated": 1})
        } else if statement.starts_with("INSERT") {
            json!({"numRowsInserted": 1})
        } else {
            json!({})
        };
        (
            axum::http::StatusCode::OK,
            axum::Json(json!({
                "statementHandle": "mock-handle",
                "resultSetMetaData": {"numRows": 0, "rowType": [], "partitionInfo": []},
                "data": [],
                "stats": stats,
            })),
        )
    }

    async fn mock_driver(
        fail_on: Option<&str>,
        zero_rows_on: Option<&str>,
    ) -> (SnowflakeDriver, std::sync::Arc<MockSnowflake>) {
        let state = std::sync::Arc::new(MockSnowflake {
            statements: Mutex::new(Vec::new()),
            fail_on: fail_on.map(str::to_string),
            zero_rows_on: zero_rows_on.map(str::to_string),
        });
        let app = axum::Router::new()
            .route("/api/v2/statements", axum::routing::post(mock_statement))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let mut driver = test_driver();
        driver.root_url = format!("http://{address}");
        driver.statements_url = format!("http://{address}/api/v2/statements");
        (driver, state)
    }

    fn recorded(state: &MockSnowflake) -> Vec<String> {
        state
            .statements
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn update_request(id: i64) -> super::super::models::TableCellUpdateRequest {
        update_request_on_column(id, "name")
    }

    fn update_request_on_column(
        id: i64,
        target_column: &str,
    ) -> super::super::models::TableCellUpdateRequest {
        super::super::models::TableCellUpdateRequest {
            table: "TESTDB.PUBLIC.ITEMS".to_string(),
            database: None,
            target_column: target_column.to_string(),
            value: json!(format!("name-{id}")),
            primary_keys: vec![super::super::models::RowKeyValue {
                column: "id".to_string(),
                value: json!(id),
            }],
        }
    }

    fn insert_request(id: i64) -> super::super::models::TableRowInsertRequest {
        super::super::models::TableRowInsertRequest {
            table: "TESTDB.PUBLIC.ITEMS".to_string(),
            database: None,
            values: vec![("id".to_string(), json!(id))],
        }
    }

    #[tokio::test]
    async fn atomic_edit_queue_runs_begin_updates_commit() {
        let (driver, state) = mock_driver(None, None).await;
        let affected = driver
            .apply_table_updates_atomically(&[update_request(1), update_request(2)])
            .await
            .unwrap();

        assert_eq!(affected, 2);
        let statements = recorded(&state);
        assert_eq!(statements.first().map(String::as_str), Some("BEGIN"));
        assert_eq!(statements.last().map(String::as_str), Some("COMMIT"));
        assert_eq!(statements.len(), 4);
        assert!(statements[1].starts_with("UPDATE "));
        assert!(statements[2].starts_with("UPDATE "));
    }

    #[tokio::test]
    async fn atomic_edit_queue_rolls_back_when_row_is_stale() {
        // The second UPDATE reports zero affected rows (stale primary-key
        // selector) → the whole queue must roll back.
        let (driver, state) = mock_driver(None, Some("\"stale_col\"")).await;
        let error = driver
            .apply_table_updates_atomically(&[
                update_request(1),
                update_request_on_column(2, "stale_col"),
            ])
            .await
            .unwrap_err();

        assert!(error
            .to_string()
            .contains("no longer matches its primary-key selector"));
        let statements = recorded(&state);
        assert_eq!(statements.first().map(String::as_str), Some("BEGIN"));
        assert_eq!(statements.last().map(String::as_str), Some("ROLLBACK"));
        assert!(!statements.iter().any(|sql| sql == "COMMIT"));
    }

    #[tokio::test]
    async fn atomic_edit_queue_surfaces_begin_failure() {
        let (driver, state) = mock_driver(Some("BEGIN"), None).await;
        let error = driver
            .apply_table_updates_atomically(&[update_request(1)])
            .await
            .unwrap_err();

        assert!(error.to_string().contains("mock failure"));
        // Nothing ran after the failed BEGIN — no non-atomic fallback.
        assert_eq!(recorded(&state), vec!["BEGIN".to_string()]);
    }

    #[tokio::test]
    async fn atomic_csv_import_commits_every_row() {
        let (driver, state) = mock_driver(None, None).await;
        let affected = driver
            .insert_table_rows_atomically(
                &[insert_request(1), insert_request(2)],
                std::sync::Arc::new(AtomicBool::new(false)),
            )
            .await
            .unwrap();

        assert_eq!(affected, 2);
        let statements = recorded(&state);
        assert_eq!(statements.first().map(String::as_str), Some("BEGIN"));
        assert_eq!(statements.last().map(String::as_str), Some("COMMIT"));
        assert_eq!(statements.len(), 4);
    }

    #[tokio::test]
    async fn atomic_csv_import_rolls_back_on_row_failure() {
        let (driver, state) = mock_driver(Some("INSERT"), None).await;
        let error = driver
            .insert_table_rows_atomically(
                &[insert_request(1)],
                std::sync::Arc::new(AtomicBool::new(false)),
            )
            .await
            .unwrap_err();

        assert!(error.to_string().contains("mock failure"));
        let statements = recorded(&state);
        assert_eq!(statements.last().map(String::as_str), Some("ROLLBACK"));
    }

    #[tokio::test]
    async fn atomic_csv_import_rejects_pre_cancelled_flag() {
        let (driver, state) = mock_driver(None, None).await;
        let error = driver
            .insert_table_rows_atomically(
                &[insert_request(1)],
                std::sync::Arc::new(AtomicBool::new(true)),
            )
            .await
            .unwrap_err();

        assert!(error.to_string().contains("cancelled"));
        // Cancelled before BEGIN: no statements were sent at all.
        assert!(recorded(&state).is_empty());
    }

    #[tokio::test]
    async fn streamed_csv_import_rolls_back_on_parse_error() {
        let (driver, state) = mock_driver(None, None).await;
        let (sender, receiver) = tokio::sync::mpsc::channel(4);
        sender.send(Ok(insert_request(1))).await.unwrap();
        sender.send(Err("bad csv row".to_string())).await.unwrap();
        drop(sender);

        let error = driver
            .insert_table_row_stream_atomically(
                receiver,
                std::sync::Arc::new(AtomicBool::new(false)),
            )
            .await
            .unwrap_err();

        assert!(error.to_string().contains("bad csv row"));
        let statements = recorded(&state);
        assert_eq!(statements.first().map(String::as_str), Some("BEGIN"));
        assert_eq!(statements.last().map(String::as_str), Some("ROLLBACK"));
        assert!(!statements.iter().any(|sql| sql == "COMMIT"));
    }

    #[tokio::test]
    async fn write_preview_always_rolls_back() {
        let (driver, state) = mock_driver(None, None).await;
        let results = driver
            .preview_write_transaction(&[
                "UPDATE TESTDB.PUBLIC.ITEMS SET name = 'x' WHERE id = 1".to_string(),
                "DELETE FROM TESTDB.PUBLIC.ITEMS WHERE id = 2".to_string(),
            ])
            .await
            .unwrap();

        assert_eq!(results.len(), 2);
        assert!(results.iter().all(|result| result.sandboxed));
        let statements = recorded(&state);
        assert_eq!(statements.first().map(String::as_str), Some("BEGIN"));
        assert_eq!(statements.last().map(String::as_str), Some("ROLLBACK"));
        assert!(!statements.iter().any(|sql| sql == "COMMIT"));
    }

    #[tokio::test]
    async fn write_preview_rolls_back_on_statement_failure() {
        let (driver, state) = mock_driver(Some("DELETE"), None).await;
        let error = driver
            .preview_write_transaction(&[
                "UPDATE TESTDB.PUBLIC.ITEMS SET name = 'x' WHERE id = 1".to_string(),
                "DELETE FROM TESTDB.PUBLIC.ITEMS WHERE id = 2".to_string(),
            ])
            .await
            .unwrap_err();

        assert!(error.to_string().contains("mock failure"));
        let statements = recorded(&state);
        assert_eq!(statements.last().map(String::as_str), Some("ROLLBACK"));
    }
}
