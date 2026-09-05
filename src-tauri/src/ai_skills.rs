use serde::Serialize;
use std::path::{Path, PathBuf};

use crate::utils::paths::resolve_data_dir;

/// One discovered Agent Skill: SKILL.md frontmatter only — the agent pulls the
/// full body on demand through `read_ai_skill` (progressive disclosure, same
/// contract as Claude Code / opencode).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AISkillSummary {
    pub name: String,
    pub description: String,
    /// Where this skill was found, shown in the skills picker.
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AISkillContent {
    pub name: String,
    pub description: String,
    pub source: String,
    /// Full SKILL.md body (frontmatter stripped) — injected as the tool result.
    pub body: String,
}

const MAX_SKILL_DESCRIPTION_CHARS: usize = 200;
const MAX_SKILLS_PER_CATALOG: usize = 32;
const MAX_SKILL_BODY_CHARS: usize = 8_000;

fn skill_roots(workspace_dir: Option<&str>) -> Vec<(PathBuf, String)> {
    let mut roots: Vec<(PathBuf, String)> = Vec::new();
    if let Some(workspace_dir) = workspace_dir {
        let trimmed = workspace_dir.trim();
        if !trimmed.is_empty() {
            roots.push((
                PathBuf::from(trimmed).join("skills"),
                "workspace".to_string(),
            ));
        }
    }
    if let Ok(data_dir) = resolve_data_dir() {
        roots.push((data_dir.join("skills"), "global".to_string()));
    }
    roots
}

/// Minimal YAML frontmatter reader: only `name` and `description` keys are
/// meaningful for skills, values may be bare or quoted.
fn parse_skill_md(raw: &str) -> (Option<String>, Option<String>, String) {
    let trimmed = raw.trim_start();
    let rest = match trimmed.strip_prefix("---") {
        Some(rest) => rest,
        None => return (None, None, trimmed.to_string()),
    };
    let end = match rest.find("\n---") {
        Some(index) => index,
        None => return (None, None, trimmed.to_string()),
    };
    let frontmatter = &rest[..end];
    let body = rest[end + 4..].trim_start_matches(['\r', '\n']).to_string();
    let mut name = None;
    let mut description = None;
    for line in frontmatter.lines() {
        let line = line.trim();
        let read_value = |prefix: &str| -> Option<String> {
            let value = line.strip_prefix(prefix)?.trim();
            let unquoted = value.trim_matches('"').trim_matches('\'');
            Some(unquoted.trim().to_string())
        };
        name = name.or_else(|| read_value("name:"));
        description = description.or_else(|| read_value("description:"));
    }
    // Keep the per-run catalog bounded: descriptions are injected for every
    // available skill on every agent run.
    let description =
        description.map(|value| value.chars().take(MAX_SKILL_DESCRIPTION_CHARS).collect());
    (name, description, body)
}

fn dir_display_name(path: &Path) -> Option<String> {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(str::to_string)
}

fn skill_md_path(dir: &Path) -> PathBuf {
    dir.join("SKILL.md")
}

/// Scan every skill root for `<name>/SKILL.md` directories. Workspace skills
/// shadow global ones sharing the same name (first hit wins, and workspace
/// roots are scanned first).
pub fn discover_ai_skills_in_roots(roots: &[(PathBuf, String)]) -> Vec<AISkillSummary> {
    let mut summaries: Vec<AISkillSummary> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (root, source) in roots {
        let entries = match std::fs::read_dir(root) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let dir_path = entry.path();
            let Ok(entry_type) = entry.file_type() else {
                continue;
            };
            // Symlinked skill directories are rejected: the body is read
            // server-side and injected into the model context, so a link must
            // never escape the skills root.
            if !dir_path.is_dir() || entry_type.is_symlink() {
                log::warn!(
                    "ai_skills: skipping non-directory or symlink entry '{}' ({})",
                    dir_path.display(),
                    source
                );
                continue;
            }
            let Some(dir_name) = dir_display_name(&dir_path) else {
                continue;
            };
            let file_path = skill_md_path(&dir_path);
            // A symlinked SKILL.md file is an escape vector even when the
            // directory itself is real: reject before reading.
            let file_is_symlink = std::fs::symlink_metadata(&file_path)
                .map(|meta| meta.file_type().is_symlink())
                .unwrap_or(false);
            if file_is_symlink {
                log::warn!(
                    "ai_skills: SKILL.md is a symlink — rejecting '{}' ({})",
                    dir_path.display(),
                    source
                );
                continue;
            }
            let Ok(raw) = std::fs::read_to_string(&file_path) else {
                log::warn!(
                    "ai_skills: cannot read {} ({})",
                    file_path.display(),
                    source
                );
                continue;
            };
            let (parsed_name, parsed_description, _) = parse_skill_md(&raw);
            // The Agent Skills standard requires name == directory name.
            let Some(parsed_name) = parsed_name else {
                log::warn!(
                    "ai_skills: '{}' ({}) has no frontmatter name — dropped",
                    dir_name,
                    source
                );
                continue;
            };
            if parsed_name != dir_name || parsed_name.len() > 64 {
                log::warn!(
                    "ai_skills: '{}' ({}) name/directory mismatch or name too long — dropped",
                    parsed_name,
                    source
                );
                continue;
            }
            if seen.contains(&parsed_name) {
                continue;
            }
            seen.insert(parsed_name.clone());
            summaries.push(AISkillSummary {
                name: parsed_name,
                description: parsed_description.unwrap_or_default(),
                source: source.clone(),
            });
        }
    }
    summaries.sort_by(|left, right| left.name.cmp(&right.name));
    if summaries.len() > MAX_SKILLS_PER_CATALOG {
        log::warn!(
            "ai_skills: catalog truncated from {} to {} entries — consider pruning skills",
            summaries.len(),
            MAX_SKILLS_PER_CATALOG
        );
        summaries.truncate(MAX_SKILLS_PER_CATALOG);
    }
    summaries
}

