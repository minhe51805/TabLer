use serde::Serializer;

/// Unified application error (roadmap Phase 1C).
///
/// Every variant renders a user-safe message via `Display` and the `Serialize`
/// implementation emits exactly that string, so Tauri IPC keeps delivering
/// plain string errors to the frontend — commands can migrate to
/// `Result<T, AppError>` without any frontend shape change.
#[derive(Debug, thiserror::Error)]
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
    #[error("{0}")]
    Other(String),
}

impl AppError {
    /// Consumes the error into its user-facing message.
    pub fn into_string(self) -> String {
        self.to_string()
    }
}

impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<anyhow::Error> for AppError {
    fn from(error: anyhow::Error) -> Self {
        AppError::Other(error.to_string())
    }
}

impl From<String> for AppError {
    fn from(message: String) -> Self {
        AppError::Other(message)
    }
}

impl From<&str> for AppError {
    fn from(message: &str) -> Self {
        AppError::Other(message.to_string())
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
    use super::AppError;

    #[test]
    fn serializes_as_plain_string_for_ipc_compatibility() {
        let serialized = serde_json::to_string(&AppError::Query("boom".to_string())).unwrap();
        assert_eq!(serialized, "\"Query error: boom\"");
    }

    #[test]
    fn converts_from_anyhow_string_and_io() {
        let anyhow_error = AppError::from(anyhow::anyhow!("driver exploded"));
        assert!(anyhow_error.to_string().contains("driver exploded"));

        assert_eq!(AppError::from("plain".to_string()).into_string(), "plain");
        assert!(
            AppError::from(std::io::Error::new(std::io::ErrorKind::NotFound, "missing",))
                .to_string()
                .starts_with("Storage error:")
        );
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
    }
}
