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
}

export type AIWorkspaceToolCommandName = keyof AIWorkspaceToolCommandMap;

export type AIWorkspaceToolCommandArgs<TCommand extends AIWorkspaceToolCommandName> =
  AIWorkspaceToolCommandMap[TCommand]["args"];

export type AIWorkspaceToolCommandResult<TCommand extends AIWorkspaceToolCommandName> =
  AIWorkspaceToolCommandMap[TCommand]["result"];