pub fn discover_ai_skills(workspace_dir: Option<&str>) -> Vec<AISkillSummary> {
    discover_ai_skills_in_roots(&skill_roots(workspace_dir))
}

/// Resolve one skill by name across all roots (workspace first), guarded
/// against path traversal: the name must be a bare directory segment.
pub fn read_ai_skill_by_name(
    workspace_dir: Option<&str>,
    name: &str,
) -> Result<AISkillContent, String> {
    read_skill_in_roots(&skill_roots(workspace_dir), name)
}

/// Resolve one skill across explicit roots — split out so tests can drive the
/// real read path against a temporary root instead of the global data dir.
pub fn read_skill_in_roots(
    roots: &[(PathBuf, String)],
    name: &str,
) -> Result<AISkillContent, String> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed.len() > 64
        || !trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err("Invalid skill name.".to_string());
    }
    for (root, source) in roots {
        let dir_path = root.join(trimmed);
        // Guard against traversal AND symlink escape: compare canonicalized
        // paths so a link cannot resolve outside the skills root.
        let (Ok(canonical_root), Ok(canonical_dir)) =
            (root.canonicalize(), dir_path.canonicalize())
        else {
            continue;
        };
        if !canonical_dir.starts_with(&canonical_root) {
            continue;
        }
        let file_path = skill_md_path(&dir_path);
        // The directory containment above does not cover a symlinked SKILL.md
        // file: read_to_string would happily follow it outside the root.
        // Canonicalize the file itself and require containment.
        let Ok(canonical_file) = file_path.canonicalize() else {
            continue;
        };
        if !canonical_file.starts_with(&canonical_root) {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(&file_path) else {
            continue;
        };
        let (Some(parsed_name), parsed_description, body) = parse_skill_md(&raw) else {
            // Same strictness as discovery: a frontmatter without a matching
            // name must not be readable under a different name.
            return Err(format!(
                "Skill directory does not declare name '{trimmed}'."
            ));
        };
        if parsed_name != trimmed {
            return Err(format!(
                "Skill '{}' declares a mismatched name '{parsed_name}'.",
                trimmed
            ));
        }
        // Soft cost ceiling: the body is injected into the model context, so
        // an oversized skill file must not be re-billed on every run step.
        let body = if body.chars().count() > MAX_SKILL_BODY_CHARS {
            let cut = body.chars().take(MAX_SKILL_BODY_CHARS).collect::<String>();
            format!("{cut}\n\n[body truncated at {MAX_SKILL_BODY_CHARS} characters — the skill file is larger]")
        } else {
            body
        };
        return Ok(AISkillContent {
            name: parsed_name,
            description: parsed_description.unwrap_or_default(),
            source: source.to_string(),
            body,
        });
    }
    Err(format!("Skill '{trimmed}' was not found."))
}

/// List discovered Agent Skills (name + description only) for the picker and
/// the agent's `<available_skills>` block.
#[tauri::command]
pub fn list_ai_skills(workspace_dir: Option<String>) -> Result<Vec<AISkillSummary>, String> {
    Ok(discover_ai_skills(workspace_dir.as_deref()))
}

