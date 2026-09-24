//! Scheduled saved queries and scheduled agent tasks (Group-2 Feature 7, Phase 1
//! + P10).
//!
//! The scheduler loop ticks every minute and fires any enabled schedule whose
//! interval has elapsed. Two kinds exist:
//!
//! * `kind == "sql"` — executed here through the connection's driver with a
//!   readonly guard (only single SELECT/WITH statements are schedulable;
//!   destructive SQL can never ride the scheduler).
//! * `kind == "agent"` — **nothing is executed here**. The backend only
//!   dispatches the trigger (`schedule-fired` with `kind: "agent"`), records the
//!   row as `dispatched`, and waits for the frontend to report the real outcome
//!   through `complete_agent_schedule_run`. The in-app agent runs the prompt
//!   READ-ONLY, so no unattended run can mutate a database, memory, or rules.
//!
//! Each run's outcome is persisted on the schedule so the UI can show the last
//! status, and a `schedule-fired` event reaches the frontend for the toast.

use crate::database::manager::DatabaseManager;
use crate::database::models::DatabaseType;
use crate::storage::connection_storage::ConnectionStorage;
use crate::storage::schedule_storage::{
    apply_agent_run_outcome, mark_agent_task_dispatched, mark_schedule_missed,
    normalize_catch_up_policy, normalize_schedule_kind, QuerySchedule, ScheduleRunOutcome,
    ScheduleStorage, MAX_PERSISTED_ERROR_CHARS, SCHEDULE_KIND_AGENT, SCHEDULE_KIND_SQL,
    SCHEDULE_STATUS_DISPATCHED, SCHEDULE_STATUS_ERROR, SCHEDULE_STATUS_OK,
};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

const SCHEDULER_TICK_MILLIS: u64 = 60_000;
const SCHEDULER_RUN_TIMEOUT_MILLIS: u64 = 120_000;
const MAX_INTERVAL_SECONDS: u64 = 86_400 * 7;

#[tauri::command]
pub fn list_query_schedules() -> Result<Vec<QuerySchedule>, String> {
    let storage = ScheduleStorage::new()?;
    Ok(storage.get_all())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // invoke params arrive flat; grouping would break the JS API
pub fn save_query_schedule(
    id: Option<String>,
    name: String,
    sql: String,
    connection_id: Option<String>,
    database: Option<String>,
    interval_seconds: u64,
    enabled: bool,
    kind: Option<String>,
    prompt: Option<String>,
    catch_up_policy: Option<String>,
    allow_data_read: Option<bool>,
) -> Result<QuerySchedule, String> {
    let mut storage = ScheduleStorage::new()?;
    let kind = normalize_schedule_kind(kind.as_deref())?;
    let catch_up_policy = normalize_catch_up_policy(catch_up_policy.as_deref())?;
    let (sql, prompt) = match kind {
        SCHEDULE_KIND_AGENT => {
            let task = prompt.unwrap_or_default().trim().to_string();
            if task.is_empty() {
                return Err("An agent task needs a prompt describing what to investigate.".into());
            }
            // The agent task never carries SQL: the agent writes its own
            // read-only queries from the prompt, so a stored statement here
            // would only ever be dead weight the UI could mistake for the task.
            (String::new(), Some(task))
        }
        _ => {
            if sql.trim().is_empty() {
                return Err("A scheduled query needs a single SELECT/WITH statement.".into());
            }
            // Reject non-readonly SQL at SAVE time, not first run: a schedule
            // that can never execute should not be storable (the runner
            // re-checks the same predicate before every fire).
            if !is_readonly_schedulable(&sql, schedule_database_type(connection_id.as_deref())) {
                return Err(
                    "Only a single read-only SELECT/WITH statement can be scheduled — writes, DDL, and filesystem-access SQL are not schedulable."
                        .into(),
                );
            }
            (sql, None)
        }
    };
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
                existing.last_summary,
                existing.missed_count,
                existing.next_due_at,
            )
        })
        .unwrap_or((None, None, None, None, None, 0, None));
    storage.save(QuerySchedule {
        id: id.unwrap_or_default(),
        name,
        sql,
        kind: kind.to_string(),
        prompt,
        // Only agent tasks may carry the data-read consent; a SQL schedule
        // never reads data through the agent, so the flag stays off there.
        allow_data_read: kind == SCHEDULE_KIND_AGENT && allow_data_read.unwrap_or(false),
        connection_id,
        database,
        interval_seconds: interval_seconds.clamp(60, MAX_INTERVAL_SECONDS),
        enabled,
        last_ran_at: history.0,
        last_status: history.1,
        last_rows: history.2,
        last_error: history.3,
        last_summary: history.4,
        catch_up_policy: catch_up_policy.to_string(),
        missed_count: history.5,
        next_due_at: history.6,
        created_at: String::new(),
        updated_at: String::new(),
    })
}

