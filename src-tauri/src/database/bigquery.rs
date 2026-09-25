use super::bigquery_support::{BigQueryDatasetListResponse, BigQueryJobReference};
use super::driver::DatabaseDriver;
use super::models::*;
use super::query_cancel::{
    cancel_flag, request_cancel, CancelLookup, CancelScopeGuard, QueryCancelRegistry,
};
use super::query_common::statement_returns_rows;
use super::safety::{
    normalize_order_dir, quote_bigquery_identifier, quote_bigquery_order_by,
    sanitize_bigquery_filter_clause,
};
use crate::utils::sql::split_sql_statements;
use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use reqwest::Client;
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock as StdRwLock};
use std::time::Instant;
use tokio::sync::RwLock;

pub(super) fn bigquery_query_returns_rows(sql: &str) -> bool {
    statement_returns_rows(sql, &["SELECT", "WITH", "SHOW", "EXPLAIN", "DESCRIBE"])
}

pub struct BigQueryDriver {
    pub(super) client: Client,
    pub(super) base_url: String,
    pub(super) access_token: String,
    pub(super) project_id: String,
    pub(super) location: Option<String>,
    pub(super) current_dataset: Arc<RwLock<Option<String>>>,
    /// request_id → running-query scope so `cancel_query_request` can abort
    /// the in-flight job over a second HTTP request.
    cancel_registry: StdRwLock<QueryCancelRegistry>,
    /// request_id → job reference of the BigQuery job currently in flight
    /// for that request.
    pending_jobs: Mutex<HashMap<String, BigQueryJobReference>>,
}

impl BigQueryDriver {
    pub async fn connect(config: &ConnectionConfig) -> Result<Self> {
        let base_url = Self::build_base_url(config)?;
        let access_token = config
            .password
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .context("BigQuery access token is required")?
            .to_string();
        let project_id = config
            .additional_fields
            .get("project_id")
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .context("BigQuery project ID is required")?
            .to_string();
        let location = config
            .additional_fields
            .get("location")
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let initial_dataset = config
            .additional_fields
            .get("dataset")
            .map(String::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| {
                config
                    .database
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
            });

        let driver = Self {
            client: Client::builder()
                .build()
                .context("Failed to initialize BigQuery HTTP client")?,
            base_url,
            access_token,
            project_id,
            location,
            current_dataset: Arc::new(RwLock::new(initial_dataset)),
            cancel_registry: StdRwLock::new(QueryCancelRegistry::new()),
            pending_jobs: Mutex::new(HashMap::new()),
        };

        driver.ping().await?;
        driver.ensure_default_dataset().await?;
        Ok(driver)
    }

    pub(super) fn current_dataset_name(&self) -> Option<String> {
        self.current_dataset
            .try_read()
            .ok()
            .and_then(|guard| guard.clone())
    }

    /// Whether a cancel was already requested for this request scope.
    fn cancel_requested(&self, request_id: &str) -> bool {
        cancel_flag(&self.cancel_registry, request_id)
            .map(|flag| flag.load(Ordering::SeqCst))
            .unwrap_or(false)
    }

    fn store_pending_job(&self, request_id: &str, job: &BigQueryJobReference) {
        let mut jobs = self
            .pending_jobs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        jobs.insert(request_id.to_string(), job.clone());
    }

    fn take_pending_job(&self, request_id: &str) -> Option<BigQueryJobReference> {
        let mut jobs = self
            .pending_jobs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        jobs.remove(request_id)
    }

    /// API path of the job cancel endpoint (`POST
    /// projects/{project}/jobs/{jobId}/cancel`). The job reference returned
    /// by `jobs.query` carries the owning project and location, so the cancel
    /// targets the same job the query is polling.
    fn job_cancel_path(job: &BigQueryJobReference) -> String {
        format!("projects/{}/jobs/{}/cancel", job.project_id, job.job_id)
    }

    /// Abort a running job through `POST
    /// /bigquery/v2/projects/{project}/jobs/{jobId}/cancel`.
    async fn cancel_job(&self, job: &BigQueryJobReference) -> Result<()> {
        let mut request = self
            .client
            .post(self.api_url(&Self::job_cancel_path(job)))
            .bearer_auth(&self.access_token)
            .header("x-goog-user-project", &self.project_id);
        if let Some(location) = job
            .location
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            request = request.query(&[("location", location)]);
        }

        let response = request
            .send()
            .await
            .context("Failed to reach BigQuery job cancel endpoint")?;
        let status = response.status();
        let body = response
            .text()
            .await
            .context("Failed to read BigQuery cancel response")?;

        if status.is_success() {
            return Ok(());
        }

        // A job that already finished cannot be cancelled, but the caller's
        // goal — nothing left running — is still met.
        let lowered = body.to_ascii_lowercase();
        if lowered.contains("not found")
            || lowered.contains("already")
            || lowered.contains("completed")
        {
            return Ok(());
        }

