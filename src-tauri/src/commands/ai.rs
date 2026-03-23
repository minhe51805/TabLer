use reqwest::Client;
use reqwest::Url;
use serde_json::json;
use std::net::IpAddr;
use crate::database::ai_models::{AIProviderConfig, AIProviderType, AIRequest, AIRequestMode, AIResponse};
use crate::utils::rate_limiter::AIRequestLimiter;

use tauri::State;
use std::collections::HashMap;
use crate::storage::ai_storage::AIStorage;
use tokio::task;

fn ai_storage_load_error() -> String {
    "Could not load AI provider settings.".to_string()
}

fn ai_storage_save_error() -> String {
    "Could not save AI provider settings.".to_string()
}

fn ai_provider_config_error() -> String {
    "The active AI provider is not configured correctly.".to_string()
}

fn ai_provider_request_error() -> String {
    "The AI request could not be completed. Please verify your provider settings and try again."
        .to_string()
}

fn ai_provider_response_error() -> String {
    "The AI provider returned an invalid or unsupported response.".to_string()
}

fn provider_requires_api_key(provider_type: &AIProviderType) -> bool {
    !matches!(provider_type, AIProviderType::Ollama | AIProviderType::Custom)
}

fn provider_allows_local_endpoint(provider_type: &AIProviderType) -> bool {
    matches!(provider_type, AIProviderType::Ollama | AIProviderType::Custom)
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
        IpAddr::V6(ipv6) => ipv6.is_loopback() || ipv6.is_unique_local() || ipv6.is_unicast_link_local(),
    }
}

fn validate_ai_endpoint(config: &AIProviderConfig, endpoint: &str) -> Result<(), String> {
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
            return Err("Private/internal AI endpoints are only allowed for Ollama or Custom providers.".to_string());
        }
    } else if !provider_allows_local_endpoint(&config.provider_type) && is_local_domain(host) {
        return Err("Local AI endpoints are only allowed for Ollama or Custom providers.".to_string());
    }

    Ok(())
}

async fn run_blocking_storage_task<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    task::spawn_blocking(operation)
        .await
        .map_err(|_| "Background AI task failed unexpectedly.".to_string())?
}

#[tauri::command]
pub async fn get_ai_configs(storage: State<'_, AIStorage>) -> Result<(Vec<AIProviderConfig>, HashMap<String, bool>), String> {
    let storage = storage.inner().clone();
    run_blocking_storage_task(move || storage.load_providers().map_err(|_| ai_storage_load_error())).await
}

#[tauri::command]
pub async fn save_ai_configs(
    providers: Vec<AIProviderConfig>,
    api_key_updates: HashMap<String, String>,
    cleared_provider_ids: Vec<String>,
    storage: State<'_, AIStorage>
) -> Result<(Vec<AIProviderConfig>, HashMap<String, bool>), String> {
    let storage = storage.inner().clone();
    run_blocking_storage_task(move || {
        storage
            .save_providers(&providers, &api_key_updates, &cleared_provider_ids)
            .map_err(|_| ai_storage_save_error())?;
        storage.load_providers().map_err(|_| ai_storage_load_error())
    })
    .await
}

