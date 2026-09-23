//! CSV import: delimiter sniffing, bounded sampling/counting, header
//! detection, and cell decoding for the `\N` NULL marker.
//!
//! Only a small file prefix is read for delimiter detection; sampling/counting
//! streams the file so preview cost stays independent of total size.

use super::DELIMITER_SNIFF_BYTES;
use serde::Serialize;
use std::io::Read;

/// Candidate delimiters, most common first. Pipe is included because
/// pipe-delimited exports are common from Postgres/BI tools.
const DELIMITER_CANDIDATES: [u8; 4] = *b",;\t|";

/// The NULL marker used by TableR CSV exports (Postgres COPY convention).
/// A literal `\N` in source data is written as `\\N` by the exporter and
/// decoded back here.
pub(crate) const CSV_NULL_MARKER: &str = "\\N";

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
    /// Backend guess for "first row is a header". When false the preview
    /// shows positional column names and row 1 stays in the data rows, so a
    /// headerless file never silently loses its first record.
    pub has_header: bool,
}

/// Picks the most plausible delimiter from a raw file prefix.
///
/// Every candidate is scored across ALL sampled lines (not just the first):
/// a delimiter that appears on several lines beats one that shows up once,
/// which keeps a stray `;` or `|` inside a single cell from winning. Quote
/// state is tracked per line so delimiters inside "quoted,cells" don't count.
pub fn detect_delimiter(prefix: &str) -> u8 {
    let mut scores = [0usize; DELIMITER_CANDIDATES.len()];
    for line in prefix.lines() {
        let mut counts = [0usize; DELIMITER_CANDIDATES.len()];
        let mut in_quotes = false;
        let mut chars = line.chars().peekable();
        while let Some(ch) = chars.next() {
            match ch {
                // RFC 4180 escaped quote inside a quoted field.
                '"' if in_quotes && chars.peek() == Some(&'"') => {
                    chars.next();
                }
                '"' => in_quotes = !in_quotes,
                _ if in_quotes => {}
                _ => {
                    if let Some(index) = DELIMITER_CANDIDATES.iter().position(|c| *c == ch as u8) {
                        counts[index] += 1;
                    }
                }
            }
        }
        // A line with N fields contributes N-1 separators; weight every line
        // equally so one long line cannot dominate the vote.
        for (index, count) in counts.iter().enumerate() {
            if *count > 0 {
                scores[index] += 1;
            }
        }
    }
    let (best_index, _) = scores
        .iter()
        .enumerate()
        .max_by_key(|(_, score)| **score)
        .unwrap();
    DELIMITER_CANDIDATES[best_index]
}

/// Reads only the first bytes of the file for delimiter sniffing — a 10 GB
/// file costs the same 8 KB read as a 10 KB one. A UTF-8 BOM is skipped;
/// UTF-16 files are rejected with a clear message instead of being sniffed
/// as garbage.
pub(super) fn sniff_delimiter_from_file(path: &std::path::Path) -> Result<u8, String> {
    let file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut prefix = Vec::new();
    file.take(DELIMITER_SNIFF_BYTES)
        .read_to_end(&mut prefix)
        .map_err(|error| error.to_string())?;
    let prefix = strip_text_bom(&prefix)?;
    let prefix = String::from_utf8_lossy(prefix);
    Ok(detect_delimiter(&prefix))
}

/// Strips a UTF-8 BOM and rejects UTF-16/UTF-32 encoded files up front so a
/// BOM never lands in the first header cell and non-UTF-8 files fail with a
/// readable message instead of mojibake.
pub(crate) fn strip_text_bom(bytes: &[u8]) -> Result<&[u8], String> {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return Ok(&bytes[3..]);
    }
    if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        return Err(
            "The file looks UTF-16 encoded; save it as UTF-8 before importing.".to_string(),
        );
    }
    if bytes.starts_with(&[0x00, 0x00, 0xFE, 0xFF]) || bytes.starts_with(&[0xFF, 0xFE, 0x00, 0x00])
    {
        return Err(
            "The file looks UTF-32 encoded; save it as UTF-8 before importing.".to_string(),
        );
    }
    Ok(bytes)
}

/// Decodes one CSV cell for import: `\N` becomes SQL NULL and `\\N` (the
/// exporter's escape for a literal `\N`) becomes the text `\N`. Every other
/// value passes through unchanged, so only cells that are exactly a run of
/// backslashes followed by `N` are affected.
pub(crate) fn decode_csv_cell(raw: &str) -> Option<String> {
    if raw == CSV_NULL_MARKER {
        return None;
    }
    // `\\+N` (two or more backslashes then N) unescapes one level.
    if raw.len() >= 3 && raw.ends_with('N') && raw[..raw.len() - 1].chars().all(|ch| ch == '\\') {
        return Some(raw[1..].to_string());
    }
    Some(raw.to_string())
}

/// Guesses whether the first record is a header row. The signal: a header
/// row is mostly non-numeric text while data rows repeat the same typed
/// shape. When the first row parses entirely as numbers/empty cells it is
/// almost certainly data, so the preview switches to headerless mode and
/// keeps row 1 instead of eating it as column names.
pub(crate) fn looks_like_header(first: &[String], second: Option<&[String]>) -> bool {
    if first.is_empty() {
        return false;
    }
    let numeric_cells = first
        .iter()
        .filter(|cell| cell.trim().is_empty() || cell.trim().parse::<f64>().is_ok())
        .count();
    if numeric_cells == first.len() {
        return false;
    }
    // All-text first row: header when a second row exists and differs in
    // shape (has numeric cells); a lone all-text row is ambiguous — treat it
    // as a header so single-line files keep their labels.
    match second {
        Some(second) => {
            let second_numeric = second
                .iter()
                .filter(|cell| cell.trim().is_empty() || cell.trim().parse::<f64>().is_ok())
                .count();
            second_numeric > 0 || first.iter().any(|cell| !cell.trim().is_empty())
        }
        None => true,
    }
}

/// Positional fallback column names for headerless imports.
pub(crate) fn positional_columns(width: usize) -> Vec<String> {
    (1..=width).map(|index| format!("column_{index}")).collect()
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

/// Reads the first `cap` records (including a would-be header) so the caller
/// can run header detection and still show row 1 when it is data.
pub(super) fn sample_prefix_rows<R: std::io::Read>(
    mut reader: csv::Reader<R>,
    cap: usize,
) -> Result<Vec<Vec<String>>, String> {
    let mut rows = Vec::new();
    for record in reader.records().take(cap) {
        let record = record.map_err(|error| format!("CSV parse error: {error}"))?;
        rows.push(record.iter().map(str::to_string).collect());
    }
    Ok(rows)
}
