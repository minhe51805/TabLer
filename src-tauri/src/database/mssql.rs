use super::driver::DatabaseDriver;
use super::models::*;
use super::query_common::{statement_returns_rows, MAX_QUERY_RESULT_ROWS};
use super::safety::{
    normalize_order_dir, qualify_mssql_table_name, quote_mssql_identifier, quote_mssql_order_by,
    sanitize_mssql_filter_clause,
};
use crate::utils::sql::split_sql_statements;
use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Instant;
use tiberius::{
    AuthMethod, Client, ColumnData, Config, EncryptionLevel, Row,
};
use tokio::net::TcpStream;
use tokio::sync::{Mutex, RwLock};
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

type MssqlClient = Client<Compat<TcpStream>>;

pub struct MssqlDriver {
    client: Arc<Mutex<MssqlClient>>,
    current_db: Arc<RwLock<Option<String>>>,
}

impl MssqlDriver {
    pub async fn connect(config: &ConnectionConfig) -> Result<Self> {
        let host = config.host.as_deref().unwrap_or("127.0.0.1");
        let port = config.port.unwrap_or_else(|| config.default_port());
        let user = config
            .username
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .context("SQL Server username is required")?;
        let password = config.password.as_deref().unwrap_or("");
        let database = config.database.as_deref().unwrap_or("master");

        let mut tds = Config::new();
        tds.host(host);
        tds.port(port);
        tds.database(database);
        tds.authentication(AuthMethod::sql_server(user.to_string(), password.to_string()));
        tds.trust_cert();
        tds.encryption(if config.use_ssl {
            EncryptionLevel::Required
        } else {
            EncryptionLevel::Off
        });

        let tcp = TcpStream::connect(tds.get_addr()).await?;
        tcp.set_nodelay(true)?;
        let client = Client::connect(tds, tcp.compat_write()).await?;

        Ok(Self {
            client: Arc::new(Mutex::new(client)),
            current_db: Arc::new(RwLock::new(Some(database.to_string()))),
        })
    }

    fn split_schema_table(table: &str) -> (String, String) {
        if let Some((schema, name)) = table.split_once('.') {
            (schema.to_string(), name.to_string())
        } else {
            ("dbo".to_string(), table.to_string())
        }
    }

    fn qualify_table_name(table: &str, database: Option<&str>) -> Result<String> {
        let (schema, name) = Self::split_schema_table(table);
        if let Some(database) = database
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Ok(format!(
                "{}.{}.{}",
                quote_mssql_identifier(database)?,
                quote_mssql_identifier(&schema)?,
                quote_mssql_identifier(&name)?,
            ));
        }

