import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMutationMock = vi.fn();
const invokeWithTimeoutMock = vi.fn();

vi.mock("@/utils/tauri-utils", () => ({
  invokeMutation: (...args: unknown[]) => invokeMutationMock(...args),
  invokeWithTimeout: (...args: unknown[]) => invokeWithTimeoutMock(...args),
}));

import { deriveConnectionName, useConnectionStore } from "@/stores/connectionStore";
import { useGlobalErrorStore } from "@/stores/globalErrorStore";
import { useUIStore } from "@/stores/uiStore";
import type { ConnectionConfig } from "@/types";

const connection = (updates: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  id: "connection-1",
  name: "",
  db_type: "postgresql",
  use_ssl: false,
  ...updates,
});

describe("deriveConnectionName", () => {
  it("preserves an explicit trimmed name", () => {
    expect(deriveConnectionName(connection({ name: "  Production  " }))).toBe("Production");
  });

  it("uses the database and host for server databases", () => {
    expect(
      deriveConnectionName(connection({ host: "db.example.com", database: "analytics" })),
    ).toBe("POSTGRESQL db.example.com / analytics");
  });

  it("uses the local filename for SQLite and DuckDB", () => {
    expect(
      deriveConnectionName(
        connection({ db_type: "sqlite", file_path: "C:\\data\\customers.sqlite" }),
      ),
    ).toBe("SQLite customers.sqlite");
    expect(
      deriveConnectionName(connection({ db_type: "duckdb", file_path: "/data/report.duckdb" })),
    ).toBe("DuckDB report.duckdb");
  });

  it("provides a useful fallback for incomplete configs", () => {
    expect(deriveConnectionName(connection({ db_type: "mysql" }))).toBe("MYSQL connection");
    expect(deriveConnectionName(connection({ db_type: "sqlite" }))).toBe("SQLite local");
  });
});

describe("connectionStore", () => {
  beforeEach(() => {
    invokeMutationMock.mockReset();
    invokeWithTimeoutMock.mockReset();
    useGlobalErrorStore.getState().clearError();
    useUIStore.setState({ tabs: [], activeTabId: null });
    useConnectionStore.setState({
      connections: [],
      activeConnectionId: null,
      connectedIds: new Set(),
      databases: [],
      currentDatabase: null,
      tables: [],
      schemaObjects: [],
      connectionHealth: {},
      isConnecting: false,
      isLoadingDatabases: false,
      isSwitchingDatabase: false,
      isLoadingTables: false,
      isLoadingSchemaObjects: false,
    });
    delete (window as unknown as Record<string, unknown>).ENV_DB_HOST;
  });

  it("removes passwords when loading saved connections", async () => {
    invokeWithTimeoutMock.mockResolvedValue([
      connection({ name: "Production", password: "secret" }),
    ]);

    await useConnectionStore.getState().loadSavedConnections();

    expect(useConnectionStore.getState().connections[0]?.password).toBeUndefined();
  });

  it("rolls back the active workspace when connecting fails", async () => {
    const previousTable = { name: "users", table_type: "table" };
    useConnectionStore.setState({
      activeConnectionId: "previous",
      currentDatabase: "main",
      tables: [previousTable],
    });
    invokeWithTimeoutMock.mockRejectedValue(new Error("connection refused"));

    await expect(
      useConnectionStore.getState().connectToDatabase(connection({ id: "next" })),
    ).rejects.toThrow("connection refused");

    expect(useConnectionStore.getState()).toMatchObject({
      activeConnectionId: "previous",
      currentDatabase: "main",
      tables: [previousTable],
      isConnecting: false,
    });
    expect(useGlobalErrorStore.getState().error).toContain("Connection to target failed");
  });

  it("derives the connection name after resolving environment fields", async () => {
    (window as unknown as Record<string, unknown>).ENV_DB_HOST = "db.internal";
    invokeWithTimeoutMock.mockImplementation((command: string) =>
      Promise.resolve(command === "connect_database" ? undefined : []),
    );

    await useConnectionStore
      .getState()
      .connectToDatabase(connection({ host: "$DB_HOST", database: "analytics" }));

    expect(invokeWithTimeoutMock).toHaveBeenCalledWith(
      "connect_database",
      expect.objectContaining({
        config: expect.objectContaining({
          host: "db.internal",
          name: "POSTGRESQL db.internal / analytics",
        }),
        requestId: expect.any(String),
      }),
      30_000,
      "Connecting to database",
      expect.objectContaining({ onTimeout: expect.any(Function) }),
    );
  });

  it("clears stale connection state when metadata reports a missing connection", async () => {
    useConnectionStore.setState({
      activeConnectionId: "connection-1",
      connectedIds: new Set(["connection-1"]),
      currentDatabase: "app",
    });
    invokeWithTimeoutMock.mockRejectedValue(new Error("Please connect first"));

    await useConnectionStore.getState().fetchTables("connection-1", "app");

    expect(useConnectionStore.getState().activeConnectionId).toBeNull();
    expect(useConnectionStore.getState().connectedIds.size).toBe(0);
    expect(useGlobalErrorStore.getState().error).toContain("Failed to list tables");
  });

  it("removes connection tabs after a successful disconnect", async () => {
    invokeMutationMock.mockResolvedValue(undefined);
    useConnectionStore.setState({
      activeConnectionId: "connection-1",
      connectedIds: new Set(["connection-1"]),
    });
    useUIStore.getState().addTab({
      id: "query-1",
      type: "query",
      title: "Query",
      connectionId: "connection-1",
    });

    await useConnectionStore.getState().disconnectFromDatabase("connection-1");

    expect(useConnectionStore.getState().activeConnectionId).toBeNull();
    expect(useUIStore.getState().tabs).toEqual([]);
  });

  it("tracks health independently for each connection", () => {
    const store = useConnectionStore.getState();
    store.setConnectionHealth("one", true);
    store.setConnectionHealth("two", false);
    expect(useConnectionStore.getState().connectionHealth).toEqual({
      one: true,
      two: false,
    });
  });
});
