//! CSV and JSON data import (roadmap Phase 2B + WF-07 streaming).
//!
//! JSON supports a top-level array of objects and NDJSON (one object per
//! line); both normalise to the same positional string rows the CSV path
//! produces, so they share the streaming INSERT sink (`execute_import`).
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
use calamine::{open_workbook_auto, Data, Reader};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io::{BufRead, BufReader, Read};
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
/// A JSON array is parsed fully into memory, so it gets a stricter cap than
/// the streaming NDJSON/CSV paths. Larger data should use NDJSON instead.
const MAX_JSON_ARRAY_FILE_BYTES: u64 = 512 * 1024 * 1024;
/// calamine decompresses a spreadsheet fully into memory, so Excel/ODS files
/// get their own cap (a small .xlsx can expand to a very large sheet).
const MAX_XLSX_FILE_BYTES: u64 = 256 * 1024 * 1024;

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
/// Each mapping picks its source cell by `source_index`.
pub fn build_insert_batch(
    database_type: DatabaseType,
    table_sql: &str,
    mappings: &[ImportColumnMapping],
    rows: &[Vec<String>],
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
                    .cloned()
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

/// Streaming CSV import (roadmap Phase 2B). Validates the file, then hands a
/// lazy record iterator to the shared import sink.
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

    // Owning record iterator so memory holds one batch at a time regardless of
    // file size. Each item is (positional string cells, byte offset).
    let reader = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .has_headers(has_header)
        .flexible(true)
        .from_path(&file_path)
        .map_err(|error| format!("Failed to open CSV file: {error}"))?;
    let rows = reader.into_records().map(|record| {
        record
            .map_err(|error| format!("CSV parse error: {error}"))
            .map(|record| {
                let byte = record
                    .position()
                    .map(|position| position.byte())
                    .unwrap_or(0);
                let cells: Vec<String> = record.iter().map(str::to_string).collect();
                (cells, byte)
            })
    });

    execute_import(
        &connection_id,
        &table,
        &mappings,
        create_table,
        batch_size,
        operation_id,
        &app,
        cancellation_state.inner(),
        db_manager.inner(),
        total_bytes,
        rows,
    )
    .await
}

