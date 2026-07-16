import { describe, expect, it, vi } from "vitest";
import { registerSchemaCompletionProvider } from "@/components/SQLEditor/SQLEditorMonacoSetup";

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

function createMonaco() {
  let provider: { provideCompletionItems: (model: unknown, position: unknown) => Promise<{ suggestions: Array<{ insertText: string }> }> } | null = null;
  const monaco = {
    languages: {
      CompletionItemKind: { Class: 1, Field: 2, Keyword: 3, Operator: 4, Variable: 5, Function: 6, Snippet: 7 },
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
      registerCompletionItemProvider: vi.fn((_language: string, nextProvider: typeof provider) => {
        provider = nextProvider;
        return { dispose: vi.fn() };
      }),
    },
  };
  return { monaco, getProvider: () => provider! };
}

const ordersStructure = {
  columns: [
    { name: "id", data_type: "integer", is_nullable: false, is_primary_key: true },
    { name: "total", data_type: "numeric", is_nullable: false, is_primary_key: false },
  ],
  indexes: [],
  foreign_keys: [],
  triggers: [],
};

describe("schema completion provider", () => {
  it("qualifies column completions with a joined table alias", async () => {
    const { monaco, getProvider } = createMonaco();
    const getTableStructure = vi.fn().mockResolvedValue(ordersStructure);
    const sql = "SELECT o.id FROM orders o WHERE o.";
    registerSchemaCompletionProvider(monaco, { getTables: () => [{ name: "orders" }], getTableStructure, dbType: "postgresql" });

    const result = await getProvider().provideCompletionItems(createModel(sql), { lineNumber: 1, column: sql.length + 1 });
    expect(result.suggestions.map((suggestion) => suggestion.insertText)).toContain("o.id");
  });

  it("completes CTE columns without loading a structure for the CTE name", async () => {
    const { monaco, getProvider } = createMonaco();
    const getTableStructure = vi.fn().mockResolvedValue(ordersStructure);
    const sql = "WITH active_orders (id, total) AS (SELECT id, total FROM orders) SELECT * FROM active_orders ao WHERE ao.";
    registerSchemaCompletionProvider(monaco, { getTables: () => [{ name: "orders" }], getTableStructure, dbType: "postgresql" });

    const result = await getProvider().provideCompletionItems(createModel(sql), { lineNumber: 1, column: sql.length + 1 });
    expect(result.suggestions.map((suggestion) => suggestion.insertText)).toEqual(expect.arrayContaining(["ao.id", "ao.total"]));
    expect(getTableStructure).not.toHaveBeenCalledWith("active_orders");
  });
});