#[tauri::command]
pub fn delete_query_schedule(id: String) -> Result<(), String> {
    let mut storage = ScheduleStorage::new()?;
    storage.delete(&id)
}

/// Clears the "runs missed while the app was closed" counters once the UI has
/// shown them. Returns how many schedules were cleared.
#[tauri::command]
pub fn acknowledge_missed_schedule_runs() -> Result<u64, String> {
    let mut storage = ScheduleStorage::new()?;
    storage.acknowledge_missed()
}

/// Reports the outcome of an unattended agent task back onto its schedule row.
///
/// Only real outcomes are accepted ("ok", "error", "needs_human") — "dispatched"
/// is written by the scheduler alone, so a run can never claim a result the app
/// did not observe. SQL-kind rows are refused: they are reported by the runner
/// itself.
///
/// The row must still be `dispatched`: a report for a run that never went out
/// — or a stale report arriving after a newer dispatch already completed —
/// must not overwrite state it did not produce.
#[tauri::command]
pub fn complete_agent_schedule_run(
    schedule_id: String,
    status: String,
    rows: Option<u64>,
    error: Option<String>,
    summary: Option<String>,
) -> Result<(), String> {
    let mut storage = ScheduleStorage::new()?;
    let mut schedule = storage
        .get(&schedule_id)
        .ok_or_else(|| format!("Schedule not found: {schedule_id}"))?;
    if !schedule.is_agent_task() {
        return Err(format!(
            "Schedule {schedule_id} is a {SCHEDULE_KIND_SQL} schedule; its runs are reported by the scheduler."
        ));
    }
    if schedule.last_status.as_deref() != Some(SCHEDULE_STATUS_DISPATCHED) {
        return Err(format!(
            "Schedule {schedule_id} is not awaiting a run report (status: {}); the report is stale and was not recorded.",
            schedule.last_status.as_deref().unwrap_or("none")
        ));
    }
    let outcome = ScheduleRunOutcome::parse(&status)?;
    apply_agent_run_outcome(
        &mut schedule,
        outcome,
        rows,
        error,
        summary,
        chrono::Utc::now().timestamp_millis(),
    );
    storage.save(schedule)?;
    Ok(())
}

/// Readonly guard: a schedule is only allowed when the canonical classifier
/// proves the whole input is a single read-only statement with no filesystem
/// capability. The old leading-keyword check let `SELECT ... INTO` and
/// mutating CTEs ride the scheduler. `database_type` is the target engine so
/// dialect-specific reads (MySQL `SHOW`, `DESCRIBE`) classify the way the
/// server will read them.
fn is_readonly_schedulable(sql: &str, database_type: Option<DatabaseType>) -> bool {
    let decision = crate::utils::sql::classify_sql_with_dialect(sql, database_type);
    decision.parse_error.is_none()
        && !decision.filesystem_access
        && decision.statements.len() == 1
        && decision.read_only
}

/// Engine a schedule's connection targets. The live session knows it when
/// connected; a saved-but-disconnected connection still carries `db_type` in
/// the store, so the guard never falls back to the generic dialect just
/// because the app was restarted.
fn schedule_database_type(connection_id: Option<&str>) -> Option<DatabaseType> {
    let connection_id = connection_id?;
    ConnectionStorage::new()
        .ok()
        .and_then(|storage| storage.load_connection_by_id(connection_id).ok())
        .map(|config| config.db_type)
}

