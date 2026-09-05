import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUIStore } from "@/stores/uiStore";
import { EventCenter } from "@/stores/event-center";
import { agentToolAvailability } from "@/components/AISlidePanel/ai-agent-engine-gates";
import { createAgentToolExecutor } from "@/components/AISlidePanel/ai-agent-tool-executor";
import type { AgentToolExecutorDeps } from "@/components/AISlidePanel/ai-agent-tool-executor";
import { AI_AGENT_COLUMN_STATS_MAX_TABLE_ROWS } from "@/components/AISlidePanel/ai-agent-tools";
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

  it("runs whole-table stats only for tables the catalog says are small", async () => {
    const deps = mkDeps();
    const obs = await run(deps, { action: "sample_table_data", args: { table: "users" } } as AIAgentToolAction);
    // users has catalog rowCount 100 (≤ AI_AGENT_COLUMN_STATS_MAX_TABLE_ROWS):
    // one aggregate query runs and the whole-table label is emitted.
    expect((deps.executeReadonlyQuery as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect(obs).toContain("Column stats (whole table):");
  });

  it("falls back to in-memory sample stats for tables above the scan cap", async () => {
    const deps = mkDeps({
      latestTables: [tbl("users", AI_AGENT_COLUMN_STATS_MAX_TABLE_ROWS + 1)],
    });
    const obs = await run(deps, { action: "sample_table_data", args: { table: "users" } } as AIAgentToolAction);
    // No stats SQL at all — the aggregate would scan millions of rows.
    expect((deps.executeReadonlyQuery as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([statements]) => String((statements as string[])[0]).includes("__total"),
    )).toHaveLength(0);
    expect(obs).toContain("Column stats (sample of 2 rows):");
    expect(obs).toContain("email: nullRatio=0, distinct=2");
  });

  it("skips statistics entirely with args.stats=off", async () => {
    const deps = mkDeps();
    const obs = await run(deps, { action: "sample_table_data", args: { table: "users", stats: "off" } } as AIAgentToolAction);
    expect(deps.executeReadonlyQuery).not.toHaveBeenCalled();
    expect(obs).not.toContain("Column stats");
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

describe("unknown tools and timeout hints", () => {
  it("steers the model back with the available tool list on an unknown tool", async () => {
    const obs = await run(mkDeps(), { action: "drop_everything", args: {} } as unknown as AIAgentToolAction);
    expect(obs).toContain('unknown tool "drop_everything"');
    expect(obs).toContain("run_readonly_sql");
    expect(obs).toContain("finish");
  });

  it("keeps the dedicated finish message for finish actions", async () => {
    const obs = await run(mkDeps(), { action: "finish" } as AIAgentToolAction);
    expect(obs).toContain("Tool error: finish does not execute a tool observation.");
  });

  it("appends a narrowing hint when a parameterized query times out", async () => {
    const deps = mkDeps();
    (deps.inspectedAgentTables as Set<string>).add("public.users");
    (deps.executeParameterizedReadonlyQuery as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Parameterized query timed out after 180 seconds."),
    );
    const obs = await run(deps, {
      action: "run_parameterized_sql",
      args: {
        sql: "SELECT * FROM users WHERE email = :email",
        parameters: [{ name: "email", value: "a@b.c" }],
      },
    } as AIAgentToolAction);
    expect(obs).toContain("parameterized query failed: Parameterized query timed out");
    expect(obs).toContain("Run a narrower statement instead");
  });

  it("appends the same narrowing hint to run_readonly_sql timeouts", async () => {
    const deps = mkDeps();
    (deps.inspectedAgentTables as Set<string>).add("public.users");
    (deps.executeReadonlyQuery as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Read-only query timed out after 180 seconds."),
    );
    const obs = await run(deps, {
      action: "run_readonly_sql",
      args: { sql: "SELECT * FROM users" },
    } as AIAgentToolAction);
    expect(obs).toContain("readonly query failed: Read-only query timed out");
    expect(obs).toContain("add a LIMIT");
  });

  it("create_checkpoint snapshots the database and reports the restore path", async () => {
    const createCheckpoint = vi.fn().mockResolvedValue({
      fileName: "1-manual.sql",
      label: "manual checkpoint",
      tableCount: 3,
      rowCount: 11,
    });
    const deps = mkDeps({ createCheckpoint });
    const obs = await run(deps, {
      action: "create_checkpoint",
      args: {},
    } as AIAgentToolAction);
    expect(createCheckpoint).toHaveBeenCalledWith(null);
    expect(obs).toContain("3 tables, 11 rows");
    expect(obs).toContain("/rollback");
  });

  it("create_checkpoint enforces a 3-per-run budget", async () => {
    const createCheckpoint = vi.fn().mockResolvedValue({
      fileName: "1-manual.sql",
      label: "manual checkpoint",
      tableCount: 3,
      rowCount: 11,
    });
    const action = { action: "create_checkpoint", args: {} } as AIAgentToolAction;
    const { runAgentTool } = createAgentToolExecutor(mkDeps({ createCheckpoint }));
    for (let index = 0; index < 3; index += 1) {
      const obs = await runAgentTool(action);
      expect(obs).toContain("Checkpoint created");
    }
    const exhausted = await runAgentTool(action);
    expect(exhausted).toContain("budget exhausted");
  });
});

// Skill loading goes through the backend command; the allowlist gate lives in
// the executor, so it is pinned here without touching the real transport.
vi.mock("@/utils/tauri-utils", () => ({
  invokeMutation: vi.fn(),
}));
vi.mock("@/components/AISlidePanel/hooks/use-agent-memory", () => ({
  invalidateAgentMemoryIndex: vi.fn(),
  getAgentMemoryIndex: vi.fn(),
}));

describe("skill allowlist enforcement", () => {
  it("refuses a skill outside the injected catalog (allowlist mode)", async () => {
    const obs = await run(mkDeps({ allowedSkillNames: ["git-release"] }), {
      action: "skill",
      args: { name: "workspace-helper" },
    });
    expect(obs).toContain("is not in the injected <available_skills> catalog");
  });

  it("loads an allowlisted skill through read_ai_skill", async () => {
    const { invokeMutation } = await import("@/utils/tauri-utils");
    vi.mocked(invokeMutation).mockResolvedValue({ name: "git-release", body: "release steps" });
    const obs = await run(mkDeps({ allowedSkillNames: ["git-release"] }), {
      action: "skill",
      args: { name: "git-release" },
    });
    expect(obs).toContain("release steps");
    expect(vi.mocked(invokeMutation)).toHaveBeenCalledWith("read_ai_skill", { name: "git-release" });
  });

  it("refuses every skill when no allowlist is injected (fail-closed)", async () => {
    const { invokeMutation } = await import("@/utils/tauri-utils");
    vi.mocked(invokeMutation).mockResolvedValue({ name: "git-release", body: "release steps" });
    const obs = await run(mkDeps(), { action: "skill", args: { name: "git-release" } });
    expect(obs).toContain("is not in the injected <available_skills> catalog");
    expect(vi.mocked(invokeMutation)).not.toHaveBeenCalledWith(
      "read_ai_skill",
      expect.anything(),
    );
  });
});

describe("agent memory tools", () => {
  it("reads a memory entry through read_agent_memory in the run scope", async () => {
    const { invokeMutation } = await import("@/utils/tauri-utils");
    vi.mocked(invokeMutation).mockResolvedValue({
      name: "metric-definitions",
      body: "revenue = net sales minus refunds",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    const deps = mkDeps({ memoryScope: { connectionId: CONNECTION_ID, database: DB } });
    const obs = await run(deps, { action: "read_memory", args: { name: "metric-definitions" } });
    expect(obs).toContain("revenue = net sales minus refunds");
    expect(obs).toContain("last updated 2026-01-01T00:00:00Z");
    expect(vi.mocked(invokeMutation)).toHaveBeenCalledWith("read_agent_memory", {
      name: "metric-definitions",
      connectionId: CONNECTION_ID,
      database: DB,
    });
  });

  it("saves memory through save_agent_memory and reports the scope", async () => {
    const { invokeMutation } = await import("@/utils/tauri-utils");
    vi.mocked(invokeMutation).mockResolvedValue({
      name: "naming-convention",
      updatedAt: "2026-02-02T00:00:00Z",
    });
    const deps = mkDeps({ memoryScope: { connectionId: CONNECTION_ID, database: DB } });
    const obs = await run(deps, {
      action: "save_memory",
      args: { name: "naming-convention", body: "orders tables always use snake_case", description: "table naming" },
    });
    expect(obs).toContain("saved for this connection/database scope");
    expect(vi.mocked(invokeMutation)).toHaveBeenCalledWith("save_agent_memory", {
      name: "naming-convention",
      body: "orders tables always use snake_case",
      description: "table naming",
      connectionId: CONNECTION_ID,
      database: DB,
    });
  });

  it("surfaces backend refusals (index full, secrets, limits) as tool errors", async () => {
    const { invokeMutation } = await import("@/utils/tauri-utils");
    vi.mocked(invokeMutation).mockRejectedValue(
      "Refusing to save: the memory body looks like it contains a password. Never store credentials in memory.",
    );
    const obs = await run(mkDeps(), {
      action: "save_memory",
      args: { name: "creds", body: "password: hunter2" },
    });
    expect(obs).toContain("Tool error");
    expect(obs).toContain("password");
  });

  it("requires name and body for save_memory", async () => {
    const obs = await run(mkDeps(), { action: "save_memory", args: { name: "", body: "x" } });
    expect(obs).toContain("requires non-empty args.name");
  });
});

describe("edit_query_sql proposals", () => {
  const originalTabs = useUIStore.getState().tabs;

  const queryTab = {
    id: "tab-1",
    type: "query" as const,
    title: "Fix me",
    connectionId: CONNECTION_ID,
  };

  beforeEach(() => {
    useUIStore.setState({ tabs: [queryTab] });
  });

  afterEach(() => {
    useUIStore.setState({ tabs: originalTabs });
    vi.restoreAllMocks();
  });

  it("refuses a mutating proposal that was never previewed this run", async () => {
    const emitSpy = vi.spyOn(EventCenter, "emit");
    const obs = await run(mkDeps(), {
      action: "edit_query_sql",
      args: {
        tabId: "tab-1",
        sql: "UPDATE orders SET status = 'done'",
        reason: "fix status",
      },
    });
    expect(obs).toContain("was not previewed in this run");
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it("accepts a mutating proposal after the same statement was previewed this run", async () => {
    const emitSpy = vi.spyOn(EventCenter, "emit");
    const deps = mkDeps();
    const exec = createAgentToolExecutor(deps);
    await exec.runAgentTool({
      action: "preview_write",
      args: { statements: ["UPDATE orders SET status = 'done'"] },
    } as AIAgentToolAction);
    const obs = await exec.runAgentTool({
      action: "edit_query_sql",
      args: {
        tabId: "tab-1",
        sql: "UPDATE orders SET status = 'done'",
        reason: "fix status",
      },
    } as AIAgentToolAction);
    expect(obs).toContain("waiting for the user to accept");
    expect(emitSpy).toHaveBeenCalledWith("ai-edit-query-sql", {
      tabId: "tab-1",
      sql: "UPDATE orders SET status = 'done'",
      reason: "fix status",
    });
  });

  it("accepts read-only proposals without a preview", async () => {
    const emitSpy = vi.spyOn(EventCenter, "emit");
    const obs = await run(mkDeps(), {
      action: "edit_query_sql",
      args: {
        tabId: "tab-1",
        sql: "SELECT * FROM orders WHERE status = 'open'",
      },
    });
    expect(obs).toContain("waiting for the user to accept");
    expect(emitSpy).toHaveBeenCalledWith("ai-edit-query-sql", expect.objectContaining({ tabId: "tab-1" }));
  });

  it("refuses proposals that echo the truncation marker", async () => {
    const obs = await run(mkDeps(), {
      action: "edit_query_sql",
      args: {
        tabId: "tab-1",
        sql: "SELECT 1 …[TRUNCATED — showing 2,000 of 9,000 chars]",
      },
    });
    expect(obs).toContain("do not echo the truncation marker");
  });

  it("deletes memory through the backend and invalidates the cache", async () => {
    const { invalidateAgentMemoryIndex } = await import(
      "@/components/AISlidePanel/hooks/use-agent-memory"
    );
    const { invokeMutation } = await import("@/utils/tauri-utils");
    vi.mocked(invokeMutation).mockResolvedValue(undefined as never);
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    const deps = mkDeps({ memoryScope: { connectionId: CONNECTION_ID, database: DB } });
    const obs = await run(deps, { action: "delete_memory", args: { name: "obsolete" } });
    expect(obs).toContain("permanently deleted");
    expect(vi.mocked(invokeMutation)).toHaveBeenCalledWith("delete_agent_memory", {
      name: "obsolete",
      connectionId: CONNECTION_ID,
      database: DB,
    });
    expect(invalidateAgentMemoryIndex).toHaveBeenCalledWith(CONNECTION_ID);
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "workspace-activity" }),
    );
  });

  it("blocks delete_memory when the user withholds consent", async () => {
    const { invokeMutation } = await import("@/utils/tauri-utils");
    const deps = mkDeps({
      memoryScope: { connectionId: CONNECTION_ID, database: DB },
      requestDataReadConsent: vi.fn().mockResolvedValue(false),
    });
    const obs = await run(deps, { action: "delete_memory", args: { name: "obsolete" } });
    expect(obs).toContain("did not approve");
    expect(vi.mocked(invokeMutation)).not.toHaveBeenCalledWith(
      "delete_agent_memory",
      expect.anything(),
    );
  });

  it("requires a name for delete_memory", async () => {
    const obs = await run(mkDeps(), { action: "delete_memory", args: { name: "" } });
    expect(obs).toContain("requires args.name");
  });

  it("refuses unknown or non-query tabIds", async () => {
    const obs = await run(mkDeps(), {
      action: "edit_query_sql",
      args: { tabId: "tab-does-not-exist", sql: "SELECT 1" },
    });
    expect(obs).toContain("open query tab");
  });
});

describe("edit_query_sql createIfMissing", () => {
  it("opens a NEW AI Query tab pre-filled with the SQL when none is open", async () => {
    const openQueryTab = vi.fn(() => true);
    const { runAgentTool } = createAgentToolExecutor(mkDeps({ openQueryTab }));
    const action = {
      action: "edit_query_sql",
      message: "fix tab sql",
      args: { sql: "SELECT TOP 5 * FROM SinhViens", reason: "align tab with schema", createIfMissing: true },
    } as AIAgentToolAction;
    const observation = await runAgentTool(action);
    expect(observation).toContain("created a new AI Query tab");
    expect(openQueryTab).toHaveBeenCalledWith(
      expect.objectContaining({ sql: "SELECT TOP 5 * FROM SinhViens", autoRun: true }),
    );
  });

  it("refuses mutating createIfMissing proposals that were never previewed", async () => {
    const openQueryTab = vi.fn(() => true);
    const { runAgentTool } = createAgentToolExecutor(mkDeps({ openQueryTab }));
    const action = {
      action: "edit_query_sql",
      message: "fix tab sql",
      args: { sql: "UPDATE SinhViens SET HoTen = 'x'", createIfMissing: true },
    } as AIAgentToolAction;
    const observation = await runAgentTool(action);
    expect(observation).toContain("preview_write");
    expect(openQueryTab).not.toHaveBeenCalled();
  });

  it("coerces a string createIfMissing from weak providers", async () => {
    const openQueryTab = vi.fn(() => true);
    const { runAgentTool } = createAgentToolExecutor(mkDeps({ openQueryTab }));
    const action = {
      action: "edit_query_sql",
      message: "open a tab",
      args: { sql: "SELECT TOP 5 * FROM SinhViens", reason: "show rows", createIfMissing: "true" },
    } as unknown as AIAgentToolAction;
    const observation = await runAgentTool(action);
    expect(observation).toContain("created a new AI Query tab");
    expect(openQueryTab).toHaveBeenCalledTimes(1);
  });

  it("reports failure when the requested tab was not actually opened", async () => {
    const openQueryTab = vi.fn(() => false);
    const { runAgentTool } = createAgentToolExecutor(mkDeps({ openQueryTab }));
    const action = {
      action: "edit_query_sql",
      message: "open a tab",
      args: { sql: "SELECT TOP 5 * FROM SinhViens", createIfMissing: true },
    } as AIAgentToolAction;
    const observation = await runAgentTool(action);
    expect(observation).toContain("could not open a new AI Query tab");
  });
});
