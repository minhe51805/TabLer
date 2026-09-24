use regex::Regex;
use serde::{Deserialize, Serialize};

/// Directory name, used for both the built-in pack and user rules.
pub const RULES_DIR_NAME: &str = "rules";
/// Manifest recording the hash of every file this module wrote, so an upgrade
/// may refresh a rule the user never touched but never clobber an edit.
pub const SEED_MANIFEST_NAME: &str = ".seeded.json";
/// Upper bound on how many rule files are loaded from one root.
pub const MAX_RULES_PER_ROOT: usize = 512;
/// Upper bound on a statement handed to the evaluator (2 MB).
pub const MAX_STATEMENT_LEN: usize = 2 * 1024 * 1024;
/// Upper bound on a compiled pattern's source length.
pub const MAX_PATTERN_LEN: usize = 8_000;

/// The built-in pack, embedded at compile time so every installer format ships
/// it and the app works with an empty data directory.
pub const BUILTIN_RULES: &[(&str, &str)] = &[
    (
        "no-delete-without-where.md",
        include_str!("../../rules/no-delete-without-where.md"),
    ),
    (
        "no-update-without-where.md",
        include_str!("../../rules/no-update-without-where.md"),
    ),
    (
        "no-drop-truncate-without-explicit-ask.md",
        include_str!("../../rules/no-drop-truncate-without-explicit-ask.md"),
    ),
    (
        "no-select-star-on-large-table.md",
        include_str!("../../rules/no-select-star-on-large-table.md"),
    ),
    (
        "require-parameterized-literals.md",
        include_str!("../../rules/require-parameterized-literals.md"),
    ),
    (
        "require-transaction-for-multi-statement-write.md",
        include_str!("../../rules/require-transaction-for-multi-statement-write.md"),
    ),
    (
        "no-cross-database-write.md",
        include_str!("../../rules/no-cross-database-write.md"),
    ),
    (
        "no-lock-hints-on-write.md",
        include_str!("../../rules/no-lock-hints-on-write.md"),
    ),
];

/// Which agent step a rule guards.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuleEvent {
    /// Fires before a read-only step (introspection, SELECT).
    PreRead,
    /// Fires before a statement that mutates data or schema.
    PreWrite,
    /// Fires for both.
    Any,
}

impl RuleEvent {
    /// Tolerant parsing: an unknown value falls back to `Any`, which keeps the
    /// guardrail armed instead of silently disarming it.
    pub fn parse(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().replace('-', "_").as_str() {
            "pre_read" | "read" | "pre_read_only" => RuleEvent::PreRead,
            "pre_write" | "write" | "pre_execute" => RuleEvent::PreWrite,
            _ => RuleEvent::Any,
        }
    }

    pub fn covers(self, requested: RuleEvent) -> bool {
        self == RuleEvent::Any || requested == RuleEvent::Any || self == requested
    }
}

/// What the caller must do when a rule matches.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuleAction {
    /// Record it and surface it to the model as a caution.
    Warn,
    /// Ask the human before the step runs.
    RequireApproval,
    /// Refuse to run the step at all.
    Block,
}

impl RuleAction {
    pub fn as_str(self) -> &'static str {
        match self {
            RuleAction::Warn => "warn",
            RuleAction::RequireApproval => "require_approval",
            RuleAction::Block => "block",
        }
    }

    /// Tolerant parsing; an unknown value degrades to `Warn` - the weakest
    /// action that still surfaces the problem - rather than to silence.
    pub fn parse(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().replace('-', "_").as_str() {
            "block" | "deny" | "forbid" => RuleAction::Block,
            "require_approval" | "approval" | "ask" | "confirm" => RuleAction::RequireApproval,
            _ => RuleAction::Warn,
        }
    }
}

/// Coarse statement class, derived from the leading keyword of each statement.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SqlEvent {
    Read,
    Write,
    Unknown,
}

impl SqlEvent {
    /// The guardrail event implied by this statement class. An unknown class is
    /// treated as a write so no write-sized blast radius can slip past.
    pub fn guardrail_event(self) -> RuleEvent {
        match self {
            SqlEvent::Read => RuleEvent::PreRead,
            SqlEvent::Write | SqlEvent::Unknown => RuleEvent::PreWrite,
        }
    }
}

