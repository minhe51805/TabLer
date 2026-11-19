use super::endpoints::validate_ai_endpoint;
use super::execution::{execute_ai_request, execute_ai_stream_request_with_sink};
use super::extraction::{extract_stream_deltas, ToolCallStreamState};
use super::providers::is_thinking_param_rejection;
use super::AIRequestCancellationState;
use crate::commands::query::{SandboxCallerScope, SandboxGateState, SANDBOX_MAX_CONCURRENCY};
use crate::config::AI_STREAM_CHUNK_IDLE_TIMEOUT;
use crate::database::ai_models::{
    AIProviderConfig, AIProviderType, AIRequest, AIRequestIntent, AIRequestMode,
    AIResponseLanguage, CanonicalToolSpec,
};
use crate::error::{AppError, ErrorCode};
use crate::storage::ai_storage::AIStorage;
use crate::utils::rate_limiter::{AIRequestLimiter, SandboxExecutionLimiter};
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Mutex, Notify};
use tokio::time::{advance, timeout, Duration};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

fn test_custom_config(
    provider_id: &str,
    endpoint: String,
    model: &str,
    api_format: Option<&str>,
) -> AIProviderConfig {
    AIProviderConfig {
        id: provider_id.to_string(),
        name: "Test Mock Provider".to_string(),
        provider_type: AIProviderType::Custom,
        endpoint,
        model: model.to_string(),
        fast_model: None,
        is_enabled: true,
        is_primary: true,
        allow_schema_context: false,
        allow_inline_completion: true,
        api_format: api_format.map(str::to_string),
        models: vec![model.to_string()],
        disabled_models: Vec::new(),
        model_settings: HashMap::new(),
    }
}

fn test_ai_request(provider_id: &str, request_id: &str, prompt: &str) -> AIRequest {
    AIRequest {
        request_id: Some(request_id.to_string()),
        provider_id: Some(provider_id.to_string()),
        model: None,
        prompt: prompt.to_string(),
        context: String::new(),
        mode: AIRequestMode::Panel,
        intent: AIRequestIntent::Agent,
        language: AIResponseLanguage::Vi,
        history: Vec::new(),
        attachments: Vec::new(),
        canonical_tools: Some(vec![
            CanonicalToolSpec {
                name: "list_tables".to_string(),
                description: "List tables".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": { "schema": { "type": "string" } }
                }),
            },
            CanonicalToolSpec {
                name: "describe_table".to_string(),
                description: "Describe a table".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": { "table": { "type": "string" } }
                }),
            },
        ]),
        allow_native_memory_tool: false,
        agent_turns: Vec::new(),
        tools: None,
        tool_choice: None,
        enable_thinking: Some(true),
    }
}

fn make_temp_ai_storage(config: &AIProviderConfig) -> (PathBuf, AIStorage) {
    let dir = std::env::temp_dir().join(format!("tabler-adv-ai-{}", Uuid::new_v4()));
    let storage = AIStorage::from_data_dir(dir.clone()).expect("temp AIStorage");
    storage
        .save_providers(std::slice::from_ref(config), &HashMap::new(), &[])
        .expect("save provider config");
    (dir, storage)
}

async fn read_http_request(stream: &mut TcpStream) -> String {
    let mut raw = Vec::new();
    let mut buf = [0u8; 4096];
    let mut header_end: Option<usize> = None;
    let mut content_length: usize = 0;

    loop {
        let n = stream.read(&mut buf).await.expect("read socket");
        if n == 0 {
            break;
        }
        raw.extend_from_slice(&buf[..n]);
        if header_end.is_none() {
            if let Some(pos) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                header_end = Some(pos + 4);
                let headers_str = String::from_utf8_lossy(&raw[..pos]);
                for line in headers_str.lines() {
                    if let Some((name, val)) = line.split_once(':') {
                        if name.trim().eq_ignore_ascii_case("content-length") {
                            content_length = val.trim().parse::<usize>().unwrap_or(0);
                        }
                    }
                }
            }
        }
        if let Some(end) = header_end {
            if raw.len() >= end + content_length {
                break;
            }
        }
    }

    String::from_utf8_lossy(&raw).into_owned()
}

fn extract_http_body(raw_http: &str) -> serde_json::Value {
    let (_, body) = raw_http.split_once("\r\n\r\n").expect("HTTP separator");
    serde_json::from_str(body).expect("JSON request body")
}

