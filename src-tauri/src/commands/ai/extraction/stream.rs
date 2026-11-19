use crate::database::ai_models::{AIProviderType, AIResponse, AIUsageStats};

use super::super::MAX_AI_STREAM_OUTPUT_BYTES;
use super::text::{
    collect_gemini_parts, extract_openai_like_reasoning_delta, extract_stream_text_from_json,
    split_think_block, THINK_CLOSE_TAG, THINK_OPEN_TAG,
};
use super::tool_calls::{format_tool_call_as_action_json, merge_usage_stats, ToolCallStreamState};

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

/// Stateful per-stream collector that publishes live `ai-stream-event` deltas
/// AND produces the authoritative structured `AIResponse` when the stream ends.
#[derive(Default)]
pub(crate) struct StreamResponseAccumulator {
    raw_text: String,
    visible_text: String,
    pending_text: String,
    visible_started: bool,
    reasoning_text: String,
    output_bytes: usize,
    tool_calls: ToolCallStreamState,
    usage: Option<AIUsageStats>,
}

impl StreamResponseAccumulator {
    pub(crate) fn push_frame_with_sink(
        &mut self,
        provider: &AIProviderType,
        payload: &serde_json::Value,
        mut emit: impl FnMut(
            &'static str,
            Option<String>,
            Option<serde_json::Value>,
        ) -> Result<(), String>,
    ) -> Result<(), String> {
        for fragment in self.tool_calls.push_payload(provider, payload) {
            self.output_bytes = self.output_bytes.saturating_add(fragment.len());
            if self.output_bytes > MAX_AI_STREAM_OUTPUT_BYTES {
                return Err("AI stream exceeded the 2 MB output limit.".to_string());
            }
            emit("text_delta", Some(fragment), None)?;
        }

        let (text_delta, reasoning_delta) = extract_stream_deltas(provider, payload);
        if let Some(reasoning) = reasoning_delta {
            if !reasoning.is_empty() {
                self.reasoning_text.push_str(&reasoning);
                emit("reasoning_delta", Some(reasoning), None)?;
            }
        }

        if let Some(delta) = text_delta {
            self.raw_text.push_str(&delta);
            let visible_delta = take_visible_stream_delta(
                &delta,
                &mut self.pending_text,
                &mut self.visible_started,
            );
            if !visible_delta.is_empty() {
                self.output_bytes = self.output_bytes.saturating_add(visible_delta.len());
                if self.output_bytes > MAX_AI_STREAM_OUTPUT_BYTES {
                    return Err("AI stream exceeded the 2 MB output limit.".to_string());
                }
                self.visible_text.push_str(&visible_delta);
                emit("text_delta", Some(visible_delta), None)?;
            }
        }

        if let Some(merged_usage) = merge_usage_stats(&mut self.usage, payload) {
            if let Ok(usage_json) = serde_json::to_value(&merged_usage) {
                emit("usage", None, Some(usage_json))?;
            }
        } else if let Some(raw_usage) = payload
            .get("usage")
            .cloned()
            .or_else(|| payload.get("usageMetadata").cloned())
        {
            emit("usage", None, Some(raw_usage))?;
        }

        Ok(())
    }

    pub(crate) fn into_response(self, used_canonical_tools: bool) -> AIResponse {
        let (tool_calls, thought_signature) = self.tool_calls.into_finalized();
        let (think_reasoning, cleaned_from_raw) = split_think_block(&self.raw_text);
        let base_text = if self.visible_started {
            self.visible_text
        } else {
            cleaned_from_raw
        };
        let reasoning = if !self.reasoning_text.trim().is_empty() {
            Some(self.reasoning_text.trim().to_string())
        } else {
            think_reasoning
        };

        let text = if base_text.trim().is_empty() && !tool_calls.is_empty() && !used_canonical_tools
        {
            format_tool_call_as_action_json(&tool_calls[0]).unwrap_or_default()
        } else {
            base_text
        };

        AIResponse {
            text,
            reasoning,
            tool_calls,
            thought_signature,
            usage: self.usage,
            error: None,
        }
    }
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
