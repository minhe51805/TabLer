use serde::Serialize;
use std::path::{Path, PathBuf};

use crate::utils::paths::resolve_data_dir;

/// One remembered fact: MEMORY.md frontmatter only — the agent pulls the full
/// body on demand through `read_agent_memory` (progressive disclosure, same
/// contract as the skills catalog).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntrySummary {
    pub name: String,
    pub description: String,
    /// ISO-8601 last-write time. Freshness signal so agents (and users) can
    /// reason about how stale a memory is before trusting it.
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntryContent {
    pub name: String,
    pub description: String,
    pub updated_at: String,
    /// Full MEMORY.md body (frontmatter stripped) — injected as the tool result.
    pub body: String,
}

const MAX_MEMORY_DESCRIPTION_CHARS: usize = 200;
const MAX_MEMORY_ENTRIES: usize = 32;
const MAX_MEMORY_BODY_CHARS: usize = 8_000;
const MAX_MEMORY_NAME_CHARS: usize = 64;

/// Scope path components (connection id, database name) never travel raw into
/// the filesystem: allowlist ASCII identifiers so a hostile scope string
/// cannot traverse out of the memory root.
fn sanitize_scope_component(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.len() > MAX_MEMORY_NAME_CHARS
        || trimmed == "."
        || trimmed == ".."
    {
        return None;
    }
    let safe: String = trimmed
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if safe == "." || safe == ".." {
        return None;
    }
    Some(safe)
}

/// Memory lives per (connection, database) — exactly the glossary scope. A
/// different connection or database resolves to a different directory, so
/// cross-scope leakage is a directory-boundary property, not a filter.
fn memory_scope_dir(
    data_dir: &Path,
    connection_id: Option<&str>,
    database: Option<&str>,
) -> PathBuf {
    let connection = connection_id
        .and_then(sanitize_scope_component)
        .unwrap_or_else(|| "global".to_string());
    let database = database
        .and_then(sanitize_scope_component)
        .unwrap_or_else(|| "default".to_string());
    data_dir
        .join("agent-memory")
        .join(connection)
        .join(database)
}

/// Entry names are directory names: allowlist charset, forbid traversal so a
/// memory name can never point outside the memory root.
fn sanitize_memory_name(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Memory name must not be empty.".to_string());
    }
    if trimmed.len() > MAX_MEMORY_NAME_CHARS {
        return Err(format!(
            "Memory name exceeds {MAX_MEMORY_NAME_CHARS} characters."
        ));
    }
    if trimmed == "." || trimmed == ".." || trimmed.contains('/') || trimmed.contains('\\') {
        return Err("Memory name must not contain path separators.".to_string());
    }
    let ok = trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if !ok {
        return Err("Memory name may only contain letters, digits, '-', '_' and '.'.".to_string());
    }
    Ok(trimmed.to_string())
}

/// Same minimal frontmatter reader as skills, plus an `updated` timestamp key.
fn parse_memory_md(raw: &str) -> (Option<String>, Option<String>, Option<String>, String) {
    let trimmed = raw.trim_start();
    let rest = match trimmed.strip_prefix("---") {
        Some(rest) => rest,
        None => return (None, None, None, trimmed.to_string()),
    };
    let end = match rest.find("\n---") {
        Some(index) => index,
        None => return (None, None, None, trimmed.to_string()),
    };
    let frontmatter = &rest[..end];
    let body = rest[end + 4..].trim_start_matches(['\r', '\n']).to_string();
    let mut name = None;
    let mut description = None;
    let mut updated = None;
    for line in frontmatter.lines() {
        let line = line.trim();
        let read_value = |prefix: &str| -> Option<String> {
            let value = line.strip_prefix(prefix)?.trim();
            let unquoted = value.trim_matches('"').trim_matches('\'');
            Some(unquoted.trim().to_string())
        };
        name = name.or_else(|| read_value("name:"));
        description = description.or_else(|| read_value("description:"));
        updated = updated.or_else(|| read_value("updated:"));
    }
    // Keep the per-run index bounded: descriptions are injected for every
    // remembered entry on every agent run.
    let description =
        description.map(|value| value.chars().take(MAX_MEMORY_DESCRIPTION_CHARS).collect());
    (name, description, updated, body)
}

