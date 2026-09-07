import { describe, expect, it } from "vitest";

import { recoverNonAgentAssistResponse } from "@/components/AISlidePanel/ai-assist-recovery";

function baseOptions() {
  return {
    appLanguage: "en" as const,
    availableSchemaTables: ["users"],
    context: "SCHEMA=users",
    currentDatabase: "app",
    fastRemoteRecovery: false,
    isCurrentRequest: () => true,
    normalizedPrompt: "show users",
    requestHistory: [],
    schemaContextEnabled: true,
    strictRecoveryContext: "SCHEMA=users",
    wantsVisualization: false,
  };
}

describe("AI assist recovery", () => {
  it("repairs an absent SQL response against the verified table allow-list", async () => {
    const prompts: string[] = [];
    const replies = ["I need more context", "```sql\nSELECT id FROM users\n```"];
    const response = await recoverNonAgentAssistResponse({
      ...baseOptions(),
      intent: "sql",
      askAI: async (prompt) => {
        prompts.push(prompt);
        return replies.shift() || "";
      },
    });

    expect(response).toContain("SELECT id FROM users");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Allowed tables only: users");
  });

  it("asks for a grounded overview when the first reply invents schema", async () => {
    const replies = ["Table invoices: stores billing records.", "## Overview\nThe users table stores profiles."];
    const response = await recoverNonAgentAssistResponse({
      ...baseOptions(),
      intent: "overview",
      askAI: async () => replies.shift() || "## Overview\nThe users table stores profiles.",
    });

    expect(response).toContain("users table");
    expect(response).not.toContain("invoices");
  });

  it("stops a replaced request before accepting a recovery result", async () => {
    await expect(recoverNonAgentAssistResponse({
      ...baseOptions(),
      intent: "sql",
      isCurrentRequest: () => false,
      askAI: async () => "SELECT id FROM users",
    })).rejects.toThrow("replaced by a newer one");
  });
});
