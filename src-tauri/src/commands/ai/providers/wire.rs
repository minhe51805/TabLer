use super::{
    anthropic_context_management, apply_attachments, apply_conversation_history,
    apply_native_tools, build_provider_request_body_with_thinking, default_max_output_tokens,
    effective_wire_provider, resolve_provider_body_shape, streaming_endpoint,
    streaming_request_body_with_thinking, ProviderBodyShape,
};
use crate::commands::ai::endpoints::{resolve_provider_endpoint, validate_ai_endpoint};
use crate::commands::ai::prompt::build_ai_prompt;
use crate::database::ai_models::{
    AIProviderConfig, AIProviderType, AIRequest, CanonicalAgentTurn, CanonicalToolSpec,
};
use crate::error::{AppError, ErrorCode};
use serde_json::json;

/// Prepared wire payload shared identically by `ask_ai` and `ask_ai_stream`.
#[derive(Debug, Clone)]
pub(crate) struct PreparedProviderWireRequest {
    pub endpoint: String,
    pub wire_provider: AIProviderType,
    #[allow(dead_code)]
    pub body_shape: ProviderBodyShape,
    pub body: serde_json::Value,
    pub used_canonical_tools: bool,
}

/// True when the wire dialect accepts native function-calling `tools`.
/// `OllamaGenerate` (`/api/generate`) is a raw completion endpoint with no
/// `tools` or `messages` support, so it falls back to text-action mode.
pub(crate) fn shape_supports_native_tools(shape: ProviderBodyShape) -> bool {
    !matches!(shape, ProviderBodyShape::OllamaGenerate)
}

/// Normalizes a JSON Schema object into Gemini's strict `Schema` proto shape
/// (uppercase `type` enum names; unknown keys like `additionalProperties`,
/// `uniqueItems`, and `$schema` stripped so Gemini/Vertex never 400).
pub(crate) fn to_gemini_schema(schema: &serde_json::Value) -> serde_json::Value {
    let Some(obj) = schema.as_object() else {
        return json!({});
    };
    let mut out = serde_json::Map::new();

    if let Some(raw_type) = obj.get("type").and_then(|v| v.as_str()) {
        out.insert(
            "type".to_string(),
            serde_json::Value::String(raw_type.to_ascii_uppercase()),
        );
    }
    if let Some(desc) = obj.get("description").and_then(|v| v.as_str()) {
        out.insert(
            "description".to_string(),
            serde_json::Value::String(desc.to_string()),
        );
    }
    if let Some(enum_vals) = obj.get("enum").and_then(|v| v.as_array()) {
        out.insert(
            "enum".to_string(),
            serde_json::Value::Array(enum_vals.clone()),
        );
    }
    for numeric_key in ["minimum", "maximum", "minItems", "maxItems"] {
        if let Some(val) = obj.get(numeric_key).filter(|v| v.is_number()) {
            out.insert(numeric_key.to_string(), val.clone());
        }
    }
    if let Some(items) = obj.get("items") {
        out.insert("items".to_string(), to_gemini_schema(items));
    }
    if let Some(props) = obj.get("properties").and_then(|v| v.as_object()) {
        let mut mapped_props = serde_json::Map::new();
        for (key, prop_schema) in props {
            mapped_props.insert(key.clone(), to_gemini_schema(prop_schema));
        }
        out.insert(
            "properties".to_string(),
            serde_json::Value::Object(mapped_props),
        );
    }
    if let Some(required) = obj
        .get("required")
        .and_then(|v| v.as_array())
        .filter(|arr| !arr.is_empty())
    {
        out.insert(
            "required".to_string(),
            serde_json::Value::Array(required.clone()),
        );
    }

    serde_json::Value::Object(out)
}

