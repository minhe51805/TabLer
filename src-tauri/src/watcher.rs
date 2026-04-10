use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

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
    *state.watcher.lock().unwrap() = Some(watcher);

    std::thread::spawn(move || {
        for res in rx {
            match res {
                Ok(event) => {
                    handle_event(&app, event);
                }
                Err(e) => {
                    eprintln!("watch error: {:?}", e);
                }
            }
        }
    });

    Ok(())
}

fn handle_event(app: &AppHandle, event: Event) {
    let kind = match event.kind {
        notify::EventKind::Create(_) => "created",
        notify::EventKind::Modify(_) => "modified",
        notify::EventKind::Remove(_) => "removed",
        _ => return,
    };

    for path in event.paths {
        if let Some(ext) = path.extension() {
            if ext == "sql" || ext == "json" {
                let payload = FileEventPayload {
                    path: path.to_string_lossy().to_string(),
                    kind: kind.to_string(),
                };
                let _ = app.emit("linked-folder-change", payload);
            }
        }
    }
}

#[tauri::command]
pub fn add_linked_folder(
    path: String,
    state: State<'_, LinkedFoldersState>,
) -> Result<(), String> {
    let mut folders = state.folders.lock().unwrap();
    if folders.insert(path.clone()) {
        if let Some(watcher) = state.watcher.lock().unwrap().as_mut() {
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
    let mut folders = state.folders.lock().unwrap();
    if folders.remove(&path) {
        if let Some(watcher) = state.watcher.lock().unwrap().as_mut() {
            let _ = watcher.unwatch(Path::new(&path));
        }
    }
    Ok(())
}

#[tauri::command]
pub fn get_linked_folders(state: State<'_, LinkedFoldersState>) -> Result<Vec<String>, String> {
    let folders = state.folders.lock().unwrap();
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
            let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            
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
