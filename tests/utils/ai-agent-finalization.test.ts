import { describe, expect, it } from "vitest";

import { finalizeAgentResult } from "@/components/AISlidePanel/ai-agent-finalization";

describe("agent finalization", () => {
  it("surfaces schema-valid SQL, trace steps, and valid dashboard widgets", async () => {
    const result = await finalizeAgentResult({
      availableSchemaTables: ["users"],
      buildControllerPrompt: () => "repair",
      initialAction: {
        action: "finish",
        message: "Done",
        args: {
          response: "Here is the answer.",
          sql: "SELECT count(*) FROM users",
          metricsWidgets: [{ title: "Users", type: "scoreboard", query: "SELECT count(*) AS total FROM users", measures: ["total"], transforms: ["count"], limit: 1 }, { title: "", query: "SELECT 1" }],
        },
      },
      initialSteps: [{ step: 1, action: "list_tables", message: "Inspect", observation: "TABLES=users" }],
      recoverFinishAction: async () => { throw new Error("should not recover"); },
      requestAgentAction: async () => { throw new Error("should not repair"); },
      sharedAgentInstruction: "grounded",
    });

    expect(result.sql).toBe("SELECT count(*) FROM users");
    expect(result.rawResponse).toBe("Here is the answer.");
    expect(result.rawResponse).not.toContain("Agent Trace");
    expect(result.agentSteps).toHaveLength(1);
    expect(result.agentWidgets).toEqual([{
      title: "Users",
      type: "scoreboard",
      query: "SELECT count(*) AS total FROM users",
      dimension: undefined,
      measures: ["total"],
      transforms: ["count"],
      limit: 1,
    }]);
  });

  it("repairs SQL that references a table outside the verified schema", async () => {
    const result = await finalizeAgentResult({
      availableSchemaTables: ["users"],
      buildControllerPrompt: () => "repair",
      initialAction: { action: "finish", message: "Wrong", args: { sql: "SELECT * FROM invoices" } },
      initialSteps: [],
      recoverFinishAction: async () => ({ action: "finish", message: "Recovered", args: { sql: "SELECT * FROM users" } }),
      requestAgentAction: async () => ({ action: "list_tables", message: "Not a finish", args: {} }),
      sharedAgentInstruction: "grounded",
    });

    expect(result.sql).toBe("SELECT * FROM users");
    expect(result.rawResponse).toBe("Recovered");
    expect(result.rawResponse).not.toContain("Agent Trace");
  });

  it("repairs SQL that fails sandbox validation and keeps the verified fix", async () => {
    const validated: string[] = [];
    const result = await finalizeAgentResult({
      availableSchemaTables: ["users"],
      buildControllerPrompt: () => "repair",
      initialAction: {
        action: "finish",
        message: "Done",
        args: {
          response: "Sandbox đã đúng thực thi.",
          sql: "SELECT table_name, row_count FROM information_schema.tables",
        },
      },
      initialSteps: [],
      recoverFinishAction: async () => { throw new Error("should not recover"); },
      requestAgentAction: async () => ({
        action: "finish",
        message: "Fixed",
        args: { response: "Row counts from the verified catalog.", sql: "SELECT name, 0 AS row_count FROM users" },
      }),
      sharedAgentInstruction: "grounded",
      validateSql: async (sql) => {
        validated.push(sql);
        return sql.includes("information_schema") ? "column \"row_count\" does not exist" : null;
      },
    });

    expect(validated).toEqual([
      "SELECT table_name, row_count FROM information_schema.tables",
      "SELECT name, 0 AS row_count FROM users",
    ]);
    expect(result.sql).toBe("SELECT name, 0 AS row_count FROM users");
    expect(result.rawResponse).not.toContain("sandbox validation");
    expect(result.agentSteps?.some((s) => s.status === "error")).toBe(true);
  });

  it("appends an honest validation warning when the repair still fails", async () => {
    const result = await finalizeAgentResult({
      availableSchemaTables: ["users"],
      buildControllerPrompt: () => "repair",
      initialAction: {
        action: "finish",
        message: "Done",
        args: { response: "All good.", sql: "SELECT bogus FROM users" },
      },
      initialSteps: [],
      recoverFinishAction: async () => { throw new Error("should not recover"); },
      requestAgentAction: async () => ({
        action: "finish",
        message: "Still wrong",
        args: { response: "All good.", sql: "SELECT bogus2 FROM users" },
      }),
      sharedAgentInstruction: "grounded",
      validateSql: async () => "column does not exist",
    });

    expect(result.sql).toBe("SELECT bogus2 FROM users");
    expect(result.rawResponse).toContain("sandbox validation");
    expect(result.rawResponse).toContain("column does not exist");
  });
});