/// Translates provider-agnostic `CanonicalToolSpec[]` into the resolved wire dialect.
pub(crate) fn apply_canonical_tools(
    body: &mut serde_json::Value,
    shape: ProviderBodyShape,
    specs: &[CanonicalToolSpec],
    allow_native_memory_tool: bool,
    tool_choice_override: Option<&serde_json::Value>,
) {
    if specs.is_empty() || !shape_supports_native_tools(shape) {
        return;
    }
    let Some(object) = body.as_object_mut() else {
        return;
    };

    match shape {
        ProviderBodyShape::OpenAiLike => {
            let tools: Vec<serde_json::Value> = specs
                .iter()
                .map(|spec| {
                    json!({
                        "type": "function",
                        "function": {
                            "name": spec.name,
                            "description": spec.description,
                            "parameters": spec.parameters,
                        }
                    })
                })
                .collect();
            object.insert("tools".to_string(), serde_json::Value::Array(tools));
            object.insert(
                "tool_choice".to_string(),
                tool_choice_override
                    .cloned()
                    .unwrap_or_else(|| json!("auto")),
            );
        }
        ProviderBodyShape::OllamaChat => {
            let tools: Vec<serde_json::Value> = specs
                .iter()
                .map(|spec| {
                    json!({
                        "type": "function",
                        "function": {
                            "name": spec.name,
                            "description": spec.description,
                            "parameters": spec.parameters,
                        }
                    })
                })
                .collect();
            object.insert("tools".to_string(), serde_json::Value::Array(tools));
            if let Some(choice) = tool_choice_override {
                object.insert("tool_choice".to_string(), choice.clone());
            }
        }
        ProviderBodyShape::Anthropic => {
            let mut tools: Vec<serde_json::Value> = specs
                .iter()
                .map(|spec| {
                    json!({
                        "name": spec.name,
                        "description": spec.description,
                        "input_schema": spec.parameters,
                    })
                })
                .collect();
            if allow_native_memory_tool {
                tools.push(json!({
                    "type": "memory_20250818",
                    "name": "memory",
                }));
            }
            object.insert("tools".to_string(), serde_json::Value::Array(tools));
            object.insert(
                "tool_choice".to_string(),
                tool_choice_override
                    .cloned()
                    .unwrap_or_else(|| json!({ "type": "auto" })),
            );
            object.insert(
                "context_management".to_string(),
                anthropic_context_management(),
            );
        }
        ProviderBodyShape::Gemini => {
            let declarations: Vec<serde_json::Value> = specs
                .iter()
                .map(|spec| {
                    json!({
                        "name": spec.name,
                        "description": spec.description,
                        "parameters": to_gemini_schema(&spec.parameters),
                    })
                })
                .collect();
            object.insert(
                "tools".to_string(),
                json!([{ "functionDeclarations": declarations }]),
            );
            object.insert(
                "tool_config".to_string(),
                tool_choice_override
                    .cloned()
                    .unwrap_or_else(|| json!({ "function_calling_config": { "mode": "AUTO" } })),
            );
        }
        ProviderBodyShape::OllamaGenerate => {}
    }
}

fn push_or_merge_anthropic_turn(
    messages: &mut Vec<serde_json::Value>,
    role: &str,
    mut blocks: Vec<serde_json::Value>,
) {
    if blocks.is_empty() {
        return;
    }
    if let Some(last) = messages.last_mut() {
        if last.get("role").and_then(|v| v.as_str()) == Some(role) {
            let mut merged_blocks = match last.get("content") {
                Some(serde_json::Value::Array(existing)) => existing.clone(),
                Some(serde_json::Value::String(text)) => {
                    if text.is_empty() {
                        Vec::new()
                    } else {
                        vec![json!({ "type": "text", "text": text })]
                    }
                }
                _ => Vec::new(),
            };
            merged_blocks.append(&mut blocks);
            last["content"] = serde_json::Value::Array(merged_blocks);
            return;
        }
    }
    messages.push(json!({
        "role": role,
        "content": blocks,
    }));
}

fn push_or_merge_gemini_turn(
    contents: &mut Vec<serde_json::Value>,
    role: &str,
    mut parts: Vec<serde_json::Value>,
) {
    if parts.is_empty() {
        return;
    }
    if let Some(last) = contents.last_mut() {
        if last.get("role").and_then(|v| v.as_str()) == Some(role) {
            if let Some(existing) = last.get_mut("parts").and_then(|v| v.as_array_mut()) {
                existing.append(&mut parts);
                return;
            }
        }
    }
    contents.push(json!({
        "role": role,
        "parts": parts,
    }));
}

