use super::MssqlDriver;
use crate::database::driver::DatabaseDriver;
use crate::database::models::*;
use crate::database::query_common::METADATA_QUERY_ROW_LIMIT;
use crate::database::safety::{
    normalize_order_dir, qualify_mssql_table_name, quote_mssql_identifier, quote_mssql_order_by,
    sanitize_mssql_filter_clause,
};
use crate::utils::sql::split_sql_statements;
use anyhow::{anyhow, Result};
use async_trait::async_trait;
use std::collections::HashSet;
use std::time::Instant;
use tiberius::{ColumnData, Query as TiberiusQuery};

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
            "SELECT s.name AS schema_name, o.name, \
                    CASE WHEN o.type = 'V' THEN N'VIEW' ELSE N'BASE TABLE' END, \
                    CONVERT(varchar(10), o.create_date, 120) \
             FROM [{}].sys.all_objects o \
             JOIN [{}].sys.schemas s ON s.schema_id = o.schema_id \
             WHERE o.type IN ('U', 'V') \
             ORDER BY schema_name, name",
            db.replace(']', "]]"),
            db.replace(']', "]]"),
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
                create_date: Self::row_value_string(row, 3),
            })
            .collect())
    }

    async fn list_schema_objects(&self, database: Option<&str>) -> Result<Vec<SchemaObjectInfo>> {
        let db = self.current_database_name(database);
        // SSMS-parity coverage: views, triggers (DML), stored procedures
        // (incl. CLR), all function kinds, synonyms, sequences, database-level
        // (DDL) triggers, assemblies, rules, standalone defaults, data types
        // (system categories / user-defined / table types / CLR) and XML
        // schema collections. System objects (is_ms_shipped = 1) are included
        // on purpose — they surface under the `sys` schema section in the
        // explorer, mirroring SSMS.
        let sql = format!(
            "SELECT s.name AS schema_name, o.name, \
                    CASE WHEN o.type = 'D' THEN N'DEFAULT' ELSE o.type_desc END, \
                    CONVERT(varchar(10), o.create_date, 120) \
             FROM [{}].sys.all_objects o \
             JOIN [{}].sys.schemas s ON s.schema_id = o.schema_id \
             LEFT JOIN [{}].sys.triggers tt ON tt.object_id = o.object_id \
             WHERE o.type IN ('V', 'TR', 'P', 'FN', 'TF', 'IF', 'SN', 'AF', 'PC', 'FS', 'FT', 'R', 'D') \
               AND (o.type <> 'TR' OR tt.parent_class <> 0) \
             UNION ALL \
             SELECT s.name AS schema_name, t.name, N'DATABASE_TRIGGER', \
                    CONVERT(varchar(10), o.create_date, 120) \
             FROM [{}].sys.triggers t \
             JOIN [{}].sys.objects o ON o.object_id = t.object_id \
             JOIN [{}].sys.schemas s ON s.schema_id = o.schema_id \
             WHERE t.parent_class = 0 \
             UNION ALL \
             SELECT N'sys' AS schema_name, a.name, N'ASSEMBLY', CAST(NULL AS nvarchar(10)) \
             FROM [{}].sys.assemblies a \
             UNION ALL \
             SELECT s.name AS schema_name, t.name, \
                    CASE \
                      WHEN t.is_user_defined = 0 THEN \
                        CASE \
                          WHEN t.name IN (N'bigint', N'int', N'smallint', N'tinyint', N'bit', \
                                          N'decimal', N'numeric', N'money', N'smallmoney') \
                            THEN N'SYSTEM_EXACT_NUMERIC' \
                          WHEN t.name IN (N'float', N'real') \
                            THEN N'SYSTEM_APPROXIMATE_NUMERIC' \
                          WHEN t.name IN (N'date', N'datetime2', N'datetime', N'smalldatetime', \
                                          N'time', N'datetimeoffset') \
                            THEN N'SYSTEM_DATE_TIME' \
                          WHEN t.name IN (N'char', N'varchar', N'text') \
                            THEN N'SYSTEM_CHARACTER_STRING' \
                          WHEN t.name IN (N'nchar', N'nvarchar', N'ntext') \
                            THEN N'SYSTEM_UNICODE_CHARACTER_STRING' \
                          WHEN t.name IN (N'binary', N'varbinary', N'image') \
                            THEN N'SYSTEM_BINARY_STRING' \
                          WHEN t.name IN (N'geography', N'geometry') \
                            THEN N'SYSTEM_SPATIAL_DATA_TYPE' \
                          WHEN t.is_assembly_type = 1 THEN N'SYSTEM_CLR_DATA_TYPE' \
                          ELSE N'SYSTEM_OTHER_DATA_TYPE' \
                        END \
                      WHEN t.is_table_type = 1 THEN N'USER_TABLE_TYPE' \
                      WHEN t.is_assembly_type = 1 THEN N'USER_CLR_TYPE' \
                      ELSE N'USER_DEFINED_TYPE' \
                    END, CAST(NULL AS nvarchar(10)) \
             FROM [{}].sys.types t \
             JOIN [{}].sys.schemas s ON s.schema_id = t.schema_id \
             UNION ALL \
             SELECT s.name AS schema_name, q.name, N'SEQUENCE', \
                    CONVERT(varchar(10), q.create_date, 120) \
             FROM [{}].sys.sequences q \
             JOIN [{}].sys.schemas s ON s.schema_id = q.schema_id \
             UNION ALL \
             SELECT s.name AS schema_name, x.name, N'XML_SCHEMA_COLLECTION', \
                    CONVERT(varchar(10), x.create_date, 120) \
             FROM [{}].sys.xml_schema_collections x \
             JOIN [{}].sys.schemas s ON s.schema_id = x.schema_id \
             ORDER BY schema_name, name",
            db.replace(']', "]]"),
            db.replace(']', "]]"),
            db.replace(']', "]]"),
            db.replace(']', "]]"),
            db.replace(']', "]]"),
            db.replace(']', "]]"),
            db.replace(']', "]]"),
            db.replace(']', "]]"),
            db.replace(']', "]]"),
            db.replace(']', "]]"),
            db.replace(']', "]]"),
            db.replace(']', "]]"),
            db.replace(']', "]]"),
        );
        let (rows, _) = self
            .query_rows_with_limit(&sql, METADATA_QUERY_ROW_LIMIT)
            .await?;

        Ok(rows
            .iter()
            .map(|row| SchemaObjectInfo {
                schema: Self::row_value_string(row, 0),
                name: Self::row_value_string(row, 1).unwrap_or_default(),
                object_type: Self::row_value_string(row, 2).unwrap_or_else(|| "OBJECT".to_string()),
                related_table: None,
                definition: None,
                create_date: Self::row_value_string(row, 3),
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
                    data_type: Self::row_value_string(row, 1)
                        .unwrap_or_else(|| "nvarchar".to_string()),
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

        for statement in statements
            .iter()
            .filter(|statement| !statement.trim().is_empty())
        {
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

    /// Checkpoint restore, atomic: every statement runs inside one explicit
    /// transaction on the driver's single client connection, so a failure at
    /// any point rolls the database back to its pre-restore state. SQL Server
    /// (unlike MySQL) supports transactional DDL, which makes the
    /// drop-recreate dump pipeline safe to abort mid-flight.
    async fn execute_restore_statements(&self, statements: &[String]) -> Result<u64> {
        let mut client = self.acquire_client().await?;
        TiberiusQuery::new("BEGIN TRANSACTION;")
            .execute(&mut *client)
            .await?;

        let mut total_affected = 0u64;
        for statement in statements
            .iter()
            .filter(|statement| !statement.trim().is_empty())
        {
            let query = TiberiusQuery::new(statement);
            match query.execute(&mut *client).await {
                Ok(result) => total_affected += result.total(),
                Err(error) => {
                    // Undo everything executed so far: the restore either
                    // completes fully or not at all.
                    let rollback_result = TiberiusQuery::new("ROLLBACK TRANSACTION;")
                        .execute(&mut *client)
                        .await;
                    let snippet: String = statement.chars().take(80).collect();
                    return match rollback_result {
                        Ok(_) => Err(anyhow!(
                            "Restore failed and was rolled back to the pre-restore state. Offending statement: {snippet} ({error})"
                        )),
                        Err(rollback_error) => {
                            self.poison_connection(&format!(
                                "restore rollback failed: {rollback_error}"
                            ));
                            Err(anyhow!(
                                "Restore failed at '{snippet}' ({error}) AND the automatic rollback also failed ({rollback_error}). The connection is poisoned and requires a reconnect before any further statement."
                            ))
                        }
                    };
                }
            }
        }

        if let Err(error) = TiberiusQuery::new("COMMIT TRANSACTION;")
            .execute(&mut *client)
            .await
        {
            // A failed COMMIT usually aborts the transaction server-side; try
            // to unwind, and poison the connection if even ROLLBACK refuses.
            if TiberiusQuery::new("ROLLBACK TRANSACTION;")
                .execute(&mut *client)
                .await
                .is_err()
            {
                self.poison_connection("restore commit failed and rollback refused");
            }
            return Err(anyhow!("Restore commit failed: {error}"));
        }
        Ok(total_affected)
    }

    async fn execute_parameterized_query(
        &self,
        sql: &str,
        parameters: &[QueryParameter],
    ) -> Result<QueryResult> {
        let start = Instant::now();
        if Self::query_returns_rows(sql) {
            let (rows, truncated) = self.query_parameterized_rows(sql, parameters).await?;
            let mut result =
                Self::build_result_from_rows(&rows, 0, sql.to_string(), 0, false, truncated);
            result.execution_time_ms = start.elapsed().as_millis();
            return Ok(result);
        }
        let affected_rows = self
            .execute_parameterized_statement(sql, parameters)
            .await?;
        Ok(QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            affected_rows,
            execution_time_ms: start.elapsed().as_millis(),
            query: sql.to_string(),
            sandboxed: false,
            truncated: false,
        })
    }

    /// True write preview: every statement runs inside one explicit
    /// BEGIN/ROLLBACK pair pinned to the driver's single client, so partial
    /// work is always discarded (same contract as the Postgres driver).
    async fn preview_write_transaction(&self, statements: &[String]) -> Result<Vec<QueryResult>> {
        let mut client = self.acquire_client().await?;
        // BEGIN/ROLLBACK must go as plain batches: sent via the prepared-RPC
        // path they run inside a nested scope and SQL Server raises 266
        // (transaction-count mismatch) when that scope exits.
        client.simple_query("BEGIN TRANSACTION").await?;
        let execution = async {
            let mut results = Vec::new();
            for statement in statements {
                let statement_start = Instant::now();
                if Self::query_returns_rows(statement) {
                    let rows = client
                        .simple_query(statement)
                        .await?
                        .into_first_result()
                        .await?;
                    let mut result =
                        Self::build_result_from_rows(&rows, 0, statement.clone(), 0, false, false);
                    result.execution_time_ms = statement_start.elapsed().as_millis();
                    results.push(result);
                } else {
                    let affected = TiberiusQuery::new(statement)
                        .execute(&mut *client)
                        .await?
                        .total();
                    results.push(QueryResult {
                        columns: Vec::new(),
                        rows: Vec::new(),
                        affected_rows: affected,
                        execution_time_ms: statement_start.elapsed().as_millis(),
                        query: statement.clone(),
                        sandboxed: true,
                        truncated: false,
                    });
                }
            }
            Ok::<_, anyhow::Error>(results)
        }
        .await;

        if let Err(rollback_error) = client.simple_query("ROLLBACK TRANSACTION").await {
            self.poison_connection(&format!("write-preview rollback failed: {rollback_error}"));
            log::warn!("write-preview rollback failed: {rollback_error}");
        }
        let results = execution?;
        Ok(results)
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

        let fetch_limit = limit.clamp(1, crate::database::query_common::MAX_TABLE_PAGE_ROWS);

        sql.push_str(&format!(
            " ORDER BY {order_expr} OFFSET {offset} ROWS FETCH NEXT {fetch_limit} ROWS ONLY"
        ));

        // Page through query_rows_with_limit: execute_query caps results at
        // MAX_QUERY_RESULT_ROWS, which silently truncated paged fetches
        // beyond 500 rows (exports batch in 1000s).
        let start = Instant::now();
        let (rows, truncated) = self
            .query_rows_with_limit(&sql, fetch_limit as usize)
            .await?;
        let mut result = Self::build_result_from_rows(
            &rows,
            start.elapsed().as_millis(),
            sql,
            0,
            false,
            truncated || limit > fetch_limit,
        );
        result.execution_time_ms = start.elapsed().as_millis();
        Ok(result)
    }

    async fn count_rows(&self, table: &str, _database: Option<&str>) -> Result<i64> {
        let sql = format!(
            "SELECT COUNT(*) AS count FROM {}",
            Self::qualify_table_name(table, _database)?
        );
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

        self.execute_bound(&sql, &values).await
    }

    async fn delete_table_rows(&self, request: &TableRowDeleteRequest) -> Result<u64> {
        if request.rows.is_empty() {
            return Err(anyhow!("Deleting rows requires at least one selected row"));
        }

        let mut values = Vec::new();
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
                    values.push(key.value.clone());
                    parts.push(format!(
                        "{} = @P{}",
                        quote_mssql_order_by(&key.column)?,
                        values.len(),
                    ));
                }
            }

            if !parts.is_empty() {
                predicates.push(format!("({})", parts.join(" AND ")));
            }
        }

        if predicates.is_empty() {
            return Err(anyhow!(
                "Deleting rows requires at least one valid row predicate"
            ));
        }

        let sql = format!(
            "DELETE FROM {} WHERE {}",
            Self::qualify_table_name(&request.table, request.database.as_deref())?,
            predicates.join(" OR "),
        );

        self.execute_bound(&sql, &values).await
    }

    async fn use_database(&self, database: &str) -> Result<()> {
        let sql = format!(
            "USE {}",
            crate::database::safety::quote_mssql_identifier(database)?
        );
        self.execute_statement(&sql).await?;
        *self.current_db.write().unwrap() = Some(database.to_string());
        Ok(())
    }

    fn current_database(&self) -> Option<String> {
        self.current_db.read().unwrap().clone()
    }

    async fn insert_table_row(&self, request: &TableRowInsertRequest) -> Result<u64> {
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

        self.execute_bound(&sql, &values).await
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
                limit, col_quoted, label_expr, table_quoted, col_quoted
            )
        };

        let (rows, _truncated) = self.query_rows(&sql).await?;
        let mut values = Vec::with_capacity(rows.len());
        for row in rows {
            let cells: Vec<ColumnData<'static>> = row.into_iter().collect();
            if cells.len() >= 2 {
                let json_value = Self::ms_cell_to_json(&cells[0]);
                let json_label = Self::ms_cell_to_json(&cells[1]);
                let label_str = json_label
                    .as_str()
                    .map(String::from)
                    .unwrap_or_else(|| json_label.to_string());
                values.push(LookupValue {
                    value: json_value,
                    label: label_str,
                });
            }
        }
        Ok(values)
    }
}
