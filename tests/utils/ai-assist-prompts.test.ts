import { describe, expect, it } from "vitest";
import {
  buildAgentEvidenceSummary,
  buildAgentFinalRecoveryPrompt,
  buildAgentTraceMarkdown,
  buildAssistPrompt,
  buildLocalAgentFallbackResponse,
} from "@/components/AISlidePanel/ai-assist-prompts";
import type { AgentTraceStep } from "@/components/AISlidePanel/ai-agent-context";

const traceSteps: AgentTraceStep[] = [{
  step: 1,
  action: "describe_table",
  message: "Inspect users",
  observation: "TABLE=users\nSCHEMA=id:int,name:text",
}];

describe("AI assist prompts", () => {
  it("keeps general requests independent from database-only behavior", () => {
    const prompt = buildAssistPrompt("Rewrite this paragraph", "general", "agent");

    expect(prompt).toContain("capable general-purpose assistant");
    expect(prompt).toContain("not limited to database-only tasks");
    expect(prompt).toContain("Rewrite this paragraph");
    expect(prompt).not.toContain("produce runnable SQL");
  });

  it("builds intent-specific grounded instructions", () => {
    expect(buildAssistPrompt("Review it", "overview", "edit"))
      .toContain("provide a grounded overview");
    expect(buildAssistPrompt("Why is this slow?", "optimize", "edit"))
      .toContain("result must be functionally identical");
    expect(buildAssistPrompt("Fix it", "fix-error", "prompt"))
      .toContain("Return the corrected SQL");
    expect(buildAssistPrompt("List users", "sql", "agent"))
      .toContain("Use only tables and columns that exist");
  });

  it("bounds recovery table names and includes verified evidence", () => {
    const tableNames = Array.from({ length: 90 }, (_, index) => `table_${index + 1}`);
    const prompt = buildAgentFinalRecoveryPrompt({
      userPrompt: "Show signup counts",
      assistIntent: "overview",
      currentDatabase: "analytics",
      availableTableNames: tableNames,
      evidenceSummary: "SELECT count(*) returned 42",
      wantsVisualization: true,
      reason: "Provider stopped early",
    });

    expect(prompt).toContain("Current database: analytics.");
    expect(prompt).toContain("Allowed tables: table_1, table_2");
    expect(prompt).toContain(", ....");
    expect(prompt).not.toContain("table_90");
    expect(prompt).toContain("Provide a grounded database overview.");
    expect(prompt).toContain("chart-friendly SQL query");
    expect(prompt).toContain("SELECT count(*) returned 42");
  });

  it("serializes evidence and user-facing trace markdown", () => {
    expect(buildAgentEvidenceSummary([])).toBe("No verified tool observations were captured.");
    expect(buildAgentEvidenceSummary(traceSteps)).toContain("Action: describe_table");
    expect(buildAgentEvidenceSummary(traceSteps)).toContain("TABLE=users");

    const markdown = buildAgentTraceMarkdown(traceSteps);
    expect(markdown).toContain("## Agent Trace");
    expect(markdown).toContain("### Step 1: `describe_table`");
    expect(markdown).toContain("```text\nTABLE=users");
    expect(buildAgentTraceMarkdown([])).toBe("");
  });

  it("builds localized fallback responses from the latest verified step", () => {
    const vietnamese = buildLocalAgentFallbackResponse({
      language: "vi",
      currentDatabase: "sales",
      availableTableNames: ["users", "orders"],
      wantsVisualization: true,
      steps: traceSteps,
    });
    const chinese = buildLocalAgentFallbackResponse({
      language: "zh",
      currentDatabase: "sales",
      availableTableNames: ["users"],
      wantsVisualization: false,
      steps: traceSteps,
    });

    expect(vietnamese).toContain("Các bảng đã xác minh: users, orders.");
    expect(vietnamese).toContain("chart-friendly");
    expect(chinese).toContain("已验证的表：users。");
    expect(chinese).toContain("describe_table");
  });

  it("limits fallback table previews to eight entries", () => {
    const response = buildLocalAgentFallbackResponse({
      language: "en",
      currentDatabase: null,
      availableTableNames: Array.from({ length: 10 }, (_, index) => `t${index + 1}`),
      wantsVisualization: false,
      steps: [],
    });

    expect(response).toContain("Verified tables: t1, t2, t3, t4, t5, t6, t7, t8, ....");
    expect(response).not.toContain("t9");
    expect(response).toContain('database "Default"');
  });
});