#[tokio::test]
async fn tcp_sse_reassembles_fragmented_utf8_reasoning_and_parallel_tool_calls() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    // "Tổng doanh thu quý 4" UTF-8:
    // 'ổ' = [0xE1, 0xBB, 0x95], 'ý' = [0xC3, 0xBD]
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let _req = read_http_request(&mut socket).await;

        socket
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n",
            )
            .await
            .unwrap();
        socket.flush().await.unwrap();

        // Split mid-`data:` token across two TCP writes.
        socket.write_all(b"da").await.unwrap();
        socket.flush().await.unwrap();
        tokio::time::sleep(Duration::from_millis(5)).await;

        socket
            .write_all(b"ta: {\"choices\":[{\"delta\":{\"reasoning_content\":\"B\xC6\xB0\xE1\xBB\x9Bc 1: \"}}]}\n\n")
            .await
            .unwrap();
        socket.flush().await.unwrap();
        tokio::time::sleep(Duration::from_millis(5)).await;

        // Split mid-multibyte UTF-8 sequence inside "Tổng doanh thu quý 4".
        let mut utf8_part1 = b"data: {\"choices\":[{\"delta\":{\"content\":\"T".to_vec();
        utf8_part1.extend_from_slice(&[0xE1, 0xBB]); // first 2 of 3 bytes for 'ổ'
        socket.write_all(&utf8_part1).await.unwrap();
        socket.flush().await.unwrap();
        tokio::time::sleep(Duration::from_millis(5)).await;

        let mut utf8_part2 = vec![0x95]; // final byte of 'ổ'
        utf8_part2.extend_from_slice(b"ng doanh thu qu");
        utf8_part2.push(0xC3); // first byte of 'ý'
        socket.write_all(&utf8_part2).await.unwrap();
        socket.flush().await.unwrap();
        tokio::time::sleep(Duration::from_millis(5)).await;

        let mut utf8_part3 = vec![0xBD]; // second byte of 'ý'
        utf8_part3.extend_from_slice(b" 4\"}}]}\n\n");
        socket.write_all(&utf8_part3).await.unwrap();
        socket.flush().await.unwrap();
        tokio::time::sleep(Duration::from_millis(5)).await;

        // Interleaved reasoning delta.
        socket
            .write_all(
                b"data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"Ki\xE1\xBB\x83m tra b\xE1\xBA\xA3ng.\"}}]}\n\n",
            )
            .await
            .unwrap();
        socket.flush().await.unwrap();
        tokio::time::sleep(Duration::from_millis(5)).await;

        // 2 parallel streamed tool calls, split mid-JSON token across TCP writes.
        socket
            .write_all(
                b"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"list_tables\",\"arguments\":\"{\\\"sche",
            )
            .await
            .unwrap();
        socket.flush().await.unwrap();
        tokio::time::sleep(Duration::from_millis(5)).await;

        socket
            .write_all(
                b"ma\\\":\\\"public\\\"}\"}},{\"index\":1,\"id\":\"call_2\",\"type\":\"function\",\"function\":{\"name\":\"describe_table\",\"arguments\":\"{\\\"table\\\":\\\"orders\\\"}\"}}]}}]}\n\n",
            )
            .await
            .unwrap();
        socket.flush().await.unwrap();
        tokio::time::sleep(Duration::from_millis(5)).await;

        socket
            .write_all(b"data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n")
            .await
            .unwrap();
        socket.flush().await.unwrap();
    });

    let config = test_custom_config(
        "p-sse-openai",
        format!("http://{addr}/v1/chat/completions"),
        "gpt-mock-stream",
        Some("chat-completions"),
    );
    let (temp_dir, storage) = make_temp_ai_storage(&config);
    let limiter = AIRequestLimiter::new(Duration::from_secs(60), 5, "Too many AI requests");
    let request = test_ai_request("p-sse-openai", "req-sse-1", "Phân tích doanh thu");
    let mut events = Vec::new();

    let response = execute_ai_stream_request_with_sink(
        request,
        &storage,
        &limiter,
        CancellationToken::new(),
        AI_STREAM_CHUNK_IDLE_TIMEOUT,
        |kind, text, usage| {
            events.push((kind, text, usage));
            Ok(())
        },
    )
    .await
    .expect("real streaming execution should succeed");

    server.await.unwrap();
    let _ = std::fs::remove_dir_all(temp_dir);

    assert_eq!(response.text, "Tổng doanh thu quý 4");
    assert!(!response.text.contains('\u{FFFD}'));
    assert_eq!(
        response.reasoning.as_deref(),
        Some("Bước 1: Kiểm tra bảng.")
    );
    assert_eq!(response.tool_calls.len(), 2);
    assert_eq!(response.tool_calls[0].id, "call_1");
    assert_eq!(response.tool_calls[0].name, "list_tables");
    assert_eq!(
        response.tool_calls[0].arguments,
        json!({ "schema": "public" })
    );
    assert_eq!(response.tool_calls[1].id, "call_2");
    assert_eq!(response.tool_calls[1].name, "describe_table");
    assert_eq!(
        response.tool_calls[1].arguments,
        json!({ "table": "orders" })
    );
    assert_eq!(response.thought_signature, None);
    assert!(events
        .iter()
        .any(|(kind, text, _)| *kind == "text_delta"
            && text.as_deref() == Some("Tổng doanh thu quý 4")));
    assert!(events.iter().any(|(kind, _, _)| *kind == "reasoning_delta"));
}

#[tokio::test]
async fn tcp_anthropic_sse_reassembles_thinking_signature_and_parallel_tool_calls() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let _req = read_http_request(&mut socket).await;

        socket
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
            )
            .await
            .unwrap();
        socket.flush().await.unwrap();

        let frames = [
            "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\n",
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"Suy luận.\"}}\n\n",
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"sig-ant-1\"}}\n\n",
            "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"Tổng doanh thu quý 4\"}}\n\n",
            "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":2,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"list_tables\",\"input\":{}}}\n\n",
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":2,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"schema\\\":\\\"app\\\"}\"}}\n\n",
            "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":2}\n\n",
            "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":3,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_2\",\"name\":\"describe_table\",\"input\":{}}}\n\n",
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":3,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"table\\\":\\\"users\\\"}\"}}\n\n",
            "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
        ];

        for frame in frames {
            socket.write_all(frame.as_bytes()).await.unwrap();
            socket.flush().await.unwrap();
            tokio::time::sleep(Duration::from_millis(3)).await;
        }
    });

    let model = format!("claude-sonnet-4-sse-{}", Uuid::new_v4());
    let config = test_custom_config(
        "p-sse-anthropic",
        format!("http://{addr}/v1/messages"),
        &model,
        Some("anthropic"),
    );
    let (temp_dir, storage) = make_temp_ai_storage(&config);
    let limiter = AIRequestLimiter::new(Duration::from_secs(60), 5, "Too many AI requests");
    let request = test_ai_request("p-sse-anthropic", "req-sse-ant", "Phân tích");

    let response = execute_ai_stream_request_with_sink(
        request,
        &storage,
        &limiter,
        CancellationToken::new(),
        AI_STREAM_CHUNK_IDLE_TIMEOUT,
        |_, _, _| Ok(()),
    )
    .await
    .expect("anthropic real streaming execution should succeed");

    server.await.unwrap();
    let _ = std::fs::remove_dir_all(temp_dir);

    assert_eq!(response.text, "Tổng doanh thu quý 4");
    assert_eq!(response.reasoning.as_deref(), Some("Suy luận."));
    assert_eq!(response.thought_signature.as_deref(), Some("sig-ant-1"));
    assert_eq!(response.tool_calls.len(), 2);
    assert_eq!(response.tool_calls[0].id, "toolu_1");
    assert_eq!(response.tool_calls[0].arguments, json!({ "schema": "app" }));
    assert_eq!(response.tool_calls[1].id, "toolu_2");
    assert_eq!(
        response.tool_calls[1].arguments,
        json!({ "table": "users" })
    );
}

