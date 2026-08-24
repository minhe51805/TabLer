use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResult {
    pub columns: Vec<ColumnInfo>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub affected_rows: u64,
    pub execution_time_ms: u128,
    pub query: String,
    pub sandboxed: bool,
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum QueryParameterType {
    #[default]
    Text,
    Integer,
    Decimal,
    Boolean,
    Json,
    Null,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryParameter {
    pub name: String,
    pub value: serde_json::Value,
    #[serde(default)]
    pub data_type: QueryParameterType,
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