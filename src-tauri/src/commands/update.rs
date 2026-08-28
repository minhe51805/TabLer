use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tauri_plugin_updater::UpdaterExt;

/// Event payload: download progress as a rounded percentage (0-100).
const UPDATE_PROGRESS_EVENT: &str = "update-download-progress";

#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateStatus {
    pub available: bool,
    pub version: Option<String>,
    pub body: Option<String>,
}

/// Check if an update is available
#[tauri::command]
pub async fn check_for_update(app: tauri::AppHandle) -> Result<UpdateStatus, String> {
    let updater = app
        .updater()
        .map_err(|e| format!("Updater not available: {e}"))?;
    match updater.check().await {
        Ok(Some(update)) => Ok(UpdateStatus {
            available: true,
            version: Some(update.version),
            body: update.body,
        }),
        Ok(None) => Ok(UpdateStatus {
            available: false,
            version: None,
            body: None,
        }),
        Err(e) => Err(format!("Failed to check for updates: {e}")),
    }
}

/// Download and install the update, emitting `update-download-progress`
/// events (percent 0-100) so the UI can show a progress indicator.
#[tauri::command]
pub async fn download_and_install_update(app: tauri::AppHandle) -> Result<(), String> {
    let updater = app
        .updater()
        .map_err(|e| format!("Updater not available: {e}"))?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("Failed to check for updates: {e}"))?
        .ok_or("No update available")?;

    let emitter = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                let percent = match total {
                    Some(total) if total > 0 => ((chunk as f64 / total as f64) * 100.0) as u8,
                    _ => 0,
                };
                let _ = emitter.emit(UPDATE_PROGRESS_EVENT, percent.min(100));
            },
            || {
                // Download finished callback
            },
        )
        .await
        .map_err(|e| format!("Failed to install update: {e}"))?;

    Ok(())
}

/// Restart the application (used right after a successful update install).
#[tauri::command]
pub fn restart_app(app: tauri::AppHandle) {
    app.restart();
}

/// Get current app version
#[tauri::command]
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
