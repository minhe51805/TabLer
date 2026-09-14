//! Backend for Anthropic's *native* client-side memory tool (`memory_20250818`).
//!
//! Unlike the durable MEMORY.md store in [`crate::agent_memory`] (a bounded,
//! per-entry index the agent reads/writes through the `save_memory`/
//! `read_memory` actions), the native tool is a general **file tree** that
//! Claude drives itself with six filesystem commands (`view`, `create`,
//! `str_replace`, `insert`, `delete`, `rename`) against a virtual `/memories`
//! root. We map that root into a sandboxed, per-(connection, database)
//! directory so a model can never touch anything outside its own scope.
//!
//! Security posture mirrors `agent_memory`:
//! * scope components are sanitized through the SAME allowlist, so the native
//!   tree is isolated per connection+database exactly like the glossary/memory;
//! * every path is validated component-by-component (no empty/`.`/`..`, tight
//!   charset) so it is *lexically* contained, then re-checked with a
//!   canonicalize + `starts_with` containment test so a planted symlink cannot
//!   redirect a read/write/delete outside the sandbox.
//!
//! Anthropic-only: the tool block `{ "type": "memory_20250818", "name":
//! "memory" }` is declared solely on Anthropic requests (see the frontend
//! tool catalog), so no other provider ever reaches this command.

use std::path::{Component, Path, PathBuf};

use crate::agent_memory::sanitize_scope_component;
use crate::utils::paths::resolve_data_dir;

/// Root folder (under the app data dir) that holds every scope's native
/// memory tree. Kept separate from `agent-memory/` so the native file tree and
/// the MEMORY.md index store never collide.
const NATIVE_MEMORY_ROOT: &str = "agent-memory-native";
/// The single virtual root Claude addresses. Every path the model sends must
/// live under this prefix; it maps to the per-scope sandbox directory.
const VIRTUAL_ROOT: &str = "memories";
/// Hard ceiling on a single memory file, so a runaway `create`/`insert` cannot
/// fill the disk or blow up the next request's token budget when viewed.
const MAX_FILE_BYTES: usize = 64_000;
/// Ceiling on how much a single `view` returns, so listing/reading stays cheap
/// to feed back as a tool_result.
const MAX_VIEW_CHARS: usize = 16_000;
/// Bound on path depth so a hostile model cannot create pathological trees.
const MAX_PATH_DEPTH: usize = 16;
/// Bound on one path segment's length (file/dir name).
const MAX_SEGMENT_CHARS: usize = 96;

/// A single decoded memory command. Built from the `tool_use.input` object the
/// model emits; kept as an enum so the executor is a total match and an unknown
/// command is a loud error rather than a silent no-op.
#[derive(Debug, Clone)]
pub enum MemoryCommand {
    View {
        path: String,
        view_range: Option<(i64, i64)>,
    },
    Create {
        path: String,
        file_text: String,
    },
    StrReplace {
        path: String,
        old_str: String,
        new_str: String,
    },
    Insert {
        path: String,
        insert_line: usize,
        insert_text: String,
    },
    Delete {
        path: String,
    },
    Rename {
        old_path: String,
        new_path: String,
    },
}

/// Split a virtual path into validated segments *below* the `/memories` root.
///
/// Returns the segments after `memories` (empty `Vec` = the root itself).
/// Rejects anything that could escape the sandbox lexically: absolute drives,
/// `.`/`..`, empty segments, path separators inside a segment, or a bad
/// charset. The charset (`A-Za-z0-9 . _ -`) is deliberately tight — memory
/// files are agent-authored notes, not arbitrary binaries.
fn virtual_segments(raw: &str) -> Result<Vec<String>, String> {
    let normalized = raw.trim().replace('\\', "/");
    if normalized.is_empty() {
        return Err("Path must not be empty; use /memories or a path under it.".to_string());
    }
    let mut parts = normalized
        .split('/')
        .filter(|segment| !segment.is_empty())
        .peekable();

    match parts.peek() {
        Some(&first) if first == VIRTUAL_ROOT => {
            parts.next();
        }
        _ => {
            return Err(format!("Path must start with /{VIRTUAL_ROOT} (got '{raw}')."));
        }
    }

    let mut segments: Vec<String> = Vec::new();
    for segment in parts {
        if segment == "." || segment == ".." {
            return Err("Path must not contain '.' or '..' segments.".to_string());
        }
        if segment.len() > MAX_SEGMENT_CHARS {
            return Err(format!(
                "Path segment '{segment}' exceeds {MAX_SEGMENT_CHARS} characters."
            ));
        }
        let ok = segment
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ' '));
        if !ok {
            return Err(format!(
                "Path segment '{segment}' may only contain letters, digits, space, '.', '_' and '-'."
            ));
        }
        segments.push(segment.to_string());
    }
    if segments.len() > MAX_PATH_DEPTH {
        return Err(format!(
            "Path is too deep (max {MAX_PATH_DEPTH} levels under /{VIRTUAL_ROOT})."
        ));
    }
    Ok(segments)
}

