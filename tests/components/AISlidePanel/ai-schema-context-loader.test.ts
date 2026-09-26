import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareAIWorkspaceSchemaContext } from "@/components/AISlidePanel/ai-schema-context-loader";
import { invalidateAgentSchemaSummary } from "@/components/AISlidePanel/ai-schema-summary";
import { tbl } from "./ai-agent-test-harness";
import type { ColumnDetail, TableInfo, TableStructure } from "@/types";

const TABLES: TableInfo[] = [tbl("users", 100), tbl("orders", 40)];

const COLUMNS: ColumnDetail[] = [
  { name: "id", data_type: "INT", is_nullable: false, is_primary_key: true } as ColumnDetail,
];

function structure(): TableStructure {
  return { columns: COLUMNS, indexes: [], foreign_keys: [], triggers: [] } as TableStructure;
}

function mkOptions(overrides: Record<string, unknown> = {}) {
  const getTableStructure = vi.fn().mockResolvedValue(structure());
  const getTableColumnsPreview = vi.fn().mockResolvedValue(COLUMNS);
  return {
    options: {
      connectionId: "conn-1",
      currentDatabase: "appdb",
      interactionMode: "agent" as const,
      // "join" forces the relational codec so getTableStructure (not the
      // columns preview) is the backend call under test.
      intent: "sql" as const,
      normalizedPrompt: "join orders and users",
      isCurrentRequest: () => true,
      isLocalProvider: false,
      schemaCodecCache: new Map<string, string>(),
      schemaContextEnabled: true,
      tables: TABLES,
      getTableColumnsPreview,
      getTableStructure,
    },
    getTableStructure,
    getTableColumnsPreview,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // The schema summary cache is module-global; clear it between cases.
  invalidateAgentSchemaSummary();
});

describe("prepareAIWorkspaceSchemaContext", () => {
  it("short-circuits without backend calls when schema context is disabled", async () => {
    const { options, getTableStructure, getTableColumnsPreview } = mkOptions();
    options.schemaContextEnabled = false;
    const result = await prepareAIWorkspaceSchemaContext(options);
    expect(result.availableSchemaTables).toEqual([]);
    expect(result.relationalSchemaSummaryByTable.size).toBe(0);
    expect(getTableStructure).not.toHaveBeenCalled();
    expect(getTableColumnsPreview).not.toHaveBeenCalled();
  });

  it("serves codec entries and the schema summary from cache on a repeat call", async () => {
    const { options, getTableStructure } = mkOptions();
    const codecCache = options.schemaCodecCache;
    const opts = { ...options, schemaCodecCache: codecCache };

    await prepareAIWorkspaceSchemaContext(opts);
    // 2 codec entries (relational) + up to 2 summary detail lines.
    const firstCallCount = getTableStructure.mock.calls.length;
    expect(firstCallCount).toBeGreaterThan(0);

    await prepareAIWorkspaceSchemaContext(opts);
    // Second identical run: summary hit inside TTL + codec cache hit = zero
    // additional backend calls.
    expect(getTableStructure.mock.calls.length).toBe(firstCallCount);
  });

  it("refetches the schema summary after invalidation but keeps codec entries", async () => {
    const { options, getTableStructure } = mkOptions();
    const opts = { ...options, schemaCodecCache: options.schemaCodecCache };
    await prepareAIWorkspaceSchemaContext(opts);
    const baseline = getTableStructure.mock.calls.length;

    invalidateAgentSchemaSummary("conn-1");
    const result = await prepareAIWorkspaceSchemaContext(opts);
    // The summary detail lines refetch; codec entries stay cached, so the
    // delta is exactly the summary's detail-table count (2 tables).
    expect(getTableStructure.mock.calls.length).toBe(baseline + TABLES.length);
    expect(result.context).toContain("Workspace schema summary");
  });
  it("is safe with no connection id", async () => {
    const { options, getTableStructure } = mkOptions();
    options.connectionId = "";
    const result = await prepareAIWorkspaceSchemaContext(options);
    // No connection → the auto-injected summary is skipped (getAgentSchemaSummary
    // returns null early), but building the capsule context must not throw.
    expect(result.context).not.toContain("Workspace schema summary");
    expect(result.context).toContain("Workspace schema capsule");
    expect(getTableStructure.mock.calls.length).toBeGreaterThan(0);
  });

  it("rejects when the request was superseded mid-build", async () => {
    const { options } = mkOptions();
    options.isCurrentRequest = () => false;
    await expect(prepareAIWorkspaceSchemaContext(options)).rejects.toThrow(
      "replaced by a newer one",
    );
  });
});
