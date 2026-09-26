import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDataGridRangeOperations } from "@/components/DataGrid/hooks/useDataGridRangeOperations";
import type { GridSelectionState } from "@/components/DataGrid/grid-selection";
import type { GridCellValue, ResolvedColumn } from "@/components/DataGrid/hooks/useDataGrid";
import type { StagedChangeInput } from "@/stores/change-tracking-store";
import type { QueryResult } from "@/types";

const COLUMNS: ResolvedColumn[] = [
  { name: "id", data_type: "INT", is_nullable: false, is_primary_key: true },
  { name: "name", data_type: "TEXT", is_nullable: true, is_primary_key: false },
  { name: "age", data_type: "INT", is_nullable: true, is_primary_key: false },
  { name: "secret", data_type: "TEXT", is_nullable: true, is_primary_key: false },
];

const PK_COLUMNS = COLUMNS.filter((c) => c.is_primary_key);

/** Source rows — row 1 is "filtered out", row 3 has an incomplete PK. */
function makeData(): QueryResult {
  return {
    columns: COLUMNS,
    rows: [
      [1, "a", 10, "x"],
      [2, "b", 20, "y"],
      [3, "c", 30, "z"],
      [null, "nopk", 40, "w"],
    ],
    affected_rows: 0,
    execution_time_ms: 1,
    query: "SELECT fixture",
    sandboxed: false,
    truncated: false,
  } as QueryResult;
}

const DISPLAYED_INDICES = [0, 2, 3];

function cellSelection(range: {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}): GridSelectionState {
  return {
    mode: "cells",
    activeCell: { row: range.startRow, col: range.startCol },
    anchorCell: { row: range.startRow, col: range.startCol },
    ranges: [range],
    rows: new Set(),
    columns: new Set(),
  };
}

interface HarnessOptions {
  selection: GridSelectionState;
  enabled?: boolean;
  maskedColumnNames?: ReadonlySet<string>;
  maskRowsForCopy?: (rows: readonly (readonly GridCellValue[])[]) => Promise<GridCellValue[][]>;
}

function makeHarness(options: HarnessOptions) {
  const data = makeData();
  const displayedRows = DISPLAYED_INDICES.map((i) => data.rows[i]);
  const spies = {
    stageChanges: vi.fn(),
    patchLoadedTableCell: vi.fn(),
    setError: vi.fn(),
  };
  const hook = renderHook(() => {
    const [gridData, setData] = useState<QueryResult | null>(data);
    const [stagedRows, setStagedRows] = useState<Set<number>>(new Set());
    const api = useDataGridRangeOperations({
      gridSelection: options.selection,
      data: gridData,
      displayedRows,
      displayedRowIndices: DISPLAYED_INDICES,
      resolvedColumns: COLUMNS,
      primaryKeyColumns: PK_COLUMNS,
      tableName: "users",
      connectionId: "conn-1",
      database: "app",
      enabled: options.enabled ?? true,
      stageChanges: spies.stageChanges,
      setData,
      setStagedRowIndices: setStagedRows,
      patchLoadedTableCell: spies.patchLoadedTableCell,
      setError: spies.setError,
      maskedColumnNames: options.maskedColumnNames,
      maskRowsForCopy: options.maskRowsForCopy,
    });
    return { api, data: gridData, stagedRows };
  });
  return { hook, spies };
}

function stagedBatch(spies: { stageChanges: ReturnType<typeof vi.fn> }): StagedChangeInput[] {
  return spies.stageChanges.mock.calls[0][0] as StagedChangeInput[];
}

