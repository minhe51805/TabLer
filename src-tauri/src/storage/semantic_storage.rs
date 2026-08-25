use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, Write};
use std::path::PathBuf;
use uuid::Uuid;

/// A curated business- semantics entry the agent reads before analyzing data:
/// what a term means, how a metric is computed, or what an alias maps to.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticEntry {
    pub id: String,
    #[serde(default)]
    pub connection_id: Option<String>,
    #[serde(default)]
    pub database: Option<String>,
    /// Short lookup key, e.g. "revenue" or "campaigns".
    pub term: String,
    /// Verified meaning, e.g. "sum(amount) where status='paid'; cancelled orders excluded".
    pub definition: String,
    /// term | metric | relationship | alias
    #[serde(default = "default_kind")]
    pub kind: String,
    /// "user" when curated manually, "agent" when proposed by the assistant.
    #[serde(default = "default_source")]
    pub source: String,
    pub created_at: String,
    pub updated_at: String,
}

fn default_kind() -> String {
    "term".to_string()
}

fn default_source() -> String {
    "user".to_string()
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn normalize(value: &str) -> String {
    value.trim().to_lowercase()
}

/// In-memory cache of glossary entries keyed by ID.
pub struct SemanticStorage {
    file_path: PathBuf,
    cache: HashMap<String, SemanticEntry>,
}

impl SemanticStorage {
    pub fn new() -> Result<Self, String> {
        let data_dir = crate::utils::paths::resolve_data_dir().map_err(|e| e.to_string())?;
        fs::create_dir_all(&data_dir)
            .map_err(|e| format!("Failed to create data directory: {e}"))?;

        let file_path = data_dir.join("semantic_glossary.json");
        if !file_path.exists() {
            fs::write(&file_path, "[]")
                .map_err(|e| format!("Failed to create semantic glossary file: {e}"))?;
        }

        let cache = Self::load_from_file(&file_path)?;
        Ok(Self { file_path, cache })
    }

    fn load_from_file(path: &PathBuf) -> Result<HashMap<String, SemanticEntry>, String> {
        let file =
            File::open(path).map_err(|e| format!("Failed to open semantic glossary file: {e}"))?;
        let reader = BufReader::new(file);
        let items: Vec<SemanticEntry> = serde_json::from_reader(reader)
            .map_err(|e| format!("Failed to parse semantic glossary: {e}"))?;
        Ok(items
            .into_iter()
            .map(|entry| (entry.id.clone(), entry))
            .collect())
    }

    fn persist(&self) -> Result<(), String> {
        let items: Vec<&SemanticEntry> = self.cache.values().collect();
        let json = serde_json::to_string_pretty(&items)
            .map_err(|e| format!("Failed to serialize semantic glossary: {e}"))?;

        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&self.file_path)
            .map_err(|e| format!("Failed to open semantic glossary file for write: {e}"))?;

        file.write_all(json.as_bytes())
            .map_err(|e| format!("Failed to write semantic glossary: {e}"))?;
        Ok(())
    }

    /// Entries visible in a scope: exact connection+database matches first,
    /// then connection-wide entries (saved without a database).
    pub fn get_for_scope(&self, connection_id: &str, database: Option<&str>) -> Vec<SemanticEntry> {
        let normalized_db = database.map(normalize);
        let mut items: Vec<SemanticEntry> = self
            .cache
            .values()
            .filter(|entry| {
                if entry.connection_id.as_deref().map(normalize).as_deref() != Some(connection_id) {
                    return false;
                }
                match (&entry.database, &normalized_db) {
                    (Some(entry_db), Some(current_db)) => normalize(entry_db) == *current_db,
                    (None, _) => true,
                    // A db-scoped entry is not visible from another database context.
                    (Some(_), None) => true,
                }
            })
            .cloned()
            .collect();
        items.sort_by(|a, b| a.term.to_lowercase().cmp(&b.term.to_lowercase()));
        items
    }

    pub fn save(&mut self, mut entry: SemanticEntry) -> Result<SemanticEntry, String> {
        entry.term = entry.term.trim().to_string();
        entry.definition = entry.definition.trim().to_string();
        if entry.term.is_empty() || entry.definition.is_empty() {
            return Err("Semantic entry requires non-empty term and definition.".to_string());
        }

        let timestamp = now_iso();
        if entry.id.is_empty() {
            entry.id = Uuid::new_v4().to_string();
            entry.created_at = timestamp.clone();
        } else if !self.cache.contains_key(&entry.id) {
            return Err(format!("Semantic entry not found: {}", entry.id));
        }
        entry.updated_at = timestamp;
        self.cache.insert(entry.id.clone(), entry.clone());
        self.persist()?;
        Ok(entry)
    }

    pub fn delete(&mut self, id: &str) -> Result<(), String> {
        if self.cache.remove(id).is_none() {
            return Err(format!("Semantic entry not found: {id}"));
        }
        self.persist()?;
        Ok(())
    }
}

