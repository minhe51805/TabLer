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

    /// Execute a raw SQL query and return results
    async fn execute_query(&self, sql: &str) -> Result<QueryResult>;

    /// Execute statements inside an isolated transaction and always roll them back.
    async fn execute_sandboxed(&self, statements: &[String]) -> Result<QueryResult>;

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

    /// Update a single cell in a table using a primary-key based row selector.
    async fn update_table_cell(&self, request: &TableCellUpdateRequest) -> Result<u64>;

    /// Delete one or more rows in a table using primary-key based row selectors.
    async fn delete_table_rows(&self, request: &TableRowDeleteRequest) -> Result<u64>;

    /// Switch to a different database
    async fn use_database(&self, database: &str) -> Result<()>;

    /// Get the current database name
    fn current_database(&self) -> Option<String>;

    /// Get the driver/database type name
    fn driver_name(&self) -> &str;
}
