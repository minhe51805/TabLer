import { describe, expect, it } from "vitest";
import {
  buildRangeTsv,
  getPrimaryGridRange,
  isMultiCellRange,
  parseRangePasteMatrix,
  planClearUpdates,
  planFillDownUpdates,
  planPasteUpdates,
  type RangeUpdateContext,
} from "@/components/DataGrid/grid-range-operations";
import {
  createEmptyGridSelection,
  selectEntireGrid,
  selectGridColumn,
  selectGridCell,
  selectGridRow,
} from "@/components/DataGrid/grid-selection";

const bounds = { rowCount: 10, columnCount: 8 };

function createContext(overrides: Partial<RangeUpdateContext> = {}): RangeUpdateContext {
  const rows: (string | number | boolean | null)[][] = [
    [1, "alice", true, null],
    [2, "bob", false, null],
    [3, "carol", null, null],
    [4, "dave", true, null],
  ];
  const columns = [
    { name: "id", is_primary_key: true },
    { name: "username" },
    { name: "active" },
    { name: "nickname" },
  ];
  return {
    rows,
    columns,
    parseValue: (raw) => raw,
    valuesEqual: (left, right) =>
      left === right || (left !== null && right !== null && String(left) === String(right)),
    rowIsTargetable: () => true,
    ...overrides,
  };
}

describe("getPrimaryGridRange", () => {
  it("normalizes every selection mode into one bounding rectangle", () => {
    const single = selectGridCell(createEmptyGridSelection(), { row: 4, col: 3 }, bounds);
    expect(getPrimaryGridRange(single, bounds)).toEqual({
      startRow: 4, endRow: 4, startCol: 3, endCol: 3,
    });

    const extended = selectGridCell(single, { row: 2, col: 8 }, bounds, { extend: true });
    expect(getPrimaryGridRange(extended, bounds)).toEqual({
      startRow: 2, endRow: 4, startCol: 3, endCol: 7,
    });

    const additive = selectGridCell(single, { row: 9, col: 4 }, bounds, { additive: true });
    expect(getPrimaryGridRange(additive, bounds)).toEqual({
      startRow: 4, endRow: 9, startCol: 3, endCol: 4,
    });

    const rows = selectGridRow(createEmptyGridSelection(), 2, bounds.rowCount);
    expect(getPrimaryGridRange(rows, bounds)).toEqual({
      startRow: 2, endRow: 2, startCol: 0, endCol: 7,
    });

    const columns = selectGridColumn(createEmptyGridSelection(), 6, bounds.columnCount);
    expect(getPrimaryGridRange(columns, bounds)).toEqual({
      startRow: 0, endRow: 9, startCol: 6, endCol: 6,
    });

    expect(getPrimaryGridRange(selectEntireGrid(bounds), bounds)).toEqual({
      startRow: 0, endRow: 9, startCol: 0, endCol: 7,
    });

    expect(getPrimaryGridRange(createEmptyGridSelection(), bounds)).toBeNull();
    expect(getPrimaryGridRange(selectEntireGrid(bounds), { rowCount: 0, columnCount: 0 })).toBeNull();
  });

  it("reports multi-cell ranges only when the rectangle spans more than one cell", () => {
    const single = selectGridCell(createEmptyGridSelection(), { row: 1, col: 1 }, bounds);
    expect(isMultiCellRange(getPrimaryGridRange(single, bounds))).toBe(false);
    const extended = selectGridCell(single, { row: 3, col: 2 }, bounds, { extend: true });
    expect(isMultiCellRange(getPrimaryGridRange(extended, bounds))).toBe(true);
  });
});

describe("buildRangeTsv", () => {
  it("serializes nulls as empty fields and keeps numbers/booleans readable", () => {
    const tsv = buildRangeTsv(
      [[1, "alice", true, null], [2, "bob", false, "b"]],
      { startRow: 0, endRow: 1, startCol: 0, endCol: 3 },
    );
    expect(tsv).toBe("1\talice\ttrue\t\n2\tbob\tfalse\tb");
  });

  it("quotes fields containing tabs, newlines, or quotes", () => {
    const tsv = buildRangeTsv(
      [["a\tb", "line1\nline2", 'say "hi"', "plain"]],
      { startRow: 0, endRow: 0, startCol: 0, endCol: 3 },
    );
    expect(tsv).toBe('"a\tb"\t"line1\nline2"\t"say ""hi"""\tplain');
  });

  it("treats cells beyond a short row as null", () => {
    const tsv = buildRangeTsv([["only"]], { startRow: 0, endRow: 0, startCol: 0, endCol: 2 });
    expect(tsv).toBe("only\t\t");
  });
});

describe("parseRangePasteMatrix", () => {
  it("splits TSV text and keeps fully empty rows", () => {
    const matrix = parseRangePasteMatrix("a\tb\n\t\nc\td");
    expect(matrix).toEqual([["a", "b"], ["", ""], ["c", "d"]]);
  });

  it("understands quoted CSV fields with commas, escaped quotes, and line breaks", () => {
    const matrix = parseRangePasteMatrix('"x,1","say ""hi""","two\nlines"\r\nplain,2');
    expect(matrix).toEqual([["x,1", 'say "hi"', "two\nlines"], ["plain", "2"]]);
  });

  it("rejects empty input", () => {
    expect(parseRangePasteMatrix("")).toBeNull();
    expect(parseRangePasteMatrix("   ")).toBeNull();
  });
});