// ─── Tauri Commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_semantic_entries(
    connection_id: String,
    database: Option<String>,
) -> Result<Vec<SemanticEntry>, String> {
    let storage = SemanticStorage::new()?;
    Ok(storage.get_for_scope(&connection_id, database.as_deref()))
}

#[tauri::command]
pub fn save_semantic_entry(
    id: Option<String>,
    connection_id: Option<String>,
    database: Option<String>,
    term: String,
    definition: String,
    kind: Option<String>,
    source: Option<String>,
) -> Result<SemanticEntry, String> {
    let mut storage = SemanticStorage::new()?;
    storage.save(SemanticEntry {
        id: id.unwrap_or_default(),
        connection_id,
        database,
        term,
        definition,
        kind: kind.unwrap_or_else(default_kind),
        source: source.unwrap_or_else(default_source),
        created_at: String::new(),
        updated_at: String::new(),
    })
}

#[tauri::command]
pub fn delete_semantic_entry(id: String) -> Result<(), String> {
    let mut storage = SemanticStorage::new()?;
    storage.delete(&id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_storage() -> SemanticStorage {
        let root = std::env::temp_dir().join(format!("tabler-semantic-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("failed to create temp dir");
        SemanticStorage {
            file_path: root.join("semantic_glossary.json"),
            cache: HashMap::new(),
        }
    }

    fn entry(term: &str, definition: &str, database: Option<&str>) -> SemanticEntry {
        SemanticEntry {
            id: String::new(),
            connection_id: Some("conn-1".to_string()),
            database: database.map(ToString::to_string),
            term: term.to_string(),
            definition: definition.to_string(),
            kind: "term".to_string(),
            source: "agent".to_string(),
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn scope_lookup_includes_connection_wide_entries_and_exact_database_matches() {
        let mut storage = temp_storage();
        let wide = storage.save(entry("revenue", "sum(amount)", None)).unwrap();
        let scoped = storage
            .save(entry("campaign", "marketing table", Some("ant_language")))
            .unwrap();
        let other_conn = storage.save(entry("other", "other conn", None)).unwrap();
        storage.cache.get_mut(&other_conn.id).unwrap().connection_id = Some("conn-2".to_string());

        let visible = storage.get_for_scope("conn-1", Some("Ant_Language"));
        let terms: Vec<&str> = visible.iter().map(|e| e.term.as_str()).collect();
        assert_eq!(terms.len(), 2);
        assert!(terms.contains(&wide.term.as_str()));
        assert!(terms.contains(&scoped.term.as_str()));
    }

    #[test]
    fn save_rejects_blank_terms_and_updates_existing_entries() {
        let mut storage = temp_storage();
        assert!(storage.save(entry("  ", "def", None)).is_err());

        let saved = storage
            .save(entry("users", "end-user accounts", None))
            .unwrap();
        let updated = storage
            .save(SemanticEntry {
                definition: "registered end users only".to_string(),
                ..saved.clone()
            })
            .unwrap();
        assert_eq!(updated.id, saved.id);
        assert_eq!(storage.cache.len(), 1);
        assert_eq!(updated.definition, "registered end users only");
    }
}
