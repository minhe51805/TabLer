import { beforeEach, describe, expect, it } from "vitest";
import { useSafeModeStore } from "@/stores/safeModeStore";

describe("connection safety profiles", () => {
  beforeEach(() => {
    localStorage.clear();
    useSafeModeStore.setState({
      settings: { globalLevel: 1, connectionOverrides: [], connectionEnvironments: {} },
    });
  });

  it("defaults an unconfigured production connection to Strict", () => {
    useSafeModeStore.getState().setConnectionEnvironment("prod", "production");

    expect(useSafeModeStore.getState().getEffectiveLevel("prod")).toBe(4);
  });

  it("persists an explicit per-connection safety choice", () => {
    const store = useSafeModeStore.getState();
    store.setConnectionEnvironment("staging", "staging");
    store.setConnectionOverride("staging", 1);

    expect(store.getConnectionEnvironment("staging")).toBe("staging");
    expect(store.getEffectiveLevel("staging")).toBe(1);
  });
});
