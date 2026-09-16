//! JSON import: shape detection, stable key collection, object alignment, and
//! NDJSON/array parsing that normalises to the same positional cells as CSV.

use serde::Serialize;
use std::collections::HashSet;
use std::io::{BufReader, Read};

/// Top-level JSON layout of an import file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum JsonShape {
    /// A single top-level array of objects: `[ {..}, {..} ]`.
    Array,
    /// Newline-delimited objects (one JSON object per line).
    Ndjson,
}

impl JsonShape {
    pub(super) fn as_str(self) -> &'static str {
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
pub(super) fn json_shape_from_prefix(prefix: &str) -> Result<JsonShape, String> {
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
pub(super) fn detect_json_shape(path: &std::path::Path) -> Result<JsonShape, String> {
    let file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut buffer = Vec::new();
    file.take(64)
        .read_to_end(&mut buffer)
        .map_err(|error| error.to_string())?;
    json_shape_from_prefix(&String::from_utf8_lossy(&buffer))
}

/// Renders a JSON scalar as a cell string; nested arrays/objects keep their
/// compact JSON text so no data is silently dropped.
pub(super) fn json_value_to_cell(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => String::new(),
        serde_json::Value::String(text) => text.clone(),
        serde_json::Value::Bool(flag) => flag.to_string(),
        serde_json::Value::Number(number) => number.to_string(),
        other => other.to_string(),
    }
}

/// Aligns one object to the fixed column order; missing keys become empty.
pub(super) fn align_object(
    columns: &[String],
    object: &serde_json::Map<String, serde_json::Value>,
) -> Vec<String> {
    columns
        .iter()
        .map(|key| object.get(key).map(json_value_to_cell).unwrap_or_default())
        .collect()
}

/// Records each key the first time it is seen so the column order stays stable.
pub(super) fn collect_keys(
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
pub(super) fn parse_json_object_line(
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
pub(super) fn read_json_array_objects(
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
