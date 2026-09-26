import { describe, expect, it } from "vitest";
import { analyzeSqlContext, getTablesInScope } from "@/components/SQLEditor/SQLContextAnalyzer";

/**
 * Clause detection drives which completions the provider offers — a wrong
 * `context` lands column suggestions in a table position (or vice versa).
 * Mirrors the fake-model convention in tests/components/SQLContextAnalyzer.test.ts.
 */
function createModel(sql: string) {
  return {
    getValue: () => sql,
    getOffsetAt: ({ lineNumber, column }: { lineNumber: number; column: number }) => {
      const lines = sql.split("\n");
      return (
        lines.slice(0, lineNumber - 1).reduce((total, line) => total + line.length + 1, 0) +
        column -
        1
      );
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

const analyzeEnd = (sql: string) =>
  analyzeSqlContext(createModel(sql), {
    lineNumber: sql.split("\n").length,
    column: (sql.split("\n").pop() ?? "").length + 1,
  } as never);

describe("analyzeSqlContext clause detection", () => {
  it.each([
    ["SELECT id, ", "SELECT"],
    ["SELECT * FROM orders o WHERE ", "WHERE"],
    ["SELECT * FROM orders o JOIN customers c ", "JOIN"],
    ["SELECT * FROM orders o JOIN customers c ON ", "ON"],
    ["SELECT * FROM orders o ORDER BY ", "ORDER BY"],
    ["SELECT * FROM orders o GROUP BY ", "GROUP BY"],
    ["SELECT * FROM orders o GROUP BY o.id HAVING ", "HAVING"],
    ["INSERT INTO orders ", "INSERT INTO"],
    ["INSERT INTO orders (id) VALUES ", "VALUES"],
    ["UPDATE orders ", "UPDATE"],
    ["UPDATE orders SET ", "SET"],
    ["DELETE FROM orders ", "DELETE FROM"],
    ["DELETE FROM orders WHERE ", "WHERE"],
    ["", "UNKNOWN"],
  ])("cursor after %j → context %s", (sql, context) => {
    expect(analyzeEnd(sql).context).toBe(context);
  });

  it("JOIN/ON flags mirror the clause", () => {
    expect(analyzeEnd("SELECT * FROM a JOIN b ").isJoinContext).toBe(true);
    expect(analyzeEnd("SELECT * FROM a JOIN b ON ").isOnContext).toBe(true);
    expect(analyzeEnd("SELECT * FROM a WHERE ").isJoinContext).toBe(false);
  });

  it("DELETE FROM resolves as DELETE FROM, not bare FROM (longest match wins)", () => {
    expect(analyzeEnd("DELETE FROM orders ").context).toBe("DELETE FROM");
  });
});

describe("analyzeSqlContext qualifier + alias definition", () => {
  it("exposes the qualifier left of the dot", () => {
    const analysis = analyzeEnd("SELECT * FROM orders o WHERE o.cu");
    expect(analysis.qualifier).toBe("o");
    expect(analysis.word).toBe("cu");
  });

  it("a quoted qualifier is unwrapped", () => {
    expect(analyzeEnd("SELECT * FROM orders o WHERE `o`.id").qualifier).toBe("o");
  });

  it("a leading-digit fragment is a numeric literal, not a qualifier", () => {
    expect(analyzeEnd("SELECT * FROM t WHERE x > 1.").qualifier).toBeNull();
  });

  it("detects an in-progress alias definition after FROM <table>", () => {
    expect(analyzeEnd("SELECT * FROM orders o").isAliasDefinition).toBe(true);
    expect(analyzeEnd("SELECT * FROM orders AS ").isAliasDefinition).toBe(true);
    expect(analyzeEnd("SELECT * FROM orders o WHERE ").isAliasDefinition).toBe(false);
  });
});

describe("analyzeSqlContext DML targets", () => {
  it("targetTable tracks the nearest preceding DML clause", () => {
    expect(analyzeEnd("INSERT INTO app.orders (id) VALUES (").targetTable).toBe("app.orders");
    expect(analyzeEnd("UPDATE [order_details] SET x = 1 WHERE ").targetTable).toBe("order_details");
    expect(analyzeEnd("DELETE FROM orders WHERE ").targetTable).toBe("orders");
    expect(analyzeEnd("SELECT * FROM a JOIN b ON ").targetTable).toBeNull();
  });

  it("insertColumnList reports columns already typed inside the parens", () => {
    expect(analyzeEnd("INSERT INTO orders (id, name, ").insertColumnList).toEqual(["id", "name"]);
    // Closed paren → past the list (VALUES context).
    expect(analyzeEnd("INSERT INTO orders (id, name) VALUES (").insertColumnList).toBeNull();
    expect(analyzeEnd("SELECT id FROM orders WHERE ").insertColumnList).toBeNull();
  });
});

describe("getTablesInScope", () => {
  it("resolves schema-qualified and quoted table refs", () => {
    const scopes = getTablesInScope(
      createModel("SELECT * FROM public.orders po JOIN `sales_regions` sr ON true"),
      { lineNumber: 1, column: 1 } as never,
    );
    expect(scopes).toContainEqual({
      table: "public.orders",
      alias: "po",
      kind: "table",
      columns: undefined,
    });
    expect(scopes).toContainEqual({
      table: "sales_regions",
      alias: "sr",
      kind: "table",
      columns: undefined,
    });
  });

  it("table refs inside a subquery contribute their own alias to scope", () => {
    const model = createModel("SELECT * FROM orders o WHERE o.id IN (SELECT id FROM orders s)");
    const scopes = getTablesInScope(model, { lineNumber: 1, column: 1 } as never);
    // Both the outer alias and the subquery alias must be completable.
    const ordersScopes = scopes.filter((s) => s.table === "orders");
    expect(ordersScopes.map((s) => s.alias).sort()).toEqual(["o", "s"]);
  });

  it("clause keywords are never adopted as aliases", () => {
    const scopes = getTablesInScope(createModel("SELECT * FROM orders WHERE"), {
      lineNumber: 1,
      column: 1,
    } as never);
    expect(scopes).toEqual([
      { table: "orders", alias: "orders", kind: "table", columns: undefined },
    ]);
  });
});