/// Appends structured `CanonicalAgentTurn` steps after the initial prompt turn,
/// translating tool calls, tool results, and thinking signatures into the target
/// provider's wire format (including mid-run cross-provider failover).
pub(crate) fn apply_agent_turns(
    body: &mut serde_json::Value,
    shape: ProviderBodyShape,
    mode: &crate::database::ai_models::AIRequestMode,
    turns: &[CanonicalAgentTurn],
) {
    if turns.is_empty() {
        return;
    }
    let Some(object) = body.as_object_mut() else {
        return;
    };

    match shape {
        ProviderBodyShape::OpenAiLike => {
            let Some(messages) = object.get_mut("messages").and_then(|v| v.as_array_mut()) else {
                return;
            };
            for turn in turns {
                match turn {
                    CanonicalAgentTurn::User { content } => {
                        messages.push(json!({ "role": "user", "content": content }));
                    }
                    CanonicalAgentTurn::Assistant {
                        text, tool_calls, ..
                    } => {
                        if tool_calls.is_empty() {
                            messages.push(json!({ "role": "assistant", "content": text }));
                        } else {
                            let content_val = if text.is_empty() {
                                serde_json::Value::Null
                            } else {
                                serde_json::Value::String(text.clone())
                            };
                            let wire_calls: Vec<serde_json::Value> = tool_calls
                                .iter()
                                .map(|call| {
                                    json!({
                                        "id": call.id,
                                        "type": "function",
                                        "function": {
                                            "name": call.name,
                                            "arguments": serde_json::to_string(&call.arguments)
                                                .unwrap_or_else(|_| "{}".to_string()),
                                        }
                                    })
                                })
                                .collect();
                            messages.push(json!({
                                "role": "assistant",
                                "content": content_val,
                                "tool_calls": wire_calls,
                            }));
                        }
                    }
                    CanonicalAgentTurn::ToolResult {
                        call_id, content, ..
                    } => {
                        messages.push(json!({
                            "role": "tool",
                            "tool_call_id": call_id,
                            "content": content,
                        }));
                    }
                }
            }
        }
        ProviderBodyShape::OllamaChat => {
            let Some(messages) = object.get_mut("messages").and_then(|v| v.as_array_mut()) else {
                return;
            };
            for turn in turns {
                match turn {
                    CanonicalAgentTurn::User { content } => {
                        messages.push(json!({ "role": "user", "content": content }));
                    }
                    CanonicalAgentTurn::Assistant {
                        text, tool_calls, ..
                    } => {
                        if tool_calls.is_empty() {
                            messages.push(json!({ "role": "assistant", "content": text }));
                        } else {
                            let wire_calls: Vec<serde_json::Value> = tool_calls
                                .iter()
                                .map(|call| {
                                    json!({
                                        "function": {
                                            "name": call.name,
                                            "arguments": call.arguments,
                                        }
                                    })
                                })
                                .collect();
                            messages.push(json!({
                                "role": "assistant",
                                "content": text,
                                "tool_calls": wire_calls,
                            }));
                        }
                    }
                    CanonicalAgentTurn::ToolResult {
                        tool_name, content, ..
                    } => {
                        messages.push(json!({
                            "role": "tool",
                            "name": tool_name,
                            "content": content,
                        }));
                    }
                }
            }
        }
        ProviderBodyShape::Anthropic => {
            // Anthropic requires every assistant turn with `tool_use` to start with a
            // cryptographically signed `thinking` block when `thinking` is enabled on
            // the request. On cross-provider failover (e.g. OpenAI -> Anthropic),
            // earlier assistant turns lack an Anthropic signature, so disable thinking
            // on this request automatically rather than triggering a 400.
            let missing_signed_thinking = turns.iter().any(|turn| match turn {
                CanonicalAgentTurn::Assistant {
                    reasoning,
                    thought_signature,
                    tool_calls,
                    ..
                } if !tool_calls.is_empty() => {
                    reasoning.as_deref().unwrap_or("").is_empty()
                        || thought_signature.as_deref().unwrap_or("").is_empty()
                }
                _ => false,
            });
            if object.contains_key("thinking") && missing_signed_thinking {
                object.remove("thinking");
                object.insert(
                    "max_tokens".to_string(),
                    json!(default_max_output_tokens(mode)),
                );
            }
            let include_thinking_blocks = object.contains_key("thinking");

            let Some(messages) = object.get_mut("messages").and_then(|v| v.as_array_mut()) else {
                return;
            };
            for turn in turns {
                match turn {
                    CanonicalAgentTurn::User { content } => {
                        push_or_merge_anthropic_turn(
                            messages,
                            "user",
                            vec![json!({ "type": "text", "text": content })],
                        );
                    }
                    CanonicalAgentTurn::Assistant {
                        text,
                        reasoning,
                        thought_signature,
                        tool_calls,
                    } => {
                        let mut blocks = Vec::new();
                        if include_thinking_blocks {
                            if let (Some(thought), Some(sig)) = (
                                reasoning.as_deref().filter(|s| !s.is_empty()),
                                thought_signature.as_deref().filter(|s| !s.is_empty()),
                            ) {
                                blocks.push(json!({
                                    "type": "thinking",
                                    "thinking": thought,
                                    "signature": sig,
                                }));
                            }
                        }
                        if !text.trim().is_empty() {
                            blocks.push(json!({ "type": "text", "text": text }));
                        }
                        for call in tool_calls {
                            blocks.push(json!({
                                "type": "tool_use",
                                "id": call.id,
                                "name": call.name,
                                "input": call.arguments,
                            }));
                        }
                        if blocks.is_empty() {
                            blocks.push(json!({ "type": "text", "text": "" }));
                        }
                        push_or_merge_anthropic_turn(messages, "assistant", blocks);
                    }
                    CanonicalAgentTurn::ToolResult {
                        call_id,
                        content,
                        is_error,
                        ..
                    } => {
                        push_or_merge_anthropic_turn(
                            messages,
                            "user",
                            vec![json!({
                                "type": "tool_result",
                                "tool_use_id": call_id,
                                "content": content,
                                "is_error": is_error,
                            })],
                        );
                    }
                }
            }

            // Place an ephemeral prompt-cache breakpoint on the final content block so
            // Claude caches the growing multi-turn prefix across agent steps.
            if let Some(last_msg) = messages.last_mut() {
                if let Some(blocks) = last_msg.get_mut("content").and_then(|v| v.as_array_mut()) {
                    if let Some(last_block) = blocks.last_mut().and_then(|v| v.as_object_mut()) {
                        last_block
                            .insert("cache_control".to_string(), json!({ "type": "ephemeral" }));
                    }
                }
            }
        }
        ProviderBodyShape::Gemini => {
            let Some(contents) = object.get_mut("contents").and_then(|v| v.as_array_mut()) else {
                return;
            };
            for turn in turns {
                match turn {
                    CanonicalAgentTurn::User { content } => {
                        push_or_merge_gemini_turn(
                            contents,
                            "user",
                            vec![json!({ "text": content })],
                        );
                    }
                    CanonicalAgentTurn::Assistant {
                        text,
                        thought_signature,
                        tool_calls,
                        ..
                    } => {
                        let mut parts = Vec::new();
                        if !text.trim().is_empty() {
                            parts.push(json!({ "text": text }));
                        }
                        for (index, call) in tool_calls.iter().enumerate() {
                            let mut part = json!({
                                "functionCall": {
                                    "name": call.name,
                                    "args": call.arguments,
                                }
                            });
                            if index == 0 {
                                if let Some(sig) =
                                    thought_signature.as_deref().filter(|s| !s.is_empty())
                                {
                                    part["thoughtSignature"] = json!(sig);
                                }
                            }
                            parts.push(part);
                        }
                        if parts.is_empty() {
                            parts.push(json!({ "text": "" }));
                        }
                        push_or_merge_gemini_turn(contents, "model", parts);
                    }
                    CanonicalAgentTurn::ToolResult {
                        tool_name,
                        content,
                        is_error,
                        ..
                    } => {
                        push_or_merge_gemini_turn(
                            contents,
                            "user",
                            vec![json!({
                                "functionResponse": {
                                    "name": tool_name,
                                    "response": {
                                        "result": content,
                                        "is_error": is_error,
                                    }
                                }
                            })],
                        );
                    }
                }
            }
        }
        ProviderBodyShape::OllamaGenerate => {
            let Some(existing_prompt) = object
                .get("prompt")
                .and_then(|v| v.as_str())
                .map(str::to_string)
            else {
                return;
            };
            let transcript = turns
                .iter()
                .map(|turn| match turn {
                    CanonicalAgentTurn::User { content } => format!("User: {}", content.trim()),
                    CanonicalAgentTurn::Assistant {
                        text, tool_calls, ..
                    } => {
                        if tool_calls.is_empty() {
                            format!("Assistant: {}", text.trim())
                        } else {
                            let calls = tool_calls
                                .iter()
                                .map(|c| format!("{}({})", c.name, c.arguments))
                                .collect::<Vec<_>>()
                                .join(", ");
                            if text.trim().is_empty() {
                                format!("Assistant tool_calls: {calls}")
                            } else {
                                format!("Assistant: {}\nTool calls: {calls}", text.trim())
                            }
                        }
                    }
                    CanonicalAgentTurn::ToolResult {
                        tool_name,
                        content,
                        is_error,
                        ..
                    } => {
                        let status = if *is_error { "error" } else { "ok" };
                        format!("ToolResult [{tool_name} ({status})]: {}", content.trim())
                    }
                })
                .collect::<Vec<_>>()
                .join("\n\n");
            let merged = format!("{existing_prompt}\n\nAgent progress so far:\n{transcript}\n\nContinue with the next action JSON object.");
            object.insert("prompt".to_string(), serde_json::Value::String(merged));
        }
    }
}

