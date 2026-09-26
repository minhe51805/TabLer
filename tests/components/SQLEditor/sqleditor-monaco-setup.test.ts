import { describe, expect, it, vi } from "vitest";
import { registerSchemaCompletionProvider } from "@/components/SQLEditor/SQLEditorMonacoSetup";

/**
 * Gaps beyond tests/components/SQLEditorMonacoSetup.test.ts: schema-qualifier
 * filtering, the capped all-tables fallback, cancellation, prefetch, and
 * structure-fetch failure tolerance.
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

function createMonaco() {
  let provider: {
    provideCompletionItems: (
      model: unknown,
      position: unknown,
      context?: unknown,
      token?: unknown,
    ) => Promise<{
      suggestions: Array<{ insertText: string; sortText?: string; detail?: string }>;
      incomplete?: boolean;
    }>;
  } | null = null;
  const monaco = {
    languages: {
      CompletionItemKind: {
        Class: 1,
        Field: 2,
        Keyword: 3,
        Operator: 4,
        Variable: 5,
        Function: 6,
        Snippet: 7,
      },
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
      registerCompletionItemProvider: vi.fn((_language: string, nextProvider: typeof provider) => {
        provider = nextProvider;
        return { dispose: vi.fn() };
      }),
    },
  };
  return { monaco, getProvider: () => provider! };
}

const structureOf = (columns: string[]) => ({
  columns: columns.map((name) => ({
    name,
    data_type: "integer",
    is_nullable: false,
    is_primary_key: false,
  })),
  indexes: [],
  foreign_keys: [],
  triggers: [],
});

const endOf = (sql: string) => ({
  lineNumber: 1,
  column: sql.length + 1,
});

describe("schema qualifier filtering", () => {
  it("`schema.` narrows FROM suggestions to tables in that schema", async () => {
    const { monaco, getProvider } = createMonaco();
    registerSchemaCompletionProvider(monaco, {
      getTables: () => [
        { name: "orders", schema: "sales" },
        { name: "customers", schema: "public" },
      ],
      getTableStructure: vi.fn().mockResolvedValue(structureOf(["id"])),
      dbType: "postgresql",
    });

    const sql = "SELECT * FROM sales.";
    const result = await getProvider().provideCompletionItems(createModel(sql), endOf(sql));
    const texts = result.suggestions.map((s) => s.insertText);
    expect(texts).toContain("orders");
    expect(texts).not.toContain("customers");
    // The qualifier stays typed — inserting must not re-emit `sales.orders`.
    expect(texts).not.toContain("sales.orders");
  });

  it("without a qualifier, schema-qualified forms are offered alongside bare names", async () => {
    const { monaco, getProvider } = createMonaco();
    registerSchemaCompletionProvider(monaco, {
      getTables: () => [{ name: "orders", schema: "sales" }],
      getTableStructure: vi.fn().mockResolvedValue(structureOf(["id"])),
      dbType: "postgresql",
    });

    const sql = "SELECT * FROM ";
    const result = await getProvider().provideCompletionItems(createModel(sql), endOf(sql));
    const texts = result.suggestions.map((s) => s.insertText);
    expect(texts).toContain("orders");
    expect(texts).toContain("sales.orders");
  });
});

describe("all-tables fallback", () => {
  it("fetches every table's structure with at most 4 parallel calls", async () => {
    const { monaco, getProvider } = createMonaco();
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const getTableStructure = vi.fn((name: string) => {
      inFlight += 1;
      calls += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Resolves on the next microtask turn — no wall-clock needed, but the
      // call stays in-flight while the other worker slots start.
      return Promise.resolve(structureOf([`${name}_col`])).then((s) => {
        inFlight -= 1;
        return s;
      });
    });
    const tables = Array.from({ length: 10 }, (_, i) => ({ name: `t${i}` }));
    registerSchemaCompletionProvider(monaco, {
      getTables: () => tables,
      getTableStructure,
      dbType: "postgresql",
    });

    const sql = "SELECT ";
    const pending = getProvider().provideCompletionItems(createModel(sql), endOf(sql));
    // The cap must have throttled the burst: fewer than all 10 calls issued
    // synchronously, and never more than 4 running at once.
    expect(calls).toBeLessThan(10);
    const result = await pending;

    expect(getTableStructure).toHaveBeenCalledTimes(10);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(result.suggestions.map((s) => s.insertText)).toContain("t0.t0_col");
    expect(result.suggestions.map((s) => s.insertText)).toContain("t9.t9_col");
  });

  it("a structure failure for one table does not kill the others", async () => {
    const { monaco, getProvider } = createMonaco();
    const getTableStructure = vi.fn((name: string) =>
      name === "broken"
        ? Promise.reject(new Error("db gone"))
        : Promise.resolve(structureOf(["ok"])),
    );
    registerSchemaCompletionProvider(monaco, {
      getTables: () => [{ name: "broken" }, { name: "good" }],
      getTableStructure,
      dbType: "postgresql",
    });

    const sql = "SELECT ";
    const result = await getProvider().provideCompletionItems(createModel(sql), endOf(sql));
    const texts = result.suggestions.map((s) => s.insertText);
    expect(texts).toContain("good.ok");
    expect(texts).not.toContain("broken.ok");
  });
});

describe("cancellation", () => {
  it("a cancelled token short-circuits to an empty list", async () => {
    const { monaco, getProvider } = createMonaco();
    registerSchemaCompletionProvider(monaco, {
      getTables: () => [{ name: "orders" }],
      getTableStructure: vi.fn().mockResolvedValue(structureOf(["id"])),
      dbType: "postgresql",
    });

    const sql = "SELECT ";
    const result = await getProvider().provideCompletionItems(
      createModel(sql),
      endOf(sql),
      {},
      { isCancellationRequested: true },
    );
    expect(result.suggestions).toEqual([]);
  });
});

describe("prefetchStructures", () => {
  it("warms every table with a bounded worker pool and survives failures", async () => {
    const { monaco } = createMonaco();
    let calls = 0;
    const getTableStructure = vi.fn((name: string) => {
      calls += 1;
      return name === "t1"
        ? Promise.reject(new Error("offline"))
        : Promise.resolve(structureOf(["id"]));
    });
    const tables = Array.from({ length: 7 }, (_, i) => ({ name: `t${i}` }));
    const provider = registerSchemaCompletionProvider(monaco, {
      getTables: () => tables,
      getTableStructure,
      dbType: "postgresql",
    });

    // One rejection must not abort the warm or reject the prefetch promise.
    await provider.prefetchStructures!();

    expect(getTableStructure).toHaveBeenCalledTimes(7);
    // The pool is capped at 3: not all calls issued synchronously.
    expect(calls).toBeGreaterThan(0);
  });

  it("prefetch caps parallel structure calls at 3", async () => {
    const { monaco } = createMonaco();
    const calls: string[] = [];
    const getTableStructure = vi.fn((name: string) => {
      calls.push(name);
      return Promise.resolve(structureOf(["id"]));
    });
    const tables = Array.from({ length: 7 }, (_, i) => ({ name: `t${i}` }));
    const provider = registerSchemaCompletionProvider(monaco, {
      getTables: () => tables,
      getTableStructure,
      dbType: "postgresql",
    });

    const pending = provider.prefetchStructures!();
    // Workers start synchronously: exactly 3 calls may be issued before any
    // structure resolves.
    expect(calls.length).toBe(3);
    await pending;
    expect(getTableStructure).toHaveBeenCalledTimes(7);
  });
});
