import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_SCHEMA_SUMMARY_CHAR_BUDGET,
  getAgentSchemaSummary,
  invalidateAgentSchemaSummary,
  isSchemaAffectingAgentAction,
} from "@/components/AISlidePanel/ai-schema-summary";
import type { TableInfo, TableStructure } from "@/types/database";

function tbl(name: string, schema = "public"): TableInfo {
  return { name, schema, table_type: "BASE TABLE", row_count: 10 } as TableInfo;
}

function structure(columns: Array<Partial<TableStructure["columns"][number]>>): TableStructure {
  return {
    columns: columns.map((column) => ({
      name: "col",
      data_type: "TEXT",
      is_nullable: true,
      is_primary_key: false,
      ...column,
    })),
    indexes: [],
    foreign_keys: [],
  } as unknown as TableStructure;
}

function mkOptions(overrides: Record<string, unknown> = {}) {
  return {
    connectionId: "conn-1",
    currentDatabase: "appdb",
    normalizedPrompt: "show orders",
    tables: [tbl("users"), tbl("orders")],
    getTableStructure: vi.fn().mockResolvedValue(
      structure([
        { name: "id", data_type: "INT", is_nullable: false, is_primary_key: true },
        { name: "email", data_type: "TEXT" },
      ]),
    ),
    ...overrides,
  };
}

beforeEach(() => {
  invalidateAgentSchemaSummary();
});

describe("getAgentSchemaSummary", () => {
  it("returns null without a connection and never touches the backend", async () => {
    const getTableStructure = vi.fn();
    const summary = await getAgentSchemaSummary(
      mkOptions({ connectionId: null, getTableStructure }) as never,
    );
    expect(summary).toBeNull();
    expect(getTableStructure).not.toHaveBeenCalled();
  });

  it("returns null for an empty catalog", async () => {
    const summary = await getAgentSchemaSummary(mkOptions({ tables: [] }) as never);
    expect(summary).toBeNull();
  });

  it("emits a codec block with columns and PK flags for each table", async () => {
    const summary = await getAgentSchemaSummary(mkOptions() as never);
    expect(summary).toContain("Workspace schema summary");
    expect(summary).toContain("DB=appdb");
    expect(summary).toContain("T:public.users|C:[id:i32!pk+nn");
    expect(summary).toContain("T:public.orders|C:[id:i32!pk+nn");
    expect(summary).toContain("Legend T=table");
  });

  it("serves the second call from cache without refetching", async () => {
    const options = mkOptions();
    await getAgentSchemaSummary(options as never);
    await getAgentSchemaSummary(options as never);
    expect(options.getTableStructure).toHaveBeenCalledTimes(2);
  });

  it("refetches after invalidateAgentSchemaSummary for that connection", async () => {
    const options = mkOptions();
    await getAgentSchemaSummary(options as never);
    invalidateAgentSchemaSummary("conn-1");
    await getAgentSchemaSummary(options as never);
    expect(options.getTableStructure).toHaveBeenCalledTimes(4);
  });

  it("keeps other connections' cache entries on scoped invalidation", async () => {
    const options = mkOptions();
    await getAgentSchemaSummary(options as never);
    invalidateAgentSchemaSummary("other-conn");
    await getAgentSchemaSummary(options as never);
    expect(options.getTableStructure).toHaveBeenCalledTimes(2);
  });

  it("truncates detail lines to the budget and lists the rest by name", async () => {
    const tables = Array.from({ length: 12 }, (_, index) => tbl(`t${index}`));
    const summary = await getAgentSchemaSummary(mkOptions({ tables, charBudget: 400 }) as never);
    expect(summary).not.toBeNull();
    expect(summary!.length).toBeLessThanOrEqual(400);
    expect(summary).toContain("more tables");
  });

  it("falls back to names-only when even one detail line exceeds the cap", async () => {
    const summary = await getAgentSchemaSummary(mkOptions({ charBudget: 60 }) as never);
    expect(summary).toContain("TABLES(2):");
    expect(summary).toContain("table names only");
  });

  it("keeps a stub line for tables whose structure fetch fails", async () => {
    const getTableStructure = vi
      .fn()
      .mockRejectedValueOnce(new Error("denied"))
      .mockResolvedValue(structure([{ name: "id", data_type: "INT" }]));
    const summary = await getAgentSchemaSummary(mkOptions({ getTableStructure }) as never);
    // The prompt ranks "orders" first, so whichever table failed keeps a stub.
    expect(summary).toMatch(/T:public\.\w+\|C:\[\]/);
    expect(summary).toContain("id:i32");
  });
});

describe("isSchemaAffectingAgentAction", () => {
  it("flags write-path tools and ignores read tools", () => {
    expect(isSchemaAffectingAgentAction("preview_write")).toBe(true);
    expect(isSchemaAffectingAgentAction("edit_query_sql")).toBe(true);
    expect(isSchemaAffectingAgentAction("propose_seed_data")).toBe(true);
    expect(isSchemaAffectingAgentAction("restore_checkpoint")).toBe(true);
    expect(isSchemaAffectingAgentAction("describe_table")).toBe(false);
    expect(isSchemaAffectingAgentAction("run_readonly_sql")).toBe(false);
    expect(isSchemaAffectingAgentAction("search_schema")).toBe(false);
  });
});

describe("budget contract", () => {
  it("stays under the ~2k-token cap on a wide catalog", async () => {
    const tables = Array.from({ length: 60 }, (_, index) => tbl(`table_${index}`));
    const summary = await getAgentSchemaSummary(mkOptions({ tables }) as never);
    expect(summary).not.toBeNull();
    expect(summary!.length).toBeLessThanOrEqual(AGENT_SCHEMA_SUMMARY_CHAR_BUDGET + 200);
  });
});
