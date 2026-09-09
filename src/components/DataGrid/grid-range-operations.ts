/**
 * Range operation planners for the DataGrid.
 *
 * Pure functions that turn a grid selection plus external input (a pasted
 * matrix, a fill-down source, or a clear request) into the exact set of
 * staged cell updates an operation would produce. Keeping the planning pure
 * lets undo/redo, the review modal, and the test suite pin exactly which
 * rows an operation targets — the WF-05 success measure.
 *
 * Value coercion deliberately reuses the single-cell editor pipeline
 * (parseEditorValue / areCellValuesEqual passed in by the caller) so a
 * paste/fill/clear can never stage anything the inline editor would reject.
 */

import type { GridBounds, GridCellAddress, GridRange, GridSelectionState } from "./grid-selection";

export type RangeCellValue = string | number | boolean | null;

export interface RangeColumnLike {
  name: string;
  is_primary_key?: boolean;
}

export interface RangeCellUpdate {
  rowIndex: number;
  colIndex: number;
  columnName: string;
  oldValue: RangeCellValue;
  nextValue: RangeCellValue;
}

export interface RangeUpdatePlan {
  updates: RangeCellUpdate[];
  /** Cells inside the target range left untouched (protected or no-op). */
  skippedCells: number;
}

export interface RangeUpdateContext {
  rows: readonly (readonly RangeCellValue[])[];
  columns: readonly RangeColumnLike[];
  parseValue: (raw: string, column: RangeColumnLike) => RangeCellValue;
  valuesEqual: (left: RangeCellValue, right: RangeCellValue) => boolean;
  /** Rows without a stable primary-key identity cannot be targeted by staged updates. */
  rowIsTargetable: (rowIndex: number) => boolean;
}

/** Normalized bounding rectangle of the active selection, or null when empty. */
export function getPrimaryGridRange(
  selection: GridSelectionState,
  bounds: GridBounds,
): GridRange | null {
  const lastRow = bounds.rowCount - 1;
  const lastCol = bounds.columnCount - 1;
  if (lastRow < 0 || lastCol < 0) return null;

  const clamp = (range: GridRange): GridRange | null => {
    const startRow = Math.max(0, Math.min(range.startRow, lastRow));
    const endRow = Math.max(0, Math.min(range.endRow, lastRow));
    const startCol = Math.max(0, Math.min(range.startCol, lastCol));
    const endCol = Math.max(0, Math.min(range.endCol, lastCol));
    if (startRow > endRow || startCol > endCol) return null;
    return { startRow, endRow, startCol, endCol };
  };

  if (selection.mode === "all") {
    return { startRow: 0, endRow: lastRow, startCol: 0, endCol: lastCol };
  }
  if (selection.mode === "cells") {
    if (selection.ranges.length === 0) return null;
    let startRow = Number.POSITIVE_INFINITY;
    let endRow = Number.NEGATIVE_INFINITY;
    let startCol = Number.POSITIVE_INFINITY;
    let endCol = Number.NEGATIVE_INFINITY;
    for (const range of selection.ranges) {
      startRow = Math.min(startRow, range.startRow);
      endRow = Math.max(endRow, range.endRow);
      startCol = Math.min(startCol, range.startCol);
      endCol = Math.max(endCol, range.endCol);
    }
    return clamp({ startRow, endRow, startCol, endCol });
  }
  if (selection.mode === "rows") {
    if (selection.rows.size === 0) return null;
    const rowIndices = [...selection.rows];
    return clamp({
      startRow: Math.min(...rowIndices),
      endRow: Math.max(...rowIndices),
      startCol: 0,
      endCol: lastCol,
    });
  }
  if (selection.mode === "columns") {
    if (selection.columns.size === 0) return null;
    const columnIndices = [...selection.columns];
    return clamp({
      startRow: 0,
      endRow: lastRow,
      startCol: Math.min(...columnIndices),
      endCol: Math.max(...columnIndices),
    });
  }
  return null;
}

export function isMultiCellRange(range: GridRange | null): boolean {
  return range !== null && (range.endRow > range.startRow || range.endCol > range.startCol);
}

