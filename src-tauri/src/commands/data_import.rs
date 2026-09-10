//! CSV data import (roadmap Phase 2B + WF-07 streaming).
//!
//! `preview_import_csv` sniffs the delimiter from a small file prefix,
//! streams a bounded sample and counts rows without holding the file in
//! memory. `import_csv` streams records straight from disk into bounded
//! INSERT batches — memory stays flat for 1 GB+ files — while emitting
//! `csv-import-progress` events and honouring the shared
//! `CsvImportCancellationState` so a running import can be cancelled.

use crate::commands::table::CsvImportCancellationState;
use crate::database::manager::DatabaseManager;
use crate::database::models::{DatabaseType, QueryParameter, QueryParameterType};
use crate::database::parameterized_query::{
    compile_parameterized_query, placeholder_style_for_database,
};
use csv::StringRecord;
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

/// Preview must stream-count its rows; files beyond this are refused so a
/// stray 100 GB file cannot spin the preview dialog for minutes.
const MAX_PREVIEW_FILE_BYTES: u64 = 1024 * 1024 * 1024;
/// Import streams from disk, so the old 100 MB gate becomes a sanity cap.
const MAX_IMPORT_FILE_BYTES: u64 = 10 * 1024 * 1024 * 1024;
/// Row-count ceiling for previews; beyond it the count is reported truncated.
const MAX_PREVIEW_COUNT_ROWS: usize = 2_000_000;
/// Bytes sniffed from the file head for delimiter detection.
const DELIMITER_SNIFF_BYTES: u64 = 8_192;
const DEFAULT_BATCH_SIZE: usize = 200;
const DEFAULT_SAMPLE_ROWS: usize = 20;
/// Progress events are emitted at this row stride (matches the atomic path).
const PROGRESS_ROW_STRIDE: u64 = 250;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvPreview {
    pub file_name: String,
    /// Absolute path so `import_csv` can re-read the same file.
    pub file_path: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub total_rows: usize,
    /// True when row counting stopped at MAX_PREVIEW_COUNT_ROWS.
    pub total_rows_truncated: bool,
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
    b",;\t"[best_index]
}

/// Reads only the first bytes of the file for delimiter sniffing — a 10 GB
/// file costs the same 8 KB read as a 10 KB one.
fn sniff_delimiter_from_file(path: &std::path::Path) -> Result<u8, String> {
    let file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut prefix = String::new();
    file.take(DELIMITER_SNIFF_BYTES)
        .read_to_string(&mut prefix)
        .map_err(|error| error.to_string())?;
    Ok(detect_delimiter(&prefix))
}

/// Streams the CSV once, collecting at most `sample_cap` data rows and
/// counting data rows up to `count_cap`. Returns
/// `(sample_rows, total_rows, truncated)`. Bounded memory regardless of size.
fn sample_and_count<R: std::io::Read>(
    mut reader: csv::Reader<R>,
    mut has_header: bool,
    sample_cap: usize,
    count_cap: usize,
) -> Result<(Vec<Vec<String>>, usize, bool), String> {
    let mut sample_rows: Vec<Vec<String>> = Vec::new();
    let mut total_rows = 0usize;
    let mut truncated = false;
    for record in reader.records() {
        let record = record.map_err(|error| format!("CSV parse error: {error}"))?;
        if has_header {
            // The header line is reported separately by the caller.
            has_header = false;
            continue;
        }
        if total_rows < count_cap {
            total_rows += 1;
        } else {
            truncated = true;
        }
        if sample_rows.len() < sample_cap {
            sample_rows.push(record.iter().map(str::to_string).collect());
        }
    }
    Ok((sample_rows, total_rows, truncated))
}

