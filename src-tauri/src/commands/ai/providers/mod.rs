use crate::database::ai_models::{AIProviderConfig, AIProviderType, AIRequestMode};
use serde_json::json;

use super::endpoints::{
    is_nvidia_integrate_endpoint, is_ollama_native_chat_endpoint,
    is_ollama_native_generate_endpoint,
};

mod history;
mod models;
pub(crate) use history::*;
pub(crate) use models::*;

pub(crate) fn streaming_request_body_with_thinking(
    config: &AIProviderConfig,
    endpoint: &str,
    system_prompt: &str,
    prompt: &str,
    mode: &AIRequestMode,
    enable_thinking: Option<bool>,
) -> serde_json::Value {
    let mut body = build_provider_request_body_with_thinking(
        config,
        endpoint,
        system_prompt,
        prompt,
        mode,
        enable_thinking,
    );
    if let Some(object) = body.as_object_mut() {
        if !matches!(
            config.provider_type,
            AIProviderType::Gemini | AIProviderType::Vertex
        ) {
            object.insert("stream".to_string(), serde_json::Value::Bool(true));
        }
        if matches!(
            config.provider_type,
            AIProviderType::OpenAI | AIProviderType::OpenRouter | AIProviderType::Custom
        ) && !matches!(
            resolve_provider_body_shape(config, endpoint),
            ProviderBodyShape::Anthropic
        ) {
            object.insert(
                "stream_options".to_string(),
                json!({ "include_usage": true }),
            );
        }
    }
    body
}

/// Test-only 5-arg shim: preserves the default (capability-gated) thinking
/// behaviour so the streaming body-shape tests stay concise.
#[cfg(test)]
pub(crate) fn streaming_request_body(
    config: &AIProviderConfig,
    endpoint: &str,
    system_prompt: &str,
    prompt: &str,
    mode: &AIRequestMode,
) -> serde_json::Value {
    streaming_request_body_with_thinking(config, endpoint, system_prompt, prompt, mode, None)
}

/// The provider identity a config behaves as on the wire. Custom/Ollama
/// configs with an explicit `anthropic` API format act exactly like a native
/// Anthropic provider (body, auth headers, tool calls, response + stream
/// parsing), so callers should route everything through this instead of the
/// raw `config.provider_type`.
pub(crate) fn effective_wire_provider(config: &AIProviderConfig, endpoint: &str) -> AIProviderType {
    if matches!(
        config.provider_type,
        AIProviderType::Ollama | AIProviderType::Custom
    ) && matches!(
        resolve_provider_body_shape(config, endpoint),
        ProviderBodyShape::Anthropic
    ) {
        AIProviderType::Anthropic
    } else {
        config.provider_type.clone()
    }
}

