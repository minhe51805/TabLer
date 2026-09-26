import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { useDataGridStagedChanges } from "@/components/DataGrid/hooks/useDataGridStagedChanges";
import type { ResolvedColumn } from "@/components/DataGrid/hooks/useDataGrid";
import type { StagedChange } from "@/types/change-tracking";
import type { QueryResult } from "@/types";

const CONNECTION = "conn-1";
const DATABASE = "app";
const TABLE = "users";

const COLUMNS: ResolvedColumn[] = [
  { name: "id", data_type: "INT", is_nullable: false, is_primary_key: true },
  { name: "name", data_type: "TEXT", is_nullable: true, is_primary_key: false },
];

function makeData(): QueryResult {
  return {
    columns: COLUMNS,
    rows: [
      [1, "staged-a"],
      [2, "staged-b"],
    ],
    affected_rows: 0,
    execution_time_ms: 1,
    query: "SELECT fixture",
    sandboxed: false,
    truncated: false,
  } as QueryResult;
}

let nextId = 0;
function makeChange(overrides: Partial<StagedChange>): StagedChange {
  return {
    id: `chg-${++nextId}`,
    type: "update",
    connectionId: CONNECTION,
    tableName: TABLE,
    database: DATABASE,
    rowIndex: 0,
    rowKey: { id: 1 },
    columns: { name: { old: "a", new: "staged-a" } },
    timestamp: Date.now(),
    sqlPreview: "",
    ...overrides,
  };
}

interface HarnessOverrides {
  stagedChanges?: StagedChange[];
  [spy: string]: unknown;
}

function makeHarness(overrides: HarnessOverrides = {}) {
  const spies = {
    setIsLoading: vi.fn(),
    setError: vi.fn(),
    unstageChanges: vi.fn(),
    closePreview: vi.fn(),
    applyTableUpdatesAtomically: vi.fn(async () => ({})),
    insertTableRowsAtomically: vi.fn(async () => ({})),
    invalidateTableCaches: vi.fn(),
    patchLoadedTableCell: vi.fn(),
    refreshTableFromStart: vi.fn(async () => ({})),
    ...overrides,
  };
  const hook = renderHook(
    (props: { stagedChanges: StagedChange[] }) =>
      (() => {
        const [data, setData] = useState<QueryResult | null>(makeData());
        const [stagedRows, setStagedRows] = useState<Set<number>>(new Set());
        const api = useDataGridStagedChanges({
          stagedChanges: props.stagedChanges,
          tableName: TABLE,
          database: DATABASE,
          connectionId: CONNECTION,
          resolvedColumns: COLUMNS,
          setData,
          setStagedRowIndices: setStagedRows,
          setIsLoading: spies.setIsLoading,
          setError: spies.setError,
          unstageChanges: spies.unstageChanges,
          closePreview: spies.closePreview,
          applyTableUpdatesAtomically: spies.applyTableUpdatesAtomically,
          insertTableRowsAtomically: spies.insertTableRowsAtomically,
          invalidateTableCaches: spies.invalidateTableCaches,
          patchLoadedTableCell: spies.patchLoadedTableCell,
          refreshTableFromStart: spies.refreshTableFromStart,
          dataGridInstanceIdRef: { current: "grid-test" },
        });
        return { api, data, stagedRows };
      })(),
    { initialProps: { stagedChanges: overrides.stagedChanges ?? [] } },
  );
  return { hook, spies };
}

