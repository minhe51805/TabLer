use std::collections::BTreeMap;

use crate::database::ai_models::{AIProviderType, AIUsageStats, CanonicalToolCall};
use serde_json::json;

#[derive(Debug, Default, Clone)]
struct PartialToolCall {
    id: String,
    name: String,
    raw_arguments: String,
    object_arguments: Option<serde_json::Value>,
}

/// Parses raw stringified JSON tool arguments into a JSON value, normalizing
/// empty/whitespace strings to `{}` and preserving malformed JSON under
/// `{"unparsedArguments": raw}` so the frontend repair/error path never silently
/// fabricates empty arguments.
pub(crate) fn parse_tool_arguments_str(raw: &str) -> serde_json::Value {
    if raw.trim().is_empty() {
        return json!({});
    }
    match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(serde_json::Value::Null) => json!({}),
        Ok(value) => value,
        Err(_) => json!({ "unparsedArguments": raw }),
    }
}

fn normalize_tool_arguments_value(value: Option<&serde_json::Value>) -> serde_json::Value {
    match value {
        Some(serde_json::Value::String(raw)) => parse_tool_arguments_str(raw),
        Some(serde_json::Value::Null) | None => json!({}),
        Some(other) => other.clone(),
    }
}

impl PartialToolCall {
    fn into_canonical(self, fallback_index: usize) -> Option<CanonicalToolCall> {
        let name = self.name.trim().to_string();
        if name.is_empty() {
            return None;
        }
        let id = if self.id.trim().is_empty() {
            format!("call_{}", fallback_index + 1)
        } else {
            self.id.trim().to_string()
        };
        let arguments = if let Some(obj) = self.object_arguments {
            if obj.is_null() {
                json!({})
            } else {
                obj
            }
        } else {
            parse_tool_arguments_str(&self.raw_arguments)
        };
        Some(CanonicalToolCall {
            id,
            name,
            arguments,
        })
    }
}

/// Accumulates one or more streamed native tool calls (plus extended-thinking
/// signatures on Anthropic and Gemini/Vertex) across SSE frames, while still
/// emitting the `{"action","args","message"}` live preview fragments for the
/// primary call so `finish` answers can stream token-by-token in the UI.
#[derive(Default)]
pub(crate) struct ToolCallStreamState {
    calls: BTreeMap<usize, PartialToolCall>,
    active_anthropic_slot: Option<usize>,
    next_synthetic_slot: usize,
    thought_signature: String,
    preview_opened: bool,
    preview_emitted_args: bool,
    preview_closed: bool,
}

impl ToolCallStreamState {
    fn close_preview(&mut self, out: &mut Vec<String>) {
        if self.preview_opened && !self.preview_closed {
            if !self.preview_emitted_args {
                out.push("{}".to_string());
                self.preview_emitted_args = true;
            }
            out.push(",\"message\":\"\"}".to_string());
            self.preview_closed = true;
        }
    }

    fn open_preview(&mut self, name: &str, out: &mut Vec<String>) {
        if !self.preview_opened {
            out.push(format!(
                "{{\"action\":{},\"args\":",
                serde_json::to_string(&json!(name)).unwrap_or_else(|_| "\"\"".to_string())
            ));
            self.preview_opened = true;
        }
    }