function formatTsvValue(value: RangeCellValue | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function quoteTsvField(raw: string): string {
  if (/[\t\n\r"]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
  return raw;
}

/**
 * Serialize the selected rectangle as TSV (the flavor spreadsheets paste
 * natively). Data only — no header row. NULL cells become empty fields so a
 * round-trip through a spreadsheet preserves the shape.
 */
export function buildRangeTsv(
  rows: readonly (readonly RangeCellValue[])[],
  range: GridRange,
): string {
  const lines: string[] = [];
  for (let rowIndex = range.startRow; rowIndex <= range.endRow; rowIndex += 1) {
    const row = rows[rowIndex];
    const fields: string[] = [];
    for (let colIndex = range.startCol; colIndex <= range.endCol; colIndex += 1) {
      fields.push(quoteTsvField(formatTsvValue(row?.[colIndex])));
    }
    lines.push(fields.join("\t"));
  }
  return lines.join("\n");
}

/**
 * Parse pasted clipboard text into a raw string matrix. Unlike the
 * insert-oriented clipboard parser this keeps fully empty rows: pasting an
 * empty row over a range is a legitimate way to stage NULLs. Handles quoted
 * CSV fields containing delimiters, escaped quotes, or line breaks.
 */
export function parseRangePasteMatrix(text: string): string[][] | null {
  if (!text || !text.trim()) return null;
  const tabCount = (text.match(/\t/g) ?? []).length;
  const commaCount = (text.match(/,/g) ?? []).length;
  const delimiter: "\t" | "," = tabCount > 0 && tabCount >= commaCount ? "\t" : ",";

  const matrix: string[][] = [];
  let row: string[] = [];
  let value = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (inQuotes && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === delimiter && !inQuotes) {
      row.push(value);
      value = "";
      continue;
    }
    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(value);
      matrix.push(row);
      row = [];
      value = "";
      continue;
    }
    value += char;
  }

  row.push(value);
  matrix.push(row);
  return matrix;
}

/**
 * Shared walker: visits every cell of `range`, asks `resolveNext` for the
 * staged value, and skips protected or no-op cells.
 *
 * resolveNext contract: return the next value (including `null` — staging a
 * NULL is legitimate) or `undefined` to leave the cell untouched.
 * Throws from parseValue propagate to the caller so a batch can be
 * all-or-nothing: nothing is staged when any target cell is invalid.
 */
function planRangeValues(
  range: GridRange,
  context: RangeUpdateContext,
  resolveNext: (
    rowIndex: number,
    colIndex: number,
    column: RangeColumnLike,
    oldValue: RangeCellValue,
  ) => RangeCellValue | undefined,
): RangeUpdatePlan {
  const updates: RangeCellUpdate[] = [];
  let skippedCells = 0;

  for (let rowIndex = range.startRow; rowIndex <= range.endRow; rowIndex += 1) {
    const row = context.rows[rowIndex];
    if (!row || !context.rowIsTargetable(rowIndex)) {
      skippedCells += range.endCol - range.startCol + 1;
      continue;
    }
    for (let colIndex = range.startCol; colIndex <= range.endCol; colIndex += 1) {
      const column = context.columns[colIndex];
      if (!column || column.is_primary_key) {
        skippedCells += 1;
        continue;
      }
      const oldValue = (row[colIndex] ?? null) as RangeCellValue;
      const nextValue = resolveNext(rowIndex, colIndex, column, oldValue);
      if (nextValue === undefined || context.valuesEqual(oldValue, nextValue)) {
        skippedCells += 1;
        continue;
      }
      updates.push({ rowIndex, colIndex, columnName: column.name, oldValue, nextValue });
    }
  }

  return { updates, skippedCells };
}

export interface PastePlanRefusal {
  requestedRows: number;
  requestedColumns: number;
}

export interface PastePlan extends RangeUpdatePlan {
  /** Set when the paste cannot be applied to the loaded page at all (all-or-nothing). */
  refused?: PastePlanRefusal;
}

/**
 * Plan a paste of `matrix` anchored at `anchor` (the active cell).
 * Overflow past the loaded rows/columns refuses the WHOLE paste — silently
 * clipping would paste less than the user asked for.
 */
export function planPasteUpdates(
  request: { anchor: GridCellAddress; matrix: string[][] },
  context: RangeUpdateContext,
): PastePlan {
  const { anchor, matrix } = request;
  if (matrix.length === 0) return { updates: [], skippedCells: 0 };
  const requestedColumns = Math.max(...matrix.map((row) => row.length));
  const lastRow = anchor.row + matrix.length - 1;
  const lastCol = anchor.col + requestedColumns - 1;
  if (lastRow > context.rows.length - 1 || lastCol > context.columns.length - 1) {
    return { updates: [], skippedCells: 0, refused: { requestedRows: matrix.length, requestedColumns } };
  }

  return planRangeValues(
    { startRow: anchor.row, endRow: lastRow, startCol: anchor.col, endCol: lastCol },
    context,
    (rowIndex, colIndex, column) => {
      const raw = matrix[rowIndex - anchor.row]?.[colIndex - anchor.col] ?? "";
      // Empty pasted cells stage NULL (spreadsheet convention, mirroring the
      // insert-oriented clipboard parser); literal "NULL" also parses to null.
      if (raw.trim() === "") return null;
      return context.parseValue(raw, column);
    },
  );
}

/** Plan staging NULL for every editable cell of the range. */
export function planClearUpdates(
  range: GridRange,
  context: RangeUpdateContext,
): RangeUpdatePlan {
  return planRangeValues(range, context, () => null);
}

/**
 * Plan a fill-down: every column copies its TOP-row value into the rows
 * below inside the range. The source row itself is never modified.
 */
export function planFillDownUpdates(
  range: GridRange,
  context: RangeUpdateContext,
): RangeUpdatePlan {
  const sourceRow = context.rows[range.startRow];
  return planRangeValues(range, context, (rowIndex, colIndex) => {
    if (rowIndex === range.startRow) return undefined;
    return (sourceRow?.[colIndex] ?? null) as RangeCellValue;
  });
}
