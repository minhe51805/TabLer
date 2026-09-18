import { describe, expect, it, vi } from "vitest";

import {
  appendAgentFacts,
  type AgentStepFacts,
  type AgentTraceStep,
} from "@/components/AISlidePanel/ai-agent-context";
import type { AgentInsight, InsightKind } from "@/components/AISlidePanel/ai-agent-insights";
import {
  LEARNING_MAX_PROPOSALS,
  MAX_LEARNING_MEMORIES_PER_RUN,
  MIN_SKILL_STEPS,
  applyLearningProposal,
  buildLearningSlug,
  proposeRunLearnings,
  type LearningInvoker,
  type LearningProposal,
} from "@/components/AISlidePanel/ai-agent-learning";

const EVIDENCE_SQL = "SELECT COUNT(*) AS __total FROM users";

function insight(overrides: Partial<AgentInsight> = {}): AgentInsight {
  const kind: InsightKind = overrides.kind ?? "soft-delete-candidate";
  return {
    id: `${kind}:users:deleted_at`,
    kind,
    table: "users",
    column: "deleted_at",
    title: "users.deleted_at is never populated",
    detail: "100% of the 500 rows seen are NULL.",
    evidence: { executedSql: EVIDENCE_SQL, rowCount: 500, digest: "deadbeef" },
    confidence: 86,
    suggestedAction: { label: "Check the flag", prefill: "SELECT 1;", danger: false },
    ...overrides,
  };
}

function step(
  action: AgentTraceStep["action"],
  facts: AgentStepFacts | null,
  message = "did something",
): AgentTraceStep {
  return {
    step: 1,
    action,
    message,
    observation: facts ? appendAgentFacts("ok", facts) : "ok",
  };
}

const readStep = () =>
  step("sample_table_data", {
    rowsReturned: 20,
    tables: ["users"],
    columnStats: [{ column: "deleted_at", nullRatio: 0.999, distinctCount: 2 }],
    insightEvidence: { executedSql: EVIDENCE_SQL, rowCount: 500 },
  });

/** A clean run of `count` steps, the last of which executed a read. */
function cleanRun(count = MIN_SKILL_STEPS): AgentTraceStep[] {
  const steps: AgentTraceStep[] = [step("list_tables", { tables: ["users"] })];
  while (steps.length < count - 1) steps.push(step("describe_table", { tables: ["users"] }));
  steps.push(readStep());
  return steps;
}

describe("buildLearningSlug", () => {
  it("produces a name every store accepts as a file name", () => {
    const slug = buildLearningSlug("Flagged column", "public.users", "deleted_at!");
    expect(slug).toBe("flagged-column-public-users-deleted-at");
    expect(slug).toMatch(/^[a-z0-9-]+$/);
    expect(buildLearningSlug("", "")).toBe("run-note");
  });
});

