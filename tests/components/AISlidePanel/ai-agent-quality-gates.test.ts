import { describe, expect, it } from "vitest";
import { appendAgentFacts, parseAgentFacts } from "@/components/AISlidePanel/ai-agent-context";
import {
  buildAgentRecoveryInstruction,
  buildRunnerInstructionForReason,
  evaluateEvidenceGate,
  finishHasSql,
  formatActionFailureReason,
  hasExecutedReadStep,
  hasSuccessfulReadStep,
  MAX_EVIDENCE_ROUNDS,
  responseClaimsSuccessfulExecution,
  responseHasMarkdownTable,
} from "@/components/AISlidePanel/ai-agent-quality-gates";
import type { AgentTraceStep } from "@/components/AISlidePanel/ai-agent-context";
import type { AIAgentFinishAction } from "@/components/AISlidePanel/ai-agent-tools";

function step(partial: Partial<AgentTraceStep>): AgentTraceStep {
  return {
    step: 1,
    action: "run_readonly_sql",
    message: "msg",
    observation: "ok",
    ...partial,
  } as AgentTraceStep;
}

function finishAction(args?: Record<string, unknown>): AIAgentFinishAction {
  return {
    action: "finish",
    message: "done",
    args: args ?? {},
  } as unknown as AIAgentFinishAction;
}

describe("hasExecutedReadStep", () => {
  it("returns true for a successful readonly SQL step", () => {
    expect(hasExecutedReadStep([step({ action: "run_readonly_sql", observation: "id | name" })])).toBe(true);
  });

  it("returns true for a successful sample_table_data step", () => {
    expect(hasExecutedReadStep([step({ action: "sample_table_data", observation: "rows..." })])).toBe(true);
  });

  it("returns false when the observation starts with Tool error or Tool blocked", () => {
    expect(hasExecutedReadStep([step({ observation: "Tool error: timeout" })])).toBe(false);
    expect(hasExecutedReadStep([step({ observation: "Tool blocked by policy" })])).toBe(false);
  });

  it("returns false for non-read actions even with observations", () => {
    expect(hasExecutedReadStep([step({ action: "describe_tables" as never })])).toBe(false);
  });

  it("returns false for empty input", () => {
    expect(hasExecutedReadStep([])).toBe(false);
  });
});

describe("finishHasSql", () => {
  it("is true when sql is a non-empty string", () => {
    expect(finishHasSql(finishAction({ sql: "SELECT 1" }))).toBe(true);
    expect(finishHasSql(finishAction({ sql: "   x " }))).toBe(true);
  });

  it("is false for missing, empty or whitespace-only sql", () => {
    expect(finishHasSql(finishAction({}))).toBe(false);
    expect(finishHasSql(finishAction({ sql: "" }))).toBe(false);
    expect(finishHasSql(finishAction({ sql: "   " }))).toBe(false);
  });

  it("is false when args is missing entirely", () => {
    const action = {} as unknown as AIAgentFinishAction;
    expect(finishHasSql(action)).toBe(false);
  });
});

describe("responseHasMarkdownTable", () => {
  it("detects a standard markdown table", () => {
    const md = "Here:\n\n| id | name |\n| --- | --- |\n| 1 | a |\n";
    expect(responseHasMarkdownTable(md)).toBe(true);
  });

  it("accepts separator rows with colons", () => {
    const md = "| a | b |\n| :-- | --: |\n| 1 | 2 |";
    expect(responseHasMarkdownTable(md)).toBe(true);
  });

  it("rejects plain text and pipe-less content", () => {
    expect(responseHasMarkdownTable("no table here")).toBe(false);
    expect(responseHasMarkdownTable(undefined)).toBe(false);
  });
});

describe("formatActionFailureReason", () => {
  it("uses the message of an Error instance", () => {
    expect(formatActionFailureReason(new Error("boom"))).toBe("boom");
  });

  it("stringifies non-error values", () => {
    expect(formatActionFailureReason("plain")).toBe("plain");
    expect(formatActionFailureReason(42)).toBe("42");
    expect(formatActionFailureReason(null)).toBe("null");
  });
});

describe("MAX_EVIDENCE_ROUNDS", () => {
  it("stays bounded at 2 rounds", () => {
    expect(MAX_EVIDENCE_ROUNDS).toBe(2);
  });
});