        Err(anyhow!(
            "{}",
            Self::format_api_error(status.as_u16(), &body)
        ))
    }

    /// `execute_parameterized_single_query` scoped to a request: the job
    /// reference is registered as soon as `jobs.query` returns it (before
    /// polling) so `cancel_query_request` can abort the in-flight job.
    async fn execute_parameterized_single_query_scoped(
        &self,
        request_id: &str,
        sql: &str,
        dataset_override: Option<&str>,
        preserve_query_text: &str,
        parameters: &[QueryParameter],
    ) -> Result<QueryResult> {
        if self.cancel_requested(request_id) {
            return Err(anyhow!("Query cancelled."));
        }

        // EXPLAIN resolves to a synchronous dry run: there is no job to
        // register or cancel, so it bypasses the pending-job machinery.
        if let Some(inner) = Self::strip_explain_prefix(sql) {
            return self
                .execute_explain(inner, dataset_override, parameters, preserve_query_text)
                .await;
        }

        let started_at = Instant::now();
        let (response, job_reference) = self
            .submit_query_job(sql, dataset_override, parameters)
            .await?;
        self.store_pending_job(request_id, &job_reference);

        // A cancel that raced ahead of the job registration still reaches the
        // job: abort it now instead of polling to completion.
        if self.cancel_requested(request_id) {
            if let Err(error) = self.cancel_job(&job_reference).await {
                log::warn!(
                    "BigQuery cancel for job {} failed: {error}",
                    job_reference.job_id
                );
            }
            self.take_pending_job(request_id);
            return Err(anyhow!("Query cancelled."));
        }

        let result = self
            .collect_query_result(response, job_reference, preserve_query_text, started_at)
            .await;
        self.take_pending_job(request_id);
        result
    }

    /// `execute_query` scoped to a request: every statement of a
    /// multi-statement script registers its own job so a cancel aborts
    /// whichever job is currently running.
    async fn execute_query_scoped(&self, request_id: &str, sql: &str) -> Result<QueryResult> {
        let started_at = Instant::now();
        let statements = split_sql_statements(sql);

        if statements.len() <= 1 {
            return self
                .execute_parameterized_single_query_scoped(request_id, sql, None, sql, &[])
                .await;
        }

        let mut total_affected = 0u64;
        let mut last_result = None;

        for statement in statements
            .iter()
            .filter(|statement| !statement.trim().is_empty())
        {
            let result = self
                .execute_parameterized_single_query_scoped(request_id, statement, None, sql, &[])
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

    /// Wrap statements in one BigQuery scripting transaction:
    /// `BEGIN TRANSACTION; <s1>; <s2>; COMMIT TRANSACTION;` submitted as a
    /// single `jobs.query` call. BigQuery runs multi-statement scripts
    /// atomically — a failure anywhere rolls the transaction back
    /// server-side. Trailing semicolons are stripped so the join never
    /// emits an empty statement.
    fn transaction_script(statements: &[String]) -> String {
        let mut script = String::from("BEGIN TRANSACTION");
        for statement in statements {
            script.push_str("; ");
            script.push_str(statement.trim().trim_end_matches(';').trim_end());
        }
        script.push_str("; COMMIT TRANSACTION;");
        script
    }

    /// Build the rollback-only preview script:
    /// `BEGIN TRANSACTION; <s1>; SET counts…; <s2>; …; ROLLBACK TRANSACTION;
    /// SELECT …`. A script job only returns its last statement's rows, so
    /// `@@row_count` is captured after every statement and reported by the
    /// trailing SELECT — the only per-statement data a rolled-back script
    /// can surface (SELECT result rows are not recoverable).
    fn preview_transaction_script(statements: &[String]) -> String {
        let mut script =
            String::from("DECLARE preview_row_counts ARRAY<INT64> DEFAULT []; BEGIN TRANSACTION");
        for statement in statements {
            script.push_str("; ");
            script.push_str(statement.trim().trim_end_matches(';').trim_end());
            script.push_str("; SET preview_row_counts = preview_row_counts || [@@row_count]");
        }
        script.push_str(
            "; ROLLBACK TRANSACTION; SELECT statement_index, affected_rows \
             FROM UNNEST(preview_row_counts) AS affected_rows \
             WITH OFFSET AS statement_index ORDER BY statement_index;",
        );
        script
    }

    /// Strip a leading `EXPLAIN`/`EXPLAIN ANALYZE` prefix (comments and
    /// whitespace tolerated) so the inner statement can run as a dry-run
    /// job. Returns the inner SQL or `None` when the statement is not an
    /// EXPLAIN. ANALYZE is accepted but ignored — BigQuery dry runs never
    /// execute.
    pub(super) fn strip_explain_prefix(sql: &str) -> Option<&str> {
        let mut rest = sql.trim_start();
        loop {
            if let Some(after) = rest.strip_prefix("--") {
                rest = after.split_once('\n').map(|(_, tail)| tail).unwrap_or("");
                rest = rest.trim_start();
                continue;
            }
            if let Some(after) = rest.strip_prefix('#') {
                rest = after.split_once('\n').map(|(_, tail)| tail).unwrap_or("");
                rest = rest.trim_start();
                continue;
            }
            if let Some(after) = rest.strip_prefix("/*") {
                rest = match after.find("*/") {
                    Some(end) => &after[end + 2..],
                    None => "",
                };
                rest = rest.trim_start();
                continue;
            }
            break;
        }
        let head = rest.get(..7)?;
        if !head.eq_ignore_ascii_case("EXPLAIN") {
            return None;
        }
        let after = &rest[7..];
        if !after.starts_with(|ch: char| ch.is_whitespace() || ch == '(') {
            return None;
        }
        let mut inner = after.trim_start();
        // Tolerate a Postgres-style option list: EXPLAIN (ANALYZE, COSTS) …
        if let Some(options) = inner.strip_prefix('(') {
            if let Some(close) = options.find(')') {
                inner = options[close + 1..].trim_start();
            }
        }
        if let Some(head) = inner.get(..7) {
            if head.eq_ignore_ascii_case("ANALYZE") {
                let tail = &inner[7..];
                if tail.starts_with(|ch: char| ch.is_whitespace()) {
                    inner = tail.trim_start();
                }
            }
        }
        if inner.is_empty() {
            return None;
        }
        Some(inner)
    }
}

#[async_trait]
impl DatabaseDriver for BigQueryDriver {
    async fn ping(&self) -> Result<()> {
        let _: BigQueryDatasetListResponse = self
            .get_json(
                &format!("projects/{}/datasets", self.project_id),
                &[("maxResults".to_string(), "1".to_string())],
            )
            .await
            .context("BigQuery ping failed")?;
        Ok(())
    }

    async fn disconnect(&self) -> Result<()> {
        Ok(())
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        let mut datasets = self.list_dataset_items().await?;
        datasets.sort_by(|left, right| {
            left.dataset_reference
                .dataset_id
                .cmp(&right.dataset_reference.dataset_id)
        });

        Ok(datasets
            .into_iter()
            .map(|dataset| DatabaseInfo {
                name: dataset.dataset_reference.dataset_id,
                size: dataset
                    .location
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string),
            })
            .collect())
    }

    async fn list_tables(&self, database: Option<&str>) -> Result<Vec<TableInfo>> {
        let dataset = self.resolve_dataset_name(database).await?;
        let mut tables = self.list_table_items(&dataset).await?;
        tables.sort_by(|left, right| {
            left.table_reference
                .table_id
                .cmp(&right.table_reference.table_id)
        });
        Ok(tables.into_iter().map(Self::table_info_from_item).collect())
    }

    async fn list_schema_objects(&self, database: Option<&str>) -> Result<Vec<SchemaObjectInfo>> {
        let dataset = self.resolve_dataset_name(database).await?;
        let tables = self.list_table_items(&dataset).await?;
        let mut objects = Vec::new();

        for table in tables {
            let object_type = table
                .table_type
                .clone()
                .unwrap_or_else(|| "TABLE".to_string())
                .to_ascii_uppercase();
            if object_type == "TABLE" {
                continue;
            }

            let definition = if matches!(object_type.as_str(), "VIEW" | "MATERIALIZED_VIEW") {
                let resource = self
                    .get_table_resource(
                        &table.table_reference.project_id,
                        &table.table_reference.dataset_id,
                        &table.table_reference.table_id,
                    )
                    .await?;
                Self::table_definition(&resource)
            } else {
                None
            };

            objects.push(SchemaObjectInfo {
                create_date: None,
                name: table.table_reference.table_id,
                schema: Some(table.table_reference.dataset_id),
                object_type,
                related_table: None,
                definition,
            });
        }

        objects.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(objects)
    }

    async fn get_table_structure(
        &self,
        table: &str,
        database: Option<&str>,
    ) -> Result<TableStructure> {
        let table_reference = self.parse_table_reference(table, database)?;
        let resource = self
            .get_table_resource(
                &table_reference.project_id,
                &table_reference.dataset_id,
                &table_reference.table_id,
            )
            .await?;

        let mut columns = Vec::new();
        if let Some(schema) = resource.schema.as_ref() {
            Self::flatten_schema_fields(&schema.fields, None, &mut columns);
        }

        Ok(TableStructure {
            columns,
            indexes: Vec::new(),
            foreign_keys: Vec::new(),
            triggers: Vec::new(),
            view_definition: Self::table_definition(&resource),
            object_type: resource
                .table_type
                .as_deref()
                .map(|value| value.to_ascii_uppercase()),
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
        self.execute_parameterized_single_query(sql, None, sql, parameters)
            .await
    }

    /// Request-scoped execution: the job reference returned by `jobs.query`
    /// is registered before polling so `cancel_query_request` can abort the
    /// in-flight job over a second HTTP request.
    async fn execute_query_for_request(&self, request_id: &str, sql: &str) -> Result<QueryResult> {
        if request_id.trim().is_empty() {
            return self.execute_query(sql).await;
        }
        let guard = CancelScopeGuard::begin(&self.cancel_registry, request_id);
        // The backend id is a job reference tracked in `pending_jobs`, so
        // registering a marker only resolves the pending race.
        if guard.register_backend(0) {
            return Err(anyhow!("Query cancelled."));
        }
        let result = self.execute_query_scoped(request_id, sql).await;
        drop(guard);
        result
    }

    /// Cancels by POSTing to `projects/{p}/jobs/{jobId}/cancel` — the job
    /// reference stored by `execute_query_for_request` carries the owning
    /// project and location. The in-flight request is blocked polling, so the
    /// cancel rides a second HTTP request.
    async fn cancel_query_request(&self, request_id: &str) -> Result<bool> {
        match request_cancel(&self.cancel_registry, request_id) {
            CancelLookup::NotRunning => Ok(false),
            // Cancel was recorded before the job reference landed; the scoped
            // execute path aborts as soon as it arrives.
            CancelLookup::Pending => Ok(true),
            CancelLookup::Backend(_) => {
                match self.take_pending_job(request_id) {
                    Some(job) => {
                        self.cancel_job(&job).await?;
                        Ok(true)
                    }
                    // The job finished between submission and the cancel;
                    // nothing is left running.
                    None => Ok(true),
                }
            }
        }
    }

    /// Request-scoped parameterized execution: same job registration as
    /// `execute_query_for_request`, with values travelling through
    /// `queryParameters` binds.
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
            .execute_parameterized_single_query_scoped(request_id, sql, None, sql, parameters)
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
        let dataset = self.resolve_dataset_name(database).await?;
        let table_reference = self.parse_table_reference(table, Some(&dataset))?;
        let mut sql = format!(
            "SELECT * FROM {}",
            Self::qualify_table_name(&table_reference)?
        );

        if let Some(filter_clause) = sanitize_bigquery_filter_clause(filter)? {
            sql.push_str(&format!(" WHERE {filter_clause}"));
        }

        if let Some(order_column) = order_by {
            let direction = normalize_order_dir(order_dir)?;
            sql.push_str(&format!(
                " ORDER BY {} {}",
                quote_bigquery_order_by(order_column)?,
                direction
            ));
        }

        sql.push_str(&format!(" LIMIT {limit} OFFSET {offset}"));
        self.execute_single_query(&sql, Some(&table_reference.dataset_id), &sql)
            .await
    }

    async fn count_rows(&self, table: &str, database: Option<&str>) -> Result<i64> {
        let dataset = self.resolve_dataset_name(database).await?;
        let table_reference = self.parse_table_reference(table, Some(&dataset))?;
        let sql = format!(
            "SELECT COUNT(*) AS count FROM {}",
            Self::qualify_table_name(&table_reference)?
        );
        let result = self
            .execute_single_query(&sql, Some(&table_reference.dataset_id), &sql)
            .await?;
        Self::scalar_i64(&result)
    }

    async fn count_null_values(
        &self,
        table: &str,
        database: Option<&str>,
        column: &str,
    ) -> Result<i64> {
        let dataset = self.resolve_dataset_name(database).await?;
        let table_reference = self.parse_table_reference(table, Some(&dataset))?;
        let sql = format!(
            "SELECT COUNT(*) AS count FROM {} WHERE {} IS NULL",
            Self::qualify_table_name(&table_reference)?,
            quote_bigquery_order_by(column)?,
        );
        let result = self
            .execute_single_query(&sql, Some(&table_reference.dataset_id), &sql)
            .await?;
        Self::scalar_i64(&result)
    }

    async fn update_table_cell(&self, request: &TableCellUpdateRequest) -> Result<u64> {
        let dataset = self
            .resolve_dataset_name(request.database.as_deref())
            .await?;
        let table_reference = self.parse_table_reference(&request.table, Some(&dataset))?;
        let where_clause = Self::build_where_clause(&request.primary_keys)?;
        let sql = format!(
            "UPDATE {} SET {} = {} WHERE {}",
            Self::qualify_table_name(&table_reference)?,
            quote_bigquery_order_by(&request.target_column)?,
            Self::quote_sql_literal(&request.value)?,
            where_clause
        );

        let result = self
            .execute_single_query(&sql, Some(&table_reference.dataset_id), &sql)
            .await?;
        Ok(result.affected_rows)
    }

    /// Apply the inline edit queue inside one BigQuery scripting
    /// transaction: `BEGIN TRANSACTION; UPDATE…; COMMIT TRANSACTION;` sent
    /// as a single `jobs.query` call. BigQuery runs multi-statement
    /// scripts atomically, so a failure anywhere rolls the whole queue
    /// back server-side. Values travel as positional `queryParameters`
    /// binds — never interpolated into the script text.
    async fn apply_table_updates_atomically(
        &self,
        updates: &[TableCellUpdateRequest],
    ) -> Result<u64> {
        if updates.is_empty() {
            return Err(anyhow!("Applying edits requires at least one update"));
        }

        let dataset = self
            .resolve_dataset_name(updates[0].database.as_deref())
            .await?;

        let mut statements = Vec::with_capacity(updates.len());
        let mut parameters = Vec::new();
        for (index, request) in updates.iter().enumerate() {
            if request.primary_keys.is_empty() {
                return Err(anyhow!(
                    "Inline update requires at least one primary key column"
                ));
            }
            let table_reference = self.parse_table_reference(&request.table, Some(&dataset))?;

            let mut statement = format!(
                "UPDATE {} SET {} = ? WHERE ",
                Self::qualify_table_name(&table_reference)?,
                quote_bigquery_order_by(&request.target_column)?,
            );
            parameters.push(QueryParameter {
                name: format!("value_{index}"),
                value: request.value.clone(),
                data_type: Self::json_value_parameter_type(&request.value),
            });

            for (key_index, primary_key) in request.primary_keys.iter().enumerate() {
                if key_index > 0 {
                    statement.push_str(" AND ");
                }
                statement.push_str(&quote_bigquery_order_by(&primary_key.column)?);
                if primary_key.value.is_null() {
                    statement.push_str(" IS NULL");
                } else {
                    statement.push_str(" = ?");
                    parameters.push(QueryParameter {
                        name: format!("key_{index}_{key_index}"),
                        value: primary_key.value.clone(),
                        data_type: Self::json_value_parameter_type(&primary_key.value),
                    });
                }
            }

            // Same contract as the other engines' edit queues: a stale
            // primary-key selector (0 rows matched) must fail the batch,
            // not silently commit the remaining updates. `@@row_count`
            // reads the UPDATE that immediately precedes it; RAISE aborts
            // the script and rolls the transaction back.
            statement.push_str(
                "; IF @@row_count = 0 THEN RAISE USING MESSAGE = \
                 'An edit queue row no longer matches its primary-key selector'; END IF",
            );
            statements.push(statement);
        }

        let sql = Self::transaction_script(&statements);
        self.execute_parameterized_single_query(&sql, Some(&dataset), &sql, &parameters)
            .await?;
        // Script jobs do not report per-statement DML counts; the queue
        // either committed fully or the job failed, so the applied count
        // is the queue length.
        Ok(updates.len() as u64)
    }

    async fn delete_table_rows(&self, request: &TableRowDeleteRequest) -> Result<u64> {
        if request.rows.is_empty() {
            return Err(anyhow!("Deleting rows requires at least one selected row"));
        }

        let dataset = self
            .resolve_dataset_name(request.database.as_deref())
            .await?;
        let table_reference = self.parse_table_reference(&request.table, Some(&dataset))?;
        let mut predicates = Vec::new();

        for row in &request.rows {
            predicates.push(format!("({})", Self::build_where_clause(row)?));
        }

        let sql = format!(
            "DELETE FROM {} WHERE {}",
            Self::qualify_table_name(&table_reference)?,
            predicates.join(" OR ")
        );

        let result = self
            .execute_single_query(&sql, Some(&table_reference.dataset_id), &sql)
            .await?;
        Ok(result.affected_rows)
    }

    async fn insert_table_row(&self, request: &TableRowInsertRequest) -> Result<u64> {
        if request.values.is_empty() {
            return Err(anyhow!("Insert requires at least one column value"));
        }

        let dataset = self
            .resolve_dataset_name(request.database.as_deref())
            .await?;
        let table_reference = self.parse_table_reference(&request.table, Some(&dataset))?;
        let columns = request
            .values
            .iter()
            .map(|(column, _)| quote_bigquery_identifier(column))
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
            values.join(", ")
        );

        let result = self
            .execute_single_query(&sql, Some(&table_reference.dataset_id), &sql)
            .await?;
        Ok(result.affected_rows)
    }
    async fn insert_table_rows_atomically(
        &self,
        requests: &[TableRowInsertRequest],
        cancelled: Arc<AtomicBool>,
    ) -> Result<u64> {
        if requests.is_empty() {
            return Err(anyhow!("CSV import requires at least one row"));
        }

        let dataset = self
            .resolve_dataset_name(requests[0].database.as_deref())
            .await?;

        if cancelled.load(Ordering::Relaxed) {
            return Err(anyhow!("CSV import cancelled; all rows were rolled back"));
        }

        // One scripted query keeps every INSERT inside a single server-side
        // transaction: BEGIN TRANSACTION; INSERT…; COMMIT TRANSACTION.
        let mut statements = Vec::with_capacity(requests.len());
        let mut parameters = Vec::new();
        for request in requests {
            if cancelled.load(Ordering::Relaxed) {
                return Err(anyhow!("CSV import cancelled; all rows were rolled back"));
            }
            if request.values.is_empty() {
                return Err(anyhow!("Each CSV row requires at least one column value"));
            }
            let table_reference = self.parse_table_reference(&request.table, Some(&dataset))?;
            let columns = request
                .values
                .iter()
                .map(|(column, _)| quote_bigquery_identifier(column))
                .collect::<Result<Vec<_>>>()?;

            statements.push(format!(
                "INSERT INTO {} ({}) VALUES ({})",
                Self::qualify_table_name(&table_reference)?,
                columns.join(", "),
                vec!["?"; request.values.len()].join(", ")
            ));

            parameters.extend(request.values.iter().map(|(column, value)| QueryParameter {
                name: column.clone(),
                value: value.clone(),
                data_type: Self::json_value_parameter_type(value),
            }));
        }

        let sql = Self::transaction_script(&statements);
        self.execute_parameterized_single_query(&sql, Some(&dataset), &sql, &parameters)
            .await?;
        Ok(requests.len() as u64)
    }

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

    /// Preview mutating statements inside a rolled-back BigQuery scripting
    /// transaction: `BEGIN TRANSACTION; <stmts>; ROLLBACK TRANSACTION;` in
    /// one `jobs.query` call. A script job only returns its last
    /// statement's rows, so per-statement SELECT output is NOT available —
    /// the script captures `@@row_count` after each statement and a
    /// trailing SELECT reports one `affected_rows` per statement (for a
    /// SELECT that is its returned-row count). Any failure aborts the
    /// script and rolls the transaction back, so nothing persists.
    async fn preview_write_transaction(&self, statements: &[String]) -> Result<Vec<QueryResult>> {
        let started_at = Instant::now();
        let mut cleaned = Vec::with_capacity(statements.len());
        for statement in statements {
            let trimmed = statement.trim().trim_end_matches(';').trim_end();
            if trimmed.is_empty() {
                return Err(anyhow!("Write preview statements cannot be empty"));
            }
            cleaned.push(trimmed.to_string());
        }

        let sql = Self::preview_transaction_script(&cleaned);
        let result = self.execute_single_query(&sql, None, &sql).await?;

        // The trailing SELECT yields one (statement_index, affected_rows)
        // row per previewed statement; align results by index so callers
        // see one QueryResult per input statement.
        let mut counts: Vec<Option<u64>> = vec![None; cleaned.len()];
        for row in &result.rows {
            let index = row
                .first()
                .and_then(|value| value.as_u64().or_else(|| value.as_i64().map(|v| v as u64)));
            let affected = row
                .get(1)
                .and_then(|value| value.as_u64().or_else(|| value.as_i64().map(|v| v as u64)));
            if let (Some(index), Some(affected)) = (index, affected) {
                if let Some(slot) = counts.get_mut(index as usize) {
                    *slot = Some(affected);
                }
            }
        }

        Ok(cleaned
            .into_iter()
            .enumerate()
            .map(|(index, statement)| QueryResult {
                columns: Vec::new(),
                rows: Vec::new(),
                affected_rows: counts[index].unwrap_or(0),
                execution_time_ms: started_at.elapsed().as_millis(),
                query: statement,
                sandboxed: true,
                truncated: false,
            })
            .collect())
    }

    async fn use_database(&self, database: &str) -> Result<()> {
        let dataset = database.trim();
        if dataset.is_empty() {
            return Err(anyhow!("BigQuery dataset name cannot be empty"));
        }

        let _dataset_info = self
            .get_dataset(dataset)
            .await
            .with_context(|| format!("Failed to switch to BigQuery dataset {dataset}"))?;

        let mut current_dataset = self.current_dataset.write().await;
        *current_dataset = Some(dataset.to_string());
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
        let value_expr = quote_bigquery_order_by(referenced_column)?;
        let label_expr = Self::label_expression(display_columns, referenced_column)?;

        let mut sql = format!(
            "SELECT {} AS value, {} AS label FROM {}",
            value_expr,
            label_expr,
            Self::qualify_table_name(&table_reference)?
        );

        if let Some(search_term) = search.map(str::trim).filter(|value| !value.is_empty()) {
            sql.push_str(&format!(
                " WHERE CAST({} AS STRING) LIKE {}",
                value_expr,
                Self::quote_sql_literal(&JsonValue::String(format!("%{search_term}%")))?,
            ));
        }

        sql.push_str(&format!(" ORDER BY {} LIMIT {}", value_expr, limit.max(1)));

        let result = self
            .execute_single_query(&sql, Some(&table_reference.dataset_id), &sql)
            .await?;

        Ok(result
            .rows
            .into_iter()
            .map(|row| {
                let value = row.first().cloned().unwrap_or(JsonValue::Null);
                let label = row.get(1).cloned().unwrap_or_else(|| value.clone());
                LookupValue {
                    value,
                    label: match label {
                        JsonValue::String(text) => text,
                        other => serde_json::to_string(&other).unwrap_or_default(),
                    },
                }
            })
            .collect())
    }

    fn current_database(&self) -> Option<String> {
        self.current_dataset_name()
    }

    fn driver_name(&self) -> &str {
        "BigQuery"
    }
}

