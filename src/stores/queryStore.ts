import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invokeWithTimeout, invokeMutation } from "../utils/tauri-utils";
import { emitAppToast } from "../utils/app-toast";
import type {
  ColumnDetail,
  QueryParameter,
  QueryResult,
  TableCellUpdateRequest,
  TableRowDeleteRequest,
  TableStructure,
} from "../types";
import { assertQueryAllowed } from "../utils/safe-mode-query-guard";
import { notifyQueryDone } from "../utils/query-notify";
import {
  getCachedQueryResult,
  invalidateQueryResultCache,
  setCachedQueryResult,
} from "../utils/query-result-cache";
import { getOrLoadTableColumns, getOrLoadTableStructure } from "../utils/schema-cache";
import { useConnectionStore } from "./connectionStore";
import { invokeAIWorkspaceToolWithTimeout } from "../utils/ai-tool-command-client";

export interface QueryState {
  isExecutingQuery: boolean;
  activeQueryRequestId: string | null;
  activeQueryConnectionId: string | null;
  /** Roadmap Phase 3B: progressive row delivery for large read-only queries. */
  progressiveDeliveryEnabled: boolean;
  /** Live count of rows delivered by the progressive channel (null when idle). */
  progressiveRowCount: number | null;
  setProgressiveDeliveryEnabled: (enabled: boolean) => void;

  executeQuery: (
    connectionId: string,
    sql: string,
    options?: { preApproved?: boolean },
  ) => Promise<QueryResult>;
  cancelQuery: () => Promise<boolean>;
  executeParameterizedQuery: (
    connectionId: string,
    sql: string,
    parameters: QueryParameter[],
    options?: { userInitiated?: boolean; preApproved?: boolean },
  ) => Promise<QueryResult>;
  executeSandboxQuery: (
    connectionId: string,
    statements: string[],
    requireReadOnly?: boolean,
    options?: { userInitiated?: boolean; preApproved?: boolean },
  ) => Promise<QueryResult>;
  executeAgentReadonlyQuery: (connectionId: string, statements: string[]) => Promise<QueryResult>;
  executeAgentParameterizedQuery: (
    connectionId: string,
    sql: string,
    parameters: QueryParameter[],
  ) => Promise<QueryResult>;
  previewWriteTransaction: (
    connectionId: string,
    statements: string[],
  ) => Promise<{
    results: QueryResult[];
    rolledBack: boolean;
  }>;
  getTableData: (
    connectionId: string,
    table: string,
    opts?: {
      database?: string;
      offset?: number;
      limit?: number;
      orderBy?: string;
      orderDir?: string;
      filter?: string;
    },
  ) => Promise<QueryResult>;
  getTableStructure: (
    connectionId: string,
    table: string,
    database?: string,
  ) => Promise<TableStructure>;
  getTableColumnsPreview: (
    connectionId: string,
    table: string,
    database?: string,
  ) => Promise<ColumnDetail[]>;
  countRows: (connectionId: string, table: string, database?: string) => Promise<number>;
  countTableNullValues: (
    connectionId: string,
    table: string,
    column: string,
    database?: string,
  ) => Promise<number>;
  updateTableCell: (connectionId: string, request: TableCellUpdateRequest) => Promise<number>;
  applyTableUpdatesAtomically: (
    connectionId: string,
    updates: TableCellUpdateRequest[],
  ) => Promise<number>;
  deleteTableRows: (connectionId: string, request: TableRowDeleteRequest) => Promise<number>;
  insertTableRow: (
    connectionId: string,
    request: { table: string; database?: string; values: [string, unknown][] },
  ) => Promise<number>;
  insertTableRowsAtomically: (
    connectionId: string,
    requests: Array<{ table: string; database?: string; values: [string, unknown][] }>,
    operationId: string,
  ) => Promise<number>;
  importCsvFileAtomically: (
    connectionId: string,
    request: {
      filePath: string;
      table: string;
      database?: string;
      delimiter: "csv" | "tsv";
      hasHeaders: boolean;
      mappings: Array<{ sourceIndex: number; targetColumn: string }>;
    },
    operationId: string,
  ) => Promise<number>;
  cancelCsvImport: (operationId: string) => Promise<boolean>;
  exportTableData: (
    connectionId: string,
    request: {
      table: string;
      database?: string;
      format: "csv" | "jsonl";
      orderBy?: string;
      orderDir?: "ASC" | "DESC";
      filter?: string;
      /** Retry after the user confirmed replacing an existing file. */
      overwrite?: boolean;
    },
    operationId: string,
  ) => Promise<{ filePath: string; format: string; rowCount: number }>;
  cancelTableExport: (operationId: string) => Promise<boolean>;
  executeStructureStatements: (connectionId: string, statements: string[]) => Promise<number>;
  getForeignKeyLookupValues: (
    connectionId: string,
    table: string,
    column: string,
    search?: string,
  ) => Promise<Array<{ value: string | number; label: string }>>;
}

