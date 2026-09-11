import type { SkillUsageEntry } from "../../stores/skillUsageStore";

/**
 * A discovered skill's frontmatter summary as returned by the `list_ai_skills`
 * backend command. Only the fields the health view needs are modeled.
 */
export interface SkillCatalogEntry {
  name: string;
  description: string;
  source: string;
  version?: string | null;
}

/** One row of the skill health report (Claude Code's `/skill-doctor` idea). */
export interface SkillHealthRow {
  name: string;
  description: string;
  source: string;
  version: string | null;
  enabled: boolean;
  runs: number;
  lastUsedAt: number | null;
  /**
   * Characters this skill's description adds to EVERY agent run (the catalog is
   * injected on every step). A rough, honest proxy for its standing context
   * cost before the body is ever loaded.
   */
  catalogCostChars: number;
  /** Injected in the catalog but never run on record — a prune candidate. */
  unused: boolean;
}

export interface SkillHealthReport {
  rows: SkillHealthRow[];
  totalSkills: number;
  enabledSkills: number;
  /** Enabled skills that have never been run — safe to disable/prune. */
  unusedEnabledSkills: number;
  /** Sum of catalog cost for the ENABLED skills (what a run actually pays). */
  enabledCatalogCostChars: number;
}

// Per-skill catalog framing (`<skill><name>…</name><description>…`) beyond the
// raw description text — a rough constant so the cost estimate is not misleading.
const SKILL_CATALOG_FRAMING_CHARS = 40;

/**
 * Fold the discovered catalog, persisted usage counters, and the enable/disable
 * prefs into a single report so the UI (and tests) have one honest source of
 * truth about which skills earn their context cost.
 */
export function buildSkillHealthReport(
  catalog: SkillCatalogEntry[],
  usage: Record<string, SkillUsageEntry>,
  isEnabled: (name: string) => boolean,
): SkillHealthReport {
  const rows: SkillHealthRow[] = catalog.map((entry) => {
    const used = usage[entry.name];
    const enabled = isEnabled(entry.name);
    const runs = used?.runs ?? 0;
    const catalogCostChars =
      enabled ? entry.name.length + entry.description.length + SKILL_CATALOG_FRAMING_CHARS : 0;
    return {
      name: entry.name,
      description: entry.description,
      source: entry.source,
      version: entry.version ?? null,
      enabled,
      runs,
      lastUsedAt: used?.lastUsedAt ?? null,
      catalogCostChars,
      unused: enabled && runs === 0,
    };
  });

  // Sort: prune candidates (enabled + unused) first, then least-used, so the
  // most actionable rows surface at the top of the manager.
  rows.sort((left, right) => {
    if (left.unused !== right.unused) return left.unused ? -1 : 1;
    if (left.runs !== right.runs) return left.runs - right.runs;
    return left.name.localeCompare(right.name);
  });

  const enabledRows = rows.filter((row) => row.enabled);
  return {
    rows,
    totalSkills: rows.length,
    enabledSkills: enabledRows.length,
    unusedEnabledSkills: enabledRows.filter((row) => row.unused).length,
    enabledCatalogCostChars: enabledRows.reduce((sum, row) => sum + row.catalogCostChars, 0),
  };
}
