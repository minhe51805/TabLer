//! Built-in Agent Skill pack — ships the SQL/T-SQL domain knowledge inside the
//! binary and installs it into the user's global skills directory on first run.
//!
//! Why `include_str!` instead of `bundle.resources`: the bundle-resource path has
//! to work across NSIS, MSI/WiX, `.dmg`, AppImage, `.deb` and `.rpm`, and that
//! exact area is where the v0.1.6a release broke. Embedding the pack at compile
//! time keeps `tauri.conf.json` untouched and makes the skills impossible to lose
//! in packaging.
//!
//! Ownership contract (never silently clobber user work):
//! - On first run every skill in [`BUILTIN_SKILLS`] is written to
//!   `<data_dir>/skills/<name>/…` and its content hashes are recorded in
//!   `<data_dir>/skills/.builtin.json`.
//! - On later runs a skill is only refreshed when **every** installed file still
//!   hashes to what we last wrote — i.e. the user has not touched it. A skill the
//!   user edited is reported as `userModified` and left alone.
//! - `reset_builtin_skills` (force) is the explicit opt-in to overwrite edits.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::utils::paths::resolve_data_dir;

/// Records what the seeder last installed, so an app upgrade can tell "untouched
/// built-in" apart from "user edited this".
const BUILTIN_MANIFEST: &str = ".builtin.json";

/// One file of a built-in skill. `rel_path` is POSIX-separated and relative to the
/// skill directory (e.g. `references/gotchas.md`).
struct BuiltinSkillFile {
    rel_path: &'static str,
    content: &'static str,
}

/// One built-in skill: the directory name must equal the `name:` in its
/// SKILL.md frontmatter, because `ai_skills::read_skill_in_roots` refuses a
/// mismatch. `version` is bumped when shipped content changes.
struct BuiltinSkill {
    name: &'static str,
    version: &'static str,
    files: &'static [BuiltinSkillFile],
}

/// Per-skill outcome of a seed pass. Serialized to the frontend so the skills
/// manager can show which built-ins are installed, customised or outdated.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeededSkillStatus {
    pub name: String,
    pub version: String,
    /// `installed` | `refreshed` | `unchanged` | `userModified`
    pub state: String,
    pub files_written: usize,
}

