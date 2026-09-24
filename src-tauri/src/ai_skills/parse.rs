use std::path::{Path, PathBuf};

use super::types::{
    MAX_SKILL_ALLOWED_TOOLS, MAX_SKILL_DESCRIPTION_CHARS, MAX_SKILL_RESOURCES, SKILL_RESOURCE_DIRS,
};
/// ignored. Values may be bare or quoted. Matches the Claude Code skill contract.
#[derive(Debug, Default, Clone)]
pub struct SkillFrontmatter {
    pub name: Option<String>,
    pub description: Option<String>,
    pub version: Option<String>,
    pub license: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub allowed_tools: Vec<String>,
}

/// Split an inline `allowed-tools:` value (`[a, b]` or `a, b`) into names.
fn parse_inline_tool_list(raw: &str) -> Vec<String> {
    raw.trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .split(',')
        .map(|item| {
            item.trim()
                .trim_matches('"')
                .trim_matches('\'')
                .trim()
                .to_string()
        })
        .filter(|item| !item.is_empty())
        .take(MAX_SKILL_ALLOWED_TOOLS)
        .collect()
}

/// Minimal YAML frontmatter reader. Supports bare/quoted scalars for the metadata
/// keys, plus `allowed-tools` as an inline (`[a, b]`) or block (`- a`) list.
pub(crate) fn parse_skill_md(raw: &str) -> (SkillFrontmatter, String) {
    // A UTF-8 BOM survives `trim_start()` (it is not whitespace), so a
    // BOM-saved SKILL.md would fail the `---` check and be silently dropped.
    let trimmed = raw.trim_start_matches('\u{feff}').trim_start();
    let Some(rest) = trimmed.strip_prefix("---") else {
        return (SkillFrontmatter::default(), trimmed.to_string());
    };
    let Some(end) = rest.find("\n---") else {
        return (SkillFrontmatter::default(), trimmed.to_string());
    };
    let frontmatter = &rest[..end];
    let body = rest[end + 4..].trim_start_matches(['\r', '\n']).to_string();
    let mut meta = SkillFrontmatter::default();
    // Set while consuming a YAML block list under `allowed-tools:`.
    let mut in_tools_block = false;
    for line in frontmatter.lines() {
        let line = line.trim();
        if in_tools_block {
            if let Some(item) = line.strip_prefix('-') {
                let item = item.trim().trim_matches('"').trim_matches('\'').trim();
                if !item.is_empty() && meta.allowed_tools.len() < MAX_SKILL_ALLOWED_TOOLS {
                    meta.allowed_tools.push(item.to_string());
                }
                continue;
            }
            in_tools_block = false;
        }
        let read_value = |prefix: &str| -> Option<String> {
            let value = line.strip_prefix(prefix)?.trim();
            let unquoted = value.trim_matches('"').trim_matches('\'');
            Some(unquoted.trim().to_string())
        };
        if meta.name.is_none() {
            meta.name = read_value("name:");
        }
        if meta.description.is_none() {
            meta.description = read_value("description:");
        }
        if meta.version.is_none() {
            meta.version = read_value("version:").filter(|v| !v.is_empty());
        }
        if meta.license.is_none() {
            meta.license = read_value("license:").filter(|v| !v.is_empty());
        }
        if meta.model.is_none() {
            meta.model = read_value("model:").filter(|v| !v.is_empty());
        }
        if meta.effort.is_none() {
            meta.effort = read_value("effort:").filter(|v| !v.is_empty());
        }
        if meta.allowed_tools.is_empty() {
            if let Some(value) =
                read_value("allowed-tools:").or_else(|| read_value("allowed_tools:"))
            {
                if value.is_empty() {
                    // A bare `allowed-tools:` opens a block list on the next lines.
                    in_tools_block = true;
                } else {
                    meta.allowed_tools = parse_inline_tool_list(&value);
                }
            }
        }
    }
    // Keep the per-run catalog bounded: descriptions are injected for every
    // available skill on every agent run.
    meta.description = meta
        .description
        .map(|value| value.chars().take(MAX_SKILL_DESCRIPTION_CHARS).collect());
    (meta, body)
}

/// List bundled resource files (references/, scripts/) for a skill directory.
/// Symlinks are rejected and every file is containment-checked against the
/// canonicalized skill directory so a link can never escape the skill root.
pub(crate) fn list_skill_resource_files(skill_dir: &Path) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let Ok(canonical_dir) = skill_dir.canonicalize() else {
        return out;
    };
    for sub in SKILL_RESOURCE_DIRS {
        if out.len() >= MAX_SKILL_RESOURCES {
            break;
        }
        collect_resource_files(&canonical_dir, &skill_dir.join(sub), sub, &mut out, 0);
    }
    out.sort();
    out.truncate(MAX_SKILL_RESOURCES);
    out
}

pub(crate) fn collect_resource_files(
    canonical_root: &Path,
    dir: &Path,
    rel_prefix: &str,
    out: &mut Vec<String>,
    depth: usize,
) {
    if depth > 3 || out.len() >= MAX_SKILL_RESOURCES {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= MAX_SKILL_RESOURCES {
            return;
        }
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        let rel = format!("{rel_prefix}/{file_name}");
        if file_type.is_dir() {
            collect_resource_files(canonical_root, &path, &rel, out, depth + 1);
        } else if file_type.is_file() {
            if let Ok(canonical) = path.canonicalize() {
                if canonical.starts_with(canonical_root) {
                    out.push(rel);
                }
            }
        }
    }
}

/// Validate a caller-supplied resource path: relative, no traversal, and rooted
/// in an allowed bundled-resource subdirectory. Backslashes are normalized so a
/// Windows-style path cannot smuggle a segment past the checks.
pub(crate) fn validate_resource_rel(resource: &str) -> Result<String, String> {
    let normalized = resource.trim().replace('\\', "/");
    if normalized.is_empty() || normalized.len() > 256 {
        return Err("Invalid resource path.".to_string());
    }
    if normalized.starts_with('/') {
        return Err("Resource path must be relative to the skill directory.".to_string());
    }
    let under_allowed_dir = SKILL_RESOURCE_DIRS
        .iter()
        .any(|dir| normalized.starts_with(&format!("{dir}/")));
    if !under_allowed_dir {
        return Err("Resource must live under references/ or scripts/.".to_string());
    }
    for component in normalized.split('/') {
        if component.is_empty() || component == "." || component == ".." {
            return Err("Resource path must not contain traversal segments.".to_string());
        }
    }
    Ok(normalized)
}

pub(crate) fn dir_display_name(path: &Path) -> Option<String> {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(str::to_string)
}

pub(crate) fn skill_md_path(dir: &Path) -> PathBuf {
    dir.join("SKILL.md")
}

/// SKILL.md modification time in millis epoch — the version token the editor
/// round-trips so `update_ai_skill` can refuse to overwrite a file that changed
/// since it was opened. `None` when the timestamp cannot be read.
pub(crate) fn skill_md_updated_at(file_path: &Path) -> Option<i64> {
    let modified = std::fs::metadata(file_path).ok()?.modified().ok()?;
    let millis = modified
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis();
    Some(i64::try_from(millis).unwrap_or(i64::MAX))
}
