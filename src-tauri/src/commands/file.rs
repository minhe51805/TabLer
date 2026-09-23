use rfd::FileDialog;
use std::fs;
use std::path::PathBuf;

/// Preview rows shipped to the import dialog. 1 000 records is still a small
/// bounded read (the csv crate streams, so memory stays flat) but gives the
/// mapping UI enough rows to spot type/format problems a 200-row sample hid.
const CSV_PREVIEW_RECORD_LIMIT: usize = 1_000;

/// Saves exported content through a native save dialog. Anchor downloads
/// (`<a download>` over `blob:` URLs) are silent no-ops inside the Tauri
/// WebView, so every grid export (CSV/JSON/XLSX/MQL/plugins) funnels here:
/// the dialog picks the destination and the bytes are written with std::fs.
/// Binary payloads (e.g. the XLSX workbook) arrive base64-encoded.
#[tauri::command]
pub async fn save_export_file(
    file_name: String,
    content: String,
    filters: Option<Vec<SaveExportFilter>>,
    encoding: Option<String>,
    content_base64: Option<String>,
) -> Result<Option<String>, String> {
    // rfd dialogs must run on the main thread; hop off the async runtime so
    // the blocking dialog never stalls a tokio worker.
    let requested_name = file_name;
    let dialog_filters = filters.unwrap_or_default();
    let target = tokio::task::spawn_blocking(move || {
        let mut dialog = FileDialog::new().set_file_name(&requested_name);
        for filter in &dialog_filters {
            dialog = dialog.add_filter(&filter.name, &filter.extensions);
        }
        dialog.save_file()
    })
    .await
    .map_err(|error| format!("Save dialog failed: {error}"))?;

    let Some(path) = target else {
        // User dismissed the dialog — not an error.
        return Ok(None);
    };
    let saved_path = path.to_string_lossy().to_string();

    let is_base64 = encoding.as_deref() == Some("base64");
    let write_result = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        if is_base64 {
            use base64::Engine as _;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(content_base64.as_deref().unwrap_or_default())
                .map_err(|error| {
                    std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        format!("Invalid base64 export payload: {error}"),
                    )
                })?;
            fs::write(&path, bytes)
        } else {
            fs::write(&path, content)
        }
    })
    .await
    .map_err(|error| format!("Save task failed: {error}"))?;

    write_result.map_err(|error| format!("Failed to write export file: {error}"))?;
    Ok(Some(saved_path))
}

#[derive(serde::Deserialize)]
pub struct SaveExportFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

/// Opens a file picker dialog filtered to SQL/text files and returns the file contents.
/// Returns the full file path and content on success, or an error message.
#[tauri::command]
pub async fn read_sql_file() -> Result<SqlFileContent, String> {
    let file_path = FileDialog::new()
        .add_filter("SQL files", &["sql"])
        .add_filter("Text files", &["txt"])
        .add_filter("All files", &["*"])
        .pick_file()
        .ok_or_else(|| "No file selected.".to_string())?;

    read_file_from_path(file_path)
}

fn read_file_from_path(file_path: PathBuf) -> Result<SqlFileContent, String> {
    let content =
        fs::read_to_string(&file_path).map_err(|e| format!("Failed to read file: {e}"))?;

    let file_name = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();

    Ok(SqlFileContent { file_name, content })
}

/// Reads a SQL file from an explicit path (used for drag-and-drop or recent files).
#[tauri::command]
pub async fn read_sql_file_from_path(path: String) -> Result<SqlFileContent, String> {
    let file_path = PathBuf::from(&path);
    if !file_path.exists() {
        return Err(format!("File not found: {path}"));
    }
    read_file_from_path(file_path)
}

/// Opens a CSV/TSV file for preview. The import pipeline validates and maps its
/// contents in the frontend before a transaction is requested from the backend.
#[tauri::command]
pub async fn read_csv_file() -> Result<CsvFileContent, String> {
    let file_path = FileDialog::new()
        .add_filter("CSV files", &["csv"])
        .add_filter("Delimited text", &["tsv", "txt"])
        .pick_file()
        .ok_or_else(|| "No file selected.".to_string())?;
    read_csv_file_from_path(file_path)
}

fn read_csv_file_from_path(file_path: PathBuf) -> Result<CsvFileContent, String> {
    let metadata = fs::metadata(&file_path).map_err(|e| format!("Failed to inspect file: {e}"))?;
    // Read the raw bytes once so a UTF-8 BOM can be stripped (it would
    // otherwise land inside the first header cell) and UTF-16/32 files fail
    // with a clear message instead of mojibake.
    let raw = fs::read(&file_path).map_err(|e| format!("Failed to open delimited file: {e}"))?;
    let text_bytes = crate::commands::data_import::strip_text_bom(&raw)?;
    let delimiter = detect_csv_delimiter(text_bytes)?;
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .has_headers(false)
        .flexible(true)
        .from_reader(text_bytes);
    let mut writer = csv::WriterBuilder::new()
        .delimiter(delimiter)
        .from_writer(Vec::new());
    let mut preview_records = 0_usize;
    for record in reader.byte_records().take(CSV_PREVIEW_RECORD_LIMIT) {
        let record = record.map_err(|e| format!("Failed to parse preview row: {e}"))?;
        writer
            .write_byte_record(&record)
            .map_err(|e| format!("Failed to build CSV preview: {e}"))?;
        preview_records += 1;
    }
    writer
        .flush()
        .map_err(|e| format!("Failed to finish CSV preview: {e}"))?;
    let content = String::from_utf8(
        writer
            .into_inner()
            .map_err(|e| format!("Failed to finish CSV preview: {e}"))?,
    )
    .map_err(|_| "CSV import requires UTF-8 text.".to_string())?;
    if preview_records == 0 {
        return Err("The selected CSV file does not contain any rows.".to_string());
    }
    Ok(CsvFileContent {
        file_name: file_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string(),
        content,
        byte_size: metadata.len(),
        file_path: file_path.to_string_lossy().to_string(),
        is_truncated: preview_records >= CSV_PREVIEW_RECORD_LIMIT
            && reader.position().byte() < text_bytes.len() as u64,
        delimiter: if delimiter == b'\t' { "tsv" } else { "csv" }.to_string(),
    })
}

/// Shares the import pipeline's multi-line, quote-aware sniffer so the
/// preview and the real import agree on `,` `;` `\t` `|`.
fn detect_csv_delimiter(sample: &[u8]) -> Result<u8, String> {
    let text = String::from_utf8_lossy(sample);
    Ok(crate::commands::data_import::detect_delimiter(&text))
}

#[tauri::command]
pub async fn pick_database_file() -> Result<DatabaseFileSelection, String> {
    let file_path = FileDialog::new()
        .add_filter(
            "Database files",
            &["sqlite", "sqlite3", "db", "db3", "duckdb"],
        )
        .add_filter("SQLite databases", &["sqlite", "sqlite3", "db", "db3"])
        .add_filter("DuckDB databases", &["duckdb"])
        .pick_file()
        .ok_or_else(|| "No file selected.".to_string())?;

    let file_name = file_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("unknown")
        .to_string();

    Ok(DatabaseFileSelection {
        file_name,
        file_path: file_path.to_string_lossy().to_string(),
    })
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlFileContent {
    pub file_name: String,
    pub content: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvFileContent {
    pub file_name: String,
    pub content: String,
    pub byte_size: u64,
    pub file_path: String,
    pub is_truncated: bool,
    pub delimiter: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseFileSelection {
    pub file_name: String,
    pub file_path: String,
}
