use log::error;
use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::mpsc::RecvTimeoutError;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

/// Quiet period that must pass with no further filesystem events before a
/// batch is flushed. Coalesces save-storms (editor autosave, OneDrive/Dropbox
/// sync churn) into a single frontend notification per file.
const EVENT_DEBOUNCE_MS: u64 = 400;
/// Upper bound for one batch: continuous event streams (sync clients) still
/// flush at least every 2s instead of never settling.
const EVENT_MAX_BATCH_WINDOW_MS: u64 = 2_000;

#[derive(Clone, Serialize, Deserialize)]
pub struct FileEventPayload {
    pub path: String,
    pub kind: String,
}

pub struct LinkedFoldersState {
    pub folders: Mutex<HashSet<String>>,
    watcher: Mutex<Option<RecommendedWatcher>>,
}

impl LinkedFoldersState {
    pub fn new() -> Self {
        Self {
            folders: Mutex::new(HashSet::new()),
            watcher: Mutex::new(None),
        }
    }
}

pub fn start_watcher(app: AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let (tx, rx) = std::sync::mpsc::channel();

    let watcher = RecommendedWatcher::new(tx, Config::default())?;

    let state = app.state::<LinkedFoldersState>();
    {
        let mut watcher_guard = match state.watcher.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        *watcher_guard = Some(watcher);
    } // watcher_guard dropped here, releasing borrow of `app`

    std::thread::spawn(move || {
        let app_for_event = app.clone();
        let debounce = Duration::from_millis(EVENT_DEBOUNCE_MS);
        let max_window = Duration::from_millis(EVENT_MAX_BATCH_WINDOW_MS);
        // Block until the first event of a potential batch arrives; the
        // thread exits when the watcher channel closes (recv returns Err).
        while let Ok(first) = rx.recv() {
            let mut batch = vec![first];
            let started = Instant::now();
            // Coalesce follow-up events while the batch is hot: flush as soon
            // as the stream goes quiet for the debounce window, or when the
            // max batch window elapses (continuous event storms).
            while started.elapsed() < max_window {
                match rx.recv_timeout(debounce) {
                    Ok(event) => batch.push(event),
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => {
                        handle_event_batch(&app_for_event, batch);
                        return;
                    }
                }
            }
            handle_event_batch(&app_for_event, batch);
        }
    });

    Ok(())
}

fn handle_event_batch(app: &AppHandle, events: Vec<notify::Result<Event>>) {
    // Deduplicate by path, keeping the latest kind seen for each file so a
    // create+modify burst emits one notification per file.
    let mut latest: HashMap<std::path::PathBuf, &'static str> = HashMap::new();
    for event in events {
        let event = match event {
            Ok(event) => event,
            Err(e) => {
                error!("watch error: {:?}", e);
                continue;
            }
        };
        let kind = match event.kind {
            notify::EventKind::Create(_) => "created",
            notify::EventKind::Modify(_) => "modified",
            notify::EventKind::Remove(_) => "removed",
            _ => continue,
        };
        for path in event.paths {
            if let Some(ext) = path.extension() {
                if ext == "sql" || ext == "json" {
                    latest.insert(path, kind);
                }
            }
        }
    }
    for (path, kind) in latest {
        let payload = FileEventPayload {
            path: path.to_string_lossy().to_string(),
            kind: kind.to_string(),
        };
        let _ = app.emit("linked-folder-change", payload);
    }
}

#[tauri::command]
pub fn add_linked_folder(path: String, state: State<'_, LinkedFoldersState>) -> Result<(), String> {
    let folders = match state.folders.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    let mut folders = folders;
    if folders.insert(path.clone()) {
        let mut watcher_guard = match state.watcher.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(watcher) = watcher_guard.as_mut() {
            if let Err(e) = watcher.watch(Path::new(&path), RecursiveMode::Recursive) {
                folders.remove(&path);
                return Err(e.to_string());
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn remove_linked_folder(
    path: String,
    state: State<'_, LinkedFoldersState>,
) -> Result<(), String> {
    let folders = match state.folders.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    let mut folders = folders;
    if folders.remove(&path) {
        let mut watcher_guard = match state.watcher.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(watcher) = watcher_guard.as_mut() {
            let _ = watcher.unwatch(Path::new(&path));
        }
    }
    Ok(())
}

#[tauri::command]
pub fn get_linked_folders(state: State<'_, LinkedFoldersState>) -> Result<Vec<String>, String> {
    let folders = state.folders.lock().map_err(|e| e.to_string())?;
    Ok(folders.iter().cloned().collect())
}

#[derive(Clone, Serialize, Deserialize)]
pub struct LinkedFileInfo {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub extension: String,
}

#[tauri::command]
pub fn scan_linked_folder(folder_path: String) -> Result<Vec<LinkedFileInfo>, String> {
    let mut files = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&folder_path) {
        for entry in entries.flatten() {
            let path = entry.path();
            let is_dir = path.is_dir();
            let name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();

            if is_dir {
                files.push(LinkedFileInfo {
                    path: path.to_string_lossy().to_string(),
                    name,
                    is_dir: true,
                    extension: String::new(),
                });
            } else if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                if ext == "sql" || ext == "json" {
                    files.push(LinkedFileInfo {
                        path: path.to_string_lossy().to_string(),
                        name,
                        is_dir: false,
                        extension: ext.to_string(),
                    });
                }
            }
        }
    }
    files.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(files)
}

#[tauri::command]
pub fn read_linked_file(file_path: String) -> Result<String, String> {
    std::fs::read_to_string(file_path).map_err(|e| e.to_string())
}
