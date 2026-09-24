use serde::{Deserialize, Serialize};

use super::parse::parse_argument_names;

/// Directory under the workspace root and the app data dir.
pub const COMMANDS_DIR_NAME: &str = "commands";

/// Records what the seeder last wrote, so a user edit is never overwritten.
pub const SEED_MANIFEST_NAME: &str = ".seeded.json";

/// Ceiling on commands read from one root - a hostile or accidental dump of
/// thousands of files must not stall startup.
pub const MAX_COMMANDS_PER_ROOT: usize = 128;

/// Matches `ai_skills.rs` (MAX_SKILL_BODY_CHARS): a runbook longer than this is
/// truncated, because the whole body is injected into the prompt.
pub const MAX_COMMAND_BODY_CHARS: usize = 8_000;

/// Matches `ai_skills.rs` (MAX_SKILL_ALLOWED_TOOLS).
pub const MAX_COMMAND_ALLOWED_TOOLS: usize = 32;

/// Context values a command may request through `inject:`.
///
/// This is the security boundary of the feature: a command file can only pull
/// from this list, so a hostile command dropped into `<workspace>/commands/`
/// cannot exfiltrate secrets into the prompt. Adding a value here is a
/// deliberate act, not an incidental one.
pub const INJECTABLE_CONTEXT_KEYS: &[&str] = &[
    "current_database",
    "bound_connection",
    "active_tab_sql",
    "selected_table",
    "schema_summary",
    "checkpoint_list",
];

/// The shipped command pack, embedded so every installer shape ships it.
pub const BUILTIN_COMMANDS: &[(&str, &str)] = &[
    ("explain.md", include_str!("../../commands/explain.md")),
    ("indexes.md", include_str!("../../commands/indexes.md")),
    ("plan.md", include_str!("../../commands/plan.md")),
    ("profile.md", include_str!("../../commands/profile.md")),
    (
        "review-sql.md",
        include_str!("../../commands/review-sql.md"),
    ),
    (
        "safe-update.md",
        include_str!("../../commands/safe-update.md"),
    ),
];

/// Where a command was read from. Precedence is `Workspace` > `Global` >
/// `Builtin`, and only `Builtin` is refreshed by an upgrade.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CommandOrigin {
    Builtin,
    Global,
    Workspace,
}

impl CommandOrigin {
    pub fn as_str(self) -> &'static str {
        match self {
            CommandOrigin::Builtin => "builtin",
            CommandOrigin::Global => "global",
            CommandOrigin::Workspace => "workspace",
        }
    }
}

/// One parsed command.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCommand {
    /// Command name without the leading slash (`name:` in frontmatter).
    pub name: String,
    pub description: String,
    /// Drives the composer affordance, e.g. `[table to profile]`.
    pub argument_hint: Option<String>,
    /// Tools this command narrows the run to. Empty means "no narrowing".
    pub allowed_tools: Vec<String>,
    /// App context keys to prepend as facts. Always a subset of
    /// `INJECTABLE_CONTEXT_KEYS`.
    pub inject: Vec<String>,
    /// Body below the frontmatter, with `$ARGUMENTS`/`{{input}}` left in place.
    pub body: String,
    /// Absolute path, for the manager UI.
    pub path: String,
    pub origin: CommandOrigin,
}

/// A command as the composer shows it: no body, so the menu stays cheap.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCommandSummary {
    pub name: String,
    pub description: String,
    pub argument_hint: Option<String>,
    /// Argument names, parsed from `argument-hint` for typed affordances.
    pub argument_names: Vec<String>,
    /// Tools this command narrows the run to (empty = no narrowing). Carried
    /// through so the frontend can enforce the declared restriction — the
    /// contract is narrowing only, never a grant.
    pub allowed_tools: Vec<String>,
    pub inject: Vec<String>,
    pub origin: CommandOrigin,
}

impl AgentCommand {
    pub fn summary(&self) -> AgentCommandSummary {
        AgentCommandSummary {
            name: self.name.clone(),
            description: self.description.clone(),
            argument_hint: self.argument_hint.clone(),
            argument_names: parse_argument_names(self.argument_hint.as_deref()),
            allowed_tools: self.allowed_tools.clone(),
            inject: self.inject.clone(),
            origin: self.origin,
        }
    }
}

/// One file that could not be loaded, and why. Reported, never swallowed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandLoadError {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandLoadReport {
    pub loaded: usize,
    pub skipped: usize,
    pub errors: Vec<CommandLoadError>,
}

/// The result of resolving `/name args` against the registry.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedCommand {
    pub command: AgentCommandSummary,
    /// The body with `$ARGUMENTS` substituted and injected facts prepended.
    pub prompt: String,
    /// The raw argument text the user typed after the command name.
    pub arguments: String,
    /// Tools this command narrows the run to (empty = no narrowing). Mirrored
    /// from `command.allowed_tools` at the top level so the caller can enforce
    /// the restriction without unpacking the summary.
    pub allowed_tools: Vec<String>,
    /// Context keys the command asked for but the host did not supply - the UI
    /// can then say "the active tab has no SQL" instead of the agent guessing.
    pub missing_context: Vec<String>,
}

// ---------------------------------------------------------------------------
