use serde::Serialize;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;
use uuid::Uuid;

const TERMINAL_ACCESS_ENABLED: bool = false;

#[derive(Clone)]
struct TerminalSession {
    stdin: Arc<Mutex<ChildStdin>>,
    child: Arc<Mutex<Child>>,
}

#[derive(Serialize, Clone)]
struct TerminalOutputEvent {
    session_id: String,
    stream: String,
    text: String,
}

static TERMINAL_SESSIONS: OnceLock<Arc<Mutex<HashMap<String, TerminalSession>>>> = OnceLock::new();

fn sessions() -> &'static Arc<Mutex<HashMap<String, TerminalSession>>> {
    TERMINAL_SESSIONS.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

#[tauri::command]
pub async fn start_terminal_session(app: AppHandle, cwd: Option<String>) -> Result<String, String> {
    if !TERMINAL_ACCESS_ENABLED {
        return Err("Integrated terminal is disabled in secure mode.".to_string());
    }

    let session_id = Uuid::new_v4().to_string();

    let mut cmd = if cfg!(target_os = "windows") {
        let mut c = Command::new("cmd.exe");
        c.args(["/Q", "/K", "chcp 65001 >nul"]);
        c
    } else {
        Command::new("sh")
    };

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start terminal: {}", e))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Failed to capture terminal stdin".to_string())?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture terminal stdout".to_string())?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture terminal stderr".to_string())?;

    let session = TerminalSession {
        stdin: Arc::new(Mutex::new(stdin)),
        child: Arc::new(Mutex::new(child)),
    };

    sessions().lock().await.insert(session_id.clone(), session.clone());

    let app_out = app.clone();
    let session_out = session_id.clone();
    tokio::spawn(async move {
        let mut buf = [0_u8; 4096];
        loop {
            match stdout.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_out.emit(
                        "terminal-output",
                        TerminalOutputEvent {
                            session_id: session_out.clone(),
                            stream: "stdout".to_string(),
                            text,
                        },
                    );
                }
                Err(_) => break,
            }
        }
    });

    let app_err = app.clone();
    let session_err = session_id.clone();
    tokio::spawn(async move {
        let mut buf = [0_u8; 4096];
        loop {
            match stderr.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_err.emit(
                        "terminal-output",
                        TerminalOutputEvent {
                            session_id: session_err.clone(),
                            stream: "stderr".to_string(),
                            text,
                        },
                    );
                }
                Err(_) => break,
            }
        }
    });

    Ok(session_id)
}

#[tauri::command]
pub async fn send_terminal_input(session_id: String, input: String) -> Result<(), String> {
    if !TERMINAL_ACCESS_ENABLED {
        return Err("Integrated terminal is disabled in secure mode.".to_string());
    }

    let map = sessions().lock().await;
    let session = map
        .get(&session_id)
        .ok_or_else(|| "Terminal session not found".to_string())?
        .clone();
    drop(map);

    let mut stdin = session.stdin.lock().await;
    stdin
        .write_all(input.as_bytes())
        .await
        .map_err(|e| format!("Failed to write to terminal: {}", e))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("Failed to flush terminal input: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn stop_terminal_session(session_id: String) -> Result<(), String> {
    if !TERMINAL_ACCESS_ENABLED {
        return Err("Integrated terminal is disabled in secure mode.".to_string());
    }

    let mut map = sessions().lock().await;
    let session = map
        .remove(&session_id)
        .ok_or_else(|| "Terminal session not found".to_string())?;
    drop(map);

    let mut child = session.child.lock().await;
    let _ = child.kill().await;
    Ok(())
}
