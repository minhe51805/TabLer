use super::driver::DatabaseDriver;
use super::models::*;
use super::query_common::{statement_returns_rows, MAX_QUERY_RESULT_ROWS};
use super::safety::{
    normalize_order_dir, quote_snowflake_identifier, quote_snowflake_order_by,
    sanitize_snowflake_filter_clause,
};
use super::snowflake_support::{
    SnowflakeStatementContext, SnowflakeStatementParameters, SnowflakeStatementRequest,
};
use crate::utils::sql::split_sql_statements;
use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use reqwest::Client;
use serde_json::Value as JsonValue;
use std::collections::HashSet;
use std::sync::Arc;
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
    use super::SnowflakeDriver;
    use serde_json::json;

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
}
