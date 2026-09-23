use crate::storage::file_storage::write_json_atomically;
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex};

/// Password-carrying clauses whose string literal must never be persisted in
/// plaintext history: `IDENTIFIED BY 'x'`, `IDENTIFIED WITH ... BY 'x'`,
/// `PASSWORD 'x'` / `PASSWORD = 'x'`, `PASSWD = 'x'`. Other literals stay
/// intact so history remains usable.
static PASSWORD_LITERAL_PATTERN: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(
        r"(?i)(\bidentified\s+with\s+\S+\s+by|\bidentified\s+by|\bpassword|\bpasswd)(\s*=\s*|\s+|\(\s*)'(?:''|[^'])*'",
    )
    .expect("password literal redaction pattern must compile")
});

/// Replace the string literal in password-carrying clauses with `'***'`.
pub(crate) fn redact_password_literals(query_text: &str) -> String {
    PASSWORD_LITERAL_PATTERN
        .replace_all(query_text, "$1$2'***'")
        .into_owned()
}

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
        let data_dir =
            crate::utils::paths::resolve_data_dir().map_err(|error| error.to_string())?;

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

        let next_id =
            next_entry_id(&file_path).map_err(|e| format!("Failed to read query history: {e}"))?;

        Ok(Self {
            file_path,
            next_id: Arc::new(Mutex::new(next_id)),
        })
    }

    pub fn save_entry(&self, entry: &mut QueryHistoryEntry) -> Result<i64, String> {
        let id = {
            let mut guard = self
                .next_id
                .lock()
                .map_err(|_| "Lock poisoned".to_string())?;
            let id = *guard;
            *guard += 1;
            id
        };

        entry.id = Some(id);
        // Never persist credentials: redact the literal in password-carrying
        // statements (CREATE USER ... IDENTIFIED BY '...', ALTER ... PASSWORD
        // '...', ...) before the entry hits disk.
        entry.query_text = redact_password_literals(&entry.query_text);

        let json =
            serde_json::to_string(entry).map_err(|e| format!("Failed to serialize entry: {e}"))?;

        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.file_path)
            .map_err(|e| format!("Failed to open query history file: {e}"))?;

        writeln!(file, "{}", json).map_err(|e| format!("Failed to write entry: {e}"))?;

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
                if !entry
                    .query_text
                    .to_lowercase()
                    .contains(&search_term.to_lowercase())
                {
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
        let entry_ids = entry_ids
            .iter()
            .copied()
            .collect::<std::collections::HashSet<_>>();
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
        // Rewrite through the shared atomic-write helper (temp file + fsync +
        // rename, previous contents rotated to `.bak`) instead of truncating
        // the file in place — a crash mid-rewrite must not lose all history.
        let mut json = String::new();
        for entry in entries {
            let line = serde_json::to_string(entry)
                .map_err(|e| format!("Failed to serialize query history entry: {e}"))?;
            json.push_str(&line);
            json.push('\n');
        }
        write_json_atomically(&self.file_path, &json)
            .map_err(|e| format!("Failed to rewrite query history file: {e}"))?;
        let next_id = entries
            .iter()
            .filter_map(|entry| entry.id)
            .max()
            .unwrap_or(0)
            + 1;
        let mut guard = self
            .next_id
            .lock()
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

/// Shared storage instance. Building one per command call re-scanned the
/// whole JSONL file to recover the next id on every save; keeping a process-
/// wide instance recovers it once and reuses the id counter afterwards.
static QUERY_HISTORY_STORAGE: std::sync::OnceLock<Result<QueryHistoryStorage, String>> =
    std::sync::OnceLock::new();

fn shared_storage() -> Result<QueryHistoryStorage, String> {
    QUERY_HISTORY_STORAGE
        .get_or_init(QueryHistoryStorage::new)
        .clone()
}

#[tauri::command]
pub async fn save_query_history(entry: QueryHistoryEntry) -> Result<i64, String> {
    let storage = shared_storage()?;
    let mut entry = entry;
    storage.save_entry(&mut entry)
}

#[tauri::command]
pub async fn get_query_history(
    connection_id: Option<String>,
    search: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<QueryHistoryEntry>, String> {
    let storage = shared_storage()?;
    storage.get_entries(
        connection_id.as_deref(),
        search.as_deref(),
        limit.unwrap_or(500),
    )
}

#[tauri::command]
pub async fn delete_query_history_entry(entry_id: i64) -> Result<bool, String> {
    let storage = shared_storage()?;
    storage.delete_entry(entry_id)
}

#[tauri::command]
pub async fn delete_query_history_entries(entry_ids: Vec<i64>) -> Result<usize, String> {
    let storage = shared_storage()?;
    storage.delete_entries(&entry_ids)
}

#[tauri::command]
pub async fn clear_query_history(connection_id: Option<String>) -> Result<usize, String> {
    let storage = shared_storage()?;
    storage.clear_entries(connection_id.as_deref())
}

#[cfg(test)]
mod tests {
    use super::{redact_password_literals, QueryHistoryEntry, QueryHistoryStorage};
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
        let storage =
            QueryHistoryStorage::new_with_file(path.clone()).expect("storage should initialize");

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
        let storage =
            QueryHistoryStorage::new_with_file(path.clone()).expect("storage should initialize");

        let mut first = sample_entry("conn-a", "select 1", "2026-04-02T00:00:00Z");
        let mut second = sample_entry("conn-a", "select 2", "2026-04-02T00:01:00Z");

        let first_id = storage.save_entry(&mut first).expect("first save");
        storage.save_entry(&mut second).expect("second save");

        let deleted = storage
            .delete_entry(first_id)
            .expect("delete should succeed");
        assert!(deleted);

        let mut third = sample_entry("conn-a", "select 3", "2026-04-02T00:02:00Z");
        let third_id = storage.save_entry(&mut third).expect("third save");
        assert_eq!(third_id, 3);

        let entries = storage
            .get_entries(Some("conn-a"), None, 10)
            .expect("history should load");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].query_text, "select 3");
        assert_eq!(entries[1].query_text, "select 2");

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn clear_entries_can_target_one_connection() {
        let path = temp_history_path();
        let storage =
            QueryHistoryStorage::new_with_file(path.clone()).expect("storage should initialize");

        let mut conn_a = sample_entry("conn-a", "select 1", "2026-04-02T00:00:00Z");
        let mut conn_b = sample_entry("conn-b", "select 2", "2026-04-02T00:01:00Z");

        storage.save_entry(&mut conn_a).expect("save conn-a");
        storage.save_entry(&mut conn_b).expect("save conn-b");

        let removed = storage
            .clear_entries(Some("conn-a"))
            .expect("clear should succeed");
        assert_eq!(removed, 1);

        let conn_a_entries = storage
            .get_entries(Some("conn-a"), None, 10)
            .expect("conn-a history");
        let conn_b_entries = storage
            .get_entries(Some("conn-b"), None, 10)
            .expect("conn-b history");
        assert!(conn_a_entries.is_empty());
        assert_eq!(conn_b_entries.len(), 1);
        assert_eq!(conn_b_entries[0].query_text, "select 2");

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn save_entry_redacts_password_literals() {
        let path = temp_history_path();
        let storage =
            QueryHistoryStorage::new_with_file(path.clone()).expect("storage should initialize");

        let mut entry = sample_entry(
            "conn-a",
            "CREATE USER 'app'@'%' IDENTIFIED BY 'sup3r-secret'; ALTER USER 'app'@'%' IDENTIFIED WITH mysql_native_password BY 'an0ther-secret'",
            "2026-04-02T00:00:00Z",
        );
        storage.save_entry(&mut entry).expect("save should succeed");

        let on_disk = std::fs::read_to_string(&path).expect("history file should read");
        assert!(!on_disk.contains("sup3r-secret"));
        assert!(!on_disk.contains("an0ther-secret"));
        assert!(on_disk.contains("IDENTIFIED BY '***'"));
        assert!(on_disk.contains("BY '***'"));

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn redact_password_literals_keeps_other_literals() {
        let redacted = redact_password_literals(
            "SELECT * FROM users WHERE name = 'password' AND note = 'keep me'",
        );
        assert_eq!(
            redacted,
            "SELECT * FROM users WHERE name = 'password' AND note = 'keep me'"
        );

        let redacted = redact_password_literals("SET PASSWORD = 'p@ss'; SELECT 'x'");
        assert_eq!(redacted, "SET PASSWORD = '***'; SELECT 'x'");
    }

    #[test]
    fn delete_entries_can_remove_multiple_records() {
        let path = temp_history_path();
        let storage =
            QueryHistoryStorage::new_with_file(path.clone()).expect("storage should initialize");

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

        let entries = storage
            .get_entries(Some("conn-a"), None, 10)
            .expect("history should load");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].query_text, "select 2");

        let _ = std::fs::remove_file(path);
    }
}