#[test]
fn gemini_sse_extracts_thought_signature_and_parallel_calls_while_loopback_http_is_blocked() {
    // Documented boundary: `validate_ai_endpoint` blocks plain HTTP / 127.0.0.1 for Gemini,
    // so Gemini wire execution cannot hit a local plain-HTTP TcpListener directly.
    let gemini_local = AIProviderConfig {
        id: "gem-local".to_string(),
        name: "Gemini".to_string(),
        provider_type: AIProviderType::Gemini,
        endpoint: "http://127.0.0.1:9999/v1beta/models/gemini-2.5-flash:generateContent"
            .to_string(),
        model: "gemini-2.5-flash".to_string(),
        fast_model: None,
        is_enabled: true,
        is_primary: true,
        allow_schema_context: false,
        allow_inline_completion: false,
        api_format: None,
        models: Vec::new(),
        disabled_models: Vec::new(),
        model_settings: HashMap::new(),
    };
    assert!(validate_ai_endpoint(&gemini_local, &gemini_local.endpoint).is_err());

    let frames = [
        json!({
            "candidates": [{
                "content": { "parts": [{ "text": "Checking schema.", "thought": true }] }
            }]
        }),
        json!({
            "candidates": [{
                "content": { "parts": [{ "text": "Tổng doanh thu quý 4" }] }
            }]
        }),
        json!({
            "candidates": [{
                "content": {
                    "parts": [
                        {
                            "thoughtSignature": "gem-sig-abc",
                            "functionCall": { "id": "g1", "name": "list_tables", "args": { "schema": "public" } }
                        },
                        {
                            "functionCall": { "id": "g2", "name": "describe_table", "args": { "table": "orders" } }
                        }
                    ]
                }
            }]
        }),
    ];

    let mut tool_state = ToolCallStreamState::default();
    let mut text = String::new();
    let mut reasoning = String::new();
    for frame in &frames {
        let _ = tool_state.push_payload(&AIProviderType::Gemini, frame);
        let (t, r) = extract_stream_deltas(&AIProviderType::Gemini, frame);
        if let Some(t) = t {
            text.push_str(&t);
        }
        if let Some(r) = r {
            reasoning.push_str(&r);
        }
    }
    let (calls, sig) = tool_state.into_finalized();
    assert_eq!(text, "Tổng doanh thu quý 4");
    assert_eq!(reasoning, "Checking schema.");
    assert_eq!(sig.as_deref(), Some("gem-sig-abc"));
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].name, "list_tables");
    assert_eq!(calls[1].name, "describe_table");
}

#[tokio::test]
async fn tcp_malformed_tool_call_arguments_preserve_unparsed_raw_string_without_silent_empty_fallback(
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let server = tokio::spawn(async move {
        // Connection 1: non-streaming `execute_ai_request`
        let (mut s1, _) = listener.accept().await.unwrap();
        let _req1 = read_http_request(&mut s1).await;
        let body1 = json!({
            "choices": [{
                "message": {
                    "content": null,
                    "tool_calls": [{
                        "id": "call_bad_1",
                        "type": "function",
                        "function": {
                            "name": "run_readonly_sql",
                            "arguments": "{\"sql\": \"SELECT 1"
                        }
                    }]
                }
            }]
        })
        .to_string();
        let resp1 = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body1.len(),
            body1
        );
        s1.write_all(resp1.as_bytes()).await.unwrap();
        s1.flush().await.unwrap();

        // Connection 2: streaming SSE with truncated JSON args
        let (mut s2, _) = listener.accept().await.unwrap();
        let _req2 = read_http_request(&mut s2).await;
        s2.write_all(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
        )
        .await
        .unwrap();
        s2.write_all(
            b"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_bad_2\",\"function\":{\"name\":\"run_readonly_sql\",\"arguments\":\"{\\\"sql\\\": \\\"\"}}]}}]}\n\n",
        )
        .await
        .unwrap();
        s2.write_all(
            b"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"SELECT 1\"}}]}}]}\n\n",
        )
        .await
        .unwrap();
        s2.write_all(
            b"data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n",
        )
        .await
        .unwrap();
        s2.flush().await.unwrap();
    });

    let config = test_custom_config(
        "p-malformed-args",
        format!("http://{addr}/v1/chat/completions"),
        "gpt-mock-malformed",
        Some("chat-completions"),
    );
    let (temp_dir, storage) = make_temp_ai_storage(&config);
    let limiter = AIRequestLimiter::new(Duration::from_secs(60), 10, "Rate limited");

    let req1 = test_ai_request("p-malformed-args", "req-bad-1", "Run SQL");
    let res1 = execute_ai_request(req1, &storage, &limiter, CancellationToken::new())
        .await
        .expect("gateway returns AIResponse with unparsedArguments marker");
    assert_eq!(res1.tool_calls.len(), 1);
    assert_ne!(res1.tool_calls[0].arguments, json!({}));
    assert_eq!(
        res1.tool_calls[0].arguments,
        json!({ "unparsedArguments": "{\"sql\": \"SELECT 1" })
    );

    let req2 = test_ai_request("p-malformed-args", "req-bad-2", "Run SQL stream");
    let res2 = execute_ai_stream_request_with_sink(
        req2,
        &storage,
        &limiter,
        CancellationToken::new(),
        AI_STREAM_CHUNK_IDLE_TIMEOUT,
        |_, _, _| Ok(()),
    )
    .await
    .expect("streaming gateway returns AIResponse with unparsedArguments marker");
    assert_eq!(res2.tool_calls.len(), 1);
    assert_ne!(res2.tool_calls[0].arguments, json!({}));
    assert_eq!(
        res2.tool_calls[0].arguments,
        json!({ "unparsedArguments": "{\"sql\": \"SELECT 1" })
    );

    server.await.unwrap();
    let _ = std::fs::remove_dir_all(temp_dir);
}

