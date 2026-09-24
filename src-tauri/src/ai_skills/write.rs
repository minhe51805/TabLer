use std::path::{Path, PathBuf};

use crate::utils::paths::resolve_data_dir;

use super::parse::{parse_skill_md, skill_md_path, skill_md_updated_at};
use super::types::{MAX_SKILL_ALLOWED_TOOLS, MAX_SKILL_BODY_CHARS, MAX_SKILL_DESCRIPTION_CHARS};
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
pub(crate) fn create_skill_in_root(
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
pub(crate) fn update_skill_in_root(
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

/// Delete a **global** Agent Skill: removes `<data_dir>/skills/<name>/`
/// entirely — SKILL.md plus any references/scripts the bundle carries.
///
/// Same containment contract as the update path: the name is validated and the
/// canonical directory must live under the global skills root, so a symlinked
/// or traversal-named entry cannot delete outside it. Workspace skills are out
/// of scope — they are files inside the user's own repository, and the app
/// must not delete project files it did not author.
#[tauri::command]
pub fn delete_ai_skill(name: String) -> Result<(), String> {
    let name = validate_skill_name(&name)?;
    let data_dir = resolve_data_dir().map_err(|error| error.to_string())?;
    let skills_root = data_dir.join("skills");
    let skill_dir = skills_root.join(&name);
    let (Ok(canonical_root), Ok(canonical_dir)) =
        (skills_root.canonicalize(), skill_dir.canonicalize())
    else {
        return Err(format!("Skill '{name}' was not found."));
    };
    if !canonical_dir.starts_with(&canonical_root) {
        return Err(format!("Skill '{name}' was not found."));
    }
    std::fs::remove_dir_all(&canonical_dir).map_err(|error| error.to_string())
}
