use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

const TERMINAL_OUTPUT_EVENT: &str = "terminal-output";
const TERMINAL_EXIT_EVENT: &str = "terminal-exit";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionInfo {
    pub session_id: String,
    pub shell_label: String,
    pub cwd: String,
}

/// Safe, non-secret database metadata made available to a terminal session.
/// Credentials are intentionally absent: the terminal must never receive a password.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalDatabaseContext {
    pub connection_id: String,
    pub connection_name: String,
    pub db_type: String,
    pub database: Option<String>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub username: Option<String>,
    pub file_path: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutputPayload {
    session_id: String,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExitPayload {
    session_id: String,
    reason: String,
}

#[derive(Clone)]
pub struct TerminalManager {
    sessions: Arc<Mutex<HashMap<String, TerminalSession>>>,
}

impl Default for TerminalManager {
    fn default() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

struct TerminalSession {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send>>>,
    info: TerminalSessionInfo,
}

#[derive(Clone)]
struct ShellLaunchConfig {
    program: String,
    args: Vec<String>,
    label: String,
}

fn get_shell_launch_config() -> ShellLaunchConfig {
    #[cfg(target_os = "windows")]
    {
        let shell = env::var("TABLER_TERMINAL_SHELL")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "powershell.exe".to_string());

        ShellLaunchConfig {
            program: shell,
            args: vec!["-NoLogo".to_string()],
            label: "PowerShell".to_string(),
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let shell = env::var("TABLER_TERMINAL_SHELL")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| env::var("SHELL").ok())
            .unwrap_or_else(|| "/bin/bash".to_string());

        let label = PathBuf::from(&shell)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("shell")
            .to_string();

        ShellLaunchConfig {
            program: shell,
            args: vec!["-l".to_string()],
            label,
        }
    }
}

fn resolve_terminal_cwd(cwd: Option<String>) -> PathBuf {
    let requested = cwd
        .map(PathBuf::from)
        .filter(|path| path.exists() && path.is_dir());

    requested
        .or_else(|| env::current_dir().ok())
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn database_context_environment(context: &TerminalDatabaseContext) -> Vec<(String, String)> {
    let mut variables = vec![
        (
            "TABLER_ACTIVE_CONNECTION_ID".to_string(),
            context.connection_id.clone(),
        ),
        (
            "TABLER_ACTIVE_CONNECTION_NAME".to_string(),
            context.connection_name.clone(),
        ),
        ("TABLER_ACTIVE_DB_TYPE".to_string(), context.db_type.clone()),
    ];
    if let Some(database) = context
        .database
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        variables.push(("TABLER_ACTIVE_DATABASE".to_string(), database.to_string()));
    }
    if let Some(host) = context
        .host
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        variables.push(("TABLER_ACTIVE_HOST".to_string(), host.to_string()));
    }
    if let Some(port) = context.port {
        variables.push(("TABLER_ACTIVE_PORT".to_string(), port.to_string()));
    }
    if let Some(username) = context
        .username
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        variables.push(("TABLER_ACTIVE_USERNAME".to_string(), username.to_string()));
    }
    if let Some(file_path) = context
        .file_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        variables.push(("TABLER_ACTIVE_FILE_PATH".to_string(), file_path.to_string()));
    }
    variables
}

fn emit_terminal_exit(
    app: &AppHandle,
    sessions: &Arc<Mutex<HashMap<String, TerminalSession>>>,
    session_id: &str,
    reason: String,
) {
    {
        let mut guard = sessions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.remove(session_id);
    }

    let _ = app.emit(
        TERMINAL_EXIT_EVENT,
        TerminalExitPayload {
            session_id: session_id.to_string(),
            reason,
        },
    );
}

