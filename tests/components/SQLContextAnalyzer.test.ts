import { describe, expect, it } from "vitest";
import {
  analyzeSqlContext,
  getCteScopes,
  getTablesInScope,
} from "@/components/SQLEditor/SQLContextAnalyzer";

function createModel(sql: string) {
  return {
    getValue: () => sql,
    getOffsetAt: ({ lineNumber, column }: { lineNumber: number; column: number }) => {
      const lines = sql.split("\n");
      return lines.slice(0, lineNumber - 1).reduce((total, line) => total + line.length + 1, 0) + column - 1;
    },
    getWordUntilPosition: ({ lineNumber, column }: { lineNumber: number; column: number }) => {
      const line = sql.split("\n")[lineNumber - 1] ?? "";
      const before = line.slice(0, column - 1);
      const match = /[\w$]+$/.exec(before);
      return {
        word: match?.[0] ?? "",
        startColumn: match ? before.length - match[0].length + 1 : column,
        endColumn: column,
      };
    },
  } as never;
}

describe("SQLContextAnalyzer", () => {
  it("keeps joined table aliases in scope", () => {
    const model = createModel("SELECT o.id FROM orders o JOIN customers AS c ON o.customer_id = c.id");
    expect(getTablesInScope(model, { lineNumber: 1, column: 1 } as never)).toEqual([
      { table: "orders", alias: "o", kind: "table", columns: undefined },
      { table: "customers", alias: "c", kind: "table", columns: undefined },
    ]);
  });

  it("exposes CTE names and projected columns without a schema round trip", () => {
    const sql = "WITH recent_orders (customer_id, total) AS (SELECT customer_id, total FROM orders) SELECT * FROM recent_orders ro";
    const model = createModel(sql);

    expect(getCteScopes(model)).toEqual([
      { table: "recent_orders", alias: "recent_orders", kind: "cte", columns: ["customer_id", "total"] },
    ]);
    expect(getTablesInScope(model, { lineNumber: 1, column: sql.length + 1 } as never)).toContainEqual(
      { table: "recent_orders", alias: "ro", kind: "cte", columns: ["customer_id", "total"] },
    );
  });

  it("keeps the active clause after a user starts typing an expression", () => {
    const sql = "SELECT o.id FROM orders o WHERE o.";
    const model = createModel(sql);
    const analysis = analyzeSqlContext(model, { lineNumber: 1, column: sql.length + 1 } as never);

    expect(analysis.context).toBe("WHERE");
    expect(analysis.alias).toBe("o");
  });
});
