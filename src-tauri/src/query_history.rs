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

        Self::new_with_file(data_dir.join("query_history.jsonl"))
    }

    fn new_with_file(file_path: PathBuf) -> Result<Self, String> {
        if let Some(parent) = file_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create query history directory: {e}"))?;
        }

        // Ensure file exists
        if !file_path.exists() {
            fs::write(&file_path, "")
                .map_err(|e| format!("Failed to create query history file: {e}"))?;
        }

        let next_id = next_entry_id(&file_path)
            .map_err(|e| format!("Failed to read query history: {e}"))?;

        Ok(Self {
            file_path,
            next_id: Arc::new(Mutex::new(next_id)),
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
        let mut results = Vec::new();

        for entry in self.read_all_entries()? {
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
        }

        results.reverse();
        if results.len() > limit as usize {
            results.truncate(limit as usize);
        }

        Ok(results)
    }

    pub fn delete_entry(&self, entry_id: i64) -> Result<bool, String> {
        self.delete_entries(&[entry_id]).map(|removed| removed > 0)
    }

    pub fn delete_entries(&self, entry_ids: &[i64]) -> Result<usize, String> {
        if entry_ids.is_empty() {
            return Ok(0);
        }

        let entries = self.read_all_entries()?;
        let original_len = entries.len();
        let entry_ids = entry_ids.iter().copied().collect::<std::collections::HashSet<_>>();
        let filtered: Vec<QueryHistoryEntry> = entries
            .into_iter()
            .filter(|entry| entry.id.map(|id| !entry_ids.contains(&id)).unwrap_or(true))
            .collect();

        let removed = original_len.saturating_sub(filtered.len());
        if removed == 0 {
            return Ok(0);
        }

        self.rewrite_entries(&filtered)?;
        Ok(removed)
    }

    pub fn clear_entries(&self, connection_id: Option<&str>) -> Result<usize, String> {
        let entries = self.read_all_entries()?;
        let original_len = entries.len();
        let filtered: Vec<QueryHistoryEntry> = match connection_id {
            Some(target_connection_id) => entries
                .into_iter()
                .filter(|entry| entry.connection_id != target_connection_id)
                .collect(),
            None => Vec::new(),
        };

        let removed = original_len.saturating_sub(filtered.len());
        if removed == 0 {
            return Ok(0);
        }

        self.rewrite_entries(&filtered)?;
        Ok(removed)
    }

    fn read_all_entries(&self) -> Result<Vec<QueryHistoryEntry>, String> {
        let file = File::open(&self.file_path)
            .map_err(|e| format!("Failed to open query history file: {e}"))?;

        let reader = BufReader::new(file);
        let mut entries = Vec::new();

        for line in reader.lines() {
            let line = line.map_err(|e| format!("Failed to read line: {e}"))?;
            if line.trim().is_empty() {
                continue;
            }

            let entry: QueryHistoryEntry = match serde_json::from_str(&line) {
                Ok(entry) => entry,
                Err(_) => continue,
            };

            entries.push(entry);
        }

        Ok(entries)
    }

    fn rewrite_entries(&self, entries: &[QueryHistoryEntry]) -> Result<(), String> {
        let mut file = File::create(&self.file_path)
            .map_err(|e| format!("Failed to rewrite query history file: {e}"))?;

        for entry in entries {
            let json = serde_json::to_string(entry)
                .map_err(|e| format!("Failed to serialize query history entry: {e}"))?;
            writeln!(file, "{json}")
                .map_err(|e| format!("Failed to persist query history entry: {e}"))?;
        }

        let next_id = entries
            .iter()
            .filter_map(|entry| entry.id)
            .max()
            .unwrap_or(0)
            + 1;
        let mut guard = self.next_id.lock()
            .map_err(|_| "Lock poisoned".to_string())?;
        *guard = next_id;

        Ok(())
    }
}

fn next_entry_id(path: &PathBuf) -> Result<i64, std::io::Error> {
    let file = File::open(path)?;
    let reader = BufReader::new(file);
    let mut max_id = 0_i64;

    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }

        if let Ok(entry) = serde_json::from_str::<QueryHistoryEntry>(&line) {
            if let Some(id) = entry.id {
                max_id = max_id.max(id);
            }
        }
    }

    Ok(max_id + 1)
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

#[tauri::command]
pub fn delete_query_history_entry(entry_id: i64) -> Result<bool, String> {
    let storage = QueryHistoryStorage::new()?;
    storage.delete_entry(entry_id)
}

#[tauri::command]
pub fn delete_query_history_entries(entry_ids: Vec<i64>) -> Result<usize, String> {
    let storage = QueryHistoryStorage::new()?;
    storage.delete_entries(&entry_ids)
}

