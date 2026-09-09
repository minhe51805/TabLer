use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::storage::file_storage::{read_json_vec_with_backup, write_json_atomically};

/// A saved SQL query the scheduler runs on an interval while the app is open.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuerySchedule {
    pub id: String,
    pub name: String,
    /// Readonly statement the scheduler runs (guarded in the runner).
    pub sql: String,
    #[serde(default)]
    pub connection_id: Option<String>,
    #[serde(default)]
    pub database: Option<String>,
    /// Minimum seconds between runs.
    pub interval_seconds: u64,
    #[serde(default)]
    pub enabled: bool,
    /// Millis epoch of the last completed run (absent = never ran).
    #[serde(default)]
    pub last_ran_at: Option<i64>,
    /// "ok" | "error" after the first run.
    #[serde(default)]
    pub last_status: Option<String>,
    #[serde(default)]
    pub last_rows: Option<u64>,
    #[serde(default)]
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl QuerySchedule {
    /// Millis epoch when the next run is due (absent last_ran_at = overdue).
    pub fn due_at(&self) -> i64 {
        match self.last_ran_at {
            Some(ran_at) => ran_at + (self.interval_seconds.saturating_mul(1_000)) as i64,
            None => 0,
        }
    }

    pub fn is_due(&self, now_millis: i64) -> bool {
        self.enabled && now_millis >= self.due_at()
    }
}

/// In-memory cache of schedules, keyed by ID (same shape as sql_favorites).
#[derive(Clone)]
pub struct ScheduleStorage {
    file_path: PathBuf,
    cache: HashMap<String, QuerySchedule>,
}

impl ScheduleStorage {
    pub fn new() -> Result<Self, String> {
        let data_dir = crate::utils::paths::resolve_data_dir().map_err(|e| e.to_string())?;
        fs::create_dir_all(&data_dir)
            .map_err(|e| format!("Failed to create data directory: {e}"))?;
        let file_path = data_dir.join("query_schedules.json");
        if !file_path.exists() {
            fs::write(&file_path, "[]")
                .map_err(|e| format!("Failed to create schedules file: {e}"))?;
        }
        let cache = Self::load_from_file(&file_path)?;
        Ok(Self { file_path, cache })
    }

    fn load_from_file(path: &Path) -> Result<HashMap<String, QuerySchedule>, String> {
        read_json_vec_with_backup::<QuerySchedule>(path, "query_schedules")
            .map(|items| items.into_iter().map(|s| (s.id.clone(), s)).collect())
            .map_err(|e| e.to_string())
    }

    fn persist(&self) -> Result<(), String> {
        let json = serde_json::to_string_pretty(&self.cache.values().collect::<Vec<_>>())
            .map_err(|e| format!("Failed to serialize schedules: {e}"))?;
        write_json_atomically(&self.file_path, &json)
            .map_err(|e| format!("Failed to persist schedules: {e}"))
    }

    pub fn get_all(&self) -> Vec<QuerySchedule> {
        let mut items: Vec<QuerySchedule> = self.cache.values().cloned().collect();
        items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        items
    }

    pub fn get(&self, id: &str) -> Option<QuerySchedule> {
        self.cache.get(id).cloned()
    }

    pub fn save(&mut self, mut schedule: QuerySchedule) -> Result<QuerySchedule, String> {
        if schedule.id.is_empty() {
            schedule.id = uuid::Uuid::new_v4().to_string();
            schedule.created_at = chrono::Utc::now().to_rfc3339();
        }
        schedule.updated_at = chrono::Utc::now().to_rfc3339();
        self.cache.insert(schedule.id.clone(), schedule.clone());
        self.persist()?;
        Ok(schedule)
    }

    pub fn delete(&mut self, id: &str) -> Result<(), String> {
        if self.cache.remove(id).is_none() {
            return Err(format!("Schedule not found: {id}"));
        }
        self.persist()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::QuerySchedule;

    fn schedule(interval_seconds: u64, last_ran_at: Option<i64>, enabled: bool) -> QuerySchedule {
        QuerySchedule {
            id: "s1".into(),
            name: "nightly".into(),
            sql: "SELECT 1".into(),
            connection_id: None,
            database: None,
            interval_seconds,
            enabled,
            last_ran_at,
            last_status: None,
            last_rows: None,
            last_error: None,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn enabled_schedules_are_due_after_the_interval_elapsed() {
        // Ran at t=1000 with a 60s interval → due at 61_000.
        let s = schedule(60, Some(1_000), true);
        assert!(!s.is_due(60_999));
        assert!(s.is_due(61_000));
    }

    #[test]
    fn never_ran_schedules_are_due_immediately_and_disabled_ones_never() {
        assert!(schedule(3_600, None, true).is_due(0));
        assert!(!schedule(60, Some(0), false).is_due(i64::MAX));
    }
}