#[tokio::test]
async fn tcp_400_thinking_self_heal_strips_thinking_once_without_double_consuming_rate_limiter() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let received_bodies = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
    let captured = Arc::clone(&received_bodies);

    let server = tokio::spawn(async move {
        // Request 1 -> 400 rejecting `budget_tokens` (matched by `THINKING_PARAMS`)
        {
            let (mut s1, _) = listener.accept().await.unwrap();
            let raw1 = read_http_request(&mut s1).await;
            captured.lock().await.push(extract_http_body(&raw1));
            let err_body = json!({
                "error": {
                    "message": "Extra inputs are not permitted: budget_tokens"
                }
            })
            .to_string();
            let resp1 = format!(
                "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                err_body.len(),
                err_body
            );
            s1.write_all(resp1.as_bytes()).await.unwrap();
            s1.flush().await.unwrap();
        }

        // Request 2 -> 200 OK after stripping thinking
        let Ok(Ok((mut s2, _))) = timeout(Duration::from_secs(3), listener.accept()).await else {
            return;
        };
        let raw2 = read_http_request(&mut s2).await;
        captured.lock().await.push(extract_http_body(&raw2));
        let ok_body = json!({
            "content": [{ "type": "text", "text": "Self-healed OK" }]
        })
        .to_string();
        let resp2 = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            ok_body.len(),
            ok_body
        );
        s2.write_all(resp2.as_bytes()).await.unwrap();
        s2.flush().await.unwrap();
    });

    // Must match `anthropic_model_supports_thinking` and be unique across tests.
    let model = format!("claude-sonnet-4-selfheal-{}", Uuid::new_v4());
    let config = test_custom_config(
        "p-selfheal",
        format!("http://{addr}/v1/messages"),
        &model,
        Some("anthropic"),
    );
    let (temp_dir, storage) = make_temp_ai_storage(&config);

    // Rate limit = 1 attempt! Double-consuming on the 400 retry would immediately fail.
    let limiter = AIRequestLimiter::new(Duration::from_secs(60), 1, "Too many AI requests");
    let cancellation_state = AIRequestCancellationState::default();
    let request_id = "req-selfheal-1";
    let token = CancellationToken::new();
    cancellation_state.register(request_id, token.clone()).await;

    let request = test_ai_request("p-selfheal", request_id, "Explain index");
    let result = execute_ai_request(request, &storage, &limiter, token).await;
    cancellation_state.finish(request_id).await;

    server.await.unwrap();

    let response = result.expect("400 thinking self-heal should retry once and succeed");
    assert_eq!(response.text, "Self-healed OK");

    let bodies = received_bodies.lock().await;
    assert_eq!(bodies.len(), 2);
    assert!(
        bodies[0].get("thinking").is_some(),
        "first request must carry thinking param"
    );
    assert!(
        bodies[1].get("thinking").is_none(),
        "second request must strip thinking param"
    );
    assert_eq!(bodies[1]["max_tokens"], json!(4096));

    // Cancellation map must be empty afterward.
    assert!(!cancellation_state.cancel(request_id).await);

    // Limiter must have recorded exactly 1 attempt (not 0, not 2); a second call is rejected.
    assert!(limiter.check("p-selfheal:Panel").await.is_err());

    // `reasoning_effort` must also trigger thinking self-heal detection.
    assert!(is_thinking_param_rejection(
        r#"{"error":{"message":"Unsupported parameter: reasoning_effort"}}"#
    ));

    let _ = std::fs::remove_dir_all(temp_dir);
}

#[tokio::test]
async fn tcp_400_json_escaped_thinking_message_must_trigger_self_heal() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let server = tokio::spawn(async move {
        {
            let (mut s1, _) = listener.accept().await.unwrap();
            let _raw1 = read_http_request(&mut s1).await;
            let err_body = json!({
                "error": {
                    "message": "Unsupported parameter: \"thinking\" is not supported on this model"
                }
            })
            .to_string();
            let resp1 = format!(
                "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                err_body.len(),
                err_body
            );
            s1.write_all(resp1.as_bytes()).await.unwrap();
            s1.flush().await.unwrap();
        }

        let Ok(Ok((mut s2, _))) = timeout(Duration::from_secs(1), listener.accept()).await else {
            return;
        };
        let _raw2 = read_http_request(&mut s2).await;
        let ok_body = json!({
            "content": [{ "type": "text", "text": "Self-healed escaped OK" }]
        })
        .to_string();
        let resp2 = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            ok_body.len(),
            ok_body
        );
        s2.write_all(resp2.as_bytes()).await.unwrap();
        s2.flush().await.unwrap();
    });

    let model = format!("claude-sonnet-4-escaped-{}", Uuid::new_v4());
    let config = test_custom_config(
        "p-selfheal-escaped",
        format!("http://{addr}/v1/messages"),
        &model,
        Some("anthropic"),
    );
    let (temp_dir, storage) = make_temp_ai_storage(&config);
    let limiter = AIRequestLimiter::new(Duration::from_secs(60), 1, "Too many AI requests");

    let request = test_ai_request("p-selfheal-escaped", "req-selfheal-escaped", "Explain");
    let result = execute_ai_request(request, &storage, &limiter, CancellationToken::new()).await;

    server.await.unwrap();
    let _ = std::fs::remove_dir_all(temp_dir);

    assert!(
        result.is_ok(),
        "BUG: JSON-escaped \\\"thinking\\\" in 400 error body fails is_thinking_param_rejection (providers/mod.rs:168 & execution.rs:181; providers/tests.rs:13 tested non-JSON string): {result:?}"
    );
}

