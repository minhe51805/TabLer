//! Agent rule engine (P6.1).
//!
//! Deterministic, regex-based guardrails that run **before** an agent read or
//! write step touches the database. Rules are Markdown files with YAML-ish
//! frontmatter (same shape as `.claude/rules/*.md`), so the text a human
//! reviews in the repo is the text the runtime enforces:
//!
//! ```text
//! ---
//! name: no-delete-without-where
//! description: Blocks a DELETE that has no WHERE clause - it would empty the table.
//! enabled: true
//! event: pre_write
//! pattern: (?is)\bdelete\s+from\b
//! pattern-not: (?is)\bwhere\b
//! action: block
//! ---
//! ```
//!
//! Roots are consulted in order: `<workspace>/rules` (repo-local, user-owned)
//! then `<data_dir>/rules` (the seeded built-in pack). A rule that fails to
//! compile is **reported**, never silently skipped: an inert guardrail is worse
//! than no guardrail, because callers believe they are protected.
//!
//! This is deliberately *not* a SQL parser. It catches the mistakes that are
//! cheap to catch (missing `WHERE`, `DROP`/`TRUNCATE`, `SELECT *`, lock hints,
//! string-built dynamic SQL). Its verdict is a **floor**, not a proof: the
//! parameterized-execution path and the confirmation gate stay the second layer.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::utils::paths::resolve_data_dir;

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
        include_str!("../rules/no-delete-without-where.md"),
    ),
    (
        "no-update-without-where.md",
        include_str!("../rules/no-update-without-where.md"),
    ),
    (
        "no-drop-truncate-without-explicit-ask.md",
        include_str!("../rules/no-drop-truncate-without-explicit-ask.md"),
    ),
    (
        "no-select-star-on-large-table.md",
        include_str!("../rules/no-select-star-on-large-table.md"),
    ),
    (
        "require-parameterized-literals.md",
        include_str!("../rules/require-parameterized-literals.md"),
    ),
    (
        "require-transaction-for-multi-statement-write.md",
        include_str!("../rules/require-transaction-for-multi-statement-write.md"),
    ),
    (
        "no-cross-database-write.md",
        include_str!("../rules/no-cross-database-write.md"),
    ),
    (
        "no-lock-hints-on-write.md",
        include_str!("../rules/no-lock-hints-on-write.md"),
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
    matcher: Regex,
    exception: Option<Regex>,
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
    fn from_matches(event: SqlEvent, mut matched: Vec<RuleMatch>) -> Self {
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

/// Parse a `key: value` frontmatter block. Values may be quoted; a `#` starts a
/// comment only when it is the first non-space character, so a `pattern`
/// containing `#` (T-SQL temp tables) survives intact.
fn parse_frontmatter(contents: &str) -> Result<HashMap<String, String>, String> {
    let normalized = contents.replace("\r\n", "\n");
    let mut lines = normalized.lines();

    let first = lines.next().unwrap_or_default();
    if first.trim() != "---" {
        return Err("missing opening `---` frontmatter fence".to_string());
    }

    let mut fields: HashMap<String, String> = HashMap::new();
    let mut closed = false;

    for line in lines {
        if line.trim() == "---" {
            closed = true;
            break;
        }

        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        let Some((key, value)) = trimmed.split_once(':') else {
            continue;
        };

        let key = key.trim().to_ascii_lowercase();
        let value = value.trim().trim_matches('"').trim_matches('\'').trim();

        fields.insert(key, value.to_string());
    }

    if !closed {
        return Err("missing closing `---` frontmatter fence".to_string());
    }

    Ok(fields)
}

/// Build a rule from a Markdown file. `origin` records where it was read from;
/// `fallback_name` is used when the file omits `name:`.
pub fn parse_rule(
    fallback_name: &str,
    contents: &str,
    origin: RuleOrigin,
) -> Result<AgentRule, String> {
    let fields = parse_frontmatter(contents)?;

    let field = |key: &str| -> Option<String> {
        fields
            .get(key)
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };

    let name = field("name").unwrap_or_else(|| fallback_name.to_string());
    if name.is_empty() {
        return Err("rule has an empty name".to_string());
    }

    let description =
        field("description").ok_or_else(|| format!("rule `{name}` has no description"))?;

    let enabled = match field("enabled").as_deref() {
        None => true,
        Some(raw) => !matches!(
            raw.trim().to_ascii_lowercase().as_str(),
            "false" | "0" | "no" | "off"
        ),
    };

    let pattern = field("pattern").ok_or_else(|| format!("rule `{name}` has no pattern"))?;
    if pattern.len() > MAX_PATTERN_LEN {
        return Err(format!(
            "rule `{name}` pattern is longer than {MAX_PATTERN_LEN} bytes"
        ));
    }

    Ok(AgentRule {
        name,
        description,
        enabled,
        event: RuleEvent::parse(field("event").as_deref().unwrap_or("pre_write")),
        action: RuleAction::parse(field("action").as_deref().unwrap_or("warn")),
        pattern,
        pattern_not: field("pattern-not"),
        scan: RuleScan::parse(field("scan").as_deref().unwrap_or("skeleton")),
        origin,
    })
}

/// Compile one rule. A rule whose regex does not compile is an **error**, never
/// a skip: an inert guardrail is worse than no guardrail, because callers
/// believe they are protected.
pub fn compile_rule(rule: AgentRule) -> Result<CompiledRule, String> {
    let matcher = Regex::new(&rule.pattern)
        .map_err(|e| format!("rule `{}` has an invalid pattern: {e}", rule.name))?;

    let exception = match rule.pattern_not.as_deref() {
        None => None,
        Some(source) => Some(
            Regex::new(source)
                .map_err(|e| format!("rule `{}` has an invalid pattern-not: {e}", rule.name))?,
        ),
    };

    Ok(CompiledRule {
        rule,
        matcher,
        exception,
    })
}

/// Replace comments and string literals with spaces, so a keyword inside a
/// literal or a comment cannot masquerade as the statement's verb.
fn skeleton(statement: &str) -> String {
    let chars: Vec<char> = statement.chars().collect();
    let mut out = String::with_capacity(statement.len());
    let mut quote: Option<char> = None;
    let mut i = 0usize;

    while i < chars.len() {
        let ch = chars[i];

        if let Some(delimiter) = quote {
            if ch == delimiter {
                // `` or '' is an escaped quote inside the literal.
                if i + 1 < chars.len() && chars[i + 1] == delimiter {
                    i += 2;
                    continue;
                }
                quote = None;
            }
            out.push(' ');
            i += 1;
            continue;
        }

        if ch == '\'' || ch == '"' || ch == '`' || ch == '[' {
            // `[...]` is a T-SQL identifier, not a literal: keep its name so a
            // statement starting with a quoted identifier still classifies.
            if ch == '[' {
                out.push(ch);
                i += 1;
                continue;
            }
            quote = Some(ch);
            out.push(' ');
            i += 1;
            continue;
        }

        if ch == '-' && i + 1 < chars.len() && chars[i + 1] == '-' {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            out.push('\n');
            continue;
        }

        if ch == '/' && i + 1 < chars.len() && chars[i + 1] == '*' {
            i += 2;
            while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                i += 1;
            }
            i = (i + 2).min(chars.len());
            out.push(' ');
            continue;
        }

        out.push(ch);
        i += 1;
    }

    out
}
/// Leading keyword of a statement, lowercased, with any PostgreSQL/SQL Server
/// noise (`EXPLAIN ANALYZE`, `WITH RECURSIVE`, `SET NOCOUNT ON`) skipped so the
/// verb is the thing that decides the class.
fn leading_keyword(statement: &str) -> String {
    const SKIP: &[&str] = &[
        "recursive",
        "analyze",
        "analyse",
        "verbose",
        "nocount",
        "on",
        "off",
        "only",
    ];

    let words = statement
        .split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .filter(|w| !w.is_empty());

    for word in words {
        let lower = word.to_ascii_lowercase();
        if SKIP.contains(&lower.as_str()) {
            continue;
        }
        return lower;
    }

    String::new()
}

/// Keywords that always mean the statement mutates data, schema, or server
/// state. Shared by the leading-keyword match and the EXPLAIN ANALYZE
/// re-classification so both agree on what counts as a write.
fn is_write_keyword(keyword: &str) -> bool {
    matches!(
        keyword,
        "insert"
            | "update"
            | "delete"
            | "truncate"
            | "drop"
            | "alter"
            | "create"
            | "replace"
            | "merge"
            | "grant"
            | "revoke"
            | "comment"
            | "exec"
            | "execute"
            | "call"
            | "vacuum"
            | "reindex"
            | "refresh"
            | "rename"
            | "upsert"
            | "begin"
            | "commit"
            | "rollback"
            | "savepoint"
            | "set"
            | "use"
            | "copy"
            | "load"
            | "import"
            | "analyze"
            | "lock"
            | "unlock"
            | "do"
            | "attach"
            | "detach"
            | "pragma"
    )
}

/// Split a script into individual statements, then classify the whole script.
///
/// The input is reduced to a skeleton first, so a `;` or a `DELETE` inside a
/// string literal cannot split a statement or change its class. Any statement
/// that mutates anything makes the whole script a `Write`: a script is only as
/// safe as its most dangerous statement.
pub fn classify_sql_event(statement: &str) -> SqlEvent {
    let body = skeleton(statement);
    let mut saw_read = false;
    let mut saw_unknown = false;

    for piece in body.split(';') {
        if piece.trim().is_empty() {
            continue;
        }

        let keyword = leading_keyword(piece);
        match keyword.as_str() {
            "explain" => {
                // EXPLAIN ANALYZE executes the wrapped statement; a plain
                // EXPLAIN only plans it. Re-classify the wrapped verb.
                let tokens: Vec<String> = piece
                    .split(|c: char| !(c.is_alphanumeric() || c == '_'))
                    .filter(|w| !w.is_empty())
                    .map(|w| w.to_ascii_lowercase())
                    .collect();
                let analyzes = tokens.iter().any(|t| t == "analyze" || t == "analyse");
                if analyzes {
                    match tokens
                        .iter()
                        .find(|t| {
                            !matches!(
                                t.as_str(),
                                "explain"
                                    | "analyze"
                                    | "analyse"
                                    | "verbose"
                                    | "format"
                                    | "buffers"
                                    | "wal"
                                    | "timing"
                                    | "summary"
                                    | "memory"
                                    | "serialize"
                                    | "settings"
                                    | "generic_plan"
                                    | "true"
                                    | "false"
                                    | "on"
                                    | "off"
                                    | "text"
                                    | "xml"
                                    | "json"
                                    | "yaml"
                            )
                        })
                        .map(String::as_str)
                    {
                        Some(inner) if is_write_keyword(inner) => return SqlEvent::Write,
                        _ => saw_read = true,
                    }
                } else {
                    saw_read = true;
                }
            }
            "select" | "with" | "values" => {
                // SELECT ... INTO creates a table; WITH bodies can carry DML.
                let mutating = piece
                    .split(|c: char| !(c.is_alphanumeric() || c == '_'))
                    .filter(|w| !w.is_empty())
                    .map(|w| w.to_ascii_lowercase())
                    .any(|w| {
                        matches!(
                            w.as_str(),
                            "into" | "insert" | "update" | "delete" | "merge" | "replace"
                        )
                    });
                if mutating {
                    return SqlEvent::Write;
                }
                saw_read = true;
            }
            "show" | "describe" | "declare" => {
                saw_read = true;
            }
            _ if is_write_keyword(&keyword) => {
                return SqlEvent::Write;
            }
            "" => {}
            _ => saw_unknown = true,
        }
    }

    if saw_unknown && !saw_read {
        SqlEvent::Unknown
    } else if saw_read {
        SqlEvent::Read
    } else {
        SqlEvent::Unknown
    }
}

/// Evaluate a statement against every enabled rule that guards its class.
///
/// Matching runs on the **skeleton**, so a keyword living inside a string
/// literal or a comment cannot be mistaken for the statement's verb - that is
/// what keeps `select * from t where note = 'delete from'` from being blocked.
pub fn evaluate_rules_for_event(
    rules: &[CompiledRule],
    statement: &str,
    event: SqlEvent,
) -> RuleVerdict {
    if statement.len() > MAX_STATEMENT_LEN {
        let shortfall = statement.len() - MAX_STATEMENT_LEN;
        let mut verdict = RuleVerdict::from_matches(
            event,
            vec![RuleMatch {
                name: "statement-too-large".to_string(),
                description: format!(
                    "statement is {shortfall} bytes past the {MAX_STATEMENT_LEN}-byte guardrail limit; refusing to judge it"
                ),
                action: RuleAction::Block,
                origin: RuleOrigin::Builtin,
            }],
        );
        verdict.event = event;
        return verdict;
    }

    let requested = event.guardrail_event();

    // The skeleton is the safe default, but a rule that deliberately inspects
    // literal text (`'..' + @id` concatenation) must see the statement as it was
    // written - the skeleton would erase the very characters it looks for.
    let mut skeleton_body: Option<String> = None;
    let mut raw_body: Option<String> = None;

    let mut matched: Vec<RuleMatch> = Vec::new();

    for candidate in rules {
        if !candidate.rule.enabled || !candidate.rule.event.covers(requested) {
            continue;
        }

        let body: &str = match candidate.rule.scan {
            RuleScan::Skeleton => skeleton_body.get_or_insert_with(|| skeleton(statement)),
            RuleScan::Raw => raw_body.get_or_insert_with(|| statement.to_string()),
        };

        if !candidate.matcher.is_match(body) {
            continue;
        }

        // `pattern-not` is an escape hatch: `DELETE ... WHERE` satisfies both
        // patterns, and the exception is what makes it allowed.
        if let Some(exception) = &candidate.exception {
            if exception.is_match(body) {
                continue;
            }
        }

        matched.push(RuleMatch {
            name: candidate.rule.name.clone(),
            description: candidate.rule.description.clone(),
            action: candidate.rule.action,
            origin: candidate.rule.origin,
        });
    }

    RuleVerdict::from_matches(event, matched)
}

/// Classify the statement, then evaluate it. The convenience entry point every
/// caller should use: it cannot forget to derive the event.
pub fn evaluate_rules(rules: &[CompiledRule], statement: &str) -> RuleVerdict {
    let event = classify_sql_event(statement);
    evaluate_rules_for_event(rules, statement, event)
}

// ---------------------------------------------------------------------------
// Roots and discovery
// ---------------------------------------------------------------------------

/// The `rules` roots, in precedence order: the per-workspace directory first so
/// a project can override a built-in rule, then the user-level directory.
pub fn rule_roots(workspace_dir: Option<&Path>, data_dir: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();

    if let Some(workspace) = workspace_dir {
        roots.push(workspace.join(RULES_DIR_NAME));
    }

    roots.push(data_dir.join(RULES_DIR_NAME));
    roots
}

/// Discover and compile every rule under `roots`.
///
/// Nothing here is fatal: a missing directory is normal on a fresh install, and
/// a broken rule is reported instead of aborting, because one bad user rule must
/// not disable the entire guardrail pack - but it must never be silent either.
pub fn load_rules_from_roots(roots: &[PathBuf]) -> (Vec<CompiledRule>, RuleLoadReport) {
    let mut compiled: Vec<CompiledRule> = Vec::new();
    let mut report = RuleLoadReport::default();
    let mut seen: HashSet<String> = HashSet::new();
    // `rule_roots` puts the data dir last: everything before it is workspace-owned,
    // so a repo rule shadows the seeded pack instead of doubling it.
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

            if compiled.len() >= MAX_RULES_PER_ROOT {
                report.errors.push(RuleLoadError {
                    path: path.display().to_string(),
                    reason: format!(
                        "more than {MAX_RULES_PER_ROOT} rules in one root; ignoring the rest"
                    ),
                });
                break;
            }

            let contents = match std::fs::read_to_string(&path) {
                Ok(contents) => contents,
                Err(error) => {
                    report.errors.push(RuleLoadError {
                        path: path.display().to_string(),
                        reason: format!("cannot read rule: {error}"),
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
                // an untouched built-in; an edited copy is the user's own rule.
                let file_name = path
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_default();
                if BUILTIN_RULES
                    .iter()
                    .any(|(name, body)| *name == file_name && *body == contents)
                {
                    RuleOrigin::Builtin
                } else {
                    RuleOrigin::Global
                }
            } else {
                RuleOrigin::Workspace
            };

            match parse_rule(&fallback, &contents, origin).and_then(compile_rule) {
                Ok(rule) => {
                    // First root wins, so a workspace rule shadows the user rule
                    // of the same name instead of both firing.
                    if !seen.insert(rule.rule.name.clone()) {
                        report.skipped += 1;
                        continue;
                    }
                    report.loaded += 1;
                    compiled.push(rule);
                }
                Err(reason) => report.errors.push(RuleLoadError {
                    path: path.display().to_string(),
                    reason,
                }),
            }
        }
    }

    compiled.sort_by(|a, b| a.rule.name.cmp(&b.rule.name));
    (compiled, report)
}

/// Load the rules that apply to this workspace.
pub fn load_rules(
    workspace_dir: Option<&Path>,
    data_dir: &Path,
) -> (Vec<CompiledRule>, RuleLoadReport) {
    load_rules_from_roots(&rule_roots(workspace_dir, data_dir))
}

/// What one seed pass did to one file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeededRuleStatus {
    pub name: String,
    /// `installed` | `refreshed` | `unchanged` | `userModified`.
    pub state: String,
}

/// Aggregate result of a seed pass, shaped like the skills `SeedReport` so the
/// manager UI can treat both packs the same way.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleSeedReport {
    pub installed: usize,
    pub refreshed: usize,
    pub unchanged: usize,
    pub user_modified: usize,
    pub rules: Vec<SeededRuleStatus>,
}

