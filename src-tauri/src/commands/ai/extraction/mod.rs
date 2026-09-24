mod stream;
mod text;
mod tool_calls;

pub(crate) use stream::*;
pub(crate) use text::*;
pub(crate) use tool_calls::*;

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
}
