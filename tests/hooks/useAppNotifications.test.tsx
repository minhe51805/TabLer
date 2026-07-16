import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  normalizeToastDuration,
  useAppNotifications,
} from "@/hooks/useAppNotifications";
import { GLOBAL_TOAST_EXIT_MS } from "@/types/app-types";
import { APP_TOAST_EVENT } from "@/utils/app-toast";

describe("useAppNotifications", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("enforces enough time for the toast exit animation", () => {
    expect(normalizeToastDuration(1)).toBe(GLOBAL_TOAST_EXIT_MS + 120);
  });

  it("shows, closes, and clears app toast events", () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    function Harness() {
      const { toast } = useAppNotifications();
      return <output>{JSON.stringify(toast)}</output>;
    }

    act(() => root.render(<Harness />));
    act(() => {
      window.dispatchEvent(
        new CustomEvent(APP_TOAST_EVENT, {
          detail: { title: "Saved", tone: "success", durationMs: 500 },
        }),
      );
    });
    expect(JSON.parse(container.textContent || "null")).toMatchObject({
      title: "Saved",
      isClosing: false,
    });

    act(() => vi.advanceTimersByTime(500 - GLOBAL_TOAST_EXIT_MS));
    expect(JSON.parse(container.textContent || "null")).toMatchObject({ isClosing: true });
    act(() => vi.advanceTimersByTime(GLOBAL_TOAST_EXIT_MS));
    expect(container.textContent).toBe("null");
    act(() => root.unmount());
  });
});