/// A verdict plus the health of the pack that produced it. Callers must know when
/// a rule failed to compile, otherwise "no match" is indistinguishable from "the
/// guardrail never loaded" - the exact silent failure this module exists to stop.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleEvaluation {
    pub verdict: RuleVerdict,
    pub report: RuleLoadReport,
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

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------
//
// The built-in guardrail pack is embedded in the binary and installed into
// `<data_dir>/rules` on first run. The same contract as the skill seeder:
// never clobber a rule the user edited, refresh an untouched built-in after an
// upgrade, and heal a missing file (which holds no user intent).

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct RuleManifestEntry {
    /// sha256 of the content we last wrote for this rule.
    hash: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct RuleManifest {
    /// File name -> what we last installed for it.
    #[serde(default)]
    rules: std::collections::BTreeMap<String, RuleManifestEntry>,
}

fn load_rule_manifest(rules_root: &Path) -> RuleManifest {
    let path = rules_root.join(SEED_MANIFEST_NAME);
    // A corrupt or hand-edited manifest must never break startup: treating it as
    // empty makes every existing file look user-modified, so nothing is
    // overwritten until the user asks for a reset.
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<RuleManifest>(&raw).ok())
        .unwrap_or_default()
}

fn save_rule_manifest(rules_root: &Path, manifest: &RuleManifest) -> Result<(), String> {
    let path = rules_root.join(SEED_MANIFEST_NAME);
    let raw = serde_json::to_string_pretty(manifest).map_err(|error| error.to_string())?;
    std::fs::write(&path, raw).map_err(|error| error.to_string())
}

