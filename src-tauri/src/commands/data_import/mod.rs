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

use crate::commands::safe_mode::SafeModeState;
use crate::commands::table::CsvImportCancellationState;
use crate::database::manager::DatabaseManager;
use std::collections::HashSet;
use std::io::{BufRead, BufReader};
use tauri::{AppHandle, State};

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
/// NDJSON previews union keys across this many leading lines so late-appearing
/// fields are still offered as import columns (bounded so a huge file does
/// not stall the dialog).
const NDJSON_KEY_SCAN_ROWS: usize = 10_000;

mod csv;
mod insert;
mod json;
#[cfg(test)]
mod tests;
mod xlsx;

pub use csv::CsvPreview;
// Shared with commands::file so the lightweight CSV preview dialog sniffs
// delimiters and strips BOMs exactly like the real import path.
pub(crate) use csv::{detect_delimiter, strip_text_bom};
pub use insert::{ImportColumnMapping, ImportSummary};
pub use json::JsonPreview;
pub use xlsx::XlsxPreview;

use csv::{
    decode_csv_cell, looks_like_header, positional_columns, sample_and_count, sample_prefix_rows,
    sniff_delimiter_from_file,
};
use insert::execute_import;
use json::{
    align_object, collect_keys, detect_json_shape, parse_json_object_line, read_json_array_objects,
    JsonShape,
};
use xlsx::{align_row_to_len, open_xlsx_sheet, xlsx_header_columns};