fn memory_md_path(dir: &Path) -> PathBuf {
    dir.join("MEMORY.md")
}

// __PART2__

/// Scan one memory scope for `<name>/MEMORY.md` directories. Silent drops are
/// logged (same rule as skills): a memory the agent cannot see must say why.
pub fn discover_memories_in_root(root: &Path) -> Vec<MemoryEntrySummary> {
    let mut summaries: Vec<MemoryEntrySummary> = Vec::new();
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => return summaries,
    };
    for entry in entries.flatten() {
        let dir_path = entry.path();
        let Ok(entry_type) = entry.file_type() else {
            continue;
        };
        // Symlinked memory directories are rejected: the body is read
        // server-side and injected into the model context.
        if !dir_path.is_dir() || entry_type.is_symlink() {
            log::warn!(
                "agent_memory: skipping non-directory or symlink entry '{}'",
                dir_path.display()
            );
            continue;
        }
        let Some(dir_name) = dir_path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        let file_path = memory_md_path(&dir_path);
        // A symlinked MEMORY.md file is an escape vector even when the
        // directory itself is real: reject before reading.
        let file_is_symlink = std::fs::symlink_metadata(&file_path)
            .map(|meta| meta.file_type().is_symlink())
            .unwrap_or(false);
        if file_is_symlink {
            log::warn!(
                "agent_memory: MEMORY.md is a symlink — rejecting '{}'",
                dir_path.display()
            );
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(&file_path) else {
            log::warn!("agent_memory: cannot read {}", file_path.display());
            continue;
        };
        let (parsed_name, parsed_description, parsed_updated, _) = parse_memory_md(&raw);
        // Same strictness as skills: name must equal the directory name.
        let Some(parsed_name) = parsed_name else {
            log::warn!(
                "agent_memory: '{}' has no frontmatter name — dropped",
                dir_name
            );
            continue;
        };
        if parsed_name != dir_name || parsed_name.len() > MAX_MEMORY_NAME_CHARS {
            log::warn!(
                "agent_memory: '{}' name/directory mismatch or too long — dropped",
                parsed_name
            );
            continue;
        }
        summaries.push(MemoryEntrySummary {
            name: parsed_name,
            description: parsed_description.unwrap_or_default(),
            updated_at: parsed_updated.unwrap_or_default(),
        });
    }
    summaries.sort_by(|left, right| left.name.cmp(&right.name));
    if summaries.len() > MAX_MEMORY_ENTRIES {
        log::warn!(
            "agent_memory: index view truncated from {} to {} entries — consider pruning memories",
            summaries.len(),
            MAX_MEMORY_ENTRIES
        );
        summaries.truncate(MAX_MEMORY_ENTRIES);
    }
    summaries
}

// __PART3__

#[derive(Clone)]
pub struct SaveMemoryParams {
    pub connection_id: Option<String>,
    pub database: Option<String>,
    pub name: String,
    pub description: Option<String>,
    pub body: String,
}

fn write_memory_file(dir: &Path, frontmatter: &str, body: &str) -> Result<(), String> {
    std::fs::create_dir_all(dir)
        .map_err(|error| format!("Failed to create memory directory: {error}"))?;
    let file_path = memory_md_path(dir);
    // Writing follows symlinks: a pre-existing MEMORY.md link would redirect
    // the write outside the scope. Refuse instead of overwriting through it.
    let target_is_symlink = std::fs::symlink_metadata(&file_path)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false);
    if target_is_symlink {
        return Err("Memory file is a symlink — refusing to write through it.".to_string());
    }
    let content = format!("---\n{frontmatter}---\n\n{body}");
    // Staging file + same-volume rename: a crash mid-write can never leave a
    // torn MEMORY.md behind (the previous file survives until the rename).
    let staging_path = file_path.with_extension("md.tmp");
    std::fs::write(&staging_path, &content)
        .map_err(|error| format!("Failed to write memory staging file: {error}"))?;
    std::fs::rename(&staging_path, &file_path)
        .map_err(|error| format!("Failed to finalize memory write: {error}"))
}