/// Builds the complete endpoint + headers-ready JSON body for either streaming
/// or non-streaming execution through one unified pipeline.
pub(crate) fn prepare_provider_wire_request(
    config: &AIProviderConfig,
    request: &AIRequest,
    streaming: bool,
    enable_thinking_override: Option<bool>,
) -> Result<PreparedProviderWireRequest, AppError> {
    let base_endpoint = resolve_provider_endpoint(config);
    validate_ai_endpoint(config, &base_endpoint)
        .map_err(|msg| AppError::structured(ErrorCode::ValidationError, msg, false))?;

    let body_shape = resolve_provider_body_shape(config, &base_endpoint);
    let wire_provider = effective_wire_provider(config, &base_endpoint);
    let used_canonical_tools = request
        .canonical_tools
        .as_ref()
        .is_some_and(|specs| !specs.is_empty());
    let has_native_tools = shape_supports_native_tools(body_shape)
        && (used_canonical_tools || request.tools.is_some());

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
        has_native_tools,
    );

    let effective_thinking = enable_thinking_override.or(request.enable_thinking);
    let mut body = if streaming {
        streaming_request_body_with_thinking(
            config,
            &base_endpoint,
            &system_prompt,
            &prompt,
            &request.mode,
            effective_thinking,
        )
    } else {
        build_provider_request_body_with_thinking(
            config,
            &base_endpoint,
            &system_prompt,
            &prompt,
            &request.mode,
            effective_thinking,
        )
    };

    if let Some(specs) = request.canonical_tools.as_deref().filter(|s| !s.is_empty()) {
        apply_canonical_tools(
            &mut body,
            body_shape,
            specs,
            request.allow_native_memory_tool,
            request.tool_choice.as_ref(),
        );
    } else if shape_supports_native_tools(body_shape) {
        apply_native_tools(
            &mut body,
            &wire_provider,
            request.tools.as_ref(),
            request.tool_choice.as_ref(),
        );
    }

    apply_conversation_history(&mut body, body_shape, &request.history);
    apply_attachments(&mut body, body_shape, &prompt, &request.attachments);
    apply_agent_turns(&mut body, body_shape, &request.mode, &request.agent_turns);

    let endpoint = if streaming {
        streaming_endpoint(config, &base_endpoint)
    } else {
        base_endpoint
    };

    Ok(PreparedProviderWireRequest {
        endpoint,
        wire_provider,
        body_shape,
        body,
        used_canonical_tools,
    })
}

