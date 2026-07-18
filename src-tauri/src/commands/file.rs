use rfd::FileDialog;
use std::fs;
use std::io::Read;
use std::path::PathBuf;

const CSV_PREVIEW_RECORD_LIMIT: usize = 200;

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
    let delimiter = detect_csv_delimiter(&file_path)?;
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .has_headers(false)
        .flexible(true)
        .from_path(&file_path)
        .map_err(|e| format!("Failed to open delimited file: {e}"))?;
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
        is_truncated: reader.position().byte() < metadata.len(),
        delimiter: if delimiter == b'\t' { "tsv" } else { "csv" }.to_string(),
    })
}

fn detect_csv_delimiter(file_path: &PathBuf) -> Result<u8, String> {
    let mut file = fs::File::open(file_path).map_err(|e| format!("Failed to open file: {e}"))?;
    let mut sample = vec![0_u8; 8192];
    let read = file
        .read(&mut sample)
        .map_err(|e| format!("Failed to sample file: {e}"))?;
    sample.truncate(read);
    let first_line = sample
        .split(|byte| *byte == b'\n')
        .next()
        .unwrap_or(&sample);
    let tabs = first_line.iter().filter(|byte| **byte == b'\t').count();
    let commas = first_line.iter().filter(|byte| **byte == b',').count();
    Ok(if tabs > 0 && tabs >= commas {
        b'\t'
    } else {
        b','
    })
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
