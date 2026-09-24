use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::utils::paths::resolve_data_dir;

use super::parse::{compile_rule, parse_rule};
use super::types::{
    RuleAction, RuleEvent, RuleLoadReport, RuleOrigin, RuleScan, RuleVerdict, BUILTIN_RULES,
    RULES_DIR_NAME, SEED_MANIFEST_NAME,
};
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
pub(crate) struct RuleManifestEntry {
    /// sha256 of the content we last wrote for this rule.
    hash: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub(crate) struct RuleManifest {
    /// File name -> what we last installed for it.
    #[serde(default)]
    pub(crate) rules: std::collections::BTreeMap<String, RuleManifestEntry>,
}

pub(crate) fn load_rule_manifest(rules_root: &Path) -> RuleManifest {
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
pub(crate) fn seed_rules_into_root(
    rules_root: &Path,
    force: bool,
) -> Result<RuleSeedReport, String> {
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
pub(crate) fn global_rules_root() -> Result<PathBuf, String> {
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
