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
          metricsWidgets: [{ title: "Users", type: "scoreboard", query: "SELECT count(*) FROM users" }, { title: "", query: "SELECT 1" }],
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
    expect(result.agentWidgets).toEqual([{ title: "Users", type: "scoreboard", query: "SELECT count(*) FROM users" }]);
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
});
