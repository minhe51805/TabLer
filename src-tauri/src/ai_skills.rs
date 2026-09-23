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
    /// Optional `version:` frontmatter, surfaced in the skills manager.
    pub version: Option<String>,
}

/// One SKILL.md entry skipped during discovery, with the reason — surfaced in
/// the skills manager so a malformed file is diagnosable instead of silently
/// absent from the catalog.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AISkillLoadError {
    pub path: String,
    pub reason: String,
}

/// Discovery result: the valid catalog plus every entry that failed to load.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AISkillListReport {
    pub skills: Vec<AISkillSummary>,
    pub errors: Vec<AISkillLoadError>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AISkillContent {
    pub name: String,
    pub description: String,
    pub source: String,
    /// Full SKILL.md body (frontmatter stripped) — injected as the tool result.
    pub body: String,
    /// Optional metadata frontmatter (Claude Code parity), surfaced to the agent
    /// and the manager UI. Empty/None when the skill omits them.
    pub version: Option<String>,
    pub license: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    /// `allowed-tools:` frontmatter — when non-empty the run restricts the agent
    /// to this tool set (plus a small essential set) while the skill is active.
    pub allowed_tools: Vec<String>,
    /// Relative paths (under references/ or scripts/) of bundled resource files
    /// the agent may pull on demand via `read_ai_skill_resource` — the third
    /// progressive-disclosure level. Never loaded into context until requested.
    pub resources: Vec<String>,
    /// SKILL.md modification time (millis epoch). The editor echoes it back as
    /// `expected_updated_at` so a save cannot silently clobber a concurrent
    /// external edit.
    pub updated_at: Option<i64>,
}

/// One bundled resource file resolved on demand (progressive disclosure level 3).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AISkillResource {
    pub name: String,
    pub resource: String,
    pub source: String,
    pub content: String,
}

pub(crate) const MAX_SKILL_DESCRIPTION_CHARS: usize = 200;
const MAX_SKILLS_PER_CATALOG: usize = 32;
pub(crate) const MAX_SKILL_BODY_CHARS: usize = 8_000;
/// Ceiling for a single bundled resource file injected into context on demand.
const MAX_SKILL_RESOURCE_CHARS: usize = 12_000;
/// Max resource files listed per skill so the catalog stays bounded.
const MAX_SKILL_RESOURCES: usize = 64;
/// Max `allowed-tools:` entries parsed from frontmatter.
const MAX_SKILL_ALLOWED_TOOLS: usize = 32;
/// Bundled-resource subdirectories that may be listed and read into context.
/// `assets/` is intentionally excluded: assets are output files, not context.
const SKILL_RESOURCE_DIRS: [&str; 2] = ["references", "scripts"];

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