/// Upsert one memory entry in the (connection, database) scope. Same name =
/// overwrite with a fresh `updated` timestamp; index-full is a loud error,
/// never a silent drop (lesson from the 2.1.210/211 memory budget fixes).
pub fn save_memory_entry(params: SaveMemoryParams) -> Result<MemoryEntrySummary, String> {
    let data_dir = resolve_data_dir().map_err(|error| error.to_string())?;
    save_memory_entry_in(&data_dir, params)
}

pub fn save_memory_entry_in(
    data_dir: &Path,
    params: SaveMemoryParams,
) -> Result<MemoryEntrySummary, String> {
    let name = sanitize_memory_name(&params.name)?;
    let body = params.body.trim().to_string();
    if body.is_empty() {
        return Err("Memory body must not be empty.".to_string());
    }
    if body.chars().count() > MAX_MEMORY_BODY_CHARS {
        return Err(format!(
            "Memory body exceeds {MAX_MEMORY_BODY_CHARS} characters — split or shorten it."
        ));
    }
    // Frontmatter is line-delimited: a description carrying a newline could
    // inject fake keys (e.g. `updated:`) and forge the freshness signal.
    // Flatten to one line BEFORE the length cap.
    let description = params.description.map(|value| {
        value
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(MAX_MEMORY_DESCRIPTION_CHARS)
            .collect::<String>()
    });
    reject_secret_shaped_payload(&name, &body, &description)?;
    let scope = memory_scope_dir(
        &data_dir,
        params.connection_id.as_deref(),
        params.database.as_deref(),
    );
    let dir = scope.join(&name);
    // Defense in depth: the sanitized name is a plain path component, but the
    // resolved entry must still live directly inside its scope directory.
    if dir.parent() != Some(scope.as_path()) {
        return Err("Memory name escapes its scope directory.".to_string());
    }
    // Overwrite-vs-new is decided from the FILESYSTEM, not the (capped)
    // index view: an entry sitting past the display cap still exists and must
    // stay overwritable — reporting "full" for it was a dead end.
    let target_exists = dir.join("MEMORY.md").exists();
    if !target_exists && discover_memories_in_root(&scope).len() >= MAX_MEMORY_ENTRIES {
        return Err(format!(
            "Memory index for this scope is full ({MAX_MEMORY_ENTRIES} entries). Merge or remove an entry before saving a new one."
        ));
    }
    let now = chrono::Utc::now().to_rfc3339();
    let frontmatter = format!(
        "name: {name}\ndescription: {}\nupdated: {now}\n",
        description.as_deref().unwrap_or("")
    );
    write_memory_file(&dir, &frontmatter, &body)?;
    Ok(MemoryEntrySummary {
        name,
        description: description.unwrap_or_default(),
        updated_at: now,
    })
}

/// Removes one memory entry (directory + MEMORY.md). Without this, a full
/// index is a dead end: overwrite alone cannot reclaim obsolete slots and
/// users have no way to prune.
#[tauri::command]
pub fn delete_agent_memory(
    connection_id: Option<String>,
    database: Option<String>,
    name: String,
) -> Result<(), String> {
    let data_dir = resolve_data_dir().map_err(|error| error.to_string())?;
    delete_agent_memory_in(
        &data_dir,
        connection_id.as_deref(),
        database.as_deref(),
        &name,
    )
}

pub(super) fn delete_agent_memory_in(
    data_dir: &Path,
    connection_id: Option<&str>,
    database: Option<&str>,
    raw_name: &str,
) -> Result<(), String> {
    let name = sanitize_memory_name(raw_name)?;
    let scope = memory_scope_dir(data_dir, connection_id, database);
    let dir = scope.join(&name);
    if dir.parent() != Some(scope.as_path()) {
        return Err("Memory name escapes its scope directory.".to_string());
    }
    if !dir.exists() {
        return Err(format!("Memory '{name}' was not found in this scope."));
    }
    std::fs::remove_dir_all(&dir)
        .map_err(|error| format!("Failed to delete memory '{name}': {error}"))?;
    log::info!("agent_memory: deleted '{name}'");
    Ok(())
}