/// A pretty, always-`/memories`-rooted display path for tool_result strings, so
/// the model sees back exactly the virtual namespace it addressed.
fn display_path(segments: &[String]) -> String {
    if segments.is_empty() {
        format!("/{VIRTUAL_ROOT}")
    } else {
        format!("/{VIRTUAL_ROOT}/{}", segments.join("/"))
    }
}

/// Confirm the resolved path cannot escape the sandbox even via a symlink: the
/// deepest ancestor that exists must canonicalize to inside `root`. We rely on
/// [`virtual_segments`] for lexical safety and this for symlink safety.
fn assert_contained(root: &Path, target: &Path) -> Result<(), String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("Cannot resolve memory root: {error}"))?;
    // Walk up to the nearest existing ancestor; canonicalize resolves any
    // symlink component along the way.
    let mut probe = target;
    loop {
        if let Ok(canonical) = probe.canonicalize() {
            if !canonical.starts_with(&canonical_root) {
                return Err("Path escapes the /memories sandbox.".to_string());
            }
            return Ok(());
        }
        match probe.parent() {
            Some(parent) if parent.starts_with(root) || parent == root => probe = parent,
            _ => {
                // Should be unreachable: `root` itself always canonicalizes.
                return Err("Path escapes the /memories sandbox.".to_string());
            }
        }
    }
}

/// Resolve a validated virtual path to a real filesystem path inside `root`.
/// `must_exist` distinguishes read/edit targets (must be present) from
/// create/rename destinations (may be new).
fn resolve_path(
    root: &Path,
    raw: &str,
    must_exist: bool,
) -> Result<(PathBuf, Vec<String>), String> {
    let segments = virtual_segments(raw)?;
    let mut target = root.to_path_buf();
    for segment in &segments {
        target.push(segment);
    }
    // Defense in depth: no non-normal components survived segment validation.
    debug_assert!(target
        .components()
        .all(|component| !matches!(component, Component::ParentDir)));
    assert_contained(root, &target)?;
    if must_exist && !target.exists() {
        return Err(format!("No such memory path: {}", display_path(&segments)));
    }
    Ok((target, segments))
}

fn ensure_size_ok(text: &str) -> Result<(), String> {
    if text.len() > MAX_FILE_BYTES {
        return Err(format!(
            "Memory file would exceed the {MAX_FILE_BYTES}-byte limit; split it or store less."
        ));
    }
    Ok(())
}


/// List a directory as a stable, sorted tree fragment for `view`.
fn render_directory(dir: &Path, segments: &[String]) -> Result<String, String> {
    let mut names: Vec<(String, bool)> = Vec::new();
    let entries =
        std::fs::read_dir(dir).map_err(|error| format!("Failed to list directory: {error}"))?;
    for entry in entries.flatten() {
        // Skip symlinks in listings: the body is fed to the model, and a
        // symlink is an escape vector we already refuse to traverse.
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        names.push((name, file_type.is_dir()));
    }
    names.sort_by(|a, b| a.0.cmp(&b.0));
    let mut out = format!("Directory {}:\n", display_path(segments));
    if names.is_empty() {
        out.push_str("(empty)");
    } else {
        for (name, is_dir) in names {
            if is_dir {
                out.push_str(&format!("- {name}/\n"));
            } else {
                out.push_str(&format!("- {name}\n"));
            }
        }
    }
    Ok(out.trim_end().to_string())
}

