//! Scheduled saved queries (Group-2 Feature 7, Phase 1).
//!
//! The scheduler loop ticks every minute and runs any enabled schedule whose
//! interval has elapsed, executing its statement through the connection's
//! driver with a readonly guard (only single SELECT/WITH statements are
//! schedulable — destructive SQL can never ride the scheduler). Each run's
//! outcome is persisted on the schedule so the UI can show the last status,
//! and a `schedule-fired` event reaches the frontend for the toast.

use crate::database::manager::DatabaseManager;
use crate::storage::schedule_storage::{QuerySchedule, ScheduleStorage};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

const SCHEDULER_TICK_MILLIS: u64 = 60_000;
const SCHEDULER_RUN_TIMEOUT_MILLIS: u64 = 120_000;
const MAX_PERSISTED_ERROR_CHARS: usize = 500;
const MAX_INTERVAL_SECONDS: u64 = 86_400 * 7;

#[tauri::command]
pub fn list_query_schedules() -> Result<Vec<QuerySchedule>, String> {
    let storage = ScheduleStorage::new()?;
    Ok(storage.get_all())
}

#[tauri::command]
pub fn save_query_schedule(
    id: Option<String>,
    name: String,
    sql: String,
    connection_id: Option<String>,
    database: Option<String>,
    interval_seconds: u64,
    enabled: bool,
) -> Result<QuerySchedule, String> {
    let mut storage = ScheduleStorage::new()?;
    // Carry run history forward when the caller edits an existing schedule —
    // the frontend edits by full replace, so history comes from the store.
    let history = id
        .as_deref()
        .and_then(|existing| storage.get(existing))
        .map(|existing| {
            (
                existing.last_ran_at,
                existing.last_status,
                existing.last_rows,
                existing.last_error,
            )
        })
        .unwrap_or((None, None, None, None));
    storage.save(QuerySchedule {
        id: id.unwrap_or_default(),
        name,
        sql,
        connection_id,
        database,
        interval_seconds: interval_seconds.clamp(60, MAX_INTERVAL_SECONDS),
        enabled,
        last_ran_at: history.0,
        last_status: history.1,
        last_rows: history.2,
        last_error: history.3,
        created_at: String::new(),
        updated_at: String::new(),
    })
}

#[tauri::command]
pub fn delete_query_schedule(id: String) -> Result<(), String> {
    let mut storage = ScheduleStorage::new()?;
    storage.delete(&id)
}

/// Readonly guard: only a leading SELECT or WITH is schedulable. Multiple
/// statements are refused outright — a trailing destructive statement must
/// never ride along a SELECT.
fn is_readonly_schedulable(sql: &str) -> bool {
    let trimmed = sql.trim().trim_end_matches(';').trim();
    if trimmed.contains(';') {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    lower.starts_with("select") || lower.starts_with("with")
}

/// Runs one schedule and persists the outcome. Failures are recorded on the
/// schedule (never surfaced as a command error) so a broken query shows up
/// in the UI instead of silently retrying forever.
async fn run_schedule(
    app: &AppHandle,
    db_manager: &DatabaseManager,
    mut schedule: QuerySchedule,
) -> Result<(), String> {
    let now = chrono::Utc::now().timestamp_millis();
    let outcome = async {
        if !is_readonly_schedulable(&schedule.sql) {
            return Err("Only a single SELECT or WITH statement can be scheduled.".to_string());
        }
        let Some(connection_id) = schedule.connection_id.clone() else {
            return Err("This schedule has no connection bound.".to_string());
        };
        let driver = db_manager
            .get_driver(&connection_id)
            .await
            .map_err(|e| e.to_string())?;
        let result = tokio::time::timeout(
            std::time::Duration::from_millis(SCHEDULER_RUN_TIMEOUT_MILLIS),
            driver.execute_query(&schedule.sql),
        )
        .await
        .map_err(|_| {
            format!(
                "Scheduled query timed out after {} seconds.",
                SCHEDULER_RUN_TIMEOUT_MILLIS / 1_000
            )
        })?
        .map_err(|e| e.to_string())?;
        Ok(result.rows.len() as u64)
    }
    .await;

    match &outcome {
        Ok(rows) => {
            schedule.last_ran_at = Some(now);
            schedule.last_status = Some("ok".into());
            schedule.last_rows = Some(*rows);
            schedule.last_error = None;
        }
        Err(error) => {
            schedule.last_ran_at = Some(now);
            schedule.last_status = Some("error".into());
            schedule.last_rows = None;
            let mut message = error.clone();
            if message.chars().count() > MAX_PERSISTED_ERROR_CHARS {
                message = message.chars().take(MAX_PERSISTED_ERROR_CHARS).collect();
            }
            schedule.last_error = Some(message);
        }
    }

    let _ = app.emit(
        "schedule-fired",
        json!({
            "scheduleId": schedule.id,
            "name": schedule.name,
            "status": schedule.last_status,
            "rows": schedule.last_rows,
            "error": schedule.last_error,
        }),
    );

    let mut storage = ScheduleStorage::new()?;
    storage.save(schedule)?;
    outcome.map(|_| ())
}

/// One scheduler tick: run every due schedule sequentially. Due schedules
/// that fail still record their outcome; later schedules keep running.
async fn run_due_schedules(app: &AppHandle, db_manager: &DatabaseManager) {
    let Ok(storage) = ScheduleStorage::new() else {
        return;
    };
    let now = chrono::Utc::now().timestamp_millis();
    let due: Vec<QuerySchedule> = storage
        .get_all()
        .into_iter()
        .filter(|schedule| schedule.is_due(now))
        .collect();
    for schedule in due {
        if let Err(error) = run_schedule(app, db_manager, schedule).await {
            log::warn!("[Scheduler] schedule run failed: {error}");
        }
    }
}

/// Spawns the minute-tick scheduler loop (called once from app setup).
pub fn spawn_scheduler(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(SCHEDULER_TICK_MILLIS)).await;
            // The manager state is fetched per tick: a State borrow cannot
            // cross into the 'static task, but the owned AppHandle can.
            let db_manager = app.state::<DatabaseManager>();
            run_due_schedules(&app, &db_manager).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::is_readonly_schedulable;

    #[test]
    fn single_selects_and_ctes_are_schedulable() {
        assert!(is_readonly_schedulable("SELECT * FROM users"));
        assert!(is_readonly_schedulable("  select 1 ;"));
        assert!(is_readonly_schedulable(
            "WITH recent AS (SELECT 1) SELECT * FROM recent"
        ));
    }

    #[test]
    fn destructive_or_multi_statement_sql_is_refused() {
        assert!(!is_readonly_schedulable("DELETE FROM users"));
        assert!(!is_readonly_schedulable("UPDATE users SET x = 1"));
        assert!(!is_readonly_schedulable("DROP TABLE users"));
        assert!(!is_readonly_schedulable("SELECT 1; DROP TABLE users"));
        assert!(!is_readonly_schedulable(""));
    }
}