describe("proposeRunLearnings", () => {
  it("offers a guardrail rule and a memory for a proven finding", () => {
    const proposals = proposeRunLearnings({ insights: [insight()], steps: [] });
    expect(proposals.map((proposal) => proposal.kind)).toEqual(["rule", "memory"]);

    const rule = proposals[0] as Extract<LearningProposal, { kind: "rule" }>;
    expect(rule.rule).toEqual({
      name: "flagged-column-users-deleted-at",
      description: expect.stringContaining("deleted_at"),
      event: "pre_read",
      // A guardrail learned from an observation informs; it must not be able to
      // refuse work the user asked for.
      action: "warn",
      pattern: "(?i)\\bdeleted_at\\b",
    });
    expect(rule.evidenceSql).toBe(EVIDENCE_SQL);

    const memory = proposals[1] as Extract<LearningProposal, { kind: "memory" }>;
    expect(memory.memory.name).toBe("users-deleted-at-soft-delete-candidate");
    expect(memory.memory.body).toContain(EVIDENCE_SQL);
    expect(memory.memory.body).toContain("500");
    expect(memory.memory.body).toContain("100% of the 500 rows");
  });

  it("skips the rule when no pattern could honestly be written", () => {
    // No column at all, then a column no SQL could mention verbatim.
    const noColumn = proposeRunLearnings({
      insights: [insight({ column: undefined, id: "constant-column:users:*" })],
      steps: [],
    });
    expect(noColumn.map((proposal) => proposal.kind)).toEqual(["memory"]);

    const oddColumn = proposeRunLearnings({
      insights: [insight({ column: "deleted at" })],
      steps: [],
    });
    expect(oddColumn.map((proposal) => proposal.kind)).toEqual(["memory"]);
  });

  it("keeps the per-kind caps and never repeats an id", () => {
    const many = Array.from({ length: 6 }, (_unused, index) =>
      insight({
        id: `high-null-column:users:c${index}`,
        kind: "high-null-column",
        column: `c${index}`,
        confidence: 95 - index,
      }),
    );
    const proposals = proposeRunLearnings({ insights: many, steps: [] });
    expect(proposals.filter((proposal) => proposal.kind === "rule")).toHaveLength(1);
    expect(proposals.filter((proposal) => proposal.kind === "memory")).toHaveLength(
      MAX_LEARNING_MEMORIES_PER_RUN,
    );
    expect(proposals.length).toBeLessThanOrEqual(LEARNING_MAX_PROPOSALS);
    expect(new Set(proposals.map((proposal) => proposal.id)).size).toBe(proposals.length);
  });

  it("offers a skill only for a clean run that actually read something", () => {
    const skill = proposeRunLearnings({ insights: [], steps: cleanRun() }).find(
      (proposal): proposal is Extract<LearningProposal, { kind: "skill" }> =>
        proposal.kind === "skill",
    );
    expect(skill).toBeDefined();
    expect(skill?.skill.name).toBe("check-users");
    expect(skill?.skill.body).toContain("## Steps");
    expect(skill?.skill.body).toContain(EVIDENCE_SQL);
    expect(skill?.rationale).toContain("clean");
  });

  it("will not document a run that was too short, ended badly, or read nothing", () => {
    const hasSkill = (steps: AgentTraceStep[]) =>
      proposeRunLearnings({ insights: [], steps }).some((proposal) => proposal.kind === "skill");

    // Too short to be a procedure.
    expect(hasSkill(cleanRun(MIN_SKILL_STEPS - 1))).toBe(false);
    // Ended on a tool error: not a procedure worth repeating. The failure has
    // to be in the observation, which is what the runner's streak counter reads.
    const failed: AgentTraceStep = {
      step: 99,
      action: "run_readonly_sql",
      message: "Read failed",
      observation: "Tool error: boom",
    };
    expect(hasSkill([...cleanRun(), failed])).toBe(false);
    // Long enough, but nothing ran: model reasoning is not a repeatable check.
    const reasoning = Array.from({ length: MIN_SKILL_STEPS + 1 }, () => step("list_tables", null));
    expect(hasSkill(reasoning)).toBe(false);
  });

  it("proposes nothing when a run learned nothing", () => {
    expect(proposeRunLearnings({ insights: [], steps: [] })).toEqual([]);
  });
  describe("applyLearningProposal", () => {
    it("writes a memory into the workspace it was learned on", async () => {
      const invoke = vi.fn(async () => "users-deleted-at");
      const memory = proposeRunLearnings({ insights: [insight()], steps: [] }).find(
        (proposal) => proposal.kind === "memory",
      );
      const path = await applyLearningProposal(
        memory as LearningProposal,
        { connectionId: "conn-1", database: "shop" },
        invoke as unknown as LearningInvoker,
      );

      expect(invoke).toHaveBeenCalledWith(
        "save_agent_memory",
        expect.objectContaining({
          name: "users-deleted-at-soft-delete-candidate",
          connectionId: "conn-1",
          database: "shop",
          body: expect.stringContaining(EVIDENCE_SQL),
        }),
      );
      expect(path).toBe("users-deleted-at");
    });

    it("writes a rule through the guardrail command", async () => {
      const invoke = vi.fn(async () => "/data/rules/flagged-column-users-deleted-at.md");
      const rule = proposeRunLearnings({ insights: [insight()], steps: [] })[0];
      await applyLearningProposal(
        rule,
        { connectionId: "conn-1", database: "shop" },
        invoke as unknown as LearningInvoker,
      );

      expect(invoke).toHaveBeenCalledWith("save_agent_rule", {
        name: "flagged-column-users-deleted-at",
        description: expect.stringContaining("effectively unused"),
        event: "pre_read",
        action: "warn",
        pattern: "(?i)\\bdeleted_at\\b",
        patternNot: null,
        scan: "skeleton",
      });
    });

    it("writes a skill with the procedure as its body", async () => {
      const invoke = vi.fn(async () => "/data/skills/check-users");
      const skill = proposeRunLearnings({ insights: [], steps: cleanRun() }).find(
        (proposal) => proposal.kind === "skill",
      );
      await applyLearningProposal(
        skill as LearningProposal,
        {},
        invoke as unknown as LearningInvoker,
      );

      expect(invoke).toHaveBeenCalledWith("create_ai_skill", {
        name: "check-users",
        description: expect.stringContaining("users"),
        body: expect.stringContaining("## Steps"),
      });
    });
  });
});
