use super::driver::DatabaseDriver;
use super::models::*;
use super::query_common::{statement_returns_rows, MAX_QUERY_RESULT_ROWS};
use super::safety::{
    normalize_order_dir, qualify_postgres_table_name, quote_postgres_identifier,
    quote_postgres_order_by, sanitize_postgres_filter_clause,
};
use crate::utils::sql::split_sql_statements;
use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use duckdb::types::{Value as DuckValue, ValueRef as DuckValueRef};
use duckdb::{AccessMode, Config, Connection as DuckConnection, OptionalExt, ToSql};
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tokio::task;

pub struct DuckDbDriver {
    connection: Arc<Mutex<DuckConnection>>,
    file_path: String,
}

impl DuckDbDriver {
    pub async fn connect(config: &ConnectionConfig) -> Result<Self> {
        let file_path = config
            .file_path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .context("DuckDB file path is required")?
            .to_string();
        let open_mode = config
            .additional_fields
            .get("read_only")
            .map(|value| value.trim().to_ascii_lowercase());

        let file_path_for_open = file_path.clone();
        let connection = task::spawn_blocking(move || -> Result<DuckConnection> {
            if file_path_for_open != ":memory:" {
                let path = Path::new(&file_path_for_open);
                if let Some(parent) = path.parent() {
                    if !parent.as_os_str().is_empty() {
                        fs::create_dir_all(parent)
                            .context("Failed to create DuckDB parent directory")?;
                    }
                }
            }

            let access_mode = match open_mode.as_deref() {
                Some("read_only") | Some("readonly") => AccessMode::ReadOnly,
                Some("read_write") | Some("readwrite") => AccessMode::ReadWrite,
                _ => AccessMode::Automatic,
            };
            let config = Config::default()
                .access_mode(access_mode)
                .context("Failed to prepare DuckDB connection options")?;

            if file_path_for_open == ":memory:" {
                DuckConnection::open_in_memory_with_flags(config)
                    .context("Failed to connect to DuckDB")
            } else {
                DuckConnection::open_with_flags(&file_path_for_open, config)
                    .context("Failed to connect to DuckDB")
            }
        })
        .await
        .map_err(|_| anyhow!("DuckDB connection task failed unexpectedly"))??;

        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
            file_path,
        })
    }

    async fn with_connection<T, F>(&self, operation: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut DuckConnection) -> Result<T> + Send + 'static,
    {
        let connection = self.connection.clone();
        task::spawn_blocking(move || {
            let mut guard = connection
                .lock()
                .map_err(|_| anyhow!("DuckDB connection lock was poisoned"))?;
            operation(&mut guard)
        })
        .await
        .map_err(|_| anyhow!("DuckDB background task failed unexpectedly"))?
    }

    fn split_schema_table(table: &str) -> (String, String) {
        if let Some((schema, table_name)) = table.split_once('.') {
            (schema.trim().to_string(), table_name.trim().to_string())
        } else {
            ("main".to_string(), table.trim().to_string())
        }
    }

    fn query_returns_rows(sql: &str) -> bool {
        statement_returns_rows(sql, &["SELECT", "PRAGMA", "EXPLAIN", "WITH", "SHOW", "DESCRIBE"])
    }

    fn duck_value_to_json(value: DuckValue) -> serde_json::Value {
        match value {
            DuckValue::Null => serde_json::Value::Null,
            DuckValue::Boolean(value) => serde_json::Value::from(value),
            DuckValue::TinyInt(value) => serde_json::Value::from(value),
            DuckValue::SmallInt(value) => serde_json::Value::from(value),
            DuckValue::Int(value) => serde_json::Value::from(value),
            DuckValue::BigInt(value) => serde_json::Value::from(value),
            DuckValue::HugeInt(value) => serde_json::Value::String(value.to_string()),
            DuckValue::UTinyInt(value) => serde_json::Value::from(value),
            DuckValue::USmallInt(value) => serde_json::Value::from(value),
            DuckValue::UInt(value) => serde_json::Value::from(value),
            DuckValue::UBigInt(value) => serde_json::Value::from(value),
            DuckValue::Float(value) => serde_json::Value::from(value as f64),
            DuckValue::Double(value) => serde_json::Value::from(value),
            DuckValue::Decimal(value) => serde_json::Value::String(value.to_string()),
            DuckValue::Timestamp(unit, value) => serde_json::Value::String(format!("{unit:?}:{value}")),
            DuckValue::Text(value) => serde_json::Value::String(value),
            DuckValue::Blob(value) => serde_json::Value::Array(
                value.into_iter().map(serde_json::Value::from).collect(),
            ),
            DuckValue::Date32(value) => serde_json::Value::from(value),
            DuckValue::Time64(unit, value) => serde_json::Value::String(format!("{unit:?}:{value}")),
            DuckValue::Interval { months, days, nanos } => serde_json::json!({
                "months": months,
                "days": days,
                "nanos": nanos,
            }),
            DuckValue::List(values) | DuckValue::Array(values) => serde_json::Value::Array(
                values.into_iter().map(Self::duck_value_to_json).collect(),
            ),
            DuckValue::Enum(value) => serde_json::Value::String(value),
            DuckValue::Struct(values) => serde_json::Value::Object(
                values
                    .iter()
                    .map(|(key, value)| (key.clone(), Self::duck_value_to_json(value.clone())))
                    .collect(),
            ),
            DuckValue::Map(values) => serde_json::Value::Array(
                values
                    .iter()
                    .map(|(key, value)| serde_json::json!({
                        "key": Self::duck_value_to_json(key.clone()),
                        "value": Self::duck_value_to_json(value.clone()),
                    }))
                    .collect(),
            ),
            DuckValue::Union(value) => Self::duck_value_to_json(*value),
        }
    }

    fn value_ref_to_json(value: DuckValueRef<'_>) -> serde_json::Value {
        Self::duck_value_to_json(value.to_owned())
    }

    fn value_ref_to_label(value: DuckValueRef<'_>) -> String {
        match value {
            DuckValueRef::Null => String::new(),
            DuckValueRef::Text(bytes) | DuckValueRef::Blob(bytes) => {
                String::from_utf8_lossy(bytes).to_string()
            }
            other => match Self::duck_value_to_json(other.to_owned()) {
                serde_json::Value::String(text) => text,
                other_json => other_json.to_string(),
            },
        }
    }

    fn json_to_duck_value(value: &serde_json::Value) -> Result<DuckValue> {
        match value {
            serde_json::Value::Null => Ok(DuckValue::Null),
            serde_json::Value::Bool(value) => Ok(DuckValue::Boolean(*value)),
            serde_json::Value::Number(value) => {
                if let Some(int_value) = value.as_i64() {
                    Ok(DuckValue::BigInt(int_value))
                } else if let Some(uint_value) = value.as_u64() {
                    Ok(DuckValue::UBigInt(uint_value))
                } else if let Some(float_value) = value.as_f64() {
                    Ok(DuckValue::Double(float_value))
                } else {
                    Err(anyhow!("Unsupported numeric value"))
                }
            }
            serde_json::Value::String(value) => Ok(DuckValue::Text(value.clone())),
            _ => Err(anyhow!(
                "Only string, number, boolean, and null values are supported"
            )),
        }
    }

    fn estimate_file_size(path: &str) -> Option<String> {
        if path == ":memory:" {
            return None;
        }

        let bytes = fs::metadata(path).ok()?.len();
        if bytes >= 1024 * 1024 * 1024 {
            Some(format!("{:.1} GB", bytes as f64 / (1024.0 * 1024.0 * 1024.0)))
        } else if bytes >= 1024 * 1024 {
            Some(format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0)))
        } else if bytes >= 1024 {
            Some(format!("{:.1} KB", bytes as f64 / 1024.0))
        } else {
            Some(format!("{bytes} B"))
        }
    }

    fn execute_select(
        conn: &mut DuckConnection,
        sql: &str,
        original_query: &str,
        affected_rows: u64,
        sandboxed: bool,
    ) -> Result<QueryResult> {
        let start = Instant::now();
        let mut statement = conn.prepare(sql)?;
        let mut rows = statement.query([])?;

        let columns = if let Some(statement_ref) = rows.as_ref() {
            (0..statement_ref.column_count())
                .map(|index| {
                    Ok(ColumnInfo {
                        name: statement_ref.column_name(index)?.clone(),
                        data_type: format!("{:?}", statement_ref.column_type(index)),
                        is_nullable: true,
                        is_primary_key: false,
                        max_length: None,
                        default_value: None,
                    })
                })
                .collect::<Result<Vec<_>>>()?
        } else {
            Vec::new()
        };

        let mut result_rows = Vec::new();
        let mut truncated = false;
        while let Some(row) = rows.next()? {
            if result_rows.len() == MAX_QUERY_RESULT_ROWS {
                truncated = true;
                break;
            }

            let mut current_row = Vec::with_capacity(columns.len());
            for index in 0..columns.len() {
                current_row.push(Self::value_ref_to_json(row.get_ref(index)?));
            }
            result_rows.push(current_row);
        }

        Ok(QueryResult {
            columns,
            rows: result_rows,
            affected_rows,
            execution_time_ms: start.elapsed().as_millis(),
            query: original_query.to_string(),
            sandboxed,
            truncated,
        })
    }

    fn collect_text_column(
        conn: &mut DuckConnection,
        sql: &str,
        schema: &str,
        table_name: &str,
    ) -> Result<Vec<String>> {
        let mut statement = conn.prepare(sql)?;
        let mut rows = statement.query([schema, table_name])?;
        let mut values = Vec::new();
        while let Some(row) = rows.next()? {
            values.push(row.get::<_, String>(0)?);
        }
        Ok(values)
    }

    fn load_foreign_keys(
        conn: &mut DuckConnection,
        schema: &str,
        table_name: &str,
    ) -> Result<Vec<ForeignKeyInfo>> {
        let sql = "\
            SELECT
                kcu.constraint_name,
                kcu.column_name,
                ccu.table_name AS referenced_table,
                ccu.column_name AS referenced_column
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name
             AND tc.table_schema = kcu.table_schema
             AND tc.table_name = kcu.table_name
            JOIN information_schema.constraint_column_usage ccu
              ON tc.constraint_name = ccu.constraint_name
             AND tc.constraint_schema = ccu.constraint_schema
            WHERE tc.table_schema = ? AND tc.table_name = ? AND tc.constraint_type = 'FOREIGN KEY'
            ORDER BY kcu.ordinal_position";

        let mut statement = conn.prepare(sql)?;
        let mut rows = statement.query([schema, table_name])?;
        let mut foreign_keys = Vec::new();

        while let Some(row) = rows.next()? {
            foreign_keys.push(ForeignKeyInfo {
                name: row.get(0)?,
                column: row.get(1)?,
                referenced_table: row.get(2)?,
                referenced_column: row.get(3)?,
                on_update: None,
                on_delete: None,
            });
        }

        Ok(foreign_keys)
    }
}

