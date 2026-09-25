import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMutationMock = vi.fn();
const invokeWithTimeoutMock = vi.fn();
const invokeAgentToolMock = vi.fn();

vi.mock("@/utils/tauri-utils", () => ({
  invokeMutation: (...args: unknown[]) => invokeMutationMock(...args),
  invokeWithTimeout: (...args: unknown[]) => invokeWithTimeoutMock(...args),
}));

vi.mock("@/utils/ai-tool-command-client", () => ({
  invokeAIWorkspaceToolWithTimeout: (...args: unknown[]) => invokeAgentToolMock(...args),
  invokeAIWorkspaceToolMutation: (...args: unknown[]) => invokeAgentToolMock(...args),
}));

import { useQueryStore } from "@/stores/queryStore";
import { useSafeModeStore } from "@/stores/safeModeStore";
import { clearQueryResultCache } from "@/utils/query-result-cache";

const queryResult = {
  columns: [],
  rows: [],
  affected_rows: 0,
  execution_time_ms: 3,
  query: "select 1",
  sandboxed: false,
  truncated: false,
};

function safetyDecision(sql: string) {
  const schema = /^\s*(CREATE|ALTER|DROP|TRUNCATE)/i.test(sql);
  const readOnly = /^\s*(SELECT|SHOW|EXPLAIN|WITH|DESCRIBE)/i.test(sql);
  return {
    statements: [{ sql, kind: schema ? "schema" : readOnly ? "read" : "write", readOnly }],
    readOnly,
    hasSchemaMutation: schema,
    parseError: null,
  };
}