#[cfg(test)]
mod tests {
    use super::super::bigquery_support::{
        BigQueryJobReference, BigQueryQueryResponse, BigQueryTableCell, BigQueryTableFieldSchema,
        BigQueryTableRow,
    };
    use super::super::models::{QueryParameter, QueryParameterType};
    use super::BigQueryDriver;
    use serde_json::json;

    fn parameter(value: serde_json::Value, data_type: QueryParameterType) -> QueryParameter {
        QueryParameter {
            name: "p".to_string(),
            value,
            data_type,
        }
    }

    #[test]
    fn parses_bigquery_repeated_record_rows() {
        let fields = vec![BigQueryTableFieldSchema {
            name: Some("items".to_string()),
            field_type: Some("RECORD".to_string()),
            mode: Some("REPEATED".to_string()),
            fields: vec![BigQueryTableFieldSchema {
                name: Some("id".to_string()),
                field_type: Some("INT64".to_string()),
                mode: Some("NULLABLE".to_string()),
                fields: Vec::new(),
                description: None,
                default_value_expression: None,
            }],
            description: None,
            default_value_expression: None,
        }];
        let row = BigQueryTableRow {
            f: vec![BigQueryTableCell {
                v: json!([
                    { "v": { "f": [{ "v": "1" }] } },
                    { "v": { "f": [{ "v": "2" }] } }
                ]),
            }],
        };

        let parsed = BigQueryDriver::table_row_to_values(row, &fields);
        assert_eq!(parsed, vec![json!([{ "id": 1 }, { "id": 2 }])]);
    }

