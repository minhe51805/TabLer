import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useWorkspaceEventBridge } from "@/hooks/useWorkspaceEventBridge";
import { useAppLayoutStore } from "@/stores/appLayoutStore";
import { useModalStore } from "@/stores/modalStore";

describe("useWorkspaceEventBridge", () => {
  beforeEach(() => {
    useAppLayoutStore.setState({ isSidebarCollapsed: true, leftPanel: "database" });
    useModalStore.setState({ showAISettings: false });
  });

  it("routes workspace events to their owning UI state", () => {
    const openAI = vi.fn();
    const container = document.createElement("div");
    const root = createRoot(container);

    function Harness() {
      const [activity, setActivity] = useState({});
      useWorkspaceEventBridge({
        openAI,
        openAIWorkspaceQuery: vi.fn(),
        openAIMetricsBoard: vi.fn(),
        setWorkspaceActivity: setActivity,
      });
      return <output>{JSON.stringify(activity)}</output>;
    }

    act(() => root.render(<Harness />));

    act(() => {
      window.dispatchEvent(
        new CustomEvent("open-ai-slide-panel", {
          detail: { prompt: "Explain", attachment: { text: "SELECT 1", source: "Query" } },
        }),
      );
      window.dispatchEvent(
        new CustomEvent("open-left-sidebar-panel", { detail: { panel: "metrics" } }),
      );
      window.dispatchEvent(new CustomEvent("open-ai-settings"));
      window.dispatchEvent(
        new CustomEvent("workspace-activity", {
          detail: { connectionId: "one", label: " Query ", durationMs: 12.6 },
        }),
      );
    });

    expect(openAI).toHaveBeenCalledWith("Explain", {
      text: "SELECT 1",
      source: "Query",
    });
    expect(useAppLayoutStore.getState()).toMatchObject({
      isSidebarCollapsed: false,
      leftPanel: "metrics",
    });
    expect(useModalStore.getState().showAISettings).toBe(true);
    expect(JSON.parse(container.textContent || "{}") as Record<string, unknown>).toMatchObject({
      one: { label: "Query", durationMs: 13 },
    });
    act(() => root.unmount());
  });
});
