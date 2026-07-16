import { describe, it, expect, beforeEach, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { useConnectionStore } from "@/stores/connectionStore";
import { useGlobalErrorStore } from "@/stores/globalErrorStore";
import { resetSchemaCacheForTests } from "@/utils/schema-cache";

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
    resetSchemaCacheForTests();
    useConnectionStore.setState({ tables: [], schemaObjects: [] });
    useGlobalErrorStore.getState().clearError();
  });

  it("shares a single list_tables call for concurrent fetchTables of the same key", async () => {
    const d = deferred<unknown>();
    invokeMock.mockReturnValue(d.promise);

    const { fetchTables } = useConnectionStore.getState();
    const p1 = fetchTables("conn-1", "db");
    const p2 = fetchTables("conn-1", "db");

    const listTablesCalls = invokeMock.mock.calls.filter((c) => c[0] === "list_tables");
    expect(listTablesCalls).toHaveLength(1);

    d.resolve([{ name: "users", table_type: "table" }]);
    await Promise.all([p1, p2]);

    expect(useConnectionStore.getState().tables).toEqual([{ name: "users", table_type: "table" }]);
  });

  it("fires separate calls for different database keys", async () => {
    invokeMock.mockResolvedValue([]);
    const { fetchTables } = useConnectionStore.getState();
    await Promise.all([fetchTables("conn-1", "db-a"), fetchTables("conn-1", "db-b")]);

    const listTablesCalls = invokeMock.mock.calls.filter((c) => c[0] === "list_tables");
    expect(listTablesCalls).toHaveLength(2);
  });

  it("reuses fresh metadata after the previous request settles", async () => {
    invokeMock.mockResolvedValue([]);
    const { fetchTables } = useConnectionStore.getState();
    await fetchTables("conn-1", "db");
    await fetchTables("conn-1", "db");

    const listTablesCalls = invokeMock.mock.calls.filter((c) => c[0] === "list_tables");
    expect(listTablesCalls).toHaveLength(1);
  });

  it("dedups concurrent fetchSchemaObjects of the same key", async () => {
    const d = deferred<unknown>();
    invokeMock.mockReturnValue(d.promise);

    const { fetchSchemaObjects } = useConnectionStore.getState();
    const p1 = fetchSchemaObjects("conn-1", "db");
    const p2 = fetchSchemaObjects("conn-1", "db");

    const calls = invokeMock.mock.calls.filter((c) => c[0] === "list_schema_objects");
    expect(calls).toHaveLength(1);

    d.resolve([{ name: "v_orders", object_type: "view" }]);
    await Promise.all([p1, p2]);

    expect(useConnectionStore.getState().schemaObjects).toEqual([{ name: "v_orders", object_type: "view" }]);
  });
});
