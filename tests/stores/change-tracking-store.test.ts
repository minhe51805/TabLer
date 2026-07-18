import { beforeEach, describe, expect, it } from "vitest";
import { useChangeTrackingStore } from "@/stores/change-tracking-store";

const firstChange = {
  type: "update" as const,
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
      history: [],
      future: [],
      _columnNameMap: {},
      _dbTypeMap: {},
    });
    useChangeTrackingStore.getState().setColumnNameMap("users", { 0: "id", 1: "name" });
  });

  it("undoes and redoes staged edits", () => {
    useChangeTrackingStore.getState().stageChange(firstChange);
    expect(useChangeTrackingStore.getState().stagedChanges).toHaveLength(1);

    const undone = useChangeTrackingStore.getState().undoLast();
    expect(undone).toEqual([]);
    expect(useChangeTrackingStore.getState().stagedChanges).toEqual([]);

    const redone = useChangeTrackingStore.getState().redoLast();
    expect(redone).toHaveLength(1);
    expect(redone?.[0].columns.name).toEqual({ old: "before", new: "after" });
  });

  it("clears redo history after a new command", () => {
    useChangeTrackingStore.getState().stageChange(firstChange);
    useChangeTrackingStore.getState().undoLast();
    useChangeTrackingStore.getState().stageChange({
      ...firstChange,
      rowKey: { id: 8 },
      rowIndex: 1,
    });

    expect(useChangeTrackingStore.getState().redoLast()).toBeNull();
  });

  it("treats a multi-cell batch as one undo unit", () => {
    useChangeTrackingStore.getState().stageChanges([
      firstChange,
      { ...firstChange, rowIndex: 1, rowKey: { id: 8 } },
    ]);

    expect(useChangeTrackingStore.getState().stagedChanges).toHaveLength(2);
    expect(useChangeTrackingStore.getState().history).toHaveLength(1);
    expect(useChangeTrackingStore.getState().undoLast()).toEqual([]);
  });
});
