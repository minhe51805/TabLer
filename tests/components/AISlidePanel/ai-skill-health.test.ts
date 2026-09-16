import { describe, expect, it } from "vitest";
import { buildSkillHealthReport } from "@/components/AISlidePanel/ai-skill-health";

const catalog = [
  { name: "git-release", description: "Draft release notes", source: "global", version: "1.0.0" },
  { name: "db-audit", description: "Audit a schema", source: "global", version: null },
  { name: "unused-skill", description: "Never runs", source: "global" },
];

describe("buildSkillHealthReport", () => {
  it("folds catalog + usage + prefs into an actionable report", () => {
    const usage = {
      "git-release": { runs: 5, lastUsedAt: 1000, lastConnectionId: null },
      "db-audit": { runs: 1, lastUsedAt: 500, lastConnectionId: null },
    };
    const disabled = new Set(["db-audit"]);
    const report = buildSkillHealthReport(catalog, usage, (name) => !disabled.has(name));

    expect(report.totalSkills).toBe(3);
    expect(report.enabledSkills).toBe(2); // db-audit disabled
    // unused-skill is enabled but never run → prune candidate, surfaced first.
    expect(report.unusedEnabledSkills).toBe(1);
    expect(report.rows[0].name).toBe("unused-skill");
    expect(report.rows[0].unused).toBe(true);

    const disabledRow = report.rows.find((row) => row.name === "db-audit");
    expect(disabledRow?.enabled).toBe(false);
    // A disabled skill costs nothing in context.
    expect(disabledRow?.catalogCostChars).toBe(0);

    const gitRow = report.rows.find((row) => row.name === "git-release");
    expect(gitRow?.runs).toBe(5);
    expect(gitRow?.version).toBe("1.0.0");
    expect(gitRow?.catalogCostChars).toBeGreaterThan(0);

    // Enabled cost only counts the enabled skills.
    expect(report.enabledCatalogCostChars).toBe(
      report.rows
        .filter((row) => row.enabled)
        .reduce((sum, row) => sum + row.catalogCostChars, 0),
    );
  });
});
