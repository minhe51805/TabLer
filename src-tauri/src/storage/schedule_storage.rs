use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::storage::file_storage::{read_json_vec_with_backup, write_json_atomically};

/// Backend-run schedule: the scheduler executes the statement itself.
pub const SCHEDULE_KIND_SQL: &str = "sql";
/// Frontend-run schedule: the backend only dispatches the trigger, and the
/// in-app agent runs the prompt READ-ONLY while the app is open.
pub const SCHEDULE_KIND_AGENT: &str = "agent";
/// Status written when an agent task was handed to the frontend and its run has
/// not been reported back yet. Distinguishes "dispatched, unknown outcome" from
/// "ran successfully" — a dispatch is never reported as a result.
pub const SCHEDULE_STATUS_DISPATCHED: &str = "dispatched";
pub const SCHEDULE_STATUS_OK: &str = "ok";
pub const SCHEDULE_STATUS_ERROR: &str = "error";
/// A run that finished without an answer because it needed a human decision
/// (it wanted to ask a question, or every read it attempted was refused). Kept
/// distinct from "error" so the UI can say "needs you" instead of "failed", and
/// distinct from "ok" because a question is not a result.
pub const SCHEDULE_STATUS_NEEDS_HUMAN: &str = "needs_human";
/// Persisted error/report lengths, clamped so one broken run cannot bloat the
/// schedules file with a full stack trace or a whole model answer.
pub const MAX_PERSISTED_ERROR_CHARS: usize = 500;
pub const MAX_PERSISTED_SUMMARY_CHARS: usize = 400;

fn default_schedule_kind() -> String {
    SCHEDULE_KIND_SQL.to_string()
}

/// Truncates on a char boundary (never mid-codepoint) for safe UI display.
pub fn clamp_persisted_text(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    text.chars().take(max_chars).collect()
}

/// A saved query/task the scheduler fires on an interval while the app is open.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuerySchedule {
    pub id: String,
    pub name: String,
    /// Readonly statement the scheduler runs (guarded in the runner). Empty for
    /// `kind == "agent"`, where the work is described by `prompt` instead.
    pub sql: String,
    /// `"sql"` (default) or `"agent"`. Absent in pre-existing files → defaults
    /// to `"sql"`, so legacy rows keep their exact behaviour.
    #[serde(default = "default_schedule_kind")]
    pub kind: String,
    /// Natural-language task for `kind == "agent"`; absent for SQL schedules.
    #[serde(default)]
    pub prompt: Option<String>,
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
    /// `"ok"` | `"error"` | `"dispatched"` after the first run.
    #[serde(default)]
    pub last_status: Option<String>,
    #[serde(default)]
    pub last_rows: Option<u64>,
    #[serde(default)]
    pub last_error: Option<String>,
    /// Short report from the last completed agent run, so an unattended task
    /// leaves behind something readable in the UI.
    #[serde(default)]
    pub last_summary: Option<String>,
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

    /// True when this schedule is a frontend-run read-only agent task.
    pub fn is_agent_task(&self) -> bool {
        self.kind == SCHEDULE_KIND_AGENT
    }
}

/// Normalizes a caller-supplied kind. Unknown values are refused instead of
/// silently falling back to SQL — a typo must never turn an agent task into a
/// backend SQL run (or the reverse).
pub fn normalize_schedule_kind(kind: Option<&str>) -> Result<&'static str, String> {
    let normalized = kind
        .unwrap_or(SCHEDULE_KIND_SQL)
        .trim()
        .to_ascii_lowercase();
    if normalized.is_empty() || normalized == SCHEDULE_KIND_SQL {
        return Ok(SCHEDULE_KIND_SQL);
    }
    if normalized == SCHEDULE_KIND_AGENT {
        return Ok(SCHEDULE_KIND_AGENT);
    }
    Err(format!(
        "Unknown schedule kind \"{normalized}\": expected \"{SCHEDULE_KIND_SQL}\" or \"{SCHEDULE_KIND_AGENT}\"."
    ))
}