    #[test]
    fn quotes_scalar_sql_literals() {
        assert_eq!(
            BigQueryDriver::quote_sql_literal(&json!("O'Reilly")).unwrap(),
            "'O''Reilly'"
        );
        assert_eq!(
            BigQueryDriver::quote_sql_literal(&json!(true)).unwrap(),
            "TRUE"
        );
        assert_eq!(
            BigQueryDriver::quote_sql_literal(&json!(null)).unwrap(),
            "NULL"
        );
    }

    #[test]
    fn builds_positional_query_parameters() {
        let binding = BigQueryDriver::query_parameter_binding(&parameter(
            json!("O'Reilly"),
            QueryParameterType::Text,
        ))
        .unwrap();
        assert_eq!(
            serde_json::to_value(&binding).unwrap(),
            json!({
                "parameterType": { "type": "STRING" },
                "parameterValue": { "value": "O'Reilly" }
            })
        );

        let binding = BigQueryDriver::query_parameter_binding(&parameter(
            json!(42),
            QueryParameterType::Integer,
        ))
        .unwrap();
        assert_eq!(
            serde_json::to_value(&binding).unwrap(),
            json!({
                "parameterType": { "type": "INT64" },
                "parameterValue": { "value": "42" }
            })
        );

        let binding = BigQueryDriver::query_parameter_binding(&parameter(
            json!(2.5),
            QueryParameterType::Decimal,
        ))
        .unwrap();
        assert_eq!(
            serde_json::to_value(&binding).unwrap(),
            json!({
                "parameterType": { "type": "NUMERIC" },
                "parameterValue": { "value": "2.5" }
            })
        );

        let binding = BigQueryDriver::query_parameter_binding(&parameter(
            json!(true),
            QueryParameterType::Boolean,
        ))
        .unwrap();
        assert_eq!(
            serde_json::to_value(&binding).unwrap(),
            json!({
                "parameterType": { "type": "BOOL" },
                "parameterValue": { "value": "true" }
            })
        );

        let binding = BigQueryDriver::query_parameter_binding(&parameter(
            json!({"id": 1}),
            QueryParameterType::Json,
        ))
        .unwrap();
        assert_eq!(
            serde_json::to_value(&binding).unwrap(),
            json!({
                "parameterType": { "type": "STRING" },
                "parameterValue": { "value": "{\"id\":1}" }
            })
        );

        // BigQuery encodes a NULL parameter by omitting `value`.
        let binding = BigQueryDriver::query_parameter_binding(&parameter(
            json!(null),
            QueryParameterType::Null,
        ))
        .unwrap();
        assert_eq!(
            serde_json::to_value(&binding).unwrap(),
            json!({
                "parameterType": { "type": "STRING" },
                "parameterValue": {}
            })
        );

        assert!(BigQueryDriver::query_parameter_binding(&parameter(
            json!("nope"),
            QueryParameterType::Integer,
        ))
        .is_err());
    }

