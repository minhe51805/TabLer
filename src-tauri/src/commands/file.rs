use rfd::FileDialog;
use std::fs;
use std::path::PathBuf;

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
    let content = fs::read_to_string(&file_path)
        .map_err(|e| format!("Failed to read file: {e}"))?;

    let file_name = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();

    Ok(SqlFileContent {
        file_name,
        content,
    })
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
pub struct DatabaseFileSelection {
    pub file_name: String,
    pub file_path: String,
}