describe("evaluateEvidenceGate", () => {
  const sqlFinish = finishAction({ sql: "SELECT 1", response: "| a |\n| - |\n| 1 |" });
  const noSqlFinish = finishAction({ response: "I checked the data." });

  it("short-circuits to no-more-evidence when the action is not a finish", () => {
    const action = { action: "run_readonly_sql" } as unknown as AIAgentFinishAction;
    const gate = evaluateEvidenceGate({ finalAction: action, steps: [], wantsReportTable: true });
    expect(gate.isFinish).toBe(false);
    expect(gate.needsMoreEvidence).toBe(false);
  });

  it("flags missing data when finish has no SQL and no read step ran", () => {
    const gate = evaluateEvidenceGate({ finalAction: noSqlFinish, steps: [], wantsReportTable: false });
    expect(gate.missingData).toBe(true);
    expect(gate.needsMoreEvidence).toBe(true);
    expect(gate.composeOnly).toBe(false);
  });

  it("passes when SQL is present and a read step produced evidence", () => {
    const gate = evaluateEvidenceGate({
      finalAction: sqlFinish,
      steps: [step({ action: "run_readonly_sql", observation: "id | name" })],
      wantsReportTable: true,
    });
    expect(gate.missingData).toBe(false);
    expect(gate.missingReportTable).toBe(false);
    expect(gate.verification.ok).toBe(true);
    expect(gate.needsMoreEvidence).toBe(false);
    expect(gate.composeOnly).toBe(true);
  });

  it("requires a report table when the user asked for one and none exists", () => {
    const gate = evaluateEvidenceGate({
      finalAction: finishAction({ sql: "SELECT 1", response: "plain text answer" }),
      steps: [step({})],
      wantsReportTable: true,
    });
    expect(gate.missingReportTable).toBe(true);
    expect(gate.needsMoreEvidence).toBe(true);
  });

  it("ignores the report-table requirement when the user did not ask for a table", () => {
    const gate = evaluateEvidenceGate({
      finalAction: finishAction({ sql: "SELECT 1", response: "plain text answer" }),
      steps: [step({})],
      wantsReportTable: false,
    });
    expect(gate.missingReportTable).toBe(false);
  });
});

describe("buildAgentRecoveryInstruction", () => {
  type Verification = ReturnType<
    typeof import("@/components/AISlidePanel/ai-agent-verification")["verifyAgentResponseAgainstEvidence"]
  >;
  const okVerification = { ok: true, unsupported: [] } as Verification;
  const badVerification = {
    ok: false,
    unsupported: [3, 7, 12],
  } as Verification;

  it("compose-only branch instructs building the table from gathered evidence", () => {
    const instruction = buildAgentRecoveryInstruction({
      lastChance: false,
      composeOnly: true,
      verification: okVerification,
    });
    expect(instruction).toContain("evidence is already gathered");
  });

  it("final-round branch warns this is the last chance", () => {
    const instruction = buildAgentRecoveryInstruction({
      lastChance: true,
      composeOnly: false,
      verification: okVerification,
    });
    expect(instruction).toContain("final round");
  });

  it("unsupported-figures branch lists up to four cited figures", () => {
    const instruction = buildAgentRecoveryInstruction({
      lastChance: false,
      composeOnly: false,
      verification: badVerification,
    });
    expect(instruction).toContain("3, 7, 12");
  });

  it("default branch demands real workspace reads", () => {
    const instruction = buildAgentRecoveryInstruction({
      lastChance: false,
      composeOnly: false,
      verification: okVerification,
    });
    expect(instruction).toContain("sample_table_data");
  });
});

describe("buildRunnerInstructionForReason", () => {
  const shared = "SHARED";

  it("direct reason appends general-assistant guidance", () => {
    const out = buildRunnerInstructionForReason("direct", shared);
    expect(out).toContain("general-purpose assistant");
    expect(out).toContain(shared);
  });

  it("budget reason appends budget guidance", () => {
    const out = buildRunnerInstructionForReason("budget", shared);
    expect(out).toContain("tool budget");
  });

  it("iterate reason returns the shared instruction unchanged", () => {
    expect(buildRunnerInstructionForReason("iterate", shared)).toBe(shared);
  });
});

