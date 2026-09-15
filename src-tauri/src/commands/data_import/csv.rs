//! CSV import: delimiter sniffing, bounded sampling/counting, and header parsing.
//!
//! Only a small file prefix is read for delimiter detection; sampling/counting
//! streams the file so preview cost stays independent of total size.

use super::DELIMITER_SNIFF_BYTES;
use serde::Serialize;
use std::io::Read;

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
pub(super) fn sniff_delimiter_from_file(path: &std::path::Path) -> Result<u8, String> {
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
pub(super) fn sample_and_count<R: std::io::Read>(
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

pub(super) fn header_columns_from_path(
    path: &std::path::Path,
    delimiter: u8,
) -> Result<Vec<String>, String> {
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
