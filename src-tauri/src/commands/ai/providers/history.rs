use super::ProviderBodyShape;
#[cfg(test)]
use crate::database::ai_models::AIProviderConfig;
use crate::database::ai_models::{
    AIConversationMessage, AIConversationRole, AIProviderType, AIRequestAttachment,
};
use serde_json::json;
#[cfg(test)]
use std::collections::HashMap;

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
                    format!(
                        "{}: {}",
                        transcript_role(&message.role),
                        message.content.trim()
                    )
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
/// Context Editing (beta `context-management-2025-06-27`) configuration for
/// Anthropic tool/agent requests. Once the prompt crosses the trigger, the
/// server clears all but the most recent tool_use/tool_result pairs *server
/// side* — the transcript we send is unchanged, but the model processes far
/// fewer tokens and the cached prefix is preserved. Emitted only when tools are
/// present (see `apply_native_tools`), so plain completion bodies stay identical.
pub(crate) fn anthropic_context_management() -> serde_json::Value {
    json!({
        "edits": [
            {
                "type": "clear_tool_uses_20250919",
                "trigger": {
                    "type": "input_tokens",
                    "value": crate::config::ANTHROPIC_CONTEXT_CLEAR_TRIGGER_TOKENS
                },
                "keep": {
                    "type": "tool_uses",
                    "value": crate::config::ANTHROPIC_CONTEXT_KEEP_TOOL_USES
                },
                "clear_at_least": {
                    "type": "input_tokens",
                    "value": crate::config::ANTHROPIC_CONTEXT_CLEAR_AT_LEAST_TOKENS
                },
                "clear_tool_inputs": false
            }
        ]
    })
}

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
        AIProviderType::Anthropic => {
            object.insert("tools".to_string(), tools.clone());
            if let Some(choice) = tool_choice {
                object.insert("tool_choice".to_string(), choice.clone());
            }
            // Context Editing beta: let the server prune stale tool_use/result
            // pairs on long agent runs (paired with the `anthropic-beta:
            // context-management-2025-06-27` header set at the Anthropic send
            // sites in execution.rs). Only reached when tools are present.
            object.insert(
                "context_management".to_string(),
                anthropic_context_management(),
            );
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
        fast_model: None,
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
