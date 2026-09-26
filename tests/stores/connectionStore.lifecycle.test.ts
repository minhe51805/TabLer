import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMutationMock = vi.fn();
const invokeWithTimeoutMock = vi.fn();

vi.mock("@/utils/tauri-utils", () => ({
  invokeMutation: (...args: unknown[]) => invokeMutationMock(...args),
  invokeWithTimeout: (...args: unknown[]) => invokeWithTimeoutMock(...args),
}));

import { useConnectionStore } from "@/stores/connectionStore";
import { useGlobalErrorStore } from "@/stores/globalErrorStore";
import { useUIStore } from "@/stores/uiStore";
import { resetSchemaCacheForTests } from "@/utils/schema-cache";
import type { ConnectionConfig } from "@/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const connection = (updates: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  id: "connection-1",
  name: "",
  db_type: "postgresql",
  use_ssl: false,
  ...updates,
});

beforeEach(() => {
  invokeMutationMock.mockReset();
  invokeWithTimeoutMock.mockReset();
  resetSchemaCacheForTests();
  useGlobalErrorStore.getState().clearError();
  useUIStore.setState({ tabs: [], activeTabId: null });
  window.localStorage.clear();
  useConnectionStore.setState({
    connections: [],
    activeConnectionId: null,
    connectedIds: new Set(),
    databases: [],
    currentDatabase: null,
    tables: [],
    schemaObjects: [],
    connectionHealth: {},
    recentConnectionIds: [],
    isConnecting: false,
    isLoadingDatabases: false,
    isSwitchingDatabase: false,
    isLoadingTables: false,
    isLoadingSchemaObjects: false,
    connectError: null,
  });
});

describe("connectionStore.connectSavedConnection failure", () => {
  it("publishes a structured connectError and stays on the connecting screen", async () => {
    useConnectionStore.setState({
      connections: [connection({ id: "conn-7", database: "app" })],
    });
    invokeWithTimeoutMock.mockRejectedValue({
      stage: "auth",
      message: "password authentication failed",
      hint: "Check the saved credentials.",
    });

    await useConnectionStore.getState().connectSavedConnection("conn-7");

    const state = useConnectionStore.getState();
    expect(state.connectError).toEqual({
      id: "conn-7",
      stage: "auth",
      message: "password authentication failed",
      hint: "Check the saved credentials.",
    });
    // The failed target stays active so <WorkspaceConnecting> keeps rendering
    // and swaps its skeleton for the error — but it is NOT connected.
    expect(state.activeConnectionId).toBe("conn-7");
    expect(state.isConnecting).toBe(false);
    expect(state.connectedIds.has("conn-7")).toBe(false);
    expect(useGlobalErrorStore.getState().error).toBeNull();
  });

  it("normalizes unstructured rejections to stage 'unknown'", async () => {
    useConnectionStore.setState({ connections: [connection({ id: "conn-7" })] });
    invokeWithTimeoutMock.mockRejectedValue(new Error("socket hung up"));

    await useConnectionStore.getState().connectSavedConnection("conn-7");

    expect(useConnectionStore.getState().connectError).toEqual({
      id: "conn-7",
      stage: "unknown",
      message: "socket hung up",
      hint: "",
    });
  });
});

