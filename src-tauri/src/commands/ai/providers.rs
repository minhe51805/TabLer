use crate::database::ai_models::{AIProviderConfig, AIProviderType, AIRequestMode};
use serde_json::json;

use super::endpoints::{
    is_nvidia_integrate_endpoint, is_ollama_native_chat_endpoint,
    is_ollama_native_generate_endpoint,
};

pub(crate) fn streaming_request_body(
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

pub(crate) fn streaming_endpoint(config: &AIProviderConfig, endpoint: &str) -> String {
    if config.provider_type == AIProviderType::Gemini {
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

pub(crate) fn build_provider_request_body(
    config: &AIProviderConfig,
    endpoint: &str,
    system_prompt: &str,
    prompt: &str,
    mode: &AIRequestMode,
) -> serde_json::Value {
    // An explicit API format wins over URL sniffing so users can point a
    // Custom provider at any path (e.g. an Ollama server behind a proxy).
    if matches!(config.provider_type, AIProviderType::Ollama | AIProviderType::Custom) {
        match super::endpoints::explicit_api_format(config) {
            Some("ollama-chat") => {
                return json!({
                    "model": config.model,
                    "messages": [
                        { "role": "system", "content": system_prompt },
                        { "role": "user", "content": prompt }
                    ],
                    "stream": false
                });
            }
            Some("ollama-generate") => {
                return json!({
                    "model": config.model,
                    "system": system_prompt,
                    "prompt": prompt,
                    "stream": false
                });
            }
            Some("chat-completions") => {
                return build_openai_like_body(
                    &config.model,
                    system_prompt,
                    prompt,
                    mode,
                    endpoint,
                );
            }
            _ => {}
        }
    }

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
        AIProviderType::Gemini => {
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
    }
}

#[cfg(test)]
mod tests {
    use super::super::extraction::take_visible_stream_delta;
    use super::*;

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
}
