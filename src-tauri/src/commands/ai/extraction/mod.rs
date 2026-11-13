mod stream;
mod text;
mod tool_calls;

pub(crate) use stream::*;
pub(crate) use text::*;
pub(crate) use tool_calls::*;

use crate::database::ai_models::{AIProviderType, AIResponse};

/// Unified non-streaming response extractor across OpenAI-like, Ollama,
/// Anthropic, Gemini, and Vertex JSON envelopes. Preserves reasoning, multiple
/// parallel tool calls, extended-thinking signatures, and normalized token usage.
pub(crate) fn extract_provider_response(
    provider: &AIProviderType,
    payload: &serde_json::Value,
    used_canonical_tools: bool,
) -> Option<AIResponse> {
    let tool_calls = extract_canonical_tool_calls(provider, payload);
    let thought_signature = extract_thought_signature(provider, payload);
    let usage = extract_usage_stats(payload);

    let (raw_text, provider_reasoning) = match provider {
        AIProviderType::Anthropic => (
            extract_anthropic_response_text(payload),
            extract_anthropic_reasoning(payload),
        ),
        AIProviderType::Gemini | AIProviderType::Vertex => (
            extract_gemini_response_text(payload),
            extract_gemini_reasoning(payload),
        ),
        _ => (
            extract_openai_like_response_text(payload),
            extract_openai_like_reasoning(payload),
        ),
    };

    let (think_reasoning, cleaned_text) = match raw_text {
        Some(text) => split_think_block(&text),
        None => (None, String::new()),
    };
    let reasoning = provider_reasoning.or(think_reasoning);

    if cleaned_text.is_empty() && tool_calls.is_empty() && reasoning.is_none() {
        return None;
    }

    let text = if cleaned_text.is_empty() && !tool_calls.is_empty() && !used_canonical_tools {
        format_tool_call_as_action_json(&tool_calls[0]).unwrap_or_default()
    } else {
        cleaned_text
    };

    Some(AIResponse {
        text,
        reasoning,
        tool_calls,
        thought_signature,
        usage,
        error: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::ai_models::AIProviderType;
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

    #[test]
    fn tool_call_stream_accumulates_multiple_parallel_openai_calls_and_empty_args() {
        let mut state = ToolCallStreamState::default();
        let mut preview = String::new();
        for payload in [
            json!({
                "choices": [{
                    "delta": {
                        "tool_calls": [
                            { "index": 0, "id": "call_a", "function": { "name": "list_tables", "arguments": "" } },
                            { "index": 1, "id": "call_b", "function": { "name": "describe_table", "arguments": "{\"table\":" } }
                        ]
                    }
                }]
            }),
            json!({
                "choices": [{
                    "delta": {
                        "tool_calls": [
                            { "index": 1, "function": { "arguments": "\"orders\"}" } }
                        ]
                    }
                }]
            }),
            json!({ "choices": [{ "delta": {}, "finish_reason": "tool_calls" }] }),
        ] {
            for fragment in state.push_payload(&AIProviderType::OpenAI, &payload) {
                preview.push_str(&fragment);
            }
        }

        // Zero-arg preview must still be valid JSON (never `"args":,"message"`).
        let parsed_preview: serde_json::Value = serde_json::from_str(&preview).unwrap();
        assert_eq!(parsed_preview["action"], "list_tables");
        assert_eq!(parsed_preview["args"], json!({}));

        let (calls, sig) = state.into_finalized();
        assert!(sig.is_none());
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].id, "call_a");
        assert_eq!(calls[0].name, "list_tables");
        assert_eq!(calls[0].arguments, json!({}));
        assert_eq!(calls[1].id, "call_b");
        assert_eq!(calls[1].name, "describe_table");
        assert_eq!(calls[1].arguments, json!({ "table": "orders" }));
    }

    #[test]
    fn tool_call_stream_accumulates_anthropic_parallel_blocks_and_thinking_signature() {
        let mut state = ToolCallStreamState::default();
        for payload in [
            json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "thinking", "thinking": "" } }),
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "signature_delta", "signature": "sig_part1_" } }),
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "signature_delta", "signature": "part2" } }),
            json!({ "type": "content_block_stop", "index": 0 }),
            json!({ "type": "content_block_start", "index": 1, "content_block": { "type": "tool_use", "id": "toolu_1", "name": "describe_table" } }),
            json!({ "type": "content_block_delta", "index": 1, "delta": { "type": "input_json_delta", "partial_json": "{\"table\":\"users\"}" } }),
            json!({ "type": "content_block_stop", "index": 1 }),
            json!({ "type": "content_block_start", "index": 2, "content_block": { "type": "tool_use", "id": "toolu_2", "name": "list_tables" } }),
            json!({ "type": "content_block_stop", "index": 2 }),
            json!({ "type": "message_stop" }),
        ] {
            let _ = state.push_payload(&AIProviderType::Anthropic, &payload);
        }

        let (calls, sig) = state.into_finalized();
        assert_eq!(sig.as_deref(), Some("sig_part1_part2"));
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].id, "toolu_1");
        assert_eq!(calls[0].arguments, json!({ "table": "users" }));
        assert_eq!(calls[1].id, "toolu_2");
        assert_eq!(calls[1].arguments, json!({}));
    }

    #[test]
    fn merge_usage_stats_combines_anthropic_message_start_and_delta_tokens() {
        let mut acc = None;
        let start = json!({
            "type": "message_start",
            "message": {
                "usage": {
                    "input_tokens": 1200,
                    "cache_read_input_tokens": 900,
                    "output_tokens": 1
                }
            }
        });
        let delta = json!({
            "type": "message_delta",
            "usage": { "output_tokens": 85 }
        });

        let first = merge_usage_stats(&mut acc, &start).unwrap();
        assert_eq!(first.input_tokens, Some(1200));
        assert_eq!(first.cache_read_input_tokens, Some(900));

        let final_stats = merge_usage_stats(&mut acc, &delta).unwrap();
        assert_eq!(final_stats.input_tokens, Some(1200));
        assert_eq!(final_stats.output_tokens, Some(85));
        assert_eq!(final_stats.total_tokens, Some(1285));
        assert_eq!(final_stats.cache_read_input_tokens, Some(900));
    }

    #[test]
    fn extract_provider_response_preserves_reasoning_signature_and_parallel_calls() {
        let gemini_payload = json!({
            "candidates": [{
                "content": {
                    "parts": [
                        { "text": "Plan: inspect both tables", "thought": true },
                        { "text": "Checking schema..." },
                        {
                            "functionCall": { "name": "describe_table", "args": { "table": "users" } },
                            "thoughtSignature": "gemini-sig-42"
                        },
                        {
                            "functionCall": { "name": "describe_table", "args": { "table": "orders" } }
                        }
                    ]
                }
            }],
            "usageMetadata": {
                "promptTokenCount": 500,
                "candidatesTokenCount": 60,
                "totalTokenCount": 560
            }
        });

        let resp =
            extract_provider_response(&AIProviderType::Gemini, &gemini_payload, true).unwrap();
        assert_eq!(resp.text, "Checking schema...");
        assert_eq!(resp.reasoning.as_deref(), Some("Plan: inspect both tables"));
        assert_eq!(resp.thought_signature.as_deref(), Some("gemini-sig-42"));
        assert_eq!(resp.tool_calls.len(), 2);
        assert_eq!(resp.tool_calls[0].id, "call_1");
        assert_eq!(resp.tool_calls[1].id, "call_2");
        assert_eq!(resp.usage.as_ref().unwrap().total_tokens, Some(560));
    }
}