const PROGRESSIVE_DELIVERY_STORAGE_KEY = "tablerogrid.progressive-delivery";

/**
 * Errors that justify retrying a progressive run through the legacy
 * `execute_query` path: transport failures and drivers that don't implement
 * the progressive command. A validation/sandbox denial, timeout, or runtime
 * error must NOT fall through — the legacy path would re-execute a statement
 * the guarded path already refused (or double-run a slow query).
 */
const PROGRESSIVE_FALLBACK_DENY =
  /not allowed|blocked|sandbox|read.only|denied|forbidden|cancel|timed? ?out|permission/i;
const PROGRESSIVE_FALLBACK_ALLOW =
  /unsupported|not supported|unknown command|not implemented|no such command|invalid command|ipc|transport|failed to fetch|channel|webview/i;

function canFallbackToLegacyQuery(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (PROGRESSIVE_FALLBACK_DENY.test(message)) return false;
  return PROGRESSIVE_FALLBACK_ALLOW.test(message);
}

/**
 * Roadmap Phase 3B: only single read-only row-returning statements go through
 * the progressive channel; everything else keeps the legacy path.
 */
export function isProgressiveEligible(sql: string): boolean {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  if (!trimmed || trimmed.includes(";")) return false;
  return /^(select|with|table|values)\b/i.test(trimmed);
}

