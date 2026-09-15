use std::collections::HashMap;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub struct QueryCancellationState {
    active: Mutex<HashMap<String, CancellationToken>>,
}

impl QueryCancellationState {
    pub(super) async fn register(&self, request_id: &str, token: CancellationToken) {
        if let Some(previous) = self
            .active
            .lock()
            .await
            .insert(request_id.to_string(), token)
        {
            previous.cancel();
        }
    }

    pub(super) async fn finish(&self, request_id: &str) {
        self.active.lock().await.remove(request_id);
    }

    pub(super) async fn cancel(&self, request_id: &str) -> bool {
        let token = self.active.lock().await.get(request_id).cloned();
        if let Some(token) = token {
            token.cancel();
            true
        } else {
            false
        }
    }
}
