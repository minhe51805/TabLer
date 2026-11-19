use serde::Serializer;
use std::fmt::{self, Write as _};

/// Machine-readable error taxonomy serialized across Tauri IPC.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorCode {
    ConnectionNotFound,
    ConnectionError,
    QueryError,
    QueryCancelled,
    QueryTimeout,
    ValidationError,
    StorageError,
    RateLimited,
    SandboxDenied,
    SandboxThrottled,
    SafeModeBlocked,
    AiCancelled,
    AiTimeout,
    AiAuth,
    AiBadRequest,
    AiRateLimited,
    AiProviderTransient,
    AiInvalidResponse,
    Internal,
}

impl ErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            ErrorCode::ConnectionNotFound => "connection-not-found",
            ErrorCode::ConnectionError => "connection-error",
            ErrorCode::QueryError => "query-error",
            ErrorCode::QueryCancelled => "query-cancelled",
            ErrorCode::QueryTimeout => "query-timeout",
            ErrorCode::ValidationError => "validation-error",
            ErrorCode::StorageError => "storage-error",
            ErrorCode::RateLimited => "rate-limited",
            ErrorCode::SandboxDenied => "sandbox-denied",
            ErrorCode::SandboxThrottled => "sandbox-throttled",
            ErrorCode::SafeModeBlocked => "safe-mode-blocked",
            ErrorCode::AiCancelled => "ai-cancelled",
            ErrorCode::AiTimeout => "ai-timeout",
            ErrorCode::AiAuth => "ai-auth",
            ErrorCode::AiBadRequest => "ai-bad-request",
            ErrorCode::AiRateLimited => "ai-rate-limited",
            ErrorCode::AiProviderTransient => "ai-provider-transient",
            ErrorCode::AiInvalidResponse => "ai-invalid-response",
            ErrorCode::Internal => "internal",
        }
    }
}

/// Unified application error serialized over Tauri IPC as structured JSON:
/// `{ code, message, retryable, retryAfterMs?, stage?, hint? }`.
#[derive(Debug, Clone, thiserror::Error)]
pub enum AppError {
    #[error("Connection error: {0}")]
    Connection(String),
    #[error("Query error: {0}")]
    Query(String),
    #[error("Validation error: {0}")]
    Validation(String),
    #[error("Storage error: {0}")]
    Storage(String),
    #[error("Rate limited: {0}")]
    RateLimited(String),
    #[error("Sandbox execution throttled: {0}")]
    SandboxThrottled(String),
    #[error("{0}")]
    Other(String),
    #[error("{message}")]
    Structured {
        code: ErrorCode,
        message: String,
        retryable: bool,
        retry_after_ms: Option<u64>,
        stage: Option<String>,
        hint: Option<String>,
    },
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AppErrorWire<'a> {
    code: ErrorCode,
    message: &'a str,
    retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    retry_after_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stage: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    hint: Option<&'a str>,
}

impl AppError {
    pub fn structured(code: ErrorCode, message: impl Into<String>, retryable: bool) -> Self {
        Self::Structured {
            code,
            message: message.into(),
            retryable,
            retry_after_ms: None,
            stage: None,
            hint: None,
        }
    }

    pub fn ai(
        code: ErrorCode,
        message: impl Into<String>,
        retryable: bool,
        retry_after_ms: Option<u64>,
    ) -> Self {
        Self::Structured {
            code,
            message: message.into(),
            retryable,
            retry_after_ms,
            stage: None,
            hint: None,
        }
    }

    pub fn connection_not_found(message: impl Into<String>) -> Self {
        Self::structured(ErrorCode::ConnectionNotFound, message, false)
    }

    pub fn connection_failure(
        stage: impl Into<String>,
        message: impl Into<String>,
        hint: impl Into<String>,
        retryable: bool,
    ) -> Self {
        Self::Structured {
            code: ErrorCode::ConnectionError,
            message: message.into(),
            retryable,
            retry_after_ms: None,
            stage: Some(stage.into()),
            hint: Some(hint.into()),
        }
    }

    pub fn query_cancelled(message: impl Into<String>) -> Self {
        Self::structured(ErrorCode::QueryCancelled, message, true)
    }

    pub fn query_timeout(message: impl Into<String>) -> Self {
        Self::structured(ErrorCode::QueryTimeout, message, true)
    }

    pub fn sandbox_denied(message: impl Into<String>) -> Self {
        Self::structured(ErrorCode::SandboxDenied, message, false)
    }

