use crate::database::ai_models::{
    AIConversationMessage, AIConversationRole, AIProviderConfig, AIProviderType, AIRequest,
    AIRequestIntent, AIRequestMode, AIResponse, AIResponseLanguage,
};
use crate::storage::ai_storage::AIStorage;
use crate::utils::rate_limiter::AIRequestLimiter;
use reqwest::{Client, StatusCode, Url};
use serde_json::json;
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::OnceLock;
use tauri::State;
use tokio::task;
use tokio::time::{sleep, Duration};

static AI_HTTP_CLIENT: OnceLock<Client> = OnceLock::new();

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
            let port = url.port().map(|value| format!(":{value}")).unwrap_or_default();
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
        format!("The connection to {endpoint_label} failed because of an SSL/TLS certificate problem.")
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
        format!("Could not reach {endpoint_label}. {raw_error}")
    };

    format!("The AI request to \"{provider_label}\" could not be completed. {detail}")
}

fn ai_provider_response_error() -> String {
    "The AI provider returned an invalid or unsupported response.".to_string()
}

fn compact_response_preview(body: &str) -> String {
    let compact = body.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.len() > 320 {
        format!("{}...", &compact[..317])
    } else {
        compact
    }
}

fn ai_provider_http_status_error(
    config: &AIProviderConfig,
    endpoint: &str,
    status: StatusCode,
    body: &str,
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
            let port = url.port().map(|value| format!(":{value}")).unwrap_or_default();
            Some(format!("{host}{port}"))
        })
        .unwrap_or_else(|| endpoint.to_string());
    let status_label = status
        .canonical_reason()
        .map(|reason| format!("{} {}", status.as_u16(), reason))
        .unwrap_or_else(|| status.as_u16().to_string());
    let preview = compact_response_preview(body);
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
            let port = url.port().map(|value| format!(":{value}")).unwrap_or_default();
            Some(format!("{host}{port}"))
        })
        .unwrap_or_else(|| endpoint.to_string());
    let preview = compact_response_preview(body);

    format!(
        "The AI provider \"{provider_label}\" at {endpoint_label} returned a non-JSON response. Response preview: {preview}"
    )
}

fn ai_provider_response_error_with_preview(
    config: &AIProviderConfig,
    endpoint: &str,
    payload: &serde_json::Value,
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
            let port = url.port().map(|value| format!(":{value}")).unwrap_or_default();
            Some(format!("{host}{port}"))
        })
        .unwrap_or_else(|| endpoint.to_string());

    let preview = payload.to_string();
    let compact_preview = if preview.len() > 320 {
        format!("{}...", &preview[..317])
    } else {
        preview
    };

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
            ipv4.is_private()
                || ipv4.is_loopback()
                || ipv4.is_link_local()
                || ipv4.is_broadcast()
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
            for key in ["text", "content", "parts", "response", "output_text", "value"] {
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

    if let Some(text) = payload.pointer("/output/0/content").and_then(extract_text_from_json) {
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
        AIRequestMode::Panel => 1024,
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

fn build_provider_request_body(
    config: &AIProviderConfig,
    endpoint: &str,
    system_prompt: &str,
    prompt: &str,
    mode: &AIRequestMode,
) -> serde_json::Value {
    if matches!(config.provider_type, AIProviderType::Ollama | AIProviderType::Custom) {
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
    }

    build_openai_like_body(&config.model, system_prompt, prompt, mode, endpoint)
}

#[tauri::command]
pub async fn get_ai_configs(
    storage: State<'_, AIStorage>,
) -> Result<(Vec<AIProviderConfig>, HashMap<String, bool>), String> {
    let storage = storage.inner().clone();
    run_blocking_storage_task(move || storage.load_providers().map_err(|_| ai_storage_load_error()))
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
    request
        .validate()
        .map_err(|e| format!("Invalid request: {}", e))?;

    let client = ai_http_client();
    let storage = storage.inner().clone();
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
            let body =
                build_provider_request_body(&config, &endpoint, &system_prompt, &prompt, &request.mode);
            let max_attempts = if is_nvidia_integrate_endpoint(&endpoint) { 3 } else { 2 };

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
                            let msg = if let Some(m) = err.get("message").and_then(|v| v.as_str())
                            {
                                m.to_string()
                            } else if let Some(m) = err.as_str() {
                                m.to_string()
                            } else {
                                err.to_string()
                            };
                            return Err(format!("AI API error: {}", msg));
                        }

                        return Err(ai_provider_response_error_with_preview(
                            &config, &endpoint, &resp_json,
                        ));
                    }

                    return Err(ai_provider_http_status_error(
                        &config, &endpoint, status, &raw_body,
                    ));
                }

                let resp_json: serde_json::Value = serde_json::from_str(&raw_body)
                    .map_err(|_| ai_provider_non_json_response_error(&config, &endpoint, &raw_body))?;

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

                if let Some(text) = extract_openai_like_response_text(&resp_json) {
                    return Ok(AIResponse { text, error: None });
                }

                return Err(ai_provider_response_error_with_preview(
                    &config, &endpoint, &resp_json,
                ));
            }

            Err(ai_provider_response_error())
        }
        AIProviderType::Anthropic => {
            let body = json!({
                "system": system_prompt,
                "model": config.model,
                "max_tokens": 1024,
                "messages": [
                    { "role": "user", "content": prompt }
                ]
            });
            let endpoint = resolve_provider_endpoint(&config);
            validate_ai_endpoint(&config, &endpoint)?;

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
                        return Err(format!("AI API error: {}", msg));
                    }

                    return Err(ai_provider_response_error_with_preview(
                        &config, &endpoint, &resp_json,
                    ));
                }

                return Err(ai_provider_http_status_error(
                    &config, &endpoint, status, &raw_body,
                ));
            }

            let resp_json: serde_json::Value = serde_json::from_str(&raw_body)
                .map_err(|_| ai_provider_non_json_response_error(&config, &endpoint, &raw_body))?;
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

            if let Some(text) = extract_anthropic_response_text(&resp_json) {
                return Ok(AIResponse { text, error: None });
            }

            Err(ai_provider_response_error_with_preview(
                &config, &endpoint, &resp_json,
            ))
        }
        AIProviderType::Gemini => {
            let body = json!({
                "systemInstruction": {
                    "parts": [{ "text": system_prompt }]
                },
                "contents": [
                    { "role": "user", "parts": [{ "text": prompt }] }
                ]
            });
            let endpoint = resolve_provider_endpoint(&config);
            validate_ai_endpoint(&config, &endpoint)?;

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
                        return Err(format!("AI API error: {}", msg));
                    }

                    return Err(ai_provider_response_error_with_preview(
                        &config, &endpoint, &resp_json,
                    ));
                }

                return Err(ai_provider_http_status_error(
                    &config, &endpoint, status, &raw_body,
                ));
            }

            let resp_json: serde_json::Value = serde_json::from_str(&raw_body)
                .map_err(|_| ai_provider_non_json_response_error(&config, &endpoint, &raw_body))?;
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

            if let Some(text) = extract_gemini_response_text(&resp_json) {
                return Ok(AIResponse { text, error: None });
            }

            Err(ai_provider_response_error_with_preview(
                &config, &endpoint, &resp_json,
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

        assert_eq!(body.get("stream").and_then(|value| value.as_bool()), Some(false));
        assert_eq!(body.get("max_tokens").and_then(|value| value.as_u64()), Some(1024));
        assert_eq!(
            body.pointer("/chat_template_kwargs/enable_thinking")
                .and_then(|value| value.as_bool()),
            Some(false)
        );
    }
}
