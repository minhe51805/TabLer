use super::driver::DatabaseDriver;
use super::models::*;
use super::query_common::{statement_returns_rows, MAX_QUERY_RESULT_ROWS};
use super::safety::{
    normalize_order_dir, quote_sqlite_identifier, quote_sqlite_order_by,
    sanitize_sqlite_filter_clause,
};
use crate::utils::sql::split_sql_statements;
use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use libsql::{
    Builder, Connection as LibSqlConnection, Database as LibSqlDatabase, TransactionBehavior,
    Value as LibSqlValue, ValueType,
};
use std::sync::{Arc, RwLock};
use std::time::Instant;

pub struct LibSqlDriver {
    _database: LibSqlDatabase,
    connection: LibSqlConnection,
    current_db: Arc<RwLock<Option<String>>>,
}

impl LibSqlDriver {
    pub async fn connect(config: &ConnectionConfig) -> Result<Self> {
        let url = Self::build_remote_url(config)?;
        let auth_token = config.password.clone().unwrap_or_default();
        let database = Builder::new_remote(url, auth_token)
            .build()
            .await
            .context("Failed to create LibSQL client")?;
        let connection = database
            .connect()
            .context("Failed to open LibSQL connection")?;

        let current_db = config
            .database
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| {
                config
                    .host
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
            });

        Ok(Self {
            _database: database,
            connection,
            current_db: Arc::new(RwLock::new(current_db)),
        })
    }

    fn build_remote_url(config: &ConnectionConfig) -> Result<String> {
        let raw_host = config
            .host
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .context("LibSQL host is required")?;

        let host = if raw_host.contains(':') && !raw_host.starts_with('[') {
            format!("[{raw_host}]")
        } else {
            raw_host.to_string()
        };

        let mut url = format!("libsql://{host}");
        if let Some(port) = config.port.filter(|value| *value > 0) {
            url.push(':');
            url.push_str(&port.to_string());
        }

        if let Some(database) = config
            .database
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            url.push('/');
            url.push_str(database.trim_start_matches('/'));
        }

        Ok(url)
    }

    fn query_returns_rows(sql: &str) -> bool {
        statement_returns_rows(sql, &["SELECT", "PRAGMA", "EXPLAIN", "WITH"])
    }

    fn type_name(value_type: ValueType) -> &'static str {
        match value_type {
            ValueType::Null => "NULL",
            ValueType::Integer => "INTEGER",
            ValueType::Real => "REAL",
            ValueType::Text => "TEXT",
            ValueType::Blob => "BLOB",
        }
    }

    fn libsql_value_to_json(value: LibSqlValue) -> serde_json::Value {
        match value {
            LibSqlValue::Null => serde_json::Value::Null,
            LibSqlValue::Integer(value) => serde_json::Value::from(value),
            LibSqlValue::Real(value) => serde_json::Value::from(value),
            LibSqlValue::Text(value) => serde_json::Value::String(value),
            LibSqlValue::Blob(value) => serde_json::Value::String(format!(
                "0x{}",
                value
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>()
            )),
        }
    }

    fn serde_to_libsql_value(value: &serde_json::Value) -> Result<LibSqlValue> {
        match value {
            serde_json::Value::Null => Ok(LibSqlValue::Null),
            serde_json::Value::Bool(value) => Ok(LibSqlValue::Integer(if *value { 1 } else { 0 })),
            serde_json::Value::Number(value) => {
                if let Some(int_value) = value.as_i64() {
                    Ok(LibSqlValue::Integer(int_value))
                } else if let Some(uint_value) = value.as_u64() {
                    if let Ok(int_value) = i64::try_from(uint_value) {
                        Ok(LibSqlValue::Integer(int_value))
                    } else if let Some(float_value) = value.as_f64() {
                        Ok(LibSqlValue::Real(float_value))
                    } else {
                        Err(anyhow!("Unsupported numeric value"))
                    }
                } else if let Some(float_value) = value.as_f64() {
                    Ok(LibSqlValue::Real(float_value))
                } else {
                    Err(anyhow!("Unsupported numeric value"))
                }
            }
            serde_json::Value::String(value) => Ok(LibSqlValue::Text(value.clone())),
            _ => Err(anyhow!(
                "Only string, number, boolean, and null values are supported"
            )),
        }
    }

    async fn collect_rows_limited(
        &self,
        sql: &str,
    ) -> Result<(Vec<ColumnInfo>, Vec<Vec<serde_json::Value>>, bool)> {
        let mut rows = self
            .connection
            .query(sql, ())
            .await
            .with_context(|| format!("Failed to execute LibSQL query: {sql}"))?;

        let columns = (0..rows.column_count())
            .map(|index| ColumnInfo {
                name: rows
                    .column_name(index)
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("column_{}", index + 1)),
                data_type: rows
                    .column_type(index)
                    .map(Self::type_name)
                    .unwrap_or("UNKNOWN")
                    .to_string(),
                is_nullable: true,
                is_primary_key: false,
                max_length: None,
                default_value: None,
            })
            .collect::<Vec<_>>();

        let mut collected_rows = Vec::new();
        while let Some(row) = rows.next().await? {
            if collected_rows.len() == MAX_QUERY_RESULT_ROWS {
                return Ok((columns, collected_rows, true));
            }

            let row_values = (0..row.column_count())
                .map(|index| {
                    row.get_value(index)
                        .map(Self::libsql_value_to_json)
                        .unwrap_or(serde_json::Value::Null)
                })
                .collect::<Vec<_>>();

            collected_rows.push(row_values);
        }

        Ok((columns, collected_rows, false))
    }

    fn build_result(
        columns: Vec<ColumnInfo>,
        rows: Vec<Vec<serde_json::Value>>,
        elapsed: u128,
        query: String,
        affected_rows: u64,
        sandboxed: bool,
        truncated: bool,
    ) -> QueryResult {
        QueryResult {
            columns,
            rows,
            affected_rows,
            execution_time_ms: elapsed,
            query,
            sandboxed,
            truncated,
        }
    }

    fn list_database_names(&self) -> Vec<DatabaseInfo> {
        let current = self
            .current_db
            .read()
            .ok()
            .and_then(|guard| guard.clone())
            .unwrap_or_else(|| "main".to_string());

        vec![DatabaseInfo {
            name: current,
            size: None,
        }]
    }
}

