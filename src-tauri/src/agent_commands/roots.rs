use std::collections::HashSet;
use std::path::{Path, PathBuf};

use super::parse::parse_command;
use super::types::{
    AgentCommand, CommandLoadError, CommandLoadReport, CommandOrigin, BUILTIN_COMMANDS,
    COMMANDS_DIR_NAME, MAX_COMMANDS_PER_ROOT,
};
pub fn command_roots(workspace_dir: Option<&Path>, data_dir: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();

    if let Some(workspace) = workspace_dir {
        roots.push(workspace.join(COMMANDS_DIR_NAME));
    }

    roots.push(data_dir.join(COMMANDS_DIR_NAME));
    roots
}

/// Discover every command under `roots`.
///
/// Same contract as `agent_rules::load_rules_from_roots`: a missing directory is
/// normal, a broken file is reported instead of aborting, and the first root wins
/// so a workspace command shadows the seeded one of the same name.
pub fn load_commands_from_roots(roots: &[PathBuf]) -> (Vec<AgentCommand>, CommandLoadReport) {
    let mut commands: Vec<AgentCommand> = Vec::new();
    let mut report = CommandLoadReport::default();
    let mut seen: HashSet<String> = HashSet::new();
    // `command_roots` puts the data dir last: everything before it is
    // workspace-owned, so a repo command shadows the seeded pack.
    let data_dir_root = roots.last().cloned();

    for root in roots {
        let is_data_dir_root = data_dir_root.as_deref() == Some(root.as_path());
        let entries = match std::fs::read_dir(root) {
            Ok(entries) => entries,
            Err(_) => continue,
        };

        let mut paths: Vec<PathBuf> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.is_file())
            .collect();
        paths.sort();

        for path in paths {
            if !path
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
            {
                continue;
            }

            if commands.len() >= MAX_COMMANDS_PER_ROOT {
                report.errors.push(CommandLoadError {
                    path: path.display().to_string(),
                    reason: format!(
                        "more than {MAX_COMMANDS_PER_ROOT} commands in one root; ignoring the rest"
                    ),
                });
                break;
            }

            let contents = match std::fs::read_to_string(&path) {
                Ok(contents) => contents,
                Err(error) => {
                    report.errors.push(CommandLoadError {
                        path: path.display().to_string(),
                        reason: format!("cannot read command: {error}"),
                    });
                    continue;
                }
            };

            let fallback = path
                .file_stem()
                .map(|stem| stem.to_string_lossy().to_string())
                .unwrap_or_default();

            let origin = if is_data_dir_root {
                // An exact-content match against the embedded pack means the file is
                // an untouched built-in; an edited copy is the user's own command.
                let file_name = path
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_default();
                if BUILTIN_COMMANDS
                    .iter()
                    .any(|(name, body)| *name == file_name && *body == contents)
                {
                    CommandOrigin::Builtin
                } else {
                    CommandOrigin::Global
                }
            } else {
                CommandOrigin::Workspace
            };

            match parse_command(&fallback, &contents, &path, origin) {
                Ok(command) => {
                    if !seen.insert(command.name.clone()) {
                        report.skipped += 1;
                        continue;
                    }
                    report.loaded += 1;
                    commands.push(command);
                }
                Err(reason) => report.errors.push(CommandLoadError {
                    path: path.display().to_string(),
                    reason,
                }),
            }
        }
    }

    commands.sort_by(|a, b| a.name.cmp(&b.name));
    (commands, report)
}

/// Load the commands that apply to this workspace.
pub fn load_commands(
    workspace_dir: Option<&Path>,
    data_dir: &Path,
) -> (Vec<AgentCommand>, CommandLoadReport) {
    load_commands_from_roots(&command_roots(workspace_dir, data_dir))
}
