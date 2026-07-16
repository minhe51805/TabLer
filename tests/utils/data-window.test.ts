import { describe, expect, it } from "vitest";
import {
  createDataWindow,
  DATA_GRID_PERFORMANCE_FIXTURES,
  getChunkOffset,
  getDataWindowDisplayCount,
  getDataWindowRows,
  getRequiredChunkOffsets,
  isDataWindowRangeLoaded,
  mergeDataWindowChunk,
  resolveDataWindowColumns,
} from "@/components/DataGrid/data-window";

describe("data window", () => {
  it("keeps canonical columns when a later chunk omits metadata", () => {
    expect(resolveDataWindowColumns(["id", "name"], [], [])).toEqual(["id", "name"]);
    expect(resolveDataWindowColumns([], ["id", "name"], [])).toEqual(["id", "name"]);
    expect(resolveDataWindowColumns([], [], ["id", "name"])).toEqual(["id", "name"]);
  });

  it("plans chunk boundaries for a virtual viewport", () => {
    expect(getChunkOffset(501, 250)).toBe(500);
    expect(getRequiredChunkOffsets(240, 520, 250)).toEqual([0, 250, 500]);
  });

  it("merges sparse chunks in deterministic row order", () => {
    let window = createDataWindow<number>(3);
    window = mergeDataWindowChunk(window, 3, [4, 5, 6]);
    window = mergeDataWindowChunk(window, 0, [1, 2, 3], 6);
    expect(getDataWindowRows(window)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(isDataWindowRangeLoaded(window, 1, 5)).toBe(true);
  });

  it("keeps an unknown total scrollable until a short final chunk arrives", () => {
    let window = createDataWindow<number>(3);
    window = mergeDataWindowChunk(window, 0, [1, 2, 3]);
    expect(window.endReached).toBe(false);
    expect(getDataWindowDisplayCount(window)).toBe(6);
    window = mergeDataWindowChunk(window, 3, [4]);
    expect(window.endReached).toBe(true);
    expect(getDataWindowDisplayCount(window)).toBe(4);
  });

  it("keeps a 100k-row fixture addressable by chunk", () => {
    const { rowCount } = DATA_GRID_PERFORMANCE_FIXTURES.oneHundredThousandRows;
    const chunkSize = 250;
    let window = createDataWindow<number>(chunkSize);
    for (let offset = 0; offset < rowCount; offset += chunkSize) {
      window = mergeDataWindowChunk(
        window,
        offset,
        Array.from({ length: chunkSize }, (_, index) => offset + index),
        rowCount,
      );
    }
    expect(isDataWindowRangeLoaded(window, 99_750, 99_999)).toBe(true);
    expect(getDataWindowDisplayCount(window)).toBe(rowCount);
  });

  it("declares both medium and wide-grid performance fixtures", () => {
    expect(DATA_GRID_PERFORMANCE_FIXTURES.tenThousandRows.rowCount).toBe(10_000);
    expect(DATA_GRID_PERFORMANCE_FIXTURES.wideColumns.columnCount).toBeGreaterThanOrEqual(100);
  });
});
