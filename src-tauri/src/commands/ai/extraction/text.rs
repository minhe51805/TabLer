/// Reasoning models like DeepSeek-R1 and some Qwen variants wrap their
/// chain-of-thought in a dedicated open/close tag pair inside normal content.
/// Written with unicode escapes so the tags never appear verbatim in source.
pub(crate) const THINK_OPEN_TAG: &str = "\u{3c}think\u{3e}";
pub(crate) const THINK_CLOSE_TAG: &str = "\u{3c}/think\u{3e}";

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

/// Streaming variant of [`extract_openai_like_reasoning`]: pulls the incremental
/// reasoning delta (`reasoning_content` / `reasoning`) WITHOUT trimming, so the
/// spaces and newlines between streamed tokens survive and the "Thinking…" block
/// reads naturally instead of collapsing into one run-on line.
pub(crate) fn extract_openai_like_reasoning_delta(payload: &serde_json::Value) -> Option<String> {
    for pointer in [
        "/choices/0/delta/reasoning_content",
        "/choices/0/delta/reasoning",
        "/choices/0/message/reasoning_content",
        "/choices/0/message/reasoning",
    ] {
        if let Some(text) = payload
            .pointer(pointer)
            .and_then(extract_stream_text_from_json)
        {
            if !text.is_empty() {
                return Some(text);
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

/// Pulls Claude's extended-thinking blocks (`{"type":"thinking","thinking":...}`)
/// out of a non-streaming Anthropic response, concatenated in order. `None` when
/// the model returned no thinking blocks (thinking off or an older model).
pub(crate) fn extract_anthropic_reasoning(payload: &serde_json::Value) -> Option<String> {
    let blocks = payload.get("content")?.as_array()?;
    let mut reasoning = String::new();
    for block in blocks {
        if block.get("type").and_then(|value| value.as_str()) == Some("thinking") {
            if let Some(text) = block.get("thinking").and_then(|value| value.as_str()) {
                reasoning.push_str(text);
            }
        }
    }
    let reasoning = reasoning.trim();
    if reasoning.is_empty() {
        None
    } else {
        Some(reasoning.to_string())
    }
}

/// Walks Gemini `candidates[0].content.parts`, concatenating the visible answer
/// text and the "thought summary" parts (`"thought": true`) separately. Returns
/// `(reasoning, answer)` as raw, untrimmed strings so streaming callers keep the
/// spacing between tokens; blocking callers trim afterwards.
pub(crate) fn collect_gemini_parts(parts: &serde_json::Value) -> (String, String) {
    let mut reasoning = String::new();
    let mut answer = String::new();
    if let Some(items) = parts.as_array() {
        for part in items {
            if let Some(text) = part.get("text").and_then(|value| value.as_str()) {
                if part.get("thought").and_then(|value| value.as_bool()) == Some(true) {
                    reasoning.push_str(text);
                } else {
                    answer.push_str(text);
                }
            }
        }
    }
    (reasoning, answer)
}

pub(crate) fn extract_gemini_response_text(payload: &serde_json::Value) -> Option<String> {
    if let Some(parts) = payload.pointer("/candidates/0/content/parts") {
        let (_reasoning, answer) = collect_gemini_parts(parts);
        let answer = answer.trim();
        if !answer.is_empty() {
            return Some(answer.to_string());
        }
    }

    if let Some(text) = payload
        .pointer("/candidates/0/output")
        .and_then(extract_text_from_json)
    {
        return Some(text);
    }

    payload.get("text").and_then(extract_text_from_json)
}

/// The Gemini "thought summary" reasoning, when `thinkingConfig.includeThoughts`
/// asked for it. `None` when the model returned no thought parts.
pub(crate) fn extract_gemini_reasoning(payload: &serde_json::Value) -> Option<String> {
    let parts = payload.pointer("/candidates/0/content/parts")?;
    let (reasoning, _answer) = collect_gemini_parts(parts);
    let reasoning = reasoning.trim();
    if reasoning.is_empty() {
        None
    } else {
        Some(reasoning.to_string())
    }
}