#[tauri::command]
pub async fn ask_ai(
    request: AIRequest,
    storage: State<'_, AIStorage>,
    ai_rate_limiter: State<'_, AIRequestLimiter>,
) -> Result<AIResponse, String> {
    // Validate request before processing
    request.validate().map_err(|e| format!("Invalid request: {}", e))?;

    let client = Client::new();
    let storage = storage.inner().clone();
    let (config, api_key) = run_blocking_storage_task(move || {
        let config = storage
            .get_active_provider_config()
            .map_err(|_| ai_provider_config_error())?;
        let api_key = if provider_requires_api_key(&config.provider_type) {
            Some(storage.get_api_key(&config.id).map_err(|_| ai_provider_config_error())?)
        } else {
            storage
                .get_api_key_optional(&config.id)
                .map_err(|_| ai_provider_config_error())?
        };

        Ok((config, api_key))
    })
    .await?;
    ai_rate_limiter.check(&format!("{}:{:?}", config.id, request.mode)).await?;
    if !config.is_enabled {
        return Err("Selected AI provider is disabled.".to_string());
    }
    if request.mode == AIRequestMode::Inline && !config.allow_inline_completion {
        return Err("Inline AI completion is disabled for this provider.".to_string());
    }
    let effective_context = if config.allow_schema_context {
        request.context.trim()
    } else {
        ""
    };
    let prompt = if effective_context.is_empty() {
        format!(
            "You are an expert SQL assistant. Task: {}\n\nProvide ONLY the raw SQL query. Do not include markdown blocks or explanations.",
            request.prompt
        )
    } else {
        format!(
            "You are an expert SQL assistant. Given the following database context:\n{}\n\nTask: {}\n\nProvide ONLY the raw SQL query. Do not include markdown blocks or explanations.",
            effective_context, request.prompt
        )
    };

    match config.provider_type {
        AIProviderType::OpenAI | AIProviderType::OpenRouter | AIProviderType::Ollama | AIProviderType::Custom => {
            let body = json!({
                "model": config.model,
                "messages": [
                    { "role": "system", "content": "You are a concise SQL assistant. Reply only with the requested SQL." },
                    { "role": "user", "content": prompt }
                ]
            });
            let default_endpoint = match config.provider_type {
                AIProviderType::OpenAI => "https://api.openai.com/v1/chat/completions",
                AIProviderType::OpenRouter => "https://openrouter.ai/api/v1/chat/completions",
                AIProviderType::Ollama => "http://localhost:11434/v1/chat/completions",
                _ => "",
            };
            let endpoint = if config.endpoint.is_empty() {
                default_endpoint
            } else {
                &config.endpoint
            };
            validate_ai_endpoint(&config, endpoint)?;

            let mut req = client.post(endpoint);
            if let Some(ref api_key) = api_key {
                req = req.bearer_auth(api_key);
            }
            let req = req
                .json(&body)
                .send()
                .await
                .map_err(|_| ai_provider_request_error())?;

            let resp_json: serde_json::Value = req
                .json()
                .await
                .map_err(|_| ai_provider_response_error())?;
            if let Some(err) = resp_json.get("error") {
                let msg = if let Some(m) = err.get("message").and_then(|v| v.as_str()) {
                    m.to_string()
                } else if let Some(m) = err.as_str() {
                    m.to_string()
                } else {
                    err.to_string()
                };
                return Err(format!("AI API error: {}", msg));
            }

            if let Some(choices) = resp_json.get("choices") {
                if let Some(choice) = choices.get(0) {
                    if let Some(message) = choice.get("message") {
                        if let Some(content) = message.get("content") {
                            return Ok(AIResponse {
                                text: content.as_str().unwrap_or("").to_string(),
                                error: None,
                            });
                        }
                    }
                }
            }
            Err(ai_provider_response_error())
        },
        AIProviderType::Anthropic => {
            let body = json!({
                "model": config.model,
                "max_tokens": 1024,
                "messages": [
                    { "role": "user", "content": prompt }
                ]
            });
            let endpoint = if config.endpoint.is_empty() {
                "https://api.anthropic.com/v1/messages"
            } else {
                &config.endpoint
            };
            validate_ai_endpoint(&config, endpoint)?;

            let req = client.post(endpoint)
                .header("x-api-key", api_key.as_deref().unwrap_or_default())
                .header("anthropic-version", "2023-06-01")
                .json(&body)
                .send()
                .await
                .map_err(|_| ai_provider_request_error())?;

            let resp_json: serde_json::Value = req
                .json()
                .await
                .map_err(|_| ai_provider_response_error())?;
            if let Some(err) = resp_json.get("error") {
                let msg = if let Some(m) = err.get("message").and_then(|v| v.as_str()) {
                    m.to_string()
                } else if let Some(m) = err.as_str() {
                    m.to_string()
                } else {
                    err.to_string()
                };
                return Err(format!("AI API error: {}", msg));
            }

            if let Some(content_array) = resp_json.get("content") {
                if let Some(content) = content_array.get(0) {
                    if let Some(text) = content.get("text") {
                        return Ok(AIResponse {
                            text: text.as_str().unwrap_or("").to_string(),
                            error: None,
                        });
                    }
                }
            }
            Err(ai_provider_response_error())
        },
        AIProviderType::Gemini => {
            let body = json!({
                "contents": [
                    { "role": "user", "parts": [{ "text": prompt }] }
                ]
            });
            let endpoint = if config.endpoint.is_empty() {
                format!(
                    "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent",
                    config.model.trim()
                )
            } else {
                config.endpoint.clone()
            };
            validate_ai_endpoint(&config, &endpoint)?;

            let req = client.post(&endpoint)
                .header("x-goog-api-key", api_key.as_deref().unwrap_or_default())
                .json(&body)
                .send()
                .await
                .map_err(|_| ai_provider_request_error())?;

            let resp_json: serde_json::Value = req
                .json()
                .await
                .map_err(|_| ai_provider_response_error())?;
            if let Some(err) = resp_json.get("error") {
                let msg = if let Some(m) = err.get("message").and_then(|v| v.as_str()) {
                    m.to_string()
                } else if let Some(m) = err.as_str() {
                    m.to_string()
                } else {
                    err.to_string()
                };
                return Err(format!("AI API error: {}", msg));
            }

            if let Some(candidates) = resp_json.get("candidates") {
                if let Some(candidate) = candidates.get(0) {
                    if let Some(content) = candidate.get("content") {
                        if let Some(parts) = content.get("parts") {
                            if let Some(part) = parts.get(0) {
                                if let Some(text) = part.get("text") {
                                    return Ok(AIResponse {
                                        text: text.as_str().unwrap_or("").to_string(),
                                        error: None,
                                    });
                                }
                            }
                        }
                    }
                }
            }
            Err(ai_provider_response_error())
        }
    }
}
