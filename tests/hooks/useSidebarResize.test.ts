import { describe, expect, it } from "vitest";

import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
} from "@/hooks/useSidebarResize";

describe("clampSidebarWidth", () => {
  it("keeps the sidebar inside its layout bounds", () => {
    expect(clampSidebarWidth(120)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(380)).toBe(380);
    expect(clampSidebarWidth(900)).toBe(SIDEBAR_MAX_WIDTH);
  });
});
