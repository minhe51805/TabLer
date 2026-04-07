use serde::Deserialize;
use tauri::{AppHandle, LogicalSize, Manager, Size};

const LAUNCHER_WIDTH: f64 = 520.0;
const LAUNCHER_HEIGHT: f64 = 420.0;
const FORM_WIDTH: f64 = 1160.0;
const FORM_HEIGHT: f64 = 760.0;
const FORM_MIN_WIDTH: f64 = 980.0;
const FORM_MIN_HEIGHT: f64 = 700.0;
const WORKSPACE_WIDTH: f64 = 1280.0;
const WORKSPACE_HEIGHT: f64 = 800.0;
const WORKSPACE_MIN_WIDTH: f64 = 800.0;
const WORKSPACE_MIN_HEIGHT: f64 = 500.0;

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WindowProfile {
    Launcher,
    Form,
    Workspace,
}

fn size(width: f64, height: f64) -> Size {
    Size::Logical(LogicalSize::new(width, height))
}

pub fn apply_window_profile_to_main(app: &AppHandle, profile: WindowProfile) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;

    window
        .set_decorations(false)
        .map_err(|error| format!("Failed to disable native window decorations: {error}"))?;

    if let Ok(true) = window.is_maximized() {
        window
            .unmaximize()
            .map_err(|error| format!("Failed to unmaximize window: {error}"))?;
    }

    match profile {
        WindowProfile::Launcher => {
            window
                .set_resizable(true)
                .map_err(|error| format!("Failed to unlock launcher resize: {error}"))?;
            window
                .set_maximizable(false)
                .map_err(|error| format!("Failed to disable launcher maximize: {error}"))?;
            window
                .set_min_size(Some(size(LAUNCHER_WIDTH, LAUNCHER_HEIGHT)))
                .map_err(|error| format!("Failed to set launcher minimum size: {error}"))?;
            window
                .set_max_size(Some(size(LAUNCHER_WIDTH, LAUNCHER_HEIGHT)))
                .map_err(|error| format!("Failed to set launcher maximum size: {error}"))?;
            window
                .set_size(size(LAUNCHER_WIDTH, LAUNCHER_HEIGHT))
                .map_err(|error| format!("Failed to set launcher size: {error}"))?;
            window
                .center()
                .map_err(|error| format!("Failed to center launcher window: {error}"))?;
            window
                .set_resizable(false)
                .map_err(|error| format!("Failed to lock launcher resize: {error}"))?;
        }
        WindowProfile::Form => {
            window
                .set_resizable(true)
                .map_err(|error| format!("Failed to unlock form resize: {error}"))?;
            window
                .set_maximizable(true)
                .map_err(|error| format!("Failed to enable form maximize: {error}"))?;
            window
                .set_max_size(Option::<Size>::None)
                .map_err(|error| format!("Failed to clear form maximum size: {error}"))?;
            window
                .set_min_size(Some(size(FORM_MIN_WIDTH, FORM_MIN_HEIGHT)))
                .map_err(|error| format!("Failed to set form minimum size: {error}"))?;
            window
                .set_size(size(FORM_WIDTH, FORM_HEIGHT))
                .map_err(|error| format!("Failed to set form size: {error}"))?;
            window
                .center()
                .map_err(|error| format!("Failed to center form window: {error}"))?;
        }
        WindowProfile::Workspace => {
            window
                .set_resizable(true)
                .map_err(|error| format!("Failed to unlock workspace resize: {error}"))?;
            window
                .set_maximizable(true)
                .map_err(|error| format!("Failed to enable workspace maximize: {error}"))?;
            window
                .set_max_size(Option::<Size>::None)
                .map_err(|error| format!("Failed to clear workspace maximum size: {error}"))?;
            window
                .set_min_size(Some(size(WORKSPACE_MIN_WIDTH, WORKSPACE_MIN_HEIGHT)))
                .map_err(|error| format!("Failed to set workspace minimum size: {error}"))?;
            window
                .set_size(size(WORKSPACE_WIDTH, WORKSPACE_HEIGHT))
                .map_err(|error| format!("Failed to set workspace size: {error}"))?;
            window
                .center()
                .map_err(|error| format!("Failed to center workspace window: {error}"))?;
        }
    }

    Ok(())
}

#[tauri::command]
pub fn apply_window_profile(profile: WindowProfile, app: AppHandle) -> Result<(), String> {
    apply_window_profile_to_main(&app, profile)
}
