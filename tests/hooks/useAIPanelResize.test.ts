import { describe, expect, it } from "vitest";

import {
  AI_PANEL_DEFAULT_WIDTH,
  AI_PANEL_MAX_WIDTH,
  AI_PANEL_MIN_WIDTH,
  clampAIPanelWidth,
  getAIPanelDisplayWidth,
} from "@/hooks/useAIPanelResize";

describe("clampAIPanelWidth", () => {
  it("keeps the AI panel inside its layout bounds", () => {
    expect(clampAIPanelWidth(120, 1600)).toBe(AI_PANEL_MIN_WIDTH);
    expect(clampAIPanelWidth(480, 1600)).toBe(480);
    expect(clampAIPanelWidth(1200, 1600)).toBe(AI_PANEL_MAX_WIDTH);
  });

  it("caps the preferred width in side-by-side mode", () => {
    expect(clampAIPanelWidth(900, 1101)).toBe(AI_PANEL_MAX_WIDTH);
  });

  it("almost fills the viewport in overlay mode without exceeding the max", () => {
    expect(clampAIPanelWidth(900, 900)).toBe(800);
  });

  it("falls back to the default for non-finite values", () => {
    expect(clampAIPanelWidth(Number.NaN, 1600)).toBe(AI_PANEL_DEFAULT_WIDTH);
  });
});

describe("getAIPanelDisplayWidth", () => {
  it("preserves the preferred width on a wide desktop", () => {
    expect(getAIPanelDisplayWidth(AI_PANEL_DEFAULT_WIDTH, 1280)).toBe(448);
    expect(getAIPanelDisplayWidth(600, 1200)).toBe(600);
  });

  it("caps the drawer at 420px without shrinking the workspace", () => {
    expect(getAIPanelDisplayWidth(AI_PANEL_DEFAULT_WIDTH, 1024)).toBe(420);
    expect(getAIPanelDisplayWidth(360, 1024)).toBe(360);
  });

  it("keeps the side-by-side workspace accessible just above the drawer breakpoint", () => {
    expect(getAIPanelDisplayWidth(800, 1101)).toBe(581);
  });
});