#[async_trait]
impl DatabaseDriver for DuckDbDriver {
    async fn ping(&self) -> Result<()> {
        self.with_connection(|conn| {
            conn.query_row("SELECT 1", [], |row| row.get::<_, i64>(0))
                .context("DuckDB ping failed")?;
            Ok(())
        })
        .await
    }

    async fn disconnect(&self) -> Result<()> {
        Ok(())
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        let file_path = self.file_path.clone();
        Ok(vec![DatabaseInfo {
            name: file_path.clone(),
            size: Self::estimate_file_size(&file_path),
        }])
    }

    async fn list_tables(&self, _database: Option<&str>) -> Result<Vec<TableInfo>> {
        self.with_connection(|conn| {
            let sql = "\
                SELECT table_schema, table_name, table_type
                FROM information_schema.tables
                WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
                  AND table_name NOT LIKE 'duckdb_%'
                ORDER BY table_schema, table_name";
            let mut statement = conn.prepare(sql)?;
            let mut rows = statement.query([])?;
            let mut tables = Vec::new();

            while let Some(row) = rows.next()? {
                tables.push(TableInfo {
                    name: row.get(1)?,
                    schema: row.get::<_, String>(0).ok(),
                    table_type: row.get::<_, String>(2)?,
                    row_count: None,
                    engine: Some("DuckDB".to_string()),
                });
            }

            Ok(tables)
        })
        .await
    }