    /// Processes one SSE JSON frame, updating internal multi-tool state and
    /// returning any preview text deltas for the primary call.
    pub(crate) fn push_payload(
        &mut self,
        provider: &AIProviderType,
        payload: &serde_json::Value,
    ) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        match provider {
            AIProviderType::Anthropic => {
                match payload.get("type").and_then(|value| value.as_str()) {
                    Some("content_block_start") => {
                        let slot = payload
                            .get("index")
                            .and_then(|v| v.as_u64())
                            .map(|n| n as usize)
                            .unwrap_or_else(|| {
                                let s = self.next_synthetic_slot;
                                self.next_synthetic_slot += 1;
                                s
                            });
                        if let Some(block) = payload.get("content_block") {
                            if let Some(sig) = block
                                .get("signature")
                                .and_then(|v| v.as_str())
                                .filter(|s| !s.is_empty())
                            {
                                self.thought_signature.push_str(sig);
                            }
                            if block.get("type").and_then(|v| v.as_str()) == Some("tool_use") {
                                let name = block
                                    .get("name")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or_default()
                                    .to_string();
                                let id = block
                                    .get("id")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or_default()
                                    .to_string();
                                let initial_input = block
                                    .get("input")
                                    .and_then(|v| v.as_object())
                                    .filter(|map| !map.is_empty())
                                    .map(|map| serde_json::Value::Object(map.clone()));

                                if !name.is_empty() && !self.preview_opened {
                                    self.open_preview(&name, &mut out);
                                    if let Some(ref obj) = initial_input {
                                        if let Ok(serialized) = serde_json::to_string(obj) {
                                            out.push(serialized);
                                            self.preview_emitted_args = true;
                                        }
                                    }
                                }

                                let entry = self.calls.entry(slot).or_default();
                                if !id.is_empty() {
                                    entry.id = id;
                                }
                                if !name.is_empty() {
                                    entry.name = name;
                                }
                                if initial_input.is_some() {
                                    entry.object_arguments = initial_input;
                                }
                                self.active_anthropic_slot = Some(slot);
                            }
                        }
                    }
                    Some("content_block_delta") => {
                        if payload.pointer("/delta/type").and_then(|v| v.as_str())
                            == Some("signature_delta")
                        {
                            if let Some(sig) =
                                payload.pointer("/delta/signature").and_then(|v| v.as_str())
                            {
                                self.thought_signature.push_str(sig);
                            }
                        }
                        if let Some(fragment) = payload
                            .pointer("/delta/partial_json")
                            .and_then(|value| value.as_str())
                        {
                            let target_slot = payload
                                .get("index")
                                .and_then(|v| v.as_u64())
                                .map(|n| n as usize)
                                .or(self.active_anthropic_slot);
                            if let Some(slot) = target_slot {
                                if let Some(entry) = self.calls.get_mut(&slot) {
                                    // Clear any placeholder initial object once real JSON deltas arrive.
                                    entry.object_arguments = None;
                                    entry.raw_arguments.push_str(fragment);
                                }
                                let is_first_slot = self.calls.keys().next().copied() == Some(slot);
                                if is_first_slot
                                    && self.preview_opened
                                    && !self.preview_closed
                                    && !fragment.is_empty()
                                {
                                    out.push(fragment.to_string());
                                    self.preview_emitted_args = true;
                                }
                            }
                        }
                    }
                    Some("content_block_stop") => {
                        let stopped_slot = payload
                            .get("index")
                            .and_then(|v| v.as_u64())
                            .map(|n| n as usize)
                            .or(self.active_anthropic_slot);
                        if self.calls.keys().next().copied() == stopped_slot {
                            self.close_preview(&mut out);
                        }
                        if self.active_anthropic_slot == stopped_slot {
                            self.active_anthropic_slot = None;
                        }
                    }
                    Some("message_stop") => {
                        self.close_preview(&mut out);
                    }
                    _ => {}
                }
            }
            AIProviderType::Gemini | AIProviderType::Vertex => {
                if let Some(parts) = payload
                    .pointer("/candidates/0/content/parts")
                    .and_then(|v| v.as_array())
                {
                    for part in parts {
                        if let Some(sig) = part
                            .get("thoughtSignature")
                            .or_else(|| part.get("thought_signature"))
                            .and_then(|v| v.as_str())
                            .filter(|s| !s.is_empty())
                        {
                            self.thought_signature = sig.to_string();
                        }
                        if let Some(call) = part.get("functionCall") {
                            if let Some(name) = call.get("name").and_then(|v| v.as_str()) {
                                let id = call
                                    .get("id")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or_default()
                                    .to_string();
                                let arguments =
                                    call.get("args").cloned().unwrap_or_else(|| json!({}));
                                let slot = self.next_synthetic_slot;
                                self.next_synthetic_slot += 1;
                                self.calls.insert(
                                    slot,
                                    PartialToolCall {
                                        id,
                                        name: name.to_string(),
                                        raw_arguments: String::new(),
                                        object_arguments: Some(arguments.clone()),
                                    },
                                );
                                if !self.preview_opened {
                                    if let Ok(action) = serde_json::to_string(&json!({
                                        "action": name,
                                        "args": arguments,
                                        "message": "",
                                    })) {
                                        out.push(action);
                                    }
                                    self.preview_opened = true;
                                    self.preview_emitted_args = true;
                                    self.preview_closed = true;
                                }
                            }
                        }
                    }
                }
            }
            // OpenAI, OpenRouter, Ollama (/v1/chat/completions or /api/chat), Custom.
            _ => {
                if let Some(calls) = payload
                    .pointer("/choices/0/delta/tool_calls")
                    .and_then(|value| value.as_array())
                {
                    for (pos, call) in calls.iter().enumerate() {
                        let slot = call
                            .get("index")
                            .and_then(|v| v.as_u64())
                            .map(|n| n as usize)
                            .unwrap_or(pos);
                        let mut preview_name_to_open: Option<String> = None;
                        {
                            let entry = self.calls.entry(slot).or_default();
                            if let Some(id) = call.get("id").and_then(|v| v.as_str()) {
                                if !id.is_empty() {
                                    entry.id = id.to_string();
                                }
                            }
                            if let Some(name) = call
                                .pointer("/function/name")
                                .and_then(|value| value.as_str())
                            {
                                if !name.is_empty() {
                                    entry.name.push_str(name);
                                    if slot == 0 && !self.preview_opened {
                                        preview_name_to_open = Some(entry.name.clone());
                                    }
                                }
                            }
                            match call.pointer("/function/arguments") {
                                Some(serde_json::Value::String(fragment)) => {
                                    entry.raw_arguments.push_str(fragment);
                                }
                                Some(other @ serde_json::Value::Object(_)) => {
                                    entry.object_arguments = Some(other.clone());
                                }
                                _ => {}
                            }
                        }
                        if let Some(preview_name) = preview_name_to_open {
                            self.open_preview(&preview_name, &mut out);
                        }
                        if slot == 0 && self.preview_opened && !self.preview_closed {
                            match call.pointer("/function/arguments") {
                                Some(serde_json::Value::String(fragment))
                                    if !fragment.is_empty() =>
                                {
                                    out.push(fragment.to_string());
                                    self.preview_emitted_args = true;
                                }
                                Some(other @ serde_json::Value::Object(_)) => {
                                    if let Ok(serialized) = serde_json::to_string(other) {
                                        out.push(serialized);
                                        self.preview_emitted_args = true;
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                } else if let Some(ollama_calls) = payload
                    .pointer("/message/tool_calls")
                    .and_then(|value| value.as_array())
                {
                    // Native Ollama `/api/chat` streams complete tool_call objects under `message.tool_calls`.
                    for call in ollama_calls {
                        let Some(name) = call
                            .pointer("/function/name")
                            .and_then(|value| value.as_str())
                            .filter(|s| !s.is_empty())
                        else {
                            continue;
                        };
                        let id = call
                            .get("id")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_string();
                        let args =
                            normalize_tool_arguments_value(call.pointer("/function/arguments"));
                        let slot = self.next_synthetic_slot;
                        self.next_synthetic_slot += 1;
                        self.calls.insert(
                            slot,
                            PartialToolCall {
                                id,
                                name: name.to_string(),
                                raw_arguments: String::new(),
                                object_arguments: Some(args.clone()),
                            },
                        );
                        if !self.preview_opened {
                            if let Ok(action) = serde_json::to_string(&json!({
                                "action": name,
                                "args": args,
                                "message": "",
                            })) {
                                out.push(action);
                            }
                            self.preview_opened = true;
                            self.preview_emitted_args = true;
                            self.preview_closed = true;
                        }
                    }
                }

                let finished = payload
                    .pointer("/choices/0/finish_reason")
                    .and_then(|value| value.as_str())
                    .is_some()
                    || payload.get("done").and_then(|value| value.as_bool()) == Some(true);
                if finished {
                    self.close_preview(&mut out);
                }
            }
        }
        out
    }

    /// Finalizes all accumulated tool calls (in deterministic index order) and
    /// any extended-thinking signature captured during the stream.
    pub(crate) fn into_finalized(self) -> (Vec<CanonicalToolCall>, Option<String>) {
        let tool_calls = self
            .calls
            .into_values()
            .enumerate()
            .filter_map(|(idx, partial)| partial.into_canonical(idx))
            .collect();
        let signature = if self.thought_signature.is_empty() {
            None
        } else {
            Some(self.thought_signature)
        };
        (tool_calls, signature)
    }
}

/// Extracts all native tool calls from a *non-streaming* provider response in
/// canonical provider-agnostic form.
pub(crate) fn extract_canonical_tool_calls(
    provider: &AIProviderType,
    payload: &serde_json::Value,
) -> Vec<CanonicalToolCall> {
    match provider {
        AIProviderType::Anthropic => payload
            .get("content")
            .and_then(|v| v.as_array())
            .map(|blocks| {
                blocks
                    .iter()
                    .filter(|item| item.get("type").and_then(|v| v.as_str()) == Some("tool_use"))
                    .enumerate()
                    .filter_map(|(idx, block)| {
                        let name = block.get("name")?.as_str()?.trim().to_string();
                        if name.is_empty() {
                            return None;
                        }
                        let id = block
                            .get("id")
                            .and_then(|v| v.as_str())
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(str::to_string)
                            .unwrap_or_else(|| format!("call_{}", idx + 1));
                        let arguments = normalize_tool_arguments_value(block.get("input"));
                        Some(CanonicalToolCall {
                            id,
                            name,
                            arguments,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default(),
        AIProviderType::Gemini | AIProviderType::Vertex => payload
            .pointer("/candidates/0/content/parts")
            .and_then(|v| v.as_array())
            .map(|parts| {
                parts
                    .iter()
                    .filter_map(|part| part.get("functionCall"))
                    .enumerate()
                    .filter_map(|(idx, call)| {
                        let name = call.get("name")?.as_str()?.trim().to_string();
                        if name.is_empty() {
                            return None;
                        }
                        let id = call
                            .get("id")
                            .and_then(|v| v.as_str())
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(str::to_string)
                            .unwrap_or_else(|| format!("call_{}", idx + 1));
                        let arguments = normalize_tool_arguments_value(call.get("args"));
                        Some(CanonicalToolCall {
                            id,
                            name,
                            arguments,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default(),
        _ => {
            let calls_array = payload
                .pointer("/choices/0/message/tool_calls")
                .and_then(|v| v.as_array())
                .or_else(|| {
                    payload
                        .pointer("/message/tool_calls")
                        .and_then(|v| v.as_array())
                });
            calls_array
                .map(|calls| {
                    calls
                        .iter()
                        .enumerate()
                        .filter_map(|(idx, item)| {
                            let call = item.get("function")?;
                            let name = call.get("name")?.as_str()?.trim().to_string();
                            if name.is_empty() {
                                return None;
                            }
                            let id = item
                                .get("id")
                                .and_then(|v| v.as_str())
                                .map(str::trim)
                                .filter(|s| !s.is_empty())
                                .map(str::to_string)
                                .unwrap_or_else(|| format!("call_{}", idx + 1));
                            let arguments = normalize_tool_arguments_value(call.get("arguments"));
                            Some(CanonicalToolCall {
                                id,
                                name,
                                arguments,
                            })
                        })
                        .collect()
                })
                .unwrap_or_default()
        }
    }
}

/// Extracts extended-thinking signature metadata from a non-streaming response
/// (`thinking.signature` on Anthropic, `thoughtSignature` on Gemini/Vertex).
pub(crate) fn extract_thought_signature(
    provider: &AIProviderType,
    payload: &serde_json::Value,
) -> Option<String> {
    match provider {
        AIProviderType::Anthropic => payload
            .get("content")?
            .as_array()?
            .iter()
            .find(|item| item.get("type").and_then(|v| v.as_str()) == Some("thinking"))
            .and_then(|block| block.get("signature"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        AIProviderType::Gemini | AIProviderType::Vertex => payload
            .pointer("/candidates/0/content/parts")?
            .as_array()?
            .iter()
            .find_map(|part| {
                part.get("thoughtSignature")
                    .or_else(|| part.get("thought_signature"))
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
            }),
        _ => None,
    }
}

/// Extracts and normalizes token usage across OpenAI, Anthropic, Gemini/Vertex,
/// and Ollama response envelopes (both streaming chunks and blocking JSON).
pub(crate) fn extract_usage_stats(payload: &serde_json::Value) -> Option<AIUsageStats> {
    let usage_obj = payload
        .get("usage")
        .or_else(|| payload.pointer("/message/usage"))
        .or_else(|| payload.get("usageMetadata"));

    let mut stats = AIUsageStats::default();
    if let Some(usage) = usage_obj {
        stats.input_tokens = usage
            .get("input_tokens")
            .or_else(|| usage.get("prompt_tokens"))
            .or_else(|| usage.get("promptTokenCount"))
            .and_then(|v| v.as_u64());
        stats.output_tokens = usage
            .get("output_tokens")
            .or_else(|| usage.get("completion_tokens"))
            .or_else(|| usage.get("candidatesTokenCount"))
            .and_then(|v| v.as_u64());
        stats.total_tokens = usage
            .get("total_tokens")
            .or_else(|| usage.get("totalTokenCount"))
            .and_then(|v| v.as_u64());
        stats.cache_read_input_tokens = usage
            .get("cache_read_input_tokens")
            .or_else(|| usage.pointer("/prompt_tokens_details/cached_tokens"))
            .or_else(|| usage.get("cachedContentTokenCount"))
            .and_then(|v| v.as_u64());
        stats.cache_creation_input_tokens = usage
            .get("cache_creation_input_tokens")
            .and_then(|v| v.as_u64());
    }

    // Native Ollama `/api/chat` and `/api/generate` emit top-level eval counts.
    if stats.input_tokens.is_none() {
        stats.input_tokens = payload.get("prompt_eval_count").and_then(|v| v.as_u64());
    }
    if stats.output_tokens.is_none() {
        stats.output_tokens = payload.get("eval_count").and_then(|v| v.as_u64());
    }
    if stats.total_tokens.is_none()
        && (stats.input_tokens.is_some() || stats.output_tokens.is_some())
    {
        stats.total_tokens =
            Some(stats.input_tokens.unwrap_or(0) + stats.output_tokens.unwrap_or(0));
    }

    (!stats.is_empty()).then_some(stats)
}

/// Merges incremental SSE usage chunks (e.g. Anthropic `message_start` input
/// tokens + `message_delta` output tokens) into a running `AIUsageStats`.
pub(crate) fn merge_usage_stats(
    accumulator: &mut Option<AIUsageStats>,
    payload: &serde_json::Value,
) -> Option<AIUsageStats> {
    let incoming = extract_usage_stats(payload)?;
    let merged = match accumulator.take() {
        Some(mut current) => {
            if incoming.input_tokens.is_some() {
                current.input_tokens = incoming.input_tokens;
            }
            if incoming.output_tokens.is_some() {
                current.output_tokens = incoming.output_tokens;
            }
            if incoming.cache_read_input_tokens.is_some() {
                current.cache_read_input_tokens = incoming.cache_read_input_tokens;
            }
            if incoming.cache_creation_input_tokens.is_some() {
                current.cache_creation_input_tokens = incoming.cache_creation_input_tokens;
            }
            current.total_tokens = incoming
                .total_tokens
                .filter(|&n| {
                    // Only prefer incoming explicit total when it covers both sides.
                    current.input_tokens.is_none() || n >= current.input_tokens.unwrap_or(0)
                })
                .or_else(|| {
                    (current.input_tokens.is_some() || current.output_tokens.is_some()).then(|| {
                        current.input_tokens.unwrap_or(0) + current.output_tokens.unwrap_or(0)
                    })
                });
            current
        }
        None => incoming,
    };
    *accumulator = Some(merged.clone());
    Some(merged)
}

/// Legacy single-action JSON wrapper (`{"action","args","message"}`) built from
/// the first native tool call when callers use the legacy `request.tools` field.
pub(crate) fn format_tool_call_as_action_json(call: &CanonicalToolCall) -> Option<String> {
    serde_json::to_string(&json!({
        "action": call.name,
        "args": call.arguments,
        "message": "",
    }))
    .ok()
}

#[cfg(test)]
pub(crate) fn extract_tool_call_as_action_json(
    provider: &AIProviderType,
    payload: &serde_json::Value,
) -> Option<String> {
    let first = extract_canonical_tool_calls(provider, payload)
        .into_iter()
        .next()?;
    format_tool_call_as_action_json(&first)
}
