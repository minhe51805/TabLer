import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMutationMock = vi.fn();
const invokeWithTimeoutMock = vi.fn();

vi.mock("@/utils/tauri-utils", () => ({
  invokeMutation: (...args: unknown[]) => invokeMutationMock(...args),
  invokeWithTimeout: (...args: unknown[]) => invokeWithTimeoutMock(...args),
}));

import { useQueryStore } from "@/stores/queryStore";
import { useSafeModeStore } from "@/stores/safeModeStore";

const queryResult = {
  columns: [],
  rows: [],
  affected_rows: 0,
  execution_time_ms: 3,
  query: "select 1",
  sandboxed: false,
  truncated: false,
};

describe("queryStore", () => {
  beforeEach(() => {
    invokeMutationMock.mockReset();
    invokeWithTimeoutMock.mockReset();
    useQueryStore.setState({ isExecutingQuery: false });
    useSafeModeStore.getState().setGlobalLevel(1);
    useSafeModeStore.getState().clearConnectionOverrides();
  });

  it("tracks query execution and returns the backend result", async () => {
    invokeMutationMock.mockResolvedValue(queryResult);

    const promise = useQueryStore.getState().executeQuery("connection-1", "select 1");
    await Promise.resolve();
    expect(useQueryStore.getState().isExecutingQuery).toBe(true);

    await expect(promise).resolves.toEqual(queryResult);
    expect(useQueryStore.getState().isExecutingQuery).toBe(false);
    expect(invokeMutationMock).toHaveBeenCalledWith("execute_query", {
      connectionId: "connection-1",
      sql: "select 1",
    });
  });

  it("always clears the execution flag after a backend error", async () => {
    invokeMutationMock.mockRejectedValue(new Error("database unavailable"));

    await expect(
      useQueryStore.getState().executeSandboxQuery("connection-1", ["select 1"]),
    ).rejects.toThrow("database unavailable");
    expect(useQueryStore.getState().isExecutingQuery).toBe(false);
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

  it("blocks unsafe SQL before invoking the backend", async () => {
    await expect(
      useQueryStore.getState().executeQuery("connection-1", "DROP TABLE users"),
    ).rejects.toThrow("Safe Mode level 1");
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
        connection_id: "connection-1",
        referenced_table: "teams",
        referenced_column: "id",
        search: "platform",
        limit: 1000,
      },
      30_000,
      "Loading FK lookup values",
    );
  });

  it("sends CSV imports as a single atomic backend request", async () => {
    invokeMutationMock.mockResolvedValue(2);

    await expect(useQueryStore.getState().insertTableRowsAtomically("connection-1", [
      { table: "users", values: [["name", "Ada"]] },
      { table: "users", database: "app", values: [["name", "Grace"]] },
    ], "csv-operation-1")).resolves.toBe(2);

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
    invokeMutationMock.mockResolvedValue(50_000);

    await expect(useQueryStore.getState().importCsvFileAtomically("connection-1", {
      filePath: "C:\\imports\\users.csv",
      table: "users",
      database: "app",
      delimiter: "csv",
      hasHeaders: true,
      mappings: [{ sourceIndex: 0, targetColumn: "email" }],
    }, "csv-file-1")).resolves.toBe(50_000);

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
    invokeMutationMock.mockResolvedValue({ filePath: "C:\\exports\\users.csv", format: "csv", rowCount: 790 });

    await expect(useQueryStore.getState().exportTableData("connection-1", {
      table: "users",
      database: "app",
      format: "csv",
      orderBy: "id",
      orderDir: "ASC",
    }, "export-1")).resolves.toMatchObject({ rowCount: 790 });

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
      },
    });
  });

  it("sends queued updates through the single atomic backend command", async () => {
    invokeMutationMock.mockResolvedValue(2);
    await expect(useQueryStore.getState().applyTableUpdatesAtomically("connection-1", [
      {
        table: "users",
        database: "app",
        target_column: "name",
        value: "Ada",
        primary_keys: [{ column: "id", value: 7 }],
      },
    ])).resolves.toBe(2);
    expect(invokeMutationMock).toHaveBeenCalledWith("apply_table_updates_atomically", {
      connectionId: "connection-1",
      updates: [{
        table: "users",
        database: "app",
        target_column: "name",
        value: "Ada",
        primary_keys: [{ column: "id", value: 7 }],
      }],
    });
  });
});