describe("handleRangeDelete (clear selection → stage NULLs)", () => {
  it("stages the whole rectangle as ONE stageChanges batch keyed by source rows", () => {
    const { hook, spies } = makeHarness({
      selection: cellSelection({ startRow: 0, endRow: 2, startCol: 1, endCol: 2 }),
    });
    let owned = false;
    act(() => {
      owned = hook.result.current.api.handleRangeDelete();
    });
    expect(owned).toBe(true);

    // One call = one undo unit, no matter how many cells.
    expect(spies.stageChanges).toHaveBeenCalledTimes(1);
    const changes = stagedBatch(spies);

    // Displayed rows 0,1,2 map to source rows 0,2,3 — but source row 3 has an
    // incomplete PK and is untargetable, so only 4 cell updates land.
    expect(changes.map((c) => c.rowIndex)).toEqual([0, 0, 2, 2]);
    expect(changes.map((c) => c.rowKey)).toEqual([{ id: 1 }, { id: 1 }, { id: 3 }, { id: 3 }]);
    expect(changes.every((c) => c.type === "update")).toBe(true);
    expect(changes[0].columns).toEqual({ 1: { old: "a", new: null } });
    expect(changes[1].columns).toEqual({ 2: { old: 10, new: null } });

    // Optimistic apply hit the SOURCE indices, not the displayed ones.
    const rows = hook.result.current.data!.rows;
    expect(rows[0]).toEqual([1, null, null, "x"]);
    expect(rows[1]).toEqual([2, "b", 20, "y"]); // filtered-out row untouched
    expect(rows[2]).toEqual([3, null, null, "z"]);
    expect(spies.patchLoadedTableCell).toHaveBeenCalledWith(2, 1, null);
    expect(hook.result.current.stagedRows).toEqual(new Set([0, 2]));
  });

  it("masked columns are treated as protected — their cells never enter the batch", () => {
    const { hook, spies } = makeHarness({
      maskedColumnNames: new Set(["secret"]),
      selection: cellSelection({ startRow: 0, endRow: 0, startCol: 2, endCol: 3 }),
    });
    act(() => {
      hook.result.current.api.handleRangeDelete();
    });
    const changes = stagedBatch(spies);
    // Only the age cell staged; the masked secret column was skipped.
    expect(changes).toHaveLength(1);
    expect(changes[0].columns).toEqual({ 2: { old: 10, new: null } });
  });
});

describe("handleRangeSetValue", () => {
  it("parses the raw value per column type and stages one batch", () => {
    const { hook, spies } = makeHarness({
      selection: cellSelection({ startRow: 0, endRow: 1, startCol: 1, endCol: 2 }),
    });
    let error: string | null = "unset";
    act(() => {
      error = hook.result.current.api.handleRangeSetValue("99");
    });
    expect(error).toBeNull();
    expect(spies.stageChanges).toHaveBeenCalledTimes(1);
    const changes = stagedBatch(spies);
    // name stays a string "99"; age parses to the number 99.
    const cellFor = (rowIndex: number, colIdx: number) =>
      changes.find((c) => c.rowIndex === rowIndex && Object.keys(c.columns)[0] === String(colIdx));
    expect(cellFor(0, 1)?.columns[1].new).toBe("99");
    expect(cellFor(0, 2)?.columns[2].new).toBe(99);
  });

  it("refuses the whole batch when the value can't parse for a column type", () => {
    const { hook, spies } = makeHarness({
      selection: cellSelection({ startRow: 0, endRow: 0, startCol: 1, endCol: 2 }),
    });
    let error: string | null = null;
    act(() => {
      error = hook.result.current.api.handleRangeSetValue("not-a-number");
    });
    expect(error).toBeTruthy(); // a message for the dialog to display
    expect(spies.stageChanges).not.toHaveBeenCalled();
    expect(hook.result.current.data!.rows[0]).toEqual([1, "a", 10, "x"]);
  });

  it("returns an error instead of staging when the only covered cells are protected", () => {
    const { hook, spies } = makeHarness({
      maskedColumnNames: new Set(["secret"]),
      selection: cellSelection({ startRow: 0, endRow: 1, startCol: 3, endCol: 3 }),
    });
    let error: string | null = null;
    act(() => {
      error = hook.result.current.api.handleRangeSetValue("x");
    });
    expect(error).toBeTruthy();
    expect(spies.stageChanges).not.toHaveBeenCalled();
  });
});