describe("false-success gate", () => {
  it("flags a success claim when every read step failed", () => {
    const evaluation = evaluateEvidenceGate({
      finalAction: finishAction({
        response: "Sandbox đã đúng thực thi, dữ liệu sẵn sàng.",
        sql: "SELECT 1 FROM users",
      }),
      steps: [step({ action: "run_readonly_sql", observation: "Tool error: column \"row_count\" does not exist" })],
      wantsReportTable: false,
    });
    expect(evaluation.falseSuccessClaim).toBe(true);
    expect(evaluation.needsMoreEvidence).toBe(true);
    expect(evaluation.composeOnly).toBe(false);
  });

  it("does not flag a success claim backed by a real sandbox read", () => {
    const evaluation = evaluateEvidenceGate({
      finalAction: finishAction({
        response: "The query executed successfully — 120 rows total.",
        sql: "SELECT count(*) FROM users",
      }),
      steps: [step({
        action: "run_readonly_sql",
        observation: "{\"rowCount\":120,\"sandboxed\":true,\"columns\":[\"count:int8\"]}",
      })],
      wantsReportTable: false,
    });
    expect(evaluation.falseSuccessClaim).toBe(false);
    expect(evaluation.needsMoreEvidence).toBe(false);
  });

  it("recovery instruction for a false success tells the model to fix and re-run", () => {
    const instruction = buildAgentRecoveryInstruction({
      lastChance: false,
      composeOnly: false,
      falseSuccessClaim: true,
      verification: { ok: true, unsupported: [] },
    });
    expect(instruction).toContain("FAILED");
    expect(instruction).toContain("list_tables rowCount");
  });
});

describe("structured facts (roadmap #7)", () => {
  it("readStepFacts parses the footer and strips it from display text", () => {
    const { text, facts } = parseAgentFacts(
      'rows preview\n{"sandboxed":true}\n@@facts:{"rowsReturned":7,"tables":["users"]}',
    );
    expect(text).toBe('rows preview\n{"sandboxed":true}');
    expect(facts).toEqual({ rowsReturned: 7, tables: ["users"] });
  });

  it("hasSuccessfulReadStep trusts facts over the legacy regex", () => {
    // Facts say 0 rows returned → NOT a successful read, even though the
    // observation mentions "sandboxed" (legacy regex would have passed it).
    expect(
      hasSuccessfulReadStep([
        {
          step: 1,
          action: "run_readonly_sql",
          message: "query",
          observation:
            '{"sandboxed":true,"rows":[]}\n@@facts:{"rowsReturned":0}',
        },
      ]),
    ).toBe(false);
    // Facts say 3 rows → successful, even without the legacy marker.
    expect(
      hasSuccessfulReadStep([
        {
          step: 1,
          action: "run_readonly_sql",
          message: "query",
          observation: 'plain result\n@@facts:{"rowsReturned":3}',
        },
      ]),
    ).toBe(true);
  });

  it("round-trips appendAgentFacts", () => {
    const observation = appendAgentFacts("sample ok", {
      rowsReturned: 4,
      columnStats: [{ column: "age", nullRatio: 0.1, distinctCount: 22 }],
    });
    const { facts } = parseAgentFacts(observation);
    expect(facts).toEqual({
      rowsReturned: 4,
      columnStats: [{ column: "age", nullRatio: 0.1, distinctCount: 22 }],
    });
    expect(parseAgentFacts("no facts here").facts).toBeNull();
  });
});

describe("responseClaimsSuccessfulExecution", () => {
  it("detects English success claims", () => {
    expect(responseClaimsSuccessfulExecution("The query ran successfully.")).toBe(true);
    expect(responseClaimsSuccessfulExecution("I successfully executed the sandbox.")).toBe(true);
  });

  it("detects Vietnamese success claims", () => {
    expect(responseClaimsSuccessfulExecution("Tôi đã chạy thành công truy vấn.")).toBe(true);
  });

  it("detects Turkish success claims", () => {
    expect(responseClaimsSuccessfulExecution("Sorgu başarıyla çalıştırıldı.")).toBe(true);
    expect(responseClaimsSuccessfulExecution("Sorgu başarılı şekilde çalıştı.")).toBe(true);
    expect(responseClaimsSuccessfulExecution("Sorgu başarılı.")).toBe(true);
  });

  it("does not flag ordinary answers", () => {
    expect(responseClaimsSuccessfulExecution("Here are the top 5 users by sales.")).toBe(false);
    expect(responseClaimsSuccessfulExecution(undefined)).toBe(false);
  });
});
