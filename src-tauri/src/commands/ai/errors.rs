use crate::database::ai_models::{AIProviderConfig, AIProviderType};
use reqwest::{StatusCode, Url};

/// Machine-readable classification appended to a finished AI error message so
/// the frontend (`normalizeAIRequestError` in `src/utils/ai-request-errors.ts`)
/// can route retry/failover decisions off an authoritative marker instead of
/// guessing from substrings (tech-debt D7). The frontend strips this suffix
/// before showing the message, so users never see it. The kind strings mirror
/// the frontend `AIRequestErrorCode` union; the shared contract lives in
/// `tests/fixtures/ai-error-kinds.json`.
pub(crate) const AI_ERROR_KIND_MARKER_KEY: &str = "ai_error_kind";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AiErrorKind {
    Cancelled,
    Timeout,
    Provider,
    InvalidResponse,
}

impl AiErrorKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            AiErrorKind::Cancelled => "cancelled",
            AiErrorKind::Timeout => "timeout",
            AiErrorKind::Provider => "provider",
            AiErrorKind::InvalidResponse => "invalid-response",
        }
    }
}

/// Appends the machine-readable kind marker to a finished error message.
pub(crate) fn tag_ai_error_kind(message: String, kind: AiErrorKind) -> String {
    format!("{message} [{AI_ERROR_KIND_MARKER_KEY}={}]", kind.as_str())
}


pub(crate) fn ai_storage_load_error() -> String {
    "Could not load AI provider settings.".to_string()
}

pub(crate) fn ai_storage_save_error() -> String {
    "Could not save AI provider settings.".to_string()
}

pub(crate) fn ai_provider_config_error() -> String {
    "The active AI provider is not configured correctly.".to_string()
}

pub(crate) fn ai_provider_request_error(
    config: &AIProviderConfig,
    endpoint: &str,
    error: &reqwest::Error,
) -> String {
    let provider_label = if config.name.trim().is_empty() {
        format!("{:?}", config.provider_type)
    } else {
        config.name.trim().to_string()
    };

    let endpoint_label = Url::parse(endpoint)
        .ok()
        .and_then(|url| {
            let host = url.host_str()?.to_string();
            let port = url
                .port()
                .map(|value| format!(":{value}"))
                .unwrap_or_default();
            Some(format!("{host}{port}"))
        })
        .unwrap_or_else(|| endpoint.to_string());

    let raw_error = error.to_string();
    let normalized_error = raw_error.to_ascii_lowercase();

    let detail = if error.is_timeout() {
        format!("The request to {endpoint_label} timed out.")
    } else if config.provider_type == AIProviderType::Ollama
        || endpoint_label.contains("localhost")
        || endpoint_label.contains("127.0.0.1")
    {
        if normalized_error.contains("connection refused")
            || normalized_error.contains("actively refused")
        {
            format!(
                "Could not connect to the local AI service at {endpoint_label}. Make sure Ollama is running, then try again."
            )
        } else if normalized_error.contains("dns")
            || normalized_error.contains("name or service not known")
        {
            format!(
                "The local AI endpoint {endpoint_label} could not be resolved. Check the endpoint setting."
            )
        } else {
            format!(
                "Could not reach the local AI service at {endpoint_label}. Make sure the endpoint is correct."
            )
        }
    } else if normalized_error.contains("certificate")
        || normalized_error.contains("tls")
        || normalized_error.contains("ssl")
    {
        format!(
            "The connection to {endpoint_label} failed because of an SSL/TLS certificate problem."
        )
    } else if normalized_error.contains("dns")
        || normalized_error.contains("name or service not known")
        || normalized_error.contains("failed to lookup address information")
    {
        format!("The hostname for {endpoint_label} could not be resolved.")
    } else if normalized_error.contains("connection refused")
        || normalized_error.contains("actively refused")
    {
        format!("The AI provider at {endpoint_label} refused the connection.")
    } else {
        format!("Could not reach {endpoint_label}. Check the endpoint and network connection.")
    };

    let kind = if error.is_timeout() {
        AiErrorKind::Timeout
    } else {
        AiErrorKind::Provider
    };
    tag_ai_error_kind(
        format!("The AI request to \"{provider_label}\" could not be completed. {detail}"),
        kind,
    )
}

