use super::{MssqlClient, MssqlDriver};
use crate::database::models::{
    QueryParameter, QueryParameterType, TableCellUpdateRequest, TableRowInsertRequest,
};
use crate::database::query_common::{statement_returns_rows, MAX_QUERY_RESULT_ROWS};
use crate::database::safety::{
    qualify_mssql_table_name, quote_mssql_identifier, quote_mssql_order_by,
};
use anyhow::{anyhow, Result};
use tiberius::{Query as TiberiusQuery, Row};
use tokio::sync::MutexGuard;

impl MssqlDriver {
    pub(super) fn split_schema_table(table: &str) -> (String, String) {
        if let Some((schema, name)) = table.split_once('.') {
            (schema.to_string(), name.to_string())
        } else {
            ("dbo".to_string(), table.to_string())
        }
    }

    pub(super) fn qualify_table_name(table: &str, database: Option<&str>) -> Result<String> {
        let (schema, name) = Self::split_schema_table(table);
        if let Some(database) = database.map(str::trim).filter(|value| !value.is_empty()) {
            return Ok(format!(
                "{}.{}.{}",
                quote_mssql_identifier(database)?,
                quote_mssql_identifier(&schema)?,
                quote_mssql_identifier(&name)?,
            ));
        }

        qualify_mssql_table_name(table, "dbo")
    }

    pub(super) fn query_returns_rows(sql: &str) -> bool {
        statement_returns_rows(sql, &["SELECT", "WITH", "EXEC", "EXECUTE", "SHOW"])
    }

