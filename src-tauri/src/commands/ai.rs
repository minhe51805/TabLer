use crate::database::ai_models::{
    AIConversationMessage, AIConversationRole, AIProviderConfig, AIProviderType, AIRequest,
    AIRequestIntent, AIRequestMode, AIResponse, AIResponseLanguage,
};
use crate::storage::ai_storage::AIStorage;
use crate::utils::rate_limiter::AIRequestLimiter;
use futures_util::StreamExt;
use reqwest::{Client, StatusCode, Url};
use serde::Serialize;
use serde_json::json;
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;
use tokio::task;
use tokio::time::{sleep, Duration};
use tokio_util::sync::CancellationToken;

static AI_HTTP_CLIENT: OnceLock<Client> = OnceLock::new();
const AI_REQUEST_CANCELLED_ERROR: &str = "AI request cancelled.";
const MAX_AI_STREAM_BUFFER_BYTES: usize = 1_048_576;
const MAX_AI_STREAM_OUTPUT_BYTES: usize = 2_097_152;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AIStreamEvent {
    request_id: String,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    usage: Option<serde_json::Value>,
}

fn emit_ai_stream_event(
    app: &AppHandle,
    request_id: &str,
    kind: &'static str,
    text: Option<String>,
    usage: Option<serde_json::Value>,
) -> Result<(), String> {
    app.emit(
        "ai-stream-event",
        AIStreamEvent {
            request_id: request_id.to_string(),
            kind,
            text,
            usage,
        },
    )
    .map_err(|_| "Failed to publish AI stream event.".to_string())
}

#[derive(Default)]
pub struct AIRequestCancellationState {
    active: Mutex<HashMap<String, CancellationToken>>,
}

impl AIRequestCancellationState {
    async fn register(&self, request_id: &str, token: CancellationToken) {
        if let Some(previous) = self
            .active
            .lock()
            .await
            .insert(request_id.to_string(), token)
        {
            previous.cancel();
        }
    }

    async fn finish(&self, request_id: &str) {
        self.active.lock().await.remove(request_id);
    }

    async fn cancel(&self, request_id: &str) -> bool {
        let token = self.active.lock().await.get(request_id).cloned();
        if let Some(token) = token {
            token.cancel();
            true
        } else {
            false
        }
    }
}

fn ai_http_client() -> &'static Client {
    AI_HTTP_CLIENT.get_or_init(|| {
        Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .pool_idle_timeout(Duration::from_secs(90))
            .pool_max_idle_per_host(8)
            .tcp_nodelay(true)
            .build()
            .expect("AI HTTP client should build")
    })
}

fn ai_storage_load_error() -> String {
    "Could not load AI provider settings.".to_string()
}

fn ai_storage_save_error() -> String {
    "Could not save AI provider settings.".to_string()
}

fn ai_provider_config_error() -> String {
    "The active AI provider is not configured correctly.".to_string()
}

