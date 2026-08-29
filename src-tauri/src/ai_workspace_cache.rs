use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::{Row, SqlitePool};
use std::fs;
use std::path::PathBuf;
use std::str::FromStr;

/// Durable cache for AI chat workspace context (opencode-style compaction):
/// - `digest` rows hold the latest compacted context summary per workspace.
/// - `transcript` rows archive the FULL pre-compaction bubble payload so
///   compacting never destroys the original conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContextSnapshot {
    pub id: i64,
    pub workspace_id: String,
    /// "digest" | "transcript"
    pub kind: String,
    pub thread_id: Option<String>,
    pub payload: JsonValue,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDigestEntry {
    pub workspace_id: String,
    pub digest: String,
    pub updated_at: i64,
}

#[derive(Clone)]
pub struct AIWorkspaceCacheStorage {
    file_path: PathBuf,
}

impl AIWorkspaceCacheStorage {
    pub fn new() -> Result<Self, String> {
        let data_dir =
            crate::utils::paths::resolve_data_dir().map_err(|error| error.to_string())?;

        fs::create_dir_all(&data_dir)
            .map_err(|error| format!("Failed to create AI cache directory: {error}"))?;

        Ok(Self {
            file_path: data_dir.join("ai_workspace_cache.sqlite"),
        })
    }

    #[cfg(test)]
    fn new_with_file(file_path: PathBuf) -> Result<Self, String> {
        if let Some(parent) = file_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Failed to create test AI cache directory: {error}"))?;
        }