/// Records that an agent task was handed to the frontend. Stale report/error
/// fields are cleared so a previous run's outcome can never be read as this
/// dispatch's result.
pub fn mark_agent_task_dispatched(schedule: &mut QuerySchedule, now_millis: i64) {
    schedule.last_ran_at = Some(now_millis);
    schedule.last_status = Some(SCHEDULE_STATUS_DISPATCHED.to_string());
    schedule.last_rows = None;
    schedule.last_error = None;
    schedule.last_summary = None;
}

/// The outcome an agent task reported back: the only statuses a completion may
/// write. `dispatched` is absent on purpose — it belongs to the scheduler alone,
/// so a run can never leave its own trigger looking unanswered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScheduleRunOutcome {
    Ok,
    Error,
    NeedsHuman,
}

impl ScheduleRunOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            ScheduleRunOutcome::Ok => SCHEDULE_STATUS_OK,
            ScheduleRunOutcome::Error => SCHEDULE_STATUS_ERROR,
            ScheduleRunOutcome::NeedsHuman => SCHEDULE_STATUS_NEEDS_HUMAN,
        }
    }

    /// Parses the status a frontend reports. Refuses anything else — including
    /// "dispatched" — so a typo cannot invent a state the scheduler owns.
    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim().to_ascii_lowercase().as_str() {
            SCHEDULE_STATUS_OK => Ok(ScheduleRunOutcome::Ok),
            SCHEDULE_STATUS_ERROR => Ok(ScheduleRunOutcome::Error),
            SCHEDULE_STATUS_NEEDS_HUMAN => Ok(ScheduleRunOutcome::NeedsHuman),
            other => Err(format!(
                "Unknown agent run status \"{other}\": expected \"{SCHEDULE_STATUS_OK}\", \"{SCHEDULE_STATUS_ERROR}\" or \"{SCHEDULE_STATUS_NEEDS_HUMAN}\"."
            )),
        }
    }
}