/// Read a file for `view`, optionally sliced to a 1-based inclusive line range
/// (`[start, end]`; `end == -1` means "to end of file"), then clamped to
/// [`MAX_VIEW_CHARS`].
fn render_file(path: &Path, view_range: Option<(i64, i64)>) -> Result<String, String> {
    let contents =
        std::fs::read_to_string(path).map_err(|error| format!("Failed to read file: {error}"))?;
    let sliced = match view_range {
        None => contents,
        Some((start, end)) => {
            let lines: Vec<&str> = contents.lines().collect();
            let total = lines.len() as i64;
            if start < 1 {
                return Err("view_range start must be >= 1.".to_string());
            }
            let end = if end == -1 { total } else { end };
            if end < start {
                return Err(
                    "view_range end must be >= start (or -1 for end of file).".to_string(),
                );
            }
            let start_idx = (start - 1).min(total) as usize;
            let end_idx = end.min(total).max(0) as usize;
            lines[start_idx..end_idx].join("\n")
        }
    };
    if sliced.len() > MAX_VIEW_CHARS {
        let mut clamped: String = sliced.chars().take(MAX_VIEW_CHARS).collect();
        clamped.push_str("\n… (truncated)");
        Ok(clamped)
    } else {
        Ok(sliced)
    }
}

/// Crash-safe write: stage to a sibling temp file, then rename over the target
/// (same-volume atomic), refusing to write *through* a pre-existing symlink.
fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    let target_is_symlink = std::fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false);
    if target_is_symlink {
        return Err("Target is a symlink — refusing to write through it.".to_string());
    }
    let staging = path.with_extension("memtmp");
    std::fs::write(&staging, contents)
        .map_err(|error| format!("Failed to write staging file: {error}"))?;
    if let Err(rename_error) = std::fs::rename(&staging, path) {
        let _ = std::fs::remove_file(&staging);
        return Err(format!("Failed to finalize write: {rename_error}"));
    }
    Ok(())
}