/// True when the installed rule still matches what we last wrote.
///
/// Asymmetric on purpose: a **changed** file holds user intent (stop), a
/// **missing** file holds nothing (restore).
fn is_rule_untouched(installed: &Path, record: Option<&RuleManifestEntry>) -> bool {
    let Some(record) = record else {
        return false;
    };
    match std::fs::read(installed) {
        Ok(bytes) => hex_sha256(&bytes) == record.hash,
        Err(_) => true,
    }
}

/// Write one built-in rule. Returns its status row plus the record to store;
/// `None` means "keep the existing record" because the file is user-owned.
fn seed_rule_one(
    rules_root: &Path,
    file_name: &str,
    content: &str,
    record: Option<&RuleManifestEntry>,
    force: bool,
) -> Result<(SeededRuleStatus, Option<RuleManifestEntry>), String> {
    let installed = rules_root.join(file_name);
    let existed = installed.exists();

    if existed && !force && !is_rule_untouched(&installed, record) {
        return Ok((
            SeededRuleStatus {
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
        SeededRuleStatus {
            name: file_name.to_string(),
            state: state.to_string(),
        },
        Some(RuleManifestEntry { hash: wanted }),
    ))
}

/// Seed the whole pack into an explicit root - split out so tests drive a temp
/// directory instead of the real data dir.
fn seed_rules_into_root(rules_root: &Path, force: bool) -> Result<RuleSeedReport, String> {
    std::fs::create_dir_all(rules_root).map_err(|error| error.to_string())?;
    let mut manifest = load_rule_manifest(rules_root);
    let mut report = RuleSeedReport::default();

    for (file_name, content) in BUILTIN_RULES {
        let record = manifest.rules.get(*file_name);
        let (status, new_record) = seed_rule_one(rules_root, file_name, content, record, force)?;
        match status.state.as_str() {
            "installed" => report.installed += 1,
            "refreshed" => report.refreshed += 1,
            "userModified" => report.user_modified += 1,
            _ => report.unchanged += 1,
        }
        if let Some(entry) = new_record {
            manifest.rules.insert((*file_name).to_string(), entry);
        }
        report.rules.push(status);
    }

    save_rule_manifest(rules_root, &manifest)?;
    Ok(report)
}

/// Absolute path of the global rules root (mirrors `rule_roots` so the seeder
/// and the loader can never disagree about where rules live).
fn global_rules_root() -> Result<PathBuf, String> {
    let data_dir = resolve_data_dir().map_err(|error| error.to_string())?;
    Ok(data_dir.join(RULES_DIR_NAME))
}

/// Upper bound on a name the app is willing to turn into a rule file stem.
pub const MAX_RULE_NAME_CHARS: usize = 64;
/// Upper bound on a rule description written by the app.
pub const MAX_RULE_DESCRIPTION_CHARS: usize = 400;

/// A rule the app is about to write to `<data_dir>/rules`.
///
/// Every field is validated and round-tripped through the loader before the
/// file lands: a guardrail the engine cannot compile is worse than no guardrail,
/// because the caller believes it is protected.
#[derive(Debug, Clone)]
pub struct NewRuleSpec {
    pub name: String,
    pub description: String,
    pub enabled: bool,
    pub event: RuleEvent,
    pub action: RuleAction,
    pub pattern: String,
    pub pattern_not: Option<String>,
    pub scan: RuleScan,
}

/// The frontmatter spelling of an event (inverse of `RuleEvent::parse`).
fn rule_event_field(event: RuleEvent) -> &'static str {
    match event {
        RuleEvent::PreRead => "pre_read",
        RuleEvent::PreWrite => "pre_write",
        RuleEvent::Any => "any",
    }
}

/// The frontmatter spelling of a scan mode (inverse of `RuleScan::parse`).
fn rule_scan_field(scan: RuleScan) -> &'static str {
    match scan {
        RuleScan::Skeleton => "skeleton",
        RuleScan::Raw => "raw",
    }
}

