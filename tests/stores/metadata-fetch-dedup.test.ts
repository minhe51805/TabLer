import { describe, it, expect, beforeEach, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { useAppStore } from "@/stores/appStore";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("metadata fetch dedup", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useAppStore.setState({ tables: [], schemaObjects: [], error: null });
  });

  it("shares a single list_tables call for concurrent fetchTables of the same key", async () => {
    const d = deferred<unknown>();
    invokeMock.mockReturnValue(d.promise);

    const { fetchTables } = useAppStore.getState();
    const p1 = fetchTables("conn-1", "db");
    const p2 = fetchTables("conn-1", "db");

    const listTablesCalls = invokeMock.mock.calls.filter((c) => c[0] === "list_tables");
    expect(listTablesCalls).toHaveLength(1);

    d.resolve([{ name: "users", table_type: "table" }]);
    await Promise.all([p1, p2]);

    expect(useAppStore.getState().tables).toEqual([{ name: "users", table_type: "table" }]);
  });

  it("fires separate calls for different database keys", async () => {
    invokeMock.mockResolvedValue([]);
    const { fetchTables } = useAppStore.getState();
    await Promise.all([fetchTables("conn-1", "db-a"), fetchTables("conn-1", "db-b")]);

    const listTablesCalls = invokeMock.mock.calls.filter((c) => c[0] === "list_tables");
    expect(listTablesCalls).toHaveLength(2);
  });

  it("allows a fresh fetch after the previous one settles", async () => {
    invokeMock.mockResolvedValue([]);
    const { fetchTables } = useAppStore.getState();
    await fetchTables("conn-1", "db");
    await fetchTables("conn-1", "db");

    const listTablesCalls = invokeMock.mock.calls.filter((c) => c[0] === "list_tables");
    expect(listTablesCalls).toHaveLength(2);
  });

  it("dedups concurrent fetchSchemaObjects of the same key", async () => {
    const d = deferred<unknown>();
    invokeMock.mockReturnValue(d.promise);

    const { fetchSchemaObjects } = useAppStore.getState();
    const p1 = fetchSchemaObjects("conn-1", "db");
    const p2 = fetchSchemaObjects("conn-1", "db");

    const calls = invokeMock.mock.calls.filter((c) => c[0] === "list_schema_objects");
    expect(calls).toHaveLength(1);

    d.resolve([{ name: "v_orders", object_type: "view" }]);
    await Promise.all([p1, p2]);

    expect(useAppStore.getState().schemaObjects).toEqual([{ name: "v_orders", object_type: "view" }]);
  });
});