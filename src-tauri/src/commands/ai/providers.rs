use crate::database::ai_models::{
    AIConversationMessage, AIConversationRole, AIProviderConfig, AIProviderType, AIRequestAttachment,
    AIRequestMode,
};
use serde_json::json;
#[cfg(test)]
use std::collections::HashMap;

use super::endpoints::{
    is_nvidia_integrate_endpoint, is_ollama_native_chat_endpoint,
    is_ollama_native_generate_endpoint, ModelsListShape,
};
use super::FetchedModel;

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
    match mode {
        AIRequestMode::Inline => 256,
        // Panel covers the chat + the agent controller. Agent finish turns embed
        // SQL plus a markdown explanation, so 1024 tokens often truncated the
        // JSON action mid-string; give it enough room to close the object.
        AIRequestMode::Panel => 4096,
    }
}

/// Extended-thinking token budget for Anthropic panel turns. Rides on TOP of the
/// answer budget because Anthropic counts thinking tokens against `max_tokens`.
const ANTHROPIC_THINKING_BUDGET_TOKENS: u32 = 2048;

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
            && model_supports_openai_thinking_switch(model);
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

/// Extracts the models from a provider's "list models" response, along with any
/// capability metadata (context window, output budget, input modalities) the
/// API advertised so the settings modal can auto-fill them instead of forcing
/// manual entry. The envelope differs per dialect (`shape`), so the caller
/// resolves that first via `resolve_models_list_endpoint`. Duplicate ids and
/// blanks are dropped while preserving the provider's own ordering.
pub(crate) fn parse_models_list_response(
    shape: ModelsListShape,
    value: &serde_json::Value,
) -> Vec<FetchedModel> {
    let raw: Vec<FetchedModel> = match shape {
        ModelsListShape::OpenAiData => value
            .get("data")
            .and_then(|data| data.as_array())
            .map(|entries| entries.iter().filter_map(parse_openai_model_entry).collect())
            .unwrap_or_default(),
        ModelsListShape::OllamaTags => value
            .get("models")
            .and_then(|models| models.as_array())
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(|entry| entry.get("name").and_then(|name| name.as_str()))
                    .map(|name| FetchedModel {
                        id: name.to_string(),
                        context_window: None,
                        max_output_tokens: None,
                        input_types: Vec::new(),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        ModelsListShape::GeminiModels => value
            .get("models")
            .and_then(|models| models.as_array())
            .map(|entries| {
                entries
                    .iter()
                    .filter(|entry| supports_generate_content(entry))
                    .filter_map(parse_gemini_model_entry)
                    .collect()
            })
            .unwrap_or_default(),
    };

    let mut seen = std::collections::HashSet::new();
    raw.into_iter()
        .map(|mut model| {
            model.id = model.id.trim().to_string();
            model
        })
        .filter(|model| !model.id.is_empty())
        .filter(|model| seen.insert(model.id.clone()))
        .collect()
}

/// Reads a token-count field a provider may send as an integer or a stringified
/// number, checking each candidate key in order. Non-positive or unparseable
/// values are treated as absent so a bogus `0` never overrides a real default.
fn model_capacity(value: &serde_json::Value, keys: &[&str]) -> Option<u64> {
    keys.iter().find_map(|key| {
        let field = value.get(*key)?;
        let count = field
            .as_u64()
            .or_else(|| field.as_str().and_then(|raw| raw.trim().parse::<u64>().ok()))?;
        (count > 0).then_some(count)
    })
}

/// Builds a `FetchedModel` from an OpenAI-style `/v1/models` entry. Plain OpenAI
/// only exposes `id`, but OpenRouter enriches each entry with a `context_length`,
/// a `top_provider` budget, and `architecture.input_modalities`, so those are
/// harvested when present to pre-fill the model's capabilities.
fn parse_openai_model_entry(entry: &serde_json::Value) -> Option<FetchedModel> {
    let id = entry.get("id").and_then(|id| id.as_str())?.to_string();
    let top_provider = entry.get("top_provider");
    let context_window = model_capacity(entry, &["context_length", "context_window"])
        .or_else(|| top_provider.and_then(|tp| model_capacity(tp, &["context_length", "context_window"])));
    let max_output_tokens = top_provider
        .and_then(|tp| model_capacity(tp, &["max_completion_tokens", "max_output_tokens"]))
        .or_else(|| model_capacity(entry, &["max_completion_tokens", "max_output_tokens"]));
    let input_types = entry
        .get("architecture")
        .and_then(|arch| arch.get("input_modalities"))
        .and_then(|modalities| modalities.as_array())
        .map(|modalities| {
            modalities
                .iter()
                .filter_map(|modality| modality.as_str())
                .map(|modality| modality.to_string())
                .collect()
        })
        .unwrap_or_default();
    Some(FetchedModel {
        id,
        context_window,
        max_output_tokens,
        input_types,
    })
}

/// Builds a `FetchedModel` from a Gemini `/v1beta/models` entry, stripping the
/// `models/` name prefix and reading the `inputTokenLimit` / `outputTokenLimit`
/// budgets Gemini advertises per model.
fn parse_gemini_model_entry(entry: &serde_json::Value) -> Option<FetchedModel> {
    let name = entry.get("name").and_then(|name| name.as_str())?;
    let id = name.strip_prefix("models/").unwrap_or(name).to_string();
    Some(FetchedModel {
        id,
        context_window: model_capacity(entry, &["inputTokenLimit"]),
        max_output_tokens: model_capacity(entry, &["outputTokenLimit"]),
        input_types: Vec::new(),
    })
}

/// Gemini lists embeddings and legacy models alongside chat models; keep only
/// those advertising `generateContent` (the dialect TableR speaks). Missing
/// metadata is treated as capable so a schema change never silently drops
/// every model.
fn supports_generate_content(entry: &serde_json::Value) -> bool {
    match entry
        .get("supportedGenerationMethods")
        .and_then(|methods| methods.as_array())
    {
        Some(methods) => methods
            .iter()
            .any(|method| method.as_str() == Some("generateContent")),
        None => true,
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

/// Injects user image attachments into an already-built request body for the
/// resolved wire shape. Strict no-op when there are no image attachments, so
/// the classic text path keeps a byte-identical body.
///
/// Only `kind == "image"` attachments become multimodal parts; text-file
/// contents are inlined into the prompt by the frontend before the request.
pub(crate) fn apply_attachments(
    body: &mut serde_json::Value,
    shape: ProviderBodyShape,
    prompt: &str,
    attachments: &[AIRequestAttachment],
) {
    let images: Vec<&AIRequestAttachment> = attachments
        .iter()
        .filter(|attachment| attachment.kind == "image" && !attachment.data.trim().is_empty())
        .collect();
    if images.is_empty() {
        return;
    }
    let Some(object) = body.as_object_mut() else {
        return;
    };

    let base64_images: Vec<String> = images.iter().map(|image| image.data.clone()).collect();
    match shape {
        ProviderBodyShape::OpenAiLike => {
            let Some(messages) = object.get_mut("messages").and_then(|v| v.as_array_mut()) else {
                return;
            };
            let Some(user_message) = messages
                .iter_mut()
                .rev()
                .find(|message| message.get("role").and_then(|v| v.as_str()) == Some("user"))
            else {
                return;
            };
            let mut parts = vec![json!({ "type": "text", "text": prompt })];
            for image in &images {
                parts.push(json!({
                    "type": "image_url",
                    "image_url": {
                        "url": format!("data:{};base64,{}", image.mime_type, image.data)
                    }
                }));
            }
            user_message["content"] = serde_json::Value::Array(parts);
        }
        ProviderBodyShape::OllamaChat => {
            let Some(messages) = object.get_mut("messages").and_then(|v| v.as_array_mut()) else {
                return;
            };
            let Some(user_message) = messages
                .iter_mut()
                .rev()
                .find(|message| message.get("role").and_then(|v| v.as_str()) == Some("user"))
            else {
                return;
            };
            user_message["images"] = json!(base64_images);
        }
        ProviderBodyShape::OllamaGenerate => {
            object.insert("images".to_string(), json!(base64_images));
        }
        ProviderBodyShape::Anthropic => {
            let Some(messages) = object.get_mut("messages").and_then(|v| v.as_array_mut()) else {
                return;
            };
            let Some(user_message) = messages
                .iter_mut()
                .rev()
                .find(|message| message.get("role").and_then(|v| v.as_str()) == Some("user"))
            else {
                return;
            };
            let mut blocks: Vec<serde_json::Value> = images
                .iter()
                .map(|image| {
                    json!({
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": image.mime_type,
                            "data": image.data
                        }
                    })
                })
                .collect();
            blocks.push(json!({ "type": "text", "text": prompt }));
            user_message["content"] = serde_json::Value::Array(blocks);
        }
        ProviderBodyShape::Gemini => {
            let Some(contents) = object.get_mut("contents").and_then(|v| v.as_array_mut()) else {
                return;
            };
            let Some(last_content) = contents.last_mut() else {
                return;
            };
            let mut parts: Vec<serde_json::Value> = images
                .iter()
                .map(|image| {
                    json!({
                        "inline_data": {
                            "mime_type": image.mime_type,
                            "data": image.data
                        }
                    })
                })
                .collect();
            parts.push(json!({ "text": prompt }));
            last_content["parts"] = serde_json::Value::Array(parts);
        }
    }
}

/// Wire role name for the OpenAI/Anthropic chat message shape.
fn chat_role(role: &AIConversationRole) -> &'static str {
    match role {
        AIConversationRole::User => "user",
        AIConversationRole::Assistant => "assistant",
    }
}

/// Wire role name for Gemini `contents` (assistant turns are `model`).
fn gemini_role(role: &AIConversationRole) -> &'static str {
    match role {
        AIConversationRole::User => "user",
        AIConversationRole::Assistant => "model",
    }
}

/// Label for the flattened `/generate` transcript fallback.
fn transcript_role(role: &AIConversationRole) -> &'static str {
    match role {
        AIConversationRole::User => "User",
        AIConversationRole::Assistant => "Assistant",
    }
}

