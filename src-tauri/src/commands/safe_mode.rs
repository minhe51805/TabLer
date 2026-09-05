use crate::utils::safe_mode::{assert_sql_allowed_at_level_with_approval, clamp_safe_mode_level};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use tokio::sync::RwLock;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SafeModeOverridePayload {
    pub connection_id: String,
    pub level: u8,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SafeModePolicyPayload {
    pub global_level: u8,
    #[serde(default)]
    pub connection_overrides: Vec<SafeModeOverridePayload>,
    #[serde(default)]
    pub production_connection_ids: Vec<String>,
}

#[derive(Debug, Clone)]
struct SafeModePolicy {
    global_level: u8,
    overrides: HashMap<String, u8>,
    production_ids: HashSet<String>,
}

impl Default for SafeModePolicy {
    fn default() -> Self {
        Self {
            global_level: 1,
            overrides: HashMap::new(),
            production_ids: HashSet::new(),
        }
    }
}

#[derive(Default)]
pub struct SafeModeState {
    policy: RwLock<SafeModePolicy>,
}

impl SafeModeState {
    pub async fn set_policy(&self, payload: SafeModePolicyPayload) {
        let mut policy = self.policy.write().await;
        policy.global_level = clamp_safe_mode_level(payload.global_level);
        policy.overrides = payload
            .connection_overrides
            .into_iter()
            .filter(|entry| !entry.connection_id.trim().is_empty())
            .map(|entry| (entry.connection_id, clamp_safe_mode_level(entry.level)))
            .collect();
        policy.production_ids = payload
            .production_connection_ids
            .into_iter()
            .filter(|id| !id.trim().is_empty())
            .collect();
    }

    pub async fn effective_level(&self, connection_id: &str) -> u8 {
        let policy = self.policy.read().await;
        if let Some(level) = policy.overrides.get(connection_id) {
            return *level;
        }
        if policy.production_ids.contains(connection_id) {
            return 4;
        }
        policy.global_level
    }

    pub async fn assert_sql_allowed(&self, connection_id: &str, sql: &str) -> Result<(), String> {
        self.assert_sql_allowed_with_approval(connection_id, sql, false)
            .await
    }

    /// Same policy, but `user_approved` marks runs the human explicitly
    /// confirmed in the UI (query editor confirmation dialog or the standing
    /// full-autonomy grant). Only relaxes the level 1-3 block; levels 4-5
    /// and parse failures stay hard.
    pub async fn assert_sql_allowed_with_approval(
        &self,
        connection_id: &str,
        sql: &str,
        user_approved: bool,
    ) -> Result<(), String> {
        let level = self.effective_level(connection_id).await;
        assert_sql_allowed_at_level_with_approval(level, sql, user_approved)
    }
}

#[tauri::command]
pub async fn set_safe_mode_policy(
    global_level: u8,
    connection_overrides: Vec<SafeModeOverridePayload>,
    production_connection_ids: Vec<String>,
    safe_mode: tauri::State<'_, SafeModeState>,
) -> Result<(), String> {
    safe_mode
        .set_policy(SafeModePolicyPayload {
            global_level,
            connection_overrides,
            production_connection_ids,
        })
        .await;
    Ok(())
}