/// Where a rule came from, so the UI can label provenance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuleOrigin {
    /// Embedded in the binary and seeded into `<data_dir>/rules`.
    Builtin,
    /// `<data_dir>/rules` file that is not part of the embedded pack.
    Global,
    /// `<workspace>/rules` file.
    Workspace,
}

/// Which body a rule's patterns are matched against.
///
/// `Skeleton` is the safe default: comments and string literals are erased so a
/// keyword inside them cannot masquerade as the statement's verb. A rule that
/// deliberately inspects literal text - `'..' + @id` concatenation is the
/// canonical case - must opt into `Raw`, otherwise the skeleton would erase the
/// very characters it looks for and the guardrail would be inert.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuleScan {
    /// Comments and literals replaced by spaces.
    Skeleton,
    /// The statement exactly as written.
    Raw,
}

impl RuleScan {
    /// Tolerant parsing; an unknown value falls back to `Skeleton`, the narrower
    /// of the two, so a typo cannot silently widen matching.
    pub fn parse(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "raw" | "statement" | "verbatim" => RuleScan::Raw,
            _ => RuleScan::Skeleton,
        }
    }
}

/// A rule file that parsed and validated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentRule {
    pub name: String,
    pub description: String,
    pub enabled: bool,
    pub event: RuleEvent,
    pub action: RuleAction,
    pub pattern: String,
    pub pattern_not: Option<String>,
    pub scan: RuleScan,
    pub origin: RuleOrigin,
}

/// A rule whose patterns compiled, ready to evaluate statements.
#[derive(Debug, Clone)]
pub struct CompiledRule {
    pub rule: AgentRule,
    pub(crate) matcher: Regex,
    pub(crate) exception: Option<Regex>,
}

/// One rule that fired against a statement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuleMatch {
    pub name: String,
    pub description: String,
    pub action: RuleAction,
    pub origin: RuleOrigin,
}

/// The single decision the engine hands back for one candidate statement.
///
/// `decision` is the string the TS gate switches on; the matched rules carry
/// the evidence the model and the human both get to see.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuleVerdict {
    pub decision: String,
    pub action: RuleAction,
    pub event: SqlEvent,
    pub message: String,
    pub matched_rules: Vec<RuleMatch>,
}

impl RuleVerdict {
    /// The verdict for a statement no rule objected to.
    pub fn allow(event: SqlEvent) -> Self {
        Self {
            decision: "allow".to_string(),
            action: RuleAction::Warn,
            event,
            message: String::new(),
            matched_rules: Vec::new(),
        }
    }

    /// The armed-rules inventory, for the rules manager.
    ///
    /// `decision` is deliberately `allow`: `matched_rules` here lists what *is
    /// armed*, not what objected, so folding it like an evaluation would make
    /// merely opening the manager read as "this statement was blocked".
    pub fn inventory(rules: Vec<RuleMatch>) -> Self {
        Self {
            decision: "allow".to_string(),
            action: RuleAction::Warn,
            event: SqlEvent::Unknown,
            message: String::new(),
            matched_rules: rules,
        }
    }

    /// Fold every fired rule into one decision using the strictest action.
    pub(crate) fn from_matches(event: SqlEvent, mut matched: Vec<RuleMatch>) -> Self {
        if matched.is_empty() {
            return Self::allow(event);
        }

        let action = matched
            .iter()
            .map(|m| m.action)
            .max()
            .unwrap_or(RuleAction::Warn);

        matched.sort_by(|a, b| a.name.cmp(&b.name));

        let message = matched
            .iter()
            .map(|m| format!("[{}] {}", m.name, m.description))
            .collect::<Vec<_>>()
            .join(" ");

        Self {
            decision: action.as_str().to_string(),
            action,
            event,
            message,
            matched_rules: matched,
        }
    }
}

/// A rule file that is present but could not be used, kept so callers can show
/// it instead of pretending the guardrail is armed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuleLoadError {
    pub path: String,
    pub reason: String,
}

/// What one load pass produced, healthy and broken alike.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleLoadReport {
    pub loaded: usize,
    /// Rules shadowed by an earlier root, or disabled by their own frontmatter.
    pub skipped: usize,
    pub errors: Vec<RuleLoadError>,
}
