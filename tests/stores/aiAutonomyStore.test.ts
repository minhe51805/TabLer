import { beforeEach, describe, expect, it } from "vitest";

import { useAIAutonomyStore } from "@/stores/aiAutonomyStore";

describe("aiAutonomyStore", () => {
  beforeEach(() => {
    useAIAutonomyStore.setState({ autonomyByConnection: {} });
  });

  it("defaults every connection to the restrictive level", () => {
    expect(useAIAutonomyStore.getState().getAutonomy("conn-1")).toBe("review");
  });

  it("scopes the grant to the connection it was granted on", () => {
    useAIAutonomyStore.getState().setAutonomy("conn-1", "full");
    expect(useAIAutonomyStore.getState().getAutonomy("conn-1")).toBe("full");
    expect(useAIAutonomyStore.getState().getAutonomy("conn-2")).toBe("review");
  });

  it("keeps the last grant when the panel closes (no reset to review)", () => {
    useAIAutonomyStore.getState().setAutonomy("conn-1", "full");
    useAIAutonomyStore.getState().setAutonomy("conn-1", "smart");
    expect(useAIAutonomyStore.getState().getAutonomy("conn-1")).toBe("smart");
  });
});