/// Execute one memory command against the sandbox `root`. Pure over the
/// filesystem (no Tauri, no global data dir) so it is unit-testable with a
/// temp directory. Returns the tool_result string on success; `Err` carries a
/// model-facing message the caller surfaces as an `is_error` tool_result.
pub fn execute_memory_command_in(root: &Path, command: &MemoryCommand) -> Result<String, String> {
    std::fs::create_dir_all(root)
        .map_err(|error| format!("Failed to create memory root: {error}"))?;

    match command {
        MemoryCommand::View { path, view_range } => {
            let (target, segments) = resolve_path(root, path, true)?;
            if target.is_dir() {
                render_directory(&target, &segments)
            } else {
                render_file(&target, *view_range)
            }
        }
        MemoryCommand::Create { path, file_text } => {
            ensure_size_ok(file_text)?;
            let (target, segments) = resolve_path(root, path, false)?;
            if target.is_dir() {
                return Err(format!(
                    "{} is a directory; choose a file path.",
                    display_path(&segments)
                ));
            }
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|error| format!("Failed to create parent directory: {error}"))?;
            }
            write_atomic(&target, file_text)?;
            Ok(format!(
                "File created successfully at {}",
                display_path(&segments)
            ))
        }
        MemoryCommand::StrReplace {
            path,
            old_str,
            new_str,
        } => {
            let (target, segments) = resolve_path(root, path, true)?;
            let contents = std::fs::read_to_string(&target)
                .map_err(|error| format!("Failed to read file: {error}"))?;
            let matches = contents.matches(old_str.as_str()).count();
            if matches == 0 {
                return Err(format!(
                    "old_str was not found in {}; nothing was changed.",
                    display_path(&segments)
                ));
            }
            if matches > 1 {
                return Err(format!(
                    "old_str is not unique in {} ({matches} matches); include more surrounding context.",
                    display_path(&segments)
                ));
            }
            let updated = contents.replacen(old_str.as_str(), new_str.as_str(), 1);
            ensure_size_ok(&updated)?;
            write_atomic(&target, &updated)?;
            Ok(format!("File {} has been edited.", display_path(&segments)))
        }
        MemoryCommand::Insert {
            path,
            insert_line,
            insert_text,
        } => {
            let (target, segments) = resolve_path(root, path, true)?;
            let contents = std::fs::read_to_string(&target)
                .map_err(|error| format!("Failed to read file: {error}"))?;
            let mut lines: Vec<String> = contents.lines().map(str::to_string).collect();
            if *insert_line > lines.len() {
                return Err(format!(
                    "insert_line {} is past the end of {} ({} lines).",
                    insert_line,
                    display_path(&segments),
                    lines.len()
                ));
            }
            // Line 0 = beginning of file; N = after the Nth line.
            let inserted: Vec<String> = insert_text.split('\n').map(str::to_string).collect();
            for (offset, line) in inserted.into_iter().enumerate() {
                lines.insert(*insert_line + offset, line);
            }
            let updated = lines.join("\n");
            ensure_size_ok(&updated)?;
            write_atomic(&target, &updated)?;
            Ok(format!("File {} has been edited.", display_path(&segments)))
        }

        MemoryCommand::Delete { path } => {
            let (target, segments) = resolve_path(root, path, true)?;
            if segments.is_empty() {
                return Err("Refusing to delete the /memories root itself.".to_string());
            }
            // Never traverse a symlinked entry when deleting; remove the link
            // itself if one is present (same policy as agent_memory).
            let meta = std::fs::symlink_metadata(&target)
                .map_err(|error| format!("Failed to stat path: {error}"))?;
            if meta.file_type().is_symlink() {
                std::fs::remove_file(&target)
                    .or_else(|_| std::fs::remove_dir(&target))
                    .map_err(|error| format!("Failed to remove symlink: {error}"))?;
            } else if target.is_dir() {
                std::fs::remove_dir_all(&target)
                    .map_err(|error| format!("Failed to delete directory: {error}"))?;
            } else {
                std::fs::remove_file(&target)
                    .map_err(|error| format!("Failed to delete file: {error}"))?;
            }
            Ok(format!("Deleted {}.", display_path(&segments)))
        }
        MemoryCommand::Rename { old_path, new_path } => {
            let (from, from_segments) = resolve_path(root, old_path, true)?;
            let (to, to_segments) = resolve_path(root, new_path, false)?;
            if from_segments.is_empty() || to_segments.is_empty() {
                return Err("Cannot rename the /memories root itself.".to_string());
            }
            if to.exists() {
                return Err(format!(
                    "{} already exists; delete it first or choose another name.",
                    display_path(&to_segments)
                ));
            }
            if let Some(parent) = to.parent() {
                std::fs::create_dir_all(parent).map_err(|error| {
                    format!("Failed to create destination directory: {error}")
                })?;
            }
            std::fs::rename(&from, &to).map_err(|error| format!("Failed to rename: {error}"))?;
            Ok(format!(
                "Renamed {} to {}.",
                display_path(&from_segments),
                display_path(&to_segments)
            ))
        }
    }
}


/// Per-(connection, database) sandbox root for the native memory tree. Uses the
/// SAME scope sanitizer as [`crate::agent_memory`], so the native tree is
/// isolated on identical boundaries to the glossary/MEMORY.md store.
fn native_scope_root(
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
        .join(NATIVE_MEMORY_ROOT)
        .join(connection)
        .join(database)
}

