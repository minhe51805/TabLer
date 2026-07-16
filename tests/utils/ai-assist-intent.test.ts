import { describe, expect, it } from "vitest";

import {
  buildKnownTableNameSet,
  inferAssistIntent,
  isMetricsBoardRequest,
  isVisualizationRequest,
  isWorkspaceScopedIntent,
  normalizeIntentText,
  stripTableSchemaQualifier,
} from "@/components/AISlidePanel/ai-assist-intent";

describe("AI assist intent", () => {
  it("normalizes Vietnamese text without changing semantic words", () => {
    expect(normalizeIntentText("Đọc lại CƠ SỞ DỮ LIỆU")).toBe("doc lai co so du lieu");
    expect(normalizeIntentText("Tối ưu truy vấn")).toBe("toi uu truy van");
  });

  it.each([
    "Draw a line chart for daily orders",
    "Vẽ biểu đồ số user theo ngày",
    "Create a dashboard overview",
    "Plot the latency histogram",
  ])("recognizes visualization request: %s", (prompt) => {
    expect(isVisualizationRequest(prompt)).toBe(true);
  });

  it("distinguishes metric boards from a single chart", () => {
    expect(isMetricsBoardRequest("Build a metrics dashboard with scoreboards")).toBe(true);
    expect(isMetricsBoardRequest("Tạo bảng tổng hợp báo cáo")).toBe(true);
    expect(isMetricsBoardRequest("Draw one line chart")).toBe(false);
  });

  it("normalizes qualified table identifiers for grounding", () => {
    expect(stripTableSchemaQualifier('"public"."Users"')).toBe("Users");
    expect(stripTableSchemaQualifier("analytics.daily_orders")).toBe("daily_orders");

    const knownNames = buildKnownTableNameSet([
      '"public"."Users"',
      "analytics.daily_orders",
    ]);
    expect(knownNames).toEqual(
      new Set(["public.users", "users", "analytics.daily_orders", "daily_orders"]),
    );
  });

  it.each([
    ["Hello, how are you?", "prompt", "general"],
    ["Give me a database overview", "prompt", "overview"],
    ["Đọc lại DB hiện tại", "prompt", "overview"],
    ["数据库概览", "prompt", "overview"],
    ["Write SQL to list active users", "prompt", "sql"],
    ["Explain what the users table is used for", "prompt", "explain"],
    ["Optimize this slow query", "prompt", "optimize"],
    ["Fix the SQL error in this query", "prompt", "fix-error"],
    ["Các bảng liên quan có key chung nào? Viết câu lệnh chạy thử", "agent", "sql"],
  ] as const)("classifies %s as %s", (prompt, mode, expectedIntent) => {
    expect(inferAssistIntent(prompt, mode)).toBe(expectedIntent);
  });

  it("requires workspace context for every intent except general chat", () => {
    expect(isWorkspaceScopedIntent("general")).toBe(false);
    for (const intent of ["overview", "sql", "explain", "optimize", "fix-error"] as const) {
      expect(isWorkspaceScopedIntent(intent)).toBe(true);
    }
  });
});