describe("connectionStore.cancelConnectionAttempt", () => {
  it("invokes cancel_connection_attempt and turns a late resolve into a no-op", async () => {
    const pending = deferred<undefined>();
    invokeWithTimeoutMock.mockReturnValue(pending.promise);
    invokeMutationMock.mockResolvedValue(undefined);
    useConnectionStore.setState({
      connections: [connection({ id: "conn-7", database: "app" })],
    });

    const attempt = useConnectionStore.getState().connectSavedConnection("conn-7");
    // Let the attempt reach the backend call so a requestId exists.
    await vi.waitFor(() =>
      expect(invokeWithTimeoutMock).toHaveBeenCalledWith(
        "connect_saved_connection",
        expect.objectContaining({ connectionId: "conn-7", requestId: expect.any(String) }),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      ),
    );
    const requestId = (invokeWithTimeoutMock.mock.calls[0][1] as { requestId: string }).requestId;

    useConnectionStore.getState().cancelConnectionAttempt();

    // The backend attempt is asked to abort with the in-flight request id.
    expect(invokeMutationMock).toHaveBeenCalledWith("cancel_connection_attempt", { requestId });
    expect(useConnectionStore.getState().isConnecting).toBe(false);

    // Late success must be a no-op: no connectedIds entry, no recents bump.
    pending.resolve(undefined);
    await attempt;

    const state = useConnectionStore.getState();
    expect(state.connectedIds.has("conn-7")).toBe(false);
    expect(state.recentConnectionIds).toEqual([]);
    expect(state.connectError).toBeNull();
    // Only the cancel call reached the mutation channel — no startup commands.
    expect(
      invokeMutationMock.mock.calls.filter(([cmd]) => cmd !== "cancel_connection_attempt"),
    ).toEqual([]);
  });

  it("drops a late rejection too — no error screen after cancel", async () => {
    const pending = deferred<undefined>();
    invokeWithTimeoutMock.mockReturnValue(pending.promise);
    invokeMutationMock.mockResolvedValue(undefined);
    useConnectionStore.setState({ connections: [connection({ id: "conn-7" })] });

    const attempt = useConnectionStore.getState().connectSavedConnection("conn-7");
    await vi.waitFor(() => expect(invokeWithTimeoutMock).toHaveBeenCalled());

    useConnectionStore.getState().cancelConnectionAttempt();
    pending.reject({ stage: "tcp", message: "refused", hint: "" });
    await attempt;

    expect(useConnectionStore.getState().connectError).toBeNull();
    expect(useConnectionStore.getState().isConnecting).toBe(false);
  });

  it("clears the connecting state without a backend call when nothing is in flight", () => {
    useConnectionStore.setState({ isConnecting: true });

    useConnectionStore.getState().cancelConnectionAttempt();

    expect(invokeMutationMock).not.toHaveBeenCalled();
    expect(useConnectionStore.getState().isConnecting).toBe(false);
  });
});

describe("connectionStore.disconnectFromDatabase", () => {
  it("removes the id from connectedIds and closes the connection's tabs", async () => {
    invokeMutationMock.mockResolvedValue(undefined);
    useConnectionStore.setState({
      activeConnectionId: "conn-1",
      connectedIds: new Set(["conn-1", "conn-2"]),
      currentDatabase: "app",
      tables: [{ name: "t", table_type: "table" }],
    });
    useUIStore.getState().addTab({
      id: "q1",
      type: "query",
      title: "Q",
      connectionId: "conn-1",
    });
    useUIStore.getState().addTab({
      id: "q2",
      type: "query",
      title: "Q2",
      connectionId: "conn-2",
    });

    await useConnectionStore.getState().disconnectFromDatabase("conn-1");

    const state = useConnectionStore.getState();
    expect(invokeMutationMock).toHaveBeenCalledWith("disconnect_database", {
      connectionId: "conn-1",
    });
    expect(state.connectedIds.has("conn-1")).toBe(false);
    expect(state.connectedIds.has("conn-2")).toBe(true);
    expect(state.activeConnectionId).toBeNull();
    expect(state.currentDatabase).toBeNull();
    expect(state.tables).toEqual([]);
    // Only the disconnected connection's tabs close.
    expect(useUIStore.getState().tabs.map((t) => t.id)).toEqual(["q2"]);
  });

  it("keeps tabs when keepTabs is set", async () => {
    invokeMutationMock.mockResolvedValue(undefined);
    useConnectionStore.setState({
      activeConnectionId: "conn-1",
      connectedIds: new Set(["conn-1"]),
    });
    useUIStore.getState().addTab({
      id: "q1",
      type: "query",
      title: "Q",
      connectionId: "conn-1",
    });

    await useConnectionStore.getState().disconnectFromDatabase("conn-1", { keepTabs: true });

    expect(useUIStore.getState().tabs.map((t) => t.id)).toEqual(["q1"]);
    expect(useConnectionStore.getState().connectedIds.has("conn-1")).toBe(false);
  });

  it("reports a backend disconnect failure through the global error store", async () => {
    invokeMutationMock.mockRejectedValue(new Error("backend gone"));
    useConnectionStore.setState({
      activeConnectionId: "conn-1",
      connectedIds: new Set(["conn-1"]),
    });

    await useConnectionStore.getState().disconnectFromDatabase("conn-1");

    expect(useGlobalErrorStore.getState().error).toContain("Disconnect failed");
    // A failed disconnect leaves the session state untouched.
    expect(useConnectionStore.getState().connectedIds.has("conn-1")).toBe(true);
  });
});