    pub fn safe_mode_blocked(message: impl Into<String>) -> Self {
        Self::structured(ErrorCode::SafeModeBlocked, message, false)
    }

    pub fn rate_limited_raw(message: impl Into<String>) -> Self {
        Self::structured(ErrorCode::RateLimited, message, false)
    }

    pub fn with_retry_after_ms(mut self, retry_after_ms: Option<u64>) -> Self {
        if let Self::Structured {
            retry_after_ms: ref mut slot,
            ..
        } = self
        {
            *slot = retry_after_ms;
            return self;
        }
        let code = self.code();
        let retryable = self.retryable();
        let message = self.to_string();
        Self::Structured {
            code,
            message,
            retryable,
            retry_after_ms,
            stage: None,
            hint: None,
        }
    }

    pub fn code(&self) -> ErrorCode {
        match self {
            Self::Connection(_) => ErrorCode::ConnectionError,
            Self::Query(_) => ErrorCode::QueryError,
            Self::Validation(_) => ErrorCode::ValidationError,
            Self::Storage(_) => ErrorCode::StorageError,
            Self::RateLimited(_) => ErrorCode::RateLimited,
            Self::SandboxThrottled(_) => ErrorCode::SandboxThrottled,
            Self::Other(_) => ErrorCode::Internal,
            Self::Structured { code, .. } => *code,
        }
    }

    pub fn retryable(&self) -> bool {
        match self {
            Self::SandboxThrottled(_) => true,
            Self::Structured { retryable, .. } => *retryable,
            Self::Connection(_)
            | Self::Query(_)
            | Self::Validation(_)
            | Self::Storage(_)
            | Self::RateLimited(_)
            | Self::Other(_) => false,
        }
    }

    pub fn retry_after_ms(&self) -> Option<u64> {
        match self {
            Self::Structured { retry_after_ms, .. } => *retry_after_ms,
            _ => None,
        }
    }

    pub fn stage(&self) -> Option<&str> {
        match self {
            Self::Structured { stage, .. } => stage.as_deref(),
            _ => None,
        }
    }

    pub fn hint(&self) -> Option<&str> {
        match self {
            Self::Structured { hint, .. } => hint.as_deref(),
            _ => None,
        }
    }

    /// Consumes the error into its user-facing message.
    pub fn into_string(self) -> String {
        self.to_string()
    }

    pub fn contains(&self, pattern: &str) -> bool {
        self.to_string().contains(pattern)
    }

    pub fn starts_with(&self, pattern: &str) -> bool {
        self.to_string().starts_with(pattern)
    }

    pub fn ends_with(&self, pattern: &str) -> bool {
        self.to_string().ends_with(pattern)
    }

    pub fn is_empty(&self) -> bool {
        self.to_string().is_empty()
    }

    pub fn to_lowercase(&self) -> String {
        self.to_string().to_lowercase()
    }

    pub fn to_ascii_lowercase(&self) -> String {
        self.to_string().to_ascii_lowercase()
    }

    /// Auto-classifies legacy `String` errors originating from deep helpers so
    /// command boundaries migrating from `Result<T, String>` emit accurate
    /// `ErrorCode` metadata while keeping exact `Display` text.
    pub fn from_legacy_message(message: String) -> Self {
        if let Some(stripped) = message.strip_prefix("SANDBOX_DENIED:") {
            return Self::sandbox_denied(stripped.trim_start());
        }
        if message.contains("not found. Please connect first.")
            || message.contains("selected connection is not active")
        {
            return Self::connection_not_found(message);
        }
        if message.starts_with("[Safe Mode level")
            || message.starts_with("Blocked by Safe Mode")
            || message.starts_with("Safe Mode could not classify")
        {
            return Self::safe_mode_blocked(message);
        }
        if message == "Query cancelled." {
            return Self::query_cancelled(message);
        }
        if message == "AI request cancelled." {
            return Self::ai(ErrorCode::AiCancelled, message, false, None);
        }
        if message.starts_with("Too many AI requests")
            || message.starts_with("Too many connection attempts")
        {
            return Self::rate_limited_raw(message);
        }
        let lower = message.to_ascii_lowercase();
        if (lower.contains("query timed out") || lower.contains("write preview timed out"))
            && !lower.contains("ai ")
        {
            return Self::query_timeout(message);
        }
        Self::Other(message)
    }
}

impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let rendered = self.to_string();
        let wire = AppErrorWire {
            code: self.code(),
            message: &rendered,
            retryable: self.retryable(),
            retry_after_ms: self.retry_after_ms(),
            stage: self.stage(),
            hint: self.hint(),
        };
        wire.serialize(serializer)
    }
}

