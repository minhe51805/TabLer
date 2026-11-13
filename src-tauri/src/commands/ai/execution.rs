use crate::database::ai_models::{
    AIProviderConfig, AIProviderType, AIRequest, AIRequestMode, AIResponse,
};
use crate::error::{AppError, ErrorCode};
use crate::storage::ai_storage::AIStorage;
use crate::utils::rate_limiter::AIRequestLimiter;
use futures_util::StreamExt;
use tauri::AppHandle;
use tokio_util::sync::CancellationToken;

use super::endpoints::{
    provider_requires_api_key, resolve_models_list_endpoint, validate_ai_endpoint,
};
use super::errors::{
    ai_cancelled_error, ai_provider_api_error, ai_provider_config_error,
    ai_provider_http_status_error, ai_provider_non_json_response_error, ai_provider_request_error,
    ai_provider_response_error, ai_provider_response_error_with_preview,
    response_retry_after_seconds,
};
use super::extraction::{extract_provider_response, StreamResponseAccumulator};
use super::providers::{
    build_provider_http_request, effective_wire_provider, is_thinking_param_rejection,
    mark_model_thinking_unsupported, model_thinking_unsupported, parse_models_list_response,
    prepare_provider_wire_request, PreparedProviderWireRequest,
};
use super::{ai_http_client, emit_ai_stream_event, run_blocking_storage_task, FetchedModel};

pub(crate) async fn fetch_provider_models(
    config: &AIProviderConfig,
    api_key: Option<&str>,
) -> Result<Vec<FetchedModel>, AppError> {
    let (endpoint, shape) = resolve_models_list_endpoint(config)
        .map_err(|msg| AppError::structured(ErrorCode::ValidationError, msg, false))?;
    validate_ai_endpoint(config, &endpoint)
        .map_err(|msg| AppError::structured(ErrorCode::ValidationError, msg, false))?;

    let mut request_builder = ai_http_client().get(&endpoint);
    match effective_wire_provider(config, &endpoint) {
        AIProviderType::Anthropic => {
            request_builder = request_builder
                .header("x-api-key", api_key.unwrap_or_default())
                .header("anthropic-version", crate::config::ANTHROPIC_API_VERSION);
        }
        AIProviderType::Gemini => {
            request_builder = request_builder.header("x-goog-api-key", api_key.unwrap_or_default());
        }
        _ => {
            if let Some(api_key) = api_key {
                request_builder = request_builder.bearer_auth(api_key);
            }
        }
    }

    let response = request_builder
        .send()
        .await
        .map_err(|error| ai_provider_request_error(config, &endpoint, &error))?;
    let status = response.status();
    let retry_after = response_retry_after_seconds(&response);
    if !status.is_success() {
        let raw_body = response
            .text()
            .await
            .map_err(|_| ai_provider_response_error())?;
        return Err(ai_provider_http_status_error(
            config,
            &endpoint,
            status,
            &raw_body,
            api_key,
            retry_after,
        ));
    }

    let resp_json: serde_json::Value = response
        .json()
        .await
        .map_err(|_| ai_provider_response_error())?;
    let models = parse_models_list_response(shape, &resp_json);
    if models.is_empty() {
        return Err(AppError::structured(
            ErrorCode::ValidationError,
            "The provider responded, but no models were found. Add model IDs manually.",
            false,
        ));
    }
    Ok(models)
}