/// Build a [`MemoryCommand`] from the loose fields of a `memory` tool_use input.
/// Missing-required-field errors are model-facing so Claude can self-correct.
#[allow(clippy::too_many_arguments)]
fn build_command(
    command: &str,
    path: Option<String>,
    file_text: Option<String>,
    old_str: Option<String>,
    new_str: Option<String>,
    insert_line: Option<usize>,
    insert_text: Option<String>,
    old_path: Option<String>,
    new_path: Option<String>,
    view_range: Option<Vec<i64>>,
) -> Result<MemoryCommand, String> {
    let require = |value: Option<String>, field: &str| {
        value.ok_or_else(|| format!("The '{command}' command requires '{field}'."))
    };
    match command {
        "view" => {
            let range = match view_range {
                None => None,
                Some(values) => {
                    if values.len() != 2 {
                        return Err("view_range must be [start, end].".to_string());
                    }
                    Some((values[0], values[1]))
                }
            };
            Ok(MemoryCommand::View {
                path: require(path, "path")?,
                view_range: range,
            })
        }
        "create" => Ok(MemoryCommand::Create {
            path: require(path, "path")?,
            file_text: require(file_text, "file_text")?,
        }),
        "str_replace" => Ok(MemoryCommand::StrReplace {
            path: require(path, "path")?,
            old_str: require(old_str, "old_str")?,
            new_str: new_str.unwrap_or_default(),
        }),
        "insert" => Ok(MemoryCommand::Insert {
            path: require(path, "path")?,
            insert_line: insert_line
                .ok_or_else(|| "The 'insert' command requires 'insert_line'.".to_string())?,
            // Anthropic uses `insert_text`; accept `new_str` as a fallback.
            insert_text: insert_text
                .or(new_str)
                .ok_or_else(|| "The 'insert' command requires 'insert_text'.".to_string())?,
        }),
        "delete" => Ok(MemoryCommand::Delete {
            path: require(path, "path")?,
        }),
        "rename" => Ok(MemoryCommand::Rename {
            old_path: require(old_path, "old_path")?,
            new_path: require(new_path, "new_path")?,
        }),
        other => Err(format!(
            "Unknown memory command '{other}'. Expected view, create, str_replace, insert, delete or rename."
        )),
    }
}

/// Tauri entry point for the native Anthropic memory tool. The frontend maps a
/// `memory` tool_use (name == "memory") to this command, spreading the input
/// fields plus the current connection/database scope, and feeds the returned
/// string back as the tool_result (or as an `is_error` result on `Err`).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn run_agent_memory_tool(
    command: String,
    path: Option<String>,
    file_text: Option<String>,
    old_str: Option<String>,
    new_str: Option<String>,
    insert_line: Option<usize>,
    insert_text: Option<String>,
    old_path: Option<String>,
    new_path: Option<String>,
    view_range: Option<Vec<i64>>,
    connection_id: Option<String>,
    database: Option<String>,
) -> Result<String, String> {
    let parsed = build_command(
        &command,
        path,
        file_text,
        old_str,
        new_str,
        insert_line,
        insert_text,
        old_path,
        new_path,
        view_range,
    )?;
    let data_dir = resolve_data_dir().map_err(|error| error.to_string())?;
    let root = native_scope_root(&data_dir, connection_id.as_deref(), database.as_deref());
    execute_memory_command_in(&root, &parsed)
}