#[tauri::command]
pub fn clear_query_history(connection_id: Option<String>) -> Result<usize, String> {
    let storage = QueryHistoryStorage::new()?;
    storage.clear_entries(connection_id.as_deref())
}

#[cfg(test)]
mod tests {
    use super::{QueryHistoryEntry, QueryHistoryStorage};
    use std::path::PathBuf;
    use uuid::Uuid;

    fn temp_history_path() -> PathBuf {
        std::env::temp_dir()
            .join("tabler-query-history-tests")
            .join(format!("{}.jsonl", Uuid::new_v4()))
    }

    fn sample_entry(connection_id: &str, query_text: &str, executed_at: &str) -> QueryHistoryEntry {
        QueryHistoryEntry {
            id: None,
            connection_id: connection_id.to_string(),
            query_text: query_text.to_string(),
            executed_at: executed_at.to_string(),
            duration_ms: 12,
            row_count: Some(1),
            error: None,
            database: Some("app".to_string()),
        }
    }

    #[test]
    fn get_entries_returns_newest_items_first() {
        let path = temp_history_path();
        let storage = QueryHistoryStorage::new_with_file(path.clone()).expect("storage should initialize");

        let mut first = sample_entry("conn-a", "select 1", "2026-04-02T00:00:00Z");
        let mut second = sample_entry("conn-a", "select 2", "2026-04-02T00:01:00Z");
        let mut third = sample_entry("conn-a", "select 3", "2026-04-02T00:02:00Z");

        storage.save_entry(&mut first).expect("first save");
        storage.save_entry(&mut second).expect("second save");
        storage.save_entry(&mut third).expect("third save");

        let entries = storage
            .get_entries(Some("conn-a"), None, 2)
            .expect("history should load");

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].query_text, "select 3");
        assert_eq!(entries[1].query_text, "select 2");

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn delete_entry_rewrites_file_and_preserves_next_id() {
        let path = temp_history_path();
        let storage = QueryHistoryStorage::new_with_file(path.clone()).expect("storage should initialize");

        let mut first = sample_entry("conn-a", "select 1", "2026-04-02T00:00:00Z");
        let mut second = sample_entry("conn-a", "select 2", "2026-04-02T00:01:00Z");

        let first_id = storage.save_entry(&mut first).expect("first save");
        storage.save_entry(&mut second).expect("second save");

        let deleted = storage.delete_entry(first_id).expect("delete should succeed");
        assert!(deleted);

        let mut third = sample_entry("conn-a", "select 3", "2026-04-02T00:02:00Z");
        let third_id = storage.save_entry(&mut third).expect("third save");
        assert_eq!(third_id, 3);

        let entries = storage.get_entries(Some("conn-a"), None, 10).expect("history should load");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].query_text, "select 3");
        assert_eq!(entries[1].query_text, "select 2");

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn clear_entries_can_target_one_connection() {
        let path = temp_history_path();
        let storage = QueryHistoryStorage::new_with_file(path.clone()).expect("storage should initialize");

        let mut conn_a = sample_entry("conn-a", "select 1", "2026-04-02T00:00:00Z");
        let mut conn_b = sample_entry("conn-b", "select 2", "2026-04-02T00:01:00Z");

        storage.save_entry(&mut conn_a).expect("save conn-a");
        storage.save_entry(&mut conn_b).expect("save conn-b");

        let removed = storage.clear_entries(Some("conn-a")).expect("clear should succeed");
        assert_eq!(removed, 1);

        let conn_a_entries = storage.get_entries(Some("conn-a"), None, 10).expect("conn-a history");
        let conn_b_entries = storage.get_entries(Some("conn-b"), None, 10).expect("conn-b history");
        assert!(conn_a_entries.is_empty());
        assert_eq!(conn_b_entries.len(), 1);
        assert_eq!(conn_b_entries[0].query_text, "select 2");

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn delete_entries_can_remove_multiple_records() {
        let path = temp_history_path();
        let storage = QueryHistoryStorage::new_with_file(path.clone()).expect("storage should initialize");

        let mut first = sample_entry("conn-a", "select 1", "2026-04-02T00:00:00Z");
        let mut second = sample_entry("conn-a", "select 2", "2026-04-02T00:01:00Z");
        let mut third = sample_entry("conn-a", "select 3", "2026-04-02T00:02:00Z");

        let first_id = storage.save_entry(&mut first).expect("first save");
        storage.save_entry(&mut second).expect("second save");
        let third_id = storage.save_entry(&mut third).expect("third save");

        let removed = storage
            .delete_entries(&[first_id, third_id])
            .expect("bulk delete should succeed");
        assert_eq!(removed, 2);

        let entries = storage.get_entries(Some("conn-a"), None, 10).expect("history should load");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].query_text, "select 2");

        let _ = std::fs::remove_file(path);
    }
}
