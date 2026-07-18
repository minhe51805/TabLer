import { create } from "zustand";
import { invokeWithTimeout, invokeMutation } from "../utils/tauri-utils";
import type { ColumnDetail, QueryParameter, QueryResult, TableCellUpdateRequest, TableRowDeleteRequest, TableStructure } from "../types";
import { assertQueryAllowed } from "../utils/safe-mode-query-guard";
import { getOrLoadTableColumns, getOrLoadTableStructure } from "../utils/schema-cache";
import { useConnectionStore } from "./connectionStore";
import {
  invokeAIWorkspaceToolMutation,
  invokeAIWorkspaceToolWithTimeout,
} from "../utils/ai-tool-command-client";

export interface QueryState {
  isExecutingQuery: boolean;
  activeQueryRequestId: string | null;

  executeQuery: (connectionId: string, sql: string) => Promise<QueryResult>;
  cancelQuery: () => Promise<boolean>;
  executeParameterizedQuery: (connectionId: string, sql: string, parameters: QueryParameter[]) => Promise<QueryResult>;
  executeSandboxQuery: (
    connectionId: string,
    statements: string[],
    requireReadOnly?: boolean,
  ) => Promise<QueryResult>;
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
    }
  ) => Promise<QueryResult>;
  getTableStructure: (connectionId: string, table: string, database?: string) => Promise<TableStructure>;
  getTableColumnsPreview: (connectionId: string, table: string, database?: string) => Promise<ColumnDetail[]>;
  countRows: (connectionId: string, table: string, database?: string) => Promise<number>;
  countTableNullValues: (connectionId: string, table: string, column: string, database?: string) => Promise<number>;
  updateTableCell: (connectionId: string, request: TableCellUpdateRequest) => Promise<number>;
  applyTableUpdatesAtomically: (connectionId: string, updates: TableCellUpdateRequest[]) => Promise<number>;
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

export const useQueryStore = create<QueryState>((set, get) => ({
  isExecutingQuery: false,
  activeQueryRequestId: null,

  executeQuery: async (connectionId: string, sql: string) => {
    const safety = await assertQueryAllowed(sql, connectionId);
    const requestId = crypto.randomUUID();
    set({ isExecutingQuery: true, activeQueryRequestId: requestId });
    try {
      const result = await invokeMutation<QueryResult>("execute_query", {
        connectionId,
        sql,
        requestId,
      });
      if (safety.hasSchemaMutation) {
        useConnectionStore.getState().invalidateSchemaMetadata(connectionId);
      }
      set((state) => state.activeQueryRequestId === requestId
        ? { isExecutingQuery: false, activeQueryRequestId: null }
        : state);
      return result;
    } catch (e) {
      set((state) => state.activeQueryRequestId === requestId
        ? { isExecutingQuery: false, activeQueryRequestId: null }
        : state);
      throw e;
    }
  },

  cancelQuery: async () => {
    const requestId = get().activeQueryRequestId;
    if (!requestId) return false;
    return invokeMutation<boolean>("cancel_query", { requestId });
  },

  executeSandboxQuery: async (
    connectionId: string,
    statements: string[],
    requireReadOnly = false,
  ) => {
    set({ isExecutingQuery: true });
    try {
      const result = await invokeAIWorkspaceToolMutation(
        "execute_sandboxed_query",
        { connectionId, statements, requireReadOnly },
      );
      set({ isExecutingQuery: false });
      return result;
    } catch (e) {
      set({ isExecutingQuery: false });
      throw e;
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
      "Loading table data"
    );
  },

  getTableStructure: async (connectionId, table, database) =>
    getOrLoadTableStructure(
      { connectionId, database },
      table,
      () => invokeAIWorkspaceToolWithTimeout(
        "get_table_structure",
        { connectionId, table, database: database || null },
        15_000,
        "Loading table structure",
      ),
    ),

  getTableColumnsPreview: async (connectionId, table, database) =>
    getOrLoadTableColumns(
      { connectionId, database },
      table,
      () => invokeWithTimeout<ColumnDetail[]>(
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
      "Counting table rows"
    ),

  countTableNullValues: async (connectionId, table, column, database) =>
    invokeWithTimeout<number>(
      "count_table_null_values",
      { connectionId, table, column, database: database || null },
      10_000,
      "Counting NULL values"
    ),

  updateTableCell: async (connectionId, request) =>
    invokeMutation<number>("update_table_cell", {
      connectionId,
      request: { ...request, database: request.database || null },
    }),

  deleteTableRows: async (connectionId, request) =>
    invokeMutation<number>("delete_table_rows", {
      connectionId,
      request: { ...request, database: request.database || null },
    }),

  applyTableUpdatesAtomically: async (connectionId, updates) =>
    invokeMutation<number>("apply_table_updates_atomically", {
      connectionId,
      updates: updates.map((request) => ({ ...request, database: request.database || null })),
    }),

  insertTableRow: async (connectionId, request) =>
    invokeMutation<number>("insert_table_row", {
      connectionId,
      request: {
        table: request.table,
        database: request.database || null,
        values: request.values,
      },
    }),

  insertTableRowsAtomically: async (connectionId, requests, operationId) =>
    invokeMutation<number>("insert_table_rows_atomically", {
      connectionId,
      operationId,
      requests: requests.map((request) => ({
        table: request.table,
        database: request.database || null,
        values: request.values,
      })),
    }),

  importCsvFileAtomically: async (connectionId, request, operationId) =>
    invokeMutation<number>("import_csv_file_atomically", {
      connectionId,
      operationId,
      request: {
        ...request,
        database: request.database || null,
      },
    }),

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
      },
    }),

  cancelTableExport: async (operationId) =>
    invokeMutation<boolean>("cancel_table_export", { operationId }),

  executeStructureStatements: async (connectionId, statements) => {
    const affectedRows = await invokeMutation<number>("execute_structure_statements", { connectionId, statements });
    useConnectionStore.getState().invalidateSchemaMetadata(connectionId);
    return affectedRows;
  },

  executeParameterizedQuery: async (connectionId, sql, parameters) => {
    const safety = await assertQueryAllowed(sql, connectionId);
    set({ isExecutingQuery: true });
    try {
      const result = await invokeMutation<QueryResult>("execute_parameterized_query", {
        connectionId,
        sql,
        parameters,
      });
      if (safety.hasSchemaMutation) {
        useConnectionStore.getState().invalidateSchemaMetadata(connectionId);
      }
      set({ isExecutingQuery: false });
      return result;
    } catch (error) {
      set({ isExecutingQuery: false });
      throw error;
    }
  },

  getForeignKeyLookupValues: async (connectionId, table, column, search) =>
    invokeWithTimeout<Array<{ value: string | number; label: string }>>(
      "get_foreign_key_lookup_values",
      {
        connection_id: connectionId,
        referenced_table: table,
        referenced_column: column,
        search: search || null,
        limit: 1000,
      },
      30_000,
      "Loading FK lookup values",
    ),
}));