/// Runs one SQL schedule and persists the outcome. Failures are recorded on the
/// schedule (never surfaced as a command error) so a broken query shows up
/// in the UI instead of silently retrying forever.
async fn run_schedule(
    app: &AppHandle,
    db_manager: &DatabaseManager,
    mut schedule: QuerySchedule,
) -> Result<(), String> {
    let now = chrono::Utc::now().timestamp_millis();
    let outcome = async {
        if !is_readonly_schedulable(
            &schedule.sql,
            schedule_database_type(schedule.connection_id.as_deref()),
        ) {
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
            schedule.last_status = Some(SCHEDULE_STATUS_OK.into());
            schedule.last_rows = Some(*rows);
            schedule.last_error = None;
        }
        Err(error) => {
            schedule.last_ran_at = Some(now);
            schedule.last_status = Some(SCHEDULE_STATUS_ERROR.into());
            schedule.last_rows = None;
            let mut message = error.clone();
            if message.chars().count() > MAX_PERSISTED_ERROR_CHARS {
                message = message.chars().take(MAX_PERSISTED_ERROR_CHARS).collect();
            }
            schedule.last_error = Some(message);
        }
    }
    // A real run happened: any skip-override on the next boundary is spent.
    schedule.next_due_at = None;

    let _ = app.emit(
        "schedule-fired",
        json!({
            "scheduleId": schedule.id,
            "name": schedule.name,
            "kind": schedule.kind,
            "status": schedule.last_status,
            "rows": schedule.last_rows,
            "error": schedule.last_error,
        }),
    );

    let mut storage = ScheduleStorage::new()?;
    storage.save(schedule)?;
    outcome.map(|_| ())
}

/// Dispatches one agent task: hands the trigger to the frontend and records the
/// row as `dispatched`.
///
/// Deliberately executes nothing. The agent runtime lives in the frontend, and
/// the app's job here is to make the trigger impossible to lose and impossible
/// to fake: the row is persisted as `dispatched` (not `ok`), and only a
/// `complete_agent_schedule_run` call from the run itself can turn it into a
/// real outcome.
async fn dispatch_agent_schedule(
    app: &AppHandle,
    mut schedule: QuerySchedule,
) -> Result<(), String> {
    if schedule
        .prompt
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .is_empty()
    {
        // A task with no prompt cannot be dispatched; record why instead of
        // firing an empty run every interval.
        apply_agent_run_outcome(
            &mut schedule,
            ScheduleRunOutcome::Error,
            None,
            Some("This agent task has no prompt, so it was never dispatched.".into()),
            None,
            chrono::Utc::now().timestamp_millis(),
        );
        let mut storage = ScheduleStorage::new()?;
        storage.save(schedule)?;
        return Ok(());
    }

    mark_agent_task_dispatched(&mut schedule);
    let _ = app.emit(
        "schedule-fired",
        json!({
            "scheduleId": schedule.id,
            "name": schedule.name,
            "kind": schedule.kind,
            "prompt": schedule.prompt,
            "connectionId": schedule.connection_id,
            "database": schedule.database,
            "allowDataRead": schedule.allow_data_read,
            "status": schedule.last_status,
            "rows": null,
            "error": null,
        }),
    );
    let mut storage = ScheduleStorage::new()?;
    storage.save(schedule)?;
    Ok(())
}

/// One scheduler tick: fire every due schedule sequentially. SQL runs execute
/// here; agent tasks are only dispatched. Due schedules that fail still record
/// their outcome; later schedules keep running.
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
        let result = if schedule.is_agent_task() {
            dispatch_agent_schedule(app, schedule).await
        } else {
            run_schedule(app, db_manager, schedule).await
        };
        if let Err(error) = result {
            log::warn!("[Scheduler] schedule run failed: {error}");
        }
    }
}

/// Boot-time reaper: a row still `dispatched` when the app starts belongs to a
/// run the previous session can never report (the queue lives in RAM and died
/// with it). Left alone it would stay `dispatched` forever — `is_due` refuses
/// to fire it and `complete_agent_schedule_run` would accept a report nobody
/// can still send. Record the interruption as an error outcome so the row is
/// honest and the schedule resumes on its normal cadence.
///
/// Runs before missed-run reconciliation so a reaped row's `last_ran_at` is
/// fresh and is not double-counted as missed.
fn reap_stale_dispatches() -> u64 {
    let Ok(mut storage) = ScheduleStorage::new() else {
        return 0;
    };
    let now = chrono::Utc::now().timestamp_millis();
    let mut reaped = 0_u64;
    for mut schedule in storage.get_all() {
        if !schedule.is_agent_task()
            || schedule.last_status.as_deref() != Some(SCHEDULE_STATUS_DISPATCHED)
        {
            continue;
        }
        apply_agent_run_outcome(
            &mut schedule,
            ScheduleRunOutcome::Error,
            None,
            Some(
                "The app closed while this task was dispatched; its outcome was never reported."
                    .into(),
            ),
            None,
            now,
        );
        reaped += 1;
        if let Err(error) = storage.save(schedule) {
            log::warn!("[Scheduler] failed to reap stale dispatch: {error}");
        }
    }
    reaped
}