    pub(super) fn current_database_name(&self, explicit: Option<&str>) -> String {
        explicit
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .or_else(|| self.current_db.read().unwrap().clone())
            .unwrap_or_else(|| "master".to_string())
    }
    /// Client-access guard. A restore/write-preview whose automatic ROLLBACK
    /// failed leaves the shared connection inside an open transaction:
    /// further statements would silently run inside it (holding locks, and a
    /// stray COMMIT could half-commit the restore). The only safe action
    /// afterwards is reconnecting.
    pub(super) async fn acquire_client(&self) -> Result<MutexGuard<'_, MssqlClient>> {
        if let Some(reason) = self.poisoned.read().unwrap().clone() {
            return Err(anyhow!(
                "Connection poisoned by a failed restore rollback ({reason}) — reconnect before issuing further statements."
            ));
        }
        Ok(self.client.lock().await)
    }

    pub(super) fn poison_connection(&self, reason: &str) {
        if let Ok(mut poisoned) = self.poisoned.write() {
            *poisoned = Some(reason.to_string());
        }
    }

    pub(super) async fn query_rows(&self, sql: &str) -> Result<(Vec<Row>, bool)> {
        self.query_rows_with_limit(sql, MAX_QUERY_RESULT_ROWS).await
    }

    /// Like [`Self::query_rows`] but with a caller-chosen row cap. Metadata
    /// enumeration (schema objects) legitimately exceeds the interactive
    /// query cap on system databases (master alone has thousands of system
    /// objects), so it uses a much larger limit.
    pub(super) async fn query_rows_with_limit(
        &self,
        sql: &str,
        limit: usize,
    ) -> Result<(Vec<Row>, bool)> {
        let mut client = self.acquire_client().await?;
        let rows = client.simple_query(sql).await?.into_first_result().await?;
        let truncated = rows.len() > limit;
        Ok((rows.into_iter().take(limit).collect::<Vec<_>>(), truncated))
    }

    pub(super) async fn execute_statement(&self, sql: &str) -> Result<u64> {
        self.execute_bound(sql, &[]).await
    }

    pub(super) fn bind_json_value(query: &mut TiberiusQuery<'_>, value: &serde_json::Value) {
        match value {
            serde_json::Value::Null => {
                query.bind(Option::<String>::None);
            }
            serde_json::Value::Bool(value) => {
                query.bind(*value);
            }
            serde_json::Value::Number(value) => {
                if let Some(integer) = value.as_i64() {
                    query.bind(integer);
                } else if let Some(float) = value.as_f64() {
                    query.bind(float);
                } else {
                    query.bind(value.to_string());
                }
            }
            serde_json::Value::String(value) => {
                query.bind(value.clone());
            }
            other => {
                query.bind(other.to_string());
            }
        }
    }

    pub(super) async fn execute_bound(
        &self,
        sql: &str,
        values: &[serde_json::Value],
    ) -> Result<u64> {
        let mut client = self.acquire_client().await?;
        let mut query = TiberiusQuery::new(sql);
        for value in values {
            Self::bind_json_value(&mut query, value);
        }
        Ok(query.execute(&mut *client).await?.total())
    }

    pub(super) async fn query_parameterized_rows(
        &self,
        sql: &str,
        parameters: &[QueryParameter],
    ) -> Result<(Vec<Row>, bool)> {
        let mut client = self.acquire_client().await?;
        let mut query = TiberiusQuery::new(sql);
        for parameter in parameters {
            match parameter.data_type {
                QueryParameterType::Text => query.bind(
                    parameter
                        .value
                        .as_str()
                        .ok_or_else(|| anyhow!("Parameter '{}' must be text.", parameter.name))?
                        .to_string(),
                ),
                QueryParameterType::Integer => {
                    query.bind(parameter.value.as_i64().ok_or_else(|| {
                        anyhow!("Parameter '{}' must be an integer.", parameter.name)
                    })?)
                }
                QueryParameterType::Decimal => {
                    query.bind(parameter.value.as_f64().ok_or_else(|| {
                        anyhow!("Parameter '{}' must be a number.", parameter.name)
                    })?)
                }
                QueryParameterType::Boolean => {
                    query.bind(parameter.value.as_bool().ok_or_else(|| {
                        anyhow!("Parameter '{}' must be boolean.", parameter.name)
                    })?)
                }
                QueryParameterType::Json => query.bind(parameter.value.to_string()),
                QueryParameterType::Null => query.bind(Option::<String>::None),
            }
        }
        let rows = query.query(&mut *client).await?.into_first_result().await?;
        let truncated = rows.len() > MAX_QUERY_RESULT_ROWS;
        Ok((
            rows.into_iter().take(MAX_QUERY_RESULT_ROWS).collect(),
            truncated,
        ))
    }

    pub(super) async fn execute_parameterized_statement(
        &self,
        sql: &str,
        parameters: &[QueryParameter],
    ) -> Result<u64> {
        let mut client = self.acquire_client().await?;
        let mut query = TiberiusQuery::new(sql);
        for parameter in parameters {
            match parameter.data_type {
                QueryParameterType::Text => query.bind(
                    parameter
                        .value
                        .as_str()
                        .ok_or_else(|| anyhow!("Parameter '{}' must be text.", parameter.name))?
                        .to_string(),
                ),
                QueryParameterType::Integer => {
                    query.bind(parameter.value.as_i64().ok_or_else(|| {
                        anyhow!("Parameter '{}' must be an integer.", parameter.name)
                    })?)
                }
                QueryParameterType::Decimal => {
                    query.bind(parameter.value.as_f64().ok_or_else(|| {
                        anyhow!("Parameter '{}' must be a number.", parameter.name)
                    })?)
                }
                QueryParameterType::Boolean => {
                    query.bind(parameter.value.as_bool().ok_or_else(|| {
                        anyhow!("Parameter '{}' must be boolean.", parameter.name)
                    })?)
                }
                QueryParameterType::Json => query.bind(parameter.value.to_string()),
                QueryParameterType::Null => query.bind(Option::<String>::None),
            }
        }
        Ok(query.execute(&mut *client).await?.total())
    }

    /// Like [`Self::execute_bound`] but runs on an already-acquired client,
    /// so callers inside an explicit transaction can bind `@Pn` parameters
    /// without re-locking the shared connection.
    pub(super) async fn execute_bound_on(
        client: &mut MssqlClient,
        sql: &str,
        values: &[serde_json::Value],
    ) -> Result<u64> {
        let mut query = TiberiusQuery::new(sql);
        for value in values {
            Self::bind_json_value(&mut query, value);
        }
        Ok(query.execute(&mut *client).await?.total())
    }

    /// Settles an explicit transaction opened with `BEGIN TRANSACTION` on
    /// `client`: commits when `outcome` is `Ok`, rolls back otherwise.
    /// `COMMIT`/`ROLLBACK` go through `simple_query` (a plain TDS batch):
    /// sent via `sp_executesql` they run in a nested scope and SQL Server
    /// raises error 266 (transaction-count mismatch) when that scope exits.
    /// If a rollback itself fails the connection is poisoned so no later
    /// statement silently runs inside the still-open transaction.
    pub(super) async fn finish_transaction<T>(
        &self,
        client: &mut MssqlClient,
        operation: &str,
        outcome: Result<T>,
    ) -> Result<T> {
        match outcome {
            Ok(value) => {
                // `.err()` drops the returned QueryStream immediately so the
                // client borrow ends before a possible ROLLBACK.
                if let Some(commit_error) = client.simple_query("COMMIT TRANSACTION").await.err() {
                    // A failed COMMIT usually aborts the transaction
                    // server-side; try to unwind, and poison the connection
                    // if even ROLLBACK refuses.
                    if client.simple_query("ROLLBACK TRANSACTION").await.is_err() {
                        self.poison_connection(&format!(
                            "{operation} commit failed and rollback refused"
                        ));
                    }
                    return Err(anyhow!("{operation} commit failed: {commit_error}"));
                }
                Ok(value)
            }
            Err(error) => match client.simple_query("ROLLBACK TRANSACTION").await {
                Ok(_) => Err(error),
                Err(rollback_error) => {
                    self.poison_connection(&format!(
                        "{operation} rollback failed: {rollback_error}"
                    ));
                    Err(anyhow!(
                        "{operation} failed ({error}) AND the automatic rollback also failed ({rollback_error}). The connection is poisoned and requires a reconnect before any further statement."
                    ))
                }
            },
        }
    }

    /// Builds the `UPDATE … SET col = @P1 WHERE pk = @Pn` statement for one
    /// cell edit. Shared by `update_table_cell` and the atomic edit queue so
    /// both paths emit identical SQL.
    pub(super) fn build_cell_update_statement(
        request: &TableCellUpdateRequest,
    ) -> Result<(String, Vec<serde_json::Value>)> {
        if request.primary_keys.is_empty() {
            return Err(anyhow!(
                "Inline update requires at least one primary key column"
            ));
        }

        let mut values = Vec::new();
        values.push(request.value.clone());
        let mut where_clause = String::new();
        for (index, primary_key) in request.primary_keys.iter().enumerate() {
            if index > 0 {
                where_clause.push_str(" AND ");
            }

            where_clause.push_str(&quote_mssql_order_by(&primary_key.column)?);
            if primary_key.value.is_null() {
                where_clause.push_str(" IS NULL");
            } else {
                values.push(primary_key.value.clone());
                where_clause.push_str(&format!(" = @P{}", values.len()));
            }
        }

        let sql = format!(
            "UPDATE {} SET {} = @P1 WHERE {}",
            Self::qualify_table_name(&request.table, request.database.as_deref())?,
            quote_mssql_order_by(&request.target_column)?,
            where_clause
        );
        Ok((sql, values))
    }

    /// Builds the `INSERT INTO … (cols) VALUES (@P1…)` statement for one row.
    /// Shared by `insert_table_row` and the atomic CSV import paths.
    pub(super) fn build_row_insert_statement(
        request: &TableRowInsertRequest,
    ) -> Result<(String, Vec<serde_json::Value>)> {
        if request.values.is_empty() {
            return Err(anyhow!("Insert requires at least one column value"));
        }

        let mut cols = Vec::new();
        let mut placeholders = Vec::new();
        let mut values = Vec::new();
        for (col, value) in &request.values {
            cols.push(quote_mssql_identifier(col)?.to_string());
            values.push(value.clone());
            placeholders.push(format!("@P{}", values.len()));
        }

        let sql = format!(
            "INSERT INTO {} ({}) VALUES ({})",
            Self::qualify_table_name(&request.table, request.database.as_deref())?,
            cols.join(", "),
            placeholders.join(", "),
        );
        Ok((sql, values))
    }
}