describe("queryStore", () => {
  beforeEach(() => {
    invokeMutationMock.mockReset();
    invokeWithTimeoutMock.mockReset();
    invokeAgentToolMock.mockReset();
    invokeAgentToolMock.mockResolvedValue(queryResult);
    invokeWithTimeoutMock.mockImplementation((command: string, args: { sql?: string }) => {
      if (command === "classify_sql_safety") return Promise.resolve(safetyDecision(args.sql || ""));
      return Promise.resolve(queryResult);
    });
    useQueryStore.setState({
      isExecutingQuery: false,
      activeQueryRequestId: null,
      activeQueryConnectionId: null,
    });
    useSafeModeStore.getState().setGlobalLevel(1);
    useSafeModeStore.getState().clearConnectionOverrides();
    clearQueryResultCache();
  });

  it("sends the active connection id when cancelling a query", async () => {
    invokeMutationMock.mockResolvedValue({ cancelled: true, serverConfirmed: true });
    useQueryStore.setState({
      isExecutingQuery: true,
      activeQueryRequestId: "req-1",
      activeQueryConnectionId: "connection-1",
    });

    await expect(useQueryStore.getState().cancelQuery()).resolves.toBe(true);
    expect(invokeMutationMock).toHaveBeenCalledWith("cancel_query", {
      requestId: "req-1",
      connectionId: "connection-1",
    });
  });

  it("tracks query execution and returns the backend result", async () => {
    invokeMutationMock.mockResolvedValue(queryResult);

    const promise = useQueryStore.getState().executeQuery("connection-1", "select 1");
    await Promise.resolve();
    await Promise.resolve();
    expect(useQueryStore.getState().isExecutingQuery).toBe(true);

    await expect(promise).resolves.toEqual(queryResult);
    expect(useQueryStore.getState().isExecutingQuery).toBe(false);
    expect(invokeMutationMock).toHaveBeenCalledWith(
      "execute_query",
      expect.objectContaining({
        connectionId: "connection-1",
        sql: "select 1",
        requestId: expect.any(String),
      }),
    );
  });

  it("serves a repeat read-only query from the cache without hitting the backend", async () => {
    invokeMutationMock.mockResolvedValue(queryResult);

    await useQueryStore.getState().executeQuery("connection-1", "select 1");
    const calls = invokeMutationMock.mock.calls.length;

    const repeat = await useQueryStore.getState().executeQuery("connection-1", "select 1");
    expect(repeat.cached).toBe(true);
    expect(repeat.rows).toEqual(queryResult.rows);
    expect(invokeMutationMock.mock.calls.length).toBe(calls);
    expect(useQueryStore.getState().isExecutingQuery).toBe(false);
  });

  it("invalidates cached reads after a successful write on the connection", async () => {
    invokeMutationMock.mockResolvedValue(queryResult);

    await useQueryStore.getState().executeQuery("connection-1", "select 1");
    await useQueryStore
      .getState()
      .executeQuery("connection-1", "DELETE FROM users", { preApproved: true });
    const calls = invokeMutationMock.mock.calls.length;

    await useQueryStore.getState().executeQuery("connection-1", "select 1");
    expect(invokeMutationMock.mock.calls.length).toBe(calls + 1);
  });
  it("always clears the execution flag after a backend error", async () => {
    invokeAgentToolMock.mockRejectedValue(new Error("database unavailable"));

    await expect(
      useQueryStore.getState().executeSandboxQuery("connection-1", ["select 1"]),
    ).rejects.toThrow("database unavailable");
    expect(useQueryStore.getState().isExecutingQuery).toBe(false);
    expect(useQueryStore.getState().activeQueryRequestId).toBeNull();
  });

  it("sends a request id for sandbox queries and blocks writes in Safe Mode", async () => {
    await useQueryStore.getState().executeSandboxQuery("connection-1", ["select 1"]);
    expect(invokeAgentToolMock).toHaveBeenCalledWith(
      "execute_sandboxed_query",
      expect.objectContaining({
        connectionId: "connection-1",
        statements: ["select 1"],
        requireReadOnly: false,
        requestId: expect.any(String),
      }),
      expect.any(Number),
      expect.any(String),
    );

    invokeAgentToolMock.mockClear();
    await expect(
      useQueryStore.getState().executeSandboxQuery("connection-1", ["DELETE FROM users"]),
    ).rejects.toThrow("Safe Mode level 1");
    expect(invokeAgentToolMock).not.toHaveBeenCalled();
  });

  it("escalates a blocked sandbox write to Safe Mode confirmation when user-initiated", async () => {
    invokeMutationMock.mockResolvedValue(queryResult);
    const autoApprove = () => {
      window.dispatchEvent(
        new CustomEvent("safe-mode-confirm-response", { detail: { approved: true } }),
      );
    };
    window.addEventListener("safe-mode-confirm-request", autoApprove);
    try {
      await useQueryStore
        .getState()
        .executeSandboxQuery("connection-1", ["DELETE FROM users"], false, {
          userInitiated: true,
        });
      expect(invokeAgentToolMock).toHaveBeenCalledWith(
        "execute_sandboxed_query",
        expect.objectContaining({
          connectionId: "connection-1",
          statements: ["DELETE FROM users"],
        }),
        expect.any(Number),
        expect.any(String),
      );
    } finally {
      window.removeEventListener("safe-mode-confirm-request", autoApprove);
    }
  });

  it("cancels a user-initiated sandbox write when Safe Mode confirmation is rejected", async () => {
    invokeMutationMock.mockResolvedValue(queryResult);
    const autoReject = () => {
      window.dispatchEvent(
        new CustomEvent("safe-mode-confirm-response", { detail: { approved: false } }),
      );
    };
    window.addEventListener("safe-mode-confirm-request", autoReject);
    try {
      await expect(
        useQueryStore.getState().executeSandboxQuery("connection-1", ["DELETE FROM users"], false, {
          userInitiated: true,
        }),
      ).rejects.toThrow("Query cancelled by Safe Mode confirmation.");
      expect(invokeAgentToolMock).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("safe-mode-confirm-request", autoReject);
    }
  });

  it("runs a blocked sandbox write without any dialog when pre-approved", async () => {
    invokeMutationMock.mockResolvedValue(queryResult);
    const failOnPrompt = () => {
      throw new Error("no Safe Mode confirmation should be requested");
    };
    window.addEventListener("safe-mode-confirm-request", failOnPrompt);
    try {
      await useQueryStore
        .getState()
        .executeSandboxQuery("connection-1", ["DELETE FROM users"], false, {
          preApproved: true,
        });
      expect(invokeAgentToolMock).toHaveBeenCalledWith(
        "execute_sandboxed_query",
        expect.objectContaining({
          connectionId: "connection-1",
          statements: ["DELETE FROM users"],
          // Backend must honor the human approval and relax its own block.
          safeModeApprovedByUser: true,
        }),
        expect.any(Number),
        expect.any(String),
      );
    } finally {
      window.removeEventListener("safe-mode-confirm-request", failOnPrompt);
    }
  });

  it("passes the user approval flag to the backend after a confirmed dialog", async () => {
    invokeMutationMock.mockResolvedValue(queryResult);
    const autoApprove = () => {
      window.dispatchEvent(
        new CustomEvent("safe-mode-confirm-response", { detail: { approved: true } }),
      );
    };
    window.addEventListener("safe-mode-confirm-request", autoApprove);
    try {
      await useQueryStore.getState().executeQuery("connection-1", "DELETE FROM users");
      expect(invokeMutationMock).toHaveBeenCalledWith(
        "execute_query",
        expect.objectContaining({
          connectionId: "connection-1",
          sql: "DELETE FROM users",
          safeModeApprovedByUser: true,
        }),
      );
    } finally {
      window.removeEventListener("safe-mode-confirm-request", autoApprove);
    }
  });

  it("does not claim user approval for runs that needed no confirmation", async () => {
    invokeMutationMock.mockResolvedValue(queryResult);
    await useQueryStore.getState().executeQuery("connection-1", "select 1");
    expect(invokeMutationMock).toHaveBeenCalledWith(
      "execute_query",
      expect.objectContaining({ safeModeApprovedByUser: false }),
    );
  });

  it("normalizes optional table-data arguments for the Tauri command", async () => {
    invokeWithTimeoutMock.mockResolvedValue(queryResult);

    await useQueryStore.getState().getTableData("connection-1", "users", {
      database: "app",
      offset: 25,
      limit: 50,
    });

    expect(invokeWithTimeoutMock).toHaveBeenCalledWith(
      "get_table_data",
      {
        connectionId: "connection-1",
        table: "users",
        database: "app",
        offset: 25,
        limit: 50,
        orderBy: null,
        orderDir: null,
        filter: null,
      },
      30_000,
      "Loading table data",
    );
  });

  it("offers a Safe Mode confirmation for blocked user-initiated runs and cancels on deny", async () => {
    // User-initiated editor runs (the Run button) get an interactive Safe
    // Mode confirmation instead of a dead-end error; denying cancels before
    // the backend is ever invoked.
    const deny = () => {
      window.dispatchEvent(
        new CustomEvent("safe-mode-confirm-response", { detail: { approved: false } }),
      );
    };
    window.addEventListener("safe-mode-confirm-request", deny, { once: true });

    await expect(
      useQueryStore.getState().executeQuery("connection-1", "DROP TABLE users"),
    ).rejects.toThrow("Query cancelled by Safe Mode confirmation.");
    expect(invokeMutationMock).not.toHaveBeenCalled();
  });

  it("accepts a confirmation response dispatched during the request event", async () => {
    useSafeModeStore.getState().setGlobalLevel(5);
    invokeMutationMock.mockResolvedValue(queryResult);
    const confirm = () => {
      window.dispatchEvent(
        new CustomEvent("safe-mode-confirm-response", { detail: { approved: true } }),
      );
    };
    window.addEventListener("safe-mode-confirm-request", confirm, { once: true });

    await expect(
      useQueryStore.getState().executeQuery("connection-1", "select 1"),
    ).resolves.toEqual(queryResult);
    expect(invokeMutationMock).toHaveBeenCalledTimes(1);
  });

  it("normalizes insert-row and foreign-key lookup requests", async () => {
    invokeMutationMock.mockResolvedValue(1);
    invokeWithTimeoutMock.mockResolvedValue([]);

    await useQueryStore.getState().insertTableRow("connection-1", {
      table: "users",
      values: [["name", "Ada"]],
    });
    await useQueryStore
      .getState()
      .getForeignKeyLookupValues("connection-1", "teams", "id", "platform");

    expect(invokeMutationMock).toHaveBeenCalledWith("insert_table_row", {
      connectionId: "connection-1",
      request: { table: "users", database: null, values: [["name", "Ada"]] },
    });
    expect(invokeWithTimeoutMock).toHaveBeenCalledWith(
      "get_foreign_key_lookup_values",
      {
        connectionId: "connection-1",
        referencedTable: "teams",
        referencedColumn: "id",
        search: "platform",
        limit: 1000,
      },
      30_000,
      "Loading FK lookup values",
    );
  });

  it("routes agent read-only queries through the pinned backend command", async () => {
    await useQueryStore.getState().executeAgentReadonlyQuery("connection-1", ["select 1"]);

    // The agent read tool must call the dedicated command whose read-only
    // boundary is pinned server-side. It must NOT send a `requireReadOnly`
    // flag, since that flag can never be used to lower the boundary here.
    expect(invokeAgentToolMock).toHaveBeenCalledWith(
      "execute_agent_readonly_query",
      expect.objectContaining({
        connectionId: "connection-1",
        statements: ["select 1"],
        requestId: expect.any(String),
      }),
      expect.any(Number),
      expect.any(String),
    );
    const [, args] = invokeAgentToolMock.mock.calls[0];
    expect(args).not.toHaveProperty("requireReadOnly");
  });

  it("blocks agent read-only writes in Safe Mode before reaching the backend", async () => {
    invokeMutationMock.mockResolvedValue(queryResult);

    await expect(
      useQueryStore.getState().executeAgentReadonlyQuery("connection-1", ["DELETE FROM users"]),
    ).rejects.toThrow("Safe Mode level 1");
    expect(invokeAgentToolMock).not.toHaveBeenCalled();
    expect(useQueryStore.getState().isExecutingQuery).toBe(false);
    expect(useQueryStore.getState().activeQueryRequestId).toBeNull();
  });

  it("sends CSV imports as a single atomic backend request", async () => {
    invokeMutationMock.mockResolvedValue(2);

    await expect(
      useQueryStore.getState().insertTableRowsAtomically(
        "connection-1",
        [
          { table: "users", values: [["name", "Ada"]] },
          { table: "users", database: "app", values: [["name", "Grace"]] },
        ],
        "csv-operation-1",
      ),
    ).resolves.toBe(2);

    expect(invokeMutationMock).toHaveBeenCalledWith("insert_table_rows_atomically", {
      connectionId: "connection-1",
      operationId: "csv-operation-1",
      requests: [
        { table: "users", database: null, values: [["name", "Ada"]] },
        { table: "users", database: "app", values: [["name", "Grace"]] },
      ],
    });

    invokeMutationMock.mockResolvedValue(true);
    await expect(useQueryStore.getState().cancelCsvImport("csv-operation-1")).resolves.toBe(true);
    expect(invokeMutationMock).toHaveBeenCalledWith("cancel_csv_import", {
      operationId: "csv-operation-1",
    });
  });

  it("streams selected CSV files without loading rows into frontend memory", async () => {
    invokeMutationMock.mockResolvedValue({
      insertedRows: 50_000,
      verifiedRows: 50_000,
      totalRowsAfter: 60_000,
      warnings: [],
    });

    await expect(
      useQueryStore.getState().importCsvFileAtomically(
        "connection-1",
        {
          filePath: "C:\\imports\\users.csv",
          table: "users",
          database: "app",
          delimiter: "csv",
          hasHeaders: true,
          mappings: [{ sourceIndex: 0, targetColumn: "email" }],
        },
        "csv-file-1",
      ),
    ).resolves.toMatchObject({ insertedRows: 50_000, verifiedRows: 50_000 });

    expect(invokeMutationMock).toHaveBeenCalledWith("import_csv_file_atomically", {
      connectionId: "connection-1",
      operationId: "csv-file-1",
      request: {
        filePath: "C:\\imports\\users.csv",
        table: "users",
        database: "app",
        delimiter: "csv",
        hasHeaders: true,
        mappings: [{ sourceIndex: 0, targetColumn: "email" }],
      },
    });
  });

  it("exports the full table through the backend instead of the loaded page", async () => {
    invokeMutationMock.mockResolvedValue({
      filePath: "C:\\exports\\users.csv",
      format: "csv",
      rowCount: 790,
    });

    await expect(
      useQueryStore.getState().exportTableData(
        "connection-1",
        {
          table: "users",
          database: "app",
          format: "csv",
          orderBy: "id",
          orderDir: "ASC",
        },
        "export-1",
      ),
    ).resolves.toMatchObject({ rowCount: 790 });

    expect(invokeMutationMock).toHaveBeenCalledWith("export_table_data", {
      connectionId: "connection-1",
      operationId: "export-1",
      request: {
        table: "users",
        database: "app",
        format: "csv",
        orderBy: "id",
        orderDir: "ASC",
        filter: null,
        overwrite: false,
      },
    });
  });

  it("sends queued updates through the single atomic backend command", async () => {
    invokeMutationMock.mockResolvedValue(2);
    await expect(
      useQueryStore.getState().applyTableUpdatesAtomically("connection-1", [
        {
          table: "users",
          database: "app",
          target_column: "name",
          value: "Ada",
          primary_keys: [{ column: "id", value: 7 }],
        },
      ]),
    ).resolves.toBe(2);
    expect(invokeMutationMock).toHaveBeenCalledWith("apply_table_updates_atomically", {
      connectionId: "connection-1",
      updates: [
        {
          table: "users",
          database: "app",
          target_column: "name",
          value: "Ada",
          primary_keys: [{ column: "id", value: 7 }],
        },
      ],
    });
  });
});
