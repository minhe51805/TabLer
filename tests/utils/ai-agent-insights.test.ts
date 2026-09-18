import { describe, expect, it } from "vitest";

import {
  appendAgentFacts,
  readStepFacts,
  type AgentStepFacts,
  type AgentTraceStep,
} from "@/components/AISlidePanel/ai-agent-context";
import {
  INSIGHT_COOLDOWN_MILLIS,
  INSIGHT_MAX_PER_RUN,
  INSIGHT_MAX_STORED,
  collectRunEndInsights,
  gradeConstantColumn,
  gradeHighNullColumn,
  gradeSoftDeleteCandidate,
  mergeInsightCards,
  type AgentInsight,
  type InsightKind,
} from "@/components/AISlidePanel/ai-agent-insights";

const EVIDENCE_SQL = "SELECT COUNT(*) AS __total FROM users";

function makeStep(facts: AgentStepFacts): AgentTraceStep {
  return {
    step: 1,
    action: "sample_table_data",
    message: "Sampled users",
    observation: appendAgentFacts("Sampled 20 rows", facts),
  };
}

function sampleFacts(columnStats: AgentStepFacts["columnStats"], rowCount = 500): AgentStepFacts {
  return {
    rowsReturned: 20,
    tables: ["users"],
    columnStats,
    insightEvidence: { executedSql: EVIDENCE_SQL, rowCount },
  };
}

function card(
  id: string,
  confidence: number,
  kind: InsightKind = "high-null-column",
): AgentInsight {
  return {
    id,
    kind,
    table: id.split(":")[1] ?? "users",
    title: id,
    detail: `detail for ${id}`,
    evidence: { executedSql: EVIDENCE_SQL, rowCount: 500, digest: "00000000" },
    confidence,
    suggestedAction: { label: "Go", prefill: "SELECT 1;", danger: false },
  };
}

describe("collectRunEndInsights", () => {
  it("drops a step whose stats have no executed statement behind them", () => {
    const steps = [
      makeStep({
        rowsReturned: 20,
        tables: ["users"],
        // Saturated and constant, but nothing ran to prove it: sample-scoped
        // stats come from driver-side pagination with no SQL text anywhere.
        columnStats: [{ column: "legacy_flag", nullRatio: 1, distinctCount: 0 }],
      }),
    ];
    expect(collectRunEndInsights(steps)).toEqual([]);
  });

  it("drops evidence from a read too small to prove anything", () => {
    const steps = [
      makeStep(sampleFacts([{ column: "email", nullRatio: 1, distinctCount: 9 }], 19)),
    ];
    expect(collectRunEndInsights(steps)).toEqual([]);
  });

  it("drops findings that cannot clear the confidence bar", () => {
    // 0.9 sits exactly on the high-null floor, which grades 79 < the 80 bar.
    const steps = [makeStep(sampleFacts([{ column: "email", nullRatio: 0.9, distinctCount: 9 }]))];
    expect(collectRunEndInsights(steps)).toEqual([]);
  });

  it("emits one card per proven finding, strongest first, citing the statement", () => {
    const insights = collectRunEndInsights([
      makeStep(
        sampleFacts([
          { column: "email", nullRatio: 0.998, distinctCount: 3 },
          // 0.9 exactly: enough for the soft-delete convention, while the
          // high-null twin grades 79 and is filtered by the bar — so this
          // column proves exactly one finding.
          { column: "deleted_at", nullRatio: 0.9, distinctCount: 5 },
          { column: "legacy_flag", nullRatio: 0.1, distinctCount: 1 },
        ]),
      ),
    ]);

    expect(insights.map((insight) => insight.kind)).toEqual([
      "high-null-column",
      "constant-column",
      "soft-delete-candidate",
    ]);
    expect(insights.map((insight) => insight.confidence)).toEqual([95, 90, 86]);
    expect(insights[0]).toMatchObject({
      id: "high-null-column:users:email",
      table: "users",
      column: "email",
    });
    expect(insights[0].evidence).toEqual({
      executedSql: EVIDENCE_SQL,
      rowCount: 500,
      digest: expect.stringMatching(/^[0-9a-f]{8}$/),
    });
    // Every card is a read-only suggestion: taking it never executes anything.
    for (const insight of insights) {
      expect(insight.suggestedAction.danger).toBe(false);
      expect(insight.suggestedAction.prefill.length).toBeGreaterThan(0);
    }
  });

  it("keeps the strongest proof when the same finding is proven twice in a run", () => {
    const strongSql = "SELECT COUNT(*) AS __total FROM users";
    const weakSql = "SELECT COUNT(*) AS __total FROM users WHERE id > 0";
    const columnStats = [{ column: "legacy_flag", nullRatio: 0.1, distinctCount: 1 }];
    const weak = makeStep({
      rowsReturned: 20,
      tables: ["users"],
      columnStats,
      insightEvidence: { executedSql: weakSql, rowCount: 50 },
    });
    const strong = makeStep({
      rowsReturned: 20,
      tables: ["users"],
      columnStats,
      insightEvidence: { executedSql: strongSql, rowCount: 400 },
    });

    // Order must not decide which proof wins — the stronger evidence does.
    for (const steps of [
      [strong, weak],
      [weak, strong],
    ]) {
      const insights = collectRunEndInsights(steps);
      expect(insights).toHaveLength(1);
      expect(insights[0].confidence).toBe(90);
      expect(insights[0].evidence.executedSql).toBe(strongSql);
      expect(insights[0].evidence.rowCount).toBe(400);
    }
  });

  it("caps the cards per run and leaves the trace untouched", () => {
    const steps = [
      makeStep(
        sampleFacts(
          ["a", "b", "c", "d"].map((column) => ({ column, nullRatio: 1, distinctCount: 5 })),
        ),
      ),
    ];
    const first = collectRunEndInsights(steps);
    expect(first).toHaveLength(INSIGHT_MAX_PER_RUN);
    expect(collectRunEndInsights(steps)).toEqual(first);
    expect(readStepFacts(steps[0])?.insightEvidence?.executedSql).toBe(EVIDENCE_SQL);
  });
});

