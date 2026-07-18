use crate::observability::{log_path, redact};
use crate::utils::paths::resolve_data_dir;
use chrono::{Duration, Utc};
use rfd::FileDialog;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::sync::Mutex;
use tauri::State;
use uuid::Uuid;

const REVIEW_TTL_MINUTES: i64 = 10;
const MAX_LOG_LINES: usize = 5_000;

#[derive(Default)]
pub struct DiagnosticReviewState(Mutex<HashMap<String, chrono::DateTime<Utc>>>);

impl DiagnosticReviewState {
    fn issue(&self, now: chrono::DateTime<Utc>) -> Result<(String, chrono::DateTime<Utc>), String> {
        let review_id = Uuid::new_v4().to_string();
        let expires_at = now + Duration::minutes(REVIEW_TTL_MINUTES);
        let mut reviews = self
            .0
            .lock()
            .map_err(|_| "Diagnostic review state is unavailable".to_string())?;
        reviews.retain(|_, expires_at| *expires_at >= now);
        reviews.insert(review_id.clone(), expires_at);
        Ok((review_id, expires_at))
    }

    fn consume(&self, review_id: &str, now: chrono::DateTime<Utc>) -> Result<(), String> {
        let expires_at = self
            .0
            .lock()
            .map_err(|_| "Diagnostic review state is unavailable".to_string())?
            .remove(review_id)
            .ok_or_else(|| {
                "Review this diagnostic bundle again before exporting it.".to_string()
            })?;
        if expires_at < now {
            return Err(
                "The diagnostic review expired. Review the bundle again before exporting it."
                    .into(),
            );
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticPreview {
    review_id: String,
    expires_at: String,
    categories: Vec<String>,
    log_entries: usize,
    estimated_bytes: u64,
    excluded: Vec<String>,
}

fn read_sanitized_logs() -> Result<Vec<Value>, String> {
    let data_dir = resolve_data_dir().map_err(|error| error.to_string())?;
    let path = log_path(&data_dir);
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    Ok(content
        .lines()
        .rev()
        .take(MAX_LOG_LINES)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .map(|line| {
            let sanitized = redact(line);
            serde_json::from_str(&sanitized).unwrap_or_else(|_| json!({ "message": sanitized }))
        })
        .collect())
}

#[tauri::command]
pub fn preview_diagnostic_bundle(
    reviews: State<'_, DiagnosticReviewState>,
) -> Result<DiagnosticPreview, String> {
    let logs = read_sanitized_logs()?;
    let estimated_bytes = serde_json::to_vec(&logs)
        .map_err(|error| error.to_string())?
        .len() as u64;
    let (review_id, expires_at) = reviews.issue(Utc::now())?;
    Ok(DiagnosticPreview {
        review_id,
        expires_at: expires_at.to_rfc3339(),
        categories: vec![
            "App version and operating system".into(),
            "Redacted application logs".into(),
        ],
        log_entries: logs.len(),
        estimated_bytes,
        excluded: vec![
            "Saved connections and credentials".into(),
            "AI keys and conversation data".into(),
            "Query results and database rows".into(),
        ],
    })
}

#[tauri::command]
pub fn export_diagnostic_bundle(
    review_id: String,
    reviews: State<'_, DiagnosticReviewState>,
) -> Result<Option<String>, String> {
    let now = Utc::now();
    reviews.consume(&review_id, now)?;
    let Some(path) = FileDialog::new()
        .set_title("Export TableR diagnostics")
        .set_file_name("tabler-diagnostics.json")
        .add_filter("JSON", &["json"])
        .save_file()
    else {
        return Ok(None);
    };
    let bundle = json!({
        "schemaVersion": 1,
        "generatedAt": now.to_rfc3339(),
        "application": { "name": "TableR", "version": env!("CARGO_PKG_VERSION") },
        "platform": { "os": std::env::consts::OS, "arch": std::env::consts::ARCH },
        "redactionApplied": true,
        "logs": read_sanitized_logs()?,
    });
    fs::write(
        &path,
        serde_json::to_vec_pretty(&bundle).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    log::info!(
        "operation_id={} operation=diagnostics.export status=succeeded",
        Uuid::new_v4()
    );
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::DiagnosticReviewState;
    use chrono::{Duration, Utc};

    #[test]
    fn review_tokens_are_required_one_time_and_expiring() {
        let state = DiagnosticReviewState::default();
        let now = Utc::now();
        let (review_id, _) = state.issue(now).unwrap();
        assert!(state.consume(&review_id, now).is_ok());
        assert!(state.consume(&review_id, now).is_err());

        let (expired_id, _) = state.issue(now).unwrap();
        assert!(state
            .consume(&expired_id, now + Duration::minutes(11))
            .is_err());
    }
}