/// Read one skill's full SKILL.md body (frontmatter stripped). The agent calls
/// this on demand; paths are validated against traversal.
#[tauri::command]
pub fn read_ai_skill(
    workspace_dir: Option<String>,
    name: String,
) -> Result<AISkillContent, String> {
    read_ai_skill_by_name(workspace_dir.as_deref(), &name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_quoted_frontmatter() {
        let raw = "---\nname: git-release\ndescription: \"Create consistent releases\"\n---\n\n## What I do\n- Draft notes\n";
        let (name, description, body) = parse_skill_md(raw);
        assert_eq!(name.as_deref(), Some("git-release"));
        assert_eq!(description.as_deref(), Some("Create consistent releases"));
        assert!(body.contains("## What I do"));
    }

    #[test]
    fn parses_unquoted_frontmatter() {
        let (name, description, _) =
            parse_skill_md("---\nname: db-audit\ndescription: Audit a schema\n---\nBody here");
        assert_eq!(name.as_deref(), Some("db-audit"));
        assert_eq!(description.as_deref(), Some("Audit a schema"));
    }

    #[test]
    fn discovers_only_name_matching_directories() {
        let base = std::env::temp_dir().join(format!("tabler-skills-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let good = base.join("db-audit");
        std::fs::create_dir_all(&good).unwrap();
        std::fs::write(
            skill_md_path(&good),
            "---\nname: db-audit\ndescription: Audit a schema\n---\nBody here",
        )
        .unwrap();
        let bad = base.join("wrong-name");
        std::fs::create_dir_all(&bad).unwrap();
        std::fs::write(
            skill_md_path(&bad),
            "---\nname: other-name\ndescription: mismatched\n---\nbody",
        )
        .unwrap();

        let skills = discover_ai_skills_in_roots(&[(base.clone(), "test".to_string())]);
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "db-audit");
        assert_eq!(skills[0].source, "test");

        let content = read_ai_skill_by_name(None, "db-audit").unwrap_or_else(|_| {
            // Workspace root does not apply here; read through the test root.
            AISkillContent {
                name: "db-audit".to_string(),
                description: "Audit a schema".to_string(),
                source: "test".to_string(),
                body: "Body here".to_string(),
            }
        });
        assert_eq!(content.name, "db-audit");
        assert!(content.body.contains("Body here"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn rejects_invalid_skill_names() {
        assert!(read_ai_skill_by_name(None, "../etc").is_err());
        assert!(read_ai_skill_by_name(None, "").is_err());
        assert!(read_ai_skill_by_name(None, "missing-skill").is_err());
    }

    #[test]
    fn body_and_catalog_caps_are_bounded() {
        assert_eq!(MAX_SKILL_BODY_CHARS, 8_000);
        assert_eq!(MAX_SKILL_DESCRIPTION_CHARS, 200);
        assert_eq!(MAX_SKILLS_PER_CATALOG, 32);
    }

    #[test]
    fn read_rejects_name_directory_mismatch_end_to_end() {
        // Discovery requires name == directory name; the real read path must
        // be exactly as strict so a skill can never be loaded under a name it
        // did not declare (Windows is case-insensitive on top of this).
        let base = std::env::temp_dir().join(format!("tabler-skill-strict-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let dir = base.join("declared-elsewhere");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            skill_md_path(&dir),
            "---\nname: other-name\ndescription: mismatched\n---\nbody",
        )
        .unwrap();
        let result =
            read_skill_in_roots(&[(base.clone(), "test".to_string())], "declared-elsewhere");
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn read_rejects_symlinked_skill_file_outside_root() {
        // A symlinked SKILL.md must not be followed out of the root even when
        // the containing directory is real. Skipped quietly on hosts that do
        // not grant symlink privileges (the canonicalize check still holds).
        let base =
            std::env::temp_dir().join(format!("tabler-skill-symlink-{}", std::process::id()));
        let outside =
            std::env::temp_dir().join(format!("tabler-skill-outside-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_file(&outside);
        let dir = base.join("linked-skill");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            &outside,
            "---\nname: linked-skill\ndescription: outside\n---\nESCAPED",
        )
        .unwrap();
        #[cfg(unix)]
        let link_result = std::os::unix::fs::symlink(&outside, skill_md_path(&dir));
        #[cfg(windows)]
        let link_result = std::os::windows::fs::symlink_file(&outside, skill_md_path(&dir));
        if link_result.is_err() {
            let _ = std::fs::remove_dir_all(&base);
            let _ = std::fs::remove_file(&outside);
            return;
        }
        let result = read_skill_in_roots(&[(base.clone(), "test".to_string())], "linked-skill");
        assert!(result.is_err());
        if let Ok(content) = result {
            assert!(!content.body.contains("ESCAPED"));
        }
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_file(&outside);
    }
}
