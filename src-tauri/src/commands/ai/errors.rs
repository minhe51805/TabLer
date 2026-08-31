use crate::database::ai_models::{AIProviderConfig, AIProviderType};
use reqwest::{StatusCode, Url};

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

    format!("The AI request to \"{provider_label}\" could not be completed. {detail}")
}

pub(crate) fn ai_provider_response_error() -> String {
    "The AI provider returned an invalid or unsupported response.".to_string()
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
    format!(
        "AI API error: {}",
        compact_response_preview(message, api_key)
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

    if preview.is_empty() {
        format!(
            "The AI provider \"{provider_label}\" at {endpoint_label} returned HTTP {status_label}.{retry_note}"
        )
    } else {
        format!(
            "The AI provider \"{provider_label}\" at {endpoint_label} returned HTTP {status_label}. Response preview: {preview}{retry_note}"
        )
    }
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

    format!(
        "The AI provider \"{provider_label}\" at {endpoint_label} returned a non-JSON response. Response preview: {preview}"
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

    format!(
        "The AI provider \"{provider_label}\" at {endpoint_label} returned an unsupported response shape. Response preview: {compact_preview}"
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
}
