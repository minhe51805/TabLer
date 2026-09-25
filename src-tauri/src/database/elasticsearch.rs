use super::driver::DatabaseDriver;
use super::models::*;
use super::opensearch::{OpenSearchDriver, SearchProduct};
use anyhow::{anyhow, Result};
use async_trait::async_trait;
use futures_util::Stream;
use std::pin::Pin;

/// Elasticsearch engine entry. Elasticsearch 7.x/8.x and OpenSearch share the
/// fork-era REST surface this crate's HTTP transport exercises — `_search`,
/// `_mapping`, `_cat`, `_update`, `_tasks`, scroll — so the driver reuses
/// `OpenSearchDriver` wholesale and only adds the product label and an
/// identity check on connect.
///
/// The check is asymmetric on purpose: a positive OpenSearch signal
/// (`version.distribution: "opensearch"`) hard-fails because security and
/// plugin endpoints diverge, while the official `X-Elastic-Product:
/// Elasticsearch` header is only warned about when absent or different —
/// Elasticsearch 7.14+ sends it, but older minors, proxies, and forks do not.
pub struct ElasticsearchDriver {
    inner: OpenSearchDriver,
}

impl ElasticsearchDriver {
    pub async fn connect(config: &ConnectionConfig, plugin_id: String) -> Result<Self> {
        let inner =
            OpenSearchDriver::connect_with_product(config, plugin_id, SearchProduct::Elasticsearch)
                .await?;
        let (product_header, body) = inner.server_identity().await?;
        let distribution = body
            .pointer("/version/distribution")
            .and_then(|value| value.as_str());
        if distribution == Some("opensearch") {
            return Err(anyhow!(
                "The endpoint at {} reports OpenSearch, not Elasticsearch — connect with the OpenSearch engine instead.",
                config.host.as_deref().unwrap_or("<host>")
            ));
        }
        match product_header.as_deref() {
            Some("Elasticsearch") => {}
            Some(other) => log::warn!(
                "Elasticsearch endpoint returned an unexpected X-Elastic-Product header: {other}"
            ),
            None => {
                let version = body
                    .pointer("/version/number")
                    .and_then(|value| value.as_str())
                    .unwrap_or("unknown");
                log::warn!(
                    "Elasticsearch endpoint did not send X-Elastic-Product (version {version}); proceeding — pre-7.14 servers and proxies do not stamp it"
                );
            }
        }
        Ok(Self { inner })
    }
}

#[async_trait]
impl DatabaseDriver for ElasticsearchDriver {
    async fn ping(&self) -> Result<()> {
        self.inner.ping().await
    }

    async fn disconnect(&self) -> Result<()> {
        self.inner.disconnect().await
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        self.inner.list_databases().await
    }

    async fn list_tables(&self, database: Option<&str>) -> Result<Vec<TableInfo>> {
        self.inner.list_tables(database).await
    }

    async fn list_schema_objects(&self, database: Option<&str>) -> Result<Vec<SchemaObjectInfo>> {
        self.inner.list_schema_objects(database).await
    }

    async fn get_table_structure(
        &self,
        table: &str,
        database: Option<&str>,
    ) -> Result<TableStructure> {
        self.inner.get_table_structure(table, database).await
    }

    async fn get_table_columns_preview(
        &self,
        table: &str,
        database: Option<&str>,
    ) -> Result<Vec<ColumnDetail>> {
        self.inner.get_table_columns_preview(table, database).await
    }

    async fn execute_query(&self, sql: &str) -> Result<QueryResult> {
        self.inner.execute_query(sql).await
    }

    async fn execute_query_for_request(&self, request_id: &str, sql: &str) -> Result<QueryResult> {
        self.inner.execute_query_for_request(request_id, sql).await
    }

    async fn cancel_query_request(&self, request_id: &str) -> Result<bool> {
        self.inner.cancel_query_request(request_id).await
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
        self.inner
            .get_table_data(table, database, offset, limit, order_by, order_dir, filter)
            .await
    }

    fn export_table_rows<'a>(
        &'a self,
        table: &'a str,
        database: Option<&'a str>,
        batch_size: u64,
        order_by: Option<&'a str>,
        order_dir: Option<&'a str>,
        filter: Option<&'a str>,
    ) -> Pin<Box<dyn Stream<Item = Result<QueryResult>> + Send + 'a>> {
        self.inner
            .export_table_rows(table, database, batch_size, order_by, order_dir, filter)
    }

    async fn count_rows(&self, table: &str, database: Option<&str>) -> Result<i64> {
        self.inner.count_rows(table, database).await
    }

    async fn count_null_values(
        &self,
        table: &str,
        database: Option<&str>,
        column: &str,
    ) -> Result<i64> {
        self.inner.count_null_values(table, database, column).await
    }

    async fn update_table_cell(&self, request: &TableCellUpdateRequest) -> Result<u64> {
        self.inner.update_table_cell(request).await
    }

    async fn delete_table_rows(&self, request: &TableRowDeleteRequest) -> Result<u64> {
        self.inner.delete_table_rows(request).await
    }

    async fn insert_table_row(&self, request: &TableRowInsertRequest) -> Result<u64> {
        self.inner.insert_table_row(request).await
    }

    async fn use_database(&self, database: &str) -> Result<()> {
        self.inner.use_database(database).await
    }

    async fn get_foreign_key_lookup_values(
        &self,
        referenced_table: &str,
        referenced_column: &str,
        display_columns: &[&str],
        search: Option<&str>,
        limit: u32,
    ) -> Result<Vec<LookupValue>> {
        self.inner
            .get_foreign_key_lookup_values(
                referenced_table,
                referenced_column,
                display_columns,
                search,
                limit,
            )
            .await
    }

    fn current_database(&self) -> Option<String> {
        self.inner.current_database()
    }

    fn driver_name(&self) -> &str {
        self.inner.driver_name()
    }

    /// Downcasts to `ElasticsearchDriver` — not `OpenSearchDriver` — so the
    /// OpenSearch-only security-plugin admin surface can never run against an
    /// Elasticsearch endpoint (`/_plugins/_security` does not exist there).
    fn as_any(&self) -> Option<&dyn std::any::Any> {
        Some(self)
    }
}
