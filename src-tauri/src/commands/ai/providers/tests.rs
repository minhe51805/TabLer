use super::super::endpoints::ModelsListShape;
use super::super::extraction::take_visible_stream_delta;
use super::super::FetchedModel;
use super::*;
use crate::database::ai_models::{AIConversationMessage, AIConversationRole, AIRequestAttachment};

#[test]
fn thinking_rejection_matches_each_provider_param_name() {
    // OpenAI-like (NVIDIA chat-template), Anthropic, Gemini rejection bodies.
    assert!(is_thinking_param_rejection(
        "{\"error\":{\"message\":\"unexpected keyword argument 'enable_thinking'\"}}"
    ));
    assert!(is_thinking_param_rejection(
        "Unsupported parameter: \"thinking\" is not supported on this model"
    ));
    assert!(is_thinking_param_rejection(
        "Invalid JSON payload received. Unknown name \"thinkingConfig\""
    ));
    assert!(is_thinking_param_rejection(
        "field budget_tokens not allowed"
    ));
}

#[test]
fn thinking_rejection_ignores_unrelated_400s() {
    assert!(!is_thinking_param_rejection(
        "{\"error\":{\"message\":\"model not found\"}}"
    ));
    assert!(!is_thinking_param_rejection("context length exceeded"));
}

#[test]
fn marking_model_disables_thinking_and_is_case_insensitive() {
    let model = "Vendor-Future-Model-2099";
    assert!(!model_thinking_unsupported(model));
    mark_model_thinking_unsupported(model);
    assert!(model_thinking_unsupported(model));
    // Same model, different casing, resolves to the same disabled entry.
    assert!(model_thinking_unsupported("vendor-future-model-2099"));
    // Blank names are ignored (never poison the cache).
    mark_model_thinking_unsupported("   ");
    assert!(!model_thinking_unsupported("   "));
}

#[test]
fn anthropic_body_drops_thinking_once_model_is_marked() {
    let marked = "claude-sonnet-4-marked-test";
    // Before marking, a known-supporting family gets the thinking block.
    let before = build_anthropic_body(marked, "sys", "hi", &AIRequestMode::Panel, Some(true));
    assert!(before.get("thinking").is_some());
    // After a 400 self-heal marks it, the block is gone.
    mark_model_thinking_unsupported(marked);
    let after = build_anthropic_body(marked, "sys", "hi", &AIRequestMode::Panel, Some(true));
    assert!(after.get("thinking").is_none());
}

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
    apply_conversation_history(
        &mut body,
        ProviderBodyShape::OllamaGenerate,
        &sample_history(),
    );
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
    // OpenAI-shape requests never carry Anthropic context editing.
    assert!(body.get("context_management").is_none());
}

#[test]
fn apply_native_tools_adds_anthropic_context_editing() {
    let mut body = json!({ "model": "claude-sonnet-4", "messages": [] });
    let tools = json!([{ "name": "finish", "input_schema": {} }]);
    let choice = json!({ "type": "auto" });
    apply_native_tools(
        &mut body,
        &AIProviderType::Anthropic,
        Some(&tools),
        Some(&choice),
    );
    // Tools + tool_choice keep the Anthropic top-level shape.
    assert_eq!(body["tools"], tools);
    assert_eq!(body["tool_choice"], json!({ "type": "auto" }));
    // Context Editing (beta context-management-2025-06-27) is attached so the
    // server clears stale tool results itself on long agent runs.
    assert_eq!(
        body["context_management"]["edits"][0]["type"],
        json!("clear_tool_uses_20250919")
    );
    assert_eq!(
        body["context_management"]["edits"][0]["trigger"]["type"],
        json!("input_tokens")
    );
    assert_eq!(
        body["context_management"]["edits"][0]["keep"]["value"],
        json!(crate::config::ANTHROPIC_CONTEXT_KEEP_TOOL_USES)
    );
}

#[test]
fn apply_native_tools_context_editing_is_absent_without_tools() {
    let mut body = json!({ "model": "claude-sonnet-4", "messages": [] });
    apply_native_tools(&mut body, &AIProviderType::Anthropic, None, None);
    // No tools => no context_management (and no tools key): plain completion
    // bodies stay byte-identical.
    assert!(body.get("context_management").is_none());
    assert!(body.get("tools").is_none());
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
    assert_eq!(
        body["systemInstruction"]["parts"][0]["text"],
        "system prompt"
    );
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
    assert_eq!(
        tool_body["tools"],
        json!([{ "functionDeclarations": tools }])
    );
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
        body.pointer("/thinking/type")
            .and_then(|value| value.as_str()),
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
        anthropic_body
            .get("max_tokens")
            .and_then(|value| value.as_u64()),
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
    assert_eq!(
        ids(&parsed),
        vec!["gpt-4o".to_string(), "gpt-4o-mini".to_string()]
    );
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
    assert!(parsed_ollama
        .iter()
        .all(|model| model.context_window.is_none()));

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
