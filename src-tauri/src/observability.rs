use chrono::Utc;
use log::{LevelFilter, Log, Metadata, Record};
use regex::Regex;
use serde_json::json;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

struct RedactingLogger {
    file: Mutex<File>,
}

impl Log for RedactingLogger {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        metadata.level() <= log::Level::Info
    }

    fn log(&self, record: &Record<'_>) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let message = redact(&record.args().to_string());
        let operation_id = event_field(&message, "operation_id");
        let operation = event_field(&message, "operation");
        let status = event_field(&message, "status");
        let entry = json!({
            "timestamp": Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "level": record.level().to_string(),
            "target": record.target(),
            "operationId": operation_id,
            "operation": operation,
            "status": status,
            "message": message,
        });
        eprintln!("{} {}", record.level(), message);
        if let Ok(mut file) = self.file.lock() {
            let _ = writeln!(file, "{entry}");
        }
    }

    fn flush(&self) {
        if let Ok(mut file) = self.file.lock() {
            let _ = file.flush();
        }
    }
}

fn event_field(message: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}=");
    message
        .split_whitespace()
        .find_map(|part| part.strip_prefix(&prefix))
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub fn initialize(data_dir: &Path) -> Result<(), String> {
    let log_path = log_path(data_dir);
    if let Some(parent) = log_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    rotate_if_needed(&log_path).map_err(|error| error.to_string())?;
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| error.to_string())?;
    log::set_boxed_logger(Box::new(RedactingLogger {
        file: Mutex::new(file),
    }))
    .map_err(|error| error.to_string())?;
    log::set_max_level(LevelFilter::Info);
    Ok(())
}

pub fn log_path(data_dir: &Path) -> PathBuf {
    data_dir.join("logs").join("tabler.jsonl")
}

fn rotate_if_needed(path: &Path) -> io::Result<()> {
    if path.metadata().map(|metadata| metadata.len()).unwrap_or(0) < MAX_LOG_BYTES {
        return Ok(());
    }
    let rotated = path.with_extension("jsonl.1");
    if rotated.exists() {
        fs::remove_file(&rotated)?;
    }
    fs::rename(path, rotated)
}

pub fn redact(value: &str) -> String {
    static URL_PASSWORD: OnceLock<Regex> = OnceLock::new();
    static SECRET_VALUE: OnceLock<Regex> = OnceLock::new();
    static BEARER: OnceLock<Regex> = OnceLock::new();
    static SQL_LITERAL: OnceLock<Regex> = OnceLock::new();

    let value = URL_PASSWORD
        .get_or_init(|| Regex::new(r"(?i)([a-z][a-z0-9+.-]*://[^:/\s]+:)[^@\s]+@").unwrap())
        .replace_all(value, "$1[REDACTED]@");
    let value = BEARER
        .get_or_init(|| Regex::new(r"(?i)\bbearer\s+[a-z0-9._~+/-]+=*").unwrap())
        .replace_all(&value, "Bearer [REDACTED]");
    let value = SECRET_VALUE
        .get_or_init(|| Regex::new(r#"(?i)\b(password|passwd|token|api[_-]?key|authorization|secret|client[_-]?secret)\b(\s*[:=]\s*)(?:\"[^\"]*\"|'[^']*'|[^\s,;]+)"#).unwrap())
        .replace_all(&value, "$1$2[REDACTED]");
    SQL_LITERAL
        .get_or_init(|| Regex::new(r"'(?:''|[^'])*'").unwrap())
        .replace_all(&value, "'[REDACTED]'")
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::{event_field, redact};

    #[test]
    fn removes_credentials_tokens_and_sql_literals() {
        let source = "postgresql://alice:hunter2@localhost/db password=secret token: abc123 Authorization: Bearer eyJhbGci SELECT * FROM users WHERE email = 'private@example.com'";
        let sanitized = redact(source);
        for secret in [
            "hunter2",
            "secret",
            "abc123",
            "eyJhbGci",
            "private@example.com",
        ] {
            assert!(!sanitized.contains(secret), "secret leaked: {secret}");
        }
        assert!(sanitized.contains("[REDACTED]"));
    }

    #[test]
    fn extracts_structured_operation_fields() {
        let message = "operation_id=abc-123 operation=query.execute status=succeeded rows=2";
        assert_eq!(
            event_field(message, "operation_id").as_deref(),
            Some("abc-123")
        );
        assert_eq!(
            event_field(message, "operation").as_deref(),
            Some("query.execute")
        );
        assert_eq!(event_field(message, "status").as_deref(), Some("succeeded"));
        assert_eq!(event_field(message, "missing"), None);
    }
}
