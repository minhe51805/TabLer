use crate::database::ai_models::{AIProviderType, AIRequest, AIRequestMode, AIResponse};
use crate::storage::ai_storage::AIStorage;
use crate::utils::rate_limiter::AIRequestLimiter;
use futures_util::StreamExt;
use tauri::AppHandle;
use tokio::time::{sleep, Duration};
use tokio_util::sync::CancellationToken;

use super::endpoints::{
    is_nvidia_integrate_endpoint, provider_requires_api_key, resolve_provider_endpoint,
    should_retry_openai_like_status, validate_ai_endpoint,
};
use super::errors::{
    ai_provider_api_error, ai_provider_config_error, ai_provider_http_status_error,
    ai_provider_non_json_response_error, ai_provider_request_error, ai_provider_response_error,
    ai_provider_response_error_with_preview,
};
use super::extraction::{
    extract_anthropic_response_text, extract_gemini_response_text, extract_openai_like_reasoning,
    extract_openai_like_response_text, extract_tool_call_as_action_json, publish_stream_payload,
    split_think_block,
};
use super::prompt::build_ai_prompt;
use super::providers::{
    apply_native_tools, build_provider_request_body, streaming_endpoint, streaming_request_body,
};
use super::{ai_http_client, run_blocking_storage_task, AI_REQUEST_CANCELLED_ERROR};

pub(crate) async fn execute_ai_stream_request(
    request: AIRequest,
    request_id: &str,
    app: &AppHandle,
    storage: &AIStorage,
    ai_rate_limiter: &AIRequestLimiter,
    cancellation_token: CancellationToken,
) -> Result<(), String> {
    let storage = storage.clone();
    let override_provider_id = request.provider_id.clone();
    let (config, api_key) = run_blocking_storage_task(move || {
        let config = match override_provider_id.as_deref() {
            Some(provider_id) if !provider_id.trim().is_empty() => storage
                .get_enabled_provider_config_by_id(provider_id.trim())
                .map_err(|_| ai_provider_config_error())?,
            _ => storage
                .get_active_provider_config()
                .map_err(|_| ai_provider_config_error())?,
        };
        let api_key = if provider_requires_api_key(&config.provider_type) {
            Some(
                storage
                    .get_api_key(&config.id)
                    .map_err(|_| ai_provider_config_error())?,
            )
        } else {
            storage
                .get_api_key_optional(&config.id)
                .map_err(|_| ai_provider_config_error())?
        };
        Ok((config, api_key))
    })
    .await?;

    ai_rate_limiter
        .check(&format!("{}:{:?}:stream", config.id, request.mode))
        .await?;
    if !config.is_enabled {
        return Err("Selected AI provider is disabled.".to_string());
    }

    let effective_context = if config.allow_schema_context {
        request.context.trim()
    } else {
        ""
    };
    let (system_prompt, prompt) = build_ai_prompt(
        &request.mode,
        &request.intent,
        &request.language,
        effective_context,
        &request.history,
        &request.prompt,
    );
    let base_endpoint = resolve_provider_endpoint(&config);
    validate_ai_endpoint(&config, &base_endpoint)?;
    let endpoint = streaming_endpoint(&config, &base_endpoint);
    let body = streaming_request_body(
        &config,
        &base_endpoint,
        &system_prompt,
        &prompt,
        &request.mode,
    );
    let mut request_builder = ai_http_client().post(&endpoint);
    match config.provider_type {
        AIProviderType::Anthropic => {
            request_builder = request_builder
                .header("x-api-key", api_key.as_deref().unwrap_or_default())
                .header("anthropic-version", "2023-06-01");
        }
        AIProviderType::Gemini => {
            request_builder =
                request_builder.header("x-goog-api-key", api_key.as_deref().unwrap_or_default());
        }
        _ => {
            if let Some(api_key) = api_key.as_deref() {
                request_builder = request_builder.bearer_auth(api_key);
            }
        }
    }

    let response = tokio::select! {
        _ = cancellation_token.cancelled() => return Err(AI_REQUEST_CANCELLED_ERROR.to_string()),
        response = request_builder.json(&body).send() => response
            .map_err(|error| ai_provider_request_error(&config, &endpoint, &error))?,
    };
    let status = response.status();
    if !status.is_success() {
        let raw_body = response
            .text()
            .await
            .map_err(|_| ai_provider_response_error())?;
        return Err(ai_provider_http_status_error(
            &config,
            &endpoint,
            status,
            &raw_body,
            api_key.as_deref(),
        ));
    }

    let mut stream = response.bytes_stream();
    let mut buffer = Vec::<u8>::new();
    let mut pending_text = String::new();
    let mut visible_started = false;
    let mut output_bytes = 0usize;

    loop {
        let next = tokio::select! {
            _ = cancellation_token.cancelled() => return Err(AI_REQUEST_CANCELLED_ERROR.to_string()),
            next = stream.next() => next,
        };
        let Some(chunk) = next else { break };
        let chunk = chunk.map_err(|_| ai_provider_response_error())?;
        buffer.extend_from_slice(&chunk);
        if buffer.len() > super::MAX_AI_STREAM_BUFFER_BYTES {
            return Err("AI stream frame exceeded the 1 MB buffer limit.".to_string());
        }

        while let Some(newline) = buffer.iter().position(|byte| *byte == 10) {
            let line = buffer.drain(..=newline).collect::<Vec<_>>();
            let line = String::from_utf8_lossy(&line);
            let line = line.trim().trim_start_matches("data:").trim();
            if line.is_empty() || line == "[DONE]" || line.starts_with("event:") {
                continue;
            }
            if let Ok(payload) = serde_json::from_str::<serde_json::Value>(line) {
                publish_stream_payload(
                    app,
                    request_id,
                    &config.provider_type,
                    &payload,
                    &mut pending_text,
                    &mut visible_started,
                    &mut output_bytes,
                )?;
            }
        }
    }

    if !buffer.is_empty() {
        let line = String::from_utf8_lossy(&buffer);
        let line = line.trim().trim_start_matches("data:").trim();
        if let Ok(payload) = serde_json::from_str::<serde_json::Value>(line) {
            publish_stream_payload(
                app,
                request_id,
                &config.provider_type,
                &payload,
                &mut pending_text,
                &mut visible_started,
                &mut output_bytes,
            )?;
        }
    }
    Ok(())
}

