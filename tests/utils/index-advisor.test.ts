import { describe, expect, it } from "vitest";
import { getIndexProposals } from "@/utils/index-advisor";
import { parseExplainOutput } from "@/utils/explain-parser";
import type { DatabaseType } from "@/types";

/** Minimal Postgres-style EXPLAIN JSON with one filtered seq scan. */
function postgresPlan(_sql: string, cost = 1200, rows = 20_000) {
  const raw = [
    {
      Plan: {
        "Node Type": "Seq Scan",
        "Relation Name": "orders",
        Filter: "(customer_id = 42) AND (status = 'open'::status_enum)",
        "Plan Rows": rows,
        "Total Cost": cost,
        Plans: [
          {
            "Node Type": "Index Scan",
            "Index Name": "orders_pkey",
            "Relation Name": "orders",
            "Plan Rows": 1,
            "Total Cost": 8,
          },
        ],
      },
      "Total Cost": cost,
    },
  ];
  return parseExplainOutput("postgres" as DatabaseType, raw);
}

describe("getIndexProposals", () => {
  const SQL = "SELECT * FROM orders WHERE customer_id = 42 AND status = 'open'";

  it("proposes an index for an expensive filtered seq scan", () => {
    const plan = postgresPlan(SQL);
    const proposals = getIndexProposals(plan, SQL);
    expect(proposals.length).toBeGreaterThan(0);
    const first = proposals[0];
    expect(first.tableName).toBe("orders");
    expect(first.columns[0]).toBe("customer_id");
    expect(first.sql).toMatch(/^CREATE INDEX idx_orders_\w+ ON orders \(customer_id/);
    expect(first.reasons.some((reason) => /Seq Scan/i.test(reason))).toBe(true);
  });

  it("orders proposals by score and caps the list", () => {
    const plan = postgresPlan(SQL);
    const proposals = getIndexProposals(plan, SQL);
    for (let index = 1; index < proposals.length; index += 1) {
      expect(proposals[index - 1].score).toBeGreaterThanOrEqual(proposals[index].score);
    }
    expect(proposals.length).toBeLessThanOrEqual(3);
  });

  it("skips scans on tables the statement does not reference", () => {
    const plan = postgresPlan(SQL);
    const proposals = getIndexProposals(plan, "SELECT * FROM audit_log WHERE id = 1");
    expect(proposals).toEqual([]);
  });

  it("skips scans whose rows are too few to matter", () => {
    const plan = postgresPlan(SQL, 1200, 12);
    const proposals = getIndexProposals(plan, SQL);
    expect(proposals).toEqual([]);
  });

  it("skips proposals duplicating an existing index prefix", () => {
    const plan = postgresPlan(SQL);
    const proposals = getIndexProposals(plan, SQL, new Map([["orders", ["customer_id, status"]]]));
    expect(proposals).toEqual([]);
  });

  it("returns nothing for plans without full scans", () => {
    const raw = [
      {
        Plan: {
          "Node Type": "Index Scan",
          "Index Name": "orders_pkey",
          "Relation Name": "orders",
          "Plan Rows": 1,
          "Total Cost": 8,
        },
        "Total Cost": 8,
      },
    ];
    const plan = parseExplainOutput("postgres" as DatabaseType, raw);
    expect(getIndexProposals(plan, SQL)).toEqual([]);
  });
});