/// A rule name doubles as the file stem, so it must be a slug: anything else
/// could escape the rules directory or vanish from diagnostics.
pub fn validate_rule_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Rule name must not be empty.".to_string());
    }
    if trimmed.chars().count() > MAX_RULE_NAME_CHARS {
        return Err(format!(
            "Rule name must be at most {MAX_RULE_NAME_CHARS} characters."
        ));
    }
    let is_slug = trimmed
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_');
    if !is_slug {
        return Err(
            "Rule name may only contain lowercase letters, digits, '-' and '_' (it becomes the rule's file name)."
                .to_string(),
        );
    }
    Ok(trimmed.to_string())
}

/// Render a `NewRuleSpec` as the Markdown file the loader reads.
///
/// Values are written unquoted and flattened to one line on purpose: the
/// frontmatter reader is line-based and trims wrapping quotes, so a value with a
/// newline (or one wrapped in quotes) would come back changed. The caller
/// verifies the round-trip instead of trusting this shape.
fn render_rule_contents(spec: &NewRuleSpec) -> Result<String, String> {
    let name = validate_rule_name(&spec.name)?;
    let flatten = |label: &str, value: &str| -> Result<String, String> {
        let flat = value.replace(['\r', '\n'], " ").trim().to_string();
        if flat.is_empty() {
            return Err(format!("Rule {label} must not be empty."));
        }
        Ok(flat)
    };
    let pattern = flatten("pattern", &spec.pattern)?;
    let description: String = flatten("description", &spec.description)?
        .chars()
        .take(MAX_RULE_DESCRIPTION_CHARS)
        .collect();

    let mut contents = String::from("---\n");
    contents.push_str(&format!("name: {name}\n"));
    contents.push_str(&format!("description: {description}\n"));
    contents.push_str(&format!("enabled: {}\n", spec.enabled));
    contents.push_str(&format!("event: {}\n", rule_event_field(spec.event)));
    contents.push_str(&format!("pattern: {pattern}\n"));
    if let Some(exception) = spec.pattern_not.as_deref() {
        contents.push_str(&format!(
            "pattern-not: {}\n",
            flatten("pattern-not", exception)?
        ));
    }
    contents.push_str(&format!("action: {}\n", spec.action.as_str()));
    contents.push_str(&format!("scan: {}\n", rule_scan_field(spec.scan)));
    contents.push_str("---\n\n");
    contents.push_str(&format!("# {name}\n\n{description}\n"));
    Ok(contents)
}

/// Write one rule into `root`, refusing to clobber an existing file.
///
/// Two safety properties, both enforced before the write: the name never reaches
/// the filesystem unchecked, and the rendered text must parse *and compile* back
/// into the rule that was asked for.
pub fn save_rule_into_root(root: &Path, spec: &NewRuleSpec) -> Result<PathBuf, String> {
    let name = validate_rule_name(&spec.name)?;
    let contents = render_rule_contents(spec)?;

    let parsed = parse_rule(&name, &contents, RuleOrigin::Global)?;
    compile_rule(parsed.clone())
        .map_err(|error| format!("Refusing to write a rule that cannot compile: {error}"))?;
    if parsed.pattern != spec.pattern.trim() {
        return Err(
            "Refusing to write a rule whose pattern does not survive the frontmatter round-trip."
                .to_string(),
        );
    }
    if parsed.action != spec.action || parsed.event != spec.event || parsed.scan != spec.scan {
        return Err(
            "Refusing to write a rule whose action, event or scan does not survive the frontmatter round-trip."
                .to_string(),
        );
    }

    std::fs::create_dir_all(root).map_err(|error| error.to_string())?;
    let path = root.join(format!("{name}.md"));
    if path.exists() {
        return Err(format!(
            "A rule named '{name}' already exists. Edit that file instead of overwriting it from a suggestion."
        ));
    }
    std::fs::write(&path, contents).map_err(|error| error.to_string())?;
    Ok(path)
}

/// Save a guardrail rule the user approved (P9 learning loop).
///
/// Rules are matched on reads too (`pre_read`): the findings this loop learns
/// from are read-time observations, so a rule about a dead column has to fire on
/// the SELECT that filters it, not only on a write.
#[tauri::command]
pub fn save_agent_rule(
    name: String,
    description: String,
    event: Option<String>,
    action: Option<String>,
    pattern: String,
    pattern_not: Option<String>,
    scan: Option<String>,
) -> Result<String, String> {
    let spec = NewRuleSpec {
        name,
        description,
        enabled: true,
        // Tolerant parsing, the same contract the loader uses: an unknown value
        // lands on the weakest setting that still surfaces the problem rather
        // than on silence.
        event: RuleEvent::parse(event.as_deref().unwrap_or("any")),
        action: RuleAction::parse(action.as_deref().unwrap_or("warn")),
        pattern,
        pattern_not: pattern_not
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        scan: RuleScan::parse(scan.as_deref().unwrap_or("skeleton")),
    };
    let root = global_rules_root()?;
    let path = save_rule_into_root(&root, &spec)?;
    Ok(path.to_string_lossy().to_string())
}