describe("insight graders", () => {
  it("only treats real saturation as high confidence", () => {
    expect(gradeHighNullColumn(0.89)).toBe(0);
    expect(gradeHighNullColumn(0.9)).toBe(79);
    expect(gradeHighNullColumn(0.998)).toBe(95);
    expect(gradeHighNullColumn(Number.NaN)).toBe(0);
  });

  it("needs both the naming convention and the abandoned column", () => {
    // The convention alone is not enough: a soft-delete column that is
    // actually populated proves nothing worth a card.
    expect(gradeSoftDeleteCandidate(0.95, 500)).toBe(86);
    expect(gradeSoftDeleteCandidate(0.9, 500)).toBe(86);
    expect(gradeSoftDeleteCandidate(0.1, 500)).toBe(0);
    expect(gradeSoftDeleteCandidate(0.99, 10)).toBe(0);
  });

  it("scales the constant-column grade with how much was observed", () => {
    expect(gradeConstantColumn(1, 199)).toBe(84);
    expect(gradeConstantColumn(1, 200)).toBe(90);
    expect(gradeConstantColumn(1, 19)).toBe(0);
    expect(gradeConstantColumn(2, 500)).toBe(0);
  });
  describe("mergeInsightCards", () => {
    const keyOf = (insight: AgentInsight) => `${insight.id}@${insight.table}`;
    const now = 1_000_000_000;

    it("stamps a first-time card and replaces it once the cooldown lapses", () => {
      const first = mergeInsightCards([], [card("high-null-column:users:email", 95)], {
        now,
        keyOf,
      });
      expect(first).toHaveLength(1);
      expect(first[0].seenAt).toBe(now);

      const withinWindow = mergeInsightCards(first, [card("high-null-column:users:email", 95)], {
        now: now + INSIGHT_COOLDOWN_MILLIS - 1,
        keyOf,
      });
      expect(withinWindow[0].seenAt).toBe(now);

      const afterWindow = mergeInsightCards(first, [card("high-null-column:users:email", 95)], {
        now: now + INSIGHT_COOLDOWN_MILLIS,
        keyOf,
      });
      expect(afterWindow[0].seenAt).toBe(now + INSIGHT_COOLDOWN_MILLIS);
    });

    it("keeps the same finding id apart when the key differs", () => {
      const merged = mergeInsightCards(
        [card("high-null-column:users:email", 95)],
        [{ ...card("high-null-column:users:email", 95), table: "customers" }],
        { now, keyOf },
      );
      expect(merged).toHaveLength(2);
    });

    it("bounds the stored set and shows the newest first", () => {
      const stored = Array.from({ length: INSIGHT_MAX_STORED }, (_unused, index) =>
        card(`high-null-column:t${index}:c`, 90),
      ).map((insight, index) => ({ ...insight, seenAt: now - (index + 1) * 1000 }));
      const merged = mergeInsightCards(stored, [card("high-null-column:fresh:c", 88)], {
        now,
        keyOf,
      });
      expect(merged).toHaveLength(INSIGHT_MAX_STORED);
      expect(merged[0].id).toBe("high-null-column:fresh:c");
    });
  });
});