#[tokio::test]
async fn tcp_mid_stream_cancellation_returns_non_retryable_ai_cancelled_and_clears_map() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let hold_open = Arc::new(Notify::new());
    let hold_open_server = Arc::clone(&hold_open);

    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let _req = read_http_request(&mut socket).await;

        socket
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
            )
            .await
            .unwrap();
        socket
            .write_all(b"data: {\"choices\":[{\"delta\":{\"content\":\"chunk-1\"}}]}\n\n")
            .await
            .unwrap();
        socket.flush().await.unwrap();

        // Keep TCP stream open until client cancels.
        hold_open_server.notified().await;
    });

    let config = test_custom_config(
        "p-cancel",
        format!("http://{addr}/v1/chat/completions"),
        "gpt-mock-cancel",
        Some("chat-completions"),
    );
    let (temp_dir, storage) = make_temp_ai_storage(&config);
    let limiter = AIRequestLimiter::new(Duration::from_secs(60), 5, "Too many AI requests");
    let request = test_ai_request("p-cancel", "req-cancel-1", "Long stream");
    let cancellation_state = Arc::new(AIRequestCancellationState::default());
    let token = CancellationToken::new();
    cancellation_state
        .register("req-cancel-1", token.clone())
        .await;

    let chunk1_received = Arc::new(Notify::new());
    let chunk1_received_sink = Arc::clone(&chunk1_received);
    let cancel_state_clone = Arc::clone(&cancellation_state);
    let exec_handle = tokio::spawn(async move {
        let mut saw_chunk1 = false;
        let res = execute_ai_stream_request_with_sink(
            request,
            &storage,
            &limiter,
            token,
            AI_STREAM_CHUNK_IDLE_TIMEOUT,
            |kind, text, _| {
                if kind == "text_delta" && text.as_deref() == Some("chunk-1") && !saw_chunk1 {
                    saw_chunk1 = true;
                    chunk1_received_sink.notify_one();
                }
                Ok(())
            },
        )
        .await;
        cancel_state_clone.finish("req-cancel-1").await;
        res
    });

    // Wait for chunk 1 to pass through the real SSE sink over TCP before cancelling.
    chunk1_received.notified().await;
    assert!(cancellation_state.cancel("req-cancel-1").await);

    let err = exec_handle
        .await
        .unwrap()
        .expect_err("cancelled stream must return Err");
    hold_open.notify_one();
    server.await.unwrap();
    let _ = std::fs::remove_dir_all(temp_dir);

    assert_eq!(err.code(), ErrorCode::AiCancelled);
    assert!(cancellation_state.active.lock().await.is_empty());
    assert!(!cancellation_state.cancel("req-cancel-1").await);
    assert!(
        !err.retryable(),
        "ErrorCode::AiCancelled must not be retryable"
    );
}

#[tokio::test(start_paused = true)]
async fn tcp_stream_chunk_idle_timeout_triggers_ai_timeout_on_stalled_stream() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let release_server = Arc::new(Notify::new());
    let release_server_bg = Arc::clone(&release_server);

    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let _req = read_http_request(&mut socket).await;

        socket
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
            )
            .await
            .unwrap();
        socket
            .write_all(b"data: {\"choices\":[{\"delta\":{\"content\":\"first\"}}]}\n\n")
            .await
            .unwrap();
        socket.flush().await.unwrap();

        // Stall indefinitely after chunk 1.
        release_server_bg.notified().await;
    });

    let config = test_custom_config(
        "p-timeout",
        format!("http://{addr}/v1/chat/completions"),
        "gpt-mock-timeout",
        Some("chat-completions"),
    );
    let (temp_dir, storage) = make_temp_ai_storage(&config);
    let limiter = AIRequestLimiter::new(Duration::from_secs(60), 5, "Too many AI requests");
    let request = test_ai_request("p-timeout", "req-timeout-1", "Stall test");
    let token = CancellationToken::new();

    let chunk1_received = Arc::new(Notify::new());
    let chunk1_received_sink = Arc::clone(&chunk1_received);
    let timeout_task = tokio::spawn(async move {
        let mut saw_first = false;
        execute_ai_stream_request_with_sink(
            request,
            &storage,
            &limiter,
            token,
            AI_STREAM_CHUNK_IDLE_TIMEOUT,
            |kind, text, _| {
                if kind == "text_delta" && text.as_deref() == Some("first") && !saw_first {
                    saw_first = true;
                    chunk1_received_sink.notify_one();
                }
                Ok(())
            },
        )
        .await
    });

    chunk1_received.notified().await;
    tokio::task::yield_now().await;
    advance(AI_STREAM_CHUNK_IDLE_TIMEOUT + Duration::from_secs(1)).await;

    let err = timeout_task
        .await
        .unwrap()
        .expect_err("stalled stream must time out");
    assert_eq!(err.code(), ErrorCode::AiTimeout);
    assert!(err.retryable());

    release_server.notify_one();
    server.await.unwrap();
    let _ = std::fs::remove_dir_all(temp_dir);
}

#[tokio::test]
async fn tcp_malformed_sse_json_frame_returns_invalid_response_error() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let _req = read_http_request(&mut socket).await;
        socket
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
            )
            .await
            .unwrap();
        socket
            .write_all(b"data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n")
            .await
            .unwrap();
        socket
            .write_all(b"data: {\"choices\":[{\"delta\":\n\n")
            .await
            .unwrap();
        socket.flush().await.unwrap();
    });

    let config = test_custom_config(
        "p-bad-sse",
        format!("http://{addr}/v1/chat/completions"),
        "gpt-mock-bad-sse",
        Some("chat-completions"),
    );
    let (temp_dir, storage) = make_temp_ai_storage(&config);
    let limiter = AIRequestLimiter::new(Duration::from_secs(60), 5, "Too many AI requests");
    let request = test_ai_request("p-bad-sse", "req-bad-sse-1", "Check SSE error");

    let err = execute_ai_stream_request_with_sink(
        request,
        &storage,
        &limiter,
        CancellationToken::new(),
        AI_STREAM_CHUNK_IDLE_TIMEOUT,
        |_, _, _| Ok(()),
    )
    .await
    .expect_err("truncated SSE JSON frame must fail instead of being silently dropped");

    server.await.unwrap();
    let _ = std::fs::remove_dir_all(temp_dir);
    assert_eq!(err.code(), ErrorCode::AiInvalidResponse);
}