/// Install/refresh the built-in guardrail pack. Safe on every startup: once
/// installed it is a handful of `stat` calls.
pub fn seed_builtin_rules(force: bool) -> Result<RuleSeedReport, String> {
    seed_rules_into_root(&global_rules_root()?, force)
}

/// Names of the shipped guardrail pack, for the manager UI and tests.
/// Names of the shipped guardrail pack, in seed order.
#[allow(dead_code)] // seeded on disk by `seed_ai_builtin_rules`; read by the manifest parity test
pub fn builtin_rule_manifest() -> Vec<String> {
    BUILTIN_RULES
        .iter()
        .map(|(file_name, _)| (*file_name).to_string())
        .collect()
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Idempotent seed, exposed so the rules manager can re-run it on demand.
#[tauri::command]
pub fn seed_ai_builtin_rules(force: Option<bool>) -> Result<RuleSeedReport, String> {
    seed_rules_into_root(&global_rules_root()?, force.unwrap_or(false))
}

/// Force-restore every built-in rule, discarding user edits to them. This is
/// the only path that overwrites a modified rule and is always user-initiated.
#[tauri::command]
pub fn reset_ai_builtin_rules() -> Result<RuleSeedReport, String> {
    seed_rules_into_root(&global_rules_root()?, true)
}

/// Evaluate one candidate statement against the armed guardrail pack.
///
/// `workspace_dir` scopes the per-project rules; `event` forces a guardrail
/// phase (`pre_read` / `pre_write`) instead of deriving it from the statement,
/// which is what the agent's plan gate needs.
#[tauri::command]
pub fn evaluate_agent_rules(
    workspace_dir: Option<String>,
    statement: String,
    event: Option<String>,
) -> Result<RuleEvaluation, String> {
    let data_dir = resolve_data_dir().map_err(|error| error.to_string())?;
    let workspace = workspace_dir.map(PathBuf::from);
    let (rules, report) = load_rules(workspace.as_deref(), &data_dir);

    let verdict = match event.as_deref() {
        Some(raw) => {
            let requested = RuleEvent::parse(raw);
            let sql_event = match requested {
                RuleEvent::PreWrite => classify_sql_event_for_write(&statement),
                _ => classify_sql_event(&statement),
            };
            evaluate_rules_for_event(&rules, &statement, sql_event)
        }
        None => evaluate_rules(&rules, &statement),
    };

    Ok(RuleEvaluation { verdict, report })
}

/// A statement handed to the plan gate must be treated as a write, otherwise a
/// bare `UPDATE` would be classified `Unknown` and half the pack would skip it.
fn classify_sql_event_for_write(statement: &str) -> SqlEvent {
    match classify_sql_event(statement) {
        SqlEvent::Unknown => SqlEvent::Write,
        event => event,
    }
}

/// Everything the rules manager needs: what is armed, and what failed to load.
#[tauri::command]
pub fn list_agent_rules(workspace_dir: Option<String>) -> Result<RuleEvaluation, String> {
    let data_dir = resolve_data_dir().map_err(|error| error.to_string())?;
    let workspace = workspace_dir.map(PathBuf::from);
    let (rules, report) = load_rules(workspace.as_deref(), &data_dir);

    let mut matched: Vec<RuleMatch> = rules
        .iter()
        .map(|candidate| RuleMatch {
            name: candidate.rule.name.clone(),
            description: candidate.rule.description.clone(),
            action: candidate.rule.action,
            origin: candidate.rule.origin,
        })
        .collect();
    matched.sort_by(|a, b| a.name.cmp(&b.name));

    Ok(RuleEvaluation {
        verdict: RuleVerdict::inventory(matched),
        report,
    })
}

/// Write a user-authored rule file into `<workspace_dir>/rules` — split from
/// the command so tests drive a temp directory instead of a real workspace.
fn write_workspace_rule_into(
    workspace_dir: &Path,
    name: &str,
    content: &str,
) -> Result<PathBuf, String> {
    let name = validate_rule_name(name)?;
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Err("Rule content must not be empty.".to_string());
    }

    // The file must be a rule the engine can actually arm: parse it back and
    // compile its patterns before anything touches the filesystem.
    let parsed = parse_rule(&name, trimmed, RuleOrigin::Workspace)
        .map_err(|error| format!("Refusing to write a rule that does not parse: {error}"))?;
    compile_rule(parsed.clone())
        .map_err(|error| format!("Refusing to write a rule that cannot compile: {error}"))?;
    // A frontmatter `name:` that disagrees with the file stem would shadow a
    // different rule in diagnostics — refuse instead of writing a confusing file.
    if parsed.name != name {
        return Err(format!(
            "The frontmatter name '{}' does not match the file name '{name}'.",
            parsed.name
        ));
    }

    let root = workspace_dir.join(RULES_DIR_NAME);
    std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let path = root.join(format!("{name}.md"));
    if path.exists() {
        return Err(format!(
            "A rule named '{name}' already exists in this workspace. Edit that file instead of overwriting it."
        ));
    }
    std::fs::write(&path, format!("{trimmed}\n")).map_err(|error| error.to_string())?;
    Ok(path)
}

/// Write a user-authored rule file into `<workspace_dir>/rules`.
///
/// Unlike `save_agent_rule` (which renders a `NewRuleSpec` into the global
/// pack), this command takes the raw Markdown the user typed and drops it into
/// the *workspace* root — the same directory `evaluate_agent_rules` scans first
/// for the linked folder. The content is still parsed and compiled before the
/// write: a guardrail the engine cannot load is worse than no guardrail,
/// because the caller believes it is protected.
#[tauri::command]
pub fn write_workspace_rule(
    workspace_dir: String,
    name: String,
    content: String,
) -> Result<String, String> {
    let path = write_workspace_rule_into(Path::new(&workspace_dir), &name, &content)?;
    Ok(path.to_string_lossy().to_string())
}
#[cfg(test)]
mod tests {
    use super::*;