/// Inserts `turns` into `array` right before `index`, clamped to the length.
fn splice_before(array: &mut Vec<serde_json::Value>, index: usize, turns: Vec<serde_json::Value>) {
    let index = index.min(array.len());
    array.splice(index..index, turns);
}

/// Position of the current (last) turn with `role`, before which prior history
/// is spliced. Falls back to the end when no such turn exists.
fn last_role_index(array: &[serde_json::Value], role: &str) -> usize {
    array
        .iter()
        .rposition(|message| message.get("role").and_then(|value| value.as_str()) == Some(role))
        .unwrap_or(array.len())
}

/// Replays prior conversation turns as REAL multi-turn messages in an
/// already-built request body — mirroring the `apply_attachments` /
/// `apply_native_tools` post-processor pattern so body builders and their tests
/// stay untouched.
///
/// Two wins over the old "flatten history into one string" approach:
/// 1. The model sees clean user/assistant role structure instead of a blob.
/// 2. It creates a STABLE prompt prefix (system + prior turns) that providers
///    can prompt-cache across turns. For Anthropic we tag the final history turn
///    with an ephemeral `cache_control` breakpoint, so the whole system+history
///    prefix is cached and re-read cheaply next turn (Claude Code-style prompt
///    caching). OpenAI and Gemini cache such stable prefixes implicitly.
///
/// Strict no-op when there is no history, so first turns and the classic path
/// keep a byte-identical body. History is inserted BEFORE the current user turn,
/// which stays last — so `apply_attachments` still targets the right message.
pub(crate) fn apply_conversation_history(
    body: &mut serde_json::Value,
    shape: ProviderBodyShape,
    history: &[AIConversationMessage],
) {
    if history.is_empty() {
        return;
    }
    let Some(object) = body.as_object_mut() else {
        return;
    };

    match shape {
        ProviderBodyShape::OpenAiLike | ProviderBodyShape::OllamaChat => {
            let Some(messages) = object.get_mut("messages").and_then(|v| v.as_array_mut()) else {
                return;
            };
            let insert_at = last_role_index(messages, "user");
            let turns: Vec<serde_json::Value> = history
                .iter()
                .map(|message| {
                    json!({ "role": chat_role(&message.role), "content": message.content })
                })
                .collect();
            splice_before(messages, insert_at, turns);
        }
        ProviderBodyShape::Anthropic => {
            let Some(messages) = object.get_mut("messages").and_then(|v| v.as_array_mut()) else {
                return;
            };
            let insert_at = last_role_index(messages, "user");
            let last = history.len() - 1;
            let turns: Vec<serde_json::Value> = history
                .iter()
                .enumerate()
                .map(|(index, message)| {
                    if index == last {
                        // Cache breakpoint: Anthropic caches everything from the
                        // start of the prompt up to and INCLUDING this block, so
                        // the system + full history prefix is reused next turn.
                        json!({
                            "role": chat_role(&message.role),
                            "content": [{
                                "type": "text",
                                "text": message.content,
                                "cache_control": { "type": "ephemeral" }
                            }]
                        })
                    } else {
                        json!({ "role": chat_role(&message.role), "content": message.content })
                    }
                })
                .collect();
            splice_before(messages, insert_at, turns);
        }
        ProviderBodyShape::Gemini => {
            let Some(contents) = object.get_mut("contents").and_then(|v| v.as_array_mut()) else {
                return;
            };
            let insert_at = last_role_index(contents, "user");
            let turns: Vec<serde_json::Value> = history
                .iter()
                .map(|message| {
                    json!({
                        "role": gemini_role(&message.role),
                        "parts": [{ "text": message.content }]
                    })
                })
                .collect();
            splice_before(contents, insert_at, turns);
        }
        ProviderBodyShape::OllamaGenerate => {
            // The /generate shape has no messages array — fall back to a compact
            // transcript prepended to the prompt so history still reaches the model.
            let Some(prompt) = object.get("prompt").and_then(|value| value.as_str()) else {
                return;
            };
            let transcript = history
                .iter()
                .map(|message| {
                    format!("{}: {}", transcript_role(&message.role), message.content.trim())
                })
                .collect::<Vec<_>>()
                .join("\n\n");
            let merged = format!("Recent conversation:\n{}\n\n{}", transcript, prompt);
            object.insert("prompt".to_string(), serde_json::Value::String(merged));
        }
    }
}

