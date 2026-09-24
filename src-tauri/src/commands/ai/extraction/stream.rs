use tauri::AppHandle;

use crate::database::ai_models::AIProviderType;

use super::super::{emit_ai_stream_event, MAX_AI_STREAM_OUTPUT_BYTES};
use super::text::{
    collect_gemini_parts, extract_openai_like_reasoning_delta, extract_stream_text_from_json,
    THINK_CLOSE_TAG, THINK_OPEN_TAG,
};
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