/// Result of one seed pass over the whole pack.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedReport {
    pub skills: Vec<SeededSkillStatus>,
    pub installed: usize,
    pub refreshed: usize,
    pub unchanged: usize,
    /// Skills the user edited — deliberately left untouched.
    pub user_modified: usize,
    pub files_written: usize,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct BuiltinManifestEntry {
    version: String,
    /// `rel_path` -> sha256 of the content we last wrote there.
    #[serde(default)]
    files: BTreeMap<String, String>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct BuiltinManifest {
    /// Skill name -> what we last installed for it.
    #[serde(default)]
    skills: BTreeMap<String, BuiltinManifestEntry>,
}

fn hex_sha256(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn load_manifest(skills_root: &Path) -> BuiltinManifest {
    let path = skills_root.join(BUILTIN_MANIFEST);
    // A corrupt or hand-edited manifest must never break startup: treat it as
    // "nothing recorded", which makes every existing file look user-modified and
    // therefore safe from overwrite.
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<BuiltinManifest>(&raw).ok())
        .unwrap_or_default()
}

fn save_manifest(skills_root: &Path, manifest: &BuiltinManifest) -> Result<(), String> {
    let path = skills_root.join(BUILTIN_MANIFEST);
    let raw = serde_json::to_string_pretty(manifest).map_err(|error| error.to_string())?;
    std::fs::write(&path, raw).map_err(|error| error.to_string())
}

/// True when the installed skill still matches what we last wrote, so refreshing
/// it cannot destroy user work.
///
/// Two cases, deliberately asymmetric:
/// - a **changed** file holds user intent → stop, report `userModified`;
/// - a **missing** file holds nothing at all → safe to restore, so a half-broken
///   install (or a stray delete) heals itself on the next startup.
///
/// Users who truly want a built-in gone disable it in the skills manager
/// (`skillPrefsStore`) rather than deleting files out from under the seeder.
fn is_untouched(skill_dir: &Path, record: Option<&BuiltinManifestEntry>) -> bool {
    let Some(record) = record else {
        return false;
    };
    for file in record.files.iter() {
        let installed = skill_dir.join(file.0);
        match std::fs::read(&installed) {
            Ok(bytes) => {
                if &hex_sha256(&bytes) != file.1 {
                    return false;
                }
            }
            // Missing: nothing to lose by restoring it.
            Err(_) => continue,
        }
    }
    true
}

/// The pack. Keep descriptions inside the 200-char frontmatter cap and bodies
/// under 8 000 chars — `scripts/validate-agent-skills.mjs` enforces both in CI.
const BUILTIN_SKILLS: &[BuiltinSkill] = &[
    BuiltinSkill {
        name: "tsql-dialect-mastery",

        version: "1.0.0",
        files: &[
            BuiltinSkillFile {
                rel_path: "SKILL.md",
                content: include_str!("../skills/tsql-dialect-mastery/SKILL.md"),
            },
            BuiltinSkillFile {
                rel_path: "references/keyword-map.md",
                content: include_str!("../skills/tsql-dialect-mastery/references/keyword-map.md"),
            },
            BuiltinSkillFile {
                rel_path: "references/gotchas.md",
                content: include_str!("../skills/tsql-dialect-mastery/references/gotchas.md"),
            },
            BuiltinSkillFile {
                rel_path: "scripts/catalog-queries.sql",
                content: include_str!("../skills/tsql-dialect-mastery/scripts/catalog-queries.sql"),
            },
        ],
    },
    BuiltinSkill {
        name: "tsql-safety-guardrails",
        version: "1.0.0",
        files: &[BuiltinSkillFile {
            rel_path: "SKILL.md",
            content: include_str!("../skills/tsql-safety-guardrails/SKILL.md"),
        }],
    },
    BuiltinSkill {
        name: "query-performance-tuning",
        version: "1.0.0",
        files: &[BuiltinSkillFile {
            rel_path: "SKILL.md",
            content: include_str!("../skills/query-performance-tuning/SKILL.md"),
        }],
    },
    BuiltinSkill {
        name: "data-profiling",
        version: "1.0.0",
        files: &[
            BuiltinSkillFile {
                rel_path: "SKILL.md",
                content: include_str!("../skills/data-profiling/SKILL.md"),
            },
            BuiltinSkillFile {
                rel_path: "scripts/profile-table.sql",
                content: include_str!("../skills/data-profiling/scripts/profile-table.sql"),
            },
        ],
    },
    BuiltinSkill {
        name: "migration-authoring",
        version: "1.0.0",
        files: &[BuiltinSkillFile {
            rel_path: "SKILL.md",
            content: include_str!("../skills/migration-authoring/SKILL.md"),
        }],
    },
    BuiltinSkill {
        name: "schema-documentation",
        version: "1.0.0",
        files: &[BuiltinSkillFile {
            rel_path: "SKILL.md",
            content: include_str!("../skills/schema-documentation/SKILL.md"),
        }],
    },
    BuiltinSkill {
        name: "postgres-dialect-mastery",
        version: "1.0.0",
        files: &[BuiltinSkillFile {
            rel_path: "SKILL.md",
            content: include_str!("../skills/postgres-dialect-mastery/SKILL.md"),
        }],
    },
    BuiltinSkill {
        name: "mysql-dialect-mastery",
        version: "1.0.0",
        files: &[BuiltinSkillFile {
            rel_path: "SKILL.md",
            content: include_str!("../skills/mysql-dialect-mastery/SKILL.md"),
        }],
    },
    BuiltinSkill {
        name: "sqlite-dialect-mastery",
        version: "1.0.0",
        files: &[BuiltinSkillFile {
            rel_path: "SKILL.md",
            content: include_str!("../skills/sqlite-dialect-mastery/SKILL.md"),
        }],
    },
    BuiltinSkill {
        name: "skill-authoring",
        version: "1.0.0",
        files: &[BuiltinSkillFile {
            rel_path: "SKILL.md",
            content: include_str!("../skills/skill-authoring/SKILL.md"),
        }],
    },
];

/// Write one skill into `skills_root`. Returns its status row and the manifest
/// entry that should be recorded (unless the skill was user-modified, in which
/// case the existing record is kept so we never start clobbering it).
fn seed_one(
    skills_root: &Path,
    skill: &BuiltinSkill,
    record: Option<&BuiltinManifestEntry>,
    force: bool,
) -> Result<(SeededSkillStatus, Option<BuiltinManifestEntry>), String> {
    let skill_dir = skills_root.join(skill.name);
    let skill_md = skill_dir.join("SKILL.md");
    let existed = skill_md.exists();

    let untouched = existed && is_untouched(&skill_dir, record);

    // Guard the user's work: only a first install, an untouched built-in, or an
    // explicit reset may write.
    if existed && !force && !untouched {
        return Ok((
            SeededSkillStatus {
                name: skill.name.to_string(),
                version: skill.version.to_string(),
                state: "userModified".to_string(),
                files_written: 0,
            },
            // Keep the stale record so a later upgrade still sees "modified".
            None,
        ));
    }

    // Would a write actually change anything? (idempotent re-seed)
    let mut pending: Vec<(&str, String)> = Vec::new();
    let mut file_hashes: BTreeMap<String, String> = BTreeMap::new();
    for file in skill.files {
        let installed = skill_dir.join(file.rel_path);
        let hash = hex_sha256(file.content.as_bytes());
        file_hashes.insert(file.rel_path.to_string(), hash);
        let same_on_disk = std::fs::read(&installed)
            .map(|bytes| hex_sha256(&bytes) == hex_sha256(file.content.as_bytes()))
            .unwrap_or(false);
        if !same_on_disk {
            pending.push((file.rel_path, file.content.to_string()));
        }
    }

    let state = if !existed {
        "installed"
    } else if pending.is_empty() {
        "unchanged"
    } else {
        "refreshed"
    };

    for (rel_path, content) in &pending {
        let target = skill_dir.join(rel_path);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        // SKILL.md goes through the same crash-safe write as the manager UI:
        // staging file + same-volume rename + symlink refusal, so a crash
        // mid-seed can never leave a torn SKILL.md behind.
        if *rel_path == "SKILL.md" {
            crate::ai_skills::write_skill_file(&target, content)?;
        } else {
            std::fs::write(&target, content).map_err(|error| error.to_string())?;
        }
    }

    // Even a no-op pass refreshes the record: it also covers the case where the
    // skill was installed by an older build that predates the manifest.
    Ok((
        SeededSkillStatus {
            name: skill.name.to_string(),
            version: skill.version.to_string(),
            state: state.to_string(),
            files_written: pending.len(),
        },
        Some(BuiltinManifestEntry {
            version: skill.version.to_string(),
            files: file_hashes,
        }),
    ))
}

/// Seed the whole pack into an explicit root — split out so tests drive a temp
/// directory instead of the real data dir.
fn seed_into_root(skills_root: &Path, force: bool) -> Result<SeedReport, String> {
    std::fs::create_dir_all(skills_root).map_err(|error| error.to_string())?;
    let mut manifest = load_manifest(skills_root);
    let mut report = SeedReport::default();

    for skill in BUILTIN_SKILLS {
        let record = manifest.skills.get(skill.name);
        let (status, new_record) = seed_one(skills_root, skill, record, force)?;
        report.files_written += status.files_written;
        match status.state.as_str() {
            "installed" => report.installed += 1,
            "refreshed" => report.refreshed += 1,
            "userModified" => report.user_modified += 1,
            _ => report.unchanged += 1,
        }
        if let Some(entry) = new_record {
            manifest.skills.insert(skill.name.to_string(), entry);
        }
        report.skills.push(status);
    }

    save_manifest(skills_root, &manifest)?;
    Ok(report)
}

/// Install/refresh the built-in pack into the global skills directory. Safe to
/// call on every startup: it is a handful of `stat` calls once installed.
pub fn seed_builtin_skills(force: bool) -> Result<SeedReport, String> {
    let data_dir = resolve_data_dir().map_err(|error| error.to_string())?;
    seed_into_root(&data_dir.join("skills"), force)
}

/// Absolute path of the global skills root (mirrors `ai_skills::ai_skills_directory`
/// so the seeder and the reader can never disagree about where skills live).
fn global_skills_root() -> Result<PathBuf, String> {
    let data_dir = resolve_data_dir().map_err(|error| error.to_string())?;
    Ok(data_dir.join("skills"))
}

/// Idempotent seed, exposed so the skills manager can re-run it on demand.
#[tauri::command]
pub fn seed_ai_builtin_skills(force: Option<bool>) -> Result<SeedReport, String> {
    seed_into_root(&global_skills_root()?, force.unwrap_or(false))
}

/// Force-restore every built-in skill, discarding user edits to them. This is the
/// only path that overwrites a modified skill, and it is always user-initiated.
#[tauri::command]
pub fn reset_ai_builtin_skills() -> Result<SeedReport, String> {
    seed_into_root(&global_skills_root()?, true)
}

/// Names + versions of the shipped pack, for the manager UI and tests.
#[allow(dead_code)] // seeded on disk by `seed_ai_builtin_skills`; read by the manifest parity test
pub fn builtin_skill_manifest() -> Vec<(String, String)> {
    BUILTIN_SKILLS
        .iter()
        .map(|skill| (skill.name.to_string(), skill.version.to_string()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_skills::{MAX_SKILL_BODY_CHARS, MAX_SKILL_DESCRIPTION_CHARS};

    /// Ephemeral skills root; the seeder is never pointed at the real data dir in
    /// tests so a test run cannot disturb the developer's own skills.
    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new(label: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "tabler-skill-seed-{}-{}-{}",
                label,
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            ));
            std::fs::create_dir_all(&dir).expect("temp root");
            TempRoot(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Every built-in must ship a SKILL.md; the directory/path name must equal the
    /// frontmatter `name`, otherwise `ai_skills::read_skill_in_roots` refuses it.
    #[test]
    fn every_builtin_dir_name_matches_its_declared_name() {
        for skill in BUILTIN_SKILLS {
            let skill_md = skill
                .files
                .iter()
                .find(|file| file.rel_path == "SKILL.md")
                .unwrap_or_else(|| panic!("{}: must ship SKILL.md", skill.name));
            let frontmatter = skill_md
                .content
                .strip_prefix("---")
                .and_then(|rest| rest.split_once("\n---"))
                .map(|(head, _)| head.to_string())
                .unwrap_or_else(|| panic!("{}: SKILL.md needs frontmatter", skill.name));
            assert!(
                frontmatter.contains(&format!("name: {}", skill.name)),
                "{}: frontmatter must declare `name: {}`",
                skill.name,
                skill.name
            );
        }
    }

    /// Runtime caps live in `ai_skills.rs`; past them the skill is truncated and
    /// stops firing on its trigger phrases.
    #[test]
    fn every_builtin_stays_inside_the_runtime_caps() {
        for skill in BUILTIN_SKILLS {
            for file in skill.files {
                if file.rel_path == "SKILL.md" {
                    let len = file.content.chars().count();
                    assert!(
                        len <= MAX_SKILL_BODY_CHARS,
                        "{}: SKILL.md is {len} chars (cap {MAX_SKILL_BODY_CHARS})",
                        skill.name
                    );
                    let description = file
                        .content
                        .lines()
                        .find_map(|line| line.strip_prefix("description:"))
                        .unwrap_or("")
                        .trim()
                        .trim_matches('"');
                    assert!(
                        !description.is_empty(),
                        "{}: description is required so the catalog can trigger it",
                        skill.name
                    );
                    assert!(
                        description.chars().count() <= MAX_SKILL_DESCRIPTION_CHARS,
                        "{}: description is {} chars (cap {MAX_SKILL_DESCRIPTION_CHARS})",
                        skill.name,
                        description.chars().count()
                    );
                } else {
                    let top = file.rel_path.split('/').next().unwrap_or("");
                    assert!(
                        matches!(top, "references" | "scripts"),
                        "{}: {} is outside the readable resource dirs",
                        skill.name,
                        file.rel_path
                    );
                }
            }
        }
    }

    /// First run into an empty root installs the whole pack, including bundled
    /// resources, and leaves a manifest behind so upgrades are auditable.
    #[test]
    fn installs_the_whole_pack_into_an_empty_root() {
        let root = TempRoot::new("install");
        let report = seed_into_root(root.path(), false).expect("seed");

        assert_eq!(report.installed, BUILTIN_SKILLS.len());
        assert_eq!(report.unchanged, 0);
        assert_eq!(report.user_modified, 0);
        assert!(report.files_written > BUILTIN_SKILLS.len());

        for skill in BUILTIN_SKILLS {
            let skill_md = root.path().join(skill.name).join("SKILL.md");
            assert!(skill_md.is_file(), "{}: SKILL.md missing", skill.name);
        }

        // The multi-file skill must land its resources too, not just SKILL.md.
        assert!(
            root.path()
                .join("tsql-dialect-mastery")
                .join("references")
                .join("keyword-map.md")
                .is_file(),
            "bundled references must be seeded"
        );
        assert!(
            root.path().join(BUILTIN_MANIFEST).is_file(),
            "manifest missing"
        );
    }

    /// Startup calls the seeder on every launch, so a second pass must be a no-op
    /// that writes zero bytes.
    #[test]
    fn a_second_run_writes_nothing() {
        let root = TempRoot::new("idempotent");
        seed_into_root(root.path(), false).expect("first seed");

        let second = seed_into_root(root.path(), false).expect("second seed");
        assert_eq!(second.files_written, 0, "re-seed must not rewrite files");
        assert_eq!(second.unchanged, BUILTIN_SKILLS.len());
        assert_eq!(second.installed, 0);
        assert_eq!(second.refreshed, 0);
    }

    /// The core safety promise: an edited built-in is reported, never overwritten.
    #[test]
    fn never_clobbers_a_user_edited_skill() {
        let root = TempRoot::new("user-edited");
        seed_into_root(root.path(), false).expect("seed");

        let target = root.path().join("tsql-safety-guardrails").join("SKILL.md");
        let edited = "# my own rules\nkeep me\n";
        std::fs::write(&target, edited).expect("write edit");

        let report = seed_into_root(root.path(), false).expect("re-seed");
        assert_eq!(report.user_modified, 1);
        assert_eq!(
            std::fs::read_to_string(&target).expect("read back"),
            edited,
            "a user edit must survive a re-seed"
        );

        let status = report
            .skills
            .iter()
            .find(|skill| skill.name == "tsql-safety-guardrails")
            .expect("status row");
        assert_eq!(status.state, "userModified");
        assert_eq!(status.files_written, 0);
    }

    /// Deleting a bundled resource leaves the skill "untouched" by the user (all
    /// remaining files still match the manifest), so an upgrade repairs it.
    #[test]
    fn restores_a_bundled_resource_that_went_missing() {
        let root = TempRoot::new("repair");
        seed_into_root(root.path(), false).expect("seed");

        let resource = root
            .path()
            .join("tsql-dialect-mastery")
            .join("scripts")
            .join("catalog-queries.sql");
        std::fs::remove_file(&resource).expect("remove resource");
        assert!(!resource.exists());

        let report = seed_into_root(root.path(), false).expect("re-seed");
        assert_eq!(report.refreshed, 1);
        assert!(resource.is_file(), "missing resource must be restored");
    }

    /// `reset` is the only path allowed to discard user edits, and it is always
    /// user-initiated.
    #[test]
    fn reset_overwrites_user_edits() {
        let root = TempRoot::new("reset");
        seed_into_root(root.path(), false).expect("seed");

        let target = root.path().join("data-profiling").join("SKILL.md");
        let shipped = std::fs::read_to_string(&target).expect("read shipped");
        std::fs::write(&target, "# broken\n").expect("break it");
        assert_ne!(std::fs::read_to_string(&target).expect("read"), shipped);

        let report = seed_into_root(root.path(), true).expect("reset");
        assert_eq!(report.refreshed, 1);
        assert_eq!(
            std::fs::read_to_string(&target).expect("read restored"),
            shipped,
            "reset must restore the shipped body"
        );
    }

    /// The manifest is what makes upgrades auditable and drives the manager UI.
    #[test]
    fn manifest_lists_every_builtin_with_its_version() {
        let root = TempRoot::new("manifest");
        seed_into_root(root.path(), false).expect("seed");

        let manifest = load_manifest(root.path());
        assert_eq!(manifest.skills.len(), BUILTIN_SKILLS.len());
        for skill in BUILTIN_SKILLS {
            let entry = manifest
                .skills
                .get(skill.name)
                .unwrap_or_else(|| panic!("{}: missing manifest entry", skill.name));
            assert_eq!(entry.version, skill.version);
            assert!(
                entry.files.contains_key("SKILL.md"),
                "{}: manifest must hash SKILL.md",
                skill.name
            );
        }

        let mut exposed = builtin_skill_manifest();
        exposed.sort();
        assert_eq!(exposed.len(), BUILTIN_SKILLS.len());
        assert!(exposed
            .iter()
            .any(|(name, _)| name == "tsql-dialect-mastery"));
    }
}