/// Load one memory entry: canonicalize-then-starts_with containment (catches
/// traversal AND symlink escape), strict name == directory, soft body ceiling.
fn read_memory_entry(
    connection_id: Option<&str>,
    database: Option<&str>,
    raw_name: &str,
) -> Result<MemoryEntryContent, String> {
    let data_dir = resolve_data_dir().map_err(|error| error.to_string())?;
    read_memory_entry_in(&data_dir, connection_id, database, raw_name)
}

fn read_memory_entry_in(
    data_dir: &Path,
    connection_id: Option<&str>,
    database: Option<&str>,
    raw_name: &str,
) -> Result<MemoryEntryContent, String> {
    let name = sanitize_memory_name(raw_name)?;
    let scope = memory_scope_dir(&data_dir, connection_id, database);
    let dir = scope.join(&name);
    let (Ok(canonical_scope), Ok(canonical_dir)) = (scope.canonicalize(), dir.canonicalize())
    else {
        return Err(format!("Memory '{name}' was not found in this scope."));
    };
    if !canonical_dir.starts_with(&canonical_scope) {
        return Err("Memory path escapes its scope directory.".to_string());
    }
    let file_path = memory_md_path(&dir);
    // Directory containment does not cover a symlinked MEMORY.md file:
    // read_to_string would follow it outside the scope. Canonicalize the
    // file itself and require containment.
    let Ok(canonical_file) = file_path.canonicalize() else {
        return Err(format!("Memory '{name}' was not found in this scope."));
    };
    if !canonical_file.starts_with(&canonical_scope) {
        return Err("Memory file escapes its scope directory.".to_string());
    }
    let raw = std::fs::read_to_string(&file_path)
        .map_err(|_| format!("Memory '{name}' was not found in this scope."))?;
    let (Some(parsed_name), parsed_description, parsed_updated, body) = parse_memory_md(&raw)
    else {
        return Err(format!(
            "Memory '{name}' has no frontmatter name — it cannot be loaded."
        ));
    };
    if parsed_name != name {
        return Err(format!(
            "Memory '{name}' declares a mismatched name '{parsed_name}'."
        ));
    }
    // Same soft cost ceiling as skills: the body is injected into the model
    // context, so an oversized file must not be re-billed on every run step.
    let body = if body.chars().count() > MAX_MEMORY_BODY_CHARS {
        let cut = body.chars().take(MAX_MEMORY_BODY_CHARS).collect::<String>();
        format!("{cut}\n\n[body truncated at {MAX_MEMORY_BODY_CHARS} characters — the memory file is larger]")
    } else {
        body
    };
    Ok(MemoryEntryContent {
        name: parsed_name,
        description: parsed_description.unwrap_or_default(),
        updated_at: parsed_updated.unwrap_or_default(),
        body,
    })
}

/// Secret-shaped payloads must never enter memory: credentials in the prompt
/// would be persisted verbatim and replayed into every future run's context.
const SECRET_PAYLOAD_PATTERNS: [(&str, &str); 8] = [
    ("password\\s*[:=]\\s*\\S+", "password"),
    ("passwd\\s*[:=]\\s*\\S+", "password"),
    ("pwd\\s*[:=]\\s*\\S+", "password"),
    ("ssh_password\\s*[:=]\\s*\\S+", "ssh password"),
    ("ssh_private_key\\s*[:=]\\s*\\S+", "ssh private key"),
    ("passphrase\\s*[:=]\\s*\\S+", "passphrase"),
    ("private[_-]?key\\s*[:=]\\s*\\S+", "private key"),
    ("api[_-]?key\\s*[:=]\\s*\\S+", "api key"),
];