struct StrEq<'a> {
    remaining: &'a str,
    matched: bool,
}

impl fmt::Write for StrEq<'_> {
    fn write_str(&mut self, s: &str) -> fmt::Result {
        if !self.matched {
            return Ok(());
        }
        match self.remaining.strip_prefix(s) {
            Some(rest) => self.remaining = rest,
            None => self.matched = false,
        }
        Ok(())
    }
}

impl AppError {
    fn eq_str(&self, other: &str) -> bool {
        let mut cmp = StrEq {
            remaining: other,
            matched: true,
        };
        let _ = write!(cmp, "{self}");
        cmp.matched && cmp.remaining.is_empty()
    }
}

impl PartialEq<str> for AppError {
    fn eq(&self, other: &str) -> bool {
        self.eq_str(other)
    }
}

impl PartialEq<&str> for AppError {
    fn eq(&self, other: &&str) -> bool {
        self.eq_str(other)
    }
}

impl PartialEq<String> for AppError {
    fn eq(&self, other: &String) -> bool {
        self.eq_str(other.as_str())
    }
}

impl From<anyhow::Error> for AppError {
    fn from(error: anyhow::Error) -> Self {
        Self::from_legacy_message(error.to_string())
    }
}

impl From<String> for AppError {
    fn from(message: String) -> Self {
        Self::from_legacy_message(message)
    }
}

impl From<&str> for AppError {
    fn from(message: &str) -> Self {
        Self::from_legacy_message(message.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> Self {
        AppError::Storage(error.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(error: serde_json::Error) -> Self {
        AppError::Validation(error.to_string())
    }
}

impl From<tauri::Error> for AppError {
    fn from(error: tauri::Error) -> Self {
        AppError::Other(error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::{AppError, ErrorCode};

    #[test]
    fn serializes_as_structured_camel_case_ipc_payload() {
        let value = serde_json::to_value(AppError::Query("boom".to_string())).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "code": "query-error",
                "message": "Query error: boom",
                "retryable": false,
            })
        );

        let ai_rate_limited = serde_json::to_value(AppError::ai(
            ErrorCode::AiRateLimited,
            "Provider asked to wait",
            true,
            Some(4000),
        ))
        .unwrap();
        assert_eq!(
            ai_rate_limited,
            serde_json::json!({
                "code": "ai-rate-limited",
                "message": "Provider asked to wait",
                "retryable": true,
                "retryAfterMs": 4000,
            })
        );
    }

    #[test]
    fn converts_from_anyhow_string_and_io_and_classifies_known_boundaries() {
        let anyhow_error = AppError::from(anyhow::anyhow!("driver exploded"));
        assert!(anyhow_error.contains("driver exploded"));
        assert_eq!(anyhow_error.code(), ErrorCode::Internal);

        assert_eq!(AppError::from("plain".to_string()).into_string(), "plain");
        assert!(
            AppError::from(std::io::Error::new(std::io::ErrorKind::NotFound, "missing"))
                .starts_with("Storage error:")
        );

        let missing_conn =
            AppError::from("Connection 'c1' not found. Please connect first.".to_string());
        assert_eq!(missing_conn.code(), ErrorCode::ConnectionNotFound);

        let safe_mode = AppError::from(
            "[Safe Mode level 1 (Read Only)] This statement is blocked.".to_string(),
        );
        assert_eq!(safe_mode.code(), ErrorCode::SafeModeBlocked);

        let sandbox = AppError::from("SANDBOX_DENIED: blocked capability".to_string());
        assert_eq!(sandbox.code(), ErrorCode::SandboxDenied);
        assert_eq!(sandbox.to_string(), "blocked capability");

        let ai_cancelled = AppError::from("AI request cancelled.".to_string());
        assert_eq!(ai_cancelled.code(), ErrorCode::AiCancelled);
        assert!(!ai_cancelled.retryable());
    }

    #[test]
    fn validation_and_rate_limit_messages_render() {
        assert_eq!(
            AppError::Validation("bad input".to_string()).to_string(),
            "Validation error: bad input"
        );
        assert_eq!(
            AppError::RateLimited("too many".to_string()).to_string(),
            "Rate limited: too many"
        );
        let throttled = AppError::SandboxThrottled("burst exceeded".to_string());
        assert_eq!(
            throttled.to_string(),
            "Sandbox execution throttled: burst exceeded"
        );
        assert!(throttled.retryable());
    }
}