describe("connectionStore.deleteSavedConnection", () => {
  it("removes the connection, its recents entry, and its tabs", async () => {
    invokeMutationMock.mockResolvedValue(undefined);
    useConnectionStore.setState({
      connections: [connection({ id: "conn-1" }), connection({ id: "conn-2" })],
      recentConnectionIds: ["conn-1", "conn-2"],
    });
    useUIStore.getState().addTab({
      id: "q1",
      type: "query",
      title: "Q",
      connectionId: "conn-1",
    });
    useUIStore.getState().addTab({
      id: "q2",
      type: "query",
      title: "Q2",
      connectionId: "conn-2",
    });

    await useConnectionStore.getState().deleteSavedConnection("conn-1");

    expect(invokeMutationMock).toHaveBeenCalledWith("delete_saved_connection", {
      connectionId: "conn-1",
    });
    const state = useConnectionStore.getState();
    expect(state.connections.map((c) => c.id)).toEqual(["conn-2"]);
    expect(state.recentConnectionIds).toEqual(["conn-2"]);
    expect(useUIStore.getState().tabs.map((t) => t.id)).toEqual(["q2"]);
    // Persisted recents no longer resurrect the deleted card in the palette.
    expect(JSON.parse(window.localStorage.getItem("tabler.recentConnections") ?? "[]")).toEqual([
      "conn-2",
    ]);
  });

  it("keeps the connection and reports the error when the backend delete fails", async () => {
    invokeMutationMock.mockRejectedValue(new Error("readonly file"));
    useConnectionStore.setState({
      connections: [connection({ id: "conn-1" })],
      recentConnectionIds: ["conn-1"],
    });

    await useConnectionStore.getState().deleteSavedConnection("conn-1");

    expect(useConnectionStore.getState().connections).toHaveLength(1);
    expect(useConnectionStore.getState().recentConnectionIds).toEqual(["conn-1"]);
    expect(useGlobalErrorStore.getState().error).toContain("Delete failed");
  });
});

describe("connectionStore.createLocalDatabase", () => {
  it("forwards the resolved config and returns the created path", async () => {
    invokeMutationMock.mockResolvedValue("C:/data/app.db");
    (window as unknown as Record<string, unknown>).ENV_DATA_DIR = "C:/data";
    const config = connection({
      db_type: "sqlite",
      file_path: "$DATA_DIR/app.db",
      port: -1,
    });

    const created = await useConnectionStore
      .getState()
      .createLocalDatabase(config, "app", ["CREATE TABLE t (id INTEGER)"]);

    expect(created).toBe("C:/data/app.db");
    const [, payload] = invokeMutationMock.mock.calls[0];
    expect(invokeMutationMock.mock.calls[0][0]).toBe("create_local_database");
    expect(payload).toMatchObject({
      databaseName: "app",
      bootstrapStatements: ["CREATE TABLE t (id INTEGER)"],
      config: expect.objectContaining({
        file_path: "C:/data/app.db",
        // Invalid ports are dropped before serde, not sent as -1.
        port: undefined,
      }),
    });
    delete (window as unknown as Record<string, unknown>).ENV_DATA_DIR;
  });

  it("sends bootstrapStatements as null when empty", async () => {
    invokeMutationMock.mockResolvedValue("x.db");

    await useConnectionStore.getState().createLocalDatabase(connection(), "x");

    expect(invokeMutationMock.mock.calls[0][1]).toMatchObject({ bootstrapStatements: null });
  });
});

describe("connectionStore.createSampleDatabase", () => {
  it("persists the sanitized config returned by the backend", async () => {
    invokeMutationMock.mockResolvedValue(
      connection({ id: "sample-1", name: "Demo", password: "embedded" }),
    );

    const saved = await useConnectionStore.getState().createSampleDatabase();

    expect(invokeMutationMock).toHaveBeenCalledWith("create_sample_database", {});
    expect(saved.password).toBeUndefined();
    const state = useConnectionStore.getState();
    expect(state.connections).toHaveLength(1);
    expect(state.connections[0].id).toBe("sample-1");
    expect(state.connections[0].password).toBeUndefined();
  });
});