#[async_trait]
impl DatabaseDriver for LibSqlDriver {
    async fn ping(&self) -> Result<()> {
        self.connection
            .query("SELECT 1", ())
            .await
            .context("LibSQL ping failed")?;
        Ok(())
    }

    async fn disconnect(&self) -> Result<()> {
        self.connection.reset().await;
        Ok(())
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        Ok(self.list_database_names())
    }

    async fn list_tables(&self, _database: Option<&str>) -> Result<Vec<TableInfo>> {
        let mut rows = self
            .connection
            .query(
                "SELECT name, type \
                 FROM sqlite_master \
                 WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' \
                 ORDER BY name",
                (),
            )
            .await
            .context("Failed to list LibSQL tables")?;

        let mut tables = Vec::new();
        while let Some(row) = rows.next().await? {
            tables.push(TableInfo {
                name: row.get::<String>(0)?,
                table_type: row.get::<String>(1)?,
                schema: None,
                row_count: None,
                engine: Some("LibSQL".to_string()),
            });
        }

        Ok(tables)
    }

    async fn list_schema_objects(
        &self,
        _database: Option<&str>,
    ) -> Result<Vec<SchemaObjectInfo>> {
        let mut rows = self
            .connection
            .query(
                "SELECT name, type, tbl_name, sql \
                 FROM sqlite_master \
                 WHERE type IN ('view', 'trigger') AND name NOT LIKE 'sqlite_%' \
                 ORDER BY type, name",
                (),
            )
            .await
            .context("Failed to list LibSQL schema objects")?;

        let mut objects = Vec::new();
        while let Some(row) = rows.next().await? {
            objects.push(SchemaObjectInfo {
                name: row.get::<String>(0)?,
                schema: None,
                object_type: row.get::<String>(1)?.to_ascii_uppercase(),
                related_table: row.get::<Option<String>>(2)?,
                definition: row.get::<Option<String>>(3)?,
            });
        }

        Ok(objects)
    }