pub(crate) fn ai_provider_response_error() -> String {
    tag_ai_error_kind(
        "The AI provider returned an invalid or unsupported response.".to_string(),
        AiErrorKind::InvalidResponse,
    )
}

fn is_sensitive_response_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();

    [
        "apikey",
        "authorization",
        "credential",
        "password",
        "secret",
        "token",
    ]
    .iter()
    .any(|sensitive| normalized.contains(sensitive))
}

fn redact_sensitive_json(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(entries) => {
            for (key, value) in entries {
                if is_sensitive_response_key(key) {
                    *value = serde_json::Value::String("[REDACTED]".to_string());
                } else {
                    redact_sensitive_json(value);
                }
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                redact_sensitive_json(item);
            }
        }
        _ => {}
    }
}

fn redact_known_secrets(value: &str, api_key: Option<&str>) -> String {
    let mut redacted = value.to_string();
    if let Some(secret) = api_key.map(str::trim).filter(|secret| secret.len() >= 4) {
        redacted = redacted.replace(secret, "[REDACTED]");
    }
    redacted
}

fn truncate_preview(value: &str) -> String {
    const PREVIEW_LIMIT: usize = 320;
    let mut characters = value.chars();
    let preview = characters.by_ref().take(PREVIEW_LIMIT).collect::<String>();
    if characters.next().is_some() {
        format!(
            "{}...",
            preview.chars().take(PREVIEW_LIMIT - 3).collect::<String>()
        )
    } else {
        preview
    }
}

fn compact_response_preview(body: &str, api_key: Option<&str>) -> String {
    let redacted = if let Ok(mut payload) = serde_json::from_str::<serde_json::Value>(body) {
        redact_sensitive_json(&mut payload);
        payload.to_string()
    } else {
        body.to_string()
    };
    let compact = redact_known_secrets(&redacted, api_key)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    truncate_preview(&compact)
}

pub(crate) fn ai_provider_api_error(message: &str, api_key: Option<&str>) -> String {
    tag_ai_error_kind(
        format!("AI API error: {}", compact_response_preview(message, api_key)),
        AiErrorKind::Provider,
    )
}

/// Read the provider's `Retry-After` header (seconds form, the common 429
/// case) so the frontend can wait exactly as long as the provider asks
/// instead of guessing. HTTP-date forms are ignored — the seconds form is
/// what every rate-limiting AI provider emits.
pub(crate) fn response_retry_after_seconds(response: &reqwest::Response) -> Option<u64> {
    let raw = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?;
    raw.trim().parse::<u64>().ok()
}

pub(crate) fn ai_provider_http_status_error(
    config: &AIProviderConfig,
    endpoint: &str,
    status: StatusCode,
    body: &str,
    api_key: Option<&str>,
    retry_after_seconds: Option<u64>,
) -> String {
    let provider_label = if config.name.trim().is_empty() {
        format!("{:?}", config.provider_type)
    } else {
        config.name.trim().to_string()
    };
    let endpoint_label = Url::parse(endpoint)
        .ok()
        .and_then(|url| {
            let host = url.host_str()?.to_string();
            let port = url
                .port()
                .map(|value| format!(":{value}"))
                .unwrap_or_default();
            Some(format!("{host}{port}"))
        })
        .unwrap_or_else(|| endpoint.to_string());
    let status_label = status
        .canonical_reason()
        .map(|reason| format!("{} {}", status.as_u16(), reason))
        .unwrap_or_else(|| status.as_u16().to_string());
    let preview = compact_response_preview(body, api_key);
    let retry_note = if matches!(
        status,
        StatusCode::BAD_GATEWAY
            | StatusCode::SERVICE_UNAVAILABLE
            | StatusCode::GATEWAY_TIMEOUT
            | StatusCode::TOO_MANY_REQUESTS
    ) {
        match retry_after_seconds {
            // Machine-readable marker: normalizeAIRequestError on the
            // frontend extracts `retry_after_ms=<n>` from this text and
            // waits exactly that long before retrying.
            Some(seconds) => format!(
                " This looks temporary on the provider side. It asks to retry after {seconds} s (retry_after_ms={}).",
                seconds.saturating_mul(1000)
            ),
            None => " This looks temporary on the provider side. Please try again in a moment.".to_string(),
        }
    } else {
        String::new()
    };

    let message = if preview.is_empty() {
        format!(
            "The AI provider \"{provider_label}\" at {endpoint_label} returned HTTP {status_label}.{retry_note}"
        )
    } else {
        format!(
            "The AI provider \"{provider_label}\" at {endpoint_label} returned HTTP {status_label}. Response preview: {preview}{retry_note}"
        )
    };
    tag_ai_error_kind(message, AiErrorKind::Provider)
}

