import { describe, expect, it } from "vitest";

import {
  normalizeMetricsTableName,
  prioritizeMetricsTables,
} from "@/hooks/useAIMetricsBoardActions";

describe("AI metrics schema prioritization", () => {
  it("normalizes schema-style table names", () => {
    expect(normalizeMetricsTableName("Public.Order Items")).toBe("public_order_items");
  });

  it("prioritizes business tables and removes normalized duplicates", () => {
    const result = prioritizeMetricsTables([
      { name: "misc", table_type: "table", row_count: 1000 },
      { name: "Users", table_type: "table", row_count: 2 },
      { name: "users", table_type: "table", row_count: 1 },
      { name: "orders", table_type: "table", row_count: 3 },
    ]);
    expect(result.map((table) => table.name)).toEqual(["Users", "orders", "misc"]);
  });
});