    async fn list_schema_objects(&self, _database: Option<&str>) -> Result<Vec<SchemaObjectInfo>> {
        self.with_connection(|conn| {
            let sql = "\
                SELECT table_schema, table_name, view_definition
                FROM information_schema.views
                WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
                ORDER BY table_schema, table_name";
            let mut statement = conn.prepare(sql)?;
            let mut rows = statement.query([])?;
            let mut objects = Vec::new();

            while let Some(row) = rows.next()? {
                objects.push(SchemaObjectInfo {
                    name: row.get(1)?,
                    schema: row.get::<_, String>(0).ok(),
                    object_type: "VIEW".to_string(),
                    related_table: None,
                    definition: row.get::<_, String>(2).ok(),
                });
            }

            Ok(objects)
        })
        .await
    }

    async fn get_table_structure(
        &self,
        table: &str,
        _database: Option<&str>,
    ) -> Result<TableStructure> {
        let table_name = table.to_string();
        self.with_connection(move |conn| {
            let (schema, bare_table_name) = Self::split_schema_table(&table_name);
            let primary_key_columns = Self::collect_text_column(
                conn,
                "\
                    SELECT kcu.column_name
                    FROM information_schema.table_constraints tc
                    JOIN information_schema.key_column_usage kcu
                      ON tc.constraint_name = kcu.constraint_name
                     AND tc.table_schema = kcu.table_schema
                     AND tc.table_name = kcu.table_name
                    WHERE tc.table_schema = ? AND tc.table_name = ? AND tc.constraint_type = 'PRIMARY KEY'
                    ORDER BY kcu.ordinal_position",
                &schema,
                &bare_table_name,
            )
            .unwrap_or_default()
            .into_iter()
            .collect::<HashSet<_>>();

            let mut column_statement = conn.prepare(
                "\
                    SELECT column_name, data_type, is_nullable, column_default
                    FROM information_schema.columns
                    WHERE table_schema = ? AND table_name = ?
                    ORDER BY ordinal_position",
            )?;
            let mut column_rows = column_statement.query([schema.as_str(), bare_table_name.as_str()])?;
            let mut columns = Vec::new();

            while let Some(row) = column_rows.next()? {
                let column_name: String = row.get(0)?;
                columns.push(ColumnDetail {
                    name: column_name.clone(),
                    data_type: row.get(1)?,
                    is_nullable: row
                        .get::<_, String>(2)
                        .map(|value| value.eq_ignore_ascii_case("YES"))
                        .unwrap_or(true),
                    default_value: row.get::<_, String>(3).ok(),
                    is_primary_key: primary_key_columns.contains(&column_name),
                    extra: None,
                    column_type: None,
                    comment: None,
                });
            }

            let object_type = conn
                .query_row(
                    "\
                        SELECT table_type
                        FROM information_schema.tables
                        WHERE table_schema = ? AND table_name = ?
                        LIMIT 1",
                    [schema.as_str(), bare_table_name.as_str()],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .map(|value| value.to_ascii_uppercase());

            let view_definition = conn
                .query_row(
                    "\
                        SELECT view_definition
                        FROM information_schema.views
                        WHERE table_schema = ? AND table_name = ?
                        LIMIT 1",
                    [schema.as_str(), bare_table_name.as_str()],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;

            let foreign_keys =
                Self::load_foreign_keys(conn, &schema, &bare_table_name).unwrap_or_default();

            Ok(TableStructure {
                columns,
                indexes: Vec::new(),
                foreign_keys,
                triggers: Vec::new(),
                view_definition,
                object_type,
            })
        })
        .await
    }

    async fn execute_query(&self, sql: &str) -> Result<QueryResult> {
        let sql_text = sql.to_string();
        self.with_connection(move |conn| {
            let start = Instant::now();
            let statements = split_sql_statements(&sql_text);
            let mut total_affected = 0u64;
            let mut last_result: Option<QueryResult> = None;

            if statements.len() <= 1 && Self::query_returns_rows(&sql_text) {
                return Self::execute_select(conn, &sql_text, &sql_text, 0, false);
            }

            for statement in statements {
                if statement.trim().is_empty() {
                    continue;
                }

                if Self::query_returns_rows(&statement) {
                    last_result = Some(Self::execute_select(
                        conn,
                        &statement,
                        &sql_text,
                        total_affected,
                        false,
                    )?);
                } else {
                    total_affected += conn.execute(&statement, [])? as u64;
                }
            }

            if let Some(mut result) = last_result {
                result.execution_time_ms = start.elapsed().as_millis();
                result.affected_rows = total_affected;
                return Ok(result);
            }

            Ok(QueryResult {
                columns: Vec::new(),
                rows: Vec::new(),
                affected_rows: total_affected,
                execution_time_ms: start.elapsed().as_millis(),
                query: sql_text,
                sandboxed: false,
                truncated: false,
            })
        })
        .await
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
        let mut sql = format!("SELECT * FROM {}", qualify_postgres_table_name(table, "main")?);
        if let Some(filter_clause) = sanitize_postgres_filter_clause(filter)? {
            sql.push_str(&format!(" WHERE {filter_clause}"));
        }
        if let Some(order_by) = order_by {
            let direction = normalize_order_dir(order_dir)?;
            sql.push_str(&format!(
                " ORDER BY {} {}",
                quote_postgres_order_by(order_by)?,
                direction
            ));
        }
        sql.push_str(&format!(" LIMIT {limit} OFFSET {offset}"));

        self.execute_query(&sql).await
    }

    async fn count_rows(&self, table: &str, _database: Option<&str>) -> Result<i64> {
        let sql = format!(
            "SELECT COUNT(*) FROM {}",
            qualify_postgres_table_name(table, "main")?
        );
        self.with_connection(move |conn| conn.query_row(&sql, [], |row| row.get(0)).map_err(Into::into))
            .await
    }

    async fn count_null_values(
        &self,
        table: &str,
        _database: Option<&str>,
        column: &str,
    ) -> Result<i64> {
        let sql = format!(
            "SELECT COUNT(*) FROM {} WHERE {} IS NULL",
            qualify_postgres_table_name(table, "main")?,
            quote_postgres_order_by(column)?,
        );
        self.with_connection(move |conn| conn.query_row(&sql, [], |row| row.get(0)).map_err(Into::into))
            .await
    }

    async fn update_table_cell(&self, request: &TableCellUpdateRequest) -> Result<u64> {
        if request.primary_keys.is_empty() {
            return Err(anyhow!(
                "Inline update requires at least one primary key column"
            ));
        }

        let qualified_table = qualify_postgres_table_name(&request.table, "main")?;
        let target_column = quote_postgres_order_by(&request.target_column)?;
        let mut sql = format!("UPDATE {qualified_table} SET {target_column} = ?");
        let mut params = vec![Self::json_to_duck_value(&request.value)?];

        sql.push_str(" WHERE ");
        for (index, primary_key) in request.primary_keys.iter().enumerate() {
            if index > 0 {
                sql.push_str(" AND ");
            }

            sql.push_str(&quote_postgres_order_by(&primary_key.column)?);
            if primary_key.value.is_null() {
                sql.push_str(" IS NULL");
            } else {
                sql.push_str(" = ?");
                params.push(Self::json_to_duck_value(&primary_key.value)?);
            }
        }

        self.with_connection(move |conn| {
            let param_refs = params.iter().map(|value| value as &dyn ToSql).collect::<Vec<_>>();
            Ok(conn.execute(&sql, param_refs.as_slice())? as u64)
        })
        .await
    }

    async fn delete_table_rows(&self, request: &TableRowDeleteRequest) -> Result<u64> {
        if request.rows.is_empty() {
            return Err(anyhow!(
                "Deleting rows requires at least one selected row"
            ));
        }

        let request = request.clone();
        self.with_connection(move |conn| {
            conn.execute_batch("BEGIN")?;
            let deletion_result = (|| -> Result<u64> {
                let qualified_table = qualify_postgres_table_name(&request.table, "main")?;
                let mut total_affected = 0u64;

                for row_keys in &request.rows {
                    if row_keys.is_empty() {
                        return Err(anyhow!(
                            "Each deleted row must include at least one primary key value"
                        ));
                    }

                    let mut sql = format!("DELETE FROM {qualified_table} WHERE ");
                    let mut params = Vec::new();

                    for (index, primary_key) in row_keys.iter().enumerate() {
                        if index > 0 {
                            sql.push_str(" AND ");
                        }

                        sql.push_str(&quote_postgres_order_by(&primary_key.column)?);
                        if primary_key.value.is_null() {
                            sql.push_str(" IS NULL");
                        } else {
                            sql.push_str(" = ?");
                            params.push(Self::json_to_duck_value(&primary_key.value)?);
                        }
                    }

                    let param_refs = params.iter().map(|value| value as &dyn ToSql).collect::<Vec<_>>();
                    total_affected += conn.execute(&sql, param_refs.as_slice())? as u64;
                }

                Ok(total_affected)
            })();

            if deletion_result.is_ok() {
                conn.execute_batch("COMMIT")?;
            } else {
                let _ = conn.execute_batch("ROLLBACK");
            }

            deletion_result
        })
        .await
    }

    async fn insert_table_row(&self, request: &TableRowInsertRequest) -> Result<u64> {
        if request.values.is_empty() {
            return Err(anyhow!("Insert requires at least one column value"));
        }

        let request = request.clone();
        self.with_connection(move |conn| {
            let qualified_table = qualify_postgres_table_name(&request.table, "main")?;
            let mut sql = format!("INSERT INTO {qualified_table} (");
            let mut params = Vec::new();

            for (index, (column, value)) in request.values.iter().enumerate() {
                if index > 0 {
                    sql.push_str(", ");
                }
                sql.push_str(&quote_postgres_identifier(column)?);
                params.push(Self::json_to_duck_value(value)?);
            }

            sql.push_str(") VALUES (");
            for index in 0..params.len() {
                if index > 0 {
                    sql.push_str(", ");
                }
                sql.push('?');
            }
            sql.push(')');

            let param_refs = params.iter().map(|value| value as &dyn ToSql).collect::<Vec<_>>();
            Ok(conn.execute(&sql, param_refs.as_slice())? as u64)
        })
        .await
    }

    async fn execute_structure_statements(&self, statements: &[String]) -> Result<u64> {
        let statements = statements.to_vec();
        self.with_connection(move |conn| {
            let mut total_affected = 0u64;
            for statement in statements {
                if statement.trim().is_empty() {
                    continue;
                }
                if Self::query_returns_rows(&statement) {
                    let result = Self::execute_select(conn, &statement, &statement, 0, false)?;
                    total_affected += result.affected_rows;
                } else {
                    total_affected += conn.execute(&statement, [])? as u64;
                }
            }
            Ok(total_affected)
        })
        .await
    }

    async fn use_database(&self, _database: &str) -> Result<()> {
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
        let label_expr = if !display_columns.is_empty() {
            display_columns
                .iter()
                .map(|column| quote_postgres_identifier(column))
                .collect::<Result<Vec<_>>>()?
                .join(" || ' ' || ")
        } else {
            quote_postgres_identifier(referenced_column)?
        };
        let qualified_table = qualify_postgres_table_name(referenced_table, "main")?;
        let referenced_column_quoted = quote_postgres_identifier(referenced_column)?;
        let search_term = search.map(str::to_string);

        self.with_connection(move |conn| {
            let mut sql = format!(
                "SELECT {} AS value, {} AS label FROM {}",
                referenced_column_quoted, label_expr, qualified_table
            );
            let mut params = Vec::new();

            if let Some(search_term) = search_term.as_deref() {
                sql.push_str(&format!(
                    " WHERE CAST({} AS VARCHAR) ILIKE ?",
                    referenced_column_quoted
                ));
                params.push(DuckValue::Text(format!("%{search_term}%")));
            }

            sql.push_str(&format!(
                " ORDER BY {} LIMIT {}",
                referenced_column_quoted, limit
            ));

            let param_refs = params.iter().map(|value| value as &dyn ToSql).collect::<Vec<_>>();
            let mut statement = conn.prepare(&sql)?;
            let mut rows = statement.query(param_refs.as_slice())?;
            let mut lookup_values = Vec::new();

            while let Some(row) = rows.next()? {
                lookup_values.push(LookupValue {
                    value: Self::value_ref_to_json(row.get_ref(0)?),
                    label: Self::value_ref_to_label(row.get_ref(1)?),
                });
            }

            Ok(lookup_values)
        })
        .await
    }

    fn current_database(&self) -> Option<String> {
        Some(self.file_path.clone())
    }

    fn driver_name(&self) -> &str {
        "DuckDB"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use uuid::Uuid;

    #[tokio::test]
    async fn duckdb_driver_smoke_test() -> Result<()> {
        let temp_path = std::env::temp_dir().join(format!("tabler-duckdb-{}.duckdb", Uuid::new_v4()));
        let temp_path_string = temp_path.to_string_lossy().to_string();
        let config = ConnectionConfig {
            id: Uuid::new_v4().to_string(),
            name: "DuckDB smoke".to_string(),
            db_type: DatabaseType::DuckDB,
            host: None,
            port: None,
            username: None,
            password: None,
            database: None,
            file_path: Some(temp_path_string.clone()),
            use_ssl: false,
            ssl_mode: None,
            ssl_ca_cert_path: None,
            ssl_client_cert_path: None,
            ssl_client_key_path: None,
            ssl_skip_host_verification: None,
            color: None,
            additional_fields: HashMap::new(),
            startup_commands: None,
        };

        {
            let driver = DuckDbDriver::connect(&config).await?;
            driver.ping().await?;
            driver
                .execute_query(
                    "\
                        CREATE TABLE items (id INTEGER PRIMARY KEY, name VARCHAR);
                        INSERT INTO items VALUES (1, 'alpha');
                    ",
                )
                .await?;

            let tables = driver.list_tables(None).await?;
            assert!(tables.iter().any(|table| table.name == "items"));

            let structure = driver.get_table_structure("items", None).await?;
            assert!(structure.columns.iter().any(|column| column.name == "id"));

            let rows = driver.get_table_data("items", None, 0, 10, None, None, None).await?;
            assert_eq!(rows.rows.len(), 1);
        }

        let _ = fs::remove_file(temp_path);
        Ok(())
    }
}
