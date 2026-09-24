use std::collections::HashSet;
use std::path::{Path, PathBuf};

use super::parse::{compile_rule, parse_rule};
use super::types::{
    CompiledRule, RuleLoadError, RuleLoadReport, RuleOrigin, BUILTIN_RULES, MAX_RULES_PER_ROOT,
    RULES_DIR_NAME,
};
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
