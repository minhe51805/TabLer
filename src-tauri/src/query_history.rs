use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// Query history entry stored in the local JSON Lines file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryHistoryEntry {
    pub id: Option<i64>,
    pub connection_id: String,
    pub query_text: String,
    pub executed_at: String,
    pub duration_ms: i64,
    pub row_count: Option<i64>,
    pub error: Option<String>,
    pub database: Option<String>,
}

/// Query history storage backed by a local JSON Lines file.
#[derive(Clone)]
pub struct QueryHistoryStorage {
    file_path: PathBuf,
    next_id: Arc<Mutex<i64>>,
}

impl QueryHistoryStorage {
    pub fn new() -> Result<Self, String> {
        let data_dir = dirs::data_dir()
            .ok_or_else(|| "Cannot find user data directory".to_string())?
            .join("TableR");

        fs::create_dir_all(&data_dir)
            .map_err(|e| format!("Failed to create data directory: {e}"))?;

        let file_path = data_dir.join("query_history.jsonl");

        // Ensure file exists
        if !file_path.exists() {
            fs::write(&file_path, "")
                .map_err(|e| format!("Failed to create query history file: {e}"))?;
        }

        // Count existing entries to determine next ID
        let count = count_lines(&file_path)
            .map_err(|e| format!("Failed to read query history: {e}"))?;

        Ok(Self {
            file_path,
            next_id: Arc::new(Mutex::new(count as i64 + 1)),
        })
    }

    pub fn save_entry(&self, entry: &mut QueryHistoryEntry) -> Result<i64, String> {
        let id = {
            let mut guard = self.next_id.lock()
                .map_err(|_| "Lock poisoned".to_string())?;
            let id = *guard;
            *guard += 1;
            id
        };

        entry.id = Some(id);

        let json = serde_json::to_string(entry)
            .map_err(|e| format!("Failed to serialize entry: {e}"))?;

        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.file_path)
            .map_err(|e| format!("Failed to open query history file: {e}"))?;

        writeln!(file, "{}", json)
            .map_err(|e| format!("Failed to write entry: {e}"))?;

        Ok(id)
    }

    pub fn get_entries(
        &self,
        connection_id: Option<&str>,
        search: Option<&str>,
        limit: u32,
    ) -> Result<Vec<QueryHistoryEntry>, String> {
        let file = File::open(&self.file_path)
            .map_err(|e| format!("Failed to open query history file: {e}"))?;

        let reader = BufReader::new(file);
        let mut results = Vec::new();

        for line in reader.lines() {
            let line = line.map_err(|e| format!("Failed to read line: {e}"))?;
            if line.trim().is_empty() {
                continue;
            }

            let entry: QueryHistoryEntry = match serde_json::from_str(&line) {
                Ok(e) => e,
                Err(_) => continue,
            };

            // Filter by connection_id
            if let Some(cid) = connection_id {
                if entry.connection_id != cid {
                    continue;
                }
            }

            // Filter by search
            if let Some(search_term) = search {
                if !entry.query_text.to_lowercase().contains(&search_term.to_lowercase()) {
                    continue;
                }
            }

            results.push(entry);

            if results.len() >= limit as usize {
                break;
            }
        }

        // Already sorted by newest first (append-only), reverse to show newest at top
        results.reverse();
        Ok(results)
    }
}

fn count_lines(path: &PathBuf) -> Result<usize, std::io::Error> {
    let file = File::open(path)?;
    let reader = BufReader::new(file);
    Ok(reader.lines().count())
}

// ─── Tauri Commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn save_query_history(entry: QueryHistoryEntry) -> Result<i64, String> {
    let storage = QueryHistoryStorage::new()?;
    let mut entry = entry;
    storage.save_entry(&mut entry)
}

#[tauri::command]
pub fn get_query_history(
    connection_id: Option<String>,
    search: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<QueryHistoryEntry>, String> {
    let storage = QueryHistoryStorage::new()?;
    storage.get_entries(
        connection_id.as_deref(),
        search.as_deref(),
        limit.unwrap_or(500),
    )
}
