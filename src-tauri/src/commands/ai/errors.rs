use crate::database::ai_models::{AIProviderConfig, AIProviderType};
use crate::error::{AppError, ErrorCode};
use reqwest::{StatusCode, Url};

pub(crate) fn ai_cancelled_error() -> AppError {
    AppError::ai(
        ErrorCode::AiCancelled,
        super::AI_REQUEST_CANCELLED_ERROR,
        false,
        None,
    )
}

pub(crate) fn ai_storage_load_error() -> AppError {
    AppError::structured(
        ErrorCode::StorageError,
        "Could not load AI provider settings.",
        false,
    )
}

pub(crate) fn ai_storage_save_error() -> AppError {
    AppError::structured(
        ErrorCode::StorageError,
        "Could not save AI provider settings.",
        false,
    )
}

pub(crate) fn ai_provider_config_error() -> AppError {
    AppError::ai(
        ErrorCode::AiAuth,
        "The active AI provider is not configured correctly.",
        false,
        None,
    )
}

fn provider_label_of(config: &AIProviderConfig) -> String {
    if config.name.trim().is_empty() {
        format!("{:?}", config.provider_type)
    } else {
        config.name.trim().to_string()
    }
}

fn endpoint_label_of(endpoint: &str) -> String {
    Url::parse(endpoint)
        .ok()
        .and_then(|url| {
            let host = url.host_str()?.to_string();
            let port = url
                .port()
                .map(|value| format!(":{value}"))
                .unwrap_or_default();
            Some(format!("{host}{port}"))
        })
        .unwrap_or_else(|| endpoint.to_string())
}

pub(crate) fn ai_provider_request_error(
    config: &AIProviderConfig,
    endpoint: &str,
    error: &reqwest::Error,
) -> AppError {
    let provider_label = provider_label_of(config);
    let endpoint_label = endpoint_label_of(endpoint);

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

    let code = if error.is_timeout() {
        ErrorCode::AiTimeout
    } else {
        ErrorCode::AiProviderTransient
    };
    AppError::ai(
        code,
        format!("The AI request to \"{provider_label}\" could not be completed. {detail}"),
        true,
        None,
    )
}

pub(crate) fn ai_provider_response_error() -> AppError {
    AppError::ai(
        ErrorCode::AiInvalidResponse,
        "The AI provider returned an invalid or unsupported response.",
        true,
        None,
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

pub(crate) fn classify_http_status(status: StatusCode) -> (ErrorCode, bool) {
    match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => (ErrorCode::AiAuth, false),
        StatusCode::TOO_MANY_REQUESTS => (ErrorCode::AiRateLimited, true),
        StatusCode::REQUEST_TIMEOUT => (ErrorCode::AiProviderTransient, true),
        _ if status.is_server_error() => (ErrorCode::AiProviderTransient, true),
        _ if status.is_client_error() => (ErrorCode::AiBadRequest, false),
        _ => (ErrorCode::AiProviderTransient, false),
    }
}

/// Classifies an inline `"error"` payload returned inside an HTTP 200 JSON body
/// (for example OpenRouter mid-stream/body errors where HTTP status stayed 200).
pub(crate) fn ai_provider_api_error(message: &str, api_key: Option<&str>) -> AppError {
    let preview = compact_response_preview(message, api_key);
    let lower = preview.to_ascii_lowercase();
    let (code, retryable) = if lower.contains("invalid api key")
        || lower.contains("unauthorized")
        || lower.contains("authentication")
        || lower.contains("forbidden")
    {
        (ErrorCode::AiAuth, false)
    } else if lower.contains("rate limit") || lower.contains("too many requests") {
        (ErrorCode::AiRateLimited, true)
    } else {
        (ErrorCode::AiProviderTransient, true)
    };
    AppError::ai(code, format!("AI API error: {preview}"), retryable, None)
}

/// Read the provider's `Retry-After` header (seconds form, the common 429
/// case) so the frontend can wait exactly as long as the provider asks
/// instead of guessing.
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
) -> AppError {
    let provider_label = provider_label_of(config);
    let endpoint_label = endpoint_label_of(endpoint);
    let status_label = status
        .canonical_reason()
        .map(|reason| format!("{} {}", status.as_u16(), reason))
        .unwrap_or_else(|| status.as_u16().to_string());

    // Extract clean provider `"error.message"` when available, still redacted.
    let extracted_error = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|payload| {
            let err = payload.get("error")?;
            if let Some(msg) = err.get("message").and_then(|v| v.as_str()) {
                Some(msg.to_string())
            } else {
                err.as_str().map(str::to_string)
            }
        });
    let preview_source = extracted_error.as_deref().unwrap_or(body);
    let preview = compact_response_preview(preview_source, api_key);

    let (code, retryable) = classify_http_status(status);
    let retry_after_ms = if retryable {
        retry_after_seconds.map(|seconds| seconds.saturating_mul(1000))
    } else {
        None
    };

    let retry_note = if matches!(
        status,
        StatusCode::BAD_GATEWAY
            | StatusCode::SERVICE_UNAVAILABLE
            | StatusCode::GATEWAY_TIMEOUT
            | StatusCode::TOO_MANY_REQUESTS
    ) {
        match retry_after_seconds {
            Some(seconds) => format!(
                " This looks temporary on the provider side. It asks to retry after {seconds} s."
            ),
            None => " This looks temporary on the provider side. Please try again in a moment."
                .to_string(),
        }
    } else {
        String::new()
    };

    let message = if preview.is_empty() || preview == "{}" {
        format!(
            "The AI provider \"{provider_label}\" at {endpoint_label} returned HTTP {status_label}.{retry_note}"
        )
    } else {
        format!(
            "The AI provider \"{provider_label}\" at {endpoint_label} returned HTTP {status_label}. Response preview: {preview}{retry_note}"
        )
    };
    AppError::ai(code, message, retryable, retry_after_ms)
}