#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        let mut dir = std::env::temp_dir();
        let unique = format!(
            "tabler-native-mem-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        dir.push(unique);
        dir
    }

    fn run(root: &Path, cmd: MemoryCommand) -> Result<String, String> {
        execute_memory_command_in(root, &cmd)
    }

    #[test]
    fn view_empty_root_reports_empty() {
        let root = temp_root();
        let out = run(
            &root,
            MemoryCommand::View {
                path: "/memories".to_string(),
                view_range: None,
            },
        )
        .unwrap();
        assert!(out.contains("Directory /memories"));
        assert!(out.contains("(empty)"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn create_view_and_edit_roundtrip() {
        let root = temp_root();
        run(
            &root,
            MemoryCommand::Create {
                path: "/memories/notes.md".to_string(),
                file_text: "# Notes\nDraft line\n".to_string(),
            },
        )
        .unwrap();

        let listing = run(
            &root,
            MemoryCommand::View {
                path: "/memories".to_string(),
                view_range: None,
            },
        )
        .unwrap();
        assert!(listing.contains("- notes.md"));

        let body = run(
            &root,
            MemoryCommand::View {
                path: "/memories/notes.md".to_string(),
                view_range: None,
            },
        )
        .unwrap();
        assert!(body.contains("Draft line"));

        run(
            &root,
            MemoryCommand::StrReplace {
                path: "/memories/notes.md".to_string(),
                old_str: "Draft line".to_string(),
                new_str: "Final line".to_string(),
            },
        )
        .unwrap();
        let body = run(
            &root,
            MemoryCommand::View {
                path: "/memories/notes.md".to_string(),
                view_range: None,
            },
        )
        .unwrap();
        assert!(body.contains("Final line"));
        assert!(!body.contains("Draft line"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn str_replace_requires_unique_match() {
        let root = temp_root();
        run(
            &root,
            MemoryCommand::Create {
                path: "/memories/a.md".to_string(),
                file_text: "x\nx\n".to_string(),
            },
        )
        .unwrap();
        let err = run(
            &root,
            MemoryCommand::StrReplace {
                path: "/memories/a.md".to_string(),
                old_str: "x".to_string(),
                new_str: "y".to_string(),
            },
        )
        .unwrap_err();
        assert!(err.contains("not unique"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn insert_places_text_after_line() {
        let root = temp_root();
        run(
            &root,
            MemoryCommand::Create {
                path: "/memories/a.md".to_string(),
                file_text: "one\ntwo\nthree".to_string(),
            },
        )
        .unwrap();
        run(
            &root,
            MemoryCommand::Insert {
                path: "/memories/a.md".to_string(),
                insert_line: 1,
                insert_text: "inserted".to_string(),
            },
        )
        .unwrap();
        let body = run(
            &root,
            MemoryCommand::View {
                path: "/memories/a.md".to_string(),
                view_range: None,
            },
        )
        .unwrap();
        assert_eq!(body, "one\ninserted\ntwo\nthree");
        let _ = std::fs::remove_dir_all(&root);
    }


    #[test]
    fn rename_then_delete() {
        let root = temp_root();
        run(
            &root,
            MemoryCommand::Create {
                path: "/memories/draft.md".to_string(),
                file_text: "hi".to_string(),
            },
        )
        .unwrap();
        run(
            &root,
            MemoryCommand::Rename {
                old_path: "/memories/draft.md".to_string(),
                new_path: "/memories/final.md".to_string(),
            },
        )
        .unwrap();
        assert!(root.join("final.md").exists());
        assert!(!root.join("draft.md").exists());
        run(
            &root,
            MemoryCommand::Delete {
                path: "/memories/final.md".to_string(),
            },
        )
        .unwrap();
        assert!(!root.join("final.md").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn view_range_slices_lines() {
        let root = temp_root();
        run(
            &root,
            MemoryCommand::Create {
                path: "/memories/log.md".to_string(),
                file_text: "l1\nl2\nl3\nl4".to_string(),
            },
        )
        .unwrap();
        let out = run(
            &root,
            MemoryCommand::View {
                path: "/memories/log.md".to_string(),
                view_range: Some((2, 3)),
            },
        )
        .unwrap();
        assert_eq!(out, "l2\nl3");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn traversal_and_bad_root_are_rejected() {
        let root = temp_root();
        std::fs::create_dir_all(&root).unwrap();
        assert!(run(
            &root,
            MemoryCommand::View {
                path: "/memories/../../secret".to_string(),
                view_range: None,
            },
        )
        .is_err());
        assert!(run(
            &root,
            MemoryCommand::View {
                path: "/etc/passwd".to_string(),
                view_range: None,
            },
        )
        .is_err());
        assert!(run(
            &root,
            MemoryCommand::Create {
                path: "/memories/bad name!.md".to_string(),
                file_text: "x".to_string(),
            },
        )
        .is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_refuses_root() {
        let root = temp_root();
        std::fs::create_dir_all(&root).unwrap();
        let err = run(
            &root,
            MemoryCommand::Delete {
                path: "/memories".to_string(),
            },
        )
        .unwrap_err();
        assert!(err.contains("root"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn build_command_reports_missing_fields() {
        assert!(build_command(
            "create",
            Some("/memories/a".into()),
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
        assert!(
            build_command("view", None, None, None, None, None, None, None, None, None).is_err()
        );
        assert!(
            build_command("bogus", None, None, None, None, None, None, None, None, None).is_err()
        );
    }

    #[test]
    fn native_scope_root_isolates_scopes() {
        let base = temp_root();
        let a = native_scope_root(&base, Some("conn-1"), Some("db"));
        let b = native_scope_root(&base, Some("conn-2"), Some("db"));
        assert_ne!(a, b);
        assert!(native_scope_root(&base, None, None).ends_with("global/default"));
        // Hostile scope strings are flattened, not traversed.
        assert_eq!(
            native_scope_root(&base, Some("../../etc"), None),
            native_scope_root(&base, Some("______etc"), None)
        );
    }
}

