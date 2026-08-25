use crate::database::ai_models::{AIProviderConfig, AIProviderType};
use reqwest::{StatusCode, Url};
use std::net::IpAddr;

pub(crate) fn provider_requires_api_key(provider_type: &AIProviderType) -> bool {
    !matches!(
        provider_type,
        AIProviderType::Ollama | AIProviderType::Custom
    )
}

pub(crate) fn provider_allows_local_endpoint(provider_type: &AIProviderType) -> bool {
    matches!(
        provider_type,
        AIProviderType::Ollama | AIProviderType::Custom
    )
}

fn is_local_domain(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1")
        || host.eq_ignore_ascii_case("localhost")
        || host.ends_with(".local")
}

fn is_private_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(ipv4) => {
            ipv4.is_private() || ipv4.is_loopback() || ipv4.is_link_local() || ipv4.is_broadcast()
        }
        IpAddr::V6(ipv6) => {
            ipv6.is_loopback() || ipv6.is_unique_local() || ipv6.is_unicast_link_local()
        }
    }
}

pub(crate) fn validate_ai_endpoint(
    config: &AIProviderConfig,
    endpoint: &str,
) -> Result<(), String> {
    let url = Url::parse(endpoint).map_err(|error| format!("Invalid AI endpoint URL: {error}"))?;

    match url.scheme() {
        "https" => {}
        "http" => {
            let host = url
                .host_str()
                .ok_or_else(|| "AI endpoint is missing a host".to_string())?;
            if !provider_allows_local_endpoint(&config.provider_type) || !is_local_domain(host) {
                return Err("Only localhost endpoints may use plain HTTP.".to_string());
            }
        }
        _ => return Err("AI endpoint must use http or https.".to_string()),
    }

    let host = url
        .host_str()
        .ok_or_else(|| "AI endpoint is missing a host".to_string())?;
    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_private_ip(&ip) && !provider_allows_local_endpoint(&config.provider_type) {
            return Err(
                "Private/internal AI endpoints are only allowed for Ollama or Custom providers."
                    .to_string(),
            );
        }
    } else if !provider_allows_local_endpoint(&config.provider_type) && is_local_domain(host) {
        return Err(
            "Local AI endpoints are only allowed for Ollama or Custom providers.".to_string(),
        );
    }

    Ok(())
}

pub(crate) fn endpoint_path(endpoint: &str) -> Option<String> {
    Url::parse(endpoint)
        .ok()
        .map(|url| url.path().trim().to_ascii_lowercase())
}

pub(crate) fn endpoint_host(endpoint: &str) -> Option<String> {
    Url::parse(endpoint)
        .ok()
        .and_then(|url| url.host_str().map(|host| host.to_ascii_lowercase()))
}

pub(crate) fn join_endpoint_suffix(endpoint: &str, suffix: &str) -> String {
    let Ok(mut url) = Url::parse(endpoint) else {
        return endpoint.to_string();
    };

    let current_path = url.path().trim_end_matches('/');
    let next_path = if current_path.is_empty() {
        format!("/{}", suffix.trim_start_matches('/'))
    } else {
        format!("{}/{}", current_path, suffix.trim_start_matches('/'))
    };
    url.set_path(&next_path);
    url.to_string()
}

