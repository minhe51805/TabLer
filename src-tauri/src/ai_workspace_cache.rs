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

/// A persisted AI chat attachment (image or text file). `data` holds base64
/// image bytes (no data-URL prefix) or the text file contents; it is excluded
/// from listing payloads so the manager stays light and image bytes are only
/// fetched on demand.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AIAttachmentRecord {
    pub id: String,
    pub workspace_key: String,
    pub thread_id: String,
    /// "image" | "text"
    pub kind: String,
    pub name: String,
    pub mime_type: String,
    pub size: i64,
    pub data: String,
    pub created_at: i64,
}

/// Listing row: everything except `data`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AIAttachmentMeta {
    pub id: String,
    pub workspace_key: String,
    pub thread_id: String,
    pub kind: String,
    pub name: String,
    pub mime_type: String,
    pub size: i64,
    pub created_at: i64,
}

/// On-demand payload for rendering a persisted attachment.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AIAttachmentData {
    pub id: String,
    pub mime_type: String,
    pub data: String,
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
            CREATE TABLE IF NOT EXISTS thread_memories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                workspace_id TEXT NOT NULL,
                thread_id TEXT NOT NULL UNIQUE,
                title TEXT NOT NULL,
                summary TEXT NOT NULL,
                keywords TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            )
            "#,
        )
        .execute(pool)
        .await
        .map_err(|error| format!("Failed to create thread memory schema: {error}"))?;

        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS ai_attachments (
                id TEXT PRIMARY KEY,
                workspace_key TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                name TEXT NOT NULL,
                mime_type TEXT NOT NULL,
                size INTEGER NOT NULL,
                data TEXT NOT NULL,
                created_at INTEGER NOT NULL
            )
            "#,
        )
        .execute(pool)
        .await
        .map_err(|error| format!("Failed to create AI attachment schema: {error}"))?;

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

/// Codex-style long-term memory entry for one chat thread: a named, keyword
/// tagged digest so related context can be found and re-imported later.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMemory {
    pub id: i64,
    pub workspace_id: String,
    pub thread_id: String,
    pub title: String,
    pub summary: String,
    pub keywords: Vec<String>,
    pub updated_at: i64,
}

