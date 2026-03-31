use super::models::*;
use anyhow::Result;
use async_trait::async_trait;

/// Core database driver trait — mirrors TablePro's DatabaseDriver protocol.
/// All database operations go through this trait.
#[async_trait]
#[allow(dead_code)]
pub trait DatabaseDriver: Send + Sync {
    /// Test connectivity
    async fn ping(&self) -> Result<()>;

    /// Close the connection
    async fn disconnect(&self) -> Result<()>;

    /// List all databases
    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>>;

    /// List tables in the current/specified database
    async fn list_tables(&self, database: Option<&str>) -> Result<Vec<TableInfo>>;

    /// List schema-level objects such as views, triggers, and routines.
    async fn list_schema_objects(&self, database: Option<&str>) -> Result<Vec<SchemaObjectInfo>>;

    /// Get table structure (columns, indexes, foreign keys)
    async fn get_table_structure(
        &self,
        table: &str,
        database: Option<&str>,
    ) -> Result<TableStructure>;

    /// Get lightweight column metadata without loading the full structure payload.
    async fn get_table_columns_preview(
        &self,
        table: &str,
        database: Option<&str>,
    ) -> Result<Vec<ColumnDetail>> {
        Ok(self.get_table_structure(table, database).await?.columns)
    }

    /// Execute a raw SQL query and return results
    async fn execute_query(&self, sql: &str) -> Result<QueryResult>;

    /// Get rows from a table with pagination
    async fn get_table_data(
        &self,
        table: &str,
        database: Option<&str>,
        offset: u64,
        limit: u64,
        order_by: Option<&str>,
        order_dir: Option<&str>,
        filter: Option<&str>,
    ) -> Result<QueryResult>;

    /// Count rows in a table
    async fn count_rows(&self, table: &str, database: Option<&str>) -> Result<i64>;

    /// Count how many NULL values a specific column currently contains.
    async fn count_null_values(
        &self,
        table: &str,
        database: Option<&str>,
        column: &str,
    ) -> Result<i64>;

    /// Update a single cell in a table using a primary-key based row selector.
    async fn update_table_cell(&self, request: &TableCellUpdateRequest) -> Result<u64>;

    /// Delete one or more rows in a table using primary-key based row selectors.
    async fn delete_table_rows(&self, request: &TableRowDeleteRequest) -> Result<u64>;

    /// Insert a single new row into a table.
    async fn insert_table_row(&self, request: &TableRowInsertRequest) -> Result<u64>;

    /// Execute reviewed schema-change statements in the backend, sequentially.
    async fn execute_structure_statements(&self, statements: &[String]) -> Result<u64> {
        let mut total_affected = 0;
        for statement in statements {
            total_affected += self.execute_query(statement).await?.affected_rows;
        }
        Ok(total_affected)
    }

    /// Switch to a different database
    async fn use_database(&self, database: &str) -> Result<()>;

    /// Get lookup values for a FK reference: SELECT pk, display FROM table LIMIT n
    async fn get_foreign_key_lookup_values(
        &self,
        referenced_table: &str,
        referenced_column: &str,
        display_columns: &[&str],
        search: Option<&str>,
        limit: u32,
    ) -> Result<Vec<LookupValue>>;

    /// Get the current database name
    fn current_database(&self) -> Option<String>;

    /// Get the driver/database type name
    fn driver_name(&self) -> &str;
}