fn reject_secret_shaped_payload(
    name: &str,
    body: &str,
    description: &Option<String>,
) -> Result<(), String> {
    let haystacks = [
        (name, "memory name"),
        (description.as_deref().unwrap_or(""), "memory description"),
        (body, "memory body"),
    ];
    let regexes = SECRET_PAYLOAD_PATTERNS
        .iter()
        .filter_map(|(pattern, label)| {
            regex::Regex::new(&format!("(?i){pattern}"))
                .ok()
                .map(|r| (r, *label))
        });
    for (text, where_label) in haystacks {
        for (regex, what) in regexes.clone() {
            if regex.is_match(text) {
                return Err(format!(
                    "Refusing to save: the {where_label} looks like it contains a {what}. Never store credentials in memory."
                ));
            }
        }
    }
    Ok(())
}

// __PART5__

#[tauri::command]
pub fn list_agent_memory(
    connection_id: Option<String>,
    database: Option<String>,
) -> Result<Vec<MemoryEntrySummary>, String> {
    let data_dir = resolve_data_dir().map_err(|error| error.to_string())?;
    let scope = memory_scope_dir(&data_dir, connection_id.as_deref(), database.as_deref());
    Ok(discover_memories_in_root(&scope))
}

#[tauri::command]
pub fn read_agent_memory(
    name: String,
    connection_id: Option<String>,
    database: Option<String>,
) -> Result<MemoryEntryContent, String> {
    read_memory_entry(connection_id.as_deref(), database.as_deref(), &name)
}