/// Injects native function-calling fields into an already-built request body.
///
/// This is a strict no-op when `tools` is `None`, so the classic text path
/// keeps a byte-identical body and existing behavior is untouched. OpenAI-like
/// providers and Anthropic share the top-level `tools`/`tool_choice` shape;
/// Gemini nests declarations under `tools[].functionDeclarations` and uses
/// `tool_config` for the selection hint.
pub(crate) fn apply_native_tools(
    body: &mut serde_json::Value,
    provider_type: &AIProviderType,
    tools: Option<&serde_json::Value>,
    tool_choice: Option<&serde_json::Value>,
) {
    let Some(tools) = tools else {
        return;
    };
    let Some(object) = body.as_object_mut() else {
        return;
    };

    match provider_type {
        AIProviderType::Gemini | AIProviderType::Vertex => {
            object.insert(
                "tools".to_string(),
                json!([{ "functionDeclarations": tools }]),
            );
            if let Some(choice) = tool_choice {
                object.insert("tool_config".to_string(), choice.clone());
            }
        }
        _ => {
            object.insert("tools".to_string(), tools.clone());
            if let Some(choice) = tool_choice {
                object.insert("tool_choice".to_string(), choice.clone());
            }
        }
    }
}

#[cfg(test)]
pub(crate) fn sample_provider(provider_type: AIProviderType) -> AIProviderConfig {
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
        api_format: None,
        models: Vec::new(),
        disabled_models: Vec::new(),
        model_settings: HashMap::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::super::extraction::take_visible_stream_delta;
    use super::*;

    #[test]
    fn apply_attachments_is_a_noop_without_images() {
        let mut body = json!({
            "model": "m",
            "messages": [{ "role": "user", "content": "look" }]
        });
        let before = body.clone();
        apply_attachments(&mut body, ProviderBodyShape::OpenAiLike, "look", &[]);
        assert_eq!(before, body);

        // Text attachments never become image parts.
        let text_only = AIRequestAttachment {
            kind: "text".to_string(),
            name: "notes.txt".to_string(),
            mime_type: "text/plain".to_string(),
            data: "hello".to_string(),
        };
        apply_attachments(
            &mut body,
            ProviderBodyShape::OpenAiLike,
            "look",
            &[text_only],
        );
        assert_eq!(before, body);
    }

    fn sample_image() -> AIRequestAttachment {
        AIRequestAttachment {
            kind: "image".to_string(),
            name: "shot.png".to_string(),
            mime_type: "image/png".to_string(),
            data: "AAAA".to_string(),
        }
    }

    #[test]
    fn apply_attachments_injects_openai_image_parts() {
        let mut body = json!({
            "model": "m",
            "messages": [
                { "role": "system", "content": "sys" },
                { "role": "user", "content": "look" }
            ]
        });
        apply_attachments(
            &mut body,
            ProviderBodyShape::OpenAiLike,
            "look",
            &[sample_image()],
        );
        let content = &body["messages"][1]["content"];
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[0]["text"], "look");
        assert_eq!(content[1]["type"], "image_url");
        assert_eq!(content[1]["image_url"]["url"], "data:image/png;base64,AAAA");
    }

    #[test]
    fn apply_attachments_injects_anthropic_image_blocks() {
        let mut body = json!({
            "model": "m",
            "max_tokens": 1024,
            "messages": [{ "role": "user", "content": "look" }]
        });
        apply_attachments(
            &mut body,
            ProviderBodyShape::Anthropic,
            "look",
            &[sample_image()],
        );
        let content = &body["messages"][0]["content"];
        assert_eq!(content[0]["type"], "image");
        assert_eq!(content[0]["source"]["type"], "base64");
        assert_eq!(content[0]["source"]["media_type"], "image/png");
        assert_eq!(content[0]["source"]["data"], "AAAA");
        assert_eq!(content[1]["type"], "text");
        assert_eq!(content[1]["text"], "look");
    }

    #[test]
    fn apply_attachments_injects_gemini_inline_data() {
        let mut body = json!({
            "contents": [{ "role": "user", "parts": [{ "text": "look" }] }]
        });
        apply_attachments(
            &mut body,
            ProviderBodyShape::Gemini,
            "look",
            &[sample_image()],
        );
        let parts = &body["contents"][0]["parts"];
        assert_eq!(parts[0]["inline_data"]["mime_type"], "image/png");
        assert_eq!(parts[0]["inline_data"]["data"], "AAAA");
        assert_eq!(parts[1]["text"], "look");
    }

    #[test]
    fn apply_attachments_injects_ollama_images() {
        let mut chat = json!({
            "model": "m",
            "messages": [
                { "role": "system", "content": "sys" },
                { "role": "user", "content": "look" }
            ],
            "stream": false
        });
        apply_attachments(
            &mut chat,
            ProviderBodyShape::OllamaChat,
            "look",
            &[sample_image()],
        );
        assert_eq!(chat["messages"][1]["images"], json!(["AAAA"]));

        let mut generate = json!({ "model": "m", "prompt": "look", "stream": false });
        apply_attachments(
            &mut generate,
            ProviderBodyShape::OllamaGenerate,
            "look",
            &[sample_image()],
        );
        assert_eq!(generate["images"], json!(["AAAA"]));
    }

    fn sample_history() -> Vec<AIConversationMessage> {
        vec![
            AIConversationMessage {
                role: AIConversationRole::User,
                content: "first question".to_string(),
            },
            AIConversationMessage {
                role: AIConversationRole::Assistant,
                content: "first answer".to_string(),
            },
        ]
    }

    #[test]
    fn apply_conversation_history_is_a_noop_without_history() {
        let mut body = json!({
            "model": "m",
            "messages": [
                { "role": "system", "content": "sys" },
                { "role": "user", "content": "now" }
            ]
        });
        let before = body.clone();
        apply_conversation_history(&mut body, ProviderBodyShape::OpenAiLike, &[]);
        assert_eq!(before, body);
    }

    #[test]
    fn apply_conversation_history_inserts_openai_turns_before_current_user() {
        let mut body = json!({
            "model": "m",
            "messages": [
                { "role": "system", "content": "sys" },
                { "role": "user", "content": "now" }
            ]
        });
        apply_conversation_history(&mut body, ProviderBodyShape::OpenAiLike, &sample_history());
        let messages = body["messages"].as_array().expect("messages array");
        // system, first question, first answer, current user — in order.
        assert_eq!(messages.len(), 4);
        assert_eq!(messages[0]["role"], "system");
        assert_eq!(messages[1]["role"], "user");
        assert_eq!(messages[1]["content"], "first question");
        assert_eq!(messages[2]["role"], "assistant");
        assert_eq!(messages[2]["content"], "first answer");
        assert_eq!(messages[3]["role"], "user");
        assert_eq!(messages[3]["content"], "now");
    }

    #[test]
    fn apply_conversation_history_marks_only_last_anthropic_turn_for_caching() {
        let mut body = json!({
            "model": "m",
            "max_tokens": 1024,
            "messages": [{ "role": "user", "content": "now" }]
        });
        apply_conversation_history(&mut body, ProviderBodyShape::Anthropic, &sample_history());
        let messages = body["messages"].as_array().expect("messages array");
        assert_eq!(messages.len(), 3);
        // First history turn: plain string content, no cache breakpoint.
        assert_eq!(messages[0]["role"], "user");
        assert_eq!(messages[0]["content"], "first question");
        // Last history turn carries the ephemeral cache_control breakpoint.
        assert_eq!(messages[1]["role"], "assistant");
        assert_eq!(messages[1]["content"][0]["type"], "text");
        assert_eq!(messages[1]["content"][0]["text"], "first answer");
        assert_eq!(
            messages[1]["content"][0]["cache_control"]["type"],
            "ephemeral"
        );
        // Current turn stays last and stays a plain string (the changing tail).
        assert_eq!(messages[2]["role"], "user");
        assert_eq!(messages[2]["content"], "now");
    }

    #[test]
    fn apply_conversation_history_maps_gemini_roles_before_current_turn() {
        let mut body = json!({
            "contents": [{ "role": "user", "parts": [{ "text": "now" }] }]
        });
        apply_conversation_history(&mut body, ProviderBodyShape::Gemini, &sample_history());
        let contents = body["contents"].as_array().expect("contents array");
        assert_eq!(contents.len(), 3);
        assert_eq!(contents[0]["role"], "user");
        assert_eq!(contents[0]["parts"][0]["text"], "first question");
        // Assistant turns map to Gemini's "model" role.
        assert_eq!(contents[1]["role"], "model");
        assert_eq!(contents[1]["parts"][0]["text"], "first answer");
        assert_eq!(contents[2]["role"], "user");
        assert_eq!(contents[2]["parts"][0]["text"], "now");
    }

    #[test]
    fn apply_conversation_history_flattens_into_ollama_generate_prompt() {
        let mut body = json!({
            "model": "m",
            "system": "sys",
            "prompt": "Current user request:\nnow"
        });
        apply_conversation_history(&mut body, ProviderBodyShape::OllamaGenerate, &sample_history());
        let prompt = body["prompt"].as_str().expect("prompt string");
        assert!(prompt.starts_with("Recent conversation:\n"));
        assert!(prompt.contains("User: first question"));
        assert!(prompt.contains("Assistant: first answer"));
        assert!(prompt.ends_with("Current user request:\nnow"));
    }

    #[test]
    fn apply_native_tools_is_a_noop_when_tools_absent() {
        let provider = sample_provider(AIProviderType::OpenAI);
        let endpoint = super::super::endpoints::resolve_provider_endpoint(&provider);
        let before = build_provider_request_body(
            &provider,
            &endpoint,
            "system",
            "prompt",
            &AIRequestMode::Panel,
        );
        let mut after = before.clone();
        apply_native_tools(&mut after, &provider.provider_type, None, None);
        // No tools => byte-identical body, so the classic text path is untouched.
        assert_eq!(before, after);
        assert!(after.get("tools").is_none());
        assert!(after.get("tool_choice").is_none());
    }

    #[test]
    fn explicit_ollama_formats_skip_openai_path_append() {
        let mut provider = sample_provider(AIProviderType::Custom);
        provider.endpoint = "http://10.0.0.5:11434/api/chat".to_string();
        provider.api_format = Some("ollama-chat".to_string());
        assert_eq!(
            super::super::endpoints::resolve_provider_endpoint(&provider),
            "http://10.0.0.5:11434/api/chat"
        );

        // Empty endpoint falls back to the local Ollama default for the format.
        provider.api_format = Some("ollama-generate".to_string());
        provider.endpoint = String::new();
        assert_eq!(
            super::super::endpoints::resolve_provider_endpoint(&provider),
            "http://localhost:11434/api/generate"
        );

        // Auto (None) keeps the legacy behavior: bare host gets /chat/completions.
        provider.api_format = None;
        provider.endpoint = "http://10.0.0.5:11434".to_string();
        assert_eq!(
            super::super::endpoints::resolve_provider_endpoint(&provider),
            "http://10.0.0.5:11434/chat/completions"
        );
    }

    #[test]
    fn explicit_api_format_controls_request_body_shape() {
        let mut provider = sample_provider(AIProviderType::Custom);
        provider.endpoint = "http://10.0.0.5:11434/api/chat".to_string();

        provider.api_format = Some("ollama-chat".to_string());
        let body = build_provider_request_body(
            &provider,
            &provider.endpoint,
            "sys",
            "usr",
            &AIRequestMode::Panel,
        );
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["stream"], json!(false));

        provider.api_format = Some("ollama-generate".to_string());
        let body = build_provider_request_body(
            &provider,
            &provider.endpoint,
            "sys",
            "usr",
            &AIRequestMode::Panel,
        );
        assert_eq!(body["system"], "sys");
        assert_eq!(body["prompt"], "usr");
        assert!(body.get("messages").is_none());

        // Chat completions wins even on an Ollama-style URL.
        provider.api_format = Some("chat-completions".to_string());
        let body = build_provider_request_body(
            &provider,
            &provider.endpoint,
            "sys",
            "usr",
            &AIRequestMode::Panel,
        );
        assert!(body.get("messages").is_some());
        assert!(body.get("prompt").is_none());
    }

    #[test]
    fn explicit_anthropic_format_uses_anthropic_wire_shape() {
        let mut provider = sample_provider(AIProviderType::Custom);
        provider.endpoint = "https://proxy.example.com/v1/messages".to_string();
        provider.api_format = Some("anthropic".to_string());

        // Wire identity + body shape follow the Anthropic contract.
        assert_eq!(
            super::super::endpoints::resolve_provider_endpoint(&provider),
            "https://proxy.example.com/v1/messages"
        );
        assert_eq!(
            effective_wire_provider(&provider, &provider.endpoint),
            AIProviderType::Anthropic
        );
        let body = build_provider_request_body(
            &provider,
            &provider.endpoint,
            "sys",
            "usr",
            &AIRequestMode::Panel,
        );
        assert_eq!(body["system"], "sys");
        assert_eq!(body["messages"][0]["role"], "user");
        assert!(body.get("prompt").is_none());

        // Streaming stays on the Anthropic contract: `stream` flips on but the
        // OpenAI-only `stream_options` key must not appear.
        let stream_body = streaming_request_body(
            &provider,
            &provider.endpoint,
            "sys",
            "usr",
            &AIRequestMode::Panel,
        );
        assert_eq!(stream_body["stream"], json!(true));
        assert!(stream_body.get("stream_options").is_none());
    }

    #[test]
    fn explicit_anthropic_format_resolves_base_urls_like_native_anthropic() {
        let mut provider = sample_provider(AIProviderType::Custom);
        provider.api_format = Some("anthropic".to_string());

        // Blank endpoint defaults to the real Anthropic API.
        assert_eq!(
            super::super::endpoints::resolve_provider_endpoint(&provider),
            "https://api.anthropic.com/v1/messages"
        );

        // Unwired base URLs get `/messages` appended, like the native provider.
        provider.endpoint = "https://proxy.example.com/v1".to_string();
        assert_eq!(
            super::super::endpoints::resolve_provider_endpoint(&provider),
            "https://proxy.example.com/v1/messages"
        );

        // Fully wired URLs are kept as-is (proxies may rewrite the path).
        provider.endpoint = "https://proxy.example.com/my-gateway".to_string();
        assert_eq!(
            super::super::endpoints::resolve_provider_endpoint(&provider),
            "https://proxy.example.com/my-gateway"
        );
    }

    #[test]
    fn apply_native_tools_injects_openai_shape() {
        let mut body = json!({ "model": "m", "messages": [] });
        let tools = json!([{ "type": "function", "function": { "name": "finish" } }]);
        let choice = json!("auto");
        apply_native_tools(
            &mut body,
            &AIProviderType::OpenAI,
            Some(&tools),
            Some(&choice),
        );
        assert_eq!(body["tools"], tools);
        assert_eq!(body["tool_choice"], json!("auto"));
    }

    #[test]
    fn apply_native_tools_nests_gemini_declarations_and_tool_config() {
        let mut body = json!({ "contents": [] });
        let tools = json!([{ "name": "finish", "parameters": {} }]);
        let choice = json!({ "function_calling_config": { "mode": "AUTO" } });
        apply_native_tools(
            &mut body,
            &AIProviderType::Gemini,
            Some(&tools),
            Some(&choice),
        );
        assert_eq!(body["tools"], json!([{ "functionDeclarations": tools }]));
        assert_eq!(body["tool_config"], choice);
        // Gemini must not receive the OpenAI-style top-level tool_choice key.
        assert!(body.get("tool_choice").is_none());
    }

    #[test]
    fn vertex_reuses_gemini_body_shape_stream_and_tool_nesting() {
        let mut vertex = sample_provider(AIProviderType::Vertex);
        // Vertex resolves the pasted endpoint verbatim; give it a full URL.
        vertex.endpoint =
            "https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/publishers/google/models/gemini-2.0-flash:generateContent"
                .to_string();
        let endpoint = super::super::endpoints::resolve_provider_endpoint(&vertex);
        assert_eq!(
            resolve_provider_body_shape(&vertex, &endpoint),
            ProviderBodyShape::Gemini
        );

        let body = build_provider_request_body(
            &vertex,
            &endpoint,
            "system prompt",
            "user prompt",
            &AIRequestMode::Panel,
        );
        assert_eq!(body["systemInstruction"]["parts"][0]["text"], "system prompt");
        assert_eq!(body["contents"][0]["role"], "user");
        assert_eq!(body["contents"][0]["parts"][0]["text"], "user prompt");

        // Streaming must not carry the OpenAI-style stream flag and must switch
        // to streamGenerateContent + alt=sse (same as Gemini).
        let stream_body = streaming_request_body(
            &vertex,
            &endpoint,
            "system prompt",
            "user prompt",
            &AIRequestMode::Panel,
        );
        assert!(stream_body.get("stream").is_none());
        let streaming = streaming_endpoint(&vertex, &endpoint);
        assert!(streaming.contains(":streamGenerateContent"));
        assert!(streaming.contains("alt=sse"));

        let mut tool_body = json!({ "contents": [] });
        let tools = json!([{ "name": "finish", "parameters": {} }]);
        let choice = json!({ "function_calling_config": { "mode": "AUTO" } });
        apply_native_tools(
            &mut tool_body,
            &AIProviderType::Vertex,
            Some(&tools),
            Some(&choice),
        );
        assert_eq!(tool_body["tools"], json!([{ "functionDeclarations": tools }]));
        assert_eq!(tool_body["tool_config"], choice);
        assert!(tool_body.get("tool_choice").is_none());
    }

    #[test]
    fn streaming_body_is_enabled_and_think_chunks_stay_private() {
        let provider = sample_provider(AIProviderType::OpenAI);
        let endpoint = super::super::endpoints::resolve_provider_endpoint(&provider);
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
            take_visible_stream_delta("\u{3c}thi", &mut pending, &mut visible),
            ""
        );
        assert_eq!(
            take_visible_stream_delta(
                "nk>private scratch\u{3c}/think\u{3e}Hello",
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
    fn nvidia_enables_thinking_for_reasoning_models_in_panel() {
        let mut provider = sample_provider(AIProviderType::OpenAI);
        provider.model = "deepseek-ai/deepseek-r1".to_string();
        let body = build_provider_request_body(
            &provider,
            "https://integrate.api.nvidia.com/v1/chat/completions",
            "system prompt",
            "user prompt",
            &AIRequestMode::Panel,
        );
        assert_eq!(
            body.pointer("/chat_template_kwargs/enable_thinking")
                .and_then(|value| value.as_bool()),
            Some(true)
        );
    }

    #[test]
    fn nvidia_keeps_thinking_off_inline_and_for_plain_models() {
        // Terse inline completion never wants a reasoning preamble...
        let mut reasoning = sample_provider(AIProviderType::OpenAI);
        reasoning.model = "deepseek-ai/deepseek-r1".to_string();
        let inline = build_provider_request_body(
            &reasoning,
            "https://integrate.api.nvidia.com/v1/chat/completions",
            "system prompt",
            "user prompt",
            &AIRequestMode::Inline,
        );
        assert_eq!(
            inline
                .pointer("/chat_template_kwargs/enable_thinking")
                .and_then(|value| value.as_bool()),
            Some(false)
        );

        // ...and a non-reasoning model stays off even in the panel.
        let plain = sample_provider(AIProviderType::OpenAI);
        let body = build_provider_request_body(
            &plain,
            "https://integrate.api.nvidia.com/v1/chat/completions",
            "system prompt",
            "user prompt",
            &AIRequestMode::Panel,
        );
        assert_eq!(
            body.pointer("/chat_template_kwargs/enable_thinking")
                .and_then(|value| value.as_bool()),
            Some(false)
        );
    }

    #[test]
    fn anthropic_enables_extended_thinking_for_capable_models_in_panel() {
        let mut provider = sample_provider(AIProviderType::Anthropic);
        provider.model = "claude-3-7-sonnet-20250219".to_string();
        let body = build_provider_request_body(
            &provider,
            &super::super::endpoints::resolve_provider_endpoint(&provider),
            "system prompt",
            "user prompt",
            &AIRequestMode::Panel,
        );
        assert_eq!(
            body.pointer("/thinking/type").and_then(|value| value.as_str()),
            Some("enabled")
        );
        let budget = body
            .pointer("/thinking/budget_tokens")
            .and_then(|value| value.as_u64())
            .expect("budget_tokens must be set");
        let max_tokens = body
            .get("max_tokens")
            .and_then(|value| value.as_u64())
            .expect("max_tokens must be set");
        // Anthropic requires budget >= 1024 and max_tokens strictly greater.
        assert!(budget >= 1024);
        assert!(max_tokens > budget);
    }

    #[test]
    fn anthropic_omits_thinking_for_legacy_models() {
        let mut provider = sample_provider(AIProviderType::Anthropic);
        provider.model = "claude-3-5-sonnet-20241022".to_string();
        let body = build_provider_request_body(
            &provider,
            &super::super::endpoints::resolve_provider_endpoint(&provider),
            "system prompt",
            "user prompt",
            &AIRequestMode::Panel,
        );
        assert!(body.get("thinking").is_none());
        assert_eq!(
            body.get("max_tokens").and_then(|value| value.as_u64()),
            Some(4096)
        );
    }

    #[test]
    fn gemini_requests_thought_summaries_for_2_5_models_in_panel() {
        let mut provider = sample_provider(AIProviderType::Gemini);
        provider.model = "gemini-2.5-pro".to_string();
        let body = build_provider_request_body(
            &provider,
            &super::super::endpoints::resolve_provider_endpoint(&provider),
            "system prompt",
            "user prompt",
            &AIRequestMode::Panel,
        );
        assert_eq!(
            body.pointer("/generationConfig/thinkingConfig/includeThoughts")
                .and_then(|value| value.as_bool()),
            Some(true)
        );
    }

    #[test]
    fn gemini_omits_thinking_config_for_legacy_models() {
        let mut provider = sample_provider(AIProviderType::Gemini);
        provider.model = "gemini-1.5-pro".to_string();
        let body = build_provider_request_body(
            &provider,
            &super::super::endpoints::resolve_provider_endpoint(&provider),
            "system prompt",
            "user prompt",
            &AIRequestMode::Panel,
        );
        assert!(body.get("generationConfig").is_none());
    }

    #[test]
    fn user_thinking_toggle_off_forces_thinking_off_everywhere() {
        // NVIDIA reasoning model: the user's OFF flag beats capability gating.
        let mut nvidia = sample_provider(AIProviderType::OpenAI);
        nvidia.model = "deepseek-ai/deepseek-r1".to_string();
        let nvidia_body = build_provider_request_body_with_thinking(
            &nvidia,
            "https://integrate.api.nvidia.com/v1/chat/completions",
            "system prompt",
            "user prompt",
            &AIRequestMode::Panel,
            Some(false),
        );
        assert_eq!(
            nvidia_body
                .pointer("/chat_template_kwargs/enable_thinking")
                .and_then(|value| value.as_bool()),
            Some(false)
        );

        // Anthropic capable model: no `thinking` block and max_tokens untouched.
        let mut anthropic = sample_provider(AIProviderType::Anthropic);
        anthropic.model = "claude-3-7-sonnet-20250219".to_string();
        let anthropic_body = build_provider_request_body_with_thinking(
            &anthropic,
            &super::super::endpoints::resolve_provider_endpoint(&anthropic),
            "system prompt",
            "user prompt",
            &AIRequestMode::Panel,
            Some(false),
        );
        assert!(anthropic_body.get("thinking").is_none());
        assert_eq!(
            anthropic_body.get("max_tokens").and_then(|value| value.as_u64()),
            Some(4096)
        );

        // Gemini 2.5: no thinkingConfig requested.
        let mut gemini = sample_provider(AIProviderType::Gemini);
        gemini.model = "gemini-2.5-pro".to_string();
        let gemini_body = build_provider_request_body_with_thinking(
            &gemini,
            &super::super::endpoints::resolve_provider_endpoint(&gemini),
            "system prompt",
            "user prompt",
            &AIRequestMode::Panel,
            Some(false),
        );
        assert!(gemini_body.get("generationConfig").is_none());
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
    fn provider_request_bodies_match_supported_api_contracts() {
        let anthropic = sample_provider(AIProviderType::Anthropic);
        let anthropic_body = build_provider_request_body(
            &anthropic,
            &super::super::endpoints::resolve_provider_endpoint(&anthropic),
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
            &super::super::endpoints::resolve_provider_endpoint(&gemini),
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
            &super::super::endpoints::resolve_provider_endpoint(&ollama),
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
    fn parses_models_list_responses_per_shape() {
        fn ids(models: &[FetchedModel]) -> Vec<String> {
            models.iter().map(|model| model.id.clone()).collect()
        }

        // OpenAI / OpenRouter / Anthropic all use { data: [ { id } ] }, and a
        // repeated id is collapsed while original order is kept. OpenRouter also
        // enriches entries with a context budget, output cap, and input
        // modalities, which are surfaced for auto-fill.
        let openai = json!({
            "data": [
                {
                    "id": "gpt-4o",
                    "context_length": 128000,
                    "top_provider": { "max_completion_tokens": 16384 },
                    "architecture": { "input_modalities": ["text", "image"] }
                },
                { "id": "gpt-4o-mini" },
                { "id": "gpt-4o" }
            ]
        });
        let parsed = parse_models_list_response(ModelsListShape::OpenAiData, &openai);
        assert_eq!(ids(&parsed), vec!["gpt-4o".to_string(), "gpt-4o-mini".to_string()]);
        assert_eq!(parsed[0].context_window, Some(128_000));
        assert_eq!(parsed[0].max_output_tokens, Some(16_384));
        assert_eq!(
            parsed[0].input_types,
            vec!["text".to_string(), "image".to_string()]
        );
        // An entry without metadata leaves every capability unset so the
        // frontend keeps its defaults.
        assert_eq!(parsed[1].context_window, None);
        assert_eq!(parsed[1].max_output_tokens, None);
        assert!(parsed[1].input_types.is_empty());

        let ollama = json!({
            "models": [
                { "name": "llama3:latest" },
                { "name": "qwen2.5-coder:7b" }
            ]
        });
        let parsed_ollama = parse_models_list_response(ModelsListShape::OllamaTags, &ollama);
        assert_eq!(
            ids(&parsed_ollama),
            vec!["llama3:latest".to_string(), "qwen2.5-coder:7b".to_string()]
        );
        // The Ollama tag list exposes no capacity metadata.
        assert!(parsed_ollama.iter().all(|model| model.context_window.is_none()));

        // Gemini strips the `models/` prefix and drops entries that cannot
        // generate content, but keeps entries missing the capability metadata.
        // Token limits map to the context window + output budget.
        let gemini = json!({
            "models": [
                {
                    "name": "models/gemini-2.0-flash",
                    "supportedGenerationMethods": ["generateContent"],
                    "inputTokenLimit": 1048576,
                    "outputTokenLimit": 8192
                },
                { "name": "models/embedding-001", "supportedGenerationMethods": ["embedContent"] },
                { "name": "models/gemini-1.5-pro" }
            ]
        });
        let parsed_gemini = parse_models_list_response(ModelsListShape::GeminiModels, &gemini);
        assert_eq!(
            ids(&parsed_gemini),
            vec!["gemini-2.0-flash".to_string(), "gemini-1.5-pro".to_string()]
        );
        assert_eq!(parsed_gemini[0].context_window, Some(1_048_576));
        assert_eq!(parsed_gemini[0].max_output_tokens, Some(8_192));
        assert_eq!(parsed_gemini[1].context_window, None);

        // A malformed / empty envelope yields no models rather than panicking.
        assert!(parse_models_list_response(ModelsListShape::OpenAiData, &json!({})).is_empty());
    }
}