pub(crate) async fn execute_ai_request(
    request: AIRequest,
    storage: &AIStorage,
    ai_rate_limiter: &AIRequestLimiter,
) -> Result<AIResponse, String> {
    request
        .validate()
        .map_err(|e| format!("Invalid request: {}", e))?;

    let client = ai_http_client();
    let storage = storage.clone();
    let override_provider_id = request.provider_id.clone();
    let (config, api_key) = run_blocking_storage_task(move || {
        let config = match override_provider_id.as_deref() {
            Some(provider_id) if !provider_id.trim().is_empty() => storage
                .get_enabled_provider_config_by_id(provider_id.trim())
                .map_err(|_| ai_provider_config_error())?,
            _ => storage
                .get_active_provider_config()
                .map_err(|_| ai_provider_config_error())?,
        };
        let api_key = if provider_requires_api_key(&config.provider_type) {
            Some(
                storage
                    .get_api_key(&config.id)
                    .map_err(|_| ai_provider_config_error())?,
            )
        } else {
            storage
                .get_api_key_optional(&config.id)
                .map_err(|_| ai_provider_config_error())?
        };

        Ok((config, api_key))
    })
    .await?;

    ai_rate_limiter
        .check(&format!("{}:{:?}", config.id, request.mode))
        .await?;

    if !config.is_enabled {
        return Err("Selected AI provider is disabled.".to_string());
    }
    if request.mode == AIRequestMode::Inline && !config.allow_inline_completion {
        return Err("Inline AI completion is disabled for this provider.".to_string());
    }

    let effective_context = if config.allow_schema_context {
        request.context.trim()
    } else {
        ""
    };
    let (system_prompt, prompt) = build_ai_prompt(
        &request.mode,
        &request.intent,
        &request.language,
        effective_context,
        &request.history,
        &request.prompt,
    );

    match config.provider_type {
        AIProviderType::OpenAI
        | AIProviderType::OpenRouter
        | AIProviderType::Ollama
        | AIProviderType::Custom => {
            let endpoint = resolve_provider_endpoint(&config);
            validate_ai_endpoint(&config, &endpoint)?;
            let mut body = build_provider_request_body(
                &config,
                &endpoint,
                &system_prompt,
                &prompt,
                &request.mode,
            );
            apply_native_tools(
                &mut body,
                &config.provider_type,
                request.tools.as_ref(),
                request.tool_choice.as_ref(),
            );
            let max_attempts = if is_nvidia_integrate_endpoint(&endpoint) {
                3
            } else {
                2
            };

            for attempt in 0..max_attempts {
                let mut req = client.post(&endpoint);
                if let Some(ref api_key) = api_key {
                    req = req.bearer_auth(api_key);
                }

                let response = req
                    .json(&body)
                    .send()
                    .await
                    .map_err(|error| ai_provider_request_error(&config, &endpoint, &error))?;

                let status = response.status();
                let raw_body = response
                    .text()
                    .await
                    .map_err(|_| ai_provider_response_error())?;

                if !status.is_success() {
                    if should_retry_openai_like_status(status) && attempt + 1 < max_attempts {
                        sleep(Duration::from_millis(800 * (attempt as u64 + 1))).await;
                        continue;
                    }

                    if let Ok(resp_json) = serde_json::from_str::<serde_json::Value>(&raw_body) {
                        if let Some(err) = resp_json.get("error") {
                            let msg = if let Some(m) = err.get("message").and_then(|v| v.as_str()) {
                                m.to_string()
                            } else if let Some(m) = err.as_str() {
                                m.to_string()
                            } else {
                                err.to_string()
                            };
                            return Err(ai_provider_api_error(&msg, api_key.as_deref()));
                        }

                        return Err(ai_provider_response_error_with_preview(
                            &config,
                            &endpoint,
                            &resp_json,
                            api_key.as_deref(),
                        ));
                    }

                    return Err(ai_provider_http_status_error(
                        &config,
                        &endpoint,
                        status,
                        &raw_body,
                        api_key.as_deref(),
                    ));
                }

                let resp_json: serde_json::Value =
                    serde_json::from_str(&raw_body).map_err(|_| {
                        ai_provider_non_json_response_error(
                            &config,
                            &endpoint,
                            &raw_body,
                            api_key.as_deref(),
                        )
                    })?;

                if let Some(err) = resp_json.get("error") {
                    let msg = if let Some(m) = err.get("message").and_then(|v| v.as_str()) {
                        m.to_string()
                    } else if let Some(m) = err.as_str() {
                        m.to_string()
                    } else {
                        err.to_string()
                    };
                    return Err(ai_provider_api_error(&msg, api_key.as_deref()));
                }

                if let Some(action) =
                    extract_tool_call_as_action_json(&config.provider_type, &resp_json)
                {
                    return Ok(AIResponse {
                        text: action,
                        reasoning: None,
                        error: None,
                    });
                }

                if let Some(text) = extract_openai_like_response_text(&resp_json) {
                    let field_reasoning = extract_openai_like_reasoning(&resp_json);
                    let (think_reasoning, cleaned) = split_think_block(&text);
                    let reasoning = field_reasoning.or(think_reasoning);
                    return Ok(AIResponse {
                        text: cleaned,
                        reasoning,
                        error: None,
                    });
                }

                return Err(ai_provider_response_error_with_preview(
                    &config,
                    &endpoint,
                    &resp_json,
                    api_key.as_deref(),
                ));
            }

            Err(ai_provider_response_error())
        }
        AIProviderType::Anthropic => {
            let endpoint = resolve_provider_endpoint(&config);
            validate_ai_endpoint(&config, &endpoint)?;
            let mut body = build_provider_request_body(
                &config,
                &endpoint,
                &system_prompt,
                &prompt,
                &request.mode,
            );
            apply_native_tools(
                &mut body,
                &config.provider_type,
                request.tools.as_ref(),
                request.tool_choice.as_ref(),
            );

            let response = client
                .post(&endpoint)
                .header("x-api-key", api_key.as_deref().unwrap_or_default())
                .header("anthropic-version", "2023-06-01")
                .json(&body)
                .send()
                .await
                .map_err(|error| ai_provider_request_error(&config, &endpoint, &error))?;

            let status = response.status();
            let raw_body = response
                .text()
                .await
                .map_err(|_| ai_provider_response_error())?;

            if !status.is_success() {
                if let Ok(resp_json) = serde_json::from_str::<serde_json::Value>(&raw_body) {
                    if let Some(err) = resp_json.get("error") {
                        let msg = if let Some(m) = err.get("message").and_then(|v| v.as_str()) {
                            m.to_string()
                        } else if let Some(m) = err.as_str() {
                            m.to_string()
                        } else {
                            err.to_string()
                        };
                        return Err(ai_provider_api_error(&msg, api_key.as_deref()));
                    }

                    return Err(ai_provider_response_error_with_preview(
                        &config,
                        &endpoint,
                        &resp_json,
                        api_key.as_deref(),
                    ));
                }

                return Err(ai_provider_http_status_error(
                    &config,
                    &endpoint,
                    status,
                    &raw_body,
                    api_key.as_deref(),
                ));
            }

            let resp_json: serde_json::Value = serde_json::from_str(&raw_body).map_err(|_| {
                ai_provider_non_json_response_error(
                    &config,
                    &endpoint,
                    &raw_body,
                    api_key.as_deref(),
                )
            })?;
            if let Some(err) = resp_json.get("error") {
                let msg = if let Some(m) = err.get("message").and_then(|v| v.as_str()) {
                    m.to_string()
                } else if let Some(m) = err.as_str() {
                    m.to_string()
                } else {
                    err.to_string()
                };
                return Err(ai_provider_api_error(&msg, api_key.as_deref()));
            }

            if let Some(action) =
                extract_tool_call_as_action_json(&config.provider_type, &resp_json)
            {
                return Ok(AIResponse {
                    text: action,
                    reasoning: None,
                    error: None,
                });
            }

            if let Some(text) = extract_anthropic_response_text(&resp_json) {
                let (reasoning, cleaned) = split_think_block(&text);
                return Ok(AIResponse {
                    text: cleaned,
                    reasoning,
                    error: None,
                });
            }

            Err(ai_provider_response_error_with_preview(
                &config,
                &endpoint,
                &resp_json,
                api_key.as_deref(),
            ))
        }
        AIProviderType::Gemini => {
            let endpoint = resolve_provider_endpoint(&config);
            validate_ai_endpoint(&config, &endpoint)?;
            let mut body = build_provider_request_body(
                &config,
                &endpoint,
                &system_prompt,
                &prompt,
                &request.mode,
            );
            apply_native_tools(
                &mut body,
                &config.provider_type,
                request.tools.as_ref(),
                request.tool_choice.as_ref(),
            );

            let response = client
                .post(&endpoint)
                .header("x-goog-api-key", api_key.as_deref().unwrap_or_default())
                .json(&body)
                .send()
                .await
                .map_err(|error| ai_provider_request_error(&config, &endpoint, &error))?;

            let status = response.status();
            let raw_body = response
                .text()
                .await
                .map_err(|_| ai_provider_response_error())?;

            if !status.is_success() {
                if let Ok(resp_json) = serde_json::from_str::<serde_json::Value>(&raw_body) {
                    if let Some(err) = resp_json.get("error") {
                        let msg = if let Some(m) = err.get("message").and_then(|v| v.as_str()) {
                            m.to_string()
                        } else if let Some(m) = err.as_str() {
                            m.to_string()
                        } else {
                            err.to_string()
                        };
                        return Err(ai_provider_api_error(&msg, api_key.as_deref()));
                    }

                    return Err(ai_provider_response_error_with_preview(
                        &config,
                        &endpoint,
                        &resp_json,
                        api_key.as_deref(),
                    ));
                }

                return Err(ai_provider_http_status_error(
                    &config,
                    &endpoint,
                    status,
                    &raw_body,
                    api_key.as_deref(),
                ));
            }

            let resp_json: serde_json::Value = serde_json::from_str(&raw_body).map_err(|_| {
                ai_provider_non_json_response_error(
                    &config,
                    &endpoint,
                    &raw_body,
                    api_key.as_deref(),
                )
            })?;
            if let Some(err) = resp_json.get("error") {
                let msg = if let Some(m) = err.get("message").and_then(|v| v.as_str()) {
                    m.to_string()
                } else if let Some(m) = err.as_str() {
                    m.to_string()
                } else {
                    err.to_string()
                };
                return Err(ai_provider_api_error(&msg, api_key.as_deref()));
            }

            if let Some(action) =
                extract_tool_call_as_action_json(&config.provider_type, &resp_json)
            {
                return Ok(AIResponse {
                    text: action,
                    reasoning: None,
                    error: None,
                });
            }

            if let Some(text) = extract_gemini_response_text(&resp_json) {
                let (reasoning, cleaned) = split_think_block(&text);
                return Ok(AIResponse {
                    text: cleaned,
                    reasoning,
                    error: None,
                });
            }

            Err(ai_provider_response_error_with_preview(
                &config,
                &endpoint,
                &resp_json,
                api_key.as_deref(),
            ))
        }
    }
}