/// Shared import sink for every format. Given a lazy row iterator (each item is
/// `(positional string cells, byte offset)`), it verifies driver capability,
/// optionally creates the target table, then streams bounded INSERT batches
/// with progress events and cooperative cancellation.
#[allow(clippy::too_many_arguments)]
async fn execute_import<I>(
    connection_id: &str,
    table: &str,
    mappings: &[ImportColumnMapping],
    create_table: bool,
    batch_size: Option<usize>,
    operation_id: Option<String>,
    app: &AppHandle,
    cancellation_state: &CsvImportCancellationState,
    db_manager: &DatabaseManager,
    total_bytes: u64,
    rows: I,
) -> Result<ImportSummary, String>
where
    I: Iterator<Item = Result<(Vec<String>, u64), String>> + Send,
{
    if mappings.is_empty() {
        return Err("Import requires at least one column mapping.".to_string());
    }
    let database_type = db_manager
        .connection_database_type(connection_id)
        .await
        .map_err(|error| error.to_string())?;
    db_manager
        .require_capability(
            connection_id,
            crate::database::capabilities::DriverCapability::PreparedParameters,
        )
        .await
        .map_err(|error| error.to_string())?;
    let driver = db_manager
        .get_driver(connection_id)
        .await
        .map_err(|error| error.to_string())?;

    // Register with the shared cancellation state so cancel_csv_import can
    // stop this import; callers without an operation id get a local flag.
    let (cancelled, registered_operation_id) = match operation_id.as_deref() {
        Some(id) if !id.trim().is_empty() => (cancellation_state.start(id)?, Some(id.to_string())),
        _ => (Arc::new(AtomicBool::new(false)), None),
    };

    let table_sql = quote_qualified_for(database_type, table)?;

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
    // Consume the row iterator: memory holds one batch at a time, so file size
    // no longer decides memory use. The loop runs inside one async block so the
    // cancellation slot is ALWAYS released afterwards.
    let import_outcome = async {
        let mut pending: Vec<Vec<String>> = Vec::with_capacity(batch);
        let mut inserted_rows = 0usize;
        let mut batches = 0usize;
        let mut batch_index = 0usize;
        let mut next_progress_at = PROGRESS_ROW_STRIDE;
        let mut was_cancelled = false;
        #[allow(unused_assignments)]
        let mut last_byte = 0u64;

        for row in rows {
            if cancelled.load(Ordering::Relaxed) {
                was_cancelled = true;
                break;
            }
            let (cells, byte) = row?;
            last_byte = byte;
            pending.push(cells);
            if pending.len() < batch {
                continue;
            }
            let (sql, parameters) =
                build_insert_batch(database_type, &table_sql, mappings, &pending, batch_index)?;
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
                build_insert_batch(database_type, &table_sql, mappings, &pending, batch_index)?;
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

/// Top-level JSON layout of an import file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum JsonShape {
    /// A single top-level array of objects: `[ {..}, {..} ]`.
    Array,
    /// Newline-delimited objects (one JSON object per line).
    Ndjson,
}

impl JsonShape {
    fn as_str(self) -> &'static str {
        match self {
            JsonShape::Array => "array",
            JsonShape::Ndjson => "ndjson",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonPreview {
    pub file_name: String,
    /// Absolute path so `import_json` can re-read the same file.
    pub file_path: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub total_rows: usize,
    /// True when row counting stopped at MAX_PREVIEW_COUNT_ROWS.
    pub total_rows_truncated: bool,
    /// "array" or "ndjson" — echoed so the UI can label the source.
    pub shape: String,
}

/// Classifies the JSON layout from the first non-whitespace byte of a prefix.
fn json_shape_from_prefix(prefix: &str) -> Result<JsonShape, String> {
    let trimmed = prefix.trim_start_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    match trimmed.chars().next() {
        Some('[') => Ok(JsonShape::Array),
        Some('{') => Ok(JsonShape::Ndjson),
        Some(_) => Err(
            "Unsupported JSON: expected an array of objects or newline-delimited objects."
                .to_string(),
        ),
        None => Err("The selected JSON file is empty.".to_string()),
    }
}

/// Reads a small prefix to classify the file without loading all of it.
fn detect_json_shape(path: &std::path::Path) -> Result<JsonShape, String> {
    let file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut buffer = Vec::new();
    file.take(64)
        .read_to_end(&mut buffer)
        .map_err(|error| error.to_string())?;
    json_shape_from_prefix(&String::from_utf8_lossy(&buffer))
}

/// Renders a JSON scalar as a cell string; nested arrays/objects keep their
/// compact JSON text so no data is silently dropped.
fn json_value_to_cell(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => String::new(),
        serde_json::Value::String(text) => text.clone(),
        serde_json::Value::Bool(flag) => flag.to_string(),
        serde_json::Value::Number(number) => number.to_string(),
        other => other.to_string(),
    }
}

/// Aligns one object to the fixed column order; missing keys become empty.
fn align_object(
    columns: &[String],
    object: &serde_json::Map<String, serde_json::Value>,
) -> Vec<String> {
    columns
        .iter()
        .map(|key| object.get(key).map(json_value_to_cell).unwrap_or_default())
        .collect()
}

/// Records each key the first time it is seen so the column order stays stable.
fn collect_keys(
    object: &serde_json::Map<String, serde_json::Value>,
    seen: &mut HashSet<String>,
    columns: &mut Vec<String>,
) {
    for key in object.keys() {
        if seen.insert(key.clone()) {
            columns.push(key.clone());
        }
    }
}

/// Parses one NDJSON line into an object, rejecting non-object lines.
fn parse_json_object_line(
    line: &str,
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    match serde_json::from_str::<serde_json::Value>(line)
        .map_err(|error| format!("JSON parse error: {error}"))?
    {
        serde_json::Value::Object(map) => Ok(map),
        _ => Err("Each NDJSON line must be a JSON object.".to_string()),
    }
}

/// Reads a top-level JSON array file into owned objects.
fn read_json_array_objects(
    path: &std::path::Path,
) -> Result<Vec<serde_json::Map<String, serde_json::Value>>, String> {
    let file =
        std::fs::File::open(path).map_err(|error| format!("Failed to open JSON file: {error}"))?;
    let value: serde_json::Value = serde_json::from_reader(BufReader::new(file))
        .map_err(|error| format!("JSON parse error: {error}"))?;
    match value {
        serde_json::Value::Array(items) => items
            .into_iter()
            .map(|item| match item {
                serde_json::Value::Object(map) => Ok(map),
                _ => Err("JSON array elements must be objects.".to_string()),
            })
            .collect(),
        _ => Err("Expected a top-level JSON array of objects.".to_string()),
    }
}

#[tauri::command]
pub async fn preview_import_json(sample_rows: Option<usize>) -> Result<JsonPreview, String> {
    let path = rfd::FileDialog::new()
        .add_filter("JSON files", &["json", "ndjson", "jsonl"])
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

    let shape = detect_json_shape(&path)?;
    let sample_cap = sample_rows.unwrap_or(DEFAULT_SAMPLE_ROWS).max(1);

    let mut columns: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut sample: Vec<serde_json::Map<String, serde_json::Value>> = Vec::new();
    let mut total_rows = 0usize;
    let mut total_rows_truncated = false;

    match shape {
        JsonShape::Array => {
            if metadata.len() > MAX_JSON_ARRAY_FILE_BYTES {
                return Err(format!(
                    "JSON array files are limited to {} MB — use NDJSON for larger data.",
                    MAX_JSON_ARRAY_FILE_BYTES / (1024 * 1024)
                ));
            }
            let objects = read_json_array_objects(&path)?;
            for object in &objects {
                collect_keys(object, &mut seen, &mut columns);
            }
            total_rows = objects.len().min(MAX_PREVIEW_COUNT_ROWS);
            total_rows_truncated = objects.len() > MAX_PREVIEW_COUNT_ROWS;
            sample = objects.into_iter().take(sample_cap).collect();
        }
        JsonShape::Ndjson => {
            let file = std::fs::File::open(&path)
                .map_err(|error| format!("Failed to open JSON file: {error}"))?;
            for line in BufReader::new(file).lines() {
                let line = line.map_err(|error| error.to_string())?;
                if line.trim().is_empty() {
                    continue;
                }
                if total_rows < MAX_PREVIEW_COUNT_ROWS {
                    total_rows += 1;
                } else {
                    total_rows_truncated = true;
                }
                if sample.len() < sample_cap {
                    let object = parse_json_object_line(&line)?;
                    collect_keys(&object, &mut seen, &mut columns);
                    sample.push(object);
                }
            }
        }
    }

    if columns.is_empty() {
        return Err("The selected JSON file has no object fields to import.".to_string());
    }

    let rows = sample
        .iter()
        .map(|object| align_object(&columns, object))
        .collect();

    Ok(JsonPreview {
        file_name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("unknown.json")
            .to_string(),
        file_path: path.to_string_lossy().to_string(),
        columns,
        rows,
        total_rows,
        total_rows_truncated,
        shape: shape.as_str().to_string(),
    })
}

/// Streaming JSON import (array-of-objects or NDJSON). `source_columns` is the
/// previewed key order, so every object maps to the same positional cells the
/// user saw; keys outside that set are ignored.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn import_json(
    connection_id: String,
    table: String,
    path: String,
    source_columns: Vec<String>,
    mappings: Vec<ImportColumnMapping>,
    create_table: bool,
    batch_size: Option<usize>,
    operation_id: Option<String>,
    app: AppHandle,
    cancellation_state: State<'_, CsvImportCancellationState>,
    db_manager: State<'_, DatabaseManager>,
) -> Result<ImportSummary, String> {
    if source_columns.is_empty() {
        return Err("Import requires the previewed JSON columns.".to_string());
    }
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
    let total_bytes = metadata.len();

    match detect_json_shape(&file_path)? {
        JsonShape::Ndjson => {
            let file = std::fs::File::open(&file_path)
                .map_err(|error| format!("Failed to open JSON file: {error}"))?;
            let columns = source_columns;
            let mut processed_bytes = 0u64;
            let rows = BufReader::new(file)
                .lines()
                .filter_map(move |line| match line {
                    Err(error) => Some(Err(error.to_string())),
                    Ok(text) => {
                        processed_bytes += text.len() as u64 + 1;
                        if text.trim().is_empty() {
                            return None;
                        }
                        match parse_json_object_line(&text) {
                            Err(error) => Some(Err(error)),
                            Ok(object) => {
                                Some(Ok((align_object(&columns, &object), processed_bytes)))
                            }
                        }
                    }
                });
            execute_import(
                &connection_id,
                &table,
                &mappings,
                create_table,
                batch_size,
                operation_id,
                &app,
                cancellation_state.inner(),
                db_manager.inner(),
                total_bytes,
                rows,
            )
            .await
        }
        JsonShape::Array => {
            if metadata.len() > MAX_JSON_ARRAY_FILE_BYTES {
                return Err(format!(
                    "JSON array files are limited to {} MB — use NDJSON for larger data.",
                    MAX_JSON_ARRAY_FILE_BYTES / (1024 * 1024)
                ));
            }
            let objects = read_json_array_objects(&file_path)?;
            let columns = source_columns;
            let total = (objects.len() as u64).max(1);
            let rows = objects.into_iter().enumerate().map(move |(index, object)| {
                // Byte progress is approximated for the in-memory array path.
                let processed = ((index as u64 + 1).saturating_mul(total_bytes)) / total;
                Ok((align_object(&columns, &object), processed))
            });
            execute_import(
                &connection_id,
                &table,
                &mappings,
                create_table,
                batch_size,
                operation_id,
                &app,
                cancellation_state.inner(),
                db_manager.inner(),
                total_bytes,
                rows,
            )
            .await
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XlsxPreview {
    pub file_name: String,
    /// Absolute path so `import_xlsx` and sheet-switching can re-read the file.
    pub file_path: String,
    pub sheet_names: Vec<String>,
    /// The sheet this preview was built from.
    pub sheet: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub total_rows: usize,
    pub total_rows_truncated: bool,
}

/// Formats an Excel serial datetime/duration without pulling in chrono, using
/// calamine's own component splitter.
fn format_excel_datetime(value: &calamine::ExcelDateTime) -> String {
    if value.is_duration() {
        let total_seconds = (value.as_f64() * 86_400.0).round() as i64;
        let hours = total_seconds / 3600;
        let minutes = (total_seconds % 3600) / 60;
        let seconds = total_seconds % 60;
        return format!("{hours}:{minutes:02}:{seconds:02}");
    }
    let (year, month, day, hour, minute, second, milli) = value.to_ymd_hms_milli();
    if hour == 0 && minute == 0 && second == 0 && milli == 0 {
        format!("{year:04}-{month:02}-{day:02}")
    } else if milli == 0 {
        format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}")
    } else {
        format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}.{milli:03}")
    }
}

/// Renders one worksheet cell as an import string, converting typed cells
/// (numbers, booleans, dates) to a stable textual form. Error cells import as
/// empty so a `#DIV/0!` never lands in a data column.
fn xlsx_cell_to_string(cell: &Data) -> String {
    match cell {
        Data::Empty => String::new(),
        Data::String(text) => text.clone(),
        Data::Bool(flag) => flag.to_string(),
        Data::Int(number) => number.to_string(),
        Data::Float(number) => number.to_string(),
        Data::DateTime(datetime) => format_excel_datetime(datetime),
        Data::DateTimeIso(text) => text.clone(),
        Data::DurationIso(text) => text.clone(),
        Data::Error(_) => String::new(),
    }
}

/// Derives header column names from the first worksheet row; blank cells get a
/// positional `column_N` fallback like the CSV path.
fn xlsx_header_columns(header: &[Data]) -> Vec<String> {
    header
        .iter()
        .enumerate()
        .map(|(index, cell)| {
            let name = xlsx_cell_to_string(cell);
            if name.trim().is_empty() {
                format!("column_{}", index + 1)
            } else {
                name
            }
        })
        .collect()
}

/// Converts a worksheet row to positional strings, padding/truncating to the
/// header width so every row lines up with the mapped columns.
fn align_row_to_len(row: &[Data], len: usize) -> Vec<String> {
    (0..len)
        .map(|index| row.get(index).map(xlsx_cell_to_string).unwrap_or_default())
        .collect()
}

/// Opens the workbook, returning the sheet-name list plus the requested (or
/// first) sheet's range. calamine loads the whole sheet into memory.
fn open_xlsx_sheet(
    path: &std::path::Path,
    sheet: Option<&str>,
) -> Result<(Vec<String>, String, calamine::Range<Data>), String> {
    let mut workbook =
        open_workbook_auto(path).map_err(|error| format!("Failed to open spreadsheet: {error}"))?;
    let sheet_names = workbook.sheet_names().to_owned();
    if sheet_names.is_empty() {
        return Err("The selected spreadsheet has no sheets.".to_string());
    }
    let active = match sheet {
        Some(name) if sheet_names.iter().any(|candidate| candidate == name) => name.to_string(),
        Some(name) => return Err(format!("Sheet '{name}' was not found in the spreadsheet.")),
        None => sheet_names[0].clone(),
    };
    let range = workbook
        .worksheet_range(&active)
        .map_err(|error| format!("Failed to read sheet '{active}': {error}"))?;
    Ok((sheet_names, active, range))
}

#[tauri::command]
pub async fn preview_import_xlsx(
    path: Option<String>,
    sheet: Option<String>,
    sample_rows: Option<usize>,
) -> Result<XlsxPreview, String> {
    let file_path = match path {
        Some(existing) => std::path::PathBuf::from(existing),
        None => rfd::FileDialog::new()
            .add_filter("Excel / ODS files", &["xlsx", "xlsm", "xls", "xlsb", "ods"])
            .add_filter("All files", &["*"])
            .pick_file()
            .ok_or_else(|| "No file selected.".to_string())?,
    };

    let metadata = std::fs::metadata(&file_path).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_XLSX_FILE_BYTES {
        return Err(format!(
            "Spreadsheet files are limited to {} MB.",
            MAX_XLSX_FILE_BYTES / (1024 * 1024)
        ));
    }

    let (sheet_names, active, range) = open_xlsx_sheet(&file_path, sheet.as_deref())?;
    let sample_cap = sample_rows.unwrap_or(DEFAULT_SAMPLE_ROWS).max(1);

    let mut row_iter = range.rows();
    let columns = match row_iter.next() {
        Some(header) => xlsx_header_columns(header),
        None => Vec::new(),
    };
    if columns.is_empty() {
        return Err(format!("Sheet '{active}' is empty."));
    }

    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut total_rows = 0usize;
    let mut total_rows_truncated = false;
    for row in row_iter {
        if total_rows < MAX_PREVIEW_COUNT_ROWS {
            total_rows += 1;
        } else {
            total_rows_truncated = true;
        }
        if rows.len() < sample_cap {
            rows.push(align_row_to_len(row, columns.len()));
        }
    }

    Ok(XlsxPreview {
        file_name: file_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("unknown.xlsx")
            .to_string(),
        file_path: file_path.to_string_lossy().to_string(),
        sheet_names,
        sheet: active,
        columns,
        rows,
        total_rows,
        total_rows_truncated,
    })
}

/// Imports one worksheet. The first row is treated as the header (defining
/// column width); remaining rows become positional cells fed to the shared
/// sink. calamine holds the sheet in memory, so this path is not streamed.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn import_xlsx(
    connection_id: String,
    table: String,
    path: String,
    sheet: String,
    mappings: Vec<ImportColumnMapping>,
    create_table: bool,
    batch_size: Option<usize>,
    operation_id: Option<String>,
    app: AppHandle,
    cancellation_state: State<'_, CsvImportCancellationState>,
    db_manager: State<'_, DatabaseManager>,
) -> Result<ImportSummary, String> {
    let file_path = std::path::PathBuf::from(&path);
    if !file_path.exists() {
        return Err(format!("File not found: {path}"));
    }
    let metadata = std::fs::metadata(&file_path).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_XLSX_FILE_BYTES {
        return Err(format!(
            "Spreadsheet files are limited to {} MB.",
            MAX_XLSX_FILE_BYTES / (1024 * 1024)
        ));
    }
    let total_bytes = metadata.len();

    let (_, _, range) = open_xlsx_sheet(&file_path, Some(&sheet))?;
    let column_count = range.rows().next().map(|row| row.len()).unwrap_or(0);
    if column_count == 0 {
        return Err(format!("Sheet '{sheet}' is empty."));
    }
    // Materialise data rows (calamine already holds the sheet in memory), then
    // hand an owned iterator to the shared sink.
    let data_rows: Vec<Vec<String>> = range
        .rows()
        .skip(1)
        .map(|row| align_row_to_len(row, column_count))
        .collect();
    let total = (data_rows.len() as u64).max(1);
    let rows = data_rows
        .into_iter()
        .enumerate()
        .map(move |(index, cells)| {
            // Byte progress is approximated for the in-memory spreadsheet path.
            let processed = ((index as u64 + 1).saturating_mul(total_bytes)) / total;
            Ok((cells, processed))
        });

    execute_import(
        &connection_id,
        &table,
        &mappings,
        create_table,
        batch_size,
        operation_id,
        &app,
        cancellation_state.inner(),
        db_manager.inner(),
        total_bytes,
        rows,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::{
        align_object, align_row_to_len, build_insert_batch, collect_keys, detect_delimiter,
        json_shape_from_prefix, json_value_to_cell, parse_json_object_line, sample_and_count,
        xlsx_cell_to_string, xlsx_header_columns, ImportColumnMapping, JsonShape,
    };
    use crate::database::models::DatabaseType;
    use calamine::{Data, ExcelDateTime, ExcelDateTimeType};
    use std::collections::HashSet;
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
        let record = vec!["alice".to_string(), "42".to_string()];
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
        let record = vec!["42".to_string(), "alice".to_string()];
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

    #[test]
    fn json_shape_detects_array_ndjson_and_rejects_scalars() {
        assert_eq!(
            json_shape_from_prefix("  [ {} ]").unwrap(),
            JsonShape::Array
        );
        assert_eq!(
            json_shape_from_prefix("\n{\"a\":1}\n").unwrap(),
            JsonShape::Ndjson
        );
        assert_eq!(
            json_shape_from_prefix("\u{feff}[").unwrap(),
            JsonShape::Array
        );
        assert!(json_shape_from_prefix("   ").is_err());
        assert!(json_shape_from_prefix("42").is_err());
    }

    #[test]
    fn json_values_render_as_import_cells() {
        assert_eq!(json_value_to_cell(&serde_json::json!(null)), "");
        assert_eq!(json_value_to_cell(&serde_json::json!("hi")), "hi");
        assert_eq!(json_value_to_cell(&serde_json::json!(true)), "true");
        assert_eq!(json_value_to_cell(&serde_json::json!(42)), "42");
        assert_eq!(
            json_value_to_cell(&serde_json::json!({"k": 1})),
            "{\"k\":1}"
        );
    }

    #[test]
    fn collect_keys_preserves_first_seen_order_across_objects() {
        let mut seen = HashSet::new();
        let mut columns = Vec::new();
        let first = parse_json_object_line("{\"b\":1,\"a\":2}").unwrap();
        let second = parse_json_object_line("{\"a\":9,\"c\":3}").unwrap();
        collect_keys(&first, &mut seen, &mut columns);
        collect_keys(&second, &mut seen, &mut columns);
        assert_eq!(columns, vec!["b", "a", "c"]);
    }

    #[test]
    fn align_object_maps_by_column_and_blanks_missing_keys() {
        let object = parse_json_object_line("{\"name\":\"alice\",\"age\":30}").unwrap();
        let columns = vec!["name".to_string(), "age".to_string(), "city".to_string()];
        assert_eq!(align_object(&columns, &object), vec!["alice", "30", ""]);
    }

    #[test]
    fn parse_json_object_line_rejects_non_objects() {
        assert!(parse_json_object_line("[1,2,3]").is_err());
        assert!(parse_json_object_line("not json").is_err());
    }

    #[test]
    fn xlsx_cells_render_typed_values_including_dates() {
        assert_eq!(xlsx_cell_to_string(&Data::Empty), "");
        assert_eq!(xlsx_cell_to_string(&Data::String("hi".to_string())), "hi");
        assert_eq!(xlsx_cell_to_string(&Data::Bool(true)), "true");
        assert_eq!(xlsx_cell_to_string(&Data::Int(42)), "42");
        assert_eq!(xlsx_cell_to_string(&Data::Float(42.5)), "42.5");
        // 45943.0 is the Excel 1900-epoch serial for 2025-10-13 (midnight).
        let datetime = ExcelDateTime::new(45943.0, ExcelDateTimeType::DateTime, false);
        assert_eq!(xlsx_cell_to_string(&Data::DateTime(datetime)), "2025-10-13");
    }

    #[test]
    fn xlsx_header_uses_positional_fallback_for_blanks() {
        let header = vec![Data::String("name".to_string()), Data::Empty, Data::Int(3)];
        assert_eq!(xlsx_header_columns(&header), vec!["name", "column_2", "3"]);
    }

    #[test]
    fn xlsx_rows_align_and_pad_to_header_width() {
        let row = vec![Data::String("a".to_string()), Data::Int(2)];
        assert_eq!(align_row_to_len(&row, 3), vec!["a", "2", ""]);
    }
}
