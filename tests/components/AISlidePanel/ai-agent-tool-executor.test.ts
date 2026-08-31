import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentToolAvailability } from "@/components/AISlidePanel/ai-agent-engine-gates";
import { createAgentToolExecutor } from "@/components/AISlidePanel/ai-agent-tool-executor";
import type { AgentToolExecutorDeps } from "@/components/AISlidePanel/ai-agent-tool-executor";
import type { AIAgentToolAction } from "@/components/AISlidePanel/ai-agent-tools";
import type { TableInfo } from "@/types";

vi.mock("@/utils/semantic-glossary", () => ({
  saveSemanticGlossaryEntry: vi.fn().mockResolvedValue(undefined),
}));

const CONNECTION_ID = "conn-1";
const DB = "appdb";

function tbl(name: string, row_count = 10, schema = "public"): TableInfo {
  return { name, schema, table_type: "BASE TABLE", row_count } as TableInfo;
}

function mkDeps(overrides: Partial<AgentToolExecutorDeps> = {}) {
  const base: AgentToolExecutorDeps = {
    connectionId: CONNECTION_ID,
    currentDatabase: DB,
    latestTables: [
      tbl("users", 100),
      tbl("orders", 40),
      tbl("order_items", 500),
    ],
    availableSchemaTables: ["public.users", "public.orders", "public.order_items"],
    relationalSchemaSummaryByTable: new Map(),
    inspectedAgentTables: new Set<string>(),
    requestId: 1,
    requestIdRef: { current: 1 },
    requestDataReadConsent: vi.fn().mockResolvedValue(true),
    publishAgentProgress: vi.fn(),
    getTableColumnsPreview: vi.fn().mockResolvedValue([
      { name: "id", data_type: "INT", is_nullable: false, is_primary_key: true },
      { name: "email", data_type: "TEXT", is_nullable: true, is_primary_key: false },
    ]),
    getTableStructure: vi.fn().mockResolvedValue({
      columns: [
        { name: "id", data_type: "INT", is_nullable: false, is_primary_key: true },
        { name: "email", data_type: "TEXT", is_nullable: true, is_primary_key: false },
      ],
      indexes: [],
      foreign_keys: [],
    }),
    getTableData: vi.fn().mockResolvedValue({
      columns: [
        { name: "id", data_type: "INT", is_nullable: false, is_primary_key: true },
        { name: "email", data_type: "TEXT", is_nullable: true, is_primary_key: false },
      ],
      rows: [[1, "a@b.c"], [2, "d@e.f"]],
      affected_rows: 0,
      execution_time_ms: 3,
      query: "fixture",
      sandboxed: false,
      truncated: false,
    }),
    executeReadonlyQuery: vi.fn().mockResolvedValue({
      columns: [{ name: "count", data_type: "INT", is_nullable: true, is_primary_key: false }],
      rows: [[7]],
      affected_rows: 0,
      execution_time_ms: 2,
      query: "fixture",
      sandboxed: true,
      truncated: false,
    }),
    executeParameterizedReadonlyQuery: vi.fn().mockResolvedValue({
      columns: [
        { name: "id", data_type: "INT", is_nullable: false, is_primary_key: true },
        { name: "email", data_type: "TEXT", is_nullable: true, is_primary_key: false },
      ],
      rows: [[1, "a@b.c"]],
      affected_rows: 0,
      execution_time_ms: 2,
      query: "fixture",
      sandboxed: true,
      truncated: false,
    }),
    previewWriteTransaction: vi.fn().mockResolvedValue({
      results: [{ affected_rows: 1, rows: [[1]], truncated: false }],
    }),
  };
  return { ...base, ...overrides } as AgentToolExecutorDeps;
}

function run(deps: AgentToolExecutorDeps, action: Partial<AIAgentToolAction>) {
  return createAgentToolExecutor(deps).runAgentTool(action as AIAgentToolAction);
}