    fn test_driver() -> BigQueryDriver {
        use super::super::query_cancel::QueryCancelRegistry;
        use std::collections::HashMap;
        use std::sync::{Mutex, RwLock as StdRwLock};
        use tokio::sync::RwLock;

        BigQueryDriver {
            client: reqwest::Client::new(),
            base_url: "https://bigquery.googleapis.com/bigquery/v2".to_string(),
            access_token: "token".to_string(),
            project_id: "proj".to_string(),
            location: None,
            current_dataset: std::sync::Arc::new(RwLock::new(None)),
            cancel_registry: StdRwLock::new(QueryCancelRegistry::new()),
            pending_jobs: Mutex::new(HashMap::new()),
        }
    }

    #[test]
    fn builds_job_cancel_path() {
        let job = BigQueryJobReference {
            project_id: "proj".to_string(),
            job_id: "job_123".to_string(),
            location: Some("US".to_string()),
        };
        assert_eq!(
            BigQueryDriver::job_cancel_path(&job),
            "projects/proj/jobs/job_123/cancel"
        );
    }

    #[test]
    fn pending_jobs_roundtrip_per_request() {
        let driver = test_driver();
        let job = BigQueryJobReference {
            project_id: "proj".to_string(),
            job_id: "job_123".to_string(),
            location: Some("EU".to_string()),
        };
        driver.store_pending_job("req-1", &job);

        let taken = driver.take_pending_job("req-1").expect("job registered");
        assert_eq!(taken.job_id, "job_123");
        assert_eq!(taken.location.as_deref(), Some("EU"));
        // Taking a job removes only that request's entry.
        assert!(driver.take_pending_job("req-1").is_none());
    }

