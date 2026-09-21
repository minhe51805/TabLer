import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUIStore } from "@/stores/uiStore";
import { EventCenter } from "@/stores/event-center";
import { createAgentToolExecutor } from "@/components/AISlidePanel/ai-agent-tool-executor";
import type { AgentToolExecutorDeps } from "@/components/AISlidePanel/ai-agent-tool-executor";
import type { AIAgentToolAction } from "@/components/AISlidePanel/ai-agent-tools";
import type { TableInfo } from "@/types";

vi.mock("@/utils/semantic-glossary", () => ({
  saveSemanticGlossaryEntry: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/components/AISlidePanel/ai-schema-summary", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, invalidateAgentSchemaSummary: vi.fn() };
});

const CONNECTION_ID = "conn-1";

function tbl(name: string, row_count = 10): TableInfo {
  return { name, schema: "public", table_type: "BASE TABLE", row_count } as TableInfo;
}

function mkDeps(overrides: Partial<AgentToolExecutorDeps> = {}) {
  const base: AgentToolExecutorDeps = {
    connectionId: CONNECTION_ID,
    currentDatabase: "appdb",
    latestTables: [tbl("orders", 40)],
    availableSchemaTables: ["public.orders"],
    relationalSchemaSummaryByTable: new Map(),
    inspectedAgentTables: new Set<string>(),
    requestId: 1,
    requestIdRef: { current: 1 },
    requestDataReadConsent: vi.fn().mockResolvedValue(true),
    publishAgentProgress: vi.fn(),
    getTableColumnsPreview: vi.fn().mockResolvedValue([]),
    getTableStructure: vi.fn().mockResolvedValue({ columns: [], indexes: [], foreign_keys: [] }),
    getTableData: vi.fn(),
    executeReadonlyQuery: vi.fn(),
    executeParameterizedReadonlyQuery: vi.fn(),
    previewWriteTransaction: vi.fn().mockResolvedValue({
      results: [{ affected_rows: 1, rows: [[1]], truncated: false }],
    }),
  };
  return { ...base, ...overrides } as AgentToolExecutorDeps;
}

const queryTab = {
  id: "tab-1",
  type: "query" as const,
  title: "Fix me",
  connectionId: CONNECTION_ID,
};

describe("edit_query_sql EXPLAIN dry-run", () => {
  const originalTabs = useUIStore.getState().tabs;
  beforeEach(() => useUIStore.setState({ tabs: [queryTab] }));
  afterEach(() => {
    useUIStore.setState({ tabs: originalTabs });
    vi.restoreAllMocks();
  });

  async function proposeMutating(deps: AgentToolExecutorDeps, sql: string) {
    const exec = createAgentToolExecutor(deps);
    await exec.runAgentTool({
      action: "preview_write",
      args: { statements: [sql] },
    } as AIAgentToolAction);
    return exec.runAgentTool({
      action: "edit_query_sql",
      args: { tabId: "tab-1", sql, reason: "fix" },
    } as AIAgentToolAction);
  }

  it("attaches the plan summary to a mutating proposal", async () => {
    const emitSpy = vi.spyOn(EventCenter, "emit");
    const explainStatement = vi.fn().mockResolvedValue({
      columns: [
        { name: "QUERY PLAN", data_type: "TEXT", is_nullable: true, is_primary_key: false },
      ],
      rows: [["Update on orders  (cost=0.00..35.50 rows=40 width=72)"]],
      affected_rows: 0,
      execution_time_ms: 1,
      query: "EXPLAIN UPDATE orders SET status = 'done'",
      sandboxed: true,
      truncated: false,
    });
    const obs = await proposeMutating(
      mkDeps({ explainStatement }),
      "UPDATE orders SET status = 'done'",
    );
    expect(explainStatement).toHaveBeenCalledWith(
      CONNECTION_ID,
      "UPDATE orders SET status = 'done'",
    );
    expect(emitSpy).toHaveBeenCalledWith(
      "ai-edit-query-sql",
      expect.objectContaining({
        explain: expect.objectContaining({ status: "ok" }),
      }),
    );
    expect(obs).toContain("EXPLAIN dry-run succeeded");
  });

  it("attaches the engine error when EXPLAIN fails on DML", async () => {
    const emitSpy = vi.spyOn(EventCenter, "emit");
    const explainStatement = vi.fn().mockRejectedValue(new Error('syntax error at or near "SETT"'));
    const obs = await proposeMutating(
      mkDeps({ explainStatement }),
      "UPDATE orders SETT status = 'done'",
    );
    expect(emitSpy).toHaveBeenCalledWith(
      "ai-edit-query-sql",
      expect.objectContaining({
        explain: { status: "error", error: 'syntax error at or near "SETT"' },
      }),
    );
    expect(obs).toContain("EXPLAIN dry-run failed");
  });

  it("marks DDL explain failures as unsupported, not syntax errors", async () => {
    const emitSpy = vi.spyOn(EventCenter, "emit");
    const explainStatement = vi
      .fn()
      .mockRejectedValue(new Error("EXPLAIN is not supported for CREATE"));
    await proposeMutating(mkDeps({ explainStatement }), "CREATE INDEX idx ON orders (status)");
    expect(emitSpy).toHaveBeenCalledWith(
      "ai-edit-query-sql",
      expect.objectContaining({
        explain: expect.objectContaining({ status: "unsupported" }),
      }),
    );
  });

  it("skips the dry-run for read-only proposals", async () => {
    const emitSpy = vi.spyOn(EventCenter, "emit");
    const explainStatement = vi.fn();
    const obs = await createAgentToolExecutor(mkDeps({ explainStatement })).runAgentTool({
      action: "edit_query_sql",
      args: { tabId: "tab-1", sql: "SELECT * FROM orders" },
    } as AIAgentToolAction);
    expect(obs).toContain("waiting for the user to accept");
    expect(explainStatement).not.toHaveBeenCalled();
    expect(emitSpy).toHaveBeenCalledWith(
      "ai-edit-query-sql",
      expect.not.objectContaining({ explain: expect.anything() }),
    );
  });
});