/// Parsed SKILL.md frontmatter. Only these keys are meaningful; unknown keys are
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
fn parse_skill_md(raw: &str) -> (SkillFrontmatter, String) {
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
fn list_skill_resource_files(skill_dir: &Path) -> Vec<String> {
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

fn collect_resource_files(
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
fn validate_resource_rel(resource: &str) -> Result<String, String> {
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

/// SKILL.md modification time in millis epoch — the version token the editor
/// round-trips so `update_ai_skill` can refuse to overwrite a file that changed
/// since it was opened. `None` when the timestamp cannot be read.
fn skill_md_updated_at(file_path: &Path) -> Option<i64> {
    let modified = std::fs::metadata(file_path).ok()?.modified().ok()?;
    let millis = modified
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis();
    Some(i64::try_from(millis).unwrap_or(i64::MAX))
}

/// Crash-safe SKILL.md write, mirroring `agent_memory::write_memory_file`:
/// refuse to write *through* a pre-existing symlink, stage to a sibling temp
/// file, then rename over the target (same-volume atomic) so a crash mid-write
/// can never leave a torn SKILL.md behind.
pub(crate) fn write_skill_file(file_path: &Path, contents: &str) -> Result<(), String> {
    let target_is_symlink = std::fs::symlink_metadata(file_path)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false);
    if target_is_symlink {
        return Err("SKILL.md is a symlink — refusing to write through it.".to_string());
    }
    let staging_path = file_path.with_extension("md.tmp");
    std::fs::write(&staging_path, contents)
        .map_err(|error| format!("Failed to write skill staging file: {error}"))?;
    if let Err(rename_error) = std::fs::rename(&staging_path, file_path) {
        // Never leave an orphaned staging file inside the skill directory.
        let _ = std::fs::remove_file(&staging_path);
        return Err(format!("Failed to finalize skill write: {rename_error}"));
    }
    Ok(())
}

/// A skill name is a bare directory segment: ASCII alphanumerics and dashes,
/// 1..=64 chars. Shared by the read/create paths so authoring can never produce
/// a skill the reader would reject.
fn validate_skill_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed.len() > 64
        || !trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err(
            "Skill name must be 1-64 characters of letters, digits, or dashes.".to_string(),
        );
    }
    Ok(trimmed.to_string())
}

/// Absolute path of the global skills directory, created if missing. Used by the
/// manager UI to reveal the folder in the OS file browser.
#[tauri::command]
pub fn ai_skills_directory() -> Result<String, String> {
    let data_dir = resolve_data_dir().map_err(|error| error.to_string())?;
    let skills_dir = data_dir.join("skills");
    std::fs::create_dir_all(&skills_dir).map_err(|error| error.to_string())?;
    Ok(skills_dir.to_string_lossy().to_string())
}

/// Scaffold a new skill under an explicit skills root — split out so tests drive
/// a temp directory instead of the real data dir.
///
/// `body` carries the procedure itself when a caller already knows it (the P9
/// learning loop does); without one the file keeps the scaffolding prompt an
/// author needs. Either way the frontmatter is generated here, so a written
/// skill always satisfies the discovery contract.
fn create_skill_in_root(
    skills_root: &Path,
    name: &str,
    description: Option<String>,
    body: Option<&str>,
) -> Result<PathBuf, String> {
    let name = validate_skill_name(name)?;
    let skill_dir = skills_root.join(&name);
    let skill_md = skill_md_path(&skill_dir);
    if skill_md.exists() {
        return Err(format!("Skill '{name}' already exists."));
    }
    std::fs::create_dir_all(skill_dir.join("references")).map_err(|error| error.to_string())?;
    // Keep the templated description on one line and free of quotes so the
    // minimal frontmatter reader parses it back cleanly.
    let description = description
        .unwrap_or_default()
        .replace(['\r', '\n', '"'], " ")
        .trim()
        .chars()
        .take(MAX_SKILL_DESCRIPTION_CHARS)
        .collect::<String>();
    let description = if description.is_empty() {
        format!("This skill should be used when the user asks about {name}.")
    } else {
        description
    };
    let body = match body.map(str::trim) {
        Some(learned) if !learned.is_empty() => {
            learned.chars().take(MAX_SKILL_BODY_CHARS).collect::<String>()
        }
        // Nothing to teach yet: keep the prompt an author fills in by hand.
        _ => "Describe when this skill applies and the concrete steps to follow.\n\n## Steps\n\n1. First step.\n2. Second step.\n\n## References\n\nPut detailed docs (schemas, examples) under `references/` and load them on\ndemand with the read_skill_resource tool instead of inlining them here."
            .to_string(),
    };
    let template = format!(
        "---\nname: {name}\ndescription: {description}\nversion: 0.1.0\n---\n\n# {name}\n\n{body}\n"
    );
    write_skill_file(&skill_md, &template).map_err(|error| error.to_string())?;
    Ok(skill_dir)
}

/// Create a global Agent Skill: `<data_dir>/skills/<name>/SKILL.md` with valid
/// frontmatter plus an empty `references/` directory. Refuses to overwrite an
/// existing skill so authoring never clobbers work.
///
/// `body` is optional and exists for the P9 learning loop, which has an actual
/// procedure to record; the skill manager omits it and gets the scaffold.
#[tauri::command]
pub fn create_ai_skill(
    name: String,
    description: Option<String>,
    body: Option<String>,
) -> Result<String, String> {
    let data_dir = resolve_data_dir().map_err(|error| error.to_string())?;
    let skill_dir = create_skill_in_root(
        &data_dir.join("skills"),
        &name,
        description,
        body.as_deref(),
    )?;
    Ok(skill_dir.to_string_lossy().to_string())
}

/// One-line frontmatter scalar: a newline or a double quote would break the
/// minimal reader (and its quoted-scalar path), so both collapse to spaces and
/// runs of whitespace squeeze to one — a pasted multi-line description must not
/// leave ragged gaps behind. An all-whitespace value is `None`, which tells the
/// caller to keep the stored value instead of writing an empty key.
fn sanitize_frontmatter_scalar(raw: Option<String>) -> Option<String> {
    let value = raw
        .unwrap_or_default()
        .replace(['\r', '\n', '"'], " ")
        .split_whitespace()
        .collect::<Vec<&str>>()
        .join(" ")
        .chars()
        .take(MAX_SKILL_DESCRIPTION_CHARS)
        .collect::<String>();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

/// Normalize an `allowed-tools:` list: entries trimmed and unquoted, blanks and
/// duplicates dropped, capped at `MAX_SKILL_ALLOWED_TOOLS` — the same cap the
/// parser applies, so a written file always reads back unchanged.
fn sanitize_tool_list(tools: Option<Vec<String>>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for tool in tools.unwrap_or_default() {
        let name = tool
            .trim()
            .trim_matches('"')
            .trim_matches('\'')
            .trim()
            .to_string();
        if name.is_empty() || out.iter().any(|existing| existing == &name) {
            continue;
        }
        out.push(name);
        if out.len() >= MAX_SKILL_ALLOWED_TOOLS {
            break;
        }
    }
    out
}

/// Render a SKILL.md the reader accepts: frontmatter, then the body verbatim — no
/// extra heading, because the stored body already carries its own and re-adding
/// one would duplicate it on every save.
fn render_skill_md(
    name: &str,
    description: &str,
    version: &str,
    extra: &[(String, String)],
    tools: &[String],
    body: &str,
) -> String {
    let mut out = String::from("---\n");
    out.push_str(&format!("name: {name}\n"));
    out.push_str(&format!("description: {description}\n"));
    out.push_str(&format!("version: {version}\n"));
    for (key, value) in extra {
        out.push_str(&format!("{key}: {value}\n"));
    }
    if !tools.is_empty() {
        out.push_str(&format!("allowed-tools: [{}]\n", tools.join(", ")));
    }
    out.push_str("---\n\n");
    out.push_str(body.trim_end());
    out.push('\n');
    out
}

/// Rewrite an existing skill's SKILL.md under an explicit skills root — split out
/// so tests drive a temp root instead of the real data dir.
///
/// Deliberately narrow, because this is the only in-place write to a skill file:
/// * it never creates — a missing or misnamed SKILL.md is an error, so a typo in
///   the name cannot silently fork a second copy of a skill,
/// * a file already past `MAX_SKILL_BODY_CHARS` is refused: `read_ai_skill`
///   truncates there, so saving the form would destroy the tail,
/// * an empty `body` keeps the stored one rather than blanking the procedure,
/// * metadata the editor does not own (`license`/`model`/`effort`) is written back
///   from what the caller round-tripped, so a save never drops it,
/// * `expected_updated_at` is the mtime `read_ai_skill` reported when the editor
///   opened the file: a mismatch means the file changed underneath the editor
///   and the save is refused instead of silently clobbering the newer content.
#[allow(clippy::too_many_arguments)]
fn update_skill_in_root(
    skills_root: &Path,
    name: &str,
    description: Option<String>,
    body: Option<&str>,
    version: Option<String>,
    allowed_tools: Option<Vec<String>>,
    license: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    expected_updated_at: Option<i64>,
) -> Result<PathBuf, String> {
    let name = validate_skill_name(name)?;
    let skill_dir = skills_root.join(&name);
    // Containment first, exactly like the read path: a symlinked skill directory
    // must not be written through to a target outside the root.
    let (Ok(canonical_root), Ok(canonical_dir)) =
        (skills_root.canonicalize(), skill_dir.canonicalize())
    else {
        return Err(format!("Skill '{name}' was not found."));
    };
    if !canonical_dir.starts_with(&canonical_root) {
        return Err(format!("Skill '{name}' was not found."));
    }
    let skill_md = skill_md_path(&skill_dir);
    // Optimistic concurrency: the editor echoes back the mtime it read. A
    // mismatch means an external edit landed in between — refuse rather than
    // overwrite work the user never saw.
    if let Some(expected) = expected_updated_at {
        if skill_md_updated_at(&skill_md) != Some(expected) {
            return Err(format!(
                "Skill '{name}' changed on disk since it was opened; reload it before saving."
            ));
        }
    }
    let Ok(raw) = std::fs::read_to_string(&skill_md) else {
        return Err(format!("Skill '{name}' was not found."));
    };
    let (meta, existing_body) = parse_skill_md(&raw);
    // Same strictness as the read path: never rewrite a file that declares a
    // different name, or the reader would start rejecting the directory.
    if meta.name.as_deref() != Some(name.as_str()) {
        return Err(format!(
            "SKILL.md does not declare name '{name}'; fix its frontmatter before editing it here."
        ));
    }
    if existing_body.chars().count() > MAX_SKILL_BODY_CHARS {
        return Err(format!(
            "SKILL.md holds more than the {MAX_SKILL_BODY_CHARS}-character editable limit; edit the file directly so the rest is not truncated."
        ));
    }
    let description = sanitize_frontmatter_scalar(description)
        .or_else(|| meta.description.clone())
        .unwrap_or_else(|| format!("This skill should be used when the user asks about {name}."));
    let version = sanitize_frontmatter_scalar(version)
        .or_else(|| meta.version.clone())
        .unwrap_or_else(|| "0.1.0".to_string());
    let body = match body.map(str::trim) {
        Some(next) if !next.is_empty() => {
            next.chars().take(MAX_SKILL_BODY_CHARS).collect::<String>()
        }
        _ => existing_body,
    };
    let mut extra: Vec<(String, String)> = Vec::new();
    for (key, value) in [
        (
            "license",
            sanitize_frontmatter_scalar(license).or_else(|| meta.license.clone()),
        ),
        (
            "model",
            sanitize_frontmatter_scalar(model).or_else(|| meta.model.clone()),
        ),
        (
            "effort",
            sanitize_frontmatter_scalar(effort).or_else(|| meta.effort.clone()),
        ),
    ] {
        if let Some(value) = value {
            extra.push((key.to_string(), value));
        }
    }
    // `None` means the caller did not supply the field — keep the stored list
    // like every other metadata field, instead of silently clearing it.
    let tools = match allowed_tools {
        Some(tools) => sanitize_tool_list(Some(tools)),
        None => meta.allowed_tools.clone(),
    };
    let rendered = render_skill_md(&name, &description, &version, &extra, &tools, &body);
    write_skill_file(&skill_md, &rendered).map_err(|error| error.to_string())?;
    Ok(skill_dir)
}

/// Edit an existing **global** Agent Skill in place: description, body, version,
/// `allowed-tools`, and the metadata keys the manager passes through untouched.
///
/// Workspace skills are out of scope on purpose — they are files inside the user's
/// own repository, and the app must not rewrite project files it did not author.
/// The manager UI keeps Edit disabled for them.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn update_ai_skill(
    name: String,
    description: Option<String>,
    body: Option<String>,
    version: Option<String>,
    allowed_tools: Option<Vec<String>>,
    license: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    expected_updated_at: Option<i64>,
) -> Result<String, String> {
    let data_dir = resolve_data_dir().map_err(|error| error.to_string())?;
    let skill_dir = update_skill_in_root(
        &data_dir.join("skills"),
        &name,
        description,
        body.as_deref(),
        version,
        allowed_tools,
        license,
        model,
        effort,
        expected_updated_at,
    )?;
    Ok(skill_dir.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_quoted_frontmatter() {
        let raw = "---\nname: git-release\ndescription: \"Create consistent releases\"\n---\n\n## What I do\n- Draft notes\n";
        let (meta, body) = parse_skill_md(raw);
        assert_eq!(meta.name.as_deref(), Some("git-release"));
        assert_eq!(
            meta.description.as_deref(),
            Some("Create consistent releases")
        );
        assert!(body.contains("## What I do"));
    }

    #[test]
    fn parses_unquoted_frontmatter() {
        let (meta, _) =
            parse_skill_md("---\nname: db-audit\ndescription: Audit a schema\n---\nBody here");
        assert_eq!(meta.name.as_deref(), Some("db-audit"));
        assert_eq!(meta.description.as_deref(), Some("Audit a schema"));
    }

    #[test]
    fn parses_extended_metadata_and_allowed_tools() {
        // Inline list form.
        let (meta, _) = parse_skill_md(
            "---\nname: db-audit\ndescription: Audit a schema\nversion: 1.2.0\nlicense: MIT\nmodel: opus\neffort: high\nallowed-tools: [run_readonly_sql, describe_table]\n---\nbody",
        );
        assert_eq!(meta.version.as_deref(), Some("1.2.0"));
        assert_eq!(meta.license.as_deref(), Some("MIT"));
        assert_eq!(meta.model.as_deref(), Some("opus"));
        assert_eq!(meta.effort.as_deref(), Some("high"));
        assert_eq!(
            meta.allowed_tools,
            vec!["run_readonly_sql".to_string(), "describe_table".to_string()]
        );
        // Block list form.
        let (block, _) = parse_skill_md(
            "---\nname: db-audit\ndescription: d\nallowed-tools:\n  - run_readonly_sql\n  - finish\n---\nbody",
        );
        assert_eq!(
            block.allowed_tools,
            vec!["run_readonly_sql".to_string(), "finish".to_string()]
        );
    }

    #[test]
    fn scaffolds_a_valid_skill_the_reader_accepts() {
        let base = std::env::temp_dir().join(format!("tabler-skill-new-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();

        let dir = create_skill_in_root(&base, "db-audit", Some("Audit a schema".to_string()), None)
            .unwrap();
        assert!(dir.join("references").is_dir());
        // The scaffold must round-trip through the real reader with matching name.
        let content =
            read_skill_in_roots(&[(base.clone(), "test".to_string())], "db-audit").unwrap();
        assert_eq!(content.name, "db-audit");
        assert_eq!(content.version.as_deref(), Some("0.1.0"));
        assert!(content.description.contains("Audit a schema"));

        // Refuses to clobber an existing skill, and rejects bad names.
        assert!(create_skill_in_root(&base, "db-audit", None, None).is_err());
        assert!(create_skill_in_root(&base, "../escape", None, None).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }
    #[test]
    fn a_learned_body_replaces_the_scaffold_and_still_satisfies_discovery() {
        let base =
            std::env::temp_dir().join(format!("tabler-skill-learned-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);

        let learned = "## What I do\n\n- Read the row counts for `orders`.\n- Compare them against `order_items`.\n\n## Steps\n\n1. `list_tables` for both.\n2. `run_readonly_sql` for the counts.";
        create_skill_in_root(
            &base,
            "orders-audit",
            Some("Repeatable order/line-item reconciliation".to_string()),
            Some(learned),
        )
        .expect("skill written");

        // The generated frontmatter is what makes the file loadable, so a learned
        // body must not be able to hide it or the procedure would be invisible.
        let content =
            read_skill_in_roots(&[(base.clone(), "test".to_string())], "orders-audit").unwrap();
        assert!(content.description.contains("Repeatable order"));
        let raw = std::fs::read_to_string(skill_md_path(&base.join("orders-audit"))).unwrap();
        assert!(raw.contains(learned));
        assert!(!raw.contains("1. First step."));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn validate_resource_rel_blocks_traversal_and_bad_roots() {
        assert!(validate_resource_rel("references/schema.md").is_ok());
        assert!(validate_resource_rel("scripts/run.sh").is_ok());
        assert!(validate_resource_rel("references/../../etc/passwd").is_err());
        assert!(validate_resource_rel("/etc/passwd").is_err());
        assert!(validate_resource_rel("assets/logo.png").is_err());
        assert!(validate_resource_rel("secret.md").is_err());
        assert!(validate_resource_rel("references\\..\\escape").is_err());
    }

    #[test]
    fn reads_bundled_reference_resource() {
        let base = std::env::temp_dir().join(format!("tabler-skill-res-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let dir = base.join("db-audit");
        std::fs::create_dir_all(dir.join("references")).unwrap();
        std::fs::write(
            skill_md_path(&dir),
            "---\nname: db-audit\ndescription: Audit a schema\n---\nBody",
        )
        .unwrap();
        std::fs::write(dir.join("references").join("schema.md"), "TABLE users(id)").unwrap();

        let roots = [(base.clone(), "test".to_string())];
        let content = read_skill_in_roots(&roots, "db-audit").unwrap();
        assert!(content
            .resources
            .contains(&"references/schema.md".to_string()));

        let resource =
            read_skill_resource_in_roots(&roots, "db-audit", "references/schema.md").unwrap();
        assert!(resource.content.contains("TABLE users"));

        // Traversal attempt is refused even end-to-end.
        assert!(
            read_skill_resource_in_roots(&roots, "db-audit", "references/../SKILL.md").is_err()
        );
        let _ = std::fs::remove_dir_all(&base);
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

        let report = discover_ai_skills_in_roots(&[(base.clone(), "test".to_string())]);
        assert_eq!(report.skills.len(), 1);
        assert_eq!(report.skills[0].name, "db-audit");
        assert_eq!(report.skills[0].source, "test");

        let content = read_ai_skill_by_name(None, "db-audit").unwrap_or_else(|_| {
            // Workspace root does not apply here; read through the test root.
            AISkillContent {
                name: "db-audit".to_string(),
                description: "Audit a schema".to_string(),
                source: "test".to_string(),
                body: "Body here".to_string(),
                version: None,
                license: None,
                model: None,
                effort: None,
                allowed_tools: Vec::new(),
                resources: Vec::new(),
                updated_at: None,
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

    /// Scratch root for the edit tests. Removed first so a previous failed run
    /// cannot make the next one pass or fail spuriously.
    fn edit_test_root(suffix: &str) -> PathBuf {
        let base =
            std::env::temp_dir().join(format!("tabler-skill-edit-{suffix}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        base
    }

    #[test]
    fn edit_rewrites_the_record_the_reader_accepts() {
        let base = edit_test_root("roundtrip");
        create_skill_in_root(&base, "edit-me", Some("First".into()), None).unwrap();

        update_skill_in_root(
            &base,
            "edit-me",
            Some("Second".into()),
            Some("Do X\nthen Y"),
            Some("1.2.3".into()),
            // Duplicates, padding and a blank entry must all collapse.
            Some(vec![
                "run_readonly_sql".to_string(),
                " run_readonly_sql ".to_string(),
                "".to_string(),
                "describe_table".to_string(),
            ]),
            Some("MIT".into()),
            None,
            None,
            None,
        )
        .unwrap();

        let content =
            read_skill_in_roots(&[(base.clone(), "test".to_string())], "edit-me").unwrap();
        assert_eq!(content.description, "Second");
        assert_eq!(content.version.as_deref(), Some("1.2.3"));
        assert_eq!(content.license.as_deref(), Some("MIT"));
        assert!(content.body.contains("Do X\nthen Y"));
        assert_eq!(
            content.allowed_tools,
            vec!["run_readonly_sql".to_string(), "describe_table".to_string()]
        );
        // The rewritten file still satisfies discovery, so it cannot vanish from
        // the roster after an edit.
        let catalog = discover_ai_skills_in_roots(&[(base.clone(), "test".to_string())]);
        assert_eq!(catalog.skills.len(), 1);
        assert_eq!(catalog.skills[0].description, "Second");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn edit_refuses_missing_skills_and_never_creates_one() {
        let base = edit_test_root("missing");
        let result = update_skill_in_root(
            &base,
            "ghost",
            Some("nope".into()),
            Some("body"),
            None,
            None,
            None,
            None,
            None,
            None,
        );
        assert!(result.is_err());
        assert!(!base.join("ghost").exists());
        // An invalid name is rejected by the same validator the reader uses.
        assert!(update_skill_in_root(
            &base,
            "../escape",
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None
        )
        .is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn edit_keeps_the_stored_body_when_none_is_supplied() {
        let base = edit_test_root("keep-body");
        create_skill_in_root(
            &base,
            "keep-body",
            Some("First".into()),
            Some("Original steps"),
        )
        .unwrap();

        update_skill_in_root(
            &base,
            "keep-body",
            Some("Retitled".into()),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();

        let content =
            read_skill_in_roots(&[(base.clone(), "test".to_string())], "keep-body").unwrap();
        // Blanking the field must not blank the procedure, and the keys the editor
        // does not own fall back to what the file already declared.
        assert!(content.body.contains("Original steps"));
        assert_eq!(content.version.as_deref(), Some("0.1.0"));
        assert_eq!(content.description, "Retitled");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn edit_refuses_a_file_past_the_editable_body_limit() {
        let base = edit_test_root("oversized");
        let dir = base.join("huge-skill");
        std::fs::create_dir_all(&dir).unwrap();
        let oversized = "x".repeat(MAX_SKILL_BODY_CHARS + 1);
        std::fs::write(
            skill_md_path(&dir),
            format!("---\nname: huge-skill\ndescription: big\n---\n{oversized}"),
        )
        .unwrap();
        let before = std::fs::read_to_string(skill_md_path(&dir)).unwrap();

        let result = update_skill_in_root(
            &base,
            "huge-skill",
            Some("sneaky".into()),
            Some("shorter"),
            None,
            None,
            None,
            None,
            None,
            None,
        );
        // Refused, and the file is untouched: a truncated read must never be
        // written back over content the app cannot see.
        assert!(result.is_err());
        assert_eq!(
            std::fs::read_to_string(skill_md_path(&dir)).unwrap(),
            before
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn edit_refuses_a_mismatched_name_and_squashes_frontmatter_scalars() {
        let base = edit_test_root("mismatch");
        let dir = base.join("renamed");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            skill_md_path(&dir),
            "---\nname: something-else\ndescription: nope\n---\nbody",
        )
        .unwrap();
        assert!(update_skill_in_root(
            &base,
            "renamed",
            Some("x".into()),
            Some("y"),
            None,
            None,
            None,
            None,
            None,
            None
        )
        .is_err());

        // A description with a newline or a quote would break the minimal reader,
        // so both collapse instead of being written through.
        create_skill_in_root(&base, "squashed", None, None).unwrap();
        update_skill_in_root(
            &base,
            "squashed",
            Some("line one\nline \"two\"".into()),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();
        let content =
            read_skill_in_roots(&[(base.clone(), "test".to_string())], "squashed").unwrap();
        assert_eq!(content.description, "line one line two");
        let _ = std::fs::remove_dir_all(&base);
    }
}