#[tokio::test]
async fn sandbox_gate_agent_saturation_must_not_starve_workspace_scope() {
    let gate = Arc::new(SandboxGateState::default());

    // 1) Saturate all Agent permits -> Workspace must still execute immediately.
    let release_agents = Arc::new(Notify::new());
    let acquired_agents = Arc::new(AtomicUsize::new(0));
    let all_agents_acquired = Arc::new(Notify::new());
    let mut agent_handles = Vec::new();
    for _ in 0..SANDBOX_MAX_CONCURRENCY {
        let gate = Arc::clone(&gate);
        let release = Arc::clone(&release_agents);
        let count = Arc::clone(&acquired_agents);
        let all_done = Arc::clone(&all_agents_acquired);
        agent_handles.push(tokio::spawn(async move {
            let _permit = gate
                .acquire_execution_slot_for_scope(SandboxCallerScope::Agent)
                .await
                .unwrap();
            let agent_key = SandboxCallerScope::Agent.scoped_key("conn-shared");
            let _probe = gate.enter_breaker(&agent_key).await.unwrap();
            if count.fetch_add(1, Ordering::SeqCst) + 1 == SANDBOX_MAX_CONCURRENCY {
                all_done.notify_one();
            }
            release.notified().await;
        }));
    }

    all_agents_acquired.notified().await;

    let gate_ws = Arc::clone(&gate);
    let ws_task = tokio::spawn(async move {
        let workspace_key = SandboxCallerScope::Workspace.scoped_key("conn-shared");
        let _probe = gate_ws.enter_breaker(&workspace_key).await?;
        let _permit = gate_ws
            .acquire_execution_slot_for_scope(SandboxCallerScope::Workspace)
            .await?;
        Ok::<(), AppError>(())
    });

    let ws_result = timeout(Duration::from_millis(150), ws_task).await;

    release_agents.notify_waiters();
    for h in agent_handles {
        h.await.unwrap();
    }

    assert!(
        ws_result.is_ok(),
        "Agent saturation must not block Workspace scope"
    );
    assert!(ws_result.unwrap().unwrap().is_ok());

    // 2) Reverse direction: saturate all Workspace permits -> Agent must still execute immediately.
    let release_ws = Arc::new(Notify::new());
    let acquired_ws = Arc::new(AtomicUsize::new(0));
    let all_ws_acquired = Arc::new(Notify::new());
    let mut ws_handles = Vec::new();
    for _ in 0..SANDBOX_MAX_CONCURRENCY {
        let gate = Arc::clone(&gate);
        let release = Arc::clone(&release_ws);
        let count = Arc::clone(&acquired_ws);
        let all_done = Arc::clone(&all_ws_acquired);
        ws_handles.push(tokio::spawn(async move {
            let _permit = gate
                .acquire_execution_slot_for_scope(SandboxCallerScope::Workspace)
                .await
                .unwrap();
            let ws_key = SandboxCallerScope::Workspace.scoped_key("conn-shared");
            let _probe = gate.enter_breaker(&ws_key).await.unwrap();
            if count.fetch_add(1, Ordering::SeqCst) + 1 == SANDBOX_MAX_CONCURRENCY {
                all_done.notify_one();
            }
            release.notified().await;
        }));
    }

    all_ws_acquired.notified().await;

    let gate_agent = Arc::clone(&gate);
    let agent_task = tokio::spawn(async move {
        let agent_key = SandboxCallerScope::Agent.scoped_key("conn-shared");
        let _probe = gate_agent.enter_breaker(&agent_key).await?;
        let _permit = gate_agent
            .acquire_execution_slot_for_scope(SandboxCallerScope::Agent)
            .await?;
        Ok::<(), AppError>(())
    });

    let agent_result = timeout(Duration::from_millis(150), agent_task).await;

    release_ws.notify_waiters();
    for h in ws_handles {
        h.await.unwrap();
    }

    assert!(
        agent_result.is_ok(),
        "Workspace saturation must not block Agent scope"
    );
    assert!(agent_result.unwrap().unwrap().is_ok());
}

#[tokio::test(start_paused = true)]
async fn sandbox_gate_half_open_probe_cancellation_must_not_wedge_breaker() {
    let gate = SandboxGateState::default();
    let limiter = SandboxExecutionLimiter::new();
    let agent_key = SandboxCallerScope::Agent.scoped_key("conn-wedge");

    for _ in 0..10 {
        limiter.check(&agent_key).await.unwrap();
        let probe = gate.enter_breaker(&agent_key).await.unwrap();
        probe.disarm();
        gate.record_failure(&agent_key, "fp-1").await;
    }
    assert!(gate.enter_breaker(&agent_key).await.is_err());

    // Advance past 30s open duration -> half-open probe admitted, then cancelled via QueryCancelled.
    advance(Duration::from_secs(31)).await;
    let probe1 = gate
        .enter_breaker(&agent_key)
        .await
        .expect("half-open probe admitted");
    assert!(
        gate.enter_breaker(&agent_key).await.is_err(),
        "concurrent second caller while probe is in flight must be rejected"
    );
    probe1.disarm();
    gate.release_half_open_probe(&agent_key).await;

    // Next caller must immediately get a fresh half-open probe; dropping that guard (simulating
    // cancelled/aborted future) must also release the half-open slot cleanly.
    let probe2 = gate
        .enter_breaker(&agent_key)
        .await
        .expect("next caller after QueryCancelled must not wedge");
    drop(probe2);

    let probe3 = gate
        .enter_breaker(&agent_key)
        .await
        .expect("dropped probe guard must release half_open_probe_in_flight");
    probe3.disarm();
    gate.record_success(&agent_key).await;
}

