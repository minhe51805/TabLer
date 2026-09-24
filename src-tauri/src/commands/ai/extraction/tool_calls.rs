use crate::database::ai_models::AIProviderType;

/// Reassembles provider tool-call fragments into the `{"action","args","message"}`
/// JSON the frontend `parseAIAgentToolAction` consumes. Text fragments pass
/// through verbatim; only the wrapper is synthesized.
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
