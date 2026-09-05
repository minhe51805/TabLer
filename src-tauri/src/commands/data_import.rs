//! CSV data import (roadmap Phase 2B).
//!
//! `preview_import_csv` sniffs the delimiter, reads the header and a sample of
//! rows. `import_csv` inserts rows in bounded batches using prepared
//! parameters — cell values are never spliced into the SQL text.

use crate::database::manager::DatabaseManager;
use crate::database::models::{DatabaseType, QueryParameter, QueryParameterType};
use crate::database::parameterized_query::{
    compile_parameterized_query, placeholder_style_for_database,
};
use csv::StringRecord;
use serde::{Deserialize, Serialize};
use std::io::Read;
use tauri::State;

const MAX_IMPORT_FILE_BYTES: u64 = 100 * 1024 * 1024;
const DEFAULT_BATCH_SIZE: usize = 200;
const DEFAULT_SAMPLE_ROWS: usize = 20;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvPreview {
    pub file_name: String,
    /// Absolute path so `import_csv` can re-read the same file.
    pub file_path: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub total_rows: usize,
    pub delimiter: char,
}

/// Picks the most frequent candidate delimiter from a raw file prefix.
pub fn detect_delimiter(prefix: &str) -> u8 {
    let mut counts = [0usize; 3]; // ',' ';' '\t'
    let mut in_quotes = false;
    let mut escaped = false;
    for ch in prefix.chars() {
        if escaped {
            escaped = false;
            continue;
        }
        match ch {
            '"' => in_quotes = !in_quotes,
            '\\' => escaped = true,
            _ if in_quotes => {}
            ',' => counts[0] += 1,
            ';' => counts[1] += 1,
            '\t' => counts[2] += 1,
            _ => {}
        }
        if ch == '\n' {
            in_quotes = false;
        }
    }
    let (best_index, _) = counts
        .iter()
        .enumerate()
        .max_by_key(|(_, count)| **count)
        .unwrap();
    [b',', b';', b'\t'][best_index]
}

fn read_records(path: &std::path::Path, delimiter: u8) -> Result<Vec<StringRecord>, String> {
    let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_IMPORT_FILE_BYTES {
        return Err(format!(
            "File is larger than the {} MB import limit.",
            MAX_IMPORT_FILE_BYTES / (1024 * 1024)
        ));
    }
    let mut file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut text = String::new();
    file.read_to_string(&mut text)
        .map_err(|error| error.to_string())?;

    let mut reader = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .has_headers(false)
        .flexible(true)
        .from_reader(text.as_bytes());
    let mut records = Vec::new();
    for record in reader.records() {
        records.push(record.map_err(|error| format!("CSV parse error: {error}"))?);
    }
    Ok(records)
}