fn header_columns_from_path(path: &std::path::Path, delimiter: u8) -> Result<Vec<String>, String> {
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .has_headers(false)
        .flexible(true)
        .from_path(path)
        .map_err(|error| format!("Failed to open CSV file: {error}"))?;
    let first = reader
        .records()
        .next()
        .ok_or_else(|| "The selected CSV file is empty.".to_string())
        .and_then(|record| record.map_err(|error| format!("CSV parse error: {error}")))?;
    if first.is_empty() {
        return Err("The selected CSV file is empty.".to_string());
    }
    let mut header_row: Vec<String> = first.into_iter().map(|cell| cell.to_string()).collect();
    // Empty header cells fall back to positional names column_1..n.
    for (index, cell) in header_row.iter_mut().enumerate() {
        if cell.trim().is_empty() {
            *cell = format!("column_{}", index + 1);
        }
    }
    Ok(header_row)
}

#[tauri::command]
pub async fn preview_import_csv(sample_rows: Option<usize>) -> Result<CsvPreview, String> {
    let path = rfd::FileDialog::new()
        .add_filter("CSV files", &["csv", "tsv"])
        .add_filter("All files", &["*"])
        .pick_file()
        .ok_or_else(|| "No file selected.".to_string())?;

    let metadata = std::fs::metadata(&path).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_PREVIEW_FILE_BYTES {
        return Err(format!(
            "File is larger than the {} MB preview limit.",
            MAX_PREVIEW_FILE_BYTES / (1024 * 1024)
        ));
    }

    let delimiter = sniff_delimiter_from_file(&path)?;
    let header_row = header_columns_from_path(&path, delimiter)?;

    // The sample and the row count come from ONE bounded-memory streaming
    // pass — no read-to-end, no Vec of every record.
    let sample_cap = sample_rows.unwrap_or(DEFAULT_SAMPLE_ROWS).max(1);
    let reader = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .has_headers(false)
        .flexible(true)
        .from_path(&path)
        .map_err(|error| format!("Failed to open CSV file: {error}"))?;
    let (data_rows, total_rows, total_rows_truncated) =
        sample_and_count(reader, true, sample_cap, MAX_PREVIEW_COUNT_ROWS)?;

    Ok(CsvPreview {
        file_name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("unknown.csv")
            .to_string(),
        file_path: path.to_string_lossy().to_string(),
        columns: header_row,
        rows: data_rows,
        total_rows,
        total_rows_truncated,
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
    /// True when the run stopped early because cancel_csv_import was called.
    pub cancelled: bool,
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
    operation_id: Option<String>,
    app: AppHandle,
    cancellation_state: State<'_, CsvImportCancellationState>,
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
    let metadata = std::fs::metadata(&file_path).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_IMPORT_FILE_BYTES {
        return Err(format!(
            "File is larger than the {} MB import limit.",
            MAX_IMPORT_FILE_BYTES / (1024 * 1024)
        ));
    }
    let delimiter = sniff_delimiter_from_file(&file_path)?;
    let total_bytes = metadata.len();

    // Register with the shared cancellation state so cancel_csv_import can
    // stop this import; callers without an operation id get a local flag.
    let (cancelled, registered_operation_id) = match operation_id.as_deref() {
        Some(id) if !id.trim().is_empty() => (cancellation_state.start(id)?, Some(id.to_string())),
        _ => (Arc::new(AtomicBool::new(false)), None),
    };

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
    // Stream records from disk: memory holds one batch at a time, so file
    // size no longer decides memory use. The loop runs inside one async
    // block so the cancellation slot is ALWAYS released afterwards.
    let import_outcome = async {
        let mut reader = csv::ReaderBuilder::new()
            .delimiter(delimiter)
            .has_headers(has_header)
            .flexible(true)
            .from_path(&file_path)
            .map_err(|error| format!("Failed to open CSV file: {error}"))?;

        let mut pending: Vec<StringRecord> = Vec::with_capacity(batch);
        let mut inserted_rows = 0usize;
        let mut batches = 0usize;
        let mut batch_index = 0usize;
        let mut next_progress_at = PROGRESS_ROW_STRIDE;
        let mut was_cancelled = false;
        #[allow(unused_assignments)]
        let mut last_byte = 0u64;

        for record in reader.records() {
            if cancelled.load(Ordering::Relaxed) {
                was_cancelled = true;
                break;
            }
            let record = record.map_err(|error| format!("CSV parse error: {error}"))?;
            last_byte = record.position().map(|p| p.byte()).unwrap_or(0);
            pending.push(record);
            if pending.len() < batch {
                continue;
            }
            let (sql, parameters) =
                build_insert_batch(database_type, &table_sql, &mappings, &pending, batch_index)?;
            let compiled = compile_parameterized_query(&sql, &parameters, style)
                .map_err(|error| error.to_string())?;
            driver
                .execute_parameterized_query(&compiled.sql, &compiled.parameters)
                .await
                .map_err(|error| format!("Import batch {batch_index} failed: {error}"))?;
            inserted_rows += pending.len();
            batches += 1;
            batch_index += 1;
            pending.clear();

            if (inserted_rows as u64) >= next_progress_at {
                next_progress_at = inserted_rows as u64 + PROGRESS_ROW_STRIDE;
                let _ = app.emit(
                    "csv-import-progress",
                    serde_json::json!({
                        "operationId": registered_operation_id,
                        "processedRows": inserted_rows as u64,
                        "processedBytes": last_byte,
                        "totalBytes": total_bytes,
                    }),
                );
            }
        }

        if was_cancelled {
            return Ok(ImportSummary {
                inserted_rows,
                batches,
                table_created,
                cancelled: true,
            });
        }

        // Final partial batch.
        if !pending.is_empty() {
            let (sql, parameters) =
                build_insert_batch(database_type, &table_sql, &mappings, &pending, batch_index)?;
            let compiled = compile_parameterized_query(&sql, &parameters, style)
                .map_err(|error| error.to_string())?;
            driver
                .execute_parameterized_query(&compiled.sql, &compiled.parameters)
                .await
                .map_err(|error| format!("Import batch {batch_index} failed: {error}"))?;
            inserted_rows += pending.len();
            batches += 1;
        }

        let _ = app.emit(
            "csv-import-progress",
            serde_json::json!({
                "operationId": registered_operation_id,
                "processedRows": inserted_rows as u64,
                "processedBytes": total_bytes,
                "totalBytes": total_bytes,
            }),
        );

        Ok(ImportSummary {
            inserted_rows,
            batches,
            table_created,
            cancelled: false,
        })
    }
    .await;

    if let Some(id) = registered_operation_id.as_deref() {
        cancellation_state.finish(id);
    }
    import_outcome
}

#[cfg(test)]
mod tests {
    use super::{build_insert_batch, detect_delimiter, sample_and_count, ImportColumnMapping};
    use crate::database::models::DatabaseType;
    use csv::StringRecord;
    use std::io::Cursor;

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

    fn reader_from(text: &str) -> csv::Reader<Cursor<&str>> {
        csv::ReaderBuilder::new()
            .delimiter(b',')
            .has_headers(false)
            .flexible(true)
            .from_reader(Cursor::new(text))
    }

    #[test]
    fn sample_and_count_streams_without_loading_every_row() {
        let mut text = String::from("id,name\n");
        for index in 0..50 {
            text.push_str(&format!("{index},row{index}\n"));
        }
        let (rows, total, truncated) =
            sample_and_count(reader_from(&text), true, 5, 1_000_000).unwrap();
        assert_eq!(rows.len(), 5);
        assert_eq!(rows[0], vec!["0", "row0"]);
        assert_eq!(total, 50);
        assert!(!truncated);
    }

    #[test]
    fn sample_and_count_reports_truncation_at_the_cap() {
        let mut text = String::from("id\n");
        for index in 0..10 {
            text.push_str(&format!("{index}\n"));
        }
        let (rows, total, truncated) = sample_and_count(reader_from(&text), true, 3, 5).unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(total, 5, "count stops at the cap");
        assert!(truncated);
    }

    #[test]
    fn sample_and_count_without_header_counts_every_line() {
        let (rows, total, truncated) =
            sample_and_count(reader_from("a,b\nc,d\n"), false, 10, 1_000_000).unwrap();
        assert_eq!(total, 2);
        assert_eq!(rows.len(), 2);
        assert!(!truncated);
    }
}