impl AIWorkspaceCacheStorage {
    pub async fn upsert_thread_memory(
        &self,
        workspace_id: &str,
        thread_id: &str,
        title: &str,
        summary: &str,
        keywords: &[String],
    ) -> Result<ThreadMemory, String> {
        let pool = self.connect_pool().await?;
        let updated_at = Utc::now().timestamp_millis();
        let keywords_text = serde_json::to_string(keywords)
            .map_err(|error| format!("Failed to serialize thread memory keywords: {error}"))?;

        let result = sqlx::query(
            r#"
            INSERT INTO thread_memories (workspace_id, thread_id, title, summary, keywords, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(thread_id) DO UPDATE SET
                workspace_id = excluded.workspace_id,
                title = excluded.title,
                summary = excluded.summary,
                keywords = excluded.keywords,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(workspace_id)
        .bind(thread_id)
        .bind(title)
        .bind(summary)
        .bind(keywords_text)
        .bind(updated_at)
        .execute(&pool)
        .await
        .map_err(|error| format!("Failed to persist thread memory: {error}"))?;

        Ok(ThreadMemory {
            id: result.last_insert_rowid(),
            workspace_id: workspace_id.to_string(),
            thread_id: thread_id.to_string(),
            title: title.to_string(),
            summary: summary.to_string(),
            keywords: keywords.to_vec(),
            updated_at,
        })
    }

    pub async fn list_thread_memories(
        &self,
        workspace_id: Option<&str>,
    ) -> Result<Vec<ThreadMemory>, String> {
        let pool = self.connect_pool().await?;
        let rows = if let Some(workspace_id) = workspace_id {
            sqlx::query(
                r#"
                SELECT id, workspace_id, thread_id, title, summary, keywords, updated_at
                FROM thread_memories
                WHERE workspace_id = ?1
                ORDER BY updated_at DESC
                LIMIT 200
                "#,
            )
            .bind(workspace_id)
            .fetch_all(&pool)
            .await
            .map_err(|error| format!("Failed to read thread memories: {error}"))?
        } else {
            sqlx::query(
                r#"
                SELECT id, workspace_id, thread_id, title, summary, keywords, updated_at
                FROM thread_memories
                ORDER BY updated_at DESC
                LIMIT 200
                "#,
            )
            .fetch_all(&pool)
            .await
            .map_err(|error| format!("Failed to read thread memories: {error}"))?
        };

        Ok(rows
            .into_iter()
            .map(|row| ThreadMemory {
                id: row.try_get("id").unwrap_or_default(),
                workspace_id: row.try_get("workspace_id").unwrap_or_default(),
                thread_id: row.try_get("thread_id").unwrap_or_default(),
                title: row.try_get("title").unwrap_or_default(),
                summary: row.try_get("summary").unwrap_or_default(),
                keywords: row
                    .try_get::<String, _>("keywords")
                    .ok()
                    .and_then(|keywords| serde_json::from_str(&keywords).ok())
                    .unwrap_or_default(),
                updated_at: row.try_get("updated_at").unwrap_or_default(),
            })
            .collect())
    }

    pub async fn delete_thread_memories_for_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<(), String> {
        let pool = self.connect_pool().await?;
        sqlx::query("DELETE FROM thread_memories WHERE workspace_id = ?1")
            .bind(workspace_id)
            .execute(&pool)
            .await
            .map_err(|error| format!("Failed to delete thread memories: {error}"))?;
        Ok(())
    }

    pub async fn delete_thread_memory_for_thread(&self, thread_id: &str) -> Result<(), String> {
        let pool = self.connect_pool().await?;
        sqlx::query("DELETE FROM thread_memories WHERE thread_id = ?1")
            .bind(thread_id)
            .execute(&pool)
            .await
            .map_err(|error| format!("Failed to delete thread memory: {error}"))?;
        Ok(())
    }

    /// Persists chat attachments. Existing ids are kept (INSERT OR IGNORE) so a
    /// retry never duplicates rows or overwrites stored bytes.
    pub async fn save_ai_attachments(
        &self,
        attachments: &[AIAttachmentRecord],
    ) -> Result<(), String> {
        if attachments.is_empty() {
            return Ok(());
        }
        let pool = self.connect_pool().await?;
        for record in attachments {
            sqlx::query(
                r#"
                INSERT OR IGNORE INTO ai_attachments
                    (id, workspace_key, thread_id, kind, name, mime_type, size, data, created_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                "#,
            )
            .bind(&record.id)
            .bind(&record.workspace_key)
            .bind(&record.thread_id)
            .bind(&record.kind)
            .bind(&record.name)
            .bind(&record.mime_type)
            .bind(record.size)
            .bind(&record.data)
            .bind(record.created_at)
            .execute(&pool)
            .await
            .map_err(|error| format!("Failed to save AI attachment: {error}"))?;
        }
        Ok(())
    }

    /// Lists attachment metadata (no `data`) newest-first for the manager UI.
    pub async fn list_ai_attachments(&self) -> Result<Vec<AIAttachmentMeta>, String> {
        let pool = self.connect_pool().await?;
        let rows = sqlx::query(
            r#"
            SELECT id, workspace_key, thread_id, kind, name, mime_type, size, created_at
            FROM ai_attachments
            ORDER BY created_at DESC
            "#,
        )
        .fetch_all(&pool)
        .await
        .map_err(|error| format!("Failed to list AI attachments: {error}"))?;

        Ok(rows
            .iter()
            .map(|row| AIAttachmentMeta {
                id: row.try_get("id").unwrap_or_default(),
                workspace_key: row.try_get("workspace_key").unwrap_or_default(),
                thread_id: row.try_get("thread_id").unwrap_or_default(),
                kind: row.try_get("kind").unwrap_or_default(),
                name: row.try_get("name").unwrap_or_default(),
                mime_type: row.try_get("mime_type").unwrap_or_default(),
                size: row.try_get("size").unwrap_or_default(),
                created_at: row.try_get("created_at").unwrap_or_default(),
            })
            .collect())
    }

    /// Fetches stored payloads for the given attachment ids (rendering, resend).
    pub async fn get_ai_attachment_data(
        &self,
        ids: &[String],
    ) -> Result<Vec<AIAttachmentData>, String> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let pool = self.connect_pool().await?;
        let mut results = Vec::with_capacity(ids.len());
        for id in ids {
            let row = sqlx::query(
                "SELECT id, mime_type, data FROM ai_attachments WHERE id = ?1",
            )
            .bind(id)
            .fetch_optional(&pool)
            .await
            .map_err(|error| format!("Failed to load AI attachment: {error}"))?;
            if let Some(row) = row {
                results.push(AIAttachmentData {
                    id: row.try_get("id").unwrap_or_default(),
                    mime_type: row.try_get("mime_type").unwrap_or_default(),
                    data: row.try_get("data").unwrap_or_default(),
                });
            }
        }
        Ok(results)
    }

    pub async fn delete_ai_attachments(&self, ids: &[String]) -> Result<(), String> {
        if ids.is_empty() {
            return Ok(());
        }
        let pool = self.connect_pool().await?;
        for id in ids {
            sqlx::query("DELETE FROM ai_attachments WHERE id = ?1")
                .bind(id)
                .execute(&pool)
                .await
                .map_err(|error| format!("Failed to delete AI attachment: {error}"))?;
        }
        Ok(())
    }

    pub async fn delete_all_ai_attachments(&self) -> Result<i64, String> {
        let pool = self.connect_pool().await?;
        let result = sqlx::query("DELETE FROM ai_attachments")
            .execute(&pool)
            .await
            .map_err(|error| format!("Failed to delete AI attachments: {error}"))?;
        Ok(result.rows_affected() as i64)
    }

    pub async fn delete_ai_attachments_for_workspace(
        &self,
        workspace_key: &str,
    ) -> Result<(), String> {
        let pool = self.connect_pool().await?;
        sqlx::query("DELETE FROM ai_attachments WHERE workspace_key = ?1")
            .bind(workspace_key)
            .execute(&pool)
            .await
            .map_err(|error| format!("Failed to delete AI attachments: {error}"))?;
        Ok(())
    }

    pub async fn delete_ai_attachments_for_thread(&self, thread_id: &str) -> Result<(), String> {
        let pool = self.connect_pool().await?;
        sqlx::query("DELETE FROM ai_attachments WHERE thread_id = ?1")
            .bind(thread_id)
            .execute(&pool)
            .await
            .map_err(|error| format!("Failed to delete AI attachments: {error}"))?;
        Ok(())
    }
}

#[tauri::command]
pub async fn upsert_thread_memory(
    workspace_id: String,
    thread_id: String,
    title: String,
    summary: String,
    keywords: Vec<String>,
) -> Result<ThreadMemory, String> {
    AIWorkspaceCacheStorage::new()?
        .upsert_thread_memory(&workspace_id, &thread_id, &title, &summary, &keywords)
        .await
}

#[tauri::command]
pub async fn list_thread_memories(
    workspace_id: Option<String>,
) -> Result<Vec<ThreadMemory>, String> {
    AIWorkspaceCacheStorage::new()?
        .list_thread_memories(workspace_id.as_deref())
        .await
}

#[tauri::command]
pub async fn delete_thread_memories_for_workspace(workspace_id: String) -> Result<(), String> {
    AIWorkspaceCacheStorage::new()?
        .delete_thread_memories_for_workspace(&workspace_id)
        .await
}

#[tauri::command]
pub async fn delete_thread_memory_for_thread(thread_id: String) -> Result<(), String> {
    AIWorkspaceCacheStorage::new()?
        .delete_thread_memory_for_thread(&thread_id)
        .await
}

#[tauri::command]
pub async fn save_ai_attachments(
    attachments: Vec<AIAttachmentRecord>,
) -> Result<(), String> {
    AIWorkspaceCacheStorage::new()?
        .save_ai_attachments(&attachments)
        .await
}

#[tauri::command]
pub async fn list_ai_attachments() -> Result<Vec<AIAttachmentMeta>, String> {
    AIWorkspaceCacheStorage::new()?.list_ai_attachments().await
}

#[tauri::command]
pub async fn get_ai_attachment_data(ids: Vec<String>) -> Result<Vec<AIAttachmentData>, String> {
    AIWorkspaceCacheStorage::new()?.get_ai_attachment_data(&ids).await
}

#[tauri::command]
pub async fn delete_ai_attachments(ids: Vec<String>) -> Result<(), String> {
    AIWorkspaceCacheStorage::new()?.delete_ai_attachments(&ids).await
}

#[tauri::command]
pub async fn delete_all_ai_attachments() -> Result<i64, String> {
    AIWorkspaceCacheStorage::new()?.delete_all_ai_attachments().await
}

#[tauri::command]
pub async fn delete_ai_attachments_for_workspace(workspace_key: String) -> Result<(), String> {
    AIWorkspaceCacheStorage::new()?
        .delete_ai_attachments_for_workspace(&workspace_key)
        .await
}

#[tauri::command]
pub async fn delete_ai_attachments_for_thread(thread_id: String) -> Result<(), String> {
    AIWorkspaceCacheStorage::new()?
        .delete_ai_attachments_for_thread(&thread_id)
        .await
}

#[cfg(test)]
mod tests {
    use super::{AIAttachmentRecord, AIWorkspaceCacheStorage, WorkspaceContextSnapshot};
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

    #[tokio::test]
    async fn saves_lists_and_deletes_ai_attachments() {
        let path = temp_cache_db_path();
        let storage =
            AIWorkspaceCacheStorage::new_with_file(path.clone()).expect("storage should build");

        let record = AIAttachmentRecord {
            id: "att-1".to_string(),
            workspace_key: "ws-1".to_string(),
            thread_id: "thread-1".to_string(),
            kind: "image".to_string(),
            name: "shot.png".to_string(),
            mime_type: "image/png".to_string(),
            size: 4,
            data: "AAAA".to_string(),
            created_at: 1_700_000_000_000,
        };
        storage
            .save_ai_attachments(&[record.clone()])
            .await
            .expect("save should succeed");
        // INSERT OR IGNORE: a duplicate save must not fail or duplicate.
        storage
            .save_ai_attachments(&[record])
            .await
            .expect("duplicate save should succeed");

        let listed = storage.list_ai_attachments().await.expect("list works");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "att-1");
        assert_eq!(listed[0].kind, "image");

        let data = storage
            .get_ai_attachment_data(&["att-1".to_string()])
            .await
            .expect("data works");
        assert_eq!(data.len(), 1);
        assert_eq!(data[0].data, "AAAA");

        storage
            .delete_ai_attachments(&["att-1".to_string()])
            .await
            .expect("delete works");
        let emptied = storage.list_ai_attachments().await.expect("list works");
        assert!(emptied.is_empty());
    }

    #[tokio::test]
    async fn upserts_and_lists_thread_memories() {
        let path = temp_cache_db_path();
        let storage =
            AIWorkspaceCacheStorage::new_with_file(path.clone()).expect("storage should init");

        storage
            .upsert_thread_memory(
                "ws-1",
                "thread-1",
                "Migration plan",
                "Goal: migrate",
                &["dbo.taikhoan".into(), "postgres".into()],
            )
            .await
            .expect("upsert should succeed");
        storage
            .upsert_thread_memory(
                "ws-1",
                "thread-1",
                "Migration plan v2",
                "Goal: migrate",
                &["dbo.taikhoan".into()],
            )
            .await
            .expect("second upsert should succeed");

        let memories = storage
            .list_thread_memories(Some("ws-1"))
            .await
            .expect("list should succeed");
        assert_eq!(memories.len(), 1);
        assert_eq!(memories[0].title, "Migration plan v2");
        assert_eq!(memories[0].keywords, vec!["dbo.taikhoan".to_string()]);

        let all = storage
            .list_thread_memories(None)
            .await
            .expect("list all should succeed");
        assert_eq!(all.len(), 1);

        storage
            .delete_thread_memory_for_thread("thread-1")
            .await
            .expect("delete should succeed");
        let emptied = storage
            .list_thread_memories(Some("ws-1"))
            .await
            .expect("list should succeed");
        assert!(emptied.is_empty());

        let _ = std::fs::remove_file(path);
    }
}
