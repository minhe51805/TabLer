use serde::Serialize;

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
pub(crate) const MAX_SKILLS_PER_CATALOG: usize = 32;
pub(crate) const MAX_SKILL_BODY_CHARS: usize = 8_000;
/// Ceiling for a single bundled resource file injected into context on demand.
pub(crate) const MAX_SKILL_RESOURCE_CHARS: usize = 12_000;
/// Max resource files listed per skill so the catalog stays bounded.
pub(crate) const MAX_SKILL_RESOURCES: usize = 64;
/// Max `allowed-tools:` entries parsed from frontmatter.
pub(crate) const MAX_SKILL_ALLOWED_TOOLS: usize = 32;
/// Bundled-resource subdirectories that may be listed and read into context.
/// `assets/` is intentionally excluded: assets are output files, not context.
pub(crate) const SKILL_RESOURCE_DIRS: [&str; 2] = ["references", "scripts"];
