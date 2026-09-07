import { describe, expect, it } from "vitest";

import {
  AI_PANEL_DEFAULT_WIDTH,
  AI_PANEL_MAX_WIDTH,
  AI_PANEL_MIN_WIDTH,
  clampAIPanelWidth,
} from "@/hooks/useAIPanelResize";

describe("clampAIPanelWidth", () => {
  it("keeps the AI panel inside its layout bounds", () => {
    expect(clampAIPanelWidth(120, 1600)).toBe(AI_PANEL_MIN_WIDTH);
    expect(clampAIPanelWidth(480, 1600)).toBe(480);
    expect(clampAIPanelWidth(1200, 1600)).toBe(AI_PANEL_MAX_WIDTH);
  });

  it("leaves room for the workspace on desktop", () => {
    expect(clampAIPanelWidth(800, 1000)).toBe(720);
  });

  it("almost fills the viewport in overlay mode without exceeding the max", () => {
    expect(clampAIPanelWidth(900, 900)).toBe(800);
  });

  it("falls back to the default for non-finite values", () => {
    expect(clampAIPanelWidth(Number.NaN, 1600)).toBe(AI_PANEL_DEFAULT_WIDTH);
  });
});
