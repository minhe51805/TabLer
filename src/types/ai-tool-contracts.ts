import type { QueryResult, TableInfo, TableStructure } from "./database";

export interface AIListTablesCommandArgs extends Record<string, unknown> {
  connectionId: string;
  database: string | null;
}

export interface AIGetTableStructureCommandArgs extends Record<string, unknown> {
  connectionId: string;
  table: string;
  database: string | null;
}

export interface AIExecuteSandboxedQueryCommandArgs extends Record<string, unknown> {
  connectionId: string;
  statements: string[];
  requireReadOnly?: boolean;
  requestId?: string;
}

export interface AIPreviewWriteTransactionCommandArgs extends Record<string, unknown> {
  connectionId: string;
  statements: string[];
}

export interface AIPreviewWriteTransactionResult {
  results: QueryResult[];
  rolledBack: boolean;
}

export interface AIWorkspaceToolCommandMap {
  list_tables: {
    args: AIListTablesCommandArgs;
    result: TableInfo[];
  };
  get_table_structure: {
    args: AIGetTableStructureCommandArgs;
    result: TableStructure;
  };
  execute_sandboxed_query: {
    args: AIExecuteSandboxedQueryCommandArgs;
    result: QueryResult;
  };
  preview_write_transaction: {
    args: AIPreviewWriteTransactionCommandArgs;
    result: AIPreviewWriteTransactionResult;
  };
}

export type AIWorkspaceToolCommandName = keyof AIWorkspaceToolCommandMap;

export type AIWorkspaceToolCommandArgs<TCommand extends AIWorkspaceToolCommandName> =
  AIWorkspaceToolCommandMap[TCommand]["args"];

export type AIWorkspaceToolCommandResult<TCommand extends AIWorkspaceToolCommandName> =
  AIWorkspaceToolCommandMap[TCommand]["result"];