    async fn get_table_structure(
        &self,
        table: &str,
        _database: Option<&str>,
    ) -> Result<TableStructure> {
        let quoted_table = quote_sqlite_identifier(table)?;

        let mut column_rows = self
            .connection
            .query(&format!("PRAGMA table_info({quoted_table})"), ())
            .await
            .context("Failed to query LibSQL table_info")?;

        let mut columns = Vec::new();
        while let Some(row) = column_rows.next().await? {
            columns.push(ColumnDetail {
                name: row.get::<String>(1)?,
                data_type: row.get::<String>(2)?,
                is_nullable: row.get::<i64>(3)? == 0,
                default_value: row.get::<Option<String>>(4)?,
                is_primary_key: row.get::<i64>(5)? > 0,
                extra: None,
                column_type: None,
                comment: None,
            });
        }

        let mut index_rows = self
            .connection
            .query(&format!("PRAGMA index_list({quoted_table})"), ())
            .await
            .context("Failed to query LibSQL index_list")?;

        let mut indexes = Vec::new();
        while let Some(row) = index_rows.next().await? {
            let name = row.get::<String>(1)?;
            let is_unique = row.get::<i64>(2)? == 1;

            let mut info_rows = self
                .connection
                .query(
                    &format!("PRAGMA index_info({})", quote_sqlite_identifier(&name)?),
                    (),
                )
                .await
                .with_context(|| format!("Failed to query LibSQL index_info for {name}"))?;

            let mut index_columns = Vec::new();
            while let Some(info_row) = info_rows.next().await? {
                index_columns.push(info_row.get::<String>(2)?);
            }

            indexes.push(IndexInfo {
                name,
                columns: index_columns,
                is_unique,
                index_type: None,
            });
        }

        let mut fk_rows = self
            .connection
            .query(&format!("PRAGMA foreign_key_list({quoted_table})"), ())
            .await
            .context("Failed to query LibSQL foreign_key_list")?;

        let mut foreign_keys = Vec::new();
        while let Some(row) = fk_rows.next().await? {
            foreign_keys.push(ForeignKeyInfo {
                name: format!("fk_{}", row.get::<i64>(0)?),
                column: row.get::<String>(3)?,
                referenced_table: row.get::<String>(2)?,
                referenced_column: row.get::<String>(4)?,
                on_update: row.get::<Option<String>>(5)?,
                on_delete: row.get::<Option<String>>(6)?,
            });
        }

        let mut object_type_rows = self
            .connection
            .query(
                "SELECT type FROM sqlite_master WHERE name = ?1 AND type IN ('table', 'view') LIMIT 1",
                [LibSqlValue::Text(table.to_string())],
            )
            .await?;
        let object_type = if let Some(row) = object_type_rows.next().await? {
            Some(row.get::<String>(0)?.to_ascii_uppercase())
        } else {
            None
        };

        let mut view_rows = self
            .connection
            .query(
                "SELECT sql FROM sqlite_master WHERE type = 'view' AND name = ?1 LIMIT 1",
                [LibSqlValue::Text(table.to_string())],
            )
            .await?;
        let view_definition = if let Some(row) = view_rows.next().await? {
            row.get::<Option<String>>(0)?
        } else {
            None
        };

        let mut trigger_rows = self
            .connection
            .query(
                "SELECT name, tbl_name, sql \
                 FROM sqlite_master \
                 WHERE type = 'trigger' AND tbl_name = ?1 \
                 ORDER BY name",
                [LibSqlValue::Text(table.to_string())],
            )
            .await
            .context("Failed to list LibSQL triggers")?;

        let mut triggers = Vec::new();
        while let Some(row) = trigger_rows.next().await? {
            triggers.push(TriggerInfo {
                name: row.get::<String>(0)?,
                timing: None,
                event: None,
                related_table: row.get::<Option<String>>(1)?,
                definition: row.get::<Option<String>>(2)?,
            });
        }

        Ok(TableStructure {
            columns,
            indexes,
            foreign_keys,
            triggers,
            view_definition,
            object_type,
        })
    }