pub(crate) fn streaming_endpoint(config: &AIProviderConfig, endpoint: &str) -> String {
    if matches!(
        config.provider_type,
        AIProviderType::Gemini | AIProviderType::Vertex
    ) {
        let Ok(mut url) = reqwest::Url::parse(endpoint) else {
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

fn default_max_output_tokens(mode: &AIRequestMode) -> u32 {
    // Values centralized in `crate::config` (tech-debt audit D10). Panel needs
    // room to close the JSON action object plus a markdown explanation.
    match mode {
        AIRequestMode::Inline => crate::config::AI_INLINE_MAX_OUTPUT_TOKENS,
        AIRequestMode::Panel => crate::config::AI_PANEL_MAX_OUTPUT_TOKENS,
    }
}

/// Extended-thinking token budget for Anthropic panel turns. Rides on TOP of the
/// answer budget because Anthropic counts thinking tokens against `max_tokens`.
use crate::config::ANTHROPIC_THINKING_BUDGET_TOKENS;

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

/// Process-global set of model ids a provider has rejected extended-thinking for
/// (tech-debt audit D2). The static allowlists above (`*_supports_thinking`) are
/// a best-effort fast path by name; a model released after this build with a new
/// naming scheme would either silently miss thinking or 400 on the parameter.
/// This cache lets the app SELF-HEAL: once a model 400s on the thinking param we
/// stop sending it for the rest of the process, so the very next turn succeeds.
fn thinking_unsupported_models() -> &'static Mutex<HashSet<String>> {
    static MODELS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    MODELS.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Records that `model` rejected the extended-thinking parameter (case-insensitive)
/// so later turns and other send paths skip it.
pub(crate) fn mark_model_thinking_unsupported(model: &str) {
    if model.trim().is_empty() {
        return;
    }
    if let Ok(mut set) = thinking_unsupported_models().lock() {
        set.insert(model.to_ascii_lowercase());
    }
}

/// True once `model` has been recorded as rejecting extended-thinking.
pub(crate) fn model_thinking_unsupported(model: &str) -> bool {
    thinking_unsupported_models()
        .lock()
        .map(|set| set.contains(&model.to_ascii_lowercase()))
        .unwrap_or(false)
}

/// Heuristic: does a provider's error body look like a rejection of the
/// extended-thinking parameter (as opposed to an unrelated 400)? Matches the
/// parameter names TableR sends for thinking across OpenAI-like / Anthropic /
/// Gemini. Kept pure so it is unit-tested. Only consulted on a 400, and the only
/// consequence of a false positive is one thinking-free retry, so a broad match
/// is safe.
pub(crate) fn is_thinking_param_rejection(body_text: &str) -> bool {
    let text = body_text.to_ascii_lowercase();
    const THINKING_PARAMS: [&str; 6] = [
        "enable_thinking",
        "chat_template_kwargs",
        "thinkingconfig",
        "includethoughts",
        "budget_tokens",
        "\"thinking\"",
    ];
    THINKING_PARAMS.iter().any(|needle| text.contains(needle))
}

/// OpenAI-compatible models that emit chain-of-thought via the chat-template
/// `enable_thinking` switch (DeepSeek-R1, Qwen "thinking"/QwQ builds). NVIDIA's
/// integrate gateway hides reasoning behind that flag, so we only flip it on for
/// models that actually understand it and leave every other model byte-identical.
fn model_supports_openai_thinking_switch(model: &str) -> bool {
    let model = model.to_ascii_lowercase();
    model.contains("deepseek-r1")
        || model.contains("qwq")
        || model.contains("qwen3")
        || model.contains("thinking")
}

/// Claude models with the extended-thinking API (`thinking` block). Older 3.5/3
/// models reject the field with 400, so only positively-known families opt in.
fn anthropic_model_supports_thinking(model: &str) -> bool {
    let model = model.to_ascii_lowercase();
    model.contains("claude-3-7")
        || model.contains("claude-sonnet-4")
        || model.contains("claude-opus-4")
        || model.contains("claude-haiku-4")
}

/// Gemini models that return "thought summary" parts when asked
/// (`thinkingConfig.includeThoughts`). The 2.5 family; older models 400 on it.
fn gemini_model_supports_thinking(model: &str) -> bool {
    model.to_ascii_lowercase().contains("2.5")
}

fn build_openai_like_body(
    model: &str,
    system_prompt: &str,
    prompt: &str,
    mode: &AIRequestMode,
    endpoint: &str,
    enable_thinking: Option<bool>,
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
        // NVIDIA's integrate gateway hides reasoning behind the chat-template
        // `enable_thinking` switch. Turn it on for reasoning models in the panel
        // (where the "Thinking…" trace lives) so DeepSeek-R1 & co. emit their
        // `reasoning_content`; keep it off for non-reasoning models and the terse
        // inline path so those bodies stay byte-identical and never 400 on a kwarg
        // the model's chat template does not understand.
        // The user's panel toggle can force it off (save tokens); otherwise it
        // stays capability-gated so unknown models never get a kwarg they'd 400 on.
        let thinking_on = enable_thinking.unwrap_or(true)
            && matches!(mode, AIRequestMode::Panel)
            && model_supports_openai_thinking_switch(model)
            && !model_thinking_unsupported(model);
        body["chat_template_kwargs"] = json!({ "enable_thinking": thinking_on });
    }

    body
}

fn build_anthropic_body(
    model: &str,
    system_prompt: &str,
    prompt: &str,
    mode: &AIRequestMode,
    enable_thinking: Option<bool>,
) -> serde_json::Value {
    let mut body = json!({
        "system": system_prompt,
        "model": model,
        "max_tokens": default_max_output_tokens(mode),
        "messages": [
            { "role": "user", "content": prompt }
        ]
    });

    // Extended thinking: only for panel turns on models that support it, so the
    // collapsible "Thinking…" trace gets Claude's real reasoning. The budget rides
    // on TOP of the answer budget (Anthropic counts thinking tokens against
    // `max_tokens`), temperature stays unset, and `tool_choice` is "auto" app-wide,
    // so this never trips the forced-tool / temperature incompatibilities.
    if enable_thinking.unwrap_or(true)
        && matches!(mode, AIRequestMode::Panel)
        && anthropic_model_supports_thinking(model)
        && !model_thinking_unsupported(model)
    {
        let budget_tokens = ANTHROPIC_THINKING_BUDGET_TOKENS;
        body["max_tokens"] = json!(default_max_output_tokens(mode) + budget_tokens);
        body["thinking"] = json!({ "type": "enabled", "budget_tokens": budget_tokens });
    }

    body
}

fn build_gemini_body(
    model: &str,
    system_prompt: &str,
    prompt: &str,
    mode: &AIRequestMode,
    enable_thinking: Option<bool>,
) -> serde_json::Value {
    let mut body = json!({
        "systemInstruction": {
            "parts": [{ "text": system_prompt }]
        },
        "contents": [
            { "role": "user", "parts": [{ "text": prompt }] }
        ]
    });

    // Gemini 2.5 only returns "thought summary" parts when asked. Request them for
    // panel turns so the "Thinking…" trace fills in; older models don't know the
    // field and would 400, so gate on the 2.5 family.
    if enable_thinking.unwrap_or(true)
        && matches!(mode, AIRequestMode::Panel)
        && gemini_model_supports_thinking(model)
        && !model_thinking_unsupported(model)
    {
        body["generationConfig"] = json!({
            "thinkingConfig": { "includeThoughts": true }
        });
    }

    body
}

/// Wire shape a provider request body uses. Resolved once so body building and
/// image attachment injection always agree on the same dialect.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProviderBodyShape {
    OpenAiLike,
    OllamaChat,
    OllamaGenerate,
    Anthropic,
    Gemini,
}

pub(crate) fn resolve_provider_body_shape(
    config: &AIProviderConfig,
    endpoint: &str,
) -> ProviderBodyShape {
    // An explicit API format wins over URL sniffing so users can point a
    // Custom provider at any path (e.g. an Ollama server behind a proxy).
    if matches!(
        config.provider_type,
        AIProviderType::Ollama | AIProviderType::Custom
    ) {
        match super::endpoints::explicit_api_format(config) {
            Some("ollama-chat") => return ProviderBodyShape::OllamaChat,
            Some("ollama-generate") => return ProviderBodyShape::OllamaGenerate,
            Some("chat-completions") => return ProviderBodyShape::OpenAiLike,
            Some("anthropic") => return ProviderBodyShape::Anthropic,
            _ => {}
        }
    }

    match config.provider_type {
        AIProviderType::Ollama | AIProviderType::Custom => {
            if is_ollama_native_chat_endpoint(endpoint) {
                ProviderBodyShape::OllamaChat
            } else if is_ollama_native_generate_endpoint(endpoint) {
                ProviderBodyShape::OllamaGenerate
            } else {
                ProviderBodyShape::OpenAiLike
            }
        }
        AIProviderType::Anthropic => ProviderBodyShape::Anthropic,
        AIProviderType::Gemini | AIProviderType::Vertex => ProviderBodyShape::Gemini,
        AIProviderType::OpenAI | AIProviderType::OpenRouter => ProviderBodyShape::OpenAiLike,
    }
}

pub(crate) fn build_provider_request_body_with_thinking(
    config: &AIProviderConfig,
    endpoint: &str,
    system_prompt: &str,
    prompt: &str,
    mode: &AIRequestMode,
    enable_thinking: Option<bool>,
) -> serde_json::Value {
    match resolve_provider_body_shape(config, endpoint) {
        ProviderBodyShape::OllamaChat => {
            json!({
                "model": config.model,
                "messages": [
                    { "role": "system", "content": system_prompt },
                    { "role": "user", "content": prompt }
                ],
                "stream": false
            })
        }
        ProviderBodyShape::OllamaGenerate => {
            json!({
                "model": config.model,
                "system": system_prompt,
                "prompt": prompt,
                "stream": false
            })
        }
        ProviderBodyShape::Anthropic => {
            build_anthropic_body(&config.model, system_prompt, prompt, mode, enable_thinking)
        }
        ProviderBodyShape::Gemini => {
            build_gemini_body(&config.model, system_prompt, prompt, mode, enable_thinking)
        }
        ProviderBodyShape::OpenAiLike => build_openai_like_body(
            &config.model,
            system_prompt,
            prompt,
            mode,
            endpoint,
            enable_thinking,
        ),
    }
}

/// Test-only 5-arg shim: preserves the default (capability-gated) thinking
/// behaviour so the body-shape tests stay concise.
#[cfg(test)]
pub(crate) fn build_provider_request_body(
    config: &AIProviderConfig,
    endpoint: &str,
    system_prompt: &str,
    prompt: &str,
    mode: &AIRequestMode,
) -> serde_json::Value {
    build_provider_request_body_with_thinking(config, endpoint, system_prompt, prompt, mode, None)
}

#[cfg(test)]
mod tests;
