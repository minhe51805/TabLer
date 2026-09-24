use std::path::{Path, PathBuf};

use super::eval::{evaluate_rules, evaluate_rules_for_event};
use super::parse::{classify_sql_event, compile_rule, parse_rule};
use super::roots::load_rules;
use super::seed::{
    global_rules_root, save_rule_into_root, seed_rules_into_root, validate_rule_name, NewRuleSpec,
    RuleEvaluation, RuleSeedReport,
};
use super::types::{
    RuleAction, RuleEvent, RuleMatch, RuleOrigin, RuleScan, RuleVerdict, SqlEvent, RULES_DIR_NAME,
};
use crate::utils::paths::resolve_data_dir;
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

/// Write a user-authored rule file into `rules_root`, refusing to clobber an
/// existing file — split from the command so tests drive a temp directory
/// instead of a real workspace.
pub(crate) fn write_rule_into_root(
    rules_root: &Path,
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

    std::fs::create_dir_all(rules_root).map_err(|error| error.to_string())?;
    let path = rules_root.join(format!("{name}.md"));
    if path.exists() {
        return Err(format!(
            "A rule named '{name}' already exists. Edit that file instead of overwriting it."
        ));
    }
    std::fs::write(&path, format!("{trimmed}\n")).map_err(|error| error.to_string())?;
    Ok(path)
}

/// Write a user-authored rule file into the rules root that applies here:
/// `<workspace_dir>/rules` when a folder is linked, otherwise the global
/// `<data_dir>/rules`. Both are roots `evaluate_agent_rules` already scans, so
/// a user with no linked folder can still author guardrails.
///
/// Unlike `save_agent_rule` (which renders a `NewRuleSpec`), this command takes
/// the raw Markdown the user typed. The content is still parsed and compiled
/// before the write: a guardrail the engine cannot load is worse than no
/// guardrail, because the caller believes it is protected.
#[tauri::command]
pub fn write_workspace_rule(
    workspace_dir: Option<String>,
    name: String,
    content: String,
) -> Result<String, String> {
    let rules_root = match workspace_dir {
        Some(dir) => Path::new(&dir).join(RULES_DIR_NAME),
        None => global_rules_root()?,
    };
    let path = write_rule_into_root(&rules_root, &name, &content)?;
    Ok(path.to_string_lossy().to_string())
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
