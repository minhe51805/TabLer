import { create } from "zustand";
import { invokeWithTimeout, invokeMutation } from "../utils/tauri-utils";
import type { ColumnDetail, QueryResult, TableCellUpdateRequest, TableRowDeleteRequest, TableStructure } from "../types";

interface QueryState {
  isExecutingQuery: boolean;

  executeQuery: (connectionId: string, sql: string) => Promise<QueryResult>;
  executeSandboxQuery: (connectionId: string, statements: string[]) => Promise<QueryResult>;
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
  deleteTableRows: (connectionId: string, request: TableRowDeleteRequest) => Promise<number>;
  executeStructureStatements: (connectionId: string, statements: string[]) => Promise<number>;
}

export const useQueryStore = create<QueryState>((set) => ({
  isExecutingQuery: false,

  executeQuery: async (connectionId: string, sql: string) => {
    set({ isExecutingQuery: true });
    try {
      const result = await invokeMutation<QueryResult>("execute_query", { connectionId, sql });
      set({ isExecutingQuery: false });
      return result;
    } catch (e) {
      set({ isExecutingQuery: false });
      throw e;
    }
  },

  executeSandboxQuery: async (connectionId: string, statements: string[]) => {
    set({ isExecutingQuery: true });
    try {
      const result = await invokeMutation<QueryResult>("execute_sandboxed_query", { connectionId, statements });
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
    invokeWithTimeout<TableStructure>(
      "get_table_structure",
      { connectionId, table, database: database || null },
      15_000,
      "Loading table structure"
    ),

  getTableColumnsPreview: async (connectionId, table, database) =>
    invokeWithTimeout<ColumnDetail[]>(
      "get_table_columns_preview",
      { connectionId, table, database: database || null },
      15_000,
      "Loading table columns"
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

  executeStructureStatements: async (connectionId, statements) =>
    invokeMutation<number>("execute_structure_statements", { connectionId, statements }),
}));
