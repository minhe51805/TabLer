import { vi } from "vitest";
import {
  createAgentToolExecutor,
  type AgentToolExecutorDeps,
} from "@/components/AISlidePanel/ai-agent-tool-executor";
import type { AIAgentToolAction } from "@/components/AISlidePanel/ai-agent-tools";
import type { TableInfo } from "@/types";

/**
 * Shared pure-executor harness for the AISlidePanel tool tests, mirroring the
 * mkDeps()/run()/parseObservation() style of ai-agent-tool-executor.test.ts.
 * Every backend dep is a vi.fn() — no Tauri transport is touched.
 */

export const CONNECTION_ID = "conn-1";
export const DB = "appdb";

export function tbl(name: string, row_count = 10, schema = "public"): TableInfo {
  return { name, schema, table_type: "BASE TABLE", row_count } as TableInfo;
}

export function mkDeps(overrides: Partial<AgentToolExecutorDeps> = {}) {
  const base: AgentToolExecutorDeps = {
    connectionId: CONNECTION_ID,
    currentDatabase: DB,
    latestTables: [tbl("users", 100), tbl("orders", 40), tbl("order_items", 500)],
    availableSchemaTables: ["public.users", "public.orders", "public.order_items"],
    relationalSchemaSummaryByTable: new Map(),
    inspectedAgentTables: new Set<string>(),
    requestId: 1,
    requestIdRef: { current: 1 },
    requestDataReadConsent: vi.fn().mockResolvedValue(true),
    requestDataDestructiveConsent: vi.fn().mockResolvedValue(true),
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
      rows: [
        [1, "a@b.c"],
        [2, "d@e.f"],
      ],
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

export function runTool(deps: AgentToolExecutorDeps, action: Partial<AIAgentToolAction>) {
  return createAgentToolExecutor(deps).runAgentTool(action as AIAgentToolAction);
}

export function parseObservation(obs: string): Record<string, unknown> {
  // Observations may carry enrichment suffixes (column stats, @@facts footer);
  // the JSON payload is the first block.
  const cut = obs.indexOf("\n@@facts:");
  const body = cut === -1 ? obs : obs.slice(0, cut);
  const statsCut = body.indexOf("\n\nColumn stats (whole table):");
  return JSON.parse(statsCut === -1 ? body : body.slice(0, statsCut));
}
