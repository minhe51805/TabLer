import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDeferredAppSurfaces } from "@/hooks/useDeferredAppSurfaces";

describe("useDeferredAppSurfaces", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("mounts global modals during idle and keeps AI mounted after first open", () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    function Harness({ showAI }: { showAI: boolean }) {
      const state = useDeferredAppSurfaces(showAI, false);
      return <output>{JSON.stringify(state)}</output>;
    }

    act(() => root.render(<Harness showAI={false} />));
    act(() => vi.advanceTimersByTime(1200));
    expect(JSON.parse(container.textContent || "{}")).toMatchObject({
      hasMountedAIWorkspace: false,
      hasMountedGlobalModals: true,
    });
    act(() => root.render(<Harness showAI />));
    act(() => root.render(<Harness showAI={false} />));
    expect(JSON.parse(container.textContent || "{}").hasMountedAIWorkspace).toBe(true);
    act(() => root.unmount());
  });
});
