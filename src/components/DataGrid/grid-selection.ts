export interface GridCellAddress {
  row: number;
  col: number;
}

export interface GridRange {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}

export interface GridBounds {
  rowCount: number;
  columnCount: number;
}

export type GridSelectionMode = "none" | "cells" | "rows" | "columns" | "all";

export interface GridSelectionState {
  mode: GridSelectionMode;
  activeCell: GridCellAddress | null;
  anchorCell: GridCellAddress | null;
  ranges: GridRange[];
  rows: Set<number>;
  columns: Set<number>;
}

export interface GridSelectionModifiers {
  extend?: boolean;
  additive?: boolean;
}

export function createEmptyGridSelection(): GridSelectionState {
  return {
    mode: "none",
    activeCell: null,
    anchorCell: null,
    ranges: [],
    rows: new Set(),
    columns: new Set(),
  };
}

function clamp(value: number, maximumExclusive: number): number {
  return Math.max(0, Math.min(value, Math.max(0, maximumExclusive - 1)));
}

function clampCell(cell: GridCellAddress, bounds: GridBounds): GridCellAddress | null {
  if (bounds.rowCount <= 0 || bounds.columnCount <= 0) return null;
  return {
    row: clamp(cell.row, bounds.rowCount),
    col: clamp(cell.col, bounds.columnCount),
  };
}

export function rangeBetween(left: GridCellAddress, right: GridCellAddress): GridRange {
  return {
    startRow: Math.min(left.row, right.row),
    endRow: Math.max(left.row, right.row),
    startCol: Math.min(left.col, right.col),
    endCol: Math.max(left.col, right.col),
  };
}

function isSingleCellRange(range: GridRange, cell: GridCellAddress): boolean {
  return range.startRow === cell.row
    && range.endRow === cell.row
    && range.startCol === cell.col
    && range.endCol === cell.col;
}

export function selectGridCell(
  state: GridSelectionState,
  requestedCell: GridCellAddress,
  bounds: GridBounds,
  modifiers: GridSelectionModifiers = {},
): GridSelectionState {
  const cell = clampCell(requestedCell, bounds);
  if (!cell) return createEmptyGridSelection();

  if (modifiers.extend) {
    const anchor = state.anchorCell ?? state.activeCell ?? cell;
    return {
      mode: "cells",
      activeCell: cell,
      anchorCell: anchor,
      ranges: [rangeBetween(anchor, cell)],
      rows: new Set(),
      columns: new Set(),
    };
  }

  if (modifiers.additive) {
    const existingIndex = state.mode === "cells"
      ? state.ranges.findIndex((range) => isSingleCellRange(range, cell))
      : -1;
    const ranges = state.mode === "cells" ? [...state.ranges] : [];
    if (existingIndex >= 0) ranges.splice(existingIndex, 1);
    else ranges.push(rangeBetween(cell, cell));

    return ranges.length === 0
      ? createEmptyGridSelection()
      : {
          mode: "cells",
          activeCell: cell,
          anchorCell: cell,
          ranges,
          rows: new Set(),
          columns: new Set(),
        };
  }

  return {
    mode: "cells",
    activeCell: cell,
    anchorCell: cell,
    ranges: [rangeBetween(cell, cell)],
    rows: new Set(),
    columns: new Set(),
  };
}

export function moveGridSelection(
  state: GridSelectionState,
  delta: GridCellAddress,
  bounds: GridBounds,
  extend = false,
): GridSelectionState {
  const origin = state.activeCell ?? { row: 0, col: 0 };
  return selectGridCell(
    state,
    { row: origin.row + delta.row, col: origin.col + delta.col },
    bounds,
    { extend },
  );
}

export function selectGridRow(
  state: GridSelectionState,
  row: number,
  rowCount: number,
  modifiers: GridSelectionModifiers = {},
): GridSelectionState {
  if (rowCount <= 0) return createEmptyGridSelection();
  const target = clamp(row, rowCount);
  const rows = modifiers.additive && state.mode === "rows" ? new Set(state.rows) : new Set<number>();

  if (modifiers.extend && state.mode === "rows" && state.rows.size > 0) {
    const anchor = Math.min(...state.rows);
    rows.clear();
    for (let index = Math.min(anchor, target); index <= Math.max(anchor, target); index += 1) {
      rows.add(index);
    }
  } else if (modifiers.additive && rows.has(target)) {
    rows.delete(target);
  } else {
    rows.add(target);
  }

  return rows.size === 0 ? createEmptyGridSelection() : {
    mode: "rows",
    activeCell: null,
    anchorCell: null,
    ranges: [],
    rows,
    columns: new Set(),
  };
}

export function selectGridColumn(
  state: GridSelectionState,
  column: number,
  columnCount: number,
  modifiers: GridSelectionModifiers = {},
): GridSelectionState {
  if (columnCount <= 0) return createEmptyGridSelection();
  const target = clamp(column, columnCount);
  const columns = modifiers.additive && state.mode === "columns"
    ? new Set(state.columns)
    : new Set<number>();

  if (modifiers.extend && state.mode === "columns" && state.columns.size > 0) {
    const anchor = Math.min(...state.columns);
    columns.clear();
    for (let index = Math.min(anchor, target); index <= Math.max(anchor, target); index += 1) {
      columns.add(index);
    }
  } else if (modifiers.additive && columns.has(target)) {
    columns.delete(target);
  } else {
    columns.add(target);
  }

  return columns.size === 0 ? createEmptyGridSelection() : {
    mode: "columns",
    activeCell: null,
    anchorCell: null,
    ranges: [],
    rows: new Set(),
    columns,
  };
}

export function selectEntireGrid(bounds: GridBounds): GridSelectionState {
  if (bounds.rowCount <= 0 || bounds.columnCount <= 0) return createEmptyGridSelection();
  return {
    mode: "all",
    activeCell: { row: 0, col: 0 },
    anchorCell: { row: 0, col: 0 },
    ranges: [{
      startRow: 0,
      endRow: bounds.rowCount - 1,
      startCol: 0,
      endCol: bounds.columnCount - 1,
    }],
    rows: new Set(),
    columns: new Set(),
  };
}

export function isGridCellSelected(
  state: GridSelectionState,
  cell: GridCellAddress,
): boolean {
  if (state.mode === "all") return true;
  if (state.mode === "rows") return state.rows.has(cell.row);
  if (state.mode === "columns") return state.columns.has(cell.col);
  if (state.mode !== "cells") return false;
  return state.ranges.some((range) => (
    cell.row >= range.startRow
    && cell.row <= range.endRow
    && cell.col >= range.startCol
    && cell.col <= range.endCol
  ));
}
