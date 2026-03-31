use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, Write};
use std::path::PathBuf;

/// A named SQL snippet saved by the user.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlFavorite {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub sql: String,
    pub tags: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// In-memory cache of all favorites, keyed by ID.
#[derive(Clone)]
pub struct SqlFavoritesStorage {
    file_path: PathBuf,
    cache: HashMap<String, SqlFavorite>,
}

impl SqlFavoritesStorage {
    pub fn new() -> Result<Self, String> {
        let data_dir = dirs::data_dir()
            .ok_or_else(|| "Cannot find user data directory".to_string())?
            .join("TableR");

        fs::create_dir_all(&data_dir)
            .map_err(|e| format!("Failed to create data directory: {e}"))?;

        let file_path = data_dir.join("sql_favorites.json");

        // Ensure file exists
        if !file_path.exists() {
            fs::write(&file_path, "[]")
                .map_err(|e| format!("Failed to create sql_favorites file: {e}"))?;
        }

        let cache = Self::load_from_file(&file_path)?;
        Ok(Self { file_path, cache })
    }

    fn load_from_file(path: &PathBuf) -> Result<HashMap<String, SqlFavorite>, String> {
        let file = File::open(path)
            .map_err(|e| format!("Failed to open sql_favorites file: {e}"))?;
        let reader = BufReader::new(file);
        let items: Vec<SqlFavorite> = serde_json::from_reader(reader)
            .map_err(|e| format!("Failed to parse sql_favorites: {e}"))?;
        Ok(items.into_iter().map(|f| (f.id.clone(), f)).collect())
    }

    fn persist(&self) -> Result<(), String> {
        let items: Vec<&SqlFavorite> = self.cache.values().collect();
        let json = serde_json::to_string_pretty(&items)
            .map_err(|e| format!("Failed to serialize favorites: {e}"))?;

        let mut file = OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&self.file_path)
            .map_err(|e| format!("Failed to open sql_favorites file for write: {e}"))?;

        file.write_all(json.as_bytes())
            .map_err(|e| format!("Failed to write sql_favorites: {e}"))?;

        Ok(())
    }

    pub fn get_all(&self) -> Vec<SqlFavorite> {
        let mut items: Vec<SqlFavorite> = self.cache.values().cloned().collect();
        items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        items
    }

    #[allow(dead_code)]
    pub fn get(&self, id: &str) -> Option<SqlFavorite> {
        self.cache.get(id).cloned()
    }

    pub fn save(&mut self, mut favorite: SqlFavorite) -> Result<SqlFavorite, String> {
        if favorite.id.is_empty() {
            favorite.id = uuid::Uuid::new_v4().to_string();
            favorite.created_at = chrono::Utc::now().to_rfc3339();
        }
        favorite.updated_at = chrono::Utc::now().to_rfc3339();
        self.cache.insert(favorite.id.clone(), favorite.clone());
        self.persist()?;
        Ok(favorite)
    }

    pub fn delete(&mut self, id: &str) -> Result<(), String> {
        if self.cache.remove(id).is_none() {
            return Err(format!("Favorite not found: {id}"));
        }
        self.persist()?;
        Ok(())
    }
}

// ─── Tauri Commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_sql_favorites() -> Result<Vec<SqlFavorite>, String> {
    let storage = SqlFavoritesStorage::new()?;
    Ok(storage.get_all())
}

#[tauri::command]
pub fn save_sql_favorite(
    id: Option<String>,
    name: String,
    description: Option<String>,
    sql: String,
    tags: Option<Vec<String>>,
) -> Result<SqlFavorite, String> {
    let mut storage = SqlFavoritesStorage::new()?;
    storage.save(SqlFavorite {
        id: id.unwrap_or_default(),
        name,
        description,
        sql,
        tags: tags.unwrap_or_default(),
        created_at: String::new(),
        updated_at: String::new(),
    })
}

#[tauri::command]
pub fn delete_sql_favorite(id: String) -> Result<(), String> {
    let mut storage = SqlFavoritesStorage::new()?;
    storage.delete(&id)
}