#[tauri::command]
pub async fn preview_import_csv(sample_rows: Option<usize>) -> Result<CsvPreview, String> {
    let path = rfd::FileDialog::new()
        .add_filter("CSV files", &["csv", "tsv"])
        .add_filter("All files", &["*"])
        .pick_file()
        .ok_or_else(|| "No file selected.".to_string())?;

    let mut prefix = String::new();
    std::fs::File::open(&path)
        .and_then(|mut file| file.read_to_string(&mut prefix))
        .map_err(|error| error.to_string())?;
    let prefix_head: String = prefix.chars().take(8_192).collect();
    let delimiter = detect_delimiter(&prefix_head);

    let records = read_records(&path, delimiter)?;
    if records.is_empty() {
        return Err("The selected CSV file is empty.".to_string());
    }

    let sample_cap = sample_rows.unwrap_or(DEFAULT_SAMPLE_ROWS).max(1);
    let mut header_row: Vec<String> = records[0].iter().map(str::to_string).collect();
    // Empty header cells fall back to positional names column_1..n.
    for (index, cell) in header_row.iter_mut().enumerate() {
        if cell.trim().is_empty() {
            *cell = format!("column_{}", index + 1);
        }
    }
    let data_rows: Vec<Vec<String>> = records
        .iter()
        .skip(1)
        .take(sample_cap)
        .map(|record| record.iter().map(|cell| cell.to_string()).collect())
        .collect();

    Ok(CsvPreview {
        file_name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("unknown.csv")
            .to_string(),
        file_path: path.to_string_lossy().to_string(),
        columns: header_row,
        rows: data_rows,
        total_rows: records.len().saturating_sub(1),
        delimiter: delimiter as char,
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportColumnMapping {
    /// Zero-based CSV column index.
    pub source_index: usize,
    /// Target column name in the database table.
    pub target_column: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub inserted_rows: usize,
    pub batches: usize,
    pub table_created: bool,
}

fn quote_qualified_for(database_type: DatabaseType, qualified: &str) -> Result<String, String> {
    crate::commands::search::quote_qualified_identifier(database_type, qualified)
        .map_err(|error| error.to_string())
}

/// Builds one multi-row parameterized INSERT; cell values travel as named
/// bindings (`:r{row}c{col}`) compiled to engine placeholders, never into text.
/// Each mapping picks its source CSV column by `source_index`.
pub fn build_insert_batch(
    database_type: DatabaseType,
    table_sql: &str,
    mappings: &[ImportColumnMapping],
    rows: &[StringRecord],
    batch_start: usize,
) -> Result<(String, Vec<QueryParameter>), String> {
    if rows.is_empty() {
        return Err("No rows in this batch.".to_string());
    }
    let column_sqls: Vec<String> = mappings
        .iter()
        .map(|mapping| quote_qualified_for(database_type, &mapping.target_column))
        .collect::<Result<Vec<String>, String>>()?;
    let mut parameters = Vec::new();
    let mut values_sql = Vec::with_capacity(rows.len());
    for (row_offset, record) in rows.iter().enumerate() {
        let placeholders: Vec<String> = mappings
            .iter()
            .enumerate()
            .map(|(map_index, mapping)| {
                let value = record
                    .get(mapping.source_index)
                    .map(str::to_string)
                    .unwrap_or_default();
                parameters.push(QueryParameter {
                    name: format!("r{}c{}", batch_start + row_offset, map_index),
                    value: serde_json::Value::String(value),
                    data_type: QueryParameterType::Text,
                });
                format!(":r{}c{}", batch_start + row_offset, map_index)
            })
            .collect();
        values_sql.push(format!("({})", placeholders.join(", ")));
    }
    Ok((
        format!(
            "INSERT INTO {table_sql} ({}) VALUES {}",
            column_sqls.join(", "),
            values_sql.join(", ")
        ),
        parameters,
    ))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn import_csv(
    connection_id: String,
    table: String,
    path: String,
    mappings: Vec<ImportColumnMapping>,
    has_header: bool,
    create_table: bool,
    batch_size: Option<usize>,
    db_manager: State<'_, DatabaseManager>,
) -> Result<ImportSummary, String> {
    if mappings.is_empty() {
        return Err("Import requires at least one column mapping.".to_string());
    }
    let database_type = db_manager
        .connection_database_type(&connection_id)
        .await
        .map_err(|error| error.to_string())?;
    db_manager
        .require_capability(
            &connection_id,
            crate::database::capabilities::DriverCapability::PreparedParameters,
        )
        .await
        .map_err(|error| error.to_string())?;
    let driver = db_manager
        .get_driver(&connection_id)
        .await
        .map_err(|error| error.to_string())?;

    let file_path = std::path::PathBuf::from(&path);
    if !file_path.exists() {
        return Err(format!("File not found: {path}"));
    }
    let mut prefix = String::new();
    std::fs::File::open(&file_path)
        .and_then(|mut file| file.read_to_string(&mut prefix))
        .map_err(|error| error.to_string())?;
    let delimiter = detect_delimiter(&prefix.chars().take(8_192).collect::<String>());
    let mut records = read_records(&file_path, delimiter)?;
    if has_header && !records.is_empty() {
        records.remove(0);
    }

    let table_sql = quote_qualified_for(database_type, &table)?;

    let mut table_created = false;
    if create_table {
        let defs: Vec<String> = mappings
            .iter()
            .map(|mapping| {
                let name_sql = quote_qualified_for(database_type, &mapping.target_column)?;
                Ok(format!("{name_sql} TEXT"))
            })
            .collect::<Result<Vec<String>, String>>()?;
        let create_sql = format!("CREATE TABLE {table_sql} ({})", defs.join(", "));
        driver
            .execute_query(&create_sql)
            .await
            .map_err(|error| format!("Create table failed: {error}"))?;
        table_created = true;
    }

    let batch = batch_size.unwrap_or(DEFAULT_BATCH_SIZE).clamp(1, 1_000);
    let style = placeholder_style_for_database(database_type);
    let mut inserted_rows = 0usize;
    let mut batches = 0usize;
    for (batch_index, chunk_start) in (0..records.len()).step_by(batch).enumerate() {
        let chunk_end = (chunk_start + batch).min(records.len());
        let rows = &records[chunk_start..chunk_end];
        let (sql, parameters) =
            build_insert_batch(database_type, &table_sql, &mappings, rows, batch_index)?;
        let compiled = compile_parameterized_query(&sql, &parameters, style)
            .map_err(|error| error.to_string())?;
        driver
            .execute_parameterized_query(&compiled.sql, &compiled.parameters)
            .await
            .map_err(|error| format!("Import batch {batch_index} failed: {error}"))?;
        inserted_rows += rows.len();
        batches += 1;
    }

    Ok(ImportSummary {
        inserted_rows,
        batches,
        table_created,
    })
}

#[cfg(test)]
mod tests {
    use super::{build_insert_batch, detect_delimiter, ImportColumnMapping};
    use crate::database::models::DatabaseType;
    use csv::StringRecord;

    #[test]
    fn detects_common_delimiters() {
        assert_eq!(detect_delimiter("a,b,c\n1,2,3"), b',');
        assert_eq!(detect_delimiter("a;b;c\n1;2;3"), b';');
        assert_eq!(detect_delimiter("a\tb\tc\n1\t2\t3"), b'\t');
        assert_eq!(detect_delimiter("\"a,b\"\tc\n"), b'\t');
    }

    #[test]
    fn insert_batches_use_bound_placeholders_and_quoted_identifiers() {
        let record = StringRecord::from(vec!["alice", "42"]);
        let mappings = vec![
            ImportColumnMapping {
                source_index: 0,
                target_column: "name".to_string(),
            },
            ImportColumnMapping {
                source_index: 1,
                target_column: "age".to_string(),
            },
        ];
        let (sql, parameters) = build_insert_batch(
            DatabaseType::PostgreSQL,
            "\"public\".\"users\"",
            &mappings,
            &[record],
            0,
        )
        .unwrap();
        assert_eq!(
            sql,
            "INSERT INTO \"public\".\"users\" (\"name\", \"age\") VALUES (:r0c0, :r0c1)"
        );
        assert_eq!(parameters[0].name, "r0c0");
        assert_eq!(parameters[0].value, serde_json::json!("alice"));
    }

    #[test]
    fn mappings_pick_cells_by_source_index() {
        // Column order in the mapping must follow source_index, not list order.
        let record = StringRecord::from(vec!["42", "alice"]);
        let mappings = vec![
            ImportColumnMapping {
                source_index: 1,
                target_column: "name".to_string(),
            },
            ImportColumnMapping {
                source_index: 0,
                target_column: "age".to_string(),
            },
        ];
        let (sql, parameters) = build_insert_batch(
            DatabaseType::PostgreSQL,
            "\"users\"",
            &mappings,
            &[record],
            0,
        )
        .unwrap();
        assert!(sql.contains("(\"name\", \"age\")"));
        assert_eq!(parameters[0].value, serde_json::json!("alice"));
        assert_eq!(parameters[1].value, serde_json::json!("42"));
    }
}