    async fn execute_query(&self, sql: &str) -> Result<QueryResult> {
        let start = Instant::now();
        let statements = split_sql_statements(sql);

        if statements.len() <= 1 && Self::query_returns_rows(sql) {
            let (columns, rows, truncated) = self.collect_rows_limited(sql).await?;
            return Ok(Self::build_result(
                columns,
                rows,
                start.elapsed().as_millis(),
                sql.to_string(),
                0,
                false,
                truncated,
            ));
        }

        let mut total_affected = 0u64;
        let mut last_result: Option<QueryResult> = None;

        if statements.len() > 1 {
            for statement in &statements {
                if Self::query_returns_rows(statement) {
                    let (columns, rows, truncated) = self.collect_rows_limited(statement).await?;
                    last_result = Some(Self::build_result(
                        columns,
                        rows,
                        0,
                        sql.to_string(),
                        total_affected,
                        false,
                        truncated,
                    ));
                } else {
                    total_affected += self
                        .connection
                        .execute(statement, ())
                        .await
                        .with_context(|| format!("Failed to execute LibSQL statement: {statement}"))?;
                }
            }
        } else if let Some(statement) = statements.first() {
            if Self::query_returns_rows(statement) {
                let (columns, rows, truncated) = self.collect_rows_limited(statement).await?;
                last_result = Some(Self::build_result(
                    columns,
                    rows,
                    0,
                    sql.to_string(),
                    total_affected,
                    false,
                    truncated,
                ));
            } else {
                total_affected += self
                    .connection
                    .execute(statement, ())
                    .await
                    .with_context(|| format!("Failed to execute LibSQL statement: {statement}"))?;
            }
        }

        let elapsed = start.elapsed().as_millis();
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
            sandboxed: false,
            truncated: false,
        })
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
        let mut sql = format!("SELECT * FROM {}", quote_sqlite_identifier(table)?);
        if let Some(filter_clause) = sanitize_sqlite_filter_clause(filter)? {
            sql.push_str(&format!(" WHERE {filter_clause}"));
        }
        if let Some(order_by) = order_by {
            let direction = normalize_order_dir(order_dir)?;
            sql.push_str(&format!(
                " ORDER BY {} {}",
                quote_sqlite_order_by(order_by)?,
                direction
            ));
        }
        sql.push_str(&format!(" LIMIT {limit} OFFSET {offset}"));

        self.execute_query(&sql).await
    }

    async fn count_rows(&self, table: &str, _database: Option<&str>) -> Result<i64> {
        let sql = format!("SELECT COUNT(*) FROM {}", quote_sqlite_identifier(table)?);
        let mut rows = self.connection.query(&sql, ()).await?;
        let row = rows
            .next()
            .await?
            .ok_or_else(|| anyhow!("LibSQL count query returned no rows"))?;
        row.get::<i64>(0).map_err(Into::into)
    }

    async fn count_null_values(
        &self,
        table: &str,
        _database: Option<&str>,
        column: &str,
    ) -> Result<i64> {
        let sql = format!(
            "SELECT COUNT(*) FROM {} WHERE {} IS NULL",
            quote_sqlite_identifier(table)?,
            quote_sqlite_order_by(column)?,
        );
        let mut rows = self.connection.query(&sql, ()).await?;
        let row = rows
            .next()
            .await?
            .ok_or_else(|| anyhow!("LibSQL null-count query returned no rows"))?;
        row.get::<i64>(0).map_err(Into::into)
    }

    async fn update_table_cell(&self, request: &TableCellUpdateRequest) -> Result<u64> {
        if request.primary_keys.is_empty() {
            return Err(anyhow!(
                "Inline update requires at least one primary key column"
            ));
        }

        let mut sql = format!(
            "UPDATE {} SET {} = ? WHERE ",
            quote_sqlite_identifier(&request.table)?,
            quote_sqlite_order_by(&request.target_column)?,
        );
        let mut params = vec![Self::serde_to_libsql_value(&request.value)?];

        for (index, primary_key) in request.primary_keys.iter().enumerate() {
            if index > 0 {
                sql.push_str(" AND ");
            }
            sql.push_str(&quote_sqlite_order_by(&primary_key.column)?);
            if primary_key.value.is_null() {
                sql.push_str(" IS NULL");
            } else {
                sql.push_str(" = ?");
                params.push(Self::serde_to_libsql_value(&primary_key.value)?);
            }
        }

        self.connection
            .execute(&sql, params)
            .await
            .with_context(|| format!("Failed to update LibSQL table cell in {}", request.table))
    }

    async fn delete_table_rows(&self, request: &TableRowDeleteRequest) -> Result<u64> {
        if request.rows.is_empty() {
            return Err(anyhow!(
                "Deleting rows requires at least one selected row"
            ));
        }

        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .await
            .context("Failed to open LibSQL transaction for delete")?;

        let mut total_affected = 0u64;

        for row_keys in &request.rows {
            if row_keys.is_empty() {
                return Err(anyhow!(
                    "Each deleted row must include at least one primary key value"
                ));
            }

            let mut sql = format!("DELETE FROM {}", quote_sqlite_identifier(&request.table)?);
            let mut params = Vec::new();
            let mut first_condition = true;

            for primary_key in row_keys {
                sql.push_str(if first_condition { " WHERE " } else { " AND " });
                first_condition = false;

                sql.push_str(&quote_sqlite_order_by(&primary_key.column)?);
                if primary_key.value.is_null() {
                    sql.push_str(" IS NULL");
                } else {
                    sql.push_str(" = ?");
                    params.push(Self::serde_to_libsql_value(&primary_key.value)?);
                }
            }

            total_affected += tx
                .execute(&sql, params)
                .await
                .with_context(|| format!("Failed to delete LibSQL row in {}", request.table))?;
        }

        tx.commit()
            .await
            .context("Failed to commit LibSQL delete transaction")?;

        Ok(total_affected)
    }

    async fn use_database(&self, database: &str) -> Result<()> {
        let requested = database.trim();
        if requested.is_empty() {
            return Err(anyhow!("LibSQL database name cannot be empty"));
        }

        let mut current = self
            .current_db
            .write()
            .map_err(|_| anyhow!("Failed to access LibSQL database state"))?;

        if let Some(existing) = current.as_deref() {
            if existing != requested {
                return Err(anyhow!(
                    "LibSQL remote connections cannot switch databases after connecting"
                ));
            }
        }

        *current = Some(requested.to_string());
        Ok(())
    }

    fn current_database(&self) -> Option<String> {
        self.current_db.read().ok().and_then(|guard| guard.clone())
    }

    async fn insert_table_row(&self, request: &TableRowInsertRequest) -> Result<u64> {
        if request.values.is_empty() {
            return Err(anyhow!("Insert requires at least one column value"));
        }

        let mut sql = format!("INSERT INTO {} (", quote_sqlite_identifier(&request.table)?);
        let mut params: Vec<LibSqlValue> = Vec::new();

        let mut first = true;
        for (col, _) in &request.values {
            if !first {
                sql.push_str(", ");
            }
            first = false;
            sql.push_str(&quote_sqlite_identifier(col)?);
        }

        sql.push_str(") VALUES (");

        first = true;
        for (_, value) in &request.values {
            if !first {
                sql.push_str(", ");
            }
            first = false;
            sql.push_str("?");
            params.push(Self::serde_to_libsql_value(value)?);
        }

        sql.push(')');

        let rows_affected = self.connection.execute(&sql, params).await
            .with_context(|| format!("Failed to insert row into LibSQL table {}", request.table))?;
        Ok(rows_affected as u64)
    }

    fn driver_name(&self) -> &str {
        "LibSQL"
    }

    async fn get_foreign_key_lookup_values(
        &self,
        referenced_table: &str,
        referenced_column: &str,
        display_columns: &[&str],
        search: Option<&str>,
        limit: u32,
    ) -> Result<Vec<LookupValue>> {
        let label_expr = if !display_columns.is_empty() {
            let cols = display_columns
                .iter()
                .map(|c| format!("\"{}\"", c))
                .collect::<Vec<_>>()
                .join(", ");
            format!("COALESCE({})", cols)
        } else {
            format!("\"{}\"", referenced_column)
        };

        let where_clause = if let Some(search_term) = search {
            format!(" WHERE CAST(\"{}\" AS TEXT) LIKE '%{}%'", referenced_column, search_term)
        } else {
            String::new()
        };

        let sql = format!(
            "SELECT \"{}\" AS value, {} AS label \
             FROM \"{}\" \
             {} \
             ORDER BY \"{}\" \
             LIMIT {}",
            referenced_column,
            label_expr,
            referenced_table,
            where_clause,
            referenced_column,
            limit
        );

        let result = self.execute_query(&sql).await?;
        let values = result
            .rows
            .into_iter()
            .map(|row| {
                let value = row.first().cloned().unwrap_or(serde_json::Value::Null);
                let label = row.get(1).cloned().unwrap_or(value.clone());
                LookupValue {
                    value,
                    label: if label.is_string() {
                        label.as_str().unwrap().to_string()
                    } else {
                        serde_json::to_string(&label).unwrap_or_default()
                    },
                }
            })
            .collect();
        Ok(values)
    }
}
