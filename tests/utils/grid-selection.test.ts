import { describe, expect, it } from "vitest";
import {
  createEmptyGridSelection,
  isGridCellSelected,
  moveGridSelection,
  selectEntireGrid,
  selectGridCell,
  selectGridColumn,
  selectGridRow,
} from "@/components/DataGrid/grid-selection";

const bounds = { rowCount: 100, columnCount: 20 };

describe("grid selection model", () => {
  it("creates a canonical active cell and anchor", () => {
    const selection = selectGridCell(createEmptyGridSelection(), { row: 4, col: 3 }, bounds);

    expect(selection.mode).toBe("cells");
    expect(selection.activeCell).toEqual({ row: 4, col: 3 });
    expect(selection.anchorCell).toEqual({ row: 4, col: 3 });
    expect(isGridCellSelected(selection, { row: 4, col: 3 })).toBe(true);
  });

  it("extends a rectangular range from the stable anchor", () => {
    const initial = selectGridCell(createEmptyGridSelection(), { row: 5, col: 5 }, bounds);
    const extended = selectGridCell(initial, { row: 2, col: 8 }, bounds, { extend: true });

    expect(extended.anchorCell).toEqual({ row: 5, col: 5 });
    expect(extended.ranges).toEqual([{ startRow: 2, endRow: 5, startCol: 5, endCol: 8 }]);
    expect(isGridCellSelected(extended, { row: 3, col: 7 })).toBe(true);
    expect(isGridCellSelected(extended, { row: 6, col: 7 })).toBe(false);
  });

  it("supports additive individual cells", () => {
    const first = selectGridCell(createEmptyGridSelection(), { row: 1, col: 1 }, bounds);
    const second = selectGridCell(first, { row: 9, col: 4 }, bounds, { additive: true });

    expect(second.ranges).toHaveLength(2);
    expect(isGridCellSelected(second, { row: 1, col: 1 })).toBe(true);
    expect(isGridCellSelected(second, { row: 9, col: 4 })).toBe(true);
  });

  it("moves and extends by keyboard without leaving the bounds", () => {
    const initial = selectGridCell(createEmptyGridSelection(), { row: 0, col: 0 }, bounds);
    const clamped = moveGridSelection(initial, { row: -1, col: -1 }, bounds);
    const extended = moveGridSelection(clamped, { row: 3, col: 2 }, bounds, true);

    expect(clamped.activeCell).toEqual({ row: 0, col: 0 });
    expect(extended.ranges).toEqual([{ startRow: 0, endRow: 3, startCol: 0, endCol: 2 }]);
  });

  it("models row, column, and select-all modes", () => {
    const rows = selectGridRow(createEmptyGridSelection(), 3, bounds.rowCount);
    const columns = selectGridColumn(rows, 7, bounds.columnCount);
    const all = selectEntireGrid(bounds);

    expect(isGridCellSelected(rows, { row: 3, col: 19 })).toBe(true);
    expect(isGridCellSelected(columns, { row: 99, col: 7 })).toBe(true);
    expect(isGridCellSelected(all, { row: 99, col: 19 })).toBe(true);
  });
});
