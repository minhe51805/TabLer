use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RowKeyValue {
    pub column: String,
    pub value: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableCellUpdateRequest {
    pub table: String,
    pub database: Option<String>,
    pub target_column: String,
    pub value: serde_json::Value,
    pub primary_keys: Vec<RowKeyValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableRowDeleteRequest {
    pub table: String,
    pub database: Option<String>,
    pub rows: Vec<Vec<RowKeyValue>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableRowInsertRequest {
    pub table: String,
    pub database: Option<String>,
    /// Column names and values for the new row.
    pub values: Vec<(String, serde_json::Value)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvColumnMapping {
    pub source_index: usize,
    pub target_column: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvFileImportRequest {
    pub file_path: String,
    pub table: String,
    pub database: Option<String>,
    pub delimiter: String,
    pub has_headers: bool,
    pub mappings: Vec<CsvColumnMapping>,
}

pub type CsvImportRow = Result<TableRowInsertRequest, String>;