#[tauri::command]
pub fn save_agent_memory(
    name: String,
    body: String,
    connection_id: Option<String>,
    database: Option<String>,
    description: Option<String>,
) -> Result<MemoryEntrySummary, String> {
    save_memory_entry(SaveMemoryParams {
        connection_id,
        database,
        name,
        description,
        body,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_components_are_sanitized_and_isolated() {
        let base = Path::new("/data");
        let a = memory_scope_dir(base, Some("conn-1"), Some("appdb"));
        let b = memory_scope_dir(base, Some("conn-2"), Some("appdb"));
        let c = memory_scope_dir(base, Some("conn-1"), Some("other"));
        assert_ne!(a, b);
        assert_ne!(a, c);
        // Hostile scope strings cannot traverse: hostile characters are
        // flattened, so the path stays inside the memory root.
        assert_eq!(
            memory_scope_dir(base, Some("../../etc"), None),
            memory_scope_dir(base, Some("______etc"), None)
        );
        assert!(memory_scope_dir(base, None, None).ends_with("global/default"));
    }

    #[test]
    fn memory_names_reject_traversal_and_bad_charset() {
        assert!(sanitize_memory_name("metric-definitions").is_ok());
        assert!(sanitize_memory_name("../escape").is_err());
        assert!(sanitize_memory_name("..").is_err());
        assert!(sanitize_memory_name("").is_err());
        assert!(sanitize_memory_name("a/b").is_err());
        assert!(sanitize_memory_name("a\\b").is_err());
        assert!(sanitize_memory_name("has space").is_err());
        let long = "a".repeat(MAX_MEMORY_NAME_CHARS + 1);
        assert!(sanitize_memory_name(&long).is_err());
    }

    #[test]
    fn secret_shaped_payloads_are_rejected() {
        assert!(reject_secret_shaped_payload(
            "ok",
            "the reporting password: hunter2 is weak",
            &None
        )
        .is_err());
        assert!(reject_secret_shaped_payload(
            "ok",
            "config uses ssh_private_key = AAAAB3Nza...",
            &None
        )
        .is_err());
        assert!(reject_secret_shaped_payload("api_key: sk-123", "benign body", &None).is_err());
        assert!(
            reject_secret_shaped_payload("ok", "Just notes about quarterly revenue.", &None)
                .is_ok()
        );
    }

    #[test]
    fn frontmatter_roundtrip_and_description_cap() {
        let raw = "---\nname: metric-definitions\ndescription: curated metric semantics\nupdated: 2026-01-01T00:00:00Z\n---\n\nbody text";
        let (name, description, updated, body) = parse_memory_md(raw);
        assert_eq!(name.as_deref(), Some("metric-definitions"));
        assert_eq!(description.as_deref(), Some("curated metric semantics"));
        assert_eq!(updated.as_deref(), Some("2026-01-01T00:00:00Z"));
        assert_eq!(body.trim(), "body text");
        let long = format!("---\nname: n\ndescription: {}\n---\nbody", "x".repeat(500));
        let (_, capped, _, _) = parse_memory_md(&long);
        assert_eq!(
            capped.unwrap().chars().count(),
            MAX_MEMORY_DESCRIPTION_CHARS
        );
    }

    #[test]
    fn discover_index_skips_mismatched_names_and_carries_timestamp() {
        let base = std::env::temp_dir().join(format!("tabler-mem-disc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let scope = base.join("conn-1").join("appdb");
        let good = scope.join("metric-definitions");
        std::fs::create_dir_all(&good).unwrap();
        std::fs::write(
            memory_md_path(&good),
            "---\nname: metric-definitions\ndescription: metrics\nupdated: 2026-01-01T00:00:00Z\n---\n\nrevenue = net sales",
        )
        .unwrap();
        let bad = scope.join("mismatched");
        std::fs::create_dir_all(&bad).unwrap();
        std::fs::write(
            memory_md_path(&bad),
            "---\nname: other\ndescription: x\n---\nbody",
        )
        .unwrap();
        let found = discover_memories_in_root(&scope);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "metric-definitions");
        assert_eq!(found[0].updated_at, "2026-01-01T00:00:00Z");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn caps_are_bounded() {
        assert_eq!(MAX_MEMORY_ENTRIES, 32);
        assert_eq!(MAX_MEMORY_DESCRIPTION_CHARS, 200);
        assert_eq!(MAX_MEMORY_BODY_CHARS, 8_000);
    }

    #[test]
    fn save_discover_read_roundtrip_is_scope_faithful() {
        // Full write→index→read cycle against a temp data dir: the write path
        // was previously unpinned, so a regression here would go unnoticed.
        let base =
            std::env::temp_dir().join(format!("tabler-mem-roundtrip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let params = SaveMemoryParams {
            connection_id: Some("conn-9".to_string()),
            database: Some("appdb".to_string()),
            name: "metric-definitions".to_string(),
            description: Some("curated metrics".to_string()),
            body: "revenue = net sales minus refunds".to_string(),
        };
        let saved = save_memory_entry_in(&base, params.clone()).unwrap();
        assert_eq!(saved.name, "metric-definitions");
        assert!(!saved.updated_at.is_empty());
        let scope = memory_scope_dir(&base, Some("conn-9"), Some("appdb"));
        assert_eq!(discover_memories_in_root(&scope).len(), 1);
        let content =
            read_memory_entry_in(&base, Some("conn-9"), Some("appdb"), "metric-definitions")
                .unwrap();
        assert_eq!(content.body.trim(), "revenue = net sales minus refunds");
        assert_eq!(content.updated_at, saved.updated_at);
        // Upsert by name: no duplicate entry, fresh body and timestamp win.
        let updated = save_memory_entry_in(
            &base,
            SaveMemoryParams {
                body: "revenue = net sales".to_string(),
                ..params
            },
        )
        .unwrap();
        assert_eq!(discover_memories_in_root(&scope).len(), 1);
        let refreshed =
            read_memory_entry_in(&base, Some("conn-9"), Some("appdb"), "metric-definitions")
                .unwrap();
        assert_eq!(refreshed.body.trim(), "revenue = net sales");
        assert_eq!(refreshed.updated_at, updated.updated_at);
        // A sibling database scope must not see the entry.
        assert!(
            discover_memories_in_root(&memory_scope_dir(&base, Some("conn-9"), Some("other")))
                .is_empty()
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn description_newlines_cannot_inject_frontmatter_keys() {
        let base = std::env::temp_dir().join(format!("tabler-mem-inject-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let saved = save_memory_entry_in(
            &base,
            SaveMemoryParams {
                connection_id: Some("conn-x".to_string()),
                database: Some("db".to_string()),
                name: "injection-probe".to_string(),
                description: Some(
                    "harmless text\nupdated: 1999-01-01T00:00:00Z\npoisoned: yes".to_string(),
                ),
                body: "body".to_string(),
            },
        )
        .unwrap();
        assert!(!saved.description.contains('\n'));
        let scope = memory_scope_dir(&base, Some("conn-x"), Some("db"));
        let raw = std::fs::read_to_string(scope.join("injection-probe").join("MEMORY.md")).unwrap();
        let (_, parsed_description, parsed_updated, _) = parse_memory_md(&raw);
        // The forged timestamp must NOT win — the real write time survives,
        // and no injected line exists as a standalone frontmatter key.
        assert_eq!(parsed_updated.as_deref(), Some(saved.updated_at.as_str()));
        for line in raw.lines() {
            assert!(
                !line.starts_with("updated: 1999") && !line.starts_with("poisoned:"),
                "forged frontmatter key leaked: {line}"
            );
        }
        assert!(parsed_description
            .unwrap()
            .starts_with("harmless text updated: 1999"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn overwrite_works_even_when_entry_sits_past_the_truncated_index() {
        let base = std::env::temp_dir().join(format!("tabler-mem-mask-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let make_params = |name: String| SaveMemoryParams {
            connection_id: Some("conn".to_string()),
            database: Some("db".to_string()),
            name,
            description: None,
            body: "body".to_string(),
        };
        for index in 0..MAX_MEMORY_ENTRIES {
            save_memory_entry_in(&base, make_params(format!("mem-{index:02}"))).unwrap();
        }
        // A 33rd file exists on disk but is cut from the capped index view —
        // saving into it must OVERWRITE, not be misreported as "index full".
        let masked = save_memory_entry_in(&base, make_params("mem-33".to_string()));
        assert!(
            masked.is_err(),
            "a genuinely NEW entry past the cap must still be refused"
        );
        assert!(masked.unwrap_err().contains("full"));
        let scope = memory_scope_dir(&base, Some("conn"), Some("db"));
        let dir33 = scope.join("mem-33");
        std::fs::create_dir_all(&dir33).unwrap();
        std::fs::write(
            memory_md_path(&dir33),
            "---\nname: mem-33\ndescription: masked\nupdated: 2020-01-01T00:00:00Z\n---\n\nold body",
        )
        .unwrap();
        let overwrite = save_memory_entry_in(&base, make_params("mem-33".to_string())).unwrap();
        assert_eq!(overwrite.name, "mem-33");
        let content = read_memory_entry_in(&base, Some("conn"), Some("db"), "mem-33").unwrap();
        assert_eq!(content.body.trim(), "body");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn delete_removes_the_entry_and_reports_missing() {
        let base = std::env::temp_dir().join(format!("tabler-mem-del-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        save_memory_entry_in(
            &base,
            SaveMemoryParams {
                connection_id: Some("conn".to_string()),
                database: Some("db".to_string()),
                name: "obsolete".to_string(),
                description: None,
                body: "stale".to_string(),
            },
        )
        .unwrap();
        delete_agent_memory_in(&base, Some("conn"), Some("db"), "obsolete").unwrap();
        let scope = memory_scope_dir(&base, Some("conn"), Some("db"));
        assert!(discover_memories_in_root(&scope).is_empty());
        assert!(delete_agent_memory_in(&base, Some("conn"), Some("db"), "obsolete").is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn save_leaves_no_staging_files_behind() {
        let base = std::env::temp_dir().join(format!("tabler-mem-atomic-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        save_memory_entry_in(
            &base,
            SaveMemoryParams {
                connection_id: Some("conn".to_string()),
                database: Some("db".to_string()),
                name: "atomic".to_string(),
                description: None,
                body: "body".to_string(),
            },
        )
        .unwrap();
        let scope = memory_scope_dir(&base, Some("conn"), Some("db"));
        let staging: Vec<_> = std::fs::read_dir(&scope)
            .unwrap()
            .flatten()
            .filter(|entry| entry.path().extension().map_or(false, |ext| ext == "tmp"))
            .collect();
        assert!(staging.is_empty());
        let _ = std::fs::remove_dir_all(&base);
    }
}