    #[test]
    fn wraps_statements_in_one_transaction_script() {
        let script = BigQueryDriver::transaction_script(&[
            "UPDATE t SET a = ? WHERE id = ?".to_string(),
            "INSERT INTO t (a) VALUES (?) ;".to_string(),
        ]);
        assert_eq!(
            script,
            "BEGIN TRANSACTION; UPDATE t SET a = ? WHERE id = ?; \
             INSERT INTO t (a) VALUES (?); COMMIT TRANSACTION;"
        );
    }

    #[test]
    fn preview_script_rolls_back_and_reports_row_counts() {
        let script = BigQueryDriver::preview_transaction_script(&[
            "UPDATE t SET a = 1".to_string(),
            "DELETE FROM t WHERE id = 2;".to_string(),
        ]);
        assert!(script.starts_with(
            "DECLARE preview_row_counts ARRAY<INT64> DEFAULT []; BEGIN TRANSACTION; UPDATE t SET a = 1"
        ));
        assert!(script.contains(
            "; SET preview_row_counts = preview_row_counts || [@@row_count]; DELETE FROM t WHERE id = 2"
        ));
        assert!(script.ends_with(
            "ROLLBACK TRANSACTION; SELECT statement_index, affected_rows \
             FROM UNNEST(preview_row_counts) AS affected_rows \
             WITH OFFSET AS statement_index ORDER BY statement_index;"
        ));
        // Two statements → two @@row_count captures, and COMMIT never appears.
        assert_eq!(script.matches("@@row_count").count(), 2);
        assert!(!script.contains("COMMIT"));
    }