describe("handleRangeFillDown", () => {
  it("copies the top-row value into the rows below via source indices", () => {
    const { hook, spies } = makeHarness({
      selection: cellSelection({ startRow: 0, endRow: 1, startCol: 1, endCol: 1 }),
    });
    act(() => {
      hook.result.current.api.handleRangeFillDown();
    });
    const changes = stagedBatch(spies);
    // Only the second displayed row changes — the source row itself is untouched.
    expect(changes).toHaveLength(1);
    expect(changes[0].rowIndex).toBe(2);
    expect(changes[0].columns).toEqual({ 1: { old: "c", new: "a" } });
  });
});

describe("handleRangePaste", () => {
  const clipboard = { readText: vi.fn(), writeText: vi.fn(async () => {}) };

  beforeEach(() => {
    clipboard.readText.mockReset();
    clipboard.writeText.mockReset();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: clipboard,
    });
  });

  it("refuses a paste that overflows the loaded page — nothing is staged", async () => {
    clipboard.readText.mockResolvedValue("p\tq\nr\ts");
    const { hook, spies } = makeHarness({
      selection: cellSelection({ startRow: 2, endRow: 2, startCol: 1, endCol: 1 }),
    });
    let owned = false;
    await act(async () => {
      owned = hook.result.current.api.handleRangePaste();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(owned).toBe(true);
    await vi.waitFor(() => {
      expect(spies.setError).toHaveBeenCalledWith(expect.stringContaining("Paste refused"));
    });
    expect(spies.stageChanges).not.toHaveBeenCalled();
  });

  it("stages a fitting paste as one batch against source indices", async () => {
    clipboard.readText.mockResolvedValue("p1\t11\np2\t22");
    const { hook, spies } = makeHarness({
      selection: cellSelection({ startRow: 0, endRow: 0, startCol: 1, endCol: 1 }),
    });
    await act(async () => {
      hook.result.current.api.handleRangePaste();
    });
    await vi.waitFor(() => {
      expect(spies.stageChanges).toHaveBeenCalledTimes(1);
    });
    const changes = stagedBatch(spies);
    expect(changes.map((c) => c.rowIndex)).toEqual([0, 0, 2, 2]);
    expect(changes[0].columns).toEqual({ 1: { old: "a", new: "p1" } });
    expect(changes[1].columns).toEqual({ 2: { old: 10, new: 11 } });
    expect(changes[2].columns).toEqual({ 1: { old: "c", new: "p2" } });
    expect(changes[3].columns).toEqual({ 2: { old: 30, new: 22 } });
  });
});

describe("handleRangeCopy", () => {
  const clipboard = { readText: vi.fn(), writeText: vi.fn(async (_text: string) => {}) };

  beforeEach(() => {
    clipboard.readText.mockReset();
    clipboard.writeText.mockReset();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: clipboard,
    });
  });

  it("copies the masked matrix — raw masked values never reach the clipboard", async () => {
    const maskRowsForCopy = vi.fn(
      async (rows: readonly (readonly GridCellValue[])[]) =>
        rows.map((row) => [row[0], row[1], row[2], "***"]) as GridCellValue[][],
    );
    const { hook } = makeHarness({
      maskRowsForCopy,
      selection: cellSelection({ startRow: 0, endRow: 0, startCol: 1, endCol: 3 }),
    });
    let owned = false;
    await act(async () => {
      owned = hook.result.current.api.handleRangeCopy();
    });
    expect(owned).toBe(true);
    await vi.waitFor(() => {
      expect(clipboard.writeText).toHaveBeenCalled();
    });
    const tsv = clipboard.writeText.mock.calls[0][0] as string;
    expect(tsv).toBe("a\t10\t***");
    expect(tsv).not.toContain('"x"');
    expect(maskRowsForCopy).toHaveBeenCalled();
  });
});

describe("disabled gate", () => {
  it("range mutations stage nothing while the grid is read-only", () => {
    const { hook, spies } = makeHarness({
      enabled: false,
      selection: cellSelection({ startRow: 0, endRow: 1, startCol: 1, endCol: 2 }),
    });
    let owned = false;
    act(() => {
      owned = hook.result.current.api.handleRangeDelete();
    });
    expect(owned).toBe(false);
    expect(spies.stageChanges).not.toHaveBeenCalled();
  });
});
