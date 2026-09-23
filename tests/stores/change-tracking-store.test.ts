import { beforeEach, describe, expect, it } from "vitest";
import { changeScopeKey, useChangeTrackingStore } from "@/stores/change-tracking-store";

const CONN_A = "conn-a";
const CONN_B = "conn-b";
const SCOPE_A = changeScopeKey(CONN_A, "app", "users");
const SCOPE_B = changeScopeKey(CONN_B, "app", "users");

const firstChange = {
  type: "update" as const,
  connectionId: CONN_A,
  tableName: "users",
  database: "app",
  rowIndex: 0,
  rowKey: { id: 7 },
  columns: { 1: { old: "before", new: "after" } },
  originalRow: [7, "before"],
};

describe("change tracking history", () => {
  beforeEach(() => {
    useChangeTrackingStore.setState({
      stagedChanges: [],
      history: {},
      future: {},
      _columnNameMap: {},
      _dbTypeMap: {},
    });
    useChangeTrackingStore.getState().setColumnNameMap(SCOPE_A, { 0: "id", 1: "name" });
    useChangeTrackingStore.getState().setColumnNameMap(SCOPE_B, { 0: "id", 1: "title" });
  });

  it("undoes and redoes staged edits", () => {
    useChangeTrackingStore.getState().stageChange(firstChange);
    expect(useChangeTrackingStore.getState().stagedChanges).toHaveLength(1);

    const undone = useChangeTrackingStore.getState().undoLast(SCOPE_A);
    expect(undone).toEqual([]);
    expect(useChangeTrackingStore.getState().stagedChanges).toEqual([]);

    const redone = useChangeTrackingStore.getState().redoLast(SCOPE_A);
    expect(redone).toHaveLength(1);
    expect(redone?.[0].columns.name).toEqual({ old: "before", new: "after" });
  });

  it("clears redo history after a new command", () => {
    useChangeTrackingStore.getState().stageChange(firstChange);
    useChangeTrackingStore.getState().undoLast(SCOPE_A);
    useChangeTrackingStore.getState().stageChange({
      ...firstChange,
      rowKey: { id: 8 },
      rowIndex: 1,
    });

    expect(useChangeTrackingStore.getState().redoLast(SCOPE_A)).toBeNull();
  });

  it("treats a multi-cell batch as one undo unit", () => {
    useChangeTrackingStore
      .getState()
      .stageChanges([firstChange, { ...firstChange, rowIndex: 1, rowKey: { id: 8 } }]);

    expect(useChangeTrackingStore.getState().stagedChanges).toHaveLength(2);
    expect(useChangeTrackingStore.getState().getUndoCount(SCOPE_A)).toBe(1);
    expect(useChangeTrackingStore.getState().undoLast(SCOPE_A)).toEqual([]);
  });

  it("unstages a batch of ids as one undo step", () => {
    useChangeTrackingStore
      .getState()
      .stageChanges([firstChange, { ...firstChange, rowIndex: 1, rowKey: { id: 8 } }]);
    const ids = useChangeTrackingStore.getState().stagedChanges.map((c) => c.id);
    useChangeTrackingStore.getState().unstageChanges(ids);

    expect(useChangeTrackingStore.getState().stagedChanges).toEqual([]);
    expect(useChangeTrackingStore.getState().getUndoCount(SCOPE_A)).toBe(2);
    expect(useChangeTrackingStore.getState().undoLast(SCOPE_A)).toHaveLength(2);
  });

  it("scopes undo history per connection so table A cannot revert table B", () => {
    useChangeTrackingStore.getState().stageChange(firstChange);
    useChangeTrackingStore.getState().stageChange({
      ...firstChange,
      connectionId: CONN_B,
      rowKey: { id: 9 },
    });

    // Undo in conn A must leave conn B's staged change untouched.
    const undone = useChangeTrackingStore.getState().undoLast(SCOPE_A);
    expect(undone).toEqual([]);
    const remaining = useChangeTrackingStore.getState().stagedChanges;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].connectionId).toBe(CONN_B);
    // The conn-B change resolved through conn B's column map (title, not name).
    expect(remaining[0].columns.title).toEqual({ old: "before", new: "after" });
  });

  it("counts changes per scope, not per bare table name", () => {
    useChangeTrackingStore.getState().stageChange(firstChange);
    useChangeTrackingStore.getState().stageChange({
      ...firstChange,
      connectionId: CONN_B,
      rowKey: { id: 9 },
    });

    expect(useChangeTrackingStore.getState().getChangeCount(SCOPE_A)).toBe(1);
    expect(useChangeTrackingStore.getState().getChangeCount(SCOPE_B)).toBe(1);
  });

  it("fails loudly when a column index cannot be resolved", () => {
    expect(() =>
      useChangeTrackingStore.getState().stageChange({
        ...firstChange,
        columns: { 42: { old: "a", new: "b" } },
      }),
    ).toThrow(/column #42/);
  });
});
