import { describe, expect, it } from "vitest";
import {
  buildWorkspaceOverviewChartSql,
  extractDashboardSnapshotWidgets,
  inferWidgetTypeFromPrompt,
  isDashboardAugmentPrompt,
  isDashboardRebuildPrompt,
  isDashboardVisualizationPrompt,
  isVisualizationPrompt,
  normalizeVisualizationText,
  prefersVietnameseSystemReply,
  resolveDashboardWidgetEditInstruction,
  summarizeAttachedDashboardSelection,
  supportsOverviewMetricsBoard,
} from "@/components/AISlidePanel/ai-visualization-intent";

const dashboardSelection = {
  boardId: "board-commerce",
  source: "dashboard: Commerce overview",
  text: [
    "Board: Commerce overview",
    "Widget count: 3",
    "1. [bar] Average rating by product",
    "2. [scoreboard] OAuth clients",
    "3. [line] Orders by day",
  ].join("\n"),
};

describe("AI visualization intent", () => {
  it("normalizes Vietnamese text and detects visualization requests", () => {
    expect(normalizeVisualizationText("Vẽ BIỂU ĐỒ tổng quan")).toBe("ve bieu do tong quan");
    expect(isVisualizationPrompt("Vẽ biểu đồ tổng quan database")).toBe(true);
    expect(isDashboardVisualizationPrompt("Vẽ dashboard tổng quan database")).toBe(true);
    expect(isVisualizationPrompt("Explain this query")).toBe(false);
    expect(prefersVietnameseSystemReply("Add missing charts", "en")).toBe(false);
    expect(prefersVietnameseSystemReply("Bổ sung biểu đồ", "en")).toBe(true);
  });

  it.each([
    ["đổi sang KPI", "scoreboard"],
    ["dùng biểu đồ thanh tròn", "radial"],
    ["switch to doughnut", "donut"],
    ["đổi qua cột ngang", "horizontal-bar"],
    ["change this to a table", "table"],
  ] as const)("maps %s to the %s widget contract", (prompt, expectedType) => {
    expect(inferWidgetTypeFromPrompt(prompt)).toBe(expectedType);
  });

  it("distinguishes dashboard augmentation from a rebuild", () => {
    expect(isDashboardAugmentPrompt("Bổ sung thêm chart để dashboard đầy đủ hơn")).toBe(true);
    expect(isDashboardRebuildPrompt("Làm lại dashboard, xóa bớt chart thừa")).toBe(true);
    expect(isDashboardAugmentPrompt("Run this SQL")).toBe(false);
  });

  it("parses and summarizes an attached dashboard snapshot", () => {
    expect(extractDashboardSnapshotWidgets(dashboardSelection.text)).toEqual([
      { type: "bar", title: "Average rating by product" },
      { type: "scoreboard", title: "OAuth clients" },
      { type: "line", title: "Orders by day" },
    ]);
    expect(summarizeAttachedDashboardSelection(dashboardSelection)).toEqual({
      boardName: "Commerce overview",
      widgetCount: 3,
      hiddenWidgetCount: 0,
      widgetTitles: ["Average rating by product", "OAuth clients", "Orders by day"],
    });
  });

  it("resolves a targeted widget edit and its deterministic replacement query", () => {
    const instruction = resolveDashboardWidgetEditInstruction(
      'Change chart "Average rating by product" to table',
      dashboardSelection,
    );

    expect(instruction).toMatchObject({
      boardId: "board-commerce",
      targetTitle: "Average rating by product",
      nextType: "table",
    });
    expect(instruction?.nextQuery).toContain('FROM "public"."products" p');
    expect(instruction?.nextQuery).toContain("AVG(r.\"rating\"::numeric)");
  });

  it("uses conversation context for numbered dashboard suggestions", () => {
    expect(
      resolveDashboardWidgetEditInstruction(
        "Dùng gợi ý 1",
        dashboardSelection,
        "Recommended change for widget: OAuth clients\nSuggestion 1: use a KPI scoreboard.",
      ),
    ).toMatchObject({
      targetTitle: "OAuth clients",
      nextType: "scoreboard",
      nextQuery: expect.stringContaining('FROM "auth"."oauth_clients"'),
    });
  });

  it("builds overview SQL only for supported server engines", () => {
    expect(supportsOverviewMetricsBoard("postgresql")).toBe(true);
    expect(buildWorkspaceOverviewChartSql("postgresql")).toContain("pg_stat_user_tables");
    expect(buildWorkspaceOverviewChartSql("mysql")).toContain("information_schema.tables");
    expect(buildWorkspaceOverviewChartSql("mssql")).toContain("sys.partitions");
    expect(supportsOverviewMetricsBoard("sqlite")).toBe(false);
    expect(buildWorkspaceOverviewChartSql("sqlite")).toBeNull();
  });
});