#[tokio::test]
async fn tcp_execute_ai_request_mid_body_cancellation_clears_map_and_requires_non_retryable() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let chunk1_sent = Arc::new(Notify::new());
    let chunk1_sent_bg = Arc::clone(&chunk1_sent);
    let hold_open = Arc::new(Notify::new());
    let hold_open_bg = Arc::clone(&hold_open);

    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let _req = read_http_request(&mut socket).await;
        socket
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
            )
            .await
            .unwrap();
        // Send partial chunked HTTP body and hold open so `response.text()` blocks.
        socket
            .write_all(b"10\r\n{\"choices\":[{\"m\r\n")
            .await
            .unwrap();
        socket.flush().await.unwrap();
        chunk1_sent_bg.notify_one();
        hold_open_bg.notified().await;
    });

    let config = test_custom_config(
        "p-exec-cancel",
        format!("http://{addr}/v1/chat/completions"),
        "gpt-mock-exec-cancel",
        Some("chat-completions"),
    );
    let (temp_dir, storage) = make_temp_ai_storage(&config);
    let limiter = AIRequestLimiter::new(Duration::from_secs(60), 5, "Too many AI requests");
    let cancellation_state = Arc::new(AIRequestCancellationState::default());
    let request_id = "req-exec-cancel-1";
    let token = CancellationToken::new();
    cancellation_state.register(request_id, token.clone()).await;

    let request = test_ai_request("p-exec-cancel", request_id, "Hold open");
    let cancel_state_clone = Arc::clone(&cancellation_state);
    let exec_handle = tokio::spawn(async move {
        let res = execute_ai_request(request, &storage, &limiter, token).await;
        cancel_state_clone.finish(request_id).await;
        res
    });

    chunk1_sent.notified().await;
    assert!(cancellation_state.cancel(request_id).await);

    let err = exec_handle
        .await
        .unwrap()
        .expect_err("cancelled execute_ai_request must return Err");
    hold_open.notify_one();
    server.await.unwrap();

    assert_eq!(err.code(), ErrorCode::AiCancelled);
    assert!(cancellation_state.active.lock().await.is_empty());
    assert!(!cancellation_state.cancel(request_id).await);
    let _ = std::fs::remove_dir_all(temp_dir);
    assert!(
        !err.retryable(),
        "BUG: execute_ai_request returned ErrorCode::AiCancelled with retryable: true (errors.rs:9)"
    );
}

#[tokio::test]
async fn tcp_stream_rate_limiter_rejects_before_wire_call() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let accept_count = Arc::new(AtomicUsize::new(0));
    let accept_count_bg = Arc::clone(&accept_count);

    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        accept_count_bg.fetch_add(1, Ordering::SeqCst);
        let _req = read_http_request(&mut socket).await;
        socket
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n\
                  data: {\"choices\":[{\"delta\":{\"content\":\"first ok\"}}]}\n\ndata: [DONE]\n\n",
            )
            .await
            .unwrap();
        socket.flush().await.unwrap();
    });

    let config = test_custom_config(
        "p-stream-rl",
        format!("http://{addr}/v1/chat/completions"),
        "gpt-mock-rl",
        Some("chat-completions"),
    );
    let (temp_dir, storage) = make_temp_ai_storage(&config);
    let limiter = AIRequestLimiter::new(Duration::from_secs(60), 1, "Too many AI requests");

    let res1 = execute_ai_stream_request_with_sink(
        test_ai_request("p-stream-rl", "req-rl-1", "First"),
        &storage,
        &limiter,
        CancellationToken::new(),
        AI_STREAM_CHUNK_IDLE_TIMEOUT,
        |_, _, _| Ok(()),
    )
    .await
    .expect("first stream call should pass");
    assert_eq!(res1.text, "first ok");

    let err2 = execute_ai_stream_request_with_sink(
        test_ai_request("p-stream-rl", "req-rl-2", "Second"),
        &storage,
        &limiter,
        CancellationToken::new(),
        AI_STREAM_CHUNK_IDLE_TIMEOUT,
        |_, _, _| Ok(()),
    )
    .await
    .expect_err("second stream call must hit AIRequestLimiter");

    server.await.unwrap();
    let _ = std::fs::remove_dir_all(temp_dir);

    assert_eq!(err2.code(), ErrorCode::RateLimited);
    assert!(!err2.retryable());
    assert_eq!(accept_count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn tcp_stream_400_thinking_self_heal_with_json_escaped_thinking_and_single_rate_limit() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let bodies = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
    let bodies_bg = Arc::clone(&bodies);

    let server = tokio::spawn(async move {
        // Attempt 1: 400 with JSON-escaped \"thinking\"
        let (mut s1, _) = listener.accept().await.unwrap();
        let raw1 = read_http_request(&mut s1).await;
        bodies_bg.lock().await.push(extract_http_body(&raw1));
        let err_body = json!({
            "error": {
                "message": "Unsupported parameter: \"thinking\" is not supported on this model"
            }
        })
        .to_string();
        let resp1 = format!(
            "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            err_body.len(),
            err_body
        );
        s1.write_all(resp1.as_bytes()).await.unwrap();
        s1.flush().await.unwrap();

        // Attempt 2: SSE stream after stripping thinking
        let (mut s2, _) = listener.accept().await.unwrap();
        let raw2 = read_http_request(&mut s2).await;
        bodies_bg.lock().await.push(extract_http_body(&raw2));
        s2.write_all(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n\
              data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n\
              data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Stream healed\"}}\n\n\
              data: {\"type\":\"message_stop\"}\n\n",
        )
        .await
        .unwrap();
        s2.flush().await.unwrap();
    });

    let model = format!("claude-sonnet-4-stream-heal-{}", Uuid::new_v4());
    let config = test_custom_config(
        "p-stream-heal",
        format!("http://{addr}/v1/messages"),
        &model,
        Some("anthropic"),
    );
    let (temp_dir, storage) = make_temp_ai_storage(&config);
    let limiter = AIRequestLimiter::new(Duration::from_secs(60), 1, "Too many AI requests");
    let mut streamed_text = String::new();

    let response = execute_ai_stream_request_with_sink(
        test_ai_request("p-stream-heal", "req-stream-heal-1", "Explain"),
        &storage,
        &limiter,
        CancellationToken::new(),
        AI_STREAM_CHUNK_IDLE_TIMEOUT,
        |kind, text, _| {
            if kind == "text_delta" {
                if let Some(chunk) = text {
                    streamed_text.push_str(&chunk);
                }
            }
            Ok(())
        },
    )
    .await
    .expect("streaming 400 self-heal should retry once and succeed");

    server.await.unwrap();
    let _ = std::fs::remove_dir_all(temp_dir);

    assert_eq!(response.text, "Stream healed");
    assert_eq!(streamed_text, "Stream healed");
    let captured = bodies.lock().await;
    assert_eq!(captured.len(), 2);
    assert!(captured[0].get("thinking").is_some());
    assert!(captured[1].get("thinking").is_none());
    // Single rate-limit unit consumed across the self-heal retry.
    assert!(limiter.check("p-stream-heal:Panel:stream").await.is_err());
}

