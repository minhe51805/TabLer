use super::bigquery_support::BigQueryDatasetListResponse;
use super::driver::DatabaseDriver;
use super::models::*;
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
use std::sync::Arc;
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
        BigQueryTableCell, BigQueryTableFieldSchema, BigQueryTableRow,
    };
    use super::BigQueryDriver;
    use serde_json::json;

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
}