#[tauri::command]
pub fn open_terminal(
    app: AppHandle,
    terminal_manager: State<'_, TerminalManager>,
    session_id: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    database_context: Option<TerminalDatabaseContext>,
) -> Result<TerminalSessionInfo, String> {
    {
        let guard = terminal_manager
            .sessions
            .lock()
            .map_err(|_| "Terminal session registry is unavailable".to_string())?;
        if let Some(session) = guard.get(&session_id) {
            return Ok(session.info.clone());
        }
    }

    let shell = get_shell_launch_config();
    let resolved_cwd = resolve_terminal_cwd(cwd);
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("Failed to create terminal PTY: {error}"))?;

    let mut command = CommandBuilder::new(&shell.program);
    for arg in &shell.args {
        command.arg(arg);
    }
    command.cwd(&resolved_cwd);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "TableR");
    if let Some(context) = database_context.as_ref() {
        for (key, value) in database_context_environment(context) {
            command.env(key, value);
        }
    }

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("Failed to spawn terminal shell: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("Failed to attach terminal writer: {error}"))?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("Failed to attach terminal reader: {error}"))?;

    let info = TerminalSessionInfo {
        session_id: session_id.clone(),
        shell_label: shell.label,
        cwd: resolved_cwd.display().to_string(),
    };

    let sessions = terminal_manager.sessions.clone();
    let session = TerminalSession {
        writer: Arc::new(Mutex::new(writer)),
        master: Arc::new(Mutex::new(pair.master)),
        child: Arc::new(Mutex::new(child)),
        info: info.clone(),
    };

    {
        let mut guard = sessions
            .lock()
            .map_err(|_| "Terminal session registry is unavailable".to_string())?;
        guard.insert(session_id.clone(), session);
    }

    let app_handle = app.clone();
    let session_id_for_thread = session_id.clone();
    let sessions_for_thread = sessions.clone();
    std::thread::spawn(move || {
        let mut buffer = [0u8; 8192];

        loop {
            match reader.read(&mut buffer) {
                Ok(0) => {
                    emit_terminal_exit(
                        &app_handle,
                        &sessions_for_thread,
                        &session_id_for_thread,
                        "Shell exited".to_string(),
                    );
                    break;
                }
                Ok(read_len) => {
                    let output = String::from_utf8_lossy(&buffer[..read_len]).to_string();
                    if app_handle
                        .emit(
                            TERMINAL_OUTPUT_EVENT,
                            TerminalOutputPayload {
                                session_id: session_id_for_thread.clone(),
                                data: output,
                            },
                        )
                        .is_err()
                    {
                        break;
                    }
                }
                Err(error) => {
                    emit_terminal_exit(
                        &app_handle,
                        &sessions_for_thread,
                        &session_id_for_thread,
                        format!("Terminal stream closed: {error}"),
                    );
                    break;
                }
            }
        }
    });

    Ok(info)
}

#[tauri::command]
pub fn write_terminal(
    terminal_manager: State<'_, TerminalManager>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let sessions = terminal_manager
        .sessions
        .lock()
        .map_err(|_| "Terminal session registry is unavailable".to_string())?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "Terminal session not found".to_string())?;
    let mut writer = session
        .writer
        .lock()
        .map_err(|_| "Terminal writer is unavailable".to_string())?;

    writer
        .write_all(data.as_bytes())
        .map_err(|error| format!("Failed to write to terminal: {error}"))?;
    writer
        .flush()
        .map_err(|error| format!("Failed to flush terminal input: {error}"))?;

    Ok(())
}

#[tauri::command]
pub fn resize_terminal(
    terminal_manager: State<'_, TerminalManager>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = terminal_manager
        .sessions
        .lock()
        .map_err(|_| "Terminal session registry is unavailable".to_string())?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "Terminal session not found".to_string())?;
    let master = session
        .master
        .lock()
        .map_err(|_| "Terminal PTY is unavailable".to_string())?;

    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("Failed to resize terminal: {error}"))?;

    Ok(())
}

#[tauri::command]
pub fn close_terminal(
    terminal_manager: State<'_, TerminalManager>,
    session_id: String,
) -> Result<(), String> {
    let session = {
        let mut sessions = terminal_manager
            .sessions
            .lock()
            .map_err(|_| "Terminal session registry is unavailable".to_string())?;
        sessions.remove(&session_id)
    };

    if let Some(session) = session {
        if let Ok(mut child) = session.child.lock() {
            let _ = child.kill();
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{database_context_environment, TerminalDatabaseContext};

    #[test]
    fn terminal_database_context_exports_only_safe_metadata() {
        let variables = database_context_environment(&TerminalDatabaseContext {
            connection_id: "connection-1".to_string(),
            connection_name: "Production reporting".to_string(),
            db_type: "postgresql".to_string(),
            database: Some("reporting".to_string()),
            host: Some("db.example.test".to_string()),
            port: Some(5432),
            username: Some("readonly".to_string()),
            file_path: None,
        });

        assert!(variables
            .iter()
            .any(|(key, value)| key == "TABLER_ACTIVE_DATABASE" && value == "reporting"));
        assert!(variables.iter().all(|(key, value)| {
            !key.to_ascii_lowercase().contains("password")
                && !value.to_ascii_lowercase().contains("password")
        }));
    }
}
