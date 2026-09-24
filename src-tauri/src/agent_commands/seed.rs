use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::utils::paths::resolve_data_dir;

use super::types::{
    AgentCommandSummary, CommandLoadReport, BUILTIN_COMMANDS, COMMANDS_DIR_NAME, SEED_MANIFEST_NAME,
};

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct CommandManifestEntry {
    /// sha256 of the content we last wrote for this command.
    hash: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct CommandManifest {
    #[serde(default)]
    commands: BTreeMap<String, CommandManifestEntry>,
}

/// What one seed pass did to one file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeededCommandStatus {
    pub name: String,
    /// `installed` | `refreshed` | `unchanged` | `userModified`.
    pub state: String,
}

/// Aggregate result of a seed pass, shaped like the rules/skills reports so the
/// manager UI can treat every pack the same way.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandSeedReport {
    pub installed: usize,
    pub refreshed: usize,
    pub unchanged: usize,
    pub user_modified: usize,
    pub commands: Vec<SeededCommandStatus>,
}

/// The registry plus the health of the pack that produced it.
///
/// Callers must see the load errors: with them, "the command is not in the menu"
/// is a diagnosable fact; without them it is a mystery.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandRegistry {
    pub commands: Vec<AgentCommandSummary>,
    pub report: CommandLoadReport,
}

fn hex_sha256(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn load_command_manifest(commands_root: &Path) -> CommandManifest {
    let path = commands_root.join(SEED_MANIFEST_NAME);
    // A corrupt manifest is treated as empty, which makes every existing file
    // look user-modified - so nothing is overwritten until the user asks.
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<CommandManifest>(&raw).ok())
        .unwrap_or_default()
}

fn save_command_manifest(commands_root: &Path, manifest: &CommandManifest) -> Result<(), String> {
    let path = commands_root.join(SEED_MANIFEST_NAME);
    let raw = serde_json::to_string_pretty(manifest).map_err(|error| error.to_string())?;
    std::fs::write(&path, raw).map_err(|error| error.to_string())
}

/// True when the installed command still matches what we last wrote.
///
/// Asymmetric on purpose, exactly like the rules seeder: a **changed** file
/// holds user intent (stop), a **missing** file holds nothing (restore).
fn is_command_untouched(installed: &Path, record: Option<&CommandManifestEntry>) -> bool {
    let Some(record) = record else {
        // No record of writing it: assume the user put it there.
        return false;
    };

    match std::fs::read(installed) {
        Ok(bytes) => hex_sha256(&bytes) == record.hash,
        Err(_) => true,
    }
}

fn seed_command_one(
    commands_root: &Path,
    file_name: &str,
    content: &str,
    record: Option<&CommandManifestEntry>,
    force: bool,
) -> Result<(SeededCommandStatus, Option<CommandManifestEntry>), String> {
    let installed = commands_root.join(file_name);
    let existed = installed.exists();

    if existed && !force && !is_command_untouched(&installed, record) {
        return Ok((
            SeededCommandStatus {
                name: file_name.to_string(),
                state: "userModified".to_string(),
            },
            None,
        ));
    }

    let wanted = hex_sha256(content.as_bytes());
    let same_on_disk = std::fs::read(&installed)
        .map(|bytes| hex_sha256(&bytes) == wanted)
        .unwrap_or(false);

    let state = if !existed {
        "installed"
    } else if same_on_disk {
        "unchanged"
    } else {
        "refreshed"
    };

    if !same_on_disk {
        std::fs::write(&installed, content).map_err(|error| error.to_string())?;
    }

    Ok((
        SeededCommandStatus {
            name: file_name.to_string(),
            state: state.to_string(),
        },
        Some(CommandManifestEntry { hash: wanted }),
    ))
}

/// Seed the whole pack into an explicit root - split out so tests drive a temp
/// directory instead of the real data dir.
pub(crate) fn seed_commands_into_root(
    commands_root: &Path,
    force: bool,
) -> Result<CommandSeedReport, String> {
    std::fs::create_dir_all(commands_root).map_err(|error| error.to_string())?;
    let mut manifest = load_command_manifest(commands_root);
    let mut report = CommandSeedReport::default();

    for (file_name, content) in BUILTIN_COMMANDS {
        let record = manifest.commands.get(*file_name);
        let (status, new_record) =
            seed_command_one(commands_root, file_name, content, record, force)?;
        match status.state.as_str() {
            "installed" => report.installed += 1,
            "refreshed" => report.refreshed += 1,
            "userModified" => report.user_modified += 1,
            _ => report.unchanged += 1,
        }
        if let Some(entry) = new_record {
            manifest.commands.insert(file_name.to_string(), entry);
        }
        report.commands.push(status);
    }

    save_command_manifest(commands_root, &manifest)?;
    Ok(report)
}

/// Absolute path of the global commands root (mirrors `command_roots` so the
/// seeder and the reader can never disagree about where commands live).
pub(crate) fn global_commands_root() -> Result<PathBuf, String> {
    let data_dir = resolve_data_dir().map_err(|error| error.to_string())?;
    Ok(data_dir.join(COMMANDS_DIR_NAME))
}

/// Install/refresh the built-in pack into the global commands directory.
///
/// Safe to call on every startup: once installed this is a handful of `stat`
/// calls, and it is what makes a fresh install useful - without it the composer
/// menu would be empty on first run.
pub fn seed_builtin_commands(force: bool) -> Result<CommandSeedReport, String> {
    seed_commands_into_root(&global_commands_root()?, force)
}

/// File names of the shipped pack, for the manifest parity test and the manager UI.
#[allow(dead_code)] // seeded on disk by `seed_ai_builtin_commands`; read by the manifest parity test
pub fn builtin_command_manifest() -> Vec<String> {
    BUILTIN_COMMANDS
        .iter()
        .map(|(name, _)| (*name).to_string())
        .collect()
}