describe("applyStagedChanges", () => {
  it("commits updates before inserts, then unstages the whole batch as one unit", async () => {
    const update = makeChange({
      columns: { name: { old: "a", new: "b" } },
    });
    const insert = makeChange({
      type: "insert",
      rowIndex: 5,
      rowKey: {},
      columns: { id: { old: null, new: 9 }, name: { old: null, new: "new-row" } },
    });
    const { hook, spies } = makeHarness({ stagedChanges: [update, insert] });

    await act(async () => {
      await hook.result.current.api.applyStagedChanges();
    });

    expect(spies.applyTableUpdatesAtomically).toHaveBeenCalledWith(CONNECTION, [
      {
        table: TABLE,
        database: DATABASE,
        target_column: "name",
        value: "b",
        primary_keys: [{ column: "id", value: 1 }],
      },
    ]);
    expect(spies.insertTableRowsAtomically).toHaveBeenCalledWith(
      CONNECTION,
      [
        {
          table: TABLE,
          database: DATABASE,
          values: [
            ["id", 9],
            ["name", "new-row"],
          ],
        },
      ],
      expect.stringMatching(/^staged-insert-/),
    );
    // Updates must be attempted before inserts.
    expect(spies.applyTableUpdatesAtomically.mock.invocationCallOrder[0]).toBeLessThan(
      spies.insertTableRowsAtomically.mock.invocationCallOrder[0],
    );
    // One batched unstage call covering both ids = one undo snapshot.
    expect(spies.unstageChanges).toHaveBeenCalledTimes(1);
    expect(spies.unstageChanges).toHaveBeenCalledWith([update.id, insert.id]);
    expect(spies.closePreview).toHaveBeenCalled();
    expect(spies.invalidateTableCaches).toHaveBeenCalledWith(CONNECTION, TABLE, DATABASE);
    expect(spies.refreshTableFromStart).toHaveBeenCalled();
    expect(hook.result.current.stagedRows.size).toBe(0);
  });

  it("refuses a queue containing a staged delete and commits nothing", async () => {
    const update = makeChange({});
    const deletion = makeChange({ type: "delete", columns: {} });
    const { hook, spies } = makeHarness({ stagedChanges: [update, deletion] });

    await act(async () => {
      await hook.result.current.api.applyStagedChanges();
    });

    expect(spies.setError).toHaveBeenCalled();
    expect(spies.applyTableUpdatesAtomically).not.toHaveBeenCalled();
    expect(spies.insertTableRowsAtomically).not.toHaveBeenCalled();
    expect(spies.unstageChanges).not.toHaveBeenCalled();
  });

  it("refuses a change with no resolved columns rather than committing nothing silently", async () => {
    const unresolved = makeChange({ columns: {} });
    const { hook, spies } = makeHarness({ stagedChanges: [unresolved] });

    await act(async () => {
      await hook.result.current.api.applyStagedChanges();
    });

    expect(spies.setError).toHaveBeenCalledWith(expect.stringContaining("no resolved columns"));
    expect(spies.applyTableUpdatesAtomically).not.toHaveBeenCalled();
    expect(spies.unstageChanges).not.toHaveBeenCalled();
  });

  it("keeps the queue when the backend apply fails", async () => {
    const update = makeChange({});
    const applyTableUpdatesAtomically = vi.fn(async () => {
      throw new Error("deadlock detected");
    });
    const { hook, spies } = makeHarness({
      stagedChanges: [update],
      applyTableUpdatesAtomically,
    });

    await act(async () => {
      await hook.result.current.api.applyStagedChanges();
    });

    expect(spies.setError).toHaveBeenCalledWith(expect.stringContaining("deadlock detected"));
    // The staged change survives so the user can retry or discard.
    expect(spies.unstageChanges).not.toHaveBeenCalled();
    expect(spies.refreshTableFromStart).not.toHaveBeenCalled();
  });

  it("ignores staged changes from other table scopes", async () => {
    const foreign = makeChange({ tableName: "other_table" });
    const { hook, spies } = makeHarness({ stagedChanges: [foreign] });

    await act(async () => {
      await hook.result.current.api.applyStagedChanges();
    });

    expect(spies.applyTableUpdatesAtomically).not.toHaveBeenCalled();
    expect(spies.setError).not.toHaveBeenCalled();
  });
});

describe("discardStagedChanges", () => {
  it("unstages only this scope's changes and reloads the grid", async () => {
    const mine = makeChange({});
    const foreign = makeChange({ tableName: "other_table" });
    const { hook, spies } = makeHarness({ stagedChanges: [mine, foreign] });

    await act(async () => {
      hook.result.current.api.discardStagedChanges();
    });

    expect(spies.unstageChanges).toHaveBeenCalledTimes(1);
    expect(spies.unstageChanges).toHaveBeenCalledWith([mine.id]);
    expect(spies.closePreview).toHaveBeenCalled();
    expect(spies.refreshTableFromStart).toHaveBeenCalled();
    expect(hook.result.current.stagedRows.size).toBe(0);
  });
});

describe("reconcileStagedChanges", () => {
  it("rolls cells back to old values when a change leaves the queue (undo)", async () => {
    const change = makeChange({
      rowIndex: 0,
      rowKey: { id: 1 },
      columns: { name: { old: "a", new: "staged-a" } },
    });
    const { hook, spies } = makeHarness({ stagedChanges: [change] });

    await act(async () => {
      hook.result.current.api.reconcileStagedChanges([]);
    });

    // Row 1's name was found by its rowKey (id=1) and restored to "a".
    expect(hook.result.current.data?.rows[0][1]).toBe("a");
    expect(spies.patchLoadedTableCell).toHaveBeenCalledWith(0, 1, "a");
    expect(hook.result.current.stagedRows.size).toBe(0);
  });

  it("applies new values when a change re-enters the queue (redo)", async () => {
    const change = makeChange({
      rowIndex: 1,
      rowKey: { id: 2 },
      columns: { name: { old: "b", new: "staged-b" } },
    });
    // Grid holds the pre-edit value; reconcile replays the new one.
    const { hook, spies } = makeHarness({ stagedChanges: [] });
    act(() => {
      hook.result.current.api.reconcileStagedChanges([change]);
    });

    expect(hook.result.current.data?.rows[1][1]).toBe("staged-b");
    expect(spies.patchLoadedTableCell).toHaveBeenCalledWith(1, 1, "staged-b");
    expect(hook.result.current.stagedRows).toEqual(new Set([1]));
  });
});
