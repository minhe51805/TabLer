//! User-facing notices raised by the storage layer.
//!
//! Storage modules run before (and independently of) the webview, so they
//! cannot toast directly. Notices are queued here, replayed onto the
//! `storage-notice` event once the app handle exists, and additionally
//! drained on demand by the `drain_storage_notices` command so a notice can
//! never be lost between emit and listener attach.

use serde::Serialize;
use std::collections::{HashSet, VecDeque};
use std::sync::{LazyLock, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

pub const STORAGE_NOTICE_EVENT: &str = "storage-notice";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageNotice {
    /// Stable dedupe key, e.g. `corrupt:connections.json`.
    pub id: String,
    /// `corrupt` | `warning` | `info` — the frontend maps this to a toast tone.
    pub kind: String,
    pub title: String,
    pub message: String,
}

#[derive(Default)]
struct NoticeState {
    pending: VecDeque<StorageNotice>,
    sent: HashSet<String>,
}

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
static STATE: LazyLock<Mutex<NoticeState>> = LazyLock::new(|| Mutex::new(NoticeState::default()));

fn state() -> &'static Mutex<NoticeState> {
    &STATE
}

/// Queue a notice for the frontend. Safe to call before the Tauri app exists;
/// duplicates (same `id`) are delivered once per session.
pub fn push_storage_notice(notice: StorageNotice) {
    let deliver = {
        let mut guard = match state().lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        if !guard.sent.insert(notice.id.clone()) {
            return;
        }
        guard.pending.push_back(notice.clone());
        notice
    };
    if let Some(app) = APP_HANDLE.get() {
        let _ = app.emit(STORAGE_NOTICE_EVENT, deliver);
    }
}

/// Called once the app handle exists: replay every queued notice so early
/// boot-time problems (sync folder missing, corrupt files quarantined) reach
/// the UI. The queue is NOT cleared — the webview may not have attached its
/// listener yet, so `drain_storage_notices` must still be able to deliver
/// them (the frontend dedupes by notice id).
pub fn init_storage_notices(app: &AppHandle) {
    let _ = APP_HANDLE.set(app.clone());
    let pending: Vec<StorageNotice> = {
        let guard = match state().lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        guard.pending.iter().cloned().collect()
    };
    for notice in pending {
        let _ = app.emit(STORAGE_NOTICE_EVENT, notice);
    }
}

/// Drain notices the frontend may have missed (e.g. emitted before the
/// listener attached). The queue persists until the frontend drains it, so
/// boot-time notices are never lost between emit and listener attach.
#[tauri::command]
pub fn drain_storage_notices() -> Vec<StorageNotice> {
    let mut guard = match state().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    guard.pending.drain(..).collect()
}