fn ai_provider_request_error(
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

fn ai_provider_response_error() -> String {
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

fn ai_provider_api_error(message: &str, api_key: Option<&str>) -> String {
    format!(
        "AI API error: {}",
        compact_response_preview(message, api_key)
    )
}

fn ai_provider_http_status_error(
    config: &AIProviderConfig,
    endpoint: &str,
    status: StatusCode,
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
        " This looks temporary on the provider side. Please try again in a moment."
    } else {
        ""
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

fn ai_provider_non_json_response_error(
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

fn ai_provider_response_error_with_preview(
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

fn response_language_name(language: &AIResponseLanguage) -> &'static str {
    match language {
        AIResponseLanguage::En => "English (United States)",
        AIResponseLanguage::Vi => "Vietnamese",
        AIResponseLanguage::Zh => "Chinese (Simplified)",
        AIResponseLanguage::Tr => "Turkish",
        AIResponseLanguage::Ko => "Korean",
    }
}

fn response_language_rule(language: &AIResponseLanguage) -> &'static str {
    match language {
        AIResponseLanguage::En => "Write naturally in English (United States).",
        AIResponseLanguage::Vi => {
            "Answer entirely in Vietnamese. Keep SQL keywords, table names, column names, enum values, and technical identifiers in their original form."
        }
        AIResponseLanguage::Zh => {
            "Answer entirely in Simplified Chinese. Keep SQL keywords, table names, column names, enum values, and technical identifiers in their original form."
        }
        AIResponseLanguage::Tr => {
            "Answer entirely in Turkish. Keep SQL keywords, table names, column names, enum values, and technical identifiers in their original form."
        }
        AIResponseLanguage::Ko => {
            "Answer entirely in Korean. Keep SQL keywords, table names, column names, enum values, and technical identifiers in their original form."
        }
    }
}

fn build_ai_prompt(
    mode: &AIRequestMode,
    intent: &AIRequestIntent,
    language: &AIResponseLanguage,
    effective_context: &str,
    history: &[AIConversationMessage],
    user_prompt: &str,
) -> (String, String) {
    let effective_intent = if matches!(mode, AIRequestMode::Inline) {
        AIRequestIntent::Sql
    } else {
        intent.clone()
    };

    let response_language = response_language_name(language);
    let language_rule = response_language_rule(language);
    let history_note = if history.is_empty() {
        ""
    } else {
        " Use the recent conversation history to resolve references like 'that', 'it', or follow-up questions. If the history conflicts with the current database context, trust the current database context and say the earlier assumption was incorrect."
    };

    let (system_prompt, response_instruction) = match effective_intent {
        AIRequestIntent::Explain => (
            format!(
                "You are a concise database assistant. Explain schemas, columns, rows, and SQL behavior in plain language. Ground the answer in the provided database context whenever it exists. Avoid generic textbook definitions when the schema context already shows the concrete tables or columns being discussed. If database context is present, never claim that the schema was missing. Do not output SQL unless the user explicitly asks for a query, statement, or migration. Always answer in {response_language}. {language_rule}{history_note}"
            ),
            format!(
                "Respond in plain language using {response_language}. Read the provided database context first and answer from that context. Never mention tables or columns that are not present in the provided database context. If the context is not enough, say so clearly. Use short markdown sections or flat bullets when that improves clarity. Do not output SQL, code fences, or query snippets unless the user explicitly asks for SQL."
            ),
        ),
        AIRequestIntent::Overview => (
            format!(
                "You are a concise database analyst. Treat every overview request as a fresh schema-reading task for the CURRENT database context. Read the provided database context first and produce a grounded overview of the current database. Summarize actual tables, their likely roles, and important relationships from the provided context. Do not explain generic database theory unless the user explicitly asks for theory. If the context is incomplete, say what is unknown instead of guessing, but never claim the database context was missing when it was provided. Even if the domain is uncertain, still summarize the visible tables and likely relationship paths. Do not output SQL unless the user explicitly asks for it. Always answer in {response_language}. {language_rule}{history_note}"
            ),
            format!(
                "Read the provided database context and write a practical overview in {response_language}. Treat the current database context as the source of truth, even if earlier chat history mentioned a different schema. Format the answer with short markdown sections and flat bullets. Cover in this order: overview, main tables, relationships or join paths, and notable gaps or assumptions. Mention only tables that actually appear in the provided database context, and if there are few tables available, cover each one briefly. Do not output SQL unless the user explicitly asks for SQL."
            ),
        ),
        AIRequestIntent::Sql => (
            format!(
                "You are a grounded SQL assistant. Use the provided database context when available and never invent tables, columns, keys, or relationships that are not present in that context. When the user asks about related tables, shared keys, or join paths, infer them only from the visible foreign keys, indexes, and matching identifier columns in the provided schema context. Prefer safe read-only SQL by default, and only emit mutating SQL when the user explicitly asks for data or schema changes. {language_rule}{history_note}"
            ),
            "Return ONLY runnable SQL for the current database. Prefer one or more safe read-only statements unless the user explicitly asked to change data or schema. If the user asks to inspect related tables or shared keys, return SQL that helps inspect those relationships from the provided schema context. Do not include explanations outside SQL.".to_string(),
        ),
        AIRequestIntent::Optimize => (
            format!(
                "You are a grounded SQL performance assistant. Optimize the user's SQL while preserving its semantics. Use the provided database context when available and never invent tables, columns, indexes, or relationships that are not present in that context. Always answer in {response_language}. {language_rule}{history_note}"
            ),
            format!(
                "Return the optimized SQL in {response_language}. Put the improved SQL inside a single ```sql fenced block. Outside the code block, briefly explain what changed, why it is faster, and any tradeoffs. Keep the query semantics functionally identical."
            ),
        ),
        AIRequestIntent::FixError => (
            format!(
                "You are a grounded SQL debugging assistant. Fix SQL errors using the provided database context whenever it exists, and never invent tables, columns, or relationships that are not present in that context. Always answer in {response_language}. {language_rule}{history_note}"
            ),
            format!(
                "Return the corrected SQL in {response_language}. Put the fixed SQL inside a single ```sql fenced block. Outside the code block, briefly explain what was wrong and what changed. Preserve the original intent unless the original SQL was itself incorrect."
            ),
        ),
        AIRequestIntent::General => (
            format!(
                "You are a capable general-purpose assistant inside a database workspace. Help with writing, planning, coding, analysis, brainstorming, summarization, translation, and everyday questions. Use the provided workspace or database context only when it is actually relevant to the user's request. Never claim that you are limited to database-only tasks. If the user explicitly asks about live workspace data and the provided context is not enough, say that clearly instead of guessing. Always answer in {response_language}. {language_rule}{history_note}"
            ),
            format!(
                "Answer the user's request directly in {response_language}. Be helpful and natural. Use any provided workspace context only when it is relevant, and do not force the answer into a database framing when the request is broader than SQL or schema work."
            ),
        ),
        AIRequestIntent::Agent => (
            format!(
                "You are an autonomous workspace agent controller. You can answer general-purpose requests directly, and when workspace or database context is provided you may use it to ground the answer. If the user request does not require workspace evidence, finish directly instead of forcing database exploration. When you do rely on provided database context, never invent tables, columns, indexes, keys, or relationships that are not present. Return only a valid JSON object that matches the exact action schema requested by the user prompt. Do not wrap JSON in markdown fences. Do not include commentary before or after the JSON. Never claim that you are limited to database-only tasks. {language_rule}{history_note}"
            ),
            "Return only the next action JSON object. Never output prose, markdown, code fences, or explanations outside that JSON.".to_string(),
        ),
    };

    let conversation_history = if history.is_empty() {
        String::new()
    } else {
        let formatted = history
            .iter()
            .map(|message| {
                let role = match message.role {
                    AIConversationRole::User => "User",
                    AIConversationRole::Assistant => "Assistant",
                };
                format!("{role}: {}", message.content.trim())
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        format!("Recent conversation:\n{}\n\n", formatted)
    };

    let prompt = if effective_context.is_empty() {
        format!(
            "{}Current user request:\n{}\n\n{}",
            conversation_history, user_prompt, response_instruction
        )
    } else {
        format!(
            "Workspace context:\n{}\n\n{}Current user request:\n{}\n\n{}",
            effective_context, conversation_history, user_prompt, response_instruction
        )
    };

    (system_prompt, prompt)
}

fn provider_requires_api_key(provider_type: &AIProviderType) -> bool {
    !matches!(
        provider_type,
        AIProviderType::Ollama | AIProviderType::Custom
    )
}

fn provider_allows_local_endpoint(provider_type: &AIProviderType) -> bool {
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

async fn run_blocking_storage_task<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    task::spawn_blocking(operation)
        .await
        .map_err(|_| "Background AI task failed unexpectedly.".to_string())?
}

fn extract_text_from_json(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        serde_json::Value::Array(items) => {
            let parts = items
                .iter()
                .filter_map(extract_text_from_json)
                .filter(|part| !part.trim().is_empty())
                .collect::<Vec<_>>();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join("\n\n"))
            }
        }
        serde_json::Value::Object(map) => {
            for key in [
                "text",
                "content",
                "parts",
                "response",
                "output_text",
                "value",
            ] {
                if let Some(candidate) = map.get(key) {
                    if let Some(text) = extract_text_from_json(candidate) {
                        return Some(text);
                    }
                }
            }

            for key in ["message", "delta"] {
                if let Some(candidate) = map.get(key) {
                    if let Some(text) = extract_text_from_json(candidate) {
                        return Some(text);
                    }
                }
            }

            None
        }
        _ => None,
    }
}

/// Splits a leading `<think>...</think>` reasoning block out of model content.
/// Returns (reasoning, cleaned_text). Reasoning models like DeepSeek-R1 and some
/// Qwen variants emit their chain-of-thought this way inside the normal content.
fn split_think_block(text: &str) -> (Option<String>, String) {
    let trimmed = text.trim_start();
    if let Some(rest) = trimmed.strip_prefix("<think>") {
        if let Some(end) = rest.find("</think>") {
            let reasoning = rest[..end].trim().to_string();
            let after = rest[end + "</think>".len()..].trim_start().to_string();
            let reasoning = if reasoning.is_empty() {
                None
            } else {
                Some(reasoning)
            };
            return (reasoning, after);
        }
        // Open tag without a close: treat everything as reasoning still in progress.
        let reasoning = rest.trim();
        if !reasoning.is_empty() {
            return (Some(reasoning.to_string()), String::new());
        }
    }
    (None, text.to_string())
}

/// Extracts the model's real reasoning from an OpenAI-compatible payload, when the
/// provider exposes it as a dedicated field (`reasoning_content` for DeepSeek /
/// some Ollama builds, `reasoning` for OpenRouter). `None` when absent.
fn extract_openai_like_reasoning(payload: &serde_json::Value) -> Option<String> {
    for pointer in [
        "/choices/0/message/reasoning_content",
        "/choices/0/message/reasoning",
        "/choices/0/delta/reasoning_content",
        "/choices/0/delta/reasoning",
    ] {
        if let Some(text) = payload.pointer(pointer).and_then(extract_text_from_json) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn extract_openai_like_response_text(payload: &serde_json::Value) -> Option<String> {
    if let Some(text) = payload
        .pointer("/choices/0/message/content")
        .and_then(extract_text_from_json)
    {
        return Some(text);
    }

    if let Some(text) = payload
        .pointer("/choices/0/delta/content")
        .and_then(extract_text_from_json)
    {
        return Some(text);
    }

    if let Some(text) = payload
        .pointer("/choices/0/text")
        .and_then(extract_text_from_json)
    {
        return Some(text);
    }

    if let Some(text) = payload
        .pointer("/message/content")
        .and_then(extract_text_from_json)
    {
        return Some(text);
    }

    if let Some(text) = payload.get("response").and_then(extract_text_from_json) {
        return Some(text);
    }

    if let Some(text) = payload.get("output_text").and_then(extract_text_from_json) {
        return Some(text);
    }

    if let Some(text) = payload
        .pointer("/output/0/content")
        .and_then(extract_text_from_json)
    {
        return Some(text);
    }

    if let Some(text) = payload.get("content").and_then(extract_text_from_json) {
        return Some(text);
    }

    payload.get("text").and_then(extract_text_from_json)
}

fn extract_anthropic_response_text(payload: &serde_json::Value) -> Option<String> {
    if let Some(text) = payload.get("content").and_then(extract_text_from_json) {
        return Some(text);
    }

    payload.get("completion").and_then(extract_text_from_json)
}

fn extract_gemini_response_text(payload: &serde_json::Value) -> Option<String> {
    if let Some(text) = payload
        .pointer("/candidates/0/content/parts")
        .and_then(extract_text_from_json)
    {
        return Some(text);
    }

    if let Some(text) = payload
        .pointer("/candidates/0/output")
        .and_then(extract_text_from_json)
    {
        return Some(text);
    }

    payload.get("text").and_then(extract_text_from_json)
}

fn extract_stream_deltas(
    provider: &AIProviderType,
    payload: &serde_json::Value,
) -> (Option<String>, Option<String>) {
    match provider {
        AIProviderType::Anthropic => {
            let text = payload
                .pointer("/delta/text")
                .and_then(|value| value.as_str())
                .map(ToString::to_string);
            let reasoning = payload
                .pointer("/delta/thinking")
                .and_then(|value| value.as_str())
                .map(ToString::to_string);
            (text, reasoning)
        }
        AIProviderType::Gemini => (extract_gemini_response_text(payload), None),
        _ => (
            extract_openai_like_response_text(payload),
            extract_openai_like_reasoning(payload),
        ),
    }
}

fn streaming_request_body(
    config: &AIProviderConfig,
    endpoint: &str,
    system_prompt: &str,
    prompt: &str,
    mode: &AIRequestMode,
) -> serde_json::Value {
    let mut body = build_provider_request_body(config, endpoint, system_prompt, prompt, mode);
    if let Some(object) = body.as_object_mut() {
        if config.provider_type != AIProviderType::Gemini {
            object.insert("stream".to_string(), serde_json::Value::Bool(true));
        }
        if matches!(
            config.provider_type,
            AIProviderType::OpenAI | AIProviderType::OpenRouter | AIProviderType::Custom
        ) {
            object.insert(
                "stream_options".to_string(),
                json!({ "include_usage": true }),
            );
        }
    }
    body
}

fn streaming_endpoint(config: &AIProviderConfig, endpoint: &str) -> String {
    if config.provider_type == AIProviderType::Gemini {
        let Ok(mut url) = Url::parse(endpoint) else {
            return endpoint.replace(":generateContent", ":streamGenerateContent");
        };
        let streaming_path = url
            .path()
            .replace(":generateContent", ":streamGenerateContent");
        url.set_path(&streaming_path);
        if !url.query_pairs().any(|(key, _)| key == "alt") {
            url.query_pairs_mut().append_pair("alt", "sse");
        }
        url.to_string()
    } else {
        endpoint.to_string()
    }
}

fn publish_stream_payload(
    app: &AppHandle,
    request_id: &str,
    provider: &AIProviderType,
    payload: &serde_json::Value,
    pending_text: &mut String,
    visible_started: &mut bool,
    output_bytes: &mut usize,
) -> Result<(), String> {
    let (text_delta, reasoning_delta) = extract_stream_deltas(provider, payload);
    if reasoning_delta.is_some() {
        emit_ai_stream_event(app, request_id, "reasoning_delta", None, None)?;
    }

    if let Some(delta) = text_delta {
        let visible_delta = take_visible_stream_delta(&delta, pending_text, visible_started);

        if !visible_delta.is_empty() {
            *output_bytes = output_bytes.saturating_add(visible_delta.len());
            if *output_bytes > MAX_AI_STREAM_OUTPUT_BYTES {
                return Err("AI stream exceeded the 2 MB output limit.".to_string());
            }
            emit_ai_stream_event(app, request_id, "text_delta", Some(visible_delta), None)?;
        }
    }

    if let Some(usage) = payload
        .get("usage")
        .cloned()
        .or_else(|| payload.get("usageMetadata").cloned())
    {
        emit_ai_stream_event(app, request_id, "usage", None, Some(usage))?;
    }
    Ok(())
}

fn take_visible_stream_delta(
    delta: &str,
    pending_text: &mut String,
    visible_started: &mut bool,
) -> String {
    if *visible_started {
        return delta.to_string();
    }
    pending_text.push_str(delta);
    if pending_text.starts_with("<think>") {
        if let Some(end) = pending_text.find("</think>") {
            *visible_started = true;
            let visible = pending_text[end + "</think>".len()..].to_string();
            pending_text.clear();
            return visible;
        }
        return String::new();
    }
    if "<think>".starts_with(pending_text.as_str()) {
        return String::new();
    }
    *visible_started = true;
    std::mem::take(pending_text)
}

fn endpoint_path(endpoint: &str) -> Option<String> {
    Url::parse(endpoint)
        .ok()
        .map(|url| url.path().trim().to_ascii_lowercase())
}

fn endpoint_host(endpoint: &str) -> Option<String> {
    Url::parse(endpoint)
        .ok()
        .and_then(|url| url.host_str().map(|host| host.to_ascii_lowercase()))
}

fn join_endpoint_suffix(endpoint: &str, suffix: &str) -> String {
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

fn resolve_provider_endpoint(config: &AIProviderConfig) -> String {
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

fn is_ollama_native_chat_endpoint(endpoint: &str) -> bool {
    endpoint_path(endpoint).is_some_and(|path| path.ends_with("/api/chat"))
}

fn is_ollama_native_generate_endpoint(endpoint: &str) -> bool {
    endpoint_path(endpoint).is_some_and(|path| path.ends_with("/api/generate"))
}

fn is_nvidia_integrate_endpoint(endpoint: &str) -> bool {
    endpoint_host(endpoint).is_some_and(|host| host == "integrate.api.nvidia.com")
}

fn should_retry_openai_like_status(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::BAD_GATEWAY
            | StatusCode::SERVICE_UNAVAILABLE
            | StatusCode::GATEWAY_TIMEOUT
            | StatusCode::TOO_MANY_REQUESTS
    )
}

fn default_max_output_tokens(mode: &AIRequestMode) -> u32 {
    match mode {
        AIRequestMode::Inline => 256,
        // Panel covers the chat + the agent controller. Agent finish turns embed
        // SQL plus a markdown explanation, so 1024 tokens often truncated the
        // JSON action mid-string; give it enough room to close the object.
        AIRequestMode::Panel => 4096,
    }
}

fn build_openai_like_body(
    model: &str,
    system_prompt: &str,
    prompt: &str,
    mode: &AIRequestMode,
    endpoint: &str,
) -> serde_json::Value {
    let mut body = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": prompt }
        ],
        "stream": false,
        "max_tokens": default_max_output_tokens(mode)
    });

    if is_nvidia_integrate_endpoint(endpoint) {
        body["chat_template_kwargs"] = json!({ "enable_thinking": false });
    }

    body
}

fn build_anthropic_body(
    model: &str,
    system_prompt: &str,
    prompt: &str,
    mode: &AIRequestMode,
) -> serde_json::Value {
    json!({
        "system": system_prompt,
        "model": model,
        "max_tokens": default_max_output_tokens(mode),
        "messages": [
            { "role": "user", "content": prompt }
        ]
    })
}

fn build_gemini_body(system_prompt: &str, prompt: &str) -> serde_json::Value {
    json!({
        "systemInstruction": {
            "parts": [{ "text": system_prompt }]
        },
        "contents": [
            { "role": "user", "parts": [{ "text": prompt }] }
        ]
    })
}

fn build_provider_request_body(
    config: &AIProviderConfig,
    endpoint: &str,
    system_prompt: &str,
    prompt: &str,
    mode: &AIRequestMode,
) -> serde_json::Value {
    match config.provider_type {
        AIProviderType::Ollama | AIProviderType::Custom => {
            if is_ollama_native_chat_endpoint(endpoint) {
                return json!({
                    "model": config.model,
                    "messages": [
                        { "role": "system", "content": system_prompt },
                        { "role": "user", "content": prompt }
                    ],
                    "stream": false
                });
            }

            if is_ollama_native_generate_endpoint(endpoint) {
                return json!({
                    "model": config.model,
                    "system": system_prompt,
                    "prompt": prompt,
                    "stream": false
                });
            }

            build_openai_like_body(&config.model, system_prompt, prompt, mode, endpoint)
        }
        AIProviderType::Anthropic => {
            build_anthropic_body(&config.model, system_prompt, prompt, mode)
        }
        AIProviderType::Gemini => build_gemini_body(system_prompt, prompt),
        AIProviderType::OpenAI | AIProviderType::OpenRouter => {
            build_openai_like_body(&config.model, system_prompt, prompt, mode, endpoint)
        }
    }
}

#[tauri::command]
pub async fn get_ai_configs(
    storage: State<'_, AIStorage>,
) -> Result<(Vec<AIProviderConfig>, HashMap<String, bool>), String> {
    let storage = storage.inner().clone();
    run_blocking_storage_task(move || {
        storage
            .load_providers()
            .map_err(|_| ai_storage_load_error())
    })
    .await
}

#[tauri::command]
pub async fn save_ai_configs(
    providers: Vec<AIProviderConfig>,
    api_key_updates: HashMap<String, String>,
    cleared_provider_ids: Vec<String>,
    storage: State<'_, AIStorage>,
) -> Result<(Vec<AIProviderConfig>, HashMap<String, bool>), String> {
    let storage = storage.inner().clone();
    run_blocking_storage_task(move || {
        storage
            .save_providers(&providers, &api_key_updates, &cleared_provider_ids)
            .map_err(|_| ai_storage_save_error())?;
        storage
            .load_providers()
            .map_err(|_| ai_storage_load_error())
    })
    .await
}

#[tauri::command]
pub async fn ask_ai(
    request: AIRequest,
    storage: State<'_, AIStorage>,
    ai_rate_limiter: State<'_, AIRequestLimiter>,
    cancellation_state: State<'_, AIRequestCancellationState>,
) -> Result<AIResponse, String> {
    request
        .validate()
        .map_err(|e| format!("Invalid request: {}", e))?;

    let request_id = request
        .request_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let cancellation_token = CancellationToken::new();

    if let Some(request_id) = request_id.as_deref() {
        cancellation_state
            .register(request_id, cancellation_token.clone())
            .await;
    }

    let result = tokio::select! {
        _ = cancellation_token.cancelled() => Err(AI_REQUEST_CANCELLED_ERROR.to_string()),
        result = execute_ai_request(request, storage.inner(), ai_rate_limiter.inner()) => result,
    };

    if let Some(request_id) = request_id.as_deref() {
        cancellation_state.finish(request_id).await;
    }

    result
}

#[tauri::command]
pub async fn ask_ai_stream(
    request: AIRequest,
    app: AppHandle,
    storage: State<'_, AIStorage>,
    ai_rate_limiter: State<'_, AIRequestLimiter>,
    cancellation_state: State<'_, AIRequestCancellationState>,
) -> Result<(), String> {
    request
        .validate()
        .map_err(|error| format!("Invalid request: {error}"))?;
    let request_id = request
        .request_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Streaming AI requests require a request ID.".to_string())?
        .to_string();
    let token = CancellationToken::new();
    cancellation_state
        .register(&request_id, token.clone())
        .await;

    let result = execute_ai_stream_request(
        request,
        &request_id,
        &app,
        storage.inner(),
        ai_rate_limiter.inner(),
        token,
    )
    .await;
    cancellation_state.finish(&request_id).await;

    match result {
        Ok(()) => emit_ai_stream_event(&app, &request_id, "done", None, None),
        Err(error) => {
            let _ = emit_ai_stream_event(&app, &request_id, "error", Some(error.clone()), None);
            Err(error)
        }
    }
}

async fn execute_ai_stream_request(
    request: AIRequest,
    request_id: &str,
    app: &AppHandle,
    storage: &AIStorage,
    ai_rate_limiter: &AIRequestLimiter,
    cancellation_token: CancellationToken,
) -> Result<(), String> {
    let storage = storage.clone();
    let (config, api_key) = run_blocking_storage_task(move || {
        let config = storage
            .get_active_provider_config()
            .map_err(|_| ai_provider_config_error())?;
        let api_key = if provider_requires_api_key(&config.provider_type) {
            Some(
                storage
                    .get_api_key(&config.id)
                    .map_err(|_| ai_provider_config_error())?,
            )
        } else {
            storage
                .get_api_key_optional(&config.id)
                .map_err(|_| ai_provider_config_error())?
        };
        Ok((config, api_key))
    })
    .await?;

    ai_rate_limiter
        .check(&format!("{}:{:?}:stream", config.id, request.mode))
        .await?;
    if !config.is_enabled {
        return Err("Selected AI provider is disabled.".to_string());
    }

    let effective_context = if config.allow_schema_context {
        request.context.trim()
    } else {
        ""
    };
    let (system_prompt, prompt) = build_ai_prompt(
        &request.mode,
        &request.intent,
        &request.language,
        effective_context,
        &request.history,
        &request.prompt,
    );
    let base_endpoint = resolve_provider_endpoint(&config);
    validate_ai_endpoint(&config, &base_endpoint)?;
    let endpoint = streaming_endpoint(&config, &base_endpoint);
    let body = streaming_request_body(
        &config,
        &base_endpoint,
        &system_prompt,
        &prompt,
        &request.mode,
    );
    let mut request_builder = ai_http_client().post(&endpoint);
    match config.provider_type {
        AIProviderType::Anthropic => {
            request_builder = request_builder
                .header("x-api-key", api_key.as_deref().unwrap_or_default())
                .header("anthropic-version", "2023-06-01");
        }
        AIProviderType::Gemini => {
            request_builder =
                request_builder.header("x-goog-api-key", api_key.as_deref().unwrap_or_default());
        }
        _ => {
            if let Some(api_key) = api_key.as_deref() {
                request_builder = request_builder.bearer_auth(api_key);
            }
        }
    }

    let response = tokio::select! {
        _ = cancellation_token.cancelled() => return Err(AI_REQUEST_CANCELLED_ERROR.to_string()),
        response = request_builder.json(&body).send() => response
            .map_err(|error| ai_provider_request_error(&config, &endpoint, &error))?,
    };
    let status = response.status();
    if !status.is_success() {
        let raw_body = response
            .text()
            .await
            .map_err(|_| ai_provider_response_error())?;
        return Err(ai_provider_http_status_error(
            &config,
            &endpoint,
            status,
            &raw_body,
            api_key.as_deref(),
        ));
    }

    let mut stream = response.bytes_stream();
    let mut buffer = Vec::<u8>::new();
    let mut pending_text = String::new();
    let mut visible_started = false;
    let mut output_bytes = 0usize;

    loop {
        let next = tokio::select! {
            _ = cancellation_token.cancelled() => return Err(AI_REQUEST_CANCELLED_ERROR.to_string()),
            next = stream.next() => next,
        };
        let Some(chunk) = next else { break };
        let chunk = chunk.map_err(|_| ai_provider_response_error())?;
        buffer.extend_from_slice(&chunk);
        if buffer.len() > MAX_AI_STREAM_BUFFER_BYTES {
            return Err("AI stream frame exceeded the 1 MB buffer limit.".to_string());
        }

        while let Some(newline) = buffer.iter().position(|byte| *byte == b'\n') {
            let line = buffer.drain(..=newline).collect::<Vec<_>>();
            let line = String::from_utf8_lossy(&line);
            let line = line.trim().trim_start_matches("data:").trim();
            if line.is_empty() || line == "[DONE]" || line.starts_with("event:") {
                continue;
            }
            if let Ok(payload) = serde_json::from_str::<serde_json::Value>(line) {
                publish_stream_payload(
                    app,
                    request_id,
                    &config.provider_type,
                    &payload,
                    &mut pending_text,
                    &mut visible_started,
                    &mut output_bytes,
                )?;
            }
        }
    }

    if !buffer.is_empty() {
        let line = String::from_utf8_lossy(&buffer);
        let line = line.trim().trim_start_matches("data:").trim();
        if let Ok(payload) = serde_json::from_str::<serde_json::Value>(line) {
            publish_stream_payload(
                app,
                request_id,
                &config.provider_type,
                &payload,
                &mut pending_text,
                &mut visible_started,
                &mut output_bytes,
            )?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn cancel_ai_request(
    request_id: String,
    cancellation_state: State<'_, AIRequestCancellationState>,
) -> Result<bool, String> {
    let request_id = request_id.trim();
    if request_id.is_empty() {
        return Err("Request ID cannot be empty.".to_string());
    }
    Ok(cancellation_state.cancel(request_id).await)
}

async fn execute_ai_request(
    request: AIRequest,
    storage: &AIStorage,
    ai_rate_limiter: &AIRequestLimiter,
) -> Result<AIResponse, String> {
    request
        .validate()
        .map_err(|e| format!("Invalid request: {}", e))?;

    let client = ai_http_client();
    let storage = storage.clone();
    let (config, api_key) = run_blocking_storage_task(move || {
        let config = storage
            .get_active_provider_config()
            .map_err(|_| ai_provider_config_error())?;
        let api_key = if provider_requires_api_key(&config.provider_type) {
            Some(
                storage
                    .get_api_key(&config.id)
                    .map_err(|_| ai_provider_config_error())?,
            )
        } else {
            storage
                .get_api_key_optional(&config.id)
                .map_err(|_| ai_provider_config_error())?
        };

        Ok((config, api_key))
    })
    .await?;

    ai_rate_limiter
        .check(&format!("{}:{:?}", config.id, request.mode))
        .await?;

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
    let (system_prompt, prompt) = build_ai_prompt(
        &request.mode,
        &request.intent,
        &request.language,
        effective_context,
        &request.history,
        &request.prompt,
    );

    match config.provider_type {
        AIProviderType::OpenAI
        | AIProviderType::OpenRouter
        | AIProviderType::Ollama
        | AIProviderType::Custom => {
            let endpoint = resolve_provider_endpoint(&config);
            validate_ai_endpoint(&config, &endpoint)?;
            let body = build_provider_request_body(
                &config,
                &endpoint,
                &system_prompt,
                &prompt,
                &request.mode,
            );
            let max_attempts = if is_nvidia_integrate_endpoint(&endpoint) {
                3
            } else {
                2
            };

            for attempt in 0..max_attempts {
                let mut req = client.post(&endpoint);
                if let Some(ref api_key) = api_key {
                    req = req.bearer_auth(api_key);
                }

                let response = req
                    .json(&body)
                    .send()
                    .await
                    .map_err(|error| ai_provider_request_error(&config, &endpoint, &error))?;

                let status = response.status();
                let raw_body = response
                    .text()
                    .await
                    .map_err(|_| ai_provider_response_error())?;

                if !status.is_success() {
                    if should_retry_openai_like_status(status) && attempt + 1 < max_attempts {
                        sleep(Duration::from_millis(800 * (attempt as u64 + 1))).await;
                        continue;
                    }

                    if let Ok(resp_json) = serde_json::from_str::<serde_json::Value>(&raw_body) {
                        if let Some(err) = resp_json.get("error") {
                            let msg = if let Some(m) = err.get("message").and_then(|v| v.as_str()) {
                                m.to_string()
                            } else if let Some(m) = err.as_str() {
                                m.to_string()
                            } else {
                                err.to_string()
                            };
                            return Err(ai_provider_api_error(&msg, api_key.as_deref()));
                        }

                        return Err(ai_provider_response_error_with_preview(
                            &config,
                            &endpoint,
                            &resp_json,
                            api_key.as_deref(),
                        ));
                    }

                    return Err(ai_provider_http_status_error(
                        &config,
                        &endpoint,
                        status,
                        &raw_body,
                        api_key.as_deref(),
                    ));
                }

                let resp_json: serde_json::Value =
                    serde_json::from_str(&raw_body).map_err(|_| {
                        ai_provider_non_json_response_error(
                            &config,
                            &endpoint,
                            &raw_body,
                            api_key.as_deref(),
                        )
                    })?;

                if let Some(err) = resp_json.get("error") {
                    let msg = if let Some(m) = err.get("message").and_then(|v| v.as_str()) {
                        m.to_string()
                    } else if let Some(m) = err.as_str() {
                        m.to_string()
                    } else {
                        err.to_string()
                    };
                    return Err(ai_provider_api_error(&msg, api_key.as_deref()));
                }

                if let Some(text) = extract_openai_like_response_text(&resp_json) {
                    let field_reasoning = extract_openai_like_reasoning(&resp_json);
                    let (think_reasoning, cleaned) = split_think_block(&text);
                    let reasoning = field_reasoning.or(think_reasoning);
                    return Ok(AIResponse {
                        text: cleaned,
                        reasoning,
                        error: None,
                    });
                }

                return Err(ai_provider_response_error_with_preview(
                    &config,
                    &endpoint,
                    &resp_json,
                    api_key.as_deref(),
                ));
            }

            Err(ai_provider_response_error())
        }
        AIProviderType::Anthropic => {
            let endpoint = resolve_provider_endpoint(&config);
            validate_ai_endpoint(&config, &endpoint)?;
            let body = build_provider_request_body(
                &config,
                &endpoint,
                &system_prompt,
                &prompt,
                &request.mode,
            );

            let response = client
                .post(&endpoint)
                .header("x-api-key", api_key.as_deref().unwrap_or_default())
                .header("anthropic-version", "2023-06-01")
                .json(&body)
                .send()
                .await
                .map_err(|error| ai_provider_request_error(&config, &endpoint, &error))?;

            let status = response.status();
            let raw_body = response
                .text()
                .await
                .map_err(|_| ai_provider_response_error())?;

            if !status.is_success() {
                if let Ok(resp_json) = serde_json::from_str::<serde_json::Value>(&raw_body) {
                    if let Some(err) = resp_json.get("error") {
                        let msg = if let Some(m) = err.get("message").and_then(|v| v.as_str()) {
                            m.to_string()
                        } else if let Some(m) = err.as_str() {
                            m.to_string()
                        } else {
                            err.to_string()
                        };
                        return Err(ai_provider_api_error(&msg, api_key.as_deref()));
                    }

                    return Err(ai_provider_response_error_with_preview(
                        &config,
                        &endpoint,
                        &resp_json,
                        api_key.as_deref(),
                    ));
                }

                return Err(ai_provider_http_status_error(
                    &config,
                    &endpoint,
                    status,
                    &raw_body,
                    api_key.as_deref(),
                ));
            }

            let resp_json: serde_json::Value = serde_json::from_str(&raw_body).map_err(|_| {
                ai_provider_non_json_response_error(
                    &config,
                    &endpoint,
                    &raw_body,
                    api_key.as_deref(),
                )
            })?;
            if let Some(err) = resp_json.get("error") {
                let msg = if let Some(m) = err.get("message").and_then(|v| v.as_str()) {
                    m.to_string()
                } else if let Some(m) = err.as_str() {
                    m.to_string()
                } else {
                    err.to_string()
                };
                return Err(ai_provider_api_error(&msg, api_key.as_deref()));
            }

            if let Some(text) = extract_anthropic_response_text(&resp_json) {
                let (reasoning, cleaned) = split_think_block(&text);
                return Ok(AIResponse {
                    text: cleaned,
                    reasoning,
                    error: None,
                });
            }

            Err(ai_provider_response_error_with_preview(
                &config,
                &endpoint,
                &resp_json,
                api_key.as_deref(),
            ))
        }
        AIProviderType::Gemini => {
            let endpoint = resolve_provider_endpoint(&config);
            validate_ai_endpoint(&config, &endpoint)?;
            let body = build_provider_request_body(
                &config,
                &endpoint,
                &system_prompt,
                &prompt,
                &request.mode,
            );

            let response = client
                .post(&endpoint)
                .header("x-goog-api-key", api_key.as_deref().unwrap_or_default())
                .json(&body)
                .send()
                .await
                .map_err(|error| ai_provider_request_error(&config, &endpoint, &error))?;

            let status = response.status();
            let raw_body = response
                .text()
                .await
                .map_err(|_| ai_provider_response_error())?;

            if !status.is_success() {
                if let Ok(resp_json) = serde_json::from_str::<serde_json::Value>(&raw_body) {
                    if let Some(err) = resp_json.get("error") {
                        let msg = if let Some(m) = err.get("message").and_then(|v| v.as_str()) {
                            m.to_string()
                        } else if let Some(m) = err.as_str() {
                            m.to_string()
                        } else {
                            err.to_string()
                        };
                        return Err(ai_provider_api_error(&msg, api_key.as_deref()));
                    }

                    return Err(ai_provider_response_error_with_preview(
                        &config,
                        &endpoint,
                        &resp_json,
                        api_key.as_deref(),
                    ));
                }

                return Err(ai_provider_http_status_error(
                    &config,
                    &endpoint,
                    status,
                    &raw_body,
                    api_key.as_deref(),
                ));
            }

            let resp_json: serde_json::Value = serde_json::from_str(&raw_body).map_err(|_| {
                ai_provider_non_json_response_error(
                    &config,
                    &endpoint,
                    &raw_body,
                    api_key.as_deref(),
                )
            })?;
            if let Some(err) = resp_json.get("error") {
                let msg = if let Some(m) = err.get("message").and_then(|v| v.as_str()) {
                    m.to_string()
                } else if let Some(m) = err.as_str() {
                    m.to_string()
                } else {
                    err.to_string()
                };
                return Err(ai_provider_api_error(&msg, api_key.as_deref()));
            }

            if let Some(text) = extract_gemini_response_text(&resp_json) {
                let (reasoning, cleaned) = split_think_block(&text);
                return Ok(AIResponse {
                    text: cleaned,
                    reasoning,
                    error: None,
                });
            }

            Err(ai_provider_response_error_with_preview(
                &config,
                &endpoint,
                &resp_json,
                api_key.as_deref(),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_provider(provider_type: AIProviderType) -> AIProviderConfig {
        AIProviderConfig {
            id: "provider".to_string(),
            name: "Provider".to_string(),
            provider_type,
            endpoint: String::new(),
            model: "demo-model".to_string(),
            is_enabled: true,
            is_primary: true,
            allow_schema_context: true,
            allow_inline_completion: true,
        }
    }

    #[test]
    fn split_think_block_extracts_leading_reasoning() {
        let (reasoning, cleaned) =
            split_think_block("<think>step one\nstep two</think>\nSELECT 1;");
        assert_eq!(reasoning.as_deref(), Some("step one\nstep two"));
        assert_eq!(cleaned, "SELECT 1;");
    }

    #[test]
    fn split_think_block_without_tag_returns_text_unchanged() {
        let (reasoning, cleaned) = split_think_block("just an answer");
        assert!(reasoning.is_none());
        assert_eq!(cleaned, "just an answer");
    }

    #[test]
    fn split_think_block_handles_unclosed_tag_as_reasoning() {
        let (reasoning, cleaned) = split_think_block("<think>still thinking");
        assert_eq!(reasoning.as_deref(), Some("still thinking"));
        assert_eq!(cleaned, "");
    }

    #[test]
    fn streaming_body_is_enabled_and_think_chunks_stay_private() {
        let provider = sample_provider(AIProviderType::OpenAI);
        let endpoint = resolve_provider_endpoint(&provider);
        let body = streaming_request_body(
            &provider,
            &endpoint,
            "system",
            "prompt",
            &AIRequestMode::Panel,
        );
        assert_eq!(
            body.get("stream").and_then(|value| value.as_bool()),
            Some(true)
        );

        let mut pending = String::new();
        let mut visible = false;
        assert_eq!(
            take_visible_stream_delta("<thi", &mut pending, &mut visible),
            ""
        );
        assert_eq!(
            take_visible_stream_delta(
                "nk>private scratch</think>Hello",
                &mut pending,
                &mut visible,
            ),
            "Hello"
        );
        assert_eq!(
            take_visible_stream_delta(" world", &mut pending, &mut visible),
            " world"
        );
        assert!(!pending.contains("Hello"));
    }

    #[test]
    fn extracts_openai_reasoning_field() {
        let payload = json!({
            "choices": [{
                "message": {
                    "content": "SELECT 1;",
                    "reasoning_content": "The user wants a trivial query."
                }
            }]
        });
        assert_eq!(
            extract_openai_like_reasoning(&payload).as_deref(),
            Some("The user wants a trivial query.")
        );
    }

    #[test]
    fn missing_reasoning_field_returns_none() {
        let payload = json!({
            "choices": [{ "message": { "content": "SELECT 1;" } }]
        });
        assert!(extract_openai_like_reasoning(&payload).is_none());
    }

    #[test]
    fn extracts_openai_text_from_block_array_content() {
        let payload = json!({
            "choices": [{
                "message": {
                    "content": [
                        { "type": "text", "text": "hello" },
                        { "type": "text", "text": "world" }
                    ]
                }
            }]
        });

        assert_eq!(
            extract_openai_like_response_text(&payload).as_deref(),
            Some("hello\n\nworld")
        );
    }

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
    fn builds_openai_like_body_with_stream_disabled_and_token_limit() {
        let provider = sample_provider(AIProviderType::OpenAI);
        let body = build_provider_request_body(
            &provider,
            "https://integrate.api.nvidia.com/v1/chat/completions",
            "system prompt",
            "user prompt",
            &AIRequestMode::Panel,
        );

        assert_eq!(
            body.get("stream").and_then(|value| value.as_bool()),
            Some(false)
        );
        assert_eq!(
            body.get("max_tokens").and_then(|value| value.as_u64()),
            Some(4096)
        );
        assert_eq!(
            body.pointer("/chat_template_kwargs/enable_thinking")
                .and_then(|value| value.as_bool()),
            Some(false)
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

    #[test]
    fn provider_request_bodies_match_supported_api_contracts() {
        let anthropic = sample_provider(AIProviderType::Anthropic);
        let anthropic_body = build_provider_request_body(
            &anthropic,
            &resolve_provider_endpoint(&anthropic),
            "system prompt",
            "user prompt",
            &AIRequestMode::Panel,
        );
        assert_eq!(anthropic_body["model"], "demo-model");
        assert_eq!(anthropic_body["system"], "system prompt");
        assert_eq!(anthropic_body["max_tokens"], 4096);
        assert_eq!(anthropic_body["messages"][0]["content"], "user prompt");
        assert!(anthropic_body.get("stream").is_none());

        let gemini = sample_provider(AIProviderType::Gemini);
        let gemini_body = build_provider_request_body(
            &gemini,
            &resolve_provider_endpoint(&gemini),
            "system prompt",
            "user prompt",
            &AIRequestMode::Panel,
        );
        assert_eq!(
            gemini_body["systemInstruction"]["parts"][0]["text"],
            "system prompt"
        );
        assert_eq!(gemini_body["contents"][0]["role"], "user");
        assert_eq!(
            gemini_body["contents"][0]["parts"][0]["text"],
            "user prompt"
        );

        let mut ollama = sample_provider(AIProviderType::Ollama);
        ollama.endpoint = "http://localhost:11434/api/generate".to_string();
        let ollama_body = build_provider_request_body(
            &ollama,
            &resolve_provider_endpoint(&ollama),
            "system prompt",
            "user prompt",
            &AIRequestMode::Panel,
        );
        assert_eq!(ollama_body["system"], "system prompt");
        assert_eq!(ollama_body["prompt"], "user prompt");
        assert_eq!(ollama_body["stream"], false);
        assert!(ollama_body.get("messages").is_none());
    }

    #[test]
    fn provider_response_extractors_match_fixture_contracts() {
        let openai = json!({
            "choices": [{ "message": { "content": "openai answer" } }]
        });
        let anthropic = json!({
            "content": [{ "type": "text", "text": "anthropic answer" }]
        });
        let gemini = json!({
            "candidates": [{
                "content": { "parts": [{ "text": "gemini answer" }] }
            }]
        });

        assert_eq!(
            extract_openai_like_response_text(&openai).as_deref(),
            Some("openai answer")
        );
        assert_eq!(
            extract_anthropic_response_text(&anthropic).as_deref(),
            Some("anthropic answer")
        );
        assert_eq!(
            extract_gemini_response_text(&gemini).as_deref(),
            Some("gemini answer")
        );
    }

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

    #[tokio::test]
    async fn cancels_and_cleans_up_registered_ai_requests() {
        let state = AIRequestCancellationState::default();
        let token = CancellationToken::new();

        state.register("request-1", token.clone()).await;
        assert!(state.cancel("request-1").await);
        assert!(token.is_cancelled());

        state.finish("request-1").await;
        assert!(!state.cancel("request-1").await);
    }
}