pub(crate) fn ai_provider_non_json_response_error(
    config: &AIProviderConfig,
    endpoint: &str,
    body: &str,
    api_key: Option<&str>,
) -> String {
    let provider_label = if config.name.trim().is_empty() {
        format!("{:?}", config.provider_type)
    } else {
        config.name.trim().to_string()
    };
    let endpoint_label = Url::parse(endpoint)
        .ok()
        .and_then(|url| {
            let host = url.host_str()?.to_string();
            let port = url
                .port()
                .map(|value| format!(":{value}"))
                .unwrap_or_default();
            Some(format!("{host}{port}"))
        })
        .unwrap_or_else(|| endpoint.to_string());
    let preview = compact_response_preview(body, api_key);

    tag_ai_error_kind(
        format!(
            "The AI provider \"{provider_label}\" at {endpoint_label} returned a non-JSON response. Response preview: {preview}"
        ),
        AiErrorKind::InvalidResponse,
    )
}

pub(crate) fn ai_provider_response_error_with_preview(
    config: &AIProviderConfig,
    endpoint: &str,
    payload: &serde_json::Value,
    api_key: Option<&str>,
) -> String {
    let provider_label = if config.name.trim().is_empty() {
        format!("{:?}", config.provider_type)
    } else {
        config.name.trim().to_string()
    };
    let endpoint_label = Url::parse(endpoint)
        .ok()
        .and_then(|url| {
            let host = url.host_str()?.to_string();
            let port = url
                .port()
                .map(|value| format!(":{value}"))
                .unwrap_or_default();
            Some(format!("{host}{port}"))
        })
        .unwrap_or_else(|| endpoint.to_string());

    let compact_preview = compact_response_preview(&payload.to_string(), api_key);

    tag_ai_error_kind(
        format!(
            "The AI provider \"{provider_label}\" at {endpoint_label} returned an unsupported response shape. Response preview: {compact_preview}"
        ),
        AiErrorKind::InvalidResponse,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn response_previews_redact_nested_credentials_and_known_secrets() {
        let secret = "sk-super-secret-1234";
        let body = json!({
            "error": {
                "message": format!("Rejected credential {secret}"),
                "api_key": secret,
                "details": [{ "refreshToken": secret }, { "password": "hunter2" }]
            }
        })
        .to_string();

        let preview = compact_response_preview(&body, Some(secret));
        assert!(!preview.contains(secret));
        assert!(!preview.contains("hunter2"));
        assert!(preview.matches("[REDACTED]").count() >= 4);
    }

    #[test]
    fn api_errors_redact_echoed_keys_and_unicode_previews_are_safe() {
        let secret = "secret-token-value";
        let error = ai_provider_api_error(
            &format!("Provider echoed {secret} while rejecting the request"),
            Some(secret),
        );
        assert!(!error.contains(secret));
        assert!(error.contains("[REDACTED]"));

        let unicode_body = "database error ".to_string() + &"界".repeat(400);
        let preview = compact_response_preview(&unicode_body, None);
        assert!(preview.chars().count() <= 320);
        assert!(preview.ends_with("..."));
    }

    /// Contract with the frontend (`normalizeAIRequestError` in
    /// `src/utils/ai-request-errors.ts`): retryable provider HTTP failures
    /// (429/5xx with a Retry-After header) embed a machine-readable
    /// `retry_after_ms=<n>` marker parsed by the frontend to wait exactly as
    /// long as the provider asked.
    #[test]
    fn provider_http_error_carries_machine_readable_retry_after_marker() {
        use crate::database::ai_models::AIProviderType;

        let config: AIProviderConfig = serde_json::from_str(&format!(
            r#"{{"id":"p1","name":"OpenAI","provider_type":{},"endpoint":"https://api.openai.com/v1/chat/completions","model":"gpt-test","is_enabled":true}}"#,
            serde_json::to_string(&AIProviderType::OpenAI).unwrap()
        ))
        .expect("provider config should deserialize");

        let endpoint = "https://api.openai.com/v1/chat/completions";

        let with_marker = ai_provider_http_status_error(
            &config,
            endpoint,
            StatusCode::TOO_MANY_REQUESTS,
            "{}",
            None,
            Some(4),
        );
        assert!(
            with_marker.contains("retry_after_ms=4000"),
            "message was: {with_marker}"
        );

        // Retryable status without a parseable Retry-After header: no marker,
        // just the human-facing note.
        let without_marker = ai_provider_http_status_error(
            &config,
            endpoint,
            StatusCode::SERVICE_UNAVAILABLE,
            "{}",
            None,
            None,
        );
        assert!(!without_marker.contains("retry_after_ms="));
        assert!(without_marker.contains("Please try again in a moment."));

        // Non-retryable statuses never carry the marker even if a header
        // slipped through.
        let bad_request = ai_provider_http_status_error(
            &config,
            endpoint,
            StatusCode::BAD_REQUEST,
            "{}",
            None,
            Some(4),
        );
        assert!(!bad_request.contains("retry_after_ms="));
    }

    fn openai_test_config() -> AIProviderConfig {
        serde_json::from_str(&format!(
            r#"{{"id":"p1","name":"OpenAI","provider_type":{},"endpoint":"https://api.openai.com/v1/chat/completions","model":"gpt-test","is_enabled":true}}"#,
            serde_json::to_string(&AIProviderType::OpenAI).unwrap()
        ))
        .expect("provider config should deserialize")
    }

    /// D7: every terminal AI error builder appends its machine-readable
    /// `[ai_error_kind=<code>]` marker so the frontend classifier can route
    /// retry/failover off it instead of guessing from substrings.
    #[test]
    fn ai_error_builders_append_machine_readable_kind_markers() {
        let config = openai_test_config();
        let endpoint = "https://api.openai.com/v1/chat/completions";

        assert!(ai_provider_response_error().ends_with("[ai_error_kind=invalid-response]"));
        assert!(ai_provider_api_error("boom", None).ends_with("[ai_error_kind=provider]"));
        assert!(
            ai_provider_http_status_error(
                &config,
                endpoint,
                StatusCode::TOO_MANY_REQUESTS,
                "{}",
                None,
                Some(4),
            )
            .ends_with("[ai_error_kind=provider]")
        );
        assert!(
            ai_provider_non_json_response_error(&config, endpoint, "<html>", None)
                .ends_with("[ai_error_kind=invalid-response]")
        );
        assert!(
            ai_provider_response_error_with_preview(&config, endpoint, &json!({"foo": "bar"}), None)
                .ends_with("[ai_error_kind=invalid-response]")
        );

        // The kind marker rides alongside the retry_after_ms marker without
        // clobbering it: both must survive on the same message.
        let http = ai_provider_http_status_error(
            &config,
            endpoint,
            StatusCode::TOO_MANY_REQUESTS,
            "{}",
            None,
            Some(4),
        );
        assert!(http.contains("retry_after_ms=4000"));
        assert!(http.contains("[ai_error_kind=provider]"));
    }

    /// Cross-language contract shared with the frontend classifier
    /// (`tests/utils/ai-request-errors.test.ts` + `src/utils/ai-request-errors.ts`).
    /// If the marker key or the set of emitted kinds drifts from the frontend's
    /// recognized codes, one side fails.
    #[test]
    fn ai_error_kind_markers_match_shared_frontend_contract() {
        #[derive(serde::Deserialize)]
        struct Contract {
            #[serde(rename = "markerKey")]
            marker_key: String,
            kinds: Vec<String>,
        }

        let contract: Contract = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/ai-error-kinds.json"
        ))
        .expect("shared AI error-kind contract should parse");

        assert_eq!(contract.marker_key, AI_ERROR_KIND_MARKER_KEY);

        let emitted = [
            AiErrorKind::Cancelled,
            AiErrorKind::Timeout,
            AiErrorKind::Provider,
            AiErrorKind::InvalidResponse,
        ];
        for kind in emitted {
            assert!(
                contract.kinds.iter().any(|listed| listed == kind.as_str()),
                "frontend contract is missing backend kind {}",
                kind.as_str()
            );
        }
        assert_eq!(
            contract.kinds.len(),
            emitted.len(),
            "contract lists kinds the backend never emits"
        );
    }
}
