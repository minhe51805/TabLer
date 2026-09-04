import { describe, expect, it } from "vitest";
import hookSource from "@/components/AISlidePanel/hooks/use-ai-slide-panel.ts?raw";

describe("edit_query_sql seam pin (hook wiring tripwire)", () => {
  // Tripwire for the forgotten-wiring bug class: if the hook stops feeding
  // open query tabs (with tabIds + current SQL) into the prompt, the agent
  // loses the ability to propose fixes entirely and nothing else would fail.
  it("feeds open query tabs into the controller prompt", () => {
    expect(hookSource).toContain('tab.type === "query"');
    expect(hookSource).toContain("queryTabs,");
  });

  it("scopes the edit surface to the run's connection", () => {
    expect(hookSource).toContain("tab.connectionId === connectionId");
  });
});