#[tauri::command]
pub async fn preview_import_csv(
    path: Option<String>,
    sample_rows: Option<usize>,
) -> Result<CsvPreview, String> {
    // A dropped file arrives with its path already known; otherwise fall back
    // to the picker.
    let path = match path {
        Some(existing) => std::path::PathBuf::from(existing),
        None => rfd::FileDialog::new()
            .add_filter("CSV files", &["csv", "tsv"])
            .add_filter("All files", &["*"])
            .pick_file()
            .ok_or_else(|| "No file selected.".to_string())?,
    };

    let metadata = std::fs::metadata(&path).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_PREVIEW_FILE_BYTES {
        return Err(format!(
            "File is larger than the {} MB preview limit.",
            MAX_PREVIEW_FILE_BYTES / (1024 * 1024)
        ));
    }

    let delimiter = sniff_delimiter_from_file(&path)?;

    // Peek at the first two records to decide whether row 1 is a header or
    // data. A headerless file keeps its first row in the preview instead of
    // silently losing it to the column list.
    let sample_cap = sample_rows.unwrap_or(DEFAULT_SAMPLE_ROWS).max(1);
    let peek_reader = ::csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .has_headers(false)
        .flexible(true)
        .from_path(&path)
        .map_err(|error| format!("Failed to open CSV file: {error}"))?;
    let prefix_rows = sample_prefix_rows(peek_reader, 2)?;
    let first = prefix_rows
        .first()
        .ok_or_else(|| "The selected CSV file is empty.".to_string())?;
    if first.is_empty() {
        return Err("The selected CSV file is empty.".to_string());
    }
    let has_header = looks_like_header(first, prefix_rows.get(1).map(Vec::as_slice));
    let header_row = if has_header {
        let mut header_row = first.clone();
        for (index, cell) in header_row.iter_mut().enumerate() {
            if cell.trim().is_empty() {
                *cell = format!("column_{}", index + 1);
            }
        }
        header_row
    } else {
        positional_columns(first.len())
    };

    // The sample and the row count come from ONE bounded-memory streaming
    // pass — no read-to-end, no Vec of every record.
    let reader = ::csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .has_headers(false)
        .flexible(true)
        .from_path(&path)
        .map_err(|error| format!("Failed to open CSV file: {error}"))?;
    let (data_rows, total_rows, total_rows_truncated) =
        sample_and_count(reader, has_header, sample_cap, MAX_PREVIEW_COUNT_ROWS)?;

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
        has_header,
    })
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
    safe_mode: State<'_, SafeModeState>,
) -> Result<ImportSummary, String> {
    db_manager.assert_write_allowed(&connection_id).await?;
    // Imports bypass the SQL editor, so Safe Mode never saw them; probe the
    // statement kinds this import will run so 'Read Only' blocks UI writes.
    let probe = if create_table {
        "CREATE TABLE t (c INT); INSERT INTO t (c) VALUES (NULL)"
    } else {
        "INSERT INTO t (c) VALUES (NULL)"
    };
    let database_type = db_manager
        .connection_database_type(&connection_id)
        .await
        .ok();
    safe_mode
        .ensure_mutation_allowed(&connection_id, probe, database_type)
        .await?;
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
    // file size. Each item is (positional cells, byte offset); `\N` decodes
    // to SQL NULL and `\\N` back to the literal text.
    let reader = ::csv::ReaderBuilder::new()
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
                let cells: Vec<Option<String>> = record.iter().map(decode_csv_cell).collect();
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
        Some(&file_path.with_extension("tabler-rejected.csv")),
        rows,
    )
    .await
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
            // Keys are collected across a bounded prefix of the file — not
            // just the displayed sample — so fields that first appear deep
            // into the data still show up as importable columns.
            let mut scanned = 0usize;
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
                if scanned < NDJSON_KEY_SCAN_ROWS {
                    scanned += 1;
                    let object = parse_json_object_line(&line)?;
                    collect_keys(&object, &mut seen, &mut columns);
                    if sample.len() < sample_cap {
                        sample.push(object);
                    }
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
    safe_mode: State<'_, SafeModeState>,
) -> Result<ImportSummary, String> {
    db_manager.assert_write_allowed(&connection_id).await?;
    // Same Safe Mode gate as import_csv: UI imports must not bypass
    // 'Read Only' just because they never pass through the SQL editor.
    let probe = if create_table {
        "CREATE TABLE t (c INT); INSERT INTO t (c) VALUES (NULL)"
    } else {
        "INSERT INTO t (c) VALUES (NULL)"
    };
    let database_type = db_manager
        .connection_database_type(&connection_id)
        .await
        .ok();
    safe_mode
        .ensure_mutation_allowed(&connection_id, probe, database_type)
        .await?;
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
                            Ok(object) => Some(Ok((
                                align_object(&columns, &object)
                                    .into_iter()
                                    .map(Some)
                                    .collect(),
                                processed_bytes,
                            ))),
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
                Some(&file_path.with_extension("tabler-rejected.csv")),
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
                Ok((
                    align_object(&columns, &object)
                        .into_iter()
                        .map(Some)
                        .collect(),
                    processed,
                ))
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
                Some(&file_path.with_extension("tabler-rejected.csv")),
                rows,
            )
            .await
        }
    }
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
    safe_mode: State<'_, SafeModeState>,
) -> Result<ImportSummary, String> {
    db_manager.assert_write_allowed(&connection_id).await?;
    // Same Safe Mode gate as import_csv: UI imports must not bypass
    // 'Read Only' just because they never pass through the SQL editor.
    let probe = if create_table {
        "CREATE TABLE t (c INT); INSERT INTO t (c) VALUES (NULL)"
    } else {
        "INSERT INTO t (c) VALUES (NULL)"
    };
    let database_type = db_manager
        .connection_database_type(&connection_id)
        .await
        .ok();
    safe_mode
        .ensure_mutation_allowed(&connection_id, probe, database_type)
        .await?;
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
    let data_rows: Vec<Vec<Option<String>>> = range
        .rows()
        .skip(1)
        .map(|row| {
            align_row_to_len(row, column_count)
                .into_iter()
                .map(Some)
                .collect()
        })
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
        Some(&file_path.with_extension("tabler-rejected.csv")),
        rows,
    )
    .await
}