function parseObservation(obs: string): Record<string, unknown> {
  // Observations may carry enrichment suffixes (column stats, @@facts footer);
  // the JSON payload is the first block. Use the LAST parseable line prefix.
  const cut = obs.indexOf("\n@@facts:");
  const body = cut === -1 ? obs : obs.slice(0, cut);
  const statsCut = body.indexOf("\n\nColumn stats (whole table):");
  return JSON.parse(statsCut === -1 ? body : body.slice(0, statsCut));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("exploration de-dup guard", () => {
  it("returns a notice when an identical non-read call repeats", async () => {
    const deps = mkDeps();
    const exec = createAgentToolExecutor(deps);
    await exec.runAgentTool({ action: "list_tables", args: {} } as AIAgentToolAction);
    const second = await exec.runAgentTool({ action: "list_tables", args: {} } as AIAgentToolAction);
    expect(second).toContain("Tool notice: identical list_tables call repeated");
  });

  it("does not de-duplicate run_readonly_sql or sample_table_data", async () => {
    const deps = mkDeps();
    const exec = createAgentToolExecutor(deps);
    deps.inspectedAgentTables.add("public.users");
    const a = await exec.runAgentTool({ action: "run_readonly_sql", args: { sql: "select * from users limit 1" } } as AIAgentToolAction);
    const b = await exec.runAgentTool({ action: "run_readonly_sql", args: { sql: "select * from users limit 1" } } as AIAgentToolAction);
    expect(a).not.toContain("Tool notice:");
    expect(b).not.toContain("Tool notice:");
    expect(deps.getTableData ?? deps.executeReadonlyQuery).toBeDefined();
    expect((deps.executeReadonlyQuery as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("list_tables", () => {
  it("returns catalog metadata with identifier and counts", async () => {
    const obs = await run(mkDeps(), { action: "list_tables", args: {} } as AIAgentToolAction);
    const parsed = parseObservation(obs);
    expect(parsed.database).toBe(DB);
    expect(parsed.catalogTables).toBe(3);
    expect(parsed.tableCount).toBe(3);
    expect(Array.isArray(parsed.tables)).toBe(true);
    expect(JSON.stringify(parsed.tables)).toContain("public.users");
  });

  it("applies schema, pattern and minRows filters", async () => {
    const obs = await run(mkDeps(), {
      action: "list_tables",
      args: { pattern: "order", minRows: 100 },
    } as AIAgentToolAction);
    const parsed = parseObservation(obs);
    expect(parsed.tableCount).toBe(1); // order_items has 500 rows; orders has 40
    expect(parsed.filtered).toBe(true);
    expect(parsed.minRows).toBe(100);
  });

  it("emits truncation hint when results exceed the limit", async () => {
    const many = Array.from({ length: 250 }, (_, i) => tbl(`t${i}`));
    const manyTables = many;
    const d2 = mkDeps({ latestTables: manyTables, availableSchemaTables: manyTables.map((x) => `${x.schema}.${x.name}`) });
    const obs = await run(d2, { action: "list_tables", args: {} } as AIAgentToolAction);
    expect(obs).toContain('"truncated": true');
    expect(obs).toContain("exceed the 200-name preview");
  });

});

describe("search_schema", () => {
  it("requires args.query", async () => {
    const obs = await run(mkDeps(), { action: "search_schema", args: {} } as AIAgentToolAction);
    expect(obs).toBe("Tool error: search_schema requires args.query.");
  });

  it("scans previews and reports matches for a column query", async () => {
    const obs = await run(mkDeps(), { action: "search_schema", args: { query: "email" } } as AIAgentToolAction);
    const parsed = parseObservation(obs);
    expect(parsed.query).toBe("email");
    expect(parsed.tablesScanned).toBe(3);
    expect(String(obs)).toContain("describe_table");
  });

  it("publishes scan progress for large catalogs (every 24 scans)", async () => {
    const many = Array.from({ length: 30 }, (_, i) => tbl(`t${i}`, 5));
    const deps = mkDeps({ latestTables: many, availableSchemaTables: many.map((t) => t.name) });
    await run(deps, { action: "search_schema", args: { query: "zzz" } } as AIAgentToolAction);
    expect(deps.publishAgentProgress).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("(24/30)") }),
    );
  });
});

describe("describe_table", () => {
  it("rejects unknown tables", async () => {
    const obs = await run(mkDeps(), { action: "describe_table", args: { table: "nope" } } as AIAgentToolAction);
    expect(obs).toContain('Tool error: Table "nope" is not present');
  });

  it("serves cached summaries without hitting the backend", async () => {
    const deps = mkDeps();
    deps.relationalSchemaSummaryByTable.set("public.users", "CACHED_SUMMARY");
    const obs = await run(deps, { action: "describe_table", args: { table: "users" } } as AIAgentToolAction);
    expect(obs).toContain("TABLE=public.users");
    expect(obs).toContain("SCHEMA=CACHED_SUMMARY");
    expect(deps.getTableStructure).not.toHaveBeenCalled();
    expect(deps.inspectedAgentTables.has("public.users")).toBe(true);
  });

  it("fetches structure, marks inspected and encodes schema", async () => {
    const deps = mkDeps();
    const obs = await run(deps, { action: "describe_table", args: { table: "public.orders" } } as AIAgentToolAction);
    expect(obs).toContain("TABLE=public.orders");
    expect(obs).toContain("COUNTS=cols:2,idx:0,fk:0");
    expect(deps.inspectedAgentTables.has("public.orders")).toBe(true);
    expect(deps.getTableStructure).toHaveBeenCalledTimes(1);
  });
});

describe("describe_tables (batch)", () => {
  it("caps the batch at AI_AGENT_BATCH_DESCRIBE_LIMIT and reports per-table sections", async () => {
    const names = ["users", "orders", "order_items", "a", "b", "c", "d", "e", "f", "g"];
    const obs = await run(mkDeps(), { action: "describe_tables", args: { tables: names } } as AIAgentToolAction);
    const parsed = parseObservation(obs);
    expect(parsed.described).toBe(8); // AI_AGENT_BATCH_DESCRIBE_LIMIT
  });

  it("flags unknown names as ERROR sections instead of failing the batch", async () => {
    const obs = await run(mkDeps(), { action: "describe_tables", args: { tables: ["nope"] } } as AIAgentToolAction);
    expect(obs).toContain("ERROR=Not present");
  });
});

describe("sample_table_data", () => {
  it("blocks sampling when data-read consent is denied", async () => {
    const deps = mkDeps({
      requestDataReadConsent: vi.fn().mockResolvedValue(false),
    });
    const obs = await run(deps, { action: "sample_table_data", args: { table: "users" } } as AIAgentToolAction);
    expect(obs).toContain("Tool blocked: The user did not grant permission");
    expect(deps.getTableData).not.toHaveBeenCalled();
  });

  it("clamps the requested limit to AI_AGENT_SAMPLE_MAX_ROWS", async () => {
    const deps = mkDeps();
    await run(deps, { action: "sample_table_data", args: { table: "users", limit: 9999 } } as AIAgentToolAction);
    expect((deps.getTableData as ReturnType<typeof vi.fn>).mock.calls[0][2]).toMatchObject({ limit: 50 });
  });

  it("returns a summarized observation with navigation hints", async () => {
    const obs = await run(mkDeps(), { action: "sample_table_data", args: { table: "users" } } as AIAgentToolAction);
    const parsed = parseObservation(obs);
    expect(parsed.rowCount).toBe(2);
    expect(parsed.identityColumns).toEqual(["id"]);
    expect(String(parsed.navigation)).toContain("stable-primary-key");
  });
});

describe("run_readonly_sql", () => {
  const depsWithInspected = () => {
    const deps = mkDeps();
    deps.inspectedAgentTables.add("public.users");
    return deps;
  };

  it("requires args.sql", async () => {
    const obs = await run(depsWithInspected(), { action: "run_readonly_sql", args: {} } as AIAgentToolAction);
    expect(obs).toBe("Tool error: run_readonly_sql requires args.sql.");
  });

  it("blocks SQL referencing unknown tables", async () => {
    const obs = await run(
      depsWithInspected(),
      { action: "run_readonly_sql", args: { sql: "SELECT * FROM ghost_table" } } as AIAgentToolAction,
    );
    expect(obs).toContain("Tool blocked: SQL references unknown table(s)");
  });

  it("blocks reads before the schema was inspected", async () => {
    const obs = await run(
      mkDeps(),
      { action: "run_readonly_sql", args: { sql: "SELECT * FROM users LIMIT 1" } } as AIAgentToolAction,
    );
    expect(obs).toContain("Tool blocked: Inspect the schema before reading rows");
  });

  it("auto-runs EXPLAIN for unbounded SELECT statements before executing", async () => {
    const deps = depsWithInspected();
    await run(deps, {
      action: "run_readonly_sql",
      args: { sql: "SELECT * FROM users" },
    } as AIAgentToolAction);
    expect((deps.executeReadonlyQuery as ReturnType<typeof vi.fn>).mock.calls[0][1][0]).toMatch(/^EXPLAIN/i);
    expect((deps.executeReadonlyQuery as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it("skips EXPLAIN when a LIMIT clause exists", async () => {
    const deps = depsWithInspected();
    await run(deps, {
      action: "run_readonly_sql",
      args: { sql: "SELECT * FROM users LIMIT 5" },
    } as AIAgentToolAction);
    expect((deps.executeReadonlyQuery as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("rejects SQL reads on non-SQL engines even if the backend mock would allow them", async () => {
    const deps = depsWithInspected();
    deps.toolAvailability = agentToolAvailability("redis");
    const obs = await run(deps, {
      action: "run_readonly_sql",
      args: { sql: "SELECT * FROM users LIMIT 1" },
    } as AIAgentToolAction);
    expect(obs).toContain("Tool blocked:");
    expect(obs).toContain("Redis");
    expect(deps.executeReadonlyQuery).not.toHaveBeenCalled();
  });

  it.each([
    "UPDATE users SET email = 'x'",
    "DELETE FROM users",
    "DROP TABLE users",
    "INSERT INTO users(email) VALUES('x')",
    "ALTER TABLE users ADD COLUMN x INT",
    "WITH gone AS (DELETE FROM users RETURNING id) SELECT * FROM gone",
  ])("blocks mutating SQL even if the backend mock would allow it: %s", async (sql) => {
    const deps = depsWithInspected();
    const obs = await run(deps, {
      action: "run_readonly_sql",
      args: { sql },
    } as AIAgentToolAction);
    expect(obs).toMatch(/^Tool error:/);
    expect(obs).toMatch(/read-only|only allows/i);
    expect(deps.executeReadonlyQuery).not.toHaveBeenCalled();
  });
});

describe("preview_write", () => {
  it("rejects write previews on non-SQL engines even if the backend mock would allow them", async () => {
    const deps = mkDeps();
    deps.toolAvailability = agentToolAvailability("mongodb");
    const obs = await run(deps, {
      action: "preview_write",
      args: { statements: ["DELETE FROM users WHERE id = 1"] },
    } as AIAgentToolAction);
    expect(obs).toContain("Tool blocked:");
    expect(obs).toContain("MongoDB");
    expect(deps.previewWriteTransaction).not.toHaveBeenCalled();
  });

  it("rejects batches without mutating statements", async () => {
    const obs = await run(mkDeps(), {
      action: "preview_write",
      args: { statements: ["SELECT 1"] },
    } as AIAgentToolAction);
    expect(obs).toContain("requires at least one INSERT/UPDATE/DELETE/ALTER/CREATE statement");
  });

  it("blocks session-switch statements outright", async () => {
    const obs = await run(mkDeps(), {
      action: "preview_write",
      args: { statements: ["DELETE FROM users WHERE id = 1", "USE other_db"] },
    } as AIAgentToolAction);
    expect(obs).toContain("session-switch statements are not allowed");
  });

  it("reports rolled-back effects for valid writes", async () => {
    const obs = await run(mkDeps(), {
      action: "preview_write",
      args: { statements: ["DELETE FROM users WHERE id = 1"] },
    } as AIAgentToolAction);
    const parsed = parseObservation(obs);
    expect(parsed.rolledBack).toBe(true);
    expect(parsed.persisted).toBe(false);
    expect(parsed.statementCount).toBe(1);
  });
});

describe("run_parameterized_sql (MỚI-2)", () => {
  it("executes a read-only parameterized query with coerced bindings", async () => {
    const deps = mkDeps();
    (deps.inspectedAgentTables as Set<string>).add("public.users");
    const obs = await run(deps, {
      action: "run_parameterized_sql",
      args: {
        sql: "SELECT * FROM users WHERE email = :email",
        parameters: [{ name: "email", value: "a@b.c" }],
      },
    } as AIAgentToolAction);
    const parsed = parseObservation(obs);
    expect(parsed.parameterized).toBe(true);
    expect(parsed.parameterCount).toBe(1);
    const call = (deps.executeParameterizedReadonlyQuery as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1]).toBe("SELECT * FROM users WHERE email = :email");
    expect(call[2]).toEqual([{ name: "email", value: "a@b.c", dataType: "text" }]);
  });

  it("rejects mutating SQL and unknown tables without touching the backend", async () => {
    const deps = mkDeps();
    await run(deps, {
      action: "run_parameterized_sql",
      args: { sql: "DELETE FROM users WHERE id = :id", parameters: [{ name: "id", value: 1 }] },
    } as AIAgentToolAction);
    expect(deps.executeParameterizedReadonlyQuery as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();

    const blocked = await run(mkDeps(), {
      action: "run_parameterized_sql",
      args: { sql: "SELECT * FROM ghost WHERE id = :id", parameters: [{ name: "id", value: 1 }] },
    } as AIAgentToolAction);
    expect(blocked).toContain("Tool blocked: SQL references unknown table(s)");
  });

  it("rejects empty parameter lists", async () => {
    const obs = await run(mkDeps(), {
      action: "run_parameterized_sql",
      args: { sql: "SELECT 1", parameters: [] },
    } as unknown as AIAgentToolAction);
    expect(obs).toContain("Tool error: run_parameterized_sql requires bindings");
  });
});

describe("find_value (MỚI-3)", () => {
  it("verifies the column and executes a parameterized exact-match query", async () => {
    const deps = mkDeps();
    const obs = await run(deps, {
      action: "find_value",
      args: { table: "users", column: "email", value: "a@b.c" },
    } as AIAgentToolAction);
    const parsed = parseObservation(obs);
    expect(parsed.table).toBe("public.users");
    expect(parsed.column).toBe("email");
    expect(parsed.parameterized).toBe(true);
    const call = (deps.executeParameterizedReadonlyQuery as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1]).toContain(":value");
    expect(call[2]).toEqual([{ name: "value", value: "a@b.c", dataType: "text" }]);
  });

  it("rejects unknown columns with the actual column list", async () => {
    const obs = await run(mkDeps(), {
      action: "find_value",
      args: { table: "users", column: "nope", value: "x" },
    } as AIAgentToolAction);
    expect(obs).toContain("Available columns: id, email");
  });

  it("uses TOP for MSSQL instead of LIMIT", async () => {
    const deps = mkDeps({ dbType: "mssql" });
    await run(deps, {
      action: "find_value",
      args: { table: "users", column: "email", value: "a@b.c", limit: 3 },
    } as AIAgentToolAction);
    const call = (deps.executeParameterizedReadonlyQuery as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1]).toContain("SELECT TOP (3) * FROM");
    expect(call[1]).not.toContain("LIMIT");
    expect(call[1]).toContain("= :value");
  });
});

describe("check_sql preflight", () => {
  it("passes grounded read-only SQL and never executes anything", async () => {
    const deps = mkDeps();
    deps.inspectedAgentTables = new Set<string>(["public.users"]);
    const obs = await run(deps, {
      action: "check_sql",
      args: { sql: "SELECT id FROM public.users LIMIT 5" },
    } as AIAgentToolAction);
    const parsed = parseObservation(obs);
    expect(parsed.ok).toBe(true);
    expect(deps.executeReadonlyQuery).not.toHaveBeenCalled();
    expect(deps.executeParameterizedReadonlyQuery).not.toHaveBeenCalled();
  });

  it("flags unknown tables and uninspected schemas without executing", async () => {
    const obs = await run(mkDeps(), {
      action: "check_sql",
      args: { sql: "SELECT * FROM public.orders LIMIT 5" },
    } as AIAgentToolAction);
    const parsed = parseObservation(obs);
    expect(parsed.ok).toBe(false);
    expect(JSON.stringify(parsed.issues)).toContain("describe_table");
  });
});

describe("remember_term", () => {
  it("persists glossary entries through the semantic store", async () => {
    const obs = await run(mkDeps(), {
      action: "remember_term",
      args: { term: "churn", definition: "Users who left", kind: "metric" },
    } as AIAgentToolAction);
    const parsed = parseObservation(obs);
    expect(parsed.saved).toBe("churn");
  });

  it("requires both term and definition", async () => {
    const obs = await run(mkDeps(), { action: "remember_term", args: { term: "" } } as AIAgentToolAction);
    expect(obs).toContain("Tool error: remember_term requires");
  });
});

describe("misc guards", () => {
  it("finish does not produce an observation", async () => {
    const obs = await run(mkDeps(), { action: "finish" } as AIAgentToolAction);
    expect(obs).toContain("Tool error: finish does not execute a tool observation.");
  });

  it("formats thrown backend errors as Tool error strings", async () => {
    const deps = mkDeps();
    (deps.getTableData as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("connection refused"));
    const obs = await run(deps, { action: "sample_table_data", args: { table: "users" } } as AIAgentToolAction);
    expect(obs).toContain("Tool error: connection refused");
  });
});
