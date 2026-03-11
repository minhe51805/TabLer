use reqwest::Client;
use serde_json::json;
use crate::database::ai_models::{AIProviderConfig, AIProviderType, AIRequest, AIResponse};

use tauri::State;
use std::collections::HashMap;
use crate::storage::ai_storage::AIStorage;

#[tauri::command]
pub async fn get_ai_configs(storage: State<'_, AIStorage>) -> Result<(Vec<AIProviderConfig>, HashMap<String, String>), String> {
    storage.load_providers().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_ai_configs(
    providers: Vec<AIProviderConfig>,
    api_keys: HashMap<String, String>,
    storage: State<'_, AIStorage>
) -> Result<(), String> {
    storage.save_providers(&providers, &api_keys).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ask_ai(request: AIRequest, config: AIProviderConfig, api_key: String) -> Result<AIResponse, String> {
    let client = Client::new();
    let prompt = format!(
        "You are an expert SQL assistant. Given the following database context:\n{}\n\nTask: {}\n\nProvide ONLY the raw SQL query. Do not include markdown blocks or explanations.",
        request.context, request.prompt
    );

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

            let req = client.post(endpoint)
                .bearer_auth(api_key)
                .json(&body)
                .send()
                .await
                .map_err(|e| e.to_string())?;

            let resp_json: serde_json::Value = req.json().await.map_err(|e| e.to_string())?;
            if let Some(err) = resp_json.get("error") {
                return Err(err.to_string());
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
            Err("Failed to parse OpenAI response".to_string())
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

            let req = client.post(endpoint)
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01")
                .json(&body)
                .send()
                .await
                .map_err(|e| e.to_string())?;

            let resp_json: serde_json::Value = req.json().await.map_err(|e| e.to_string())?;
            if let Some(err) = resp_json.get("error") {
                return Err(err.to_string());
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
            Err("Failed to parse Anthropic response".to_string())
        },
        AIProviderType::Gemini => {
            let body = json!({
                "contents": [
                    { "role": "user", "parts": [{ "text": prompt }] }
                ]
            });
            let endpoint = if config.endpoint.is_empty() {
                format!("https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}", config.model.trim(), api_key)
            } else {
                config.endpoint.clone()
            };

            let req = client.post(&endpoint)
                .json(&body)
                .send()
                .await
                .map_err(|e| e.to_string())?;

            let resp_json: serde_json::Value = req.json().await.map_err(|e| e.to_string())?;
            if let Some(err) = resp_json.get("error") {
                return Err(err.to_string());
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
            Err("Failed to parse Gemini response".to_string())
        }
    }
}
