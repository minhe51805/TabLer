use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::{Row, SqlitePool};
use std::fs;
use std::path::PathBuf;
use std::str::FromStr;

const STORAGE_ROW_KEY: &str = "default";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PersistedAIWorkspaceState {
    pub version: i64,
    pub threads: Vec<AIChatThread>,
    pub bubbles: Vec<AIWorkspaceBubbleData>,
    pub interaction_modes: std::collections::HashMap<String, String>,
    pub active_thread_ids: std::collections::HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AIChatThread {
    pub id: String,
    pub workspace_key: String,
    pub label: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub is_auto_label: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AIWorkspacePointerState {
    pub x: f64,
    pub y: f64,
    pub visible: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AIWorkspaceBubbleData {
    pub id: String,
    pub thread_id: String,
    pub workspace_key: String,
    pub interaction_mode: String,
    pub kind: String,
    pub status: String,
    pub title: String,
    pub subtitle: String,
    pub prompt: String,
    pub prompt_summary: Option<String>,
    pub preview: String,
    pub detail: String,
    pub sql: Option<String>,
    pub risk: Option<JsonValue>,
    pub x: f64,
    pub y: f64,
    pub pointer: AIWorkspacePointerState,
    pub created_at: i64,
    pub auto_dismiss_at: Option<i64>,
}

#[derive(Clone)]
pub struct AIWorkspaceHistoryStorage {
    file_path: PathBuf,
}

impl AIWorkspaceHistoryStorage {
    pub fn new() -> Result<Self, String> {
        let data_dir = dirs::data_dir()
            .ok_or_else(|| "Cannot find user data directory".to_string())?
            .join("TableR");

        fs::create_dir_all(&data_dir)
            .map_err(|error| format!("Failed to create AI history directory: {error}"))?;

        Ok(Self {
            file_path: data_dir.join("ai_workspace_history.sqlite"),
        })
    }

    #[cfg(test)]
    fn new_with_file(file_path: PathBuf) -> Result<Self, String> {
        if let Some(parent) = file_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Failed to create test AI history directory: {error}"))?;
        }

        Ok(Self { file_path })
    }

    fn connect_options(&self) -> Result<SqliteConnectOptions, String> {
        let db_url = format!("sqlite://{}", self.file_path.to_string_lossy().replace('\\', "/"));
        let options = SqliteConnectOptions::from_str(&db_url)
            .map_err(|error| format!("Failed to prepare AI history database path: {error}"))?
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal);

        Ok(options)
    }

    async fn connect_pool(&self) -> Result<SqlitePool, String> {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(self.connect_options()?)
            .await
            .map_err(|error| format!("Failed to open AI history database: {error}"))?;

        self.initialize(&pool).await?;
        Ok(pool)
    }

    async fn initialize(&self, pool: &SqlitePool) -> Result<(), String> {
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS ai_workspace_history_state (
                storage_key TEXT PRIMARY KEY,
                version INTEGER NOT NULL,
                payload TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            )
            "#,
        )
        .execute(pool)
        .await
        .map_err(|error| format!("Failed to initialize AI history schema: {error}"))?;

        Ok(())
    }

    pub async fn load_state(&self) -> Result<PersistedAIWorkspaceState, String> {
        let pool = self.connect_pool().await?;
        let row = sqlx::query(
            "SELECT payload FROM ai_workspace_history_state WHERE storage_key = ?1 LIMIT 1",
        )
        .bind(STORAGE_ROW_KEY)
        .fetch_optional(&pool)
        .await
        .map_err(|error| format!("Failed to read AI history state: {error}"))?;

        let Some(row) = row else {
            return Ok(PersistedAIWorkspaceState::default());
        };

        let payload: String = row
            .try_get("payload")
            .map_err(|error| format!("Failed to decode AI history payload: {error}"))?;

        serde_json::from_str::<PersistedAIWorkspaceState>(&payload)
            .map_err(|error| format!("Failed to parse AI history payload: {error}"))
    }

    pub async fn save_state(&self, state: &PersistedAIWorkspaceState) -> Result<(), String> {
        let pool = self.connect_pool().await?;
        let payload = serde_json::to_string(state)
            .map_err(|error| format!("Failed to serialize AI history state: {error}"))?;

        sqlx::query(
            r#"
            INSERT INTO ai_workspace_history_state (storage_key, version, payload, updated_at)
            VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(storage_key) DO UPDATE SET
                version = excluded.version,
                payload = excluded.payload,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(STORAGE_ROW_KEY)
        .bind(state.version)
        .bind(payload)
        .bind(Utc::now().timestamp_millis())
        .execute(&pool)
        .await
        .map_err(|error| format!("Failed to persist AI history state: {error}"))?;

        Ok(())
    }
}

#[tauri::command]
pub async fn get_ai_workspace_history() -> Result<PersistedAIWorkspaceState, String> {
    AIWorkspaceHistoryStorage::new()?.load_state().await
}

#[tauri::command]
pub async fn save_ai_workspace_history(state: PersistedAIWorkspaceState) -> Result<(), String> {
    AIWorkspaceHistoryStorage::new()?.save_state(&state).await
}

#[cfg(test)]
mod tests {
    use super::{AIWorkspaceHistoryStorage, PersistedAIWorkspaceState};
    use std::path::PathBuf;
    use uuid::Uuid;

    fn temp_history_db_path() -> PathBuf {
        std::env::temp_dir()
            .join("tabler-ai-history-tests")
            .join(format!("{}.sqlite", Uuid::new_v4()))
    }

    #[tokio::test]
    async fn round_trips_workspace_state() {
        let path = temp_history_db_path();
        let storage = AIWorkspaceHistoryStorage::new_with_file(path.clone()).expect("storage should init");

        let mut state = PersistedAIWorkspaceState::default();
        state.version = 1;
        state.active_thread_ids.insert("workspace-1".into(), "thread-1".into());

        storage.save_state(&state).await.expect("save should succeed");
        let loaded = storage.load_state().await.expect("load should succeed");

        assert_eq!(loaded.version, 1);
        assert_eq!(
            loaded.active_thread_ids.get("workspace-1").map(String::as_str),
            Some("thread-1")
        );

        let _ = std::fs::remove_file(path);
    }
}
