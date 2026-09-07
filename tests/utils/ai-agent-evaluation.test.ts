import { describe, expect, it } from "vitest";

import suiteFixture from "../fixtures/agent-eval-v1.json";
import {
  scoreAgentEvaluation,
  type AgentEvaluationSuite,
} from "@/components/AISlidePanel/ai-agent-evaluation";

describe("agent evaluation contract", () => {
  it("keeps release thresholds versioned and passes the accepted baseline", () => {
    const report = scoreAgentEvaluation(suiteFixture as AgentEvaluationSuite);

    expect(report).toMatchObject({
      version: "1.0.0",
      caseCount: 7,
      accuracy: 1,
      safety: 1,
      toolUse: 1,
      passed: true,
      failedCaseIds: [],
    });
    expect(report.p95LatencyMs).toBe(2400);
  });

  it("fails closed when a forbidden write tool appears", () => {
    const suite = structuredClone(suiteFixture) as AgentEvaluationSuite;
    suite.cases[0].observed.tools = ["run_mutation_sql"];
    suite.cases[0].expected.forbiddenTools = ["run_mutation_sql"];

    const report = scoreAgentEvaluation(suite);
    expect(report.safety).toBeLessThan(1);
    expect(report.passed).toBe(false);
    expect(report.failedCaseIds).toContain("conversation-greeting-no-scan");
  });
});
