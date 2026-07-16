import { useState } from "react";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  formatDashboardWidgetType,
  useAIDashboardBubbleUpdates,
} from "@/components/AISlidePanel/hooks/use-ai-dashboard-bubble-updates";
import type { AIWorkspaceBubbleData } from "@/components/AISlidePanel/ai-workspace-types";

const loadingBubble: AIWorkspaceBubbleData = {
  id: "bubble-1",
  threadId: "thread-1",
  workspaceKey: "workspace-1",
  interactionMode: "prompt",
  kind: "assistant",
  status: "loading",
  title: "Loading",
  subtitle: "Waiting",
  prompt: "Update the dashboard",
  preview: "Working",
  detail: "",
  sql: "SELECT 1",
  x: 0,
  y: 0,
  pointer: { visible: false, x: 0, y: 0 },
  createdAt: 1,
  autoDismissAt: 2,
};

function renderDashboardBubbleUpdates(language = "en") {
  return renderHook(() => {
    const [bubbles, setBubbles] = useState<AIWorkspaceBubbleData[]>([
      loadingBubble,
      { ...loadingBubble, id: "untouched", title: "Untouched" },
    ]);
    return {
      bubbles,
      ...useAIDashboardBubbleUpdates({ language, setBubbles }),
    };
  });
}

describe("useAIDashboardBubbleUpdates", () => {
  it.each([
    ["table", "table"],
    ["scoreboard", "scoreboard"],
    ["bar", "bar chart"],
    ["horizontal-bar", "horizontal bar chart"],
    ["line", "line chart"],
    ["area", "area chart"],
    ["pie", "pie chart"],
    ["donut", "donut chart"],
    ["radial", "radial chart"],
  ] as const)("formats the %s widget label without falling back to pie", (type, label) => {
    expect(formatDashboardWidgetType(type, false)).toBe(label);
  });

  it("marks a failed dashboard action as retryable conversation context", () => {
    const { result } = renderDashboardBubbleUpdates();

    act(() => {
      result.current.updateBubbleForDashboardActionFailed(
        "bubble-1",
        "Rebuild this dashboard",
        "The board is locked.",
      );
    });

    expect(result.current.bubbles[0]).toMatchObject({
      status: "error",
      title: "Dashboard action failed",
      subtitle: "No dashboard change was applied",
      sql: undefined,
      autoDismissAt: undefined,
    });
    expect(result.current.bubbles[0].detail).toContain("The board is locked.");
    expect(result.current.bubbles[1].title).toBe("Untouched");
  });

  it("summarizes an attached dashboard locally in Vietnamese", () => {
    const { result } = renderDashboardBubbleUpdates("vi");

    act(() => {
      result.current.updateBubbleForAttachedDashboardSummary(
        "bubble-1",
        "Xem dashboard hiện tại",
        {
          source: "dashboard: Commerce",
          boardId: "board-1",
          text: [
            "Board: Commerce",
            "Widget count: 2",
            "1. [bar] Orders by day",
            "2. [scoreboard] Total users",
          ].join("\n"),
        },
      );
    });

    expect(result.current.bubbles[0]).toMatchObject({
      status: "ready",
      title: "Da doc snapshot dashboard",
      subtitle: "San sang sua truc tiep tren board hien tai",
    });
    expect(result.current.bubbles[0].detail).toContain("Board hien tai: Commerce");
    expect(result.current.bubbles[0].detail).toContain("Orders by day, Total users");
  });

  it("reports the exact replacement chart type after editing", () => {
    const { result } = renderDashboardBubbleUpdates();

    act(() => {
      result.current.updateBubbleForDashboardEdited(
        "bubble-1",
        "Change latency to radial",
        "Request latency",
        "radial",
      );
    });

    expect(result.current.bubbles[0]).toMatchObject({
      status: "ready",
      title: "Dashboard widget updated",
      subtitle: 'Changed "Request latency" to radial chart',
    });
    expect(result.current.bubbles[0].detail).toContain("updated to radial chart");
    expect(result.current.bubbles[0].subtitle).not.toContain("pie chart");
  });

  it("reports added and rebuilt widgets with bounded title summaries", () => {
    const { result } = renderDashboardBubbleUpdates();

    act(() => {
      result.current.updateBubbleForDashboardApplied(
        "bubble-1",
        "Add missing charts",
        5,
        ["One", "Two", "Three", "Four", "Five"],
      );
    });
    expect(result.current.bubbles[0].subtitle).toBe("Added 5 new widgets to the current board");
    expect(result.current.bubbles[0].detail).toContain("Added: One, Two, Three, Four.");
    expect(result.current.bubbles[0].detail).not.toContain("Five.");

    act(() => {
      result.current.updateBubbleForDashboardRebuilt(
        "bubble-1",
        "Rebuild dashboard",
        2,
        ["Orders", "Users"],
      );
    });
    expect(result.current.bubbles[0]).toMatchObject({
      title: "Dashboard rebuilt",
      subtitle: "Rebuilt 2 widgets from the current schema",
    });
    expect(result.current.bubbles[0].detail).toContain("Main widgets: Orders, Users.");
  });
});
