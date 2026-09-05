import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMutationMock = vi.fn();
const invokeWithTimeoutMock = vi.fn();

vi.mock("@/utils/tauri-utils", () => ({
  invokeMutation: (...args: unknown[]) => invokeMutationMock(...args),
  invokeWithTimeout: (...args: unknown[]) => invokeWithTimeoutMock(...args),
}));

import { deriveConnectionName, useConnectionStore } from "@/stores/connectionStore";
import { sanitizeConnectionConfig } from "@/stores/connectionStoreHelpers";
import { useGlobalErrorStore } from "@/stores/globalErrorStore";
import { useUIStore } from "@/stores/uiStore";
import { resetSchemaCacheForTests } from "@/utils/schema-cache";
import type { ConnectionConfig } from "@/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const connection = (updates: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  id: "connection-1",
  name: "",
  db_type: "postgresql",
  use_ssl: false,
  ...updates,
});

describe("sanitizeConnectionConfig", () => {
  it("maps persisted startup_commands onto the frontend field", () => {
    const sanitized = sanitizeConnectionConfig(
      connection({
        password: "secret",
        startup_commands: "SET timezone TO 'UTC'",
      } as ConnectionConfig & { startup_commands: string }),
    );
    expect(sanitized.password).toBeUndefined();
    expect(sanitized.startupCommands).toBe("SET timezone TO 'UTC'");
  });
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
    resetSchemaCacheForTests();
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
      45_000,
      "Connecting to database",
      expect.objectContaining({ onTimeout: expect.any(Function) }),
    );
  });

  it("keeps the workspace connected when metadata reports a missing connection", async () => {
    // A single failed metadata command must NOT tear the workspace down or
    // kick the user back to the launcher; only an explicit disconnect does.
    useConnectionStore.setState({
      activeConnectionId: "connection-1",
      connectedIds: new Set(["connection-1"]),
      currentDatabase: "app",
    });
    invokeWithTimeoutMock.mockRejectedValue(new Error("Please connect first"));

    await useConnectionStore.getState().fetchTables("connection-1", "app");

    expect(useConnectionStore.getState().activeConnectionId).toBe("connection-1");
    expect(useConnectionStore.getState().connectedIds.has("connection-1")).toBe(true);
    expect(useGlobalErrorStore.getState().error).toContain("Failed to list tables");
  });

  it("closes catalog-bound tabs when switching databases", async () => {
    invokeMutationMock.mockResolvedValue(undefined);
    invokeWithTimeoutMock.mockResolvedValue([]);
    useConnectionStore.setState({
      activeConnectionId: "connection-1",
      connectedIds: new Set(["connection-1"]),
      currentDatabase: "app",
    });
    useUIStore.getState().addTab({
      id: "table-users",
      type: "table",
      title: "users",
      connectionId: "connection-1",
      database: "app",
      tableName: "users",
    });
    useUIStore.getState().addTab({
      id: "query-1",
      type: "query",
      title: "Query",
      connectionId: "connection-1",
      database: "app",
    });

    await useConnectionStore.getState().switchDatabase("connection-1", "analytics");

    expect(useUIStore.getState().tabs.map((tab) => tab.id)).toEqual(["query-1"]);
    expect(useConnectionStore.getState().currentDatabase).toBe("analytics");
  });

  it("serializes rapid switches so a superseded switch cannot clobber tables", async () => {
    const slowTables = deferred<unknown>();
    invokeMutationMock.mockResolvedValue(undefined);
    invokeWithTimeoutMock.mockImplementation((command: string, args: { database?: string | null }) => {
      if (command === "list_tables") {
        const database = args?.database ?? "";
        // The first (soon superseded) switch resolves its metadata very late.
        if (database === "slow-a") return slowTables.promise;
        return Promise.resolve([{ name: `table_${database}`, table_type: "table" }]);
      }
      return Promise.resolve([]);
    });
    useConnectionStore.setState({
      activeConnectionId: "connection-1",
      connectedIds: new Set(["connection-1"]),
      currentDatabase: null,
    });

    const first = useConnectionStore.getState().switchDatabase("connection-1", "slow-a");
    const second = useConnectionStore.getState().switchDatabase("connection-1", "fast-b");
    await Promise.all([first, second]);

    // The superseded switch must never run `use_database` nor write its
    // tables; only the newest switch (fast-b) may land.
    const useCalls = invokeMutationMock.mock.calls.filter((call) => call[0] === "use_database");
    expect(useCalls).toHaveLength(1);
    expect(useCalls[0][1]).toEqual({ connectionId: "connection-1", database: "fast-b" });
    expect(useConnectionStore.getState().currentDatabase).toBe("fast-b");
    expect(useConnectionStore.getState().tables).toEqual([{ name: "table_fast-b", table_type: "table" }]);
    expect(useConnectionStore.getState().isSwitchingDatabase).toBe(false);
  });

  it("skips the backend round-trip when re-selecting the current database", async () => {
    invokeMutationMock.mockResolvedValue(undefined);
    invokeWithTimeoutMock.mockResolvedValue([]);
    useConnectionStore.setState({
      activeConnectionId: "connection-1",
      connectedIds: new Set(["connection-1"]),
      currentDatabase: "analytics",
    });

    const { switchDatabase } = useConnectionStore.getState();
    await switchDatabase("connection-1", "analytics");
    expect(
      invokeMutationMock.mock.calls.filter(([command]) => command === "use_database"),
    ).toHaveLength(1);
  });

  it("keeps displayed metadata when reconnecting to the same connection and database", async () => {
    invokeMutationMock.mockResolvedValue(undefined);
    // connect_database resolves; metadata fetches stay pending so the
    // preserved state is observable without any re-fetch landing.
    invokeWithTimeoutMock.mockImplementation((command: string) => {
      if (command === "connect_database") return Promise.resolve(undefined);
      return new Promise(() => {});
    });
    const tables = [{ name: "users", table_type: "table" }];
    const schemaObjects = [{ name: "v_orders", object_type: "view" }];
    useConnectionStore.setState({
      activeConnectionId: "connection-1",
      connectedIds: new Set(["connection-1"]),
      currentDatabase: "analytics",
      tables,
      schemaObjects,
    });

    await useConnectionStore.getState().connectToDatabase(
      connection({ id: "connection-1", database: "analytics" }),
    );

    const state = useConnectionStore.getState();
    expect(state.isConnecting).toBe(false);
    expect(state.currentDatabase).toBe("analytics");
    // Same connection + same database: the on-screen metadata survives.
    expect(state.tables).toEqual([{ name: "users", table_type: "table" }]);
    expect(state.schemaObjects).toEqual(schemaObjects);
  });

  it("clears displayed metadata when connecting to a different database", async () => {
    invokeMutationMock.mockResolvedValue(undefined);
    invokeWithTimeoutMock.mockImplementation((command: string) => {
      if (command === "connect_database") return Promise.resolve(undefined);
      return new Promise(() => {});
    });
    useConnectionStore.setState({
      activeConnectionId: "connection-1",
      connectedIds: new Set(["connection-1"]),
      currentDatabase: "analytics",
      tables: [{ name: "old_table", table_type: "table" }],
      schemaObjects: [{ name: "v_orders", object_type: "view" }],
    });

    await useConnectionStore.getState().connectToDatabase(
      connection({ id: "connection-1", database: "other" }),
    );

    const state = useConnectionStore.getState();
    expect(state.currentDatabase).toBe("other");
    expect(state.schemaObjects).toEqual([]);
    expect(state.tables).toEqual([]);
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
