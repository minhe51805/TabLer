import { describe, expect, it } from "vitest";

import {
  extractSqlFromResponse,
  hasSqlStartKeyword,
  isLikelySqlOnlyResponse,
  stripLeadingSqlComments,
  stripSqlCodeBlocksFromResponse,
  summarizeRunResult,
} from "@/components/AISlidePanel/ai-sql-response";

describe("AI SQL response helpers", () => {
  it("recognizes SQL after leading line and block comments", () => {
    expect(stripLeadingSqlComments("-- safe read\n/* note */\nSELECT 1")).toBe("SELECT 1");
    expect(hasSqlStartKeyword("# note\nWITH totals AS (SELECT 1) SELECT * FROM totals")).toBe(true);
    expect(hasSqlStartKeyword("Here is a query")).toBe(false);
  });

  it("extracts fenced SQL without the response prose", () => {
    const response = "Here is a safe query:\n```sql\nSELECT * FROM users;\n```\nIt returns users.";
    expect(extractSqlFromResponse(response)).toBe("SELECT * FROM users;");
    expect(stripSqlCodeBlocksFromResponse(response)).toBe("Here is a safe query:\n\nIt returns users.");
  });

  it("finds an unfenced SQL statement while preserving leading comments", () => {
    const response = "Use this:\n-- active customers\nSELECT id FROM customers WHERE active = true;";
    expect(extractSqlFromResponse(response)).toBe("-- active customers\nSELECT id FROM customers WHERE active = true;");
  });

  it("does not treat explanatory text as SQL", () => {
    expect(extractSqlFromResponse("The users table contains profiles.")).toBe("");
    expect(isLikelySqlOnlyResponse("The users table contains profiles.")).toBe(false);
  });

  it("identifies SQL-only responses but not an explanation with SQL", () => {
    expect(isLikelySqlOnlyResponse("```sql\nSELECT count(*) FROM users;\n```")).toBe(true);
    expect(isLikelySqlOnlyResponse("This counts active users and may be slow.\n```sql\nSELECT count(*) FROM users;\n```\nAdd an index if needed.")).toBe(false);
  });

  it("summarizes query, mutation, and empty results", () => {
    const base = {
      columns: [],
      affected_rows: 0,
      execution_time_ms: 12,
      query: "SELECT 1",
      sandboxed: true,
      truncated: false,
    };
    expect(summarizeRunResult({ ...base, rows: [[1], [2]] })).toBe("Returned 2 rows in 12 ms.");
    expect(summarizeRunResult({ ...base, rows: [], affected_rows: 1 })).toBe("Applied changes to 1 row in 12 ms.");
    expect(summarizeRunResult({ ...base, rows: [] })).toBe("Execution completed in 12 ms.");
  });

  it("cuts trailing prose after the last SQL terminator", () => {
    const response = [
      "Query để xem dữ liệu characters:",
      "SELECT",
      "id,",
      "name",
      "FROM public.characters",
      "ORDER BY created_at DESC",
      "LIMIT 50;",
      "Chạy query này trong tab Query để xem toàn bộ characters.",
    ].join("\n");
    expect(extractSqlFromResponse(response)).toBe(
      "SELECT\nid,\nname\nFROM public.characters\nORDER BY created_at DESC\nLIMIT 50;",
    );
  });

  it("keeps SQL intact when no statement terminator exists", () => {
    expect(extractSqlFromResponse("SELECT id FROM users")).toBe("SELECT id FROM users");
  });
});