/// Computes the exact HTTP headers a prepared request requires. Kept pure so unit
/// tests can assert header parity (including `anthropic-beta`) across streaming
/// and non-streaming without opening a socket.
pub(crate) fn provider_wire_headers(
    config: &AIProviderConfig,
    prepared: &PreparedProviderWireRequest,
    api_key: Option<&str>,
) -> Vec<(&'static str, String)> {
    let mut headers = Vec::new();
    match prepared.wire_provider {
        AIProviderType::Anthropic => {
            headers.push(("x-api-key", api_key.unwrap_or_default().to_string()));
            headers.push((
                "anthropic-version",
                crate::config::ANTHROPIC_API_VERSION.to_string(),
            ));
            headers.push((
                "anthropic-beta",
                crate::config::ANTHROPIC_CONTEXT_MANAGEMENT_BETA.to_string(),
            ));
        }
        AIProviderType::Gemini if !matches!(config.provider_type, AIProviderType::Vertex) => {
            headers.push(("x-goog-api-key", api_key.unwrap_or_default().to_string()));
        }
        _ => {
            if let Some(token) = api_key.filter(|k| !k.is_empty()) {
                headers.push(("authorization", format!("Bearer {token}")));
            }
        }
    }
    headers
}

pub(crate) fn build_provider_http_request(
    client: &reqwest::Client,
    config: &AIProviderConfig,
    prepared: &PreparedProviderWireRequest,
    api_key: Option<&str>,
) -> reqwest::RequestBuilder {
    let mut builder = client.post(&prepared.endpoint);
    for (name, value) in provider_wire_headers(config, prepared, api_key) {
        builder = builder.header(name, value);
    }
    builder.json(&prepared.body)
}
