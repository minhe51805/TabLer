import { describe, expect, it } from "vitest";
import tsqlSkill from "../../src-tauri/skills/tsql-dialect-mastery/SKILL.md?raw";
import {
  appendAgentFacts,
  parseAgentFacts,
  type AgentTraceStep,
} from "@/components/AISlidePanel/ai-agent-context";
import { buildAgentControllerPrompt } from "@/components/AISlidePanel/ai-agent-controller-prompt";
import { buildSchemaRegroundingPrompt } from "@/components/AISlidePanel/ai-agent-grounding";
import {
  computeSampleColumnStats,
  normalizeAgentPlanSteps,
  resolveColumnStatsScope,
} from "@/components/AISlidePanel/ai-agent-tool-executor";
import {
  AI_AGENT_COLUMN_STATS_MAX_TABLE_ROWS,
  AI_AGENT_TOOL_NAMES,
} from "@/components/AISlidePanel/ai-agent-tools";
import {
  AI_AGENT_TOOL_SPECS,
  formatAgentToolCatalog,
  nativeToolPayloadForProvider,
} from "@/components/AISlidePanel/ai-agent-tool-schema";
import { verifyAgentResponseAgainstEvidence } from "@/components/AISlidePanel/ai-agent-verification";
import { runAIAgentToolLoop } from "@/components/AISlidePanel/ai-agent-runner";
import type { AIAgentToolAction } from "@/components/AISlidePanel/ai-agent-tools";

/**
 * Agent golden-set eval (audit follow-up): table-driven checks over the agent's
 * pure decision gates. Every case is a pass/fail behavior contract — this file
 * is the regression floor the CI "Agent golden-set eval" step runs.
 */

const step = (observation: string): AgentTraceStep => ({
  step: 1,
  action: "sample_table_data",
  message: "peek",
  observation,
});

describe("eval: sample_table_data column-stats gate (no full-table scans)", () => {
  it("falls back to sample-scoped stats for large or unknown-size tables", () => {
    expect(resolveColumnStatsScope(undefined, AI_AGENT_COLUMN_STATS_MAX_TABLE_ROWS)).toBe("whole");
    expect(resolveColumnStatsScope(undefined, AI_AGENT_COLUMN_STATS_MAX_TABLE_ROWS + 1)).toBe(
      "sample",
    );
    expect(resolveColumnStatsScope(undefined, null)).toBe("sample");
    expect(resolveColumnStatsScope(undefined, 42)).toBe("whole");
  });

  it("honors explicit stats args", () => {
    expect(resolveColumnStatsScope("off", 1)).toBe("off");
    expect(resolveColumnStatsScope("sample", 1)).toBe("sample");
  });

  it("computes honest in-memory stats from the sampled rows", () => {
    const rows = [
      ["a", 1, null],
      ["a", 2, "x"],
      ["b", null, ""],
    ];
    const stats = computeSampleColumnStats(rows, [
      { name: "c1", index: 0 },
      { name: "c2", index: 1 },
      { name: "c3", index: 2 },
    ]);
    expect(stats).toEqual([
      { column: "c1", nullRatio: 0, distinctCount: 2 },
      { column: "c2", nullRatio: 0.333, distinctCount: 2 },
      { column: "c3", nullRatio: 0.667, distinctCount: 1 },
    ]);
  });
});

