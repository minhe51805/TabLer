use serde::Deserialize;
use std::sync::atomic::{AtomicU8, Ordering};
use tauri::{AppHandle, LogicalSize, Manager, Size};
use tauri_plugin_opener::OpenerExt;

const LAUNCHER_WIDTH: f64 = 720.0;
const LAUNCHER_HEIGHT: f64 = 520.0;
const FORM_WIDTH: f64 = 1160.0;
const FORM_HEIGHT: f64 = 760.0;
const FORM_MIN_WIDTH: f64 = 980.0;
const FORM_MIN_HEIGHT: f64 = 700.0;
const WORKSPACE_WIDTH: f64 = 1280.0;
const WORKSPACE_HEIGHT: f64 = 800.0;
const WORKSPACE_MIN_WIDTH: f64 = 800.0;
const WORKSPACE_MIN_HEIGHT: f64 = 500.0;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WindowProfile {
    Launcher,
    Form,
    Workspace,
}

fn size(width: f64, height: f64) -> Size {
    Size::Logical(LogicalSize::new(width, height))
}

/// Last applied window profile (0 = none, 1 = launcher, 2 = form, 3 = workspace).
/// Re-applying the workspace profile while already in it must not resize,
/// re-center, or drop the maximized state — that made the window visibly
/// "flap" whenever connection flags flickered.
static LAST_APPLIED_PROFILE: AtomicU8 = AtomicU8::new(0);

/// Apply window profile settings asynchronously to avoid macOS first responder issues
pub fn apply_window_profile_to_main(app: &AppHandle, profile: WindowProfile) -> Result<(), String> {
    let requested = match profile {
        WindowProfile::Launcher => 1u8,
        WindowProfile::Form => 2u8,
        WindowProfile::Workspace => 3u8,
    };
    let reapplying_workspace = profile == WindowProfile::Workspace
        && LAST_APPLIED_PROFILE.load(Ordering::Relaxed) == requested;

    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;

    window
        .set_decorations(false)
        .map_err(|error| format!("Failed to disable native window decorations: {error}"))?;

    // On macOS, calling window methods during setup can cause first responder issues.
    // We safely check maximized state and ignore errors.
    let was_maximized = window.is_maximized().unwrap_or(false);
    if was_maximized && !reapplying_workspace {
        let _ = window.unmaximize();
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
            // Only force the default size/position when entering the workspace
            // from another profile; re-applying it must keep the user's size,
            // position, and maximized state untouched.
            if !reapplying_workspace {
                window
                    .set_size(size(WORKSPACE_WIDTH, WORKSPACE_HEIGHT))
                    .map_err(|error| format!("Failed to set workspace size: {error}"))?;
                window
                    .center()
                    .map_err(|error| format!("Failed to center workspace window: {error}"))?;
            }
        }
    }

    LAST_APPLIED_PROFILE.store(requested, Ordering::Relaxed);

    Ok(())
}

#[tauri::command]
pub fn apply_window_profile(profile: WindowProfile, app: AppHandle) -> Result<(), String> {
    apply_window_profile_to_main(&app, profile)
}

/// Open an http(s) URL in the user's default browser (Help → Report an issue /
/// Send feedback). The scheme is restricted so the command can never be used
/// to launch local files or custom protocol handlers.
#[tauri::command]
pub fn open_external_url(url: String, app: AppHandle) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("Only http(s) URLs can be opened externally".to_string());
    }
    app.opener()
        .open_url(&url, None::<String>)
        .map_err(|e| format!("Failed to open external URL: {}", e))
}

/// Whether closing the main window hides it to the tray instead of quitting.
/// Frontend-owned setting (localStorage) mirrored here at boot and on toggle;
/// the Rust side needs it synchronously inside the CloseRequested handler.
static KEEP_RUNNING_IN_BACKGROUND: AtomicU8 = AtomicU8::new(0);

pub fn keep_running_in_background() -> bool {
    KEEP_RUNNING_IN_BACKGROUND.load(Ordering::Relaxed) == 1
}

#[tauri::command]
pub fn set_keep_running_in_background(enabled: bool) -> Result<(), String> {
    KEEP_RUNNING_IN_BACKGROUND.store(if enabled { 1 } else { 0 }, Ordering::Relaxed);
    Ok(())
}
