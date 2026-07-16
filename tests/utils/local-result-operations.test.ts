import { describe, expect, it } from "vitest";
import { filterAndSortLocalRows, filterRowsWithSourceIndices } from "@/components/DataGrid/local-result-operations";

describe("local query result operations", () => {
  const rows = [
    [2, "Zulu", null],
    [10, "alpha", true],
    [1, "Alpha", false],
  ];

  it("filters every displayed value without changing the original result rows", () => {
    const result = filterAndSortLocalRows([...rows], ["id", "name", "enabled"], "alp", null, "ASC");
    expect(result).toEqual([[10, "alpha", true], [1, "Alpha", false]]);
    expect(rows).toHaveLength(3);
  });

  it("preserves original indices for filtered table rows", () => {
    expect(filterRowsWithSourceIndices(rows, "alp")).toEqual([
      { row: [10, "alpha", true], sourceIndex: 1 },
      { row: [1, "Alpha", false], sourceIndex: 2 },
    ]);
  });

  it("sorts values stably and puts null values last", () => {
    expect(filterAndSortLocalRows([...rows], ["id", "name", "enabled"], "", "id", "ASC"))
      .toEqual([[1, "Alpha", false], [2, "Zulu", null], [10, "alpha", true]]);
    expect(filterAndSortLocalRows([...rows], ["id", "name", "enabled"], "", "enabled", "ASC"))
      .toEqual([[1, "Alpha", false], [10, "alpha", true], [2, "Zulu", null]]);
  });
});
