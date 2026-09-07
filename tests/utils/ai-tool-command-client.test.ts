import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { TableInfo, TableStructure } from "@/types";
import type {
  AIWorkspaceToolCommandArgs,
  AIWorkspaceToolCommandResult,
} from "@/types/ai-tool-contracts";

const invokeMutationMock = vi.fn();
const invokeWithTimeoutMock = vi.fn();

vi.mock("@/utils/tauri-utils", () => ({
  invokeMutation: (...args: unknown[]) => invokeMutationMock(...args),
  invokeWithTimeout: (...args: unknown[]) => invokeWithTimeoutMock(...args),
}));

import {
  invokeAIWorkspaceToolMutation,
  invokeAIWorkspaceToolWithTimeout,
} from "@/utils/ai-tool-command-client";

describe("AI workspace Tauri tool contracts", () => {
  beforeEach(() => {
    invokeMutationMock.mockReset();
    invokeWithTimeoutMock.mockReset();
  });

  it("binds each command name to its exact input and output type", () => {
    expectTypeOf<AIWorkspaceToolCommandArgs<"list_tables">>().toEqualTypeOf<{
      connectionId: string;
      database: string | null;
      [key: string]: unknown;
    }>();
    expectTypeOf<AIWorkspaceToolCommandResult<"list_tables">>().toEqualTypeOf<TableInfo[]>();
    expectTypeOf<AIWorkspaceToolCommandResult<"get_table_structure">>()
      .toEqualTypeOf<TableStructure>();
  });

  it("forwards typed metadata commands through the timeout boundary", async () => {
    const tables: TableInfo[] = [{
      name: "users",
      schema: "public",
      table_type: "BASE TABLE",
    }];
    invokeWithTimeoutMock.mockResolvedValue(tables);

    const result = await invokeAIWorkspaceToolWithTimeout(
      "list_tables",
      { connectionId: "connection-1", database: "public" },
      15_000,
      "Listing tables",
    );

    expect(result).toBe(tables);
    expect(invokeWithTimeoutMock).toHaveBeenCalledWith(
      "list_tables",
      { connectionId: "connection-1", database: "public" },
      15_000,
      "Listing tables",
    );
  });

  it("forwards only sandbox statements through the mutation boundary", async () => {
    const queryResult = {
      columns: [],
      rows: [],
      affected_rows: 0,
      execution_time_ms: 1,
      query: "SELECT 1",
      sandboxed: true,
      truncated: false,
    };
    invokeMutationMock.mockResolvedValue(queryResult);

    const result = await invokeAIWorkspaceToolMutation(
      "execute_sandboxed_query",
      { connectionId: "connection-1", statements: ["SELECT 1"] },
    );

    expect(result).toBe(queryResult);
    expect(invokeMutationMock).toHaveBeenCalledWith(
      "execute_sandboxed_query",
      { connectionId: "connection-1", statements: ["SELECT 1"] },
    );
  });
});
