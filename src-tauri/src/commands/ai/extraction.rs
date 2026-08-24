use crate::database::ai_models::AIProviderType;
use tauri::AppHandle;

use super::{emit_ai_stream_event, MAX_AI_STREAM_OUTPUT_BYTES};

/// Reasoning models like DeepSeek-R1 and some Qwen variants wrap their
/// chain-of-thought in a dedicated open/close tag pair inside normal content.
/// Written with unicode escapes so the tags never appear verbatim in source.
const THINK_OPEN_TAG: &str = "\u{3c}think\u{3e}";
const THINK_CLOSE_TAG: &str = "\u{3c}/think\u{3e}";

pub(crate) fn extract_text_from_json(value: &serde_json::Value) -> Option<String> {
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

pub(crate) fn extract_stream_text_from_json(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(text) => {
            if text.is_empty() {
                None
            } else {
                Some(text.to_string())
            }
        }
        serde_json::Value::Array(items) => {
            let text = items
                .iter()
                .filter_map(extract_stream_text_from_json)
                .collect::<String>();
            if text.is_empty() {
                None
            } else {
                Some(text)
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
                "message",
                "delta",
            ] {
                if let Some(text) = map.get(key).and_then(extract_stream_text_from_json) {
                    return Some(text);
                }
            }
            None
        }
        _ => None,
    }
}

/// Splits a leading reasoning block out of model content.
/// Returns (reasoning, cleaned_text).
pub(crate) fn split_think_block(text: &str) -> (Option<String>, String) {
    let trimmed = text.trim_start();
    if let Some(rest) = trimmed.strip_prefix(THINK_OPEN_TAG) {
        if let Some(end) = rest.find(THINK_CLOSE_TAG) {
            let reasoning = rest[..end].trim().to_string();
            let after = rest[end + THINK_CLOSE_TAG.len()..].trim_start().to_string();
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
pub(crate) fn extract_openai_like_reasoning(payload: &serde_json::Value) -> Option<String> {
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

pub(crate) fn extract_openai_like_response_text(payload: &serde_json::Value) -> Option<String> {
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

pub(crate) fn extract_anthropic_response_text(payload: &serde_json::Value) -> Option<String> {
    if let Some(text) = payload.get("content").and_then(extract_text_from_json) {
        return Some(text);
    }

    payload.get("completion").and_then(extract_text_from_json)
}

pub(crate) fn extract_gemini_response_text(payload: &serde_json::Value) -> Option<String> {
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

pub(crate) fn extract_stream_deltas(
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
        AIProviderType::Gemini => {
            let text = [
                "/candidates/0/content/parts",
                "/candidates/0/output",
                "/text",
            ]
            .into_iter()
            .find_map(|pointer| {
                payload
                    .pointer(pointer)
                    .and_then(extract_stream_text_from_json)
            });
            (text, None)
        }
        _ => (
            [
                "/choices/0/delta/content",
                "/choices/0/text",
                "/choices/0/message/content",
                "/message/content",
                "/response",
                "/output_text",
                "/output/0/content",
                "/content",
                "/text",
            ]
            .into_iter()
            .find_map(|pointer| {
                payload
                    .pointer(pointer)
                    .and_then(extract_stream_text_from_json)
            }),
            extract_openai_like_reasoning(payload),
        ),
    }
}

pub(crate) fn publish_stream_payload(
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

pub(crate) fn take_visible_stream_delta(
    delta: &str,
    pending_text: &mut String,
    visible_started: &mut bool,
) -> String {
    if *visible_started {
        return delta.to_string();
    }
    pending_text.push_str(delta);
    if pending_text.starts_with(THINK_OPEN_TAG) {
        if let Some(end) = pending_text.find(THINK_CLOSE_TAG) {
            *visible_started = true;
            let visible = pending_text[end + THINK_CLOSE_TAG.len()..].to_string();
            pending_text.clear();
            return visible;
        }
        return String::new();
    }
    if THINK_OPEN_TAG.starts_with(pending_text.as_str()) {
        return String::new();
    }
    *visible_started = true;
    std::mem::take(pending_text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn split_think_block_extracts_leading_reasoning() {
        let input = format!(
            "{THINK_OPEN_TAG}step one\nstep two{THINK_CLOSE_TAG}\nSELECT 1;"
        );
        let (reasoning, cleaned) = split_think_block(&input);
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
        let input = format!("{THINK_OPEN_TAG}still thinking");
        let (reasoning, cleaned) = split_think_block(&input);
        assert_eq!(reasoning.as_deref(), Some("still thinking"));
        assert_eq!(cleaned, "");
    }

    #[test]
    fn streamed_provider_tokens_preserve_leading_and_whitespace_only_chunks() {
        let openai_word = json!({
            "choices": [{ "delta": { "content": " database" } }]
        });
        let openai_space = json!({
            "choices": [{ "delta": { "content": " " } }]
        });
        let gemini_line = json!({
            "candidates": [{
                "content": { "parts": [{ "text": "\n- next item" }] }
            }]
        });

        assert_eq!(
            extract_stream_deltas(&AIProviderType::OpenAI, &openai_word).0,
            Some(" database".to_string())
        );
        assert_eq!(
            extract_stream_deltas(&AIProviderType::OpenAI, &openai_space).0,
            Some(" ".to_string())
        );
        assert_eq!(
            extract_stream_deltas(&AIProviderType::Gemini, &gemini_line).0,
            Some("\n- next item".to_string())
        );
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
}