    #[test]
    fn strips_explain_prefixes() {
        assert_eq!(
            BigQueryDriver::strip_explain_prefix("EXPLAIN SELECT 1"),
            Some("SELECT 1")
        );
        assert_eq!(
            BigQueryDriver::strip_explain_prefix("explain analyze select 1"),
            Some("select 1")
        );
        assert_eq!(
            BigQueryDriver::strip_explain_prefix("-- note\nEXPLAIN (ANALYZE) SELECT 1"),
            Some("SELECT 1")
        );
        assert_eq!(
            BigQueryDriver::strip_explain_prefix("/* c */ EXPLAIN UPDATE t SET a = 1"),
            Some("UPDATE t SET a = 1")
        );
        assert_eq!(BigQueryDriver::strip_explain_prefix("SELECT 1"), None);
        assert_eq!(BigQueryDriver::strip_explain_prefix("EXPLAIN"), None);
        assert_eq!(BigQueryDriver::strip_explain_prefix("EXPLAINABLE x"), None);
    }

    #[test]
    fn explain_result_surfaces_dry_run_estimates() {
        let response = BigQueryQueryResponse {
            total_bytes_processed: Some("1048576".to_string()),
            total_slot_ms: Some("12".to_string()),
            cache_hit: Some(false),
            ..Default::default()
        };
        let result = BigQueryDriver::explain_result_from_dry_run(response, 5, "EXPLAIN SELECT 1");
        assert_eq!(result.query, "EXPLAIN SELECT 1");
        assert_eq!(result.columns.len(), 2);
        assert_eq!(
            result.rows[0],
            vec![json!("total_bytes_processed"), json!(1048576)]
        );
        assert_eq!(result.rows[1], vec![json!("total_slot_ms"), json!(12)]);
        assert_eq!(result.rows[2], vec![json!("cache_hit"), json!(false)]);
        assert_eq!(result.rows.len(), 4); // metrics + note row
    }
}