describe("planPasteUpdates", () => {
  it("plans an update per changed cell anchored at the active cell", () => {
    const context = createContext();
    const plan = planPasteUpdates(
      { anchor: { row: 1, col: 1 }, matrix: [["bob2", "x"], ["carol2", "y"]] },
      context,
    );
    expect(plan.updates).toEqual([
      { rowIndex: 1, colIndex: 1, columnName: "username", oldValue: "bob", nextValue: "bob2" },
      { rowIndex: 1, colIndex: 2, columnName: "active", oldValue: false, nextValue: "x" },
      { rowIndex: 2, colIndex: 1, columnName: "username", oldValue: "carol", nextValue: "carol2" },
      { rowIndex: 2, colIndex: 2, columnName: "active", oldValue: null, nextValue: "y" },
    ]);
    expect(plan.skippedCells).toBe(0);
  });

  it("stages NULL for empty pasted cells and skips no-op / protected cells", () => {
    const context = createContext();
    const plan = planPasteUpdates(
      { anchor: { row: 0, col: 1 }, matrix: [["alice", "keep"]] },
      context,
    );
    // "alice" over "alice" is a no-op; "keep" over boolean column true —
    // passthrough parse makes it "keep", a real change on column "active";
    // column 0 (id, PK) is outside this matrix.
    expect(plan.updates).toEqual([
      { rowIndex: 0, colIndex: 2, columnName: "active", oldValue: true, nextValue: "keep" },
    ]);
    expect(plan.skippedCells).toBe(1);
  });

  it("never targets primary-key columns or identity-less rows", () => {
    const context = createContext({
      rowIsTargetable: (rowIndex) => rowIndex !== 1,
    });
    const plan = planPasteUpdates(
      { anchor: { row: 0, col: 0 }, matrix: [["9", "alice2"], ["8", "bob2"]] },
      context,
    );
    // Column 0 is the PK (skipped for row 0); row 1 is identity-less, so both
    // of its cells are skipped by the targetability gate.
    expect(plan.updates).toEqual([
      { rowIndex: 0, colIndex: 1, columnName: "username", oldValue: "alice", nextValue: "alice2" },
    ]);
    expect(plan.skippedCells).toBe(3);
  });

  it("refuses the whole paste when it would extend past the loaded page", () => {
    const context = createContext();
    const plan = planPasteUpdates(
      { anchor: { row: 3, col: 3 }, matrix: [["a", "b"], ["c", "d"]] },
      context,
    );
    expect(plan.updates).toEqual([]);
    expect(plan.refused).toEqual({ requestedRows: 2, requestedColumns: 2 });
  });

  it("propagates per-column parse errors so a batch stays all-or-nothing", () => {
    const context = createContext({
      parseValue: () => {
        throw new Error("Numeric columns only accept valid numbers.");
      },
    });
    expect(() =>
      planPasteUpdates({ anchor: { row: 0, col: 1 }, matrix: [["oops"]] }, context),
    ).toThrow("Numeric columns only accept valid numbers.");
  });
});

describe("planClearUpdates", () => {
  it("stages NULL for every non-null editable cell and skips the rest", () => {
    const context = createContext();
    const plan = planClearUpdates({ startRow: 0, endRow: 2, startCol: 1, endCol: 3 }, context);
    expect(plan.updates).toEqual([
      { rowIndex: 0, colIndex: 1, columnName: "username", oldValue: "alice", nextValue: null },
      { rowIndex: 0, colIndex: 2, columnName: "active", oldValue: true, nextValue: null },
      { rowIndex: 1, colIndex: 1, columnName: "username", oldValue: "bob", nextValue: null },
      { rowIndex: 1, colIndex: 2, columnName: "active", oldValue: false, nextValue: null },
      { rowIndex: 2, colIndex: 1, columnName: "username", oldValue: "carol", nextValue: null },
    ]);
    expect(plan.skippedCells).toBe(4);
  });
});

describe("planFillDownUpdates", () => {
  it("copies each column's top-row value downward and never touches the source row", () => {
    const context = createContext();
    const plan = planFillDownUpdates({ startRow: 0, endRow: 3, startCol: 1, endCol: 2 }, context);
    expect(plan.updates).toEqual([
      { rowIndex: 1, colIndex: 1, columnName: "username", oldValue: "bob", nextValue: "alice" },
      { rowIndex: 1, colIndex: 2, columnName: "active", oldValue: false, nextValue: true },
      { rowIndex: 2, colIndex: 1, columnName: "username", oldValue: "carol", nextValue: "alice" },
      { rowIndex: 2, colIndex: 2, columnName: "active", oldValue: null, nextValue: true },
      { rowIndex: 3, colIndex: 1, columnName: "username", oldValue: "dave", nextValue: "alice" },
    ]);
    expect(plan.skippedCells).toBe(3);
  });
});

