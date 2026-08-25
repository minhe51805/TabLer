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
    }
}

#[cfg(test)]
mod tests {
    use super::super::extraction::take_visible_stream_delta;
    use super::*;

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