        Ok(Self { file_path })
    }

    fn connect_options(&self) -> Result<SqliteConnectOptions, String> {
        let db_url = format!(
            "sqlite://{}",
            self.file_path.to_string_lossy().replace('\\', "/")
        );
        let options = SqliteConnectOptions::from_str(&db_url)
            .map_err(|error| format!("Failed to prepare AI cache database path: {error}"))?
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal);

        Ok(options)
    }

    async fn connect_pool(&self) -> Result<SqlitePool, String> {
        let options = self.connect_options()?;
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .map_err(|error| format!("Failed to connect AI cache database: {error}"))?;

        self.ensure_schema(&pool).await?;
        Ok(pool)
    }

    async fn ensure_schema(&self, pool: &SqlitePool) -> Result<(), String> {
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS workspace_context_cache (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                workspace_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                thread_id TEXT,
                payload TEXT NOT NULL,
                created_at INTEGER NOT NULL
            )
            "#,
        )
        .execute(pool)
        .await
        .map_err(|error| format!("Failed to create AI cache schema: {error}"))?;

        sqlx::query(
            r#"
            CREATE INDEX IF NOT EXISTS idx_workspace_context_cache_lookup
            ON workspace_context_cache (workspace_id, kind, created_at)
            "#,
        )
        .execute(pool)
        .await
        .map_err(|error| format!("Failed to create AI cache index: {error}"))?;

        Ok(())
    }

    pub async fn save_snapshot(
        &self,
        workspace_id: &str,
        kind: &str,
        thread_id: Option<&str>,
        payload: &JsonValue,
    ) -> Result<WorkspaceContextSnapshot, String> {
        let pool = self.connect_pool().await?;
        let created_at = Utc::now().timestamp_millis();
        let payload_text = serde_json::to_string(payload)
            .map_err(|error| format!("Failed to serialize AI cache payload: {error}"))?;

        let result = sqlx::query(
            r#"
            INSERT INTO workspace_context_cache (workspace_id, kind, thread_id, payload, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5)
            "#,
        )
        .bind(workspace_id)
        .bind(kind)
        .bind(thread_id)
        .bind(payload_text)
        .bind(created_at)
        .execute(&pool)
        .await
        .map_err(|error| format!("Failed to persist AI cache snapshot: {error}"))?;

        Ok(WorkspaceContextSnapshot {
            id: result.last_insert_rowid(),
            workspace_id: workspace_id.to_string(),
            kind: kind.to_string(),
            thread_id: thread_id.map(|value| value.to_string()),
            payload: payload.clone(),
            created_at,
        })
    }

    pub async fn list_snapshots(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<WorkspaceContextSnapshot>, String> {
        let pool = self.connect_pool().await?;
        let rows = sqlx::query(
            r#"
            SELECT id, workspace_id, kind, thread_id, payload, created_at
            FROM workspace_context_cache
            WHERE workspace_id = ?1
            ORDER BY created_at DESC
            LIMIT 200
            "#,
        )
        .bind(workspace_id)
        .fetch_all(&pool)
        .await
        .map_err(|error| format!("Failed to read AI cache snapshots: {error}"))?;

        Ok(rows
            .into_iter()
            .map(|row| WorkspaceContextSnapshot {
                id: row.try_get("id").unwrap_or_default(),
                workspace_id: row.try_get("workspace_id").unwrap_or_default(),
                kind: row.try_get("kind").unwrap_or_default(),
                thread_id: row.try_get("thread_id").ok(),
                payload: row
                    .try_get::<String, _>("payload")
                    .ok()
                    .and_then(|payload| serde_json::from_str(&payload).ok())
                    .unwrap_or(JsonValue::Null),
                created_at: row.try_get("created_at").unwrap_or_default(),
            })
            .collect())
    }

    pub async fn latest_digest(
        &self,
        workspace_id: &str,
    ) -> Result<Option<WorkspaceDigestEntry>, String> {
        let pool = self.connect_pool().await?;
        let row = sqlx::query(
            r#"
            SELECT workspace_id, payload, created_at
            FROM workspace_context_cache
            WHERE workspace_id = ?1 AND kind = 'digest'
            ORDER BY created_at DESC
            LIMIT 1
            "#,
        )
        .bind(workspace_id)
        .fetch_optional(&pool)
        .await
        .map_err(|error| format!("Failed to read AI cache digest: {error}"))?;

        let Some(row) = row else {
            return Ok(None);
        };

        let payload_text: String = row
            .try_get("payload")
            .map_err(|error| format!("Failed to decode AI cache digest: {error}"))?;
        let payload: JsonValue = serde_json::from_str(&payload_text)
            .map_err(|error| format!("Failed to parse AI cache digest: {error}"))?;

        Ok(Some(WorkspaceDigestEntry {
            workspace_id: row.try_get("workspace_id").unwrap_or_default(),
            digest: payload
                .get("digest")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string(),
            updated_at: row.try_get("created_at").unwrap_or_default(),
        }))
    }

    /// Latest digest for every workspace that has one — used to hydrate the
    /// frontend store after restarts (digests survive localStorage clears).
    pub async fn latest_digests(&self) -> Result<Vec<WorkspaceDigestEntry>, String> {
        let pool = self.connect_pool().await?;
        let rows = sqlx::query(
            r#"
            SELECT workspace_id, payload, created_at
            FROM workspace_context_cache
            WHERE kind = 'digest'
            GROUP BY workspace_id
            HAVING created_at = MAX(created_at)
            "#,
        )
        .fetch_all(&pool)
        .await
        .map_err(|error| format!("Failed to read AI cache digests: {error}"))?;

        Ok(rows
            .into_iter()
            .map(|row| {
                let payload_text: String = row.try_get("payload").unwrap_or_default();
                let payload: JsonValue =
                    serde_json::from_str(&payload_text).unwrap_or(JsonValue::Null);
                WorkspaceDigestEntry {
                    workspace_id: row.try_get("workspace_id").unwrap_or_default(),
                    digest: payload
                        .get("digest")
                        .and_then(|value| value.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    updated_at: row.try_get("created_at").unwrap_or_default(),
                }
            })
            .collect())
    }

    pub async fn delete_snapshots(&self, workspace_id: &str) -> Result<(), String> {
        let pool = self.connect_pool().await?;
        sqlx::query("DELETE FROM workspace_context_cache WHERE workspace_id = ?1")
            .bind(workspace_id)
            .execute(&pool)
            .await
            .map_err(|error| format!("Failed to delete AI cache snapshots: {error}"))?;
        Ok(())
    }
}

#[tauri::command]
pub async fn save_workspace_context_snapshot(
    workspace_id: String,
    kind: String,
    thread_id: Option<String>,
    payload: JsonValue,
) -> Result<WorkspaceContextSnapshot, String> {
    AIWorkspaceCacheStorage::new()?
        .save_snapshot(&workspace_id, &kind, thread_id.as_deref(), &payload)
        .await
}

#[tauri::command]
pub async fn list_workspace_context_snapshots(
    workspace_id: String,
) -> Result<Vec<WorkspaceContextSnapshot>, String> {
    AIWorkspaceCacheStorage::new()?
        .list_snapshots(&workspace_id)
        .await
}

#[tauri::command]
pub async fn get_latest_workspace_digest(
    workspace_id: String,
) -> Result<Option<WorkspaceDigestEntry>, String> {
    AIWorkspaceCacheStorage::new()?
        .latest_digest(&workspace_id)
        .await
}

#[tauri::command]
pub async fn list_latest_workspace_digests() -> Result<Vec<WorkspaceDigestEntry>, String> {
    AIWorkspaceCacheStorage::new()?.latest_digests().await
}

#[tauri::command]
pub async fn delete_workspace_context_snapshots(workspace_id: String) -> Result<(), String> {
    AIWorkspaceCacheStorage::new()?
        .delete_snapshots(&workspace_id)
        .await
}

#[cfg(test)]
mod tests {
    use super::{AIWorkspaceCacheStorage, WorkspaceContextSnapshot};
    use serde_json::json;
    use std::path::PathBuf;
    use uuid::Uuid;

    fn temp_cache_db_path() -> PathBuf {
        std::env::temp_dir()
            .join("tabler-ai-cache-tests")
            .join(format!("{}.sqlite", Uuid::new_v4()))
    }

    #[tokio::test]
    async fn archives_and_reads_snapshots() {
        let path = temp_cache_db_path();
        let storage =
            AIWorkspaceCacheStorage::new_with_file(path.clone()).expect("storage should init");

        let digest_payload = json!({ "digest": "Goal: migrate dbo.taikhoan" });
        let saved: WorkspaceContextSnapshot = storage
            .save_snapshot("ws-1", "digest", Some("thread-1"), &digest_payload)
            .await
            .expect("save digest should succeed");

        assert!(saved.id > 0);
        assert_eq!(saved.workspace_id, "ws-1");

        let transcript_payload = json!({ "bubbles": [{ "id": "b1" }, { "id": "b2" }] });
        storage
            .save_snapshot("ws-1", "transcript", Some("thread-1"), &transcript_payload)
            .await
            .expect("save transcript should succeed");

        let snapshots = storage
            .list_snapshots("ws-1")
            .await
            .expect("list should succeed");
        assert_eq!(snapshots.len(), 2);

        let digest = storage
            .latest_digest("ws-1")
            .await
            .expect("latest digest should succeed");
        assert!(digest.is_some());
        assert_eq!(digest.unwrap().digest, "Goal: migrate dbo.taikhoan");

        storage
            .delete_snapshots("ws-1")
            .await
            .expect("delete should succeed");
        let emptied = storage
            .list_snapshots("ws-1")
            .await
            .expect("list should succeed");
        assert!(emptied.is_empty());

        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn latest_digests_groups_per_workspace() {
        let path = temp_cache_db_path();
        let storage =
            AIWorkspaceCacheStorage::new_with_file(path.clone()).expect("storage should init");

        storage
            .save_snapshot("ws-a", "digest", None, &json!({ "digest": "A v1" }))
            .await
            .expect("save should succeed");
        storage
            .save_snapshot("ws-b", "digest", None, &json!({ "digest": "B v1" }))
            .await
            .expect("save should succeed");

        let entries = storage
            .latest_digests()
            .await
            .expect("latest digests should succeed");
        let mine: Vec<_> = entries
            .into_iter()
            .filter(|entry| entry.workspace_id == "ws-a" || entry.workspace_id == "ws-b")
            .collect();
        assert_eq!(mine.len(), 2);

        let _ = std::fs::remove_file(path);
    }
}