describe("eval: claim verification (fabrications caught, noise ignored)", () => {
  it("accuses figures no tool ever observed", () => {
    const result = verifyAgentResponseAgainstEvidence(
      "The customers table holds 12345 active rows and 987 pending tickets in total.",
      [step('{"rowCount": 40}')],
    );
    expect(result.ok).toBe(false);
    expect(result.unsupported).toContain(12345);
    expect(result.unsupported).toContain(987);
  });

  it("ignores numbers inside code spans, dates, and versions", () => {
    const result = verifyAgentResponseAgainstEvidence(
      [
        "Schema check on 2024-01-05 against build 1.2.3:",
        "run `SELECT COUNT(*) FROM orders LIMIT 100` first.",
      ].join(" "),
      [],
    );
    expect(result.unsupported).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("accepts rounded restatements of witnessed figures", () => {
    const result = verifyAgentResponseAgainstEvidence("Approximately 2,400 orders were placed.", [
      step('{"rowCount": 2401}'),
    ]);
    expect(result.unsupported).toEqual([]);
  });

  it("resolves locale-ambiguous separators against either reading", () => {
    const result = verifyAgentResponseAgainstEvidence("The sample shows 1.234 distinct emails.", [
      step('{"rowCount": 1234}'),
    ]);
    expect(result.unsupported).toEqual([]);
  });

  it("witnesses figures from structured step.facts without any text parsing", () => {
    const factsStep: AgentTraceStep = {
      step: 1,
      action: "sample_table_data",
      message: "peek",
      // Observation text deliberately carries none of the witnessed numbers.
      observation: "sampled the customers table",
      facts: {
        rowsReturned: 2401,
        columnStats: [{ column: "email", nullRatio: 0.12, distinctCount: 88 }],
      },
    };
    const result = verifyAgentResponseAgainstEvidence(
      "Found 2,401 rows; the email column has 88 distinct values (12% null).",
      [factsStep],
    );
    expect(result.unsupported).toEqual([]);
    expect(result.ok).toBe(true);

    const fabricated = verifyAgentResponseAgainstEvidence(
      "Found 2,401 rows and exactly 1,200 duplicate accounts.",
      [factsStep],
    );
    expect(fabricated.unsupported).toContain(1200);
  });
});

describe("eval: update_plan and delegate are first-class registry tools", () => {
  it("registers both tools with executable specs", () => {
    expect(AI_AGENT_TOOL_NAMES).toContain("update_plan");
    expect(AI_AGENT_TOOL_NAMES).toContain("delegate");
    expect(AI_AGENT_TOOL_SPECS.update_plan.parameters.required).toEqual(["steps"]);
    expect(AI_AGENT_TOOL_SPECS.delegate.parameters.required).toEqual(["instruction"]);
    // Both stay available even when workspace SQL tools are off.
    const disabled = new Set(
      formatAgentToolCatalog(false).map((line) => line.match(/"action":"([^"]+)"/)?.[1]),
    );
    expect(disabled.has("update_plan")).toBe(true);
    expect(disabled.has("delegate")).toBe(true);
  });

  it("travels in the native function-calling payload", () => {
    const payload = nativeToolPayloadForProvider("openai");
    const names = (payload.tools as Array<{ function: { name: string } }>).map(
      (tool) => tool.function.name,
    );
    expect(names).toContain("update_plan");
    expect(names).toContain("delegate");
  });
});

describe("eval: update_plan checklist normalization", () => {
  it("drops junk entries, defaults statuses, caps the list, and trims titles", () => {
    const plan = normalizeAgentPlanSteps(
      [
        { title: "  Locate the orders table  ", status: "in_progress" },
        { title: "" },
        "not an object",
        { title: "Check null ratios" },
        { title: "Report", status: "banana" },
        { title: "Finish", status: "done" },
      ],
      3,
    );
    expect(plan).toEqual([
      { title: "Locate the orders table", status: "in_progress" },
      { title: "Check null ratios", status: "pending" },
      { title: "Report", status: "pending" },
    ]);
    expect(normalizeAgentPlanSteps("nope", 8)).toEqual([]);
  });
});

describe("eval: regrounding prompts are localized for ko/tr", () => {
  it("emits Korean and Turkish re-grounding instructions", () => {
    const ko = buildSchemaRegroundingPrompt("ko", "sales", ["orders"], "explain", "q");
    expect(ko).toContain("처음부터 다시");
    expect(ko).toContain("orders");
    const tr = buildSchemaRegroundingPrompt("tr", "sales", ["orders"], "overview", "q");
    expect(tr).toContain("Baştan yanıt verin");
    expect(tr).toContain("orders");
  });
});

describe("eval: @@facts footer survives prompt clamping and never reaches the UI", () => {
  const footer = appendAgentFacts("body", { rowsReturned: 7 });
  const longObservation = `${"x".repeat(3000)}\n${footer}`;

  it("keeps the footer parseable after the observation clamp", () => {
    const prompt = buildAgentControllerPrompt({
      userPrompt: "summarize orders",
      assistIntent: "sql",
      currentDatabase: null,
      availableTableNames: ["orders"],
      steps: [
        { step: 1, action: "sample_table_data", message: "peek", observation: longObservation },
      ],
      workspaceToolsEnabled: false,
    });
    expect(prompt).toContain("[observation truncated]");
    const footerMatch = prompt.match(/@@facts:(\{.*\})/);
    expect(footerMatch).not.toBeNull();
    const parsed = JSON.parse(footerMatch![1]) as { rowsReturned?: number };
    expect(parsed.rowsReturned).toBe(7);
  });

  it("strips the footer from the display text while keeping the facts", () => {
    const { text, facts } = parseAgentFacts(longObservation);
    expect(text).not.toContain("@@facts:");
    expect(facts?.rowsReturned).toBe(7);
    expect(text.startsWith("x")).toBe(true);
  });
});

describe("eval: Mongo HAVING recovery stays bounded", () => {
  it("aggregate with HAVING on Mongo finishes within eight steps without a statement storm", async () => {
    const havingSql = "SELECT status, COUNT(*) FROM orders GROUP BY status HAVING COUNT(*) > 1";
    const recoveredSql =
      "SELECT * FROM (SELECT status, COUNT(*) AS total FROM orders GROUP BY status) WHERE total > 1 LIMIT 50";
    const actions: AIAgentToolAction[] = [
      { action: "run_readonly_sql", message: "Aggregate orders", args: { sql: havingSql } },
      { action: "run_readonly_sql", message: "Wrap the aggregation", args: { sql: recoveredSql } },
      { action: "finish", message: "Report", args: { response: "Aggregation completed." } },
    ];
    const statements: string[] = [];
    let actionIndex = 0;
    const result = await runAIAgentToolLoop({
      workspaceToolsEnabled: true,
      stepBudget: 8,
      requestAction: async () => actions[actionIndex++],
      runTool: async (action) => {
        const sql = String((action.args as { sql?: string } | undefined)?.sql ?? "");
        statements.push(sql);
        if (sql === havingSql) {
          return "Tool error: This sandbox accepts SQL only. HAVING is not supported — wrap the aggregation in an outer SELECT; use LIMIT/OFFSET for paging.";
        }
        return '{"sandboxed":true,"rows":[]}';
      },
      recoverFinish: async () => ({
        action: "finish",
        message: "Recover",
        args: { response: "Recovered." },
      }),
    });

    expect(result.finalAction.action).toBe("finish");
    expect(result.steps.length).toBeLessThanOrEqual(8);
    expect(statements).toEqual([havingSql, recoveredSql]);
    expect(
      statements.some(
        (statement) => statements.filter((candidate) => candidate === statement).length >= 3,
      ),
    ).toBe(false);
  });
});

describe("eval: MSSQL dialect cheat-sheet", () => {
  it("MSSQL case never emits NOW()", () => {
    const currentTimeFunction =
      tsqlSkill.includes("| `NOW()`") && tsqlSkill.includes("`GETDATE()`") ? "GETDATE()" : "NOW()";
    const emittedSql = `SELECT ${currentTimeFunction} AS current_time`;
    expect(emittedSql).toContain("GETDATE()");
    expect(emittedSql).not.toMatch(/\bNOW\s*\(/i);
  });
});
