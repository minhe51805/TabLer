use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DatabaseType {
    MySQL,
    PostgreSQL,
    SQLite,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionConfig {
    pub id: String,
    pub name: String,
    pub db_type: DatabaseType,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub database: Option<String>,
    /// For SQLite: path to the .db file
    pub file_path: Option<String>,
    pub use_ssl: bool,
    pub color: Option<String>,
}

#[allow(dead_code)]
impl ConnectionConfig {
    pub fn connection_url(&self) -> String {
        match self.db_type {
            DatabaseType::MySQL => {
                let host = self.host.as_deref().unwrap_or("127.0.0.1");
                let port = self.port.unwrap_or(3306);
                let user = self.username.as_deref().unwrap_or("root");
                let pass = self.password.as_deref().unwrap_or("");
                let db = self.database.as_deref().unwrap_or("");
                if db.is_empty() {
                    format!("mysql://{}:{}@{}:{}", user, pass, host, port)
                } else {
                    format!("mysql://{}:{}@{}:{}/{}", user, pass, host, port, db)
                }
            }
            DatabaseType::PostgreSQL => {
                let host = self.host.as_deref().unwrap_or("127.0.0.1");
                let port = self.port.unwrap_or(5432);
                let user = self.username.as_deref().unwrap_or("postgres");
                let pass = self.password.as_deref().unwrap_or("");
                let db = self.database.as_deref().unwrap_or("postgres");
                format!("postgres://{}:{}@{}:{}/{}", user, pass, host, port, db)
            }
            DatabaseType::SQLite => {
                let path = self.file_path.as_deref().unwrap_or(":memory:");
                format!("sqlite:{}", path)
            }
        }
    }

    pub fn default_port(&self) -> u16 {
        match self.db_type {
            DatabaseType::MySQL => 3306,
            DatabaseType::PostgreSQL => 5432,
            DatabaseType::SQLite => 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResult {
    pub columns: Vec<ColumnInfo>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub affected_rows: u64,
    pub execution_time_ms: u128,
    pub query: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub is_nullable: bool,
    pub is_primary_key: bool,
    pub max_length: Option<u32>,
    pub default_value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableInfo {
    pub name: String,
    pub schema: Option<String>,
    pub table_type: String,
    pub row_count: Option<i64>,
    pub engine: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseInfo {
    pub name: String,
    pub size: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableStructure {
    pub columns: Vec<ColumnDetail>,
    pub indexes: Vec<IndexInfo>,
    pub foreign_keys: Vec<ForeignKeyInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnDetail {
    pub name: String,
    pub data_type: String,
    pub is_nullable: bool,
    pub is_primary_key: bool,
    pub default_value: Option<String>,
    pub extra: Option<String>,
    pub column_type: Option<String>,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub is_unique: bool,
    pub index_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForeignKeyInfo {
    pub name: String,
    pub column: String,
    pub referenced_table: String,
    pub referenced_column: String,
    pub on_update: Option<String>,
    pub on_delete: Option<String>,
}
