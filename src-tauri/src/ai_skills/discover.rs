use std::path::PathBuf;

use crate::utils::paths::resolve_data_dir;

use super::parse::{
    dir_display_name, list_skill_resource_files, parse_skill_md, skill_md_path,
    skill_md_updated_at, validate_resource_rel,
};
use super::types::{
    AISkillContent, AISkillListReport, AISkillLoadError, AISkillResource, AISkillSummary,
    MAX_SKILLS_PER_CATALOG, MAX_SKILL_BODY_CHARS, MAX_SKILL_RESOURCE_CHARS,
};
pub(crate) fn skill_roots(workspace_dir: Option<&str>) -> Vec<(PathBuf, String)> {
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

/// Scan every skill root for `<name>/SKILL.md` directories. Workspace skills
/// shadow global ones sharing the same name (first hit wins, and workspace
/// roots are scanned first).
pub fn discover_ai_skills_in_roots(roots: &[(PathBuf, String)]) -> AISkillListReport {
    let mut summaries: Vec<AISkillSummary> = Vec::new();
    let mut errors: Vec<AISkillLoadError> = Vec::new();
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
                errors.push(AISkillLoadError {
                    path: file_path.display().to_string(),
                    reason: "SKILL.md could not be read.".to_string(),
                });
                continue;
            };
            let (meta, _) = parse_skill_md(&raw);
            // The Agent Skills standard requires name == directory name.
            let Some(parsed_name) = meta.name.clone() else {
                log::warn!(
                    "ai_skills: '{}' ({}) has no frontmatter name — dropped",
                    dir_name,
                    source
                );
                errors.push(AISkillLoadError {
                    path: file_path.display().to_string(),
                    reason: "SKILL.md has no frontmatter name.".to_string(),
                });
                continue;
            };
            if parsed_name != dir_name || parsed_name.len() > 64 {
                log::warn!(
                    "ai_skills: '{}' ({}) name/directory mismatch or name too long — dropped",
                    parsed_name,
                    source
                );
                errors.push(AISkillLoadError {
                    path: file_path.display().to_string(),
                    reason: format!(
                        "Frontmatter name '{parsed_name}' must match the directory name and be at most 64 characters."
                    ),
                });
                continue;
            }
            if seen.contains(&parsed_name) {
                continue;
            }
            seen.insert(parsed_name.clone());
            summaries.push(AISkillSummary {
                name: parsed_name,
                description: meta.description.clone().unwrap_or_default(),
                source: source.clone(),
                version: meta.version.clone(),
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
    AISkillListReport {
        skills: summaries,
        errors,
    }
}

pub fn discover_ai_skills(workspace_dir: Option<&str>) -> AISkillListReport {
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
        let (meta, body) = parse_skill_md(&raw);
        // Same strictness as discovery: a frontmatter without a matching
        // name must not be readable under a different name.
        let Some(parsed_name) = meta.name.clone() else {
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
            description: meta.description.clone().unwrap_or_default(),
            source: source.to_string(),
            body,
            version: meta.version.clone(),
            license: meta.license.clone(),
            model: meta.model.clone(),
            effort: meta.effort.clone(),
            allowed_tools: meta.allowed_tools.clone(),
            resources: list_skill_resource_files(&dir_path),
            updated_at: skill_md_updated_at(&file_path),
        });
    }
    Err(format!("Skill '{trimmed}' was not found."))
}

/// List discovered Agent Skills (name + description only) for the picker and
/// the agent's `<available_skills>` block, plus every SKILL.md that failed to
/// load so the manager can surface it instead of dropping it silently.
#[tauri::command]
pub fn list_ai_skills(workspace_dir: Option<String>) -> Result<AISkillListReport, String> {
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

/// Resolve one bundled resource file (references/, scripts/) of a skill across
/// explicit roots. Guarded against traversal and symlink escape: the resolved
/// file must canonicalize to a path inside the skill directory.
pub fn read_skill_resource_in_roots(
    roots: &[(PathBuf, String)],
    name: &str,
    resource: &str,
) -> Result<AISkillResource, String> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed.len() > 64
        || !trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err("Invalid skill name.".to_string());
    }
    let relative = validate_resource_rel(resource)?;
    for (root, source) in roots {
        let dir_path = root.join(trimmed);
        let (Ok(canonical_root), Ok(canonical_dir)) =
            (root.canonicalize(), dir_path.canonicalize())
        else {
            continue;
        };
        if !canonical_dir.starts_with(&canonical_root) {
            continue;
        }
        // The skill must actually exist (SKILL.md present) before its resources
        // are readable, so a bare directory cannot expose arbitrary files.
        if !skill_md_path(&dir_path).is_file() {
            continue;
        }
        let resource_path = dir_path.join(&relative);
        // Canonicalize resolves any symlink in the chain; requiring containment
        // in the skill dir rejects a link that points outside the skill root.
        let Ok(canonical_resource) = resource_path.canonicalize() else {
            continue;
        };
        if !canonical_resource.starts_with(&canonical_dir) {
            return Err("Resource path escapes the skill directory.".to_string());
        }
        let Ok(raw) = std::fs::read_to_string(&canonical_resource) else {
            return Err(format!(
                "Resource '{relative}' could not be read as UTF-8 text."
            ));
        };
        let content = if raw.chars().count() > MAX_SKILL_RESOURCE_CHARS {
            let cut = raw
                .chars()
                .take(MAX_SKILL_RESOURCE_CHARS)
                .collect::<String>();
            format!("{cut}\n\n[resource truncated at {MAX_SKILL_RESOURCE_CHARS} characters — the file is larger]")
        } else {
            raw
        };
        return Ok(AISkillResource {
            name: trimmed.to_string(),
            resource: relative,
            source: source.to_string(),
            content,
        });
    }
    Err(format!(
        "Resource '{relative}' was not found for skill '{trimmed}'."
    ))
}

/// Read one bundled resource file of a skill on demand (progressive disclosure
/// level 3). Only references/ and scripts/ text files are readable.
#[tauri::command]
pub fn read_ai_skill_resource(
    workspace_dir: Option<String>,
    name: String,
    resource: String,
) -> Result<AISkillResource, String> {
    read_skill_resource_in_roots(&skill_roots(workspace_dir.as_deref()), &name, &resource)
}