    /// Ephemeral rules root; the seeder is never pointed at the real data dir in
    /// tests so a test run cannot disturb the developer's own guardrails.
    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new(label: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "tabler-rule-seed-{}-{}-{}",
                label,
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            ));
            std::fs::create_dir_all(&dir).expect("temp root");
            TempRoot(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// The embedded pack, compiled exactly the way the loader compiles it - no
    /// filesystem involved, so a pattern regression fails here and not in prod.
    fn builtin_rules() -> Vec<CompiledRule> {
        BUILTIN_RULES
            .iter()
            .map(|(file_name, contents)| {
                let rule = parse_rule(file_name, contents, RuleOrigin::Builtin)
                    .unwrap_or_else(|error| panic!("{file_name}: {error}"));
                compile_rule(rule).unwrap_or_else(|error| panic!("{file_name}: {error}"))
            })
            .collect()
    }

    fn fired(verdict: &RuleVerdict) -> Vec<String> {
        verdict
            .matched_rules
            .iter()
            .map(|matched| matched.name.clone())
            .collect()
    }

    fn write_rule(root: &Path, file_name: &str, body: &str) {
        std::fs::create_dir_all(root).expect("rules root");
        std::fs::write(root.join(file_name), body).expect("rule file");
    }

    /// A minimal valid rule body, so shadowing/disabled/error tests stay readable.
    fn rule_body(name: &str, pattern: &str, action: &str, extra: &str) -> String {
        format!(
            "---\nname: {name}\ndescription: test rule {name}\nevent: pre_write\npattern: {pattern}\n{extra}action: {action}\n---\n"
        )
    }

    #[test]
    fn every_builtin_rule_parses_and_compiles() {
        let rules = builtin_rules();
        assert_eq!(
            rules.len(),
            BUILTIN_RULES.len(),
            "every embedded rule must survive parse + compile"
        );
        assert_eq!(builtin_rule_manifest().len(), BUILTIN_RULES.len());
        for rule in &rules {
            assert!(
                !rule.rule.name.is_empty(),
                "built-in rule must declare its own name"
            );
            assert!(
                !rule.rule.description.is_empty(),
                "{}: description is what the agent shows the user",
                rule.rule.name
            );
        }
    }

    /// The regression that matters most: an inert guardrail is worse than no
    /// guardrail, so every shipped rule is proven to fire on the statement it
    /// exists to catch. A typo in a pattern (the `(?i)`-mid-pattern bug class)
    /// fails here instead of silently disarming the pack.
    #[test]
    fn every_builtin_rule_fires_on_the_statement_it_must_catch() {
        let rules = builtin_rules();
        let cases: &[(&str, &str)] = &[
            ("no-delete-without-where", "DELETE FROM users"),
            ("no-update-without-where", "UPDATE users SET name = 'x'"),
            ("no-drop-truncate-without-explicit-ask", "DROP TABLE users"),
            (
                "no-drop-truncate-without-explicit-ask",
                "TRUNCATE TABLE users",
            ),
            ("no-select-star-on-large-table", "SELECT * FROM users"),
            (
                "require-parameterized-literals",
                "EXEC('select id from t where id = ' + @id)",
            ),
            (
                "require-transaction-for-multi-statement-write",
                "UPDATE a SET x = 1; DELETE FROM b",
            ),
            (
                "no-cross-database-write",
                "UPDATE sales.dbo.orders SET total = 1",
            ),
            (
                "no-lock-hints-on-write",
                "UPDATE users SET name = 1 WITH (UPDLOCK)",
            ),
        ];

        for (expected, statement) in cases {
            let verdict = evaluate_rules(&rules, statement);
            assert!(
                fired(&verdict).iter().any(|name| name == expected),
                "`{statement}` must fire {expected}; fired={:?}",
                fired(&verdict)
            );
        }
    }

    #[test]
    fn delete_and_update_with_a_where_clause_are_allowed() {
        let rules = builtin_rules();

        for statement in [
            "DELETE FROM users WHERE id = 1",
            "UPDATE users SET name = 'x' WHERE id = 1",
        ] {
            let verdict = evaluate_rules(&rules, statement);
            assert!(
                fired(&verdict).is_empty(),
                "`{statement}` must be allowed; fired={:?}",
                fired(&verdict)
            );
            assert_eq!(verdict.decision, "allow");
        }
    }

    /// `pattern-not` is the escape hatch, and the skeleton is what keeps a
    /// keyword inside a comment from disarming it: a commented-out `WHERE` must
    /// not talk the guardrail out of blocking an unfiltered `DELETE`.
    #[test]
    fn a_commented_out_where_cannot_satisfy_the_guardrail() {
        let rules = builtin_rules();
        let verdict = evaluate_rules(&rules, "DELETE FROM users -- WHERE id = 1");
        assert_eq!(verdict.decision, "block", "fired={:?}", fired(&verdict));
    }

    #[test]
    fn skeleton_erases_a_destructive_keyword_hidden_in_a_literal_or_comment() {
        let rules = builtin_rules();

        for statement in [
            "UPDATE users SET note = 'DROP TABLE users' WHERE id = 1",
            "UPDATE users SET note = 'TRUNCATE TABLE users' WHERE id = 1",
            "UPDATE users SET note = 1 WHERE id = 1 -- DROP TABLE users",
            "UPDATE users SET note = 1 /* DROP TABLE users */ WHERE id = 1",
        ] {
            let verdict = evaluate_rules(&rules, statement);
            let names = fired(&verdict);
            assert!(
                !names
                    .iter()
                    .any(|name| name == "no-drop-truncate-without-explicit-ask"),
                "`{statement}` must not fire the DDL guardrail; fired={names:?}"
            );
        }
    }

    /// A rule that deliberately inspects literal text (`scan: raw`) must still
    /// see the string it looks for, otherwise the parameterization guardrail
    /// would be inert by construction.
    #[test]
    fn raw_scan_rules_see_string_literals() {
        let rules = builtin_rules();
        let verdict = evaluate_rules(&rules, "EXEC('select id from t where id = ' + @id)");
        assert!(
            fired(&verdict)
                .iter()
                .any(|name| name == "require-parameterized-literals"),
            "raw-scan rule must observe the concatenation; fired={:?}",
            fired(&verdict)
        );
    }

    #[test]
    fn classify_sql_event_separates_reads_writes_and_unknown() {
        for statement in [
            "SELECT id FROM users",
            "SHOW TABLES",
            "EXPLAIN ANALYZE SELECT 1",
            "WITH cte AS (SELECT 1) SELECT * FROM cte",
        ] {
            assert_eq!(
                classify_sql_event(statement),
                SqlEvent::Read,
                "`{statement}` should classify as a read"
            );
        }

        for statement in [
            "DELETE FROM users",
            "UPDATE users SET a = 1",
            "DROP TABLE users",
            "GRANT SELECT TO someone",
            "BEGIN TRAN",
        ] {
            assert_eq!(
                classify_sql_event(statement),
                SqlEvent::Write,
                "`{statement}` should classify as a write"
            );
        }

        for statement in ["", "   ", ";;"] {
            assert_eq!(
                classify_sql_event(statement),
                SqlEvent::Unknown,
                "`{statement}` should classify as unknown"
            );
        }
    }

    /// A script is only as safe as its most dangerous statement, and a `;` inside
    /// a literal must not split one statement into two.
    #[test]
    fn a_read_prefixed_script_that_writes_is_a_write() {
        assert_eq!(
            classify_sql_event("SELECT 1; DELETE FROM users"),
            SqlEvent::Write
        );
        assert_eq!(
            classify_sql_event("SELECT 'a;b' FROM users"),
            SqlEvent::Read,
            "a `;` inside a literal must not split the statement"
        );
    }

    /// Unknown statements are treated as writes, so nothing with write-sized
    /// blast radius slips past the write pack.
    #[test]
    fn an_unknown_statement_is_guarded_as_a_write() {
        assert_eq!(SqlEvent::Unknown.guardrail_event(), RuleEvent::PreWrite);
        assert_eq!(SqlEvent::Read.guardrail_event(), RuleEvent::PreRead);
    }

    /// Several rules may fire at once; the verdict must be the strictest action,
    /// never the first or the last one seen.
    #[test]
    fn a_verdict_folds_every_match_into_the_strictest_action() {
        let rules = builtin_rules();
        let verdict = evaluate_rules(&rules, "DELETE FROM a; DELETE FROM b");

        let names = fired(&verdict);
        assert!(
            names.iter().any(|name| name == "no-delete-without-where")
                && names
                    .iter()
                    .any(|name| name == "require-transaction-for-multi-statement-write"),
            "both the block and the warn rule should fire; fired={names:?}"
        );
        assert_eq!(verdict.decision, "block");
        assert_eq!(verdict.action, RuleAction::Block);
        assert!(!verdict.message.is_empty(), "the user must get a reason");
    }

    /// The guardrail refuses to judge an oversized statement instead of getting
    /// slow or blowing the stack: refusing is the fail-closed answer.
    #[test]
    fn an_oversized_statement_is_denied_rather_than_unjudged() {
        let rules = builtin_rules();
        let huge = "a".repeat(MAX_STATEMENT_LEN + 1);
        let verdict = evaluate_rules(&rules, &huge);

        assert_eq!(verdict.decision, "block");
        assert_eq!(verdict.action, RuleAction::Block);
        assert!(
            fired(&verdict)
                .iter()
                .any(|name| name == "statement-too-large"),
            "the reason must name the limit; fired={:?}",
            fired(&verdict)
        );
    }

    /// An invalid pattern must surface as an error, never as a silent skip - the
    /// `(?i)`-mid-pattern bug shipped an inert guardrail precisely because a
    /// broken rule compiled to nothing and nothing said so.
    #[test]
    fn an_invalid_pattern_is_reported_instead_of_silently_skipped() {
        let broken = rule_body("broken-rule", "(unclosed[", "block", "");
        let parsed = parse_rule("broken-rule", &broken, RuleOrigin::Workspace)
            .expect("frontmatter is valid");
        let error = compile_rule(parsed).expect_err("an invalid regex must fail");
        assert!(
            error.contains("broken-rule") && error.contains("invalid pattern"),
            "error should name the rule and the cause: {error}"
        );

        let root = TempRoot::new("broken");
        write_rule(root.path(), "broken-rule.md", &broken);
        let (rules, report) = load_rules_from_roots(&[root.path().to_path_buf()]);

        assert!(rules.is_empty(), "a broken rule must not be armed");
        assert_eq!(report.loaded, 0);
        assert_eq!(
            report.errors.len(),
            1,
            "the failure must be reported: {:?}",
            report.errors
        );
        assert!(report.errors[0].reason.contains("invalid pattern"));
    }

    #[test]
    fn a_rule_without_a_description_is_an_error() {
        let body = "---\nname: nameless\nevent: pre_write\npattern: delete\n---\n";
        let error = parse_rule("nameless", body, RuleOrigin::Workspace)
            .expect_err("a rule must explain itself");
        assert!(error.contains("description"), "unexpected error: {error}");
    }

    #[test]
    fn a_disabled_rule_never_fires() {
        let root = TempRoot::new("disabled");
        let body = rule_body(
            "disabled-block",
            "\\bdelete\\b",
            "block",
            "enabled: false\n",
        );
        write_rule(root.path(), "disabled-block.md", &body);

        let (rules, report) = load_rules_from_roots(&[root.path().to_path_buf()]);
        assert_eq!(report.loaded, 1, "a disabled rule still loads");
        assert!(
            fired(&evaluate_rules(&rules, "DELETE FROM users")).is_empty(),
            "a disabled rule must not arm itself"
        );
    }

    /// A repo-local rule must shadow the built-in of the same name, not double it.
    #[test]
    fn a_workspace_rule_shadows_the_builtin_of_the_same_name() {
        let workspace = TempRoot::new("workspace");
        let data_dir = TempRoot::new("data");

        let seeded = seed_rules_into_root(data_dir.path(), false).expect("seed built-in pack");
        assert_eq!(seeded.installed, BUILTIN_RULES.len());

        let override_body = rule_body(
            "no-delete-without-where",
            "(?is)\\bdelete\\s+from\\b",
            "warn",
            "",
        );
        write_rule(
            workspace.path(),
            "no-delete-without-where.md",
            &override_body,
        );

        let (rules, report) = load_rules_from_roots(&[
            workspace.path().to_path_buf(),
            data_dir.path().to_path_buf(),
        ]);

        let names = fired(&evaluate_rules(&rules, "DELETE FROM users"));
        assert_eq!(
            names,
            vec!["no-delete-without-where".to_string()],
            "the rule must be armed exactly once"
        );
        assert!(
            report.skipped >= 1,
            "the shadowed built-in must be counted as skipped, not silently dropped"
        );

        let verdict = evaluate_rules(&rules, "DELETE FROM users");
        assert_eq!(
            verdict.action,
            RuleAction::Warn,
            "the workspace override must win, not the built-in block"
        );
    }

    #[test]
    fn seeded_builtin_rules_are_labelled_builtin_and_reload_untouched() {
        let root = TempRoot::new("origin");
        seed_rules_into_root(root.path(), false).expect("seed built-in pack");

        let (rules, report) = load_rules_from_roots(&[root.path().to_path_buf()]);
        assert_eq!(report.errors, Vec::new());
        assert_eq!(report.loaded, BUILTIN_RULES.len());
        assert!(rules
            .iter()
            .all(|rule| rule.rule.origin == RuleOrigin::Builtin));

        let verdict = evaluate_rules(&rules, "DELETE FROM users");
        assert_eq!(verdict.decision, "block");
    }

    /// Seeding runs on every startup, so it must be a no-op the second time - and
    /// it must never overwrite a rule the user edited (the whole point of the
    /// manifest is that a rule marked `userModified` is left alone).
    #[test]
    fn seeding_is_idempotent_and_never_clobbers_a_user_edit() {
        let root = TempRoot::new("lifecycle");
        let file_name = BUILTIN_RULES[0].0;
        let rule_path = root.path().join(file_name);

        let first = seed_rules_into_root(root.path(), false).expect("first seed");
        assert_eq!(first.installed, BUILTIN_RULES.len());
        assert_eq!(first.refreshed, 0);
        assert_eq!(first.user_modified, 0);
        assert!(rule_path.exists());

        let second = seed_rules_into_root(root.path(), false).expect("second seed");
        assert_eq!(second.installed, 0, "a re-seed must install nothing new");
        assert_eq!(second.unchanged, BUILTIN_RULES.len());
        assert_eq!(second.refreshed, 0);

        let customised = "---\nname: no-delete-without-where\ndescription: mine\npattern: (?is)\\bdelete\\b\naction: warn\n---\n";
        std::fs::write(&rule_path, customised).expect("user edit");

        let third = seed_rules_into_root(root.path(), false).expect("seed after user edit");
        assert_eq!(third.user_modified, 1);
        assert_eq!(
            std::fs::read_to_string(&rule_path).expect("rule still readable"),
            customised,
            "an upgrade must never overwrite a rule the user edited"
        );

        let forced = seed_rules_into_root(root.path(), true).expect("force seed");
        assert_eq!(forced.refreshed, 1);
        assert_eq!(
            std::fs::read_to_string(&rule_path).expect("rule restored"),
            BUILTIN_RULES[0].1,
            "the explicit reset is the only path that discards a user edit"
        );
    }

    /// A file the user deleted holds no intent, so the seeder restores it.
    #[test]
    fn a_deleted_builtin_rule_is_restored_on_the_next_seed() {
        let root = TempRoot::new("restore");
        seed_rules_into_root(root.path(), false).expect("first seed");

        let file_name = BUILTIN_RULES[1].0;
        let rule_path = root.path().join(file_name);
        std::fs::remove_file(&rule_path).expect("delete the rule");

        let report = seed_rules_into_root(root.path(), false).expect("re-seed");
        assert_eq!(report.installed, 1);
        assert!(
            rule_path.exists(),
            "a missing built-in must come back without a force flag"
        );
    }

    /// Regression: the rules manager lists what is *armed*, so opening the panel
    /// must not read as "this statement was blocked" just because a `block` rule
    /// is installed.
    #[test]
    fn the_armed_rules_inventory_never_reports_a_block() {
        let rules = builtin_rules();
        let inventory = RuleVerdict::inventory(
            rules
                .iter()
                .map(|candidate| RuleMatch {
                    name: candidate.rule.name.clone(),
                    description: candidate.rule.description.clone(),
                    action: candidate.rule.action,
                    origin: candidate.rule.origin,
                })
                .collect(),
        );

        assert!(inventory
            .matched_rules
            .iter()
            .any(|m| m.action == RuleAction::Block));
        assert_eq!(
            inventory.decision, "allow",
            "listing the pack is not an evaluation and must not inherit the strictest action"
        );
        assert!(inventory.message.is_empty());
    }

    #[test]
    fn the_seeder_writes_a_manifest_recording_every_builtin() {
        let root = TempRoot::new("manifest");
        seed_rules_into_root(root.path(), false).expect("seed built-in pack");

        let manifest_path = root.path().join(SEED_MANIFEST_NAME);
        assert!(
            manifest_path.exists(),
            "the manifest is what protects edits"
        );

        let manifest = load_rule_manifest(root.path());
        assert_eq!(manifest.rules.len(), BUILTIN_RULES.len());
        for (file_name, _) in BUILTIN_RULES {
            assert!(
                manifest.rules.contains_key(*file_name),
                "{file_name} must be recorded in the manifest"
            );
        }
    }
    #[test]
    fn saved_rule_round_trips_through_the_loader() {
        let root = std::env::temp_dir().join(format!("tabler-rule-save-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let spec = NewRuleSpec {
            name: "dead-column-users-deleted-at".to_string(),
            description: "users.deleted_at is never populated: review SQL that filters on it."
                .to_string(),
            enabled: true,
            event: RuleEvent::PreRead,
            action: RuleAction::Warn,
            pattern: r"(?i)\bdeleted_at\b".to_string(),
            pattern_not: None,
            scan: RuleScan::Skeleton,
        };

        let path = save_rule_into_root(&root, &spec).expect("rule saved");
        let contents = std::fs::read_to_string(&path).expect("rule file readable");
        let parsed = parse_rule(&spec.name, &contents, RuleOrigin::Global).expect("rule parses");
        assert_eq!(parsed.event, RuleEvent::PreRead);
        assert_eq!(parsed.action, RuleAction::Warn);
        assert_eq!(parsed.scan, RuleScan::Skeleton);
        assert_eq!(parsed.pattern, spec.pattern);
        assert!(parsed.enabled);
        compile_rule(parsed).expect("rule compiles");

        // A second save must not clobber a file the user may have edited.
        let again = save_rule_into_root(&root, &spec).expect_err("must refuse to overwrite");
        assert!(again.contains("already exists"), "got: {again}");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_rule_that_cannot_compile_never_reaches_the_disk() {
        let root = std::env::temp_dir().join(format!("tabler-rule-broken-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let spec = NewRuleSpec {
            name: "broken-pattern".to_string(),
            description: "An invalid regex must be refused before anything is written.".to_string(),
            enabled: true,
            event: RuleEvent::Any,
            action: RuleAction::Warn,
            pattern: "(unclosed".to_string(),
            pattern_not: None,
            scan: RuleScan::Skeleton,
        };

        let error = save_rule_into_root(&root, &spec).expect_err("invalid regex is rejected");
        assert!(error.contains("cannot compile"), "got: {error}");
        assert!(
            !root.exists(),
            "a refused rule must not leave a directory behind"
        );
    }

    #[test]
    fn rule_names_are_slugs_so_a_name_cannot_escape_the_rules_dir() {
        assert!(validate_rule_name("../escape").is_err());
        assert!(validate_rule_name("Upper").is_err());
        assert!(validate_rule_name("a/b").is_err());
        assert!(validate_rule_name("").is_err());
        assert_eq!(
            validate_rule_name(" ok-name_1 ").expect("slug"),
            "ok-name_1"
        );
    }

    #[test]
    fn workspace_rule_written_by_the_command_is_picked_up_by_evaluation() {
        let temp = TempRoot::new("workspace-write");
        let workspace = temp.path().join("project");
        let content = rule_body("no-drop-table", "(?is)\\bdrop\\s+table\\b", "block", "");

        let path = write_workspace_rule_into(&workspace, "no-drop-table", &content)
            .expect("valid rule is written");
        assert_eq!(path, workspace.join("rules").join("no-drop-table.md"));

        // The same load path `evaluate_agent_rules` uses must arm the new file.
        let (rules, report) = load_rules_from_roots(&[workspace.join(RULES_DIR_NAME)]);
        assert_eq!(report.errors, vec![], "written rule must load cleanly");
        let verdict = evaluate_rules(&rules, "DROP TABLE users");
        assert_eq!(verdict.decision, "block");
        assert_eq!(fired(&verdict), vec!["no-drop-table".to_string()]);

        // A second write must not clobber a file the user may have edited.
        let again = write_workspace_rule_into(&workspace, "no-drop-table", &content)
            .expect_err("must refuse to overwrite");
        assert!(again.contains("already exists"), "got: {again}");

        // A rule that cannot compile never reaches the disk.
        let broken = rule_body("broken", "(unclosed", "warn", "");
        let error = write_workspace_rule_into(&workspace, "broken", &broken)
            .expect_err("invalid regex is rejected");
        assert!(error.contains("cannot compile"), "got: {error}");
        assert!(!workspace.join("rules").join("broken.md").exists());
    }
}
