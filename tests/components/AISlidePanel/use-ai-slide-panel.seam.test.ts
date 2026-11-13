import { describe, expect, it } from "vitest";
import facadeSource from "@/components/AISlidePanel/ai-agent-generate.ts?raw";
import contextLoaderSource from "@/components/AISlidePanel/agent-engine/context-loader.ts?raw";
import turnDriverSource from "@/components/AISlidePanel/agent-engine/turn-driver.ts?raw";

const hookSource = [facadeSource, contextLoaderSource, turnDriverSource].join("\n");

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

  it("marks truncated tab sql so the model never sees a silent partial view", () => {
    expect(hookSource).toContain("…[TRUNCATED");
  });
});
