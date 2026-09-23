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
fn collect_gemini_parts(parts: &serde_json::Value) -> (String, String) {
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
        AIProviderType::Gemini | AIProviderType::Vertex => {
            // Gemini 2.5 interleaves "thought summary" parts (`"thought": true`)
            // with the answer parts. Route the thoughts to the reasoning delta so
            // the "Thinking…" trace streams live and never leaks into the answer.
            let (reasoning_raw, answer_raw) = payload
                .pointer("/candidates/0/content/parts")
                .map(collect_gemini_parts)
                .unwrap_or_default();
            let text = if !answer_raw.is_empty() {
                Some(answer_raw)
            } else {
                ["/candidates/0/output", "/text"]
                    .into_iter()
                    .find_map(|pointer| {
                        payload
                            .pointer(pointer)
                            .and_then(extract_stream_text_from_json)
                    })
            };
            let reasoning = if reasoning_raw.is_empty() {
                None
            } else {
                Some(reasoning_raw)
            };
            (text, reasoning)
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
            extract_openai_like_reasoning_delta(payload),
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
    // Forward the actual reasoning text so the UI can stream the model's
    // chain-of-thought live into the collapsible "Thinking…" block, instead of
    // only flashing a boolean flag and dumping the whole block at the end.
    if let Some(reasoning) = reasoning_delta {
        if !reasoning.is_empty() {
            emit_ai_stream_event(app, request_id, "reasoning_delta", Some(reasoning), None)?;
        }
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
/// Streaming counterpart of `extract_tool_call_as_action_json`: providers that
/// stream native tool calls emit the call name once, then the arguments as
/// JSON text fragments. This accumulator re-wraps those fragments into the
/// controller-action contract (`{"action":…,"args":…,"message":""}`) so the
/// frontend sees the same text stream as the classic path — which is what lets
/// `extractStreamingAgentAnswer` pull the finish answer out token by token.
/// Text fragments pass through verbatim; only the wrapper is synthesized.
#[derive(Default)]
pub(crate) struct ToolCallStreamState {
    /// True once the `{"action":"<name>","args":` prefix has been emitted.
    opened: bool,
    /// True once the closing `,"message":""}` has been emitted.
    closed: bool,
}

impl ToolCallStreamState {
    /// Extracts tool-call fragments from one streaming payload and returns the
    /// text pieces to emit as `text_delta`, in order. Non-tool-call payloads
    /// return an empty vec so the caller just forwards nothing extra.
    pub(crate) fn push_payload(
        &mut self,
        provider: &AIProviderType,
        payload: &serde_json::Value,
    ) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        match provider {
            AIProviderType::Anthropic => {
                match payload.get("type").and_then(|value| value.as_str()) {
                    // content_block_start carries the tool name.
                    Some("content_block_start") => {
                        if let Some(block) = payload.get("content_block") {
                            if block.get("type").and_then(|v| v.as_str()) == Some("tool_use") {
                                if let Some(name) = block.get("name").and_then(|v| v.as_str()) {
                                    out.push(format!(
                                        "{{\"action\":{},\"args\":",
                                        serde_json::to_string(&serde_json::json!(name))
                                            .unwrap_or_else(|_| "\"\"".to_string())
                                    ));
                                    self.opened = true;
                                }
                            }
                        }
                    }
                    // content_block_delta carries `partial_json` fragments.
                    Some("content_block_delta") => {
                        if self.opened && !self.closed {
                            if let Some(fragment) = payload
                                .pointer("/delta/partial_json")
                                .and_then(|value| value.as_str())
                            {
                                if !fragment.is_empty() {
                                    out.push(fragment.to_string());
                                }
                            }
                        }
                    }
                    // content_block_stop / message_stop close the args object.
                    Some("content_block_stop") | Some("message_stop")
                        if self.opened && !self.closed =>
                    {
                        out.push(",\"message\":\"\"}".to_string());
                        self.closed = true;
                    }
                    _ => {}
                }
            }
            AIProviderType::Gemini | AIProviderType::Vertex => {
                // Gemini streams complete functionCall objects, not fragments —
                // emit the whole action JSON once.
                if !self.opened {
                    if let Some(action) = extract_tool_call_as_action_json(provider, payload) {
                        out.push(action);
                        self.opened = true;
                        self.closed = true;
                    }
                }
            }
            // OpenAI, OpenRouter, Ollama, Custom: chat-completions delta shape.
            _ => {
                let calls = payload
                    .pointer("/choices/0/delta/tool_calls")
                    .and_then(|value| value.as_array());
                if let Some(calls) = calls {
                    for call in calls {
                        if !self.opened {
                            if let Some(name) = call
                                .pointer("/function/name")
                                .and_then(|value| value.as_str())
                            {
                                out.push(format!(
                                    "{{\"action\":{},\"args\":",
                                    serde_json::to_string(&serde_json::json!(name))
                                        .unwrap_or_else(|_| "\"\"".to_string())
                                ));
                                self.opened = true;
                            }
                        }
                        if self.opened && !self.closed {
                            if let Some(fragment) = call
                                .pointer("/function/arguments")
                                .and_then(|value| value.as_str())
                            {
                                if !fragment.is_empty() {
                                    out.push(fragment.to_string());
                                }
                            }
                        }
                    }
                }
                // finish_reason marks the end of the streamed tool call.
                let finished = payload
                    .pointer("/choices/0/finish_reason")
                    .and_then(|value| value.as_str())
                    .is_some();
                if finished && self.opened && !self.closed {
                    out.push(",\"message\":\"\"}".to_string());
                    self.closed = true;
                }
            }
        }
        out
    }
}

/// Pulls the first native tool call out of a *non-streaming* provider response
/// and re-serializes it into the controller-action contract
/// (`{"action","args","message"}`) that the frontend `parseAIAgentToolAction`
/// already consumes. Returns `None` when the payload carries no tool call, so
/// the caller cleanly falls back to normal text extraction. The streaming path
/// uses `ToolCallStreamState` instead, which reassembles argument fragments.
pub(crate) fn extract_tool_call_as_action_json(
    provider: &AIProviderType,
    payload: &serde_json::Value,
) -> Option<String> {
    let (name, arguments) = match provider {
        AIProviderType::Anthropic => {
            let block = payload.get("content")?.as_array()?.iter().find(|item| {
                item.get("type").and_then(|value| value.as_str()) == Some("tool_use")
            })?;
            let name = block.get("name")?.as_str()?.to_string();
            let arguments = block
                .get("input")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            (name, arguments)
        }
        AIProviderType::Gemini | AIProviderType::Vertex => {
            let call = payload
                .pointer("/candidates/0/content/parts")?
                .as_array()?
                .iter()
                .find_map(|part| part.get("functionCall"))?;
            let name = call.get("name")?.as_str()?.to_string();
            let arguments = call
                .get("args")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({}));
            (name, arguments)
        }
        // OpenAI, OpenRouter, Ollama and Custom all follow the OpenAI chat shape.
        _ => {
            let call = payload.pointer("/choices/0/message/tool_calls/0/function")?;
            let name = call.get("name")?.as_str()?.to_string();
            // OpenAI encodes function arguments as a JSON *string*; parse it
            // back into an object so the frontend normalizer sees real args.
            let arguments = match call.get("arguments") {
                Some(serde_json::Value::String(raw)) => {
                    if raw.trim().is_empty() {
                        serde_json::json!({})
                    } else {
                        match serde_json::from_str::<serde_json::Value>(raw) {
                            Ok(value) => value,
                            // Weak providers emit malformed JSON in
                            // function.arguments. Silently degrading to empty
                            // args loses the model's intent: the tool then
                            // fails with "requires args.x" while the trace
                            // shows a call that clearly carried arguments,
                            // inviting fabricated PASS summaries. Ship the raw
                            // string verbatim under `unparsedArguments` so the
                            // frontend repair pipeline can recover it (and
                            // surface a real parse error if it cannot).
                            Err(_) => serde_json::json!({ "unparsedArguments": raw }),
                        }
                    }
                }
                Some(other) => other.clone(),
                None => serde_json::json!({}),
            };
            (name, arguments)
        }
    };

    serde_json::to_string(&serde_json::json!({
        "action": name,
        "args": arguments,
        "message": "",
    }))
    .ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tool_call_extraction_returns_none_without_a_call() {
        let openai = json!({ "choices": [{ "message": { "content": "plain text" } }] });
        assert!(extract_tool_call_as_action_json(&AIProviderType::OpenAI, &openai).is_none());
    }

    #[test]
    fn tool_call_extraction_parses_openai_string_arguments() {
        let payload = json!({
            "choices": [{
                "message": {
                    "tool_calls": [{
                        "type": "function",
                        "function": {
                            "name": "describe_table",
                            "arguments": "{\"table\":\"users\"}"
                        }
                    }]
                }
            }]
        });
        let action = extract_tool_call_as_action_json(&AIProviderType::OpenAI, &payload).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&action).unwrap();
        assert_eq!(parsed["action"], "describe_table");
        assert_eq!(parsed["args"]["table"], "users");
        assert_eq!(parsed["message"], "");
    }

    #[test]
    fn tool_call_extraction_reads_anthropic_tool_use() {
        let payload = json!({
            "content": [
                { "type": "text", "text": "let me look" },
                { "type": "tool_use", "name": "list_tables", "input": { "limit": 5 } }
            ]
        });
        let action =
            extract_tool_call_as_action_json(&AIProviderType::Anthropic, &payload).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&action).unwrap();
        assert_eq!(parsed["action"], "list_tables");
        assert_eq!(parsed["args"]["limit"], 5);
    }

    #[test]
    fn tool_call_stream_reassembles_openai_argument_fragments() {
        // OpenAI streams the tool name once, then the arguments JSON in
        // arbitrary fragments; the accumulator must emit the action wrapper
        // around them so the concatenated text parses as the action contract.
        let mut state = ToolCallStreamState::default();
        let mut text = String::new();
        for payload in [
            json!({ "choices": [{ "delta": { "tool_calls": [{ "function": { "name": "finish" } }] } }] }),
            json!({ "choices": [{ "delta": { "tool_calls": [{ "function": { "arguments": "{\"response\":\"Hel" } }] } }] }),
            json!({ "choices": [{ "delta": { "tool_calls": [{ "function": { "arguments": "lo\"}" } }] } }] }),
            json!({ "choices": [{ "delta": {}, "finish_reason": "tool_calls" }] }),
        ] {
            for fragment in state.push_payload(&AIProviderType::OpenAI, &payload) {
                text.push_str(&fragment);
            }
        }
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed["action"], "finish");
        assert_eq!(parsed["args"]["response"], "Hello");
        assert_eq!(parsed["message"], "");
    }

    #[test]
    fn tool_call_stream_reassembles_anthropic_partial_json() {
        let mut state = ToolCallStreamState::default();
        let mut text = String::new();
        for payload in [
            json!({ "type": "content_block_start", "content_block": { "type": "tool_use", "name": "finish" } }),
            json!({ "type": "content_block_delta", "delta": { "type": "input_json_delta", "partial_json": "{\"response\":\"Hi" } }),
            json!({ "type": "content_block_delta", "delta": { "type": "input_json_delta", "partial_json": " there\"}" } }),
            json!({ "type": "content_block_stop" }),
        ] {
            for fragment in state.push_payload(&AIProviderType::Anthropic, &payload) {
                text.push_str(&fragment);
            }
        }
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed["action"], "finish");
        assert_eq!(parsed["args"]["response"], "Hi there");
    }

    #[test]
    fn tool_call_stream_ignores_plain_text_deltas() {
        // A streamed prose answer (no tool call) must produce no fragments so
        // the normal text-delta path stays byte-identical.
        let mut state = ToolCallStreamState::default();
        let payload = json!({ "choices": [{ "delta": { "content": "hello" } }] });
        assert!(state
            .push_payload(&AIProviderType::OpenAI, &payload)
            .is_empty());
    }

    #[test]
    fn stream_deltas_expose_openai_reasoning_delta_without_trimming() {
        // A streamed reasoning chunk must keep its leading space so the live
        // "Thinking…" text does not collapse into a run-on string.
        let payload = json!({
            "choices": [{ "delta": { "reasoning_content": " still thinking" } }]
        });
        let (text, reasoning) = extract_stream_deltas(&AIProviderType::OpenAI, &payload);
        assert!(text.is_none());
        assert_eq!(reasoning.as_deref(), Some(" still thinking"));
    }

    #[test]
    fn stream_deltas_expose_anthropic_thinking_delta() {
        let payload = json!({ "delta": { "thinking": "let me reason" } });
        let (_text, reasoning) = extract_stream_deltas(&AIProviderType::Anthropic, &payload);
        assert_eq!(reasoning.as_deref(), Some("let me reason"));
    }

    #[test]
    fn tool_call_extraction_reads_gemini_function_call() {
        let payload = json!({
            "candidates": [{
                "content": {
                    "parts": [{ "functionCall": { "name": "search_schema", "args": { "query": "email" } } }]
                }
            }]
        });
        let action = extract_tool_call_as_action_json(&AIProviderType::Gemini, &payload).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&action).unwrap();
        assert_eq!(parsed["action"], "search_schema");
        assert_eq!(parsed["args"]["query"], "email");
    }

    #[test]
    fn vertex_reuses_gemini_tool_call_and_stream_extraction() {
        // Vertex AI returns the same generateContent shape as Gemini, so both
        // the non-streaming tool-call and streaming-delta extractors must treat
        // it identically.
        let call_payload = json!({
            "candidates": [{
                "content": {
                    "parts": [{ "functionCall": { "name": "list_tables", "args": { "limit": 3 } } }]
                }
            }]
        });
        let action =
            extract_tool_call_as_action_json(&AIProviderType::Vertex, &call_payload).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&action).unwrap();
        assert_eq!(parsed["action"], "list_tables");
        assert_eq!(parsed["args"]["limit"], 3);

        let stream_payload = json!({
            "candidates": [{
                "content": { "parts": [{ "text": "\n- next row" }] }
            }]
        });
        assert_eq!(
            extract_stream_deltas(&AIProviderType::Vertex, &stream_payload).0,
            Some("\n- next row".to_string())
        );
    }

    #[test]
    fn tool_call_extraction_ships_unparseable_arguments_verbatim() {
        let payload = json!({
            "choices": [{
                "message": {
                    "tool_calls": [{
                        "type": "function",
                        "function": {
                            "name": "edit_query_sql",
                            "arguments": "{\"sql\":\"SELECT 1\", \"createIfMissing\":true,"
                        }
                    }]
                }
            }]
        });
        let action = extract_tool_call_as_action_json(&AIProviderType::OpenAI, &payload).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&action).unwrap();
        assert_eq!(parsed["action"], "edit_query_sql");
        assert_eq!(
            parsed["args"]["unparsedArguments"],
            "{\"sql\":\"SELECT 1\", \"createIfMissing\":true,"
        );
    }

    #[test]
    fn tool_call_extraction_treats_empty_arguments_as_empty_object() {
        let payload = json!({
            "choices": [{
                "message": {
                    "tool_calls": [{
                        "type": "function",
                        "function": { "name": "finish", "arguments": "   " }
                    }]
                }
            }]
        });
        let action = extract_tool_call_as_action_json(&AIProviderType::OpenAI, &payload).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&action).unwrap();
        assert_eq!(parsed["action"], "finish");
        assert_eq!(parsed["args"], json!({}));
    }

    #[test]
    fn split_think_block_extracts_leading_reasoning() {
        let input = format!("{THINK_OPEN_TAG}step one\nstep two{THINK_CLOSE_TAG}\nSELECT 1;");
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

    #[test]
    fn gemini_splits_thought_summary_from_answer() {
        let payload = json!({
            "candidates": [{
                "content": { "parts": [
                    { "text": "let me plan", "thought": true },
                    { "text": "SELECT 1;" }
                ]}
            }]
        });
        assert_eq!(
            extract_gemini_response_text(&payload).as_deref(),
            Some("SELECT 1;")
        );
        assert_eq!(
            extract_gemini_reasoning(&payload).as_deref(),
            Some("let me plan")
        );
    }

    #[test]
    fn gemini_stream_deltas_route_thoughts_to_reasoning() {
        let payload = json!({
            "candidates": [{
                "content": { "parts": [
                    { "text": "reasoning chunk", "thought": true },
                    { "text": " answer chunk" }
                ]}
            }]
        });
        let (text, reasoning) = extract_stream_deltas(&AIProviderType::Gemini, &payload);
        assert_eq!(text.as_deref(), Some(" answer chunk"));
        assert_eq!(reasoning.as_deref(), Some("reasoning chunk"));
    }

    #[test]
    fn extracts_anthropic_extended_thinking_blocks() {
        let payload = json!({
            "content": [
                { "type": "thinking", "thinking": "step through it" },
                { "type": "text", "text": "final answer" }
            ]
        });
        assert_eq!(
            extract_anthropic_reasoning(&payload).as_deref(),
            Some("step through it")
        );
        // The answer text must not carry the thinking block.
        assert_eq!(
            extract_anthropic_response_text(&payload).as_deref(),
            Some("final answer")
        );
    }
}