/// Boot-time reconciliation: every occurrence that elapsed while the app was
/// closed is recorded as `missed` on its schedule, then the catch-up policy
/// decides what happens next — `skip` resumes on the next future boundary,
/// `run_once` leaves the schedule due so the immediate first tick fires a
/// single catch-up run. Returns the total missed occurrences recorded.
///
/// Runs inside the scheduler task (not setup) so a slow disk never delays app
/// startup; the `schedules-missed` event reaches the frontend for the badge.
fn reconcile_missed_schedules(app: &AppHandle) -> u64 {
    let Ok(mut storage) = ScheduleStorage::new() else {
        return 0;
    };
    let now = chrono::Utc::now().timestamp_millis();
    let mut total_missed = 0_u64;
    for mut schedule in storage.get_all() {
        let missed = schedule.missed_occurrences(now);
        if missed == 0 {
            continue;
        }
        mark_schedule_missed(&mut schedule, missed);
        total_missed = total_missed.saturating_add(missed);
        if let Err(error) = storage.save(schedule) {
            log::warn!("[Scheduler] failed to record missed runs: {error}");
        }
    }
    if total_missed > 0 {
        let _ = app.emit("schedules-missed", json!({ "missedRuns": total_missed }));
    }
    total_missed
}

/// Spawns the minute-tick scheduler loop (called once from app setup).
pub fn spawn_scheduler(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Before the first tick: reap dispatches the previous session can never
        // report, then account for everything that elapsed while the app was
        // closed, then run what is due — that first pass is also what executes
        // `run_once` catch-ups exactly once.
        reap_stale_dispatches();
        reconcile_missed_schedules(&app);
        {
            let db_manager = app.state::<DatabaseManager>();
            run_due_schedules(&app, &db_manager).await;
        }
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
    use crate::storage::schedule_storage::ScheduleRunOutcome;
    #[test]
    fn single_selects_and_ctes_are_schedulable() {
        assert!(is_readonly_schedulable("SELECT * FROM users", None));
        assert!(is_readonly_schedulable("  select 1 ;", None));
        assert!(is_readonly_schedulable(
            "WITH recent AS (SELECT 1) SELECT * FROM recent",
            None
        ));
        // Dialect-aware: a MySQL server command the generic grammar cannot
        // parse is still a schedulable read on MySQL/MariaDB.
        assert!(is_readonly_schedulable(
            "SHOW FULL PROCESSLIST",
            Some(crate::database::models::DatabaseType::MySQL)
        ));
        assert!(!is_readonly_schedulable("SHOW FULL PROCESSLIST", None));
    }

    #[test]
    fn destructive_or_multi_statement_sql_is_refused() {
        assert!(!is_readonly_schedulable("DELETE FROM users", None));
        assert!(!is_readonly_schedulable("UPDATE users SET x = 1", None));
        assert!(!is_readonly_schedulable("DROP TABLE users", None));
        assert!(!is_readonly_schedulable("SELECT 1; DROP TABLE users", None));
        assert!(!is_readonly_schedulable("", None));
        // Reads that reach the filesystem are not schedulable either.
        assert!(!is_readonly_schedulable(
            "SELECT pg_read_file('/etc/passwd')",
            Some(crate::database::models::DatabaseType::PostgreSQL)
        ));
    }
    #[test]
    fn agent_run_status_accepts_only_real_outcomes() {
        assert_eq!(
            ScheduleRunOutcome::parse("ok").unwrap(),
            ScheduleRunOutcome::Ok
        );
        assert_eq!(
            ScheduleRunOutcome::parse(" OK ").unwrap(),
            ScheduleRunOutcome::Ok
        );
        assert_eq!(
            ScheduleRunOutcome::parse("error").unwrap(),
            ScheduleRunOutcome::Error
        );
        // A run that stopped needing a person is its own outcome, not a failure
        // and not a result.
        assert_eq!(
            ScheduleRunOutcome::parse("needs_human").unwrap(),
            ScheduleRunOutcome::NeedsHuman
        );
        // "dispatched" is written by the scheduler alone: a run reporting it as
        // its own outcome would leave a due task looking permanently pending.
        assert!(ScheduleRunOutcome::parse("dispatched").is_err());
        assert!(ScheduleRunOutcome::parse("success").is_err());
        assert!(ScheduleRunOutcome::parse("").is_err());
    }
}