#[tokio::test]
async fn tcp_stream_into_response_action_json_fallback_only_for_legacy_tools() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let server = tokio::spawn(async move {
        for _ in 0..2 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let _req = read_http_request(&mut socket).await;
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n\
                      data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_tc_1\",\"type\":\"function\",\"function\":{\"name\":\"run_readonly_sql\",\"arguments\":\"{\\\"sql\\\":\\\"SELECT 1\\\"}\"}}]}}]}\n\n\
                      data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n",
                )
                .await
                .unwrap();
            socket.flush().await.unwrap();
        }
    });

    let config = test_custom_config(
        "p-fallback",
        format!("http://{addr}/v1/chat/completions"),
        "gpt-mock-fallback",
        Some("chat-completions"),
    );
    let (temp_dir, storage) = make_temp_ai_storage(&config);
    let limiter = AIRequestLimiter::new(Duration::from_secs(60), 10, "Too many AI requests");

    // 1) Legacy `tools` (non-canonical): tool-call-only stream fills `text` with action JSON.
    let mut legacy_req = test_ai_request("p-fallback", "req-legacy-tc", "Run");
    legacy_req.canonical_tools = None;
    legacy_req.tools = Some(json!([{
        "type": "function",
        "function": {
            "name": "run_readonly_sql",
            "parameters": { "type": "object" }
        }
    }]));
    let legacy_res = execute_ai_stream_request_with_sink(
        legacy_req,
        &storage,
        &limiter,
        CancellationToken::new(),
        AI_STREAM_CHUNK_IDLE_TIMEOUT,
        |_, _, _| Ok(()),
    )
    .await
    .expect("legacy tool stream should succeed");
    assert_eq!(legacy_res.tool_calls.len(), 1);
    let action_json: serde_json::Value =
        serde_json::from_str(&legacy_res.text).expect("legacy fallback must serialize action JSON");
    assert_eq!(action_json["action"], "run_readonly_sql");
    assert_eq!(action_json["args"], json!({ "sql": "SELECT 1" }));

    // 2) Canonical tools: tool-call-only stream keeps `text` empty (no synthetic action JSON).
    let canonical_req = test_ai_request("p-fallback", "req-canon-tc", "Run");
    let canonical_res = execute_ai_stream_request_with_sink(
        canonical_req,
        &storage,
        &limiter,
        CancellationToken::new(),
        AI_STREAM_CHUNK_IDLE_TIMEOUT,
        |_, _, _| Ok(()),
    )
    .await
    .expect("canonical tool stream should succeed");
    assert_eq!(canonical_res.tool_calls.len(), 1);
    assert!(
        canonical_res.text.is_empty(),
        "canonical tool mode must not inject legacy action JSON into text"
    );

    server.await.unwrap();
    let _ = std::fs::remove_dir_all(temp_dir);
}

#[tokio::test]
async fn tcp_stream_inline_sse_error_returns_provider_error() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let _req = read_http_request(&mut socket).await;
        socket
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n\
                  data: {\"error\":{\"message\":\"Rate limit exceeded mid-stream\"}}\n\n",
            )
            .await
            .unwrap();
        socket.flush().await.unwrap();
    });

    let config = test_custom_config(
        "p-inline-err",
        format!("http://{addr}/v1/chat/completions"),
        "gpt-mock-inline-err",
        Some("chat-completions"),
    );
    let (temp_dir, storage) = make_temp_ai_storage(&config);
    let limiter = AIRequestLimiter::new(Duration::from_secs(60), 5, "Too many AI requests");

    let err = execute_ai_stream_request_with_sink(
        test_ai_request("p-inline-err", "req-inline-err", "Test"),
        &storage,
        &limiter,
        CancellationToken::new(),
        AI_STREAM_CHUNK_IDLE_TIMEOUT,
        |_, _, _| Ok(()),
    )
    .await
    .expect_err("inline SSE error frame must return Err");

    server.await.unwrap();
    let _ = std::fs::remove_dir_all(temp_dir);

    assert_eq!(err.code(), ErrorCode::AiRateLimited);
    assert!(err.retryable());
}

#[tokio::test]
async fn tcp_stream_exceeding_buffer_limit_returns_invalid_response() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let _req = read_http_request(&mut socket).await;
        socket
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
            )
            .await
            .unwrap();
        let oversized = vec![b'a'; super::MAX_AI_STREAM_BUFFER_BYTES + 64];
        let _ = socket.write_all(&oversized).await;
        let _ = socket.flush().await;
    });

    let config = test_custom_config(
        "p-buf-cap",
        format!("http://{addr}/v1/chat/completions"),
        "gpt-mock-buf-cap",
        Some("chat-completions"),
    );
    let (temp_dir, storage) = make_temp_ai_storage(&config);
    let limiter = AIRequestLimiter::new(Duration::from_secs(60), 5, "Too many AI requests");

    let err = execute_ai_stream_request_with_sink(
        test_ai_request("p-buf-cap", "req-buf-cap", "Test"),
        &storage,
        &limiter,
        CancellationToken::new(),
        AI_STREAM_CHUNK_IDLE_TIMEOUT,
        |_, _, _| Ok(()),
    )
    .await
    .expect_err("frame exceeding MAX_AI_STREAM_BUFFER_BYTES must fail");

    server.await.unwrap();
    let _ = std::fs::remove_dir_all(temp_dir);

    assert_eq!(err.code(), ErrorCode::AiInvalidResponse);
    assert!(!err.retryable());
}
