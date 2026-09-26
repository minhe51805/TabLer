import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMutationMock = vi.fn();

vi.mock("@/utils/tauri-utils", () => ({
  invokeMutation: (...args: unknown[]) => invokeMutationMock(...args),
}));

import { EventCenter } from "@/stores/event-center";
import { useQueryHistoryStore } from "@/stores/queryHistoryStore";
import type { QueryHistoryEntry } from "@/types";

const entry = (overrides: Partial<QueryHistoryEntry> = {}): QueryHistoryEntry => ({
  id: 1,
  connection_id: "conn-1",
  query_text: "SELECT 1",
  executed_at: "2026-09-26T00:00:00Z",
  duration_ms: 5,
  ...overrides,
});

function listenForUpdates() {
  const seen: Array<{ connectionId?: string }> = [];
  const off = EventCenter.on("query-history-updated", (e) => seen.push(e.detail));
  return { seen, off };
}

beforeEach(() => {
  invokeMutationMock.mockReset();
  useQueryHistoryStore.setState({ entries: [], isLoading: false });
});

describe("queryHistoryStore.saveEntry", () => {
  it("prepends the saved entry with its backend id and notifies listeners", async () => {
    useQueryHistoryStore.setState({ entries: [entry({ id: 40 })] });
    invokeMutationMock.mockResolvedValue(41);
    const { seen, off } = listenForUpdates();

    await useQueryHistoryStore.getState().saveEntry("SELECT 2", "conn-1", 12, 3, undefined, "app");
    off();

    const state = useQueryHistoryStore.getState();
    expect(state.entries[0]).toMatchObject({
      id: 41,
      connection_id: "conn-1",
      query_text: "SELECT 2",
      duration_ms: 12,
      row_count: 3,
      database: "app",
    });
    expect(state.entries[1]).toMatchObject({ id: 40 });
    expect(seen).toEqual([{ connectionId: "conn-1" }]);
  });

  it("does not emit when the backend save fails", async () => {
    invokeMutationMock.mockRejectedValue(new Error("disk full"));
    const { seen, off } = listenForUpdates();
    vi.spyOn(console, "error").mockImplementation(() => {});

    await useQueryHistoryStore.getState().saveEntry("SELECT 1", "conn-1", 1);
    off();

    expect(seen).toEqual([]);
    expect(useQueryHistoryStore.getState().entries).toEqual([]);
    vi.restoreAllMocks();
  });
});

describe("queryHistoryStore.deleteEntries", () => {
  it("emits and filters locally only when the backend removed rows", async () => {
    useQueryHistoryStore.setState({
      entries: [entry({ id: 10 }), entry({ id: 11 }), entry({ id: 12 })],
    });
    invokeMutationMock.mockResolvedValue(2);
    const { seen, off } = listenForUpdates();

    const removed = await useQueryHistoryStore.getState().deleteEntries([10, 12], "conn-1");
    off();

    expect(removed).toBe(2);
    expect(useQueryHistoryStore.getState().entries.map((e) => e.id)).toEqual([11]);
    expect(seen).toEqual([{ connectionId: "conn-1" }]);
  });

  it("does not emit when the backend reports zero removals", async () => {
    useQueryHistoryStore.setState({ entries: [entry({ id: 10 })] });
    invokeMutationMock.mockResolvedValue(0);
    const { seen, off } = listenForUpdates();

    const removed = await useQueryHistoryStore.getState().deleteEntries([10], "conn-1");
    off();

    expect(removed).toBe(0);
    expect(useQueryHistoryStore.getState().entries.map((e) => e.id)).toEqual([10]);
    expect(seen).toEqual([]);
  });

  it("short-circuits an empty id list without a backend call", async () => {
    const removed = await useQueryHistoryStore.getState().deleteEntries([]);
    expect(removed).toBe(0);
    expect(invokeMutationMock).not.toHaveBeenCalled();
  });
});

describe("queryHistoryStore.clearHistory", () => {
  it("drops only the targeted connection's entries", async () => {
    useQueryHistoryStore.setState({
      entries: [
        entry({ id: 1, connection_id: "conn-1" }),
        entry({ id: 2, connection_id: "conn-2" }),
        entry({ id: 3, connection_id: "conn-1" }),
      ],
    });
    invokeMutationMock.mockResolvedValue(2);

    const removed = await useQueryHistoryStore.getState().clearHistory("conn-1");

    expect(removed).toBe(2);
    expect(invokeMutationMock).toHaveBeenCalledWith("clear_query_history", {
      connectionId: "conn-1",
    });
    expect(useQueryHistoryStore.getState().entries).toEqual([
      entry({ id: 2, connection_id: "conn-2" }),
    ]);
  });

  it("clears every entry and passes null when no connection is given", async () => {
    useQueryHistoryStore.setState({
      entries: [entry({ id: 1 }), entry({ id: 2, connection_id: "conn-2" })],
    });
    invokeMutationMock.mockResolvedValue(5);

    await useQueryHistoryStore.getState().clearHistory();

    expect(invokeMutationMock).toHaveBeenCalledWith("clear_query_history", {
      connectionId: null,
    });
    expect(useQueryHistoryStore.getState().entries).toEqual([]);
  });
});
