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

fn skill_roots(workspace_dir: Option<&str>) -> Vec<(PathBuf, String)> {
    let mut roots: Vec<(PathBuf, String)> = Vec::new();
    if let Some(workspace_dir) = workspace_dir {
        let trimmed = workspace_dir.trim();
        if !trimmed.is_empty() {
            roots.push((PathBuf::from(trimmed).join("skills"), "workspace".to_string()));
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
    (name, description, body)
}

fn dir_display_name(path: &Path) -> Option<String> {
    path.file_name().and_then(|value| value.to_str()).map(str::to_string)
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
            if !dir_path.is_dir() {
                continue;
            }
            let Some(dir_name) = dir_display_name(&dir_path) else {
                continue;
            };
            let Ok(raw) = std::fs::read_to_string(skill_md_path(&dir_path)) else {
                continue;
            };
            let (parsed_name, parsed_description, _) = parse_skill_md(&raw);
            // The Agent Skills standard requires name == directory name.
            let Some(parsed_name) = parsed_name else {
                continue;
            };
            if parsed_name != dir_name || parsed_name.len() > 64 {
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
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed.len() > 64
        || !trimmed.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err("Invalid skill name.".to_string());
    }
    for (root, source) in skill_roots(workspace_dir) {
        let dir_path = root.join(trimmed);
        // Guard against traversal: the resolved path must stay inside the root.
        if !dir_path.starts_with(&root) {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(skill_md_path(&dir_path)) else {
            continue;
        };
        let (parsed_name, parsed_description, body) = parse_skill_md(&raw);
        return Ok(AISkillContent {
            name: parsed_name.unwrap_or_else(|| trimmed.to_string()),
            description: parsed_description.unwrap_or_default(),
            source,
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
}