/// Applies the outcome an agent task reported back.
pub fn apply_agent_run_outcome(
    schedule: &mut QuerySchedule,
    outcome: ScheduleRunOutcome,
    rows: Option<u64>,
    error: Option<String>,
    summary: Option<String>,
    now_millis: i64,
) {
    schedule.last_ran_at = Some(now_millis);
    schedule.last_status = Some(outcome.as_str().to_string());
    schedule.last_rows = rows;
    schedule.last_error = error
        .map(|message| clamp_persisted_text(&message, MAX_PERSISTED_ERROR_CHARS))
        .filter(|message| !message.trim().is_empty());
    schedule.last_summary = summary
        .map(|text| clamp_persisted_text(text.trim(), MAX_PERSISTED_SUMMARY_CHARS))
        .filter(|text| !text.is_empty());
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
    use super::{
        apply_agent_run_outcome, clamp_persisted_text, mark_agent_task_dispatched,
        normalize_schedule_kind, QuerySchedule, ScheduleRunOutcome, MAX_PERSISTED_SUMMARY_CHARS,
        SCHEDULE_KIND_AGENT, SCHEDULE_KIND_SQL, SCHEDULE_STATUS_DISPATCHED, SCHEDULE_STATUS_ERROR,
        SCHEDULE_STATUS_NEEDS_HUMAN, SCHEDULE_STATUS_OK,
    };

    fn schedule(interval_seconds: u64, last_ran_at: Option<i64>, enabled: bool) -> QuerySchedule {
        QuerySchedule {
            id: "s1".into(),
            name: "nightly".into(),
            sql: "SELECT 1".into(),
            kind: SCHEDULE_KIND_SQL.into(),
            prompt: None,
            connection_id: None,
            database: None,
            interval_seconds,
            enabled,
            last_ran_at,
            last_status: None,
            last_rows: None,
            last_error: None,
            last_summary: None,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn agent_schedule() -> QuerySchedule {
        QuerySchedule {
            prompt: Some("Summarize yesterday's failures".into()),
            sql: String::new(),
            kind: SCHEDULE_KIND_AGENT.into(),
            ..schedule(3_600, None, true)
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

    #[test]
    fn legacy_rows_without_kind_load_as_sql_schedules() {
        // The pre-P10 file shape: no kind / prompt / lastSummary keys at all.
        let legacy = r#"[{
            "id": "old",
            "name": "nightly",
            "sql": "SELECT 1",
            "intervalSeconds": 60,
            "enabled": true,
            "createdAt": "",
            "updatedAt": ""
        }]"#;
        let parsed: Vec<QuerySchedule> = serde_json::from_str(legacy).expect("legacy json parses");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].kind, SCHEDULE_KIND_SQL);
        assert!(!parsed[0].is_agent_task());
        assert!(parsed[0].prompt.is_none());
        assert!(parsed[0].last_summary.is_none());
    }

    #[test]
    fn unknown_schedule_kinds_are_refused_instead_of_defaulting() {
        assert_eq!(normalize_schedule_kind(None).unwrap(), SCHEDULE_KIND_SQL);
        assert_eq!(
            normalize_schedule_kind(Some("  ")).unwrap(),
            SCHEDULE_KIND_SQL
        );
        assert_eq!(
            normalize_schedule_kind(Some("SQL")).unwrap(),
            SCHEDULE_KIND_SQL
        );
        assert_eq!(
            normalize_schedule_kind(Some(" agent ")).unwrap(),
            SCHEDULE_KIND_AGENT
        );
        assert!(normalize_schedule_kind(Some("agentic")).is_err());
    }

    #[test]
    fn dispatch_clears_a_previous_report() {
        let mut s = agent_schedule();
        apply_agent_run_outcome(
            &mut s,
            ScheduleRunOutcome::Ok,
            Some(4),
            None,
            Some("previous answer".into()),
            1_000,
        );
        assert_eq!(s.last_status.as_deref(), Some(SCHEDULE_STATUS_OK));

        mark_agent_task_dispatched(&mut s, 2_000);
        assert_eq!(s.last_ran_at, Some(2_000));
        assert_eq!(s.last_status.as_deref(), Some(SCHEDULE_STATUS_DISPATCHED));
        assert!(s.last_summary.is_none());
        assert!(s.last_rows.is_none());
        assert!(s.last_error.is_none());
    }

    #[test]
    fn completion_records_the_reported_outcome_and_clamps_the_report() {
        let mut s = agent_schedule();
        apply_agent_run_outcome(
            &mut s,
            ScheduleRunOutcome::Error,
            None,
            Some("boom".into()),
            Some("x".repeat(MAX_PERSISTED_SUMMARY_CHARS + 50)),
            5_000,
        );
        assert_eq!(s.last_ran_at, Some(5_000));
        assert_eq!(s.last_status.as_deref(), Some(SCHEDULE_STATUS_ERROR));
        assert_eq!(s.last_error.as_deref(), Some("boom"));
        assert_eq!(
            s.last_summary.as_deref().map(|text| text.chars().count()),
            Some(MAX_PERSISTED_SUMMARY_CHARS)
        );

        // A blank report must stay absent rather than persist an empty string.
        apply_agent_run_outcome(
            &mut s,
            ScheduleRunOutcome::Ok,
            Some(2),
            None,
            Some("   ".into()),
            6_000,
        );
        assert!(s.last_summary.is_none());
        assert!(s.last_error.is_none());
        assert_eq!(s.last_rows, Some(2));
    }

    #[test]
    fn a_run_that_needs_a_human_is_not_reported_as_a_failure_or_a_result() {
        let mut s = agent_schedule();
        apply_agent_run_outcome(
            &mut s,
            ScheduleRunOutcome::NeedsHuman,
            None,
            None,
            Some("[read-only] refused 1 blocked tool call(s): ask_user".into()),
            7_000,
        );
        assert_eq!(s.last_status.as_deref(), Some(SCHEDULE_STATUS_NEEDS_HUMAN));
        assert_ne!(s.last_status.as_deref(), Some(SCHEDULE_STATUS_OK));
        assert_ne!(s.last_status.as_deref(), Some(SCHEDULE_STATUS_ERROR));
        assert!(s.last_error.is_none());
    }

    #[test]
    fn clamping_never_splits_a_codepoint() {
        let text = "ẩn".repeat(4);
        let clamped = clamp_persisted_text(&text, 3);
        assert_eq!(clamped, "ẩnẩ");
        assert_eq!(clamped.chars().count(), 3);
    }
}