        qualify_mssql_table_name(table, "dbo")
    }

    fn query_returns_rows(sql: &str) -> bool {
        statement_returns_rows(sql, &["SELECT", "WITH", "EXEC", "EXECUTE", "SHOW"])
    }

    fn current_database_name(&self, explicit: Option<&str>) -> String {
        explicit
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .or_else(|| self.current_db.blocking_read().clone())
            .unwrap_or_else(|| "master".to_string())
    }

    fn ms_cell_to_json(value: &ColumnData<'static>) -> serde_json::Value {
        match value {
            ColumnData::U8(Some(v)) => serde_json::Value::from(*v),
            ColumnData::I16(Some(v)) => serde_json::Value::from(*v),
            ColumnData::I32(Some(v)) => serde_json::Value::from(*v),
            ColumnData::I64(Some(v)) => serde_json::Value::from(*v),
            ColumnData::F32(Some(v)) => serde_json::Value::from(*v as f64),
            ColumnData::F64(Some(v)) => serde_json::Value::from(*v),
            ColumnData::Bit(Some(v)) => serde_json::Value::from(*v),
            ColumnData::Guid(Some(v)) => serde_json::Value::String(v.to_string()),
            ColumnData::String(Some(v)) => serde_json::Value::String(v.to_string()),
            ColumnData::Binary(Some(v)) => serde_json::Value::String(
                v.iter().map(|byte| format!("{byte:02x}")).collect::<String>(),
            ),
            ColumnData::Numeric(Some(v)) => serde_json::Value::String(v.to_string()),
            ColumnData::DateTime(Some(v)) => serde_json::Value::String(format!("{v:?}")),
            ColumnData::SmallDateTime(Some(v)) => serde_json::Value::String(format!("{v:?}")),
            ColumnData::Time(Some(v)) => serde_json::Value::String(format!("{v:?}")),
            ColumnData::Date(Some(v)) => serde_json::Value::String(format!("{v:?}")),
            ColumnData::DateTime2(Some(v)) => serde_json::Value::String(format!("{v:?}")),
            ColumnData::DateTimeOffset(Some(v)) => serde_json::Value::String(format!("{v:?}")),
            _ => serde_json::Value::Null,
        }
    }

    fn ms_column_type(value: &ColumnData<'static>) -> String {
        match value {
            ColumnData::U8(_) => "tinyint",
            ColumnData::I16(_) => "smallint",
            ColumnData::I32(_) => "int",
            ColumnData::I64(_) => "bigint",
            ColumnData::F32(_) => "real",
            ColumnData::F64(_) => "float",
            ColumnData::Bit(_) => "bit",
            ColumnData::Guid(_) => "uniqueidentifier",
            ColumnData::String(_) => "nvarchar",
            ColumnData::Binary(_) => "varbinary",
            ColumnData::Numeric(_) => "numeric",
            ColumnData::DateTime(_) => "datetime",
            ColumnData::SmallDateTime(_) => "smalldatetime",
            ColumnData::Time(_) => "time",
            ColumnData::Date(_) => "date",
            ColumnData::DateTime2(_) => "datetime2",
            ColumnData::DateTimeOffset(_) => "datetimeoffset",
            _ => "unknown",
        }
        .to_string()
    }

    fn row_value_string(row: &Row, index: usize) -> Option<String> {
        row.cells()
            .nth(index)
            .and_then(|(_, value)| match value {
                ColumnData::String(Some(v)) => Some(v.to_string()),
                ColumnData::Guid(Some(v)) => Some(v.to_string()),
                ColumnData::Numeric(Some(v)) => Some(v.to_string()),
                ColumnData::I16(Some(v)) => Some(v.to_string()),
                ColumnData::I32(Some(v)) => Some(v.to_string()),
                ColumnData::I64(Some(v)) => Some(v.to_string()),
                ColumnData::U8(Some(v)) => Some(v.to_string()),
                ColumnData::F32(Some(v)) => Some(v.to_string()),
                ColumnData::F64(Some(v)) => Some(v.to_string()),
                ColumnData::Bit(Some(v)) => Some(v.to_string()),
                _ => None,
            })
    }

    fn row_value_i64(row: &Row, index: usize) -> Option<i64> {
        row.cells()
            .nth(index)
            .and_then(|(_, value)| match value {
                ColumnData::I16(Some(v)) => Some((*v).into()),
                ColumnData::I32(Some(v)) => Some((*v).into()),
                ColumnData::I64(Some(v)) => Some(*v),
                ColumnData::U8(Some(v)) => Some((*v).into()),
                ColumnData::String(Some(v)) => v.parse::<i64>().ok(),
                _ => None,
            })
    }

    fn build_result_from_rows(
        rows: &[Row],
        elapsed: u128,
        query: String,
        affected_rows: u64,
        sandboxed: bool,
        truncated: bool,
    ) -> QueryResult {
        let columns = rows
            .first()
            .map(|first| {
                first
                    .cells()
                    .map(|(column, value)| ColumnInfo {
                        name: column.name().to_string(),
                        data_type: Self::ms_column_type(value),
                        is_nullable: true,
                        is_primary_key: false,
                        max_length: None,
                        default_value: None,
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        let result_rows = rows
            .iter()
            .map(|row| {
                row.cells()
                    .map(|(_, value)| Self::ms_cell_to_json(value))
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();

        QueryResult {
            columns,
            rows: result_rows,
            affected_rows,
            execution_time_ms: elapsed,
            query,
            sandboxed,
            truncated,
        }
    }

    async fn query_rows(&self, sql: &str) -> Result<(Vec<Row>, bool)> {
        let mut client = self.client.lock().await;
        let rows = client.simple_query(sql).await?.into_first_result().await?;
        let truncated = rows.len() > MAX_QUERY_RESULT_ROWS;
        Ok((
            rows.into_iter().take(MAX_QUERY_RESULT_ROWS).collect::<Vec<_>>(),
            truncated,
        ))
    }

    async fn execute_statement(&self, sql: &str) -> Result<u64> {
        let mut client = self.client.lock().await;
        let result = client.execute(sql, &[]).await?;
        Ok(result.total())
    }

    fn quote_literal(value: &serde_json::Value) -> Result<String> {
        Ok(match value {
            serde_json::Value::Null => "NULL".to_string(),
            serde_json::Value::Bool(v) => {
                if *v { "1".to_string() } else { "0".to_string() }
            }
            serde_json::Value::Number(v) => v.to_string(),
            serde_json::Value::String(v) => format!("N'{}'", v.replace('\'', "''")),
            other => format!("N'{}'", other.to_string().replace('\'', "''")),
        })
    }
}

#[async_trait]
impl DatabaseDriver for MssqlDriver {
    async fn ping(&self) -> Result<()> {
        let _ = self.query_rows("SELECT 1 AS ok").await?;
        Ok(())
    }

    async fn disconnect(&self) -> Result<()> {
        Ok(())
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        let (rows, _) = self
            .query_rows("SELECT name FROM sys.databases ORDER BY name")
            .await?;

        Ok(rows
            .iter()
            .filter_map(|row| Self::row_value_string(row, 0))
            .map(|name| DatabaseInfo { name, size: None })
            .collect())
    }

    async fn list_tables(&self, database: Option<&str>) -> Result<Vec<TableInfo>> {
        let db = self.current_database_name(database);
        let sql = format!(
            "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE \
             FROM [{}].INFORMATION_SCHEMA.TABLES \
             WHERE TABLE_TYPE IN ('BASE TABLE', 'VIEW') \
             ORDER BY TABLE_SCHEMA, TABLE_NAME",
            db.replace(']', "]]")
        );
        let (rows, _) = self.query_rows(&sql).await?;

        Ok(rows
            .iter()
            .map(|row| TableInfo {
                schema: Self::row_value_string(row, 0),
                name: Self::row_value_string(row, 1).unwrap_or_default(),
                table_type: Self::row_value_string(row, 2).unwrap_or_else(|| "TABLE".to_string()),
                row_count: None,
                engine: Some("SQL Server".to_string()),
            })
            .collect())
    }

    async fn list_schema_objects(&self, database: Option<&str>) -> Result<Vec<SchemaObjectInfo>> {
        let db = self.current_database_name(database);
        let sql = format!(
            "SELECT s.name AS schema_name, o.name, o.type_desc \
             FROM [{}].sys.objects o \
             JOIN [{}].sys.schemas s ON s.schema_id = o.schema_id \
             WHERE o.type IN ('V', 'TR', 'P', 'FN', 'TF', 'IF') \
             ORDER BY s.name, o.name",
            db.replace(']', "]]"),
            db.replace(']', "]]")
        );
        let (rows, _) = self.query_rows(&sql).await?;

        Ok(rows
            .iter()
            .map(|row| SchemaObjectInfo {
                schema: Self::row_value_string(row, 0),
                name: Self::row_value_string(row, 1).unwrap_or_default(),
                object_type: Self::row_value_string(row, 2).unwrap_or_else(|| "OBJECT".to_string()),
                related_table: None,
                definition: None,
            })
            .collect())
    }

    async fn get_table_structure(
        &self,
        table: &str,
        database: Option<&str>,
    ) -> Result<TableStructure> {
        let db = self.current_database_name(database);
        let (schema, name) = Self::split_schema_table(table);
        let db_name = db.replace(']', "]]");
        let schema_lit = schema.replace('\'', "''");
        let name_lit = name.replace('\'', "''");

        let columns_sql = format!(
            "SELECT c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT \
             FROM [{db_name}].INFORMATION_SCHEMA.COLUMNS c \
             WHERE c.TABLE_SCHEMA = N'{schema_lit}' AND c.TABLE_NAME = N'{name_lit}' \
             ORDER BY c.ORDINAL_POSITION"
        );
        let pk_sql = format!(
            "SELECT ku.COLUMN_NAME \
             FROM [{db_name}].INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc \
             JOIN [{db_name}].INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku \
               ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME \
              AND tc.TABLE_SCHEMA = ku.TABLE_SCHEMA \
              AND tc.TABLE_NAME = ku.TABLE_NAME \
             WHERE tc.TABLE_SCHEMA = N'{schema_lit}' \
               AND tc.TABLE_NAME = N'{name_lit}' \
               AND tc.CONSTRAINT_TYPE = 'PRIMARY KEY'"
        );

        let (column_rows, _) = self.query_rows(&columns_sql).await?;
        let (pk_rows, _) = self.query_rows(&pk_sql).await?;
        let primary_keys = pk_rows
            .iter()
            .filter_map(|row| Self::row_value_string(row, 0))
            .collect::<HashSet<_>>();

        let columns = column_rows
            .iter()
            .map(|row| {
                let column_name = Self::row_value_string(row, 0).unwrap_or_default();
                let nullable = Self::row_value_string(row, 2)
                    .map(|value| value.eq_ignore_ascii_case("YES"))
                    .unwrap_or(true);

                ColumnDetail {
                    name: column_name.clone(),
                    data_type: Self::row_value_string(row, 1).unwrap_or_else(|| "nvarchar".to_string()),
                    is_nullable: nullable,
                    is_primary_key: primary_keys.contains(&column_name),
                    default_value: Self::row_value_string(row, 3),
                    extra: None,
                    column_type: None,
                    comment: None,
                }
            })
            .collect::<Vec<_>>();

        Ok(TableStructure {
            columns,
            indexes: Vec::new(),
            foreign_keys: Vec::new(),
            triggers: Vec::new(),
            view_definition: None,
            object_type: Some("table".to_string()),
        })
    }

    async fn execute_query(&self, sql: &str) -> Result<QueryResult> {
        let start = Instant::now();
        let statements = split_sql_statements(sql);
        let mut total_affected = 0u64;
        let mut last_result = None;

        for statement in statements.iter().filter(|statement| !statement.trim().is_empty()) {
            if Self::query_returns_rows(statement) {
                let (rows, truncated) = self.query_rows(statement).await?;
                last_result = Some(Self::build_result_from_rows(
                    &rows,
                    0,
                    sql.to_string(),
                    total_affected,
                    false,
                    truncated,
                ));
            } else {
                total_affected += self.execute_statement(statement).await?;
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
        database: Option<&str>,
        offset: u64,
        limit: u64,
        order_by: Option<&str>,
        order_dir: Option<&str>,
        filter: Option<&str>,
    ) -> Result<QueryResult> {
        let mut sql = format!(
            "SELECT * FROM {}",
            Self::qualify_table_name(table, database)?
        );

        if let Some(filter_clause) = sanitize_mssql_filter_clause(filter)? {
            sql.push_str(&format!(" WHERE {filter_clause}"));
        }

        let order_expr = if let Some(order_by) = order_by {
            let direction = normalize_order_dir(order_dir)?;
            format!("{} {}", quote_mssql_order_by(order_by)?, direction)
        } else {
            "(SELECT NULL)".to_string()
        };

        sql.push_str(&format!(
            " ORDER BY {order_expr} OFFSET {offset} ROWS FETCH NEXT {limit} ROWS ONLY"
        ));

        self.execute_query(&sql).await
    }

    async fn count_rows(&self, table: &str, _database: Option<&str>) -> Result<i64> {
        let sql = format!("SELECT COUNT(*) AS count FROM {}", Self::qualify_table_name(table, _database)?);
        let (rows, _) = self.query_rows(&sql).await?;
        rows.first()
            .and_then(|row| Self::row_value_i64(row, 0))
            .ok_or_else(|| anyhow!("SQL Server count query returned no rows"))
    }

    async fn count_null_values(
        &self,
        table: &str,
        database: Option<&str>,
        column: &str,
    ) -> Result<i64> {
        let sql = format!(
            "SELECT COUNT(*) AS count FROM {} WHERE {} IS NULL",
            Self::qualify_table_name(table, database)?,
            quote_mssql_order_by(column)?,
        );
        let (rows, _) = self.query_rows(&sql).await?;
        rows.first()
            .and_then(|row| Self::row_value_i64(row, 0))
            .ok_or_else(|| anyhow!("SQL Server null-count query returned no rows"))
    }

    async fn update_table_cell(&self, request: &TableCellUpdateRequest) -> Result<u64> {
        if request.primary_keys.is_empty() {
            return Err(anyhow!("Inline update requires at least one primary key column"));
        }

        let mut where_clause = String::new();
        for (index, primary_key) in request.primary_keys.iter().enumerate() {
            if index > 0 {
                where_clause.push_str(" AND ");
            }

            where_clause.push_str(&quote_mssql_order_by(&primary_key.column)?);
            if primary_key.value.is_null() {
                where_clause.push_str(" IS NULL");
            } else {
                where_clause.push_str(" = ");
                where_clause.push_str(&Self::quote_literal(&primary_key.value)?);
            }
        }

        let sql = format!(
            "UPDATE {} SET {} = {} WHERE {}",
            Self::qualify_table_name(&request.table, request.database.as_deref())?,
            quote_mssql_order_by(&request.target_column)?,
            Self::quote_literal(&request.value)?,
            where_clause
        );

        self.execute_statement(&sql).await
    }

    async fn delete_table_rows(&self, request: &TableRowDeleteRequest) -> Result<u64> {
        if request.rows.is_empty() {
            return Err(anyhow!("Deleting rows requires at least one selected row"));
        }

        let mut predicates = Vec::new();
        for row in &request.rows {
            if row.is_empty() {
                continue;
            }

            let mut parts = Vec::new();
            for key in row {
                if key.value.is_null() {
                    parts.push(format!("{} IS NULL", quote_mssql_order_by(&key.column)?));
                } else {
                    parts.push(format!(
                        "{} = {}",
                        quote_mssql_order_by(&key.column)?,
                        Self::quote_literal(&key.value)?,
                    ));
                }
            }

            if !parts.is_empty() {
                predicates.push(format!("({})", parts.join(" AND ")));
            }
        }

        if predicates.is_empty() {
            return Err(anyhow!("Deleting rows requires at least one valid row predicate"));
        }

        let sql = format!(
            "DELETE FROM {} WHERE {}",
            Self::qualify_table_name(&request.table, request.database.as_deref())?,
            predicates.join(" OR "),
        );

        self.execute_statement(&sql).await
    }

    async fn use_database(&self, database: &str) -> Result<()> {
        let sql = format!("USE {}", super::safety::quote_mssql_identifier(database)?);
        self.execute_statement(&sql).await?;
        *self.current_db.write().await = Some(database.to_string());
        Ok(())
    }

    fn current_database(&self) -> Option<String> {
        self.current_db.blocking_read().clone()
    }

    async fn insert_table_row(&self, request: &TableRowInsertRequest) -> Result<u64> {
        if request.values.is_empty() {
            return Err(anyhow!("Insert requires at least one column value"));
        }

        let mut cols = Vec::new();
        let mut vals = Vec::new();
        for (col, value) in &request.values {
            cols.push(quote_mssql_identifier(col)?.to_string());
            vals.push(Self::quote_literal(value)?.to_string());
        }

        let sql = format!(
            "INSERT INTO {} ({}) VALUES ({})",
            Self::qualify_table_name(&request.table, request.database.as_deref())?,
            cols.join(", "),
            vals.join(", "),
        );

        self.execute_statement(&sql).await
    }

    fn driver_name(&self) -> &str {
        "SQL Server"
    }

    async fn get_foreign_key_lookup_values(
        &self,
        referenced_table: &str,
        referenced_column: &str,
        display_columns: &[&str],
        search: Option<&str>,
        limit: u32,
    ) -> Result<Vec<LookupValue>> {
        let table_quoted = qualify_mssql_table_name(referenced_table, "dbo")?;
        let col_quoted = quote_mssql_identifier(referenced_column)?;

        let label_expr = if !display_columns.is_empty() {
            let cols = display_columns
                .iter()
                .map(|c| quote_mssql_identifier(c).unwrap_or_else(|_| c.to_string()))
                .collect::<Vec<_>>()
                .join(", ");
            format!("COALESCE({})", cols)
        } else {
            col_quoted.clone()
        };

        let sql = if let Some(search_term) = search {
            format!(
                "SELECT TOP {} {} AS value, {} AS label \
                 FROM {} \
                 WHERE CAST({} AS NVARCHAR) LIKE '%{}%' \
                 ORDER BY {}",
                limit,
                col_quoted,
                label_expr,
                table_quoted,
                col_quoted,
                search_term.replace('\'', "''"),
                col_quoted
            )
        } else {
            format!(
                "SELECT TOP {} {} AS value, {} AS label \
                 FROM {} \
                 ORDER BY {}",
                limit,
                col_quoted,
                label_expr,
                table_quoted,
                col_quoted
            )
        };

        let (rows, _truncated) = self.query_rows(&sql).await?;
        let mut values = Vec::with_capacity(rows.len());
        for row in rows {
            let cells: Vec<ColumnData<'static>> = row.into_iter().collect();
            if cells.len() >= 2 {
                let json_value = Self::ms_cell_to_json(&cells[0]);
                let json_label = Self::ms_cell_to_json(&cells[1]);
                let label_str = json_label.as_str().map(String::from).unwrap_or_else(|| json_label.to_string());
                values.push(LookupValue { value: json_value, label: label_str });
            }
        }
        Ok(values)
    }
}
