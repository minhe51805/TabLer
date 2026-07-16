import { describe, expect, it } from "vitest";

import {
  areQueryChromeStatesEqual,
  pruneTabState,
} from "@/hooks/useQueryWorkspaceState";

describe("query workspace state utilities", () => {
  it("keeps the same object when no closed-tab state needs pruning", () => {
    const state = { one: 1, two: 2 };
    expect(pruneTabState(state, new Set(["one", "two"]))).toBe(state);
  });

  it("removes state belonging to closed query tabs", () => {
    expect(pruneTabState({ one: 1, closed: 2 }, new Set(["one"]))).toEqual({ one: 1 });
  });

  it("compares every titlebar query metric", () => {
    const state = { isRunning: false, rowCount: 3, queryCount: 1 };
    expect(areQueryChromeStatesEqual(state, { ...state })).toBe(true);
    expect(areQueryChromeStatesEqual(state, { ...state, rowCount: 4 })).toBe(false);
  });
});
