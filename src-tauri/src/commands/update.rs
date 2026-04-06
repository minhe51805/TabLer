use serde::{Deserialize, Serialize};
use tauri_plugin_updater::UpdaterExt;

#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateStatus {
    pub available: bool,
    pub version: Option<String>,
    pub body: Option<String>,
}

/// Check if an update is available
#[tauri::command]
pub async fn check_for_update(app: tauri::AppHandle) -> Result<UpdateStatus, String> {
    let updater = app.updater().map_err(|e| format!("Updater not available: {e}"))?;
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

/// Download and install the update
#[tauri::command]
pub async fn download_and_install_update(app: tauri::AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| format!("Updater not available: {e}"))?;
    let update = updater.check().await.map_err(|e| format!("Failed to check for updates: {e}"))?
        .ok_or("No update available")?;

    update.download_and_install(
        |_chunk, _total| {
            // Progress tracking can be added here if needed
        },
        || {
            // Download finished callback
        },
    ).await.map_err(|e| format!("Failed to install update: {e}"))?;

    Ok(())
}

/// Get current app version
#[tauri::command]
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