export const useQueryStore = create<QueryState>((set, get) => ({
  isExecutingQuery: false,
  activeQueryRequestId: null,
  activeQueryConnectionId: null,
  progressiveDeliveryEnabled: (() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem(PROGRESSIVE_DELIVERY_STORAGE_KEY) !== "off";
  })(),
  progressiveRowCount: null,
  setProgressiveDeliveryEnabled: (enabled: boolean) => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(PROGRESSIVE_DELIVERY_STORAGE_KEY, enabled ? "on" : "off");
    }
    set({ progressiveDeliveryEnabled: enabled });
  },

  executeQuery: async (connectionId: string, sql: string, options?: { preApproved?: boolean }) => {
    // Repeat read-only runs within the cache TTL return instantly — before the
    // Safe Mode guard, so a cached hit never re-prompts a confirmation.
    const database = useConnectionStore.getState().currentDatabase;
    const cached = getCachedQueryResult(connectionId, sql, database);
    if (cached) return cached;
    // The editor's Run button is a human decision: a Safe Mode block becomes
    // an interactive confirmation instead of a dead end — unless the AI tab
    // carries the standing full-autonomy grant (`preApproved`). All other
    // callers (agent tools, programmatic sandbox calls) keep the hard block.
    const safety = await assertQueryAllowed(sql, connectionId, {
      userInitiated: true,
      preApproved: options?.preApproved,
    });
    const requestId = crypto.randomUUID();
    set({
      isExecutingQuery: true,
      activeQueryRequestId: requestId,
      activeQueryConnectionId: connectionId,
    });
    const startedAt = Date.now();
    try {
      let result: QueryResult | null = null;
      let unlisten: UnlistenFn | null = null;
      if (get().progressiveDeliveryEnabled && isProgressiveEligible(sql)) {
        // Phase 3B: stream row batches so the UI can show live delivery
        // progress; the command still resolves with the complete result.
        // A listener-setup failure is a transport problem — always fall back.
        try {
          unlisten = await listen<{ connectionId: string; rows: unknown[][]; totalRows: number }>(
            "query-row-batch",
            (event) => {
              if (event.payload.connectionId !== connectionId) return;
              set({ progressiveRowCount: event.payload.totalRows });
            },
          );
        } catch (listenError) {
          console.warn("[Query] Progressive listener unavailable, using legacy path:", listenError);
          unlisten = null;
        }
        if (unlisten) {
          try {
            result = await invokeMutation<QueryResult>("execute_query_progressive", {
              connectionId,
              sql,
              chunkSize: null,
              requestId,
              safeModeApprovedByUser: safety.userConfirmed === true,
            });
          } catch (progressiveError) {
            // Progressive delivery is an optimization; only transport-level or
            // "unsupported" failures may retry through the unguarded legacy
            // path — a sandbox/validation denial must surface as-is.
            if (!canFallbackToLegacyQuery(progressiveError)) {
              throw progressiveError;
            }
            console.warn("[Query] Progressive execution failed, falling back:", progressiveError);
            result = null;
          } finally {
            unlisten();
          }
        }
      }
      if (result === null) {
        result = await invokeMutation<QueryResult>("execute_query", {
          connectionId,
          sql,
          requestId,
          safeModeApprovedByUser: safety.userConfirmed === true,
        });
      }
      set({ progressiveRowCount: null });
      if (safety.hasSchemaMutation) {
        useConnectionStore.getState().invalidateSchemaMetadata(connectionId);
      }
      if (safety.readOnly) {
        setCachedQueryResult(connectionId, sql, database, result);
      } else {
        // A committed write can change what any cached read on this
        // connection would return — drop them all.
        invalidateQueryResultCache(connectionId);
      }
      void notifyQueryDone({
        durationMs: Date.now() - startedAt,
        rowCount: result.rows.length,
      });
      set((state) =>
        state.activeQueryRequestId === requestId
          ? { isExecutingQuery: false, activeQueryRequestId: null, activeQueryConnectionId: null }
          : state,
      );
      return result;
    } catch (e) {
      void notifyQueryDone({ durationMs: Date.now() - startedAt, error: e });
      set((state) =>
        state.activeQueryRequestId === requestId
          ? {
              isExecutingQuery: false,
              activeQueryRequestId: null,
              activeQueryConnectionId: null,
              progressiveRowCount: null,
            }
          : state,
      );
      throw e;
    }
  },

  cancelQuery: async () => {
    const requestId = get().activeQueryRequestId;
    const connectionId = get().activeQueryConnectionId;
    if (!requestId) return false;
    try {
      // cancel_query returns { cancelled, serverConfirmed }: `cancelled` only
      // means a registered request was signalled — without serverConfirmed the
      // backend may still be running the statement, so say so honestly.
      const outcome = await invokeMutation<{ cancelled: boolean; serverConfirmed: boolean }>(
        "cancel_query",
        { requestId, connectionId },
      );
      if (outcome.cancelled && !outcome.serverConfirmed) {
        emitAppToast({
          title: "Cancel requested",
          description:
            "The cancel signal was sent, but this engine has no server-side cancel — the query may still be running.",
          tone: "info",
        });
      }
      return outcome.cancelled;
    } catch (error) {
      // Callers `void` this promise — a failed cancel must surface or the UI
      // keeps a spinner for a query that is still running server-side.
      const message = error instanceof Error ? error.message : String(error);
      emitAppToast({
        title: "Could not cancel the running query",
        description: message,
        tone: "error",
      });
      return false;
    }
  },

  executeSandboxQuery: async (
    connectionId: string,
    statements: string[],
    requireReadOnly = false,
    options?: { userInitiated?: boolean; preApproved?: boolean },
  ) => {
    // Same instant-repeat behaviour as executeQuery: the joined statements are
    // the cache key, so identical batches hit within the TTL.
    const database = useConnectionStore.getState().currentDatabase;
    const cacheSql = statements.join(";\n");
    const cached = getCachedQueryResult(connectionId, cacheSql, database);
    if (cached) return cached;
    const safety = await assertQueryAllowed(cacheSql, connectionId, options);
    const requestId = crypto.randomUUID();
    set({
      isExecutingQuery: true,
      activeQueryRequestId: requestId,
      activeQueryConnectionId: connectionId,
    });
    const startedAt = Date.now();
    try {
      // Bounded: a stuck backend call must never hang an agent run forever —
      // Stop cannot kill an in-flight invoke, so the timeout is the bound.
      const result = await invokeAIWorkspaceToolWithTimeout(
        "execute_sandboxed_query",
        {
          connectionId,
          statements,
          requireReadOnly,
          requestId,
          safeModeApprovedByUser: safety.userConfirmed === true,
        },
        120_000,
        "Sandbox query",
      );
      if (safety.hasSchemaMutation) {
        useConnectionStore.getState().invalidateSchemaMetadata(connectionId);
      }
      if (safety.readOnly) {
        setCachedQueryResult(connectionId, cacheSql, database, result);
      } else {
        invalidateQueryResultCache(connectionId);
      }
      void notifyQueryDone({
        durationMs: Date.now() - startedAt,
        rowCount: result.rows.length,
      });
      set((state) =>
        state.activeQueryRequestId === requestId
          ? { isExecutingQuery: false, activeQueryRequestId: null, activeQueryConnectionId: null }
          : state,
      );
      return result;
    } catch (e) {
      void notifyQueryDone({ durationMs: Date.now() - startedAt, error: e });
      set((state) =>
        state.activeQueryRequestId === requestId
          ? { isExecutingQuery: false, activeQueryRequestId: null, activeQueryConnectionId: null }
          : state,
      );
      throw e;
    }
  },

  executeAgentReadonlyQuery: async (connectionId: string, statements: string[]) => {
    // Read-only is enforced by the backend `execute_agent_readonly_query`
    // command, which pins the boundary server-side. We still run the local
    // safe-mode guard first so blocked policies fail fast with a clear message.
    const safety = await assertQueryAllowed(statements.join(";\n"), connectionId);
    const requestId = crypto.randomUUID();
    set({
      isExecutingQuery: true,
      activeQueryRequestId: requestId,
      activeQueryConnectionId: connectionId,
    });
    try {
      const result = await invokeAIWorkspaceToolWithTimeout(
        "execute_agent_readonly_query",
        {
          connectionId,
          statements,
          requestId,
        },
        60_000,
        "Agent read-only query",
      );
      if (safety.hasSchemaMutation) {
        useConnectionStore.getState().invalidateSchemaMetadata(connectionId);
      }
      set((state) =>
        state.activeQueryRequestId === requestId
          ? { isExecutingQuery: false, activeQueryRequestId: null, activeQueryConnectionId: null }
          : state,
      );
      return result;
    } catch (e) {
      set((state) =>
        state.activeQueryRequestId === requestId
          ? { isExecutingQuery: false, activeQueryRequestId: null, activeQueryConnectionId: null }
          : state,
      );
      throw e;
    }
  },

  executeAgentParameterizedQuery: async (
    connectionId: string,
    sql: string,
    parameters: QueryParameter[],
  ) => {
    // Read-only AND prepared-parameters are both pinned server-side by the
    // `execute_agent_parameterized_query` command; the local safe-mode guard
    // only makes blocked policies fail fast with a clear message.
    const safety = await assertQueryAllowed(sql, connectionId);
    const requestId = crypto.randomUUID();
    set({
      isExecutingQuery: true,
      activeQueryRequestId: requestId,
      activeQueryConnectionId: connectionId,
    });
    try {
      const result = await invokeAIWorkspaceToolWithTimeout(
        "execute_agent_parameterized_query",
        {
          connectionId,
          sql,
          parameters,
          requestId,
        },
        60_000,
        "Agent parameterized query",
      );
      if (safety.hasSchemaMutation) {
        useConnectionStore.getState().invalidateSchemaMetadata(connectionId);
      }
      set((state) =>
        state.activeQueryRequestId === requestId
          ? { isExecutingQuery: false, activeQueryRequestId: null, activeQueryConnectionId: null }
          : state,
      );
      return result;
    } catch (e) {
      set((state) =>
        state.activeQueryRequestId === requestId
          ? { isExecutingQuery: false, activeQueryRequestId: null, activeQueryConnectionId: null }
          : state,
      );
      throw e;
    }
  },

  previewWriteTransaction: async (connectionId, statements) => {
    set({ isExecutingQuery: true });
    try {
      return await invokeAIWorkspaceToolWithTimeout(
        "preview_write_transaction",
        {
          connectionId,
          statements,
        },
        120_000,
        "Write preview",
      );
    } finally {
      set({ isExecutingQuery: false });
    }
  },

  getTableData: async (connectionId, table, opts = {}) => {
    return invokeWithTimeout<QueryResult>(
      "get_table_data",
      {
        connectionId,
        table,
        database: opts.database || null,
        offset: opts.offset || 0,
        limit: opts.limit || 100,
        orderBy: opts.orderBy || null,
        orderDir: opts.orderDir || null,
        filter: opts.filter || null,
      },
      30_000,
      "Loading table data",
    );
  },

  getTableStructure: async (connectionId, table, database) =>
    getOrLoadTableStructure({ connectionId, database }, table, () =>
      invokeAIWorkspaceToolWithTimeout(
        "get_table_structure",
        { connectionId, table, database: database || null },
        15_000,
        "Loading table structure",
      ),
    ),

  getTableColumnsPreview: async (connectionId, table, database) =>
    getOrLoadTableColumns({ connectionId, database }, table, () =>
      invokeWithTimeout<ColumnDetail[]>(
        "get_table_columns_preview",
        { connectionId, table, database: database || null },
        15_000,
        "Loading table columns",
      ),
    ),

  countRows: async (connectionId, table, database) =>
    invokeWithTimeout<number>(
      "count_table_rows",
      { connectionId, table, database: database || null },
      10_000,
      "Counting table rows",
    ),

  countTableNullValues: async (connectionId, table, column, database) =>
    invokeWithTimeout<number>(
      "count_table_null_values",
      { connectionId, table, column, database: database || null },
      10_000,
      "Counting NULL values",
    ),

  updateTableCell: async (connectionId, request) => {
    const affected = await invokeMutation<number>("update_table_cell", {
      connectionId,
      request: { ...request, database: request.database || null },
    });
    invalidateQueryResultCache(connectionId);
    return affected;
  },

  deleteTableRows: async (connectionId, request) => {
    const affected = await invokeMutation<number>("delete_table_rows", {
      connectionId,
      request: { ...request, database: request.database || null },
    });
    invalidateQueryResultCache(connectionId);
    return affected;
  },

  applyTableUpdatesAtomically: async (connectionId, updates) => {
    const affected = await invokeMutation<number>("apply_table_updates_atomically", {
      connectionId,
      updates: updates.map((request) => ({ ...request, database: request.database || null })),
    });
    invalidateQueryResultCache(connectionId);
    return affected;
  },

  insertTableRow: async (connectionId, request) => {
    const affected = await invokeMutation<number>("insert_table_row", {
      connectionId,
      request: {
        table: request.table,
        database: request.database || null,
        values: request.values,
      },
    });
    invalidateQueryResultCache(connectionId);
    return affected;
  },

  insertTableRowsAtomically: async (connectionId, requests, operationId) => {
    const affected = await invokeMutation<number>("insert_table_rows_atomically", {
      connectionId,
      operationId,
      requests: requests.map((request) => ({
        table: request.table,
        database: request.database || null,
        values: request.values,
      })),
    });
    invalidateQueryResultCache(connectionId);
    return affected;
  },

  importCsvFileAtomically: async (connectionId, request, operationId) => {
    const affected = await invokeMutation<number>("import_csv_file_atomically", {
      connectionId,
      operationId,
      request: {
        ...request,
        database: request.database || null,
      },
    });
    invalidateQueryResultCache(connectionId);
    return affected;
  },

  cancelCsvImport: async (operationId) =>
    invokeMutation<boolean>("cancel_csv_import", { operationId }),

  exportTableData: async (connectionId, request, operationId) =>
    invokeMutation<{ filePath: string; format: string; rowCount: number }>("export_table_data", {
      connectionId,
      operationId,
      request: {
        ...request,
        database: request.database || null,
        orderBy: request.orderBy || null,
        orderDir: request.orderDir || null,
        filter: request.filter || null,
        overwrite: request.overwrite ?? false,
      },
    }),

  cancelTableExport: async (operationId) =>
    invokeMutation<boolean>("cancel_table_export", { operationId }),

  executeStructureStatements: async (connectionId, statements) => {
    const affectedRows = await invokeMutation<number>("execute_structure_statements", {
      connectionId,
      statements,
    });
    useConnectionStore.getState().invalidateSchemaMetadata(connectionId);
    invalidateQueryResultCache(connectionId);
    return affectedRows;
  },

  executeParameterizedQuery: async (connectionId, sql, parameters, options) => {
    // Same human-decision treatment as the plain execute path: an editor Run
    // with named parameters must get the confirmation dialog (levels <= 3)
    // instead of a dead end, and a full-autonomy AI tab passes pre-approved.
    const safety = await assertQueryAllowed(sql, connectionId, options);
    const requestId = crypto.randomUUID();
    set({
      isExecutingQuery: true,
      activeQueryRequestId: requestId,
      activeQueryConnectionId: connectionId,
    });
    const startedAt = Date.now();
    try {
      const result = await invokeMutation<QueryResult>("execute_parameterized_query", {
        connectionId,
        sql,
        parameters,
        requestId,
        safeModeApprovedByUser: safety.userConfirmed === true,
      });
      if (safety.hasSchemaMutation) {
        useConnectionStore.getState().invalidateSchemaMetadata(connectionId);
      }
      // Not cached: the key would need the parameter values, and a wrong-key
      // hit is worse than no cache.
      if (!safety.readOnly) invalidateQueryResultCache(connectionId);
      void notifyQueryDone({
        durationMs: Date.now() - startedAt,
        rowCount: result.rows.length,
      });
      set((state) =>
        state.activeQueryRequestId === requestId
          ? { isExecutingQuery: false, activeQueryRequestId: null, activeQueryConnectionId: null }
          : state,
      );
      return result;
    } catch (error) {
      void notifyQueryDone({ durationMs: Date.now() - startedAt, error });
      set((state) =>
        state.activeQueryRequestId === requestId
          ? { isExecutingQuery: false, activeQueryRequestId: null, activeQueryConnectionId: null }
          : state,
      );
      throw error;
    }
  },

  getForeignKeyLookupValues: async (connectionId, table, column, search) =>
    invokeWithTimeout<Array<{ value: string | number; label: string }>>(
      "get_foreign_key_lookup_values",
      {
        connectionId,
        referencedTable: table,
        referencedColumn: column,
        search: search || null,
        limit: 1000,
      },
      30_000,
      "Loading FK lookup values",
    ),
}));
