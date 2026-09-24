use std::collections::HashMap;
use std::path::PathBuf;

use crate::utils::paths::resolve_data_dir;

use super::parse::render_command;
use super::roots::load_commands;
use super::seed::{
    global_commands_root, seed_commands_into_root, CommandRegistry, CommandSeedReport,
};
use super::types::{AgentCommand, CommandLoadReport, ResolvedCommand};
pub fn parse_command_line(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim();
    let rest = trimmed.strip_prefix('/')?;
    let mut parts = rest.splitn(2, char::is_whitespace);
    let name = parts.next().unwrap_or_default().trim();
    if name.is_empty() {
        return None;
    }
    Some((
        name.to_ascii_lowercase(),
        parts.next().unwrap_or_default().trim().to_string(),
    ))
}

/// First three characters, used for a cheap "did you mean" suggestion.
///
/// Built from `chars()` rather than byte slicing: the typed name is user input
/// and may be non-ASCII, and slicing a UTF-8 string at a byte index would panic.
fn name_head(value: &str) -> String {
    value.chars().take(3).collect()
}

fn shares_prefix(a: &str, b: &str) -> bool {
    let head = name_head(a);
    head.chars().count() >= 3 && head.eq_ignore_ascii_case(&name_head(b))
}

/// Why a `/name` did not resolve, with the closest names so a typo is fixable
/// and a *broken* command file is never mistaken for a missing command.
pub(crate) fn unknown_command_reason(
    name: &str,
    known: &[AgentCommand],
    report: &CommandLoadReport,
) -> String {
    let mut suggestions: Vec<String> = known
        .iter()
        .filter(|command| {
            command.name.contains(name)
                || name.contains(command.name.as_str())
                || shares_prefix(&command.name, name)
        })
        // The origin is part of the suggestion on purpose: "closest is
        // /profiler" does not tell you *which file* to open, while
        // "/profiler (workspace)" does.
        .map(|command| format!("/{} ({})", command.name, command.origin.as_str()))
        .collect();
    suggestions.truncate(5);

    let mut reason = if suggestions.is_empty() {
        format!("no command named `/{name}` is installed")
    } else {
        format!(
            "no command named `/{name}` is installed; closest are {}",
            suggestions.join(", ")
        )
    };

    // A command the user *did* write but which failed to parse must be named here.
    // Otherwise "not installed" is a lie, and the file sits on disk being ignored.
    if !report.errors.is_empty() {
        reason.push_str(&format!(
            ". {} command file(s) failed to load: {}",
            report.errors.len(),
            report
                .errors
                .iter()
                .map(|error| format!("{} ({})", error.path, error.reason))
                .collect::<Vec<_>>()
                .join("; ")
        ));
    }

    reason
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Idempotent seed, exposed so the commands manager can re-run it on demand.
#[tauri::command]
pub fn seed_ai_builtin_commands(force: Option<bool>) -> Result<CommandSeedReport, String> {
    seed_commands_into_root(&global_commands_root()?, force.unwrap_or(false))
}

/// Force-restore every built-in command, discarding user edits to them. This is
/// the only path that overwrites a modified command and is always user-initiated.
#[tauri::command]
pub fn reset_ai_builtin_commands() -> Result<CommandSeedReport, String> {
    seed_commands_into_root(&global_commands_root()?, true)
}

/// Everything the composer's `/` menu needs: the registry plus load health.
#[tauri::command]
pub fn list_ai_commands(workspace_dir: Option<String>) -> Result<CommandRegistry, String> {
    let data_dir = resolve_data_dir().map_err(|error| error.to_string())?;
    let workspace = workspace_dir.map(PathBuf::from);
    let (commands, report) = load_commands(workspace.as_deref(), &data_dir);

    Ok(CommandRegistry {
        commands: commands.iter().map(AgentCommand::summary).collect(),
        report,
    })
}

/// The composer's `/` menu registry: every command under `<data_dir>/commands`
/// — the seeded pack plus the user's own `.md` files — with load health so a
/// broken file surfaces as a warning instead of a silent absence.
///
/// Same payload as `list_ai_commands`, minus the workspace root: the composer
/// has no workspace context, so user commands live in the data dir only.
#[tauri::command]
#[allow(dead_code)] // registered in lib.rs alongside the other command handlers
pub fn list_user_slash_commands() -> Result<CommandRegistry, String> {
    let data_dir = resolve_data_dir().map_err(|error| error.to_string())?;
    let (commands, report) = load_commands(None, &data_dir);

    Ok(CommandRegistry {
        commands: commands.iter().map(AgentCommand::summary).collect(),
        report,
    })
}

/// Turn `/name arguments` into the prompt the agent actually receives.
///
/// The frontend supplies `context` because only it knows the live UI state; this
/// command emits **only** the keys the command's `inject:` names, and reports the
/// ones the host could not supply instead of letting the model guess.
#[tauri::command]
pub fn resolve_ai_command(
    workspace_dir: Option<String>,
    command_line: String,
    context: Option<HashMap<String, String>>,
) -> Result<ResolvedCommand, String> {
    let data_dir = resolve_data_dir().map_err(|error| error.to_string())?;
    let workspace = workspace_dir.map(PathBuf::from);
    let (commands, report) = load_commands(workspace.as_deref(), &data_dir);

    let (name, arguments) = parse_command_line(&command_line)
        .ok_or_else(|| format!("`{}` is not a slash command", command_line.trim()))?;

    let command = commands
        .iter()
        .find(|candidate| candidate.name.eq_ignore_ascii_case(&name))
        .ok_or_else(|| unknown_command_reason(&name, &commands, &report))?;

    Ok(render_command(
        command,
        &arguments,
        &context.unwrap_or_default(),
    ))
}