pub(crate) fn resolve_provider_endpoint(config: &AIProviderConfig) -> String {
    let default_endpoint = match config.provider_type {
        AIProviderType::OpenAI => "https://api.openai.com/v1/chat/completions",
        AIProviderType::OpenRouter => "https://openrouter.ai/api/v1/chat/completions",
        AIProviderType::Ollama => "http://localhost:11434/v1/chat/completions",
        AIProviderType::Anthropic => "https://api.anthropic.com/v1/messages",
        AIProviderType::Gemini => {
            return if config.endpoint.trim().is_empty() {
                format!(
                    "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent",
                    config.model.trim()
                )
            } else {
                config.endpoint.trim().to_string()
            };
        }
        AIProviderType::Custom => "",
    };

    let endpoint = if config.endpoint.trim().is_empty() {
        default_endpoint.to_string()
    } else {
        config.endpoint.trim().to_string()
    };

    let path = endpoint_path(&endpoint).unwrap_or_default();

    match config.provider_type {
        AIProviderType::OpenAI | AIProviderType::OpenRouter | AIProviderType::Custom => {
            if path.is_empty() || path == "/" || path == "/v1" {
                join_endpoint_suffix(&endpoint, "chat/completions")
            } else {
                endpoint
            }
        }
        AIProviderType::Ollama => {
            if path.is_empty() || path == "/" || path == "/v1" {
                join_endpoint_suffix(&endpoint, "chat/completions")
            } else {
                endpoint
            }
        }
        AIProviderType::Anthropic => {
            if path.is_empty() || path == "/" || path == "/v1" {
                join_endpoint_suffix(&endpoint, "messages")
            } else {
                endpoint
            }
        }
        AIProviderType::Gemini => endpoint,
    }
}

pub(crate) fn is_ollama_native_chat_endpoint(endpoint: &str) -> bool {
    endpoint_path(endpoint).is_some_and(|path| path.ends_with("/api/chat"))
}

pub(crate) fn is_ollama_native_generate_endpoint(endpoint: &str) -> bool {
    endpoint_path(endpoint).is_some_and(|path| path.ends_with("/api/generate"))
}

pub(crate) fn is_nvidia_integrate_endpoint(endpoint: &str) -> bool {
    endpoint_host(endpoint).is_some_and(|host| host == "integrate.api.nvidia.com")
}

pub(crate) fn should_retry_openai_like_status(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::BAD_GATEWAY
            | StatusCode::SERVICE_UNAVAILABLE
            | StatusCode::GATEWAY_TIMEOUT
            | StatusCode::TOO_MANY_REQUESTS
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::ai::providers::{sample_provider, streaming_endpoint};

    #[test]
    fn resolves_openai_like_base_url_to_chat_completions() {
        let mut provider = sample_provider(AIProviderType::OpenAI);
        provider.endpoint = "https://integrate.api.nvidia.com/v1".to_string();

        assert_eq!(
            resolve_provider_endpoint(&provider),
            "https://integrate.api.nvidia.com/v1/chat/completions"
        );
    }

    #[test]
    fn provider_endpoints_match_supported_api_contracts() {
        let cases = [
            (
                AIProviderType::OpenAI,
                "https://api.openai.com/v1/chat/completions",
            ),
            (
                AIProviderType::OpenRouter,
                "https://openrouter.ai/api/v1/chat/completions",
            ),
            (
                AIProviderType::Ollama,
                "http://localhost:11434/v1/chat/completions",
            ),
            (
                AIProviderType::Anthropic,
                "https://api.anthropic.com/v1/messages",
            ),
            (
                AIProviderType::Gemini,
                "https://generativelanguage.googleapis.com/v1beta/models/demo-model:generateContent",
            ),
        ];

        for (provider_type, expected_endpoint) in cases {
            assert_eq!(
                resolve_provider_endpoint(&sample_provider(provider_type)),
                expected_endpoint
            );
        }

        let mut custom = sample_provider(AIProviderType::Custom);
        custom.endpoint = "https://example.com/v1".to_string();
        assert_eq!(
            resolve_provider_endpoint(&custom),
            "https://example.com/v1/chat/completions"
        );

        let gemini = sample_provider(AIProviderType::Gemini);
        assert_eq!(
            streaming_endpoint(
                &gemini,
                "https://generativelanguage.googleapis.com/v1beta/models/demo-model:generateContent?key=demo"
            ),
            "https://generativelanguage.googleapis.com/v1beta/models/demo-model:streamGenerateContent?key=demo&alt=sse"
        );
    }
}