async fn resolve_request_provider_config_and_key(
    request: &AIRequest,
    storage: &AIStorage,
) -> Result<(AIProviderConfig, Option<String>), AppError> {
    let storage = storage.clone();
    let override_provider_id = request.provider_id.clone();
    let (mut config, api_key) = run_blocking_storage_task(move || {
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

    if let Some(model_override) = request.model.as_deref() {
        let trimmed = model_override.trim();
        if !trimmed.is_empty() {
            config.model = trimmed.to_string();
        }
    }

    if !config.is_enabled {
        return Err(AppError::structured(
            ErrorCode::ValidationError,
            "Selected AI provider is disabled.",
            false,
        ));
    }
    if request.mode == AIRequestMode::Inline && !config.allow_inline_completion {
        return Err(AppError::structured(
            ErrorCode::ValidationError,
            "Inline AI completion is disabled for this provider.",
            false,
        ));
    }

    Ok((config, api_key))
}

/// Dispatches an AI HTTP POST once, with a 1x thinking-parameter 400 self-heal
/// shared uniformly across every provider and across both streaming and blocking
/// execution. Transient HTTP retries are intentionally NOT repeated here — the
/// frontend transport coordinator owns bounded retry and failover in one place.
async fn send_with_thinking_self_heal(
    config: &AIProviderConfig,
    request: &AIRequest,
    api_key: Option<&str>,
    streaming: bool,
    cancellation_token: &CancellationToken,
) -> Result<(reqwest::Response, PreparedProviderWireRequest), AppError> {
    let client = ai_http_client();
    let mut prepared = prepare_provider_wire_request(config, request, streaming, None)?;

    for attempt in 0..2 {
        let http_req = build_provider_http_request(client, config, &prepared, api_key);
        let response = tokio::select! {
            _ = cancellation_token.cancelled() => return Err(ai_cancelled_error()),
            res = http_req.send() => res
                .map_err(|error| ai_provider_request_error(config, &prepared.endpoint, &error))?,
        };

        let status = response.status();
        if status.is_success() {
            return Ok((response, prepared));
        }

        let retry_after = response_retry_after_seconds(&response);
        let raw_body = tokio::select! {
            _ = cancellation_token.cancelled() => return Err(ai_cancelled_error()),
            text = response.text() => text.map_err(|_| ai_provider_response_error())?,
        };

        if attempt == 0
            && status.as_u16() == 400
            && !model_thinking_unsupported(&config.model)
            && is_thinking_param_rejection(&raw_body)
        {
            mark_model_thinking_unsupported(&config.model);
            prepared = prepare_provider_wire_request(config, request, streaming, Some(false))?;
            continue;
        }

        return Err(ai_provider_http_status_error(
            config,
            &prepared.endpoint,
            status,
            &raw_body,
            api_key,
            retry_after,
        ));
    }

    Err(ai_provider_response_error())
}

fn extract_inline_error_message(payload: &serde_json::Value) -> Option<String> {
    let err = payload.get("error")?;
    if err.is_null() {
        return None;
    }
    if let Some(msg) = err.get("message").and_then(|v| v.as_str()) {
        Some(msg.to_string())
    } else if let Some(msg) = err.as_str() {
        Some(msg.to_string())
    } else {
        Some(err.to_string())
    }
}

fn process_sse_line<F>(
    raw_line: &str,
    wire_provider: &AIProviderType,
    api_key: Option<&str>,
    accumulator: &mut StreamResponseAccumulator,
    emit: &mut F,
) -> Result<(), AppError>
where
    F: FnMut(&'static str, Option<String>, Option<serde_json::Value>) -> Result<(), String>,
{
    let trimmed = raw_line.trim();
    if trimmed.is_empty()
        || trimmed.starts_with(':')
        || trimmed.starts_with("event:")
        || trimmed.starts_with("id:")
        || trimmed.starts_with("retry:")
    {
        return Ok(());
    }
    let has_data_prefix = trimmed.starts_with("data:");
    let line = if has_data_prefix {
        trimmed.trim_start_matches("data:").trim()
    } else {
        trimmed
    };
    if line.is_empty() || line == "[DONE]" {
        return Ok(());
    }
    match serde_json::from_str::<serde_json::Value>(line) {
        Ok(payload) => {
            if let Some(err_msg) = extract_inline_error_message(&payload) {
                return Err(ai_provider_api_error(&err_msg, api_key));
            }
            accumulator
                .push_frame_with_sink(wire_provider, &payload, emit)
                .map_err(|msg| AppError::ai(ErrorCode::AiInvalidResponse, msg, false, None))?;
            Ok(())
        }
        Err(err) => {
            if line.starts_with('{') || line.starts_with('[') {
                log::warn!(
                    "Malformed JSON frame in AI stream (bytes={}): {}",
                    line.len(),
                    err
                );
                return Err(AppError::ai(
                    ErrorCode::AiInvalidResponse,
                    format!("AI stream returned malformed JSON frame: {err}"),
                    true,
                    None,
                ));
            }
            log::warn!(
                "Ignoring non-JSON SSE line in AI stream (has_data_prefix={}, bytes={}): {}",
                has_data_prefix,
                line.len(),
                err
            );
            Ok(())
        }
    }
}

pub(crate) async fn execute_ai_stream_request(
    request: AIRequest,
    request_id: &str,
    app: &AppHandle,
    storage: &AIStorage,
    ai_rate_limiter: &AIRequestLimiter,
    cancellation_token: CancellationToken,
) -> Result<AIResponse, AppError> {
    execute_ai_stream_request_with_sink(
        request,
        storage,
        ai_rate_limiter,
        cancellation_token,
        crate::config::AI_STREAM_CHUNK_IDLE_TIMEOUT,
        |kind, text, usage| emit_ai_stream_event(app, request_id, kind, text, usage),
    )
    .await
}

pub(crate) async fn execute_ai_stream_request_with_sink<F>(
    request: AIRequest,
    storage: &AIStorage,
    ai_rate_limiter: &AIRequestLimiter,
    cancellation_token: CancellationToken,
    chunk_idle_timeout: std::time::Duration,
    mut on_event: F,
) -> Result<AIResponse, AppError>
where
    F: FnMut(&'static str, Option<String>, Option<serde_json::Value>) -> Result<(), String>,
{
    request.validate().map_err(|e| {
        AppError::structured(
            ErrorCode::ValidationError,
            format!("Invalid request: {e}"),
            false,
        )
    })?;

    let (config, api_key) = resolve_request_provider_config_and_key(&request, storage).await?;

    ai_rate_limiter
        .check(&format!("{}:{:?}:stream", config.id, request.mode))
        .await
        .map_err(AppError::rate_limited_raw)?;

    let (response, prepared) = send_with_thinking_self_heal(
        &config,
        &request,
        api_key.as_deref(),
        true,
        &cancellation_token,
    )
    .await?;

    let provider_label = if config.name.trim().is_empty() {
        format!("{:?}", config.provider_type)
    } else {
        config.name.trim().to_string()
    };

    let mut stream = response.bytes_stream();
    let mut buffer = Vec::<u8>::new();
    let mut accumulator = StreamResponseAccumulator::default();

    loop {
        let next = tokio::select! {
            _ = cancellation_token.cancelled() => return Err(ai_cancelled_error()),
            _ = tokio::time::sleep(chunk_idle_timeout) => {
                return Err(AppError::ai(
                    ErrorCode::AiTimeout,
                    format!(
                        "The AI stream from \"{provider_label}\" stalled for over {} seconds without sending data.",
                        chunk_idle_timeout.as_secs()
                    ),
                    true,
                    None,
                ));
            }
            next = stream.next() => next,
        };
        let Some(chunk) = next else { break };
        let chunk = chunk.map_err(|_| ai_provider_response_error())?;
        buffer.extend_from_slice(&chunk);
        if buffer.len() > super::MAX_AI_STREAM_BUFFER_BYTES {
            return Err(AppError::ai(
                ErrorCode::AiInvalidResponse,
                "AI stream frame exceeded the 1 MB buffer limit.",
                false,
                None,
            ));
        }

        while let Some(newline) = buffer.iter().position(|byte| *byte == 10) {
            let line_bytes = buffer.drain(..=newline).collect::<Vec<_>>();
            let line = String::from_utf8_lossy(&line_bytes);
            process_sse_line(
                &line,
                &prepared.wire_provider,
                api_key.as_deref(),
                &mut accumulator,
                &mut on_event,
            )?;
        }
    }

    if !buffer.is_empty() {
        let line = String::from_utf8_lossy(&buffer);
        process_sse_line(
            &line,
            &prepared.wire_provider,
            api_key.as_deref(),
            &mut accumulator,
            &mut on_event,
        )?;
    }

    Ok(accumulator.into_response(prepared.used_canonical_tools))
}

pub(crate) async fn execute_ai_request(
    request: AIRequest,
    storage: &AIStorage,
    ai_rate_limiter: &AIRequestLimiter,
    cancellation_token: CancellationToken,
) -> Result<AIResponse, AppError> {
    request.validate().map_err(|e| {
        AppError::structured(
            ErrorCode::ValidationError,
            format!("Invalid request: {e}"),
            false,
        )
    })?;

    let (config, api_key) = resolve_request_provider_config_and_key(&request, storage).await?;

    ai_rate_limiter
        .check(&format!("{}:{:?}", config.id, request.mode))
        .await
        .map_err(AppError::rate_limited_raw)?;

    let (response, prepared) = send_with_thinking_self_heal(
        &config,
        &request,
        api_key.as_deref(),
        false,
        &cancellation_token,
    )
    .await?;

    let raw_body = tokio::select! {
        _ = cancellation_token.cancelled() => return Err(ai_cancelled_error()),
        text = response.text() => text.map_err(|_| ai_provider_response_error())?,
    };

    let resp_json: serde_json::Value = serde_json::from_str(&raw_body).map_err(|_| {
        ai_provider_non_json_response_error(
            &config,
            &prepared.endpoint,
            &raw_body,
            api_key.as_deref(),
        )
    })?;

    if let Some(err_msg) = extract_inline_error_message(&resp_json) {
        return Err(ai_provider_api_error(&err_msg, api_key.as_deref()));
    }

    if let Some(extracted) = extract_provider_response(
        &prepared.wire_provider,
        &resp_json,
        prepared.used_canonical_tools,
    ) {
        return Ok(extracted);
    }

    Err(ai_provider_response_error_with_preview(
        &config,
        &prepared.endpoint,
        &resp_json,
        api_key.as_deref(),
    ))
}
