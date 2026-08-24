mod endpoints;
mod errors;
mod execution;
mod extraction;
mod prompt;
mod providers;

use crate::database::ai_models::{AIProviderConfig, AIRequest, AIResponse};
use crate::storage::ai_storage::AIStorage;
use crate::utils::rate_limiter::AIRequestLimiter;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;
use tokio::task;
use tokio_util::sync::CancellationToken;

pub(crate) const AI_REQUEST_CANCELLED_ERROR: &str = "AI request cancelled.";
const MAX_AI_STREAM_BUFFER_BYTES: usize = 1_048_576;
pub(crate) const MAX_AI_STREAM_OUTPUT_BYTES: usize = 2_097_152;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AIStreamEvent {
    request_id: String,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    usage: Option<serde_json::Value>,
}

fn emit_ai_stream_event(
    app: &AppHandle,
    request_id: &str,
    kind: &'static str,
    text: Option<String>,
    usage: Option<serde_json::Value>,
) -> Result<(), String> {
    app.emit(
        "ai-stream-event",
        AIStreamEvent {
            request_id: request_id.to_string(),
            kind,
            text,
            usage,
        },
    )
    .map_err(|_| "Failed to publish AI stream event.".to_string())
}

#[derive(Default)]
pub struct AIRequestCancellationState {
    active: Mutex<HashMap<String, CancellationToken>>,
}

impl AIRequestCancellationState {
    async fn register(&self, request_id: &str, token: CancellationToken) {
        if let Some(previous) = self
            .active
            .lock()
            .await
            .insert(request_id.to_string(), token)
        {
            previous.cancel();
        }
    }

    async fn finish(&self, request_id: &str) {
        self.active.lock().await.remove(request_id);
    }

    async fn cancel(&self, request_id: &str) -> bool {
        let token = self.active.lock().await.get(request_id).cloned();
        if let Some(token) = token {
            token.cancel();
            true
        } else {
            false
        }
    }
}

static AI_HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn ai_http_client() -> &'static reqwest::Client {
    AI_HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(tokio::time::Duration::from_secs(10))
            .pool_idle_timeout(tokio::time::Duration::from_secs(90))
            .pool_max_idle_per_host(8)
            .tcp_nodelay(true)
            .build()
            .expect("AI HTTP client should build")
    })
}

async fn run_blocking_storage_task<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    task::spawn_blocking(operation)
        .await
        .map_err(|_| "Background AI task failed unexpectedly.".to_string())?
}

#[tauri::command]
pub async fn get_ai_configs(
    storage: State<'_, AIStorage>,
) -> Result<(Vec<AIProviderConfig>, HashMap<String, bool>), String> {
    let storage = storage.inner().clone();
    run_blocking_storage_task(move || {
        storage
            .load_providers()
            .map_err(|_| errors::ai_storage_load_error())
    })
    .await
}

#[tauri::command]
pub async fn save_ai_configs(
    providers: Vec<AIProviderConfig>,
    api_key_updates: HashMap<String, String>,
    cleared_provider_ids: Vec<String>,
    storage: State<'_, AIStorage>,
) -> Result<(Vec<AIProviderConfig>, HashMap<String, bool>), String> {
    let storage = storage.inner().clone();
    run_blocking_storage_task(move || {
        storage
            .save_providers(&providers, &api_key_updates, &cleared_provider_ids)
            .map_err(|_| errors::ai_storage_save_error())?;
        storage
            .load_providers()
            .map_err(|_| errors::ai_storage_load_error())
    })
    .await
}

#[tauri::command]
pub async fn ask_ai(
    request: AIRequest,
    storage: State<'_, AIStorage>,
    ai_rate_limiter: State<'_, AIRequestLimiter>,
    cancellation_state: State<'_, AIRequestCancellationState>,
) -> Result<AIResponse, String> {
    request
        .validate()
        .map_err(|e| format!("Invalid request: {}", e))?;

    let request_id = request
        .request_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let cancellation_token = CancellationToken::new();

    if let Some(request_id) = request_id.as_deref() {
        cancellation_state
            .register(request_id, cancellation_token.clone())
            .await;
    }

    let result = tokio::select! {
        _ = cancellation_token.cancelled() => Err(AI_REQUEST_CANCELLED_ERROR.to_string()),
        result = execution::execute_ai_request(request, storage.inner(), ai_rate_limiter.inner()) => result,
    };

    if let Some(request_id) = request_id.as_deref() {
        cancellation_state.finish(request_id).await;
    }

    result
}

#[tauri::command]
pub async fn ask_ai_stream(
    request: AIRequest,
    app: AppHandle,
    storage: State<'_, AIStorage>,
    ai_rate_limiter: State<'_, AIRequestLimiter>,
    cancellation_state: State<'_, AIRequestCancellationState>,
) -> Result<(), String> {
    request
        .validate()
        .map_err(|error| format!("Invalid request: {error}"))?;
    let request_id = request
        .request_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Streaming AI requests require a request ID.".to_string())?
        .to_string();
    let token = CancellationToken::new();
    cancellation_state
        .register(&request_id, token.clone())
        .await;

    let result = execution::execute_ai_stream_request(
        request,
        &request_id,
        &app,
        storage.inner(),
        ai_rate_limiter.inner(),
        token,
    )
    .await;
    cancellation_state.finish(&request_id).await;

    match result {
        Ok(()) => emit_ai_stream_event(&app, &request_id, "done", None, None),
        Err(error) => {
            let _ = emit_ai_stream_event(&app, &request_id, "error", Some(error.clone()), None);
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn cancel_ai_request(
    request_id: String,
    cancellation_state: State<'_, AIRequestCancellationState>,
) -> Result<bool, String> {
    let request_id = request_id.trim();
    if request_id.is_empty() {
        return Err("Request ID cannot be empty.".to_string());
    }
    Ok(cancellation_state.cancel(request_id).await)
}

/// Persists an agent run trace as JSONL under <data_dir>/traces/ so failed or
/// surprising runs can be replayed offline. Best-effort debugging artifact.
#[tauri::command]
pub fn save_agent_trace(request_id: String, content: String) -> Result<String, String> {
    let safe_name: String = request_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let data_dir = crate::utils::paths::resolve_data_dir().map_err(|e| e.to_string())?;
    let traces_dir = data_dir.join("traces");
    fs::create_dir_all(&traces_dir).map_err(|e| format!("Failed to create traces directory: {e}"))?;
    let path = traces_dir.join(format!("{safe_name}.jsonl"));
    fs::write(&path, content).map_err(|e| format!("Failed to write agent trace: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_util::sync::CancellationToken as TestToken;

    #[tokio::test]
    async fn cancels_and_cleans_up_registered_ai_requests() {
        let state = AIRequestCancellationState::default();
        let token = TestToken::new();

        state.register("request-1", token.clone()).await;
        assert!(state.cancel("request-1").await);
        assert!(token.is_cancelled());

        state.finish("request-1").await;
        assert!(!state.cancel("request-1").await);
    }
}