pub(crate) fn ai_provider_non_json_response_error(
    config: &AIProviderConfig,
    endpoint: &str,
    body: &str,
    api_key: Option<&str>,
) -> AppError {
    let provider_label = provider_label_of(config);
    let endpoint_label = endpoint_label_of(endpoint);
    let preview = compact_response_preview(body, api_key);

    AppError::ai(
        ErrorCode::AiInvalidResponse,
        format!(
            "The AI provider \"{provider_label}\" at {endpoint_label} returned a non-JSON response. Response preview: {preview}"
        ),
        true,
        None,
    )
}

pub(crate) fn ai_provider_response_error_with_preview(
    config: &AIProviderConfig,
    endpoint: &str,
    payload: &serde_json::Value,
    api_key: Option<&str>,
) -> AppError {
    let provider_label = provider_label_of(config);
    let endpoint_label = endpoint_label_of(endpoint);
    let compact_preview = compact_response_preview(&payload.to_string(), api_key);

    AppError::ai(
        ErrorCode::AiInvalidResponse,
        format!(
            "The AI provider \"{provider_label}\" at {endpoint_label} returned an unsupported response shape. Response preview: {compact_preview}"
        ),
        true,
        None,
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

    fn openai_test_config() -> AIProviderConfig {
        serde_json::from_str(&format!(
            r#"{{"id":"p1","name":"OpenAI","provider_type":{},"endpoint":"https://api.openai.com/v1/chat/completions","model":"gpt-test","is_enabled":true}}"#,
            serde_json::to_string(&AIProviderType::OpenAI).unwrap()
        ))
        .expect("provider config should deserialize")
    }

    #[test]
    fn provider_http_error_carries_structured_code_and_retry_after_ms() {
        let config = openai_test_config();
        let endpoint = "https://api.openai.com/v1/chat/completions";

        let rate_limited = ai_provider_http_status_error(
            &config,
            endpoint,
            StatusCode::TOO_MANY_REQUESTS,
            r#"{"error":{"message":"Quota exceeded"}}"#,
            None,
            Some(4),
        );
        assert_eq!(rate_limited.code(), ErrorCode::AiRateLimited);
        assert!(rate_limited.retryable());
        assert_eq!(rate_limited.retry_after_ms(), Some(4000));
        assert!(rate_limited.contains("Quota exceeded"));
        assert!(!rate_limited.contains("ai_error_kind"));

        let unavailable = ai_provider_http_status_error(
            &config,
            endpoint,
            StatusCode::SERVICE_UNAVAILABLE,
            "{}",
            None,
            None,
        );
        assert_eq!(unavailable.code(), ErrorCode::AiProviderTransient);
        assert!(unavailable.retryable());
        assert_eq!(unavailable.retry_after_ms(), None);

        let unauthorized = ai_provider_http_status_error(
            &config,
            endpoint,
            StatusCode::UNAUTHORIZED,
            r#"{"error":{"message":"Incorrect API key"}}"#,
            None,
            None,
        );
        assert_eq!(unauthorized.code(), ErrorCode::AiAuth);
        assert!(!unauthorized.retryable());

        let bad_request = ai_provider_http_status_error(
            &config,
            endpoint,
            StatusCode::BAD_REQUEST,
            r#"{"error":{"message":"Invalid parameter"}}"#,
            None,
            Some(4),
        );
        assert_eq!(bad_request.code(), ErrorCode::AiBadRequest);
        assert!(!bad_request.retryable());
        assert_eq!(bad_request.retry_after_ms(), None);
    }

    #[test]
    fn structured_ai_error_codes_match_shared_frontend_contract() {
        #[derive(serde::Deserialize)]
        struct Contract {
            codes: Vec<String>,
        }

        let contract: Contract = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/ai-error-kinds.json"
        ))
        .expect("shared AI error-code contract should parse");

        let emitted = [
            ErrorCode::AiCancelled,
            ErrorCode::AiTimeout,
            ErrorCode::AiAuth,
            ErrorCode::AiBadRequest,
            ErrorCode::AiRateLimited,
            ErrorCode::AiProviderTransient,
            ErrorCode::AiInvalidResponse,
            ErrorCode::RateLimited,
        ];
        for code in emitted {
            assert!(
                contract.codes.iter().any(|listed| listed == code.as_str()),
                "frontend contract is missing backend code {}",
                code.as_str()
            );
        }
        assert_eq!(
            contract.codes.len(),
            emitted.len(),
            "contract lists codes the backend AI layer never emits"
        );
    }
}
