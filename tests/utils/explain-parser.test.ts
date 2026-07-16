import { describe, expect, it } from "vitest";
import { buildExplainQuery, getExplainHotspots, parseExplainOutput } from "@/utils/explain-parser";

describe("EXPLAIN parser fixtures", () => {
  it("parses PostgreSQL JSON ANALYZE timing, row estimates, and nested plans", () => {
    const plan = parseExplainOutput("postgresql", [{
      Plan: {
        "Node Type": "Nested Loop",
        "Total Cost": 140,
        "Plan Rows": 10,
        "Actual Rows": 55,
        "Actual Total Time": 18.4,
        Plans: [{
          "Node Type": "Seq Scan",
          "Relation Name": "orders",
          "Total Cost": 120,
          "Plan Rows": 10,
          "Actual Rows": 50,
          "Actual Total Time": 16.2,
        }],
      },
    }]);

    expect(plan.analyzed).toBe(true);
    expect(plan.nodes).toHaveLength(2);
    expect(plan.nodes[0]).toMatchObject({ operation: "Nested Loop", actualTimeMs: 18.4, actualRows: 55 });
    expect(plan.nodes[1]).toMatchObject({ operation: "Seq Scan", parentId: plan.nodes[0].id });
    expect(getExplainHotspots(plan).map((hotspot) => hotspot.node.operation)).toContain("Seq Scan");
  });

  it("parses MySQL JSON nested_loop table access details", () => {
    const plan = parseExplainOutput("mysql", {
      query_block: {
        select_id: 1,
        nested_loop: [
          { table: { table_name: "orders", access_type: "ALL", rows_examined_per_scan: 500, filtered: 50 } },
          { table: { table_name: "customers", access_type: "eq_ref", key: "PRIMARY" } },
        ],
      },
    });

    expect(plan.nodes).toHaveLength(3);
    expect(plan.nodes.map((node) => node.operation)).toEqual(["Query block", "ALL orders", "eq_ref customers"]);
    expect(plan.nodes[1].extras).toMatchObject({ table: "orders", rows_examined: 500 });
  });

  it("parses SQLite query-plan row payloads into a parent-child graph", () => {
    const plan = parseExplainOutput("sqlite", [
      { id: 2, parent: -1, detail: "SCAN orders" },
      { id: 8, parent: 2, detail: "SEARCH customers USING INDEX customers_pk" },
    ]);

    expect(plan.nodes).toHaveLength(2);
    expect(plan.rootIds).toEqual([plan.nodes[0].id]);
    expect(plan.nodes[0].children).toEqual([plan.nodes[1].id]);
  });

  it("builds engine-safe EXPLAIN commands for the primary engines", () => {
    expect(buildExplainQuery("SELECT * FROM orders", "postgresql", true))
      .toContain("EXPLAIN (ANALYZE, COSTS, VERBOSE, BUFFERS, FORMAT JSON)");
    expect(buildExplainQuery("SELECT * FROM orders", "mysql"))
      .toBe("EXPLAIN FORMAT=JSON SELECT * FROM orders");
    expect(buildExplainQuery("SELECT * FROM orders", "sqlite"))
      .toBe("EXPLAIN QUERY PLAN SELECT * FROM orders");
  });
});
