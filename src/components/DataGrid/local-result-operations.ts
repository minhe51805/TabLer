import type { GridCellValue } from "./hooks/useDataGrid";

function compareValues(left: GridCellValue, right: GridCellValue) {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  if (typeof left === "boolean" && typeof right === "boolean") return Number(left) - Number(right);
  return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" });
}

/** Filter loaded table rows while retaining their source indices for row actions. */
export function filterRowsWithSourceIndices(rows: GridCellValue[][], filter: string) {
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  return rows
    .map((row, sourceIndex) => ({ row, sourceIndex }))
    .filter(({ row }) => (
      !normalizedFilter
        || row.some((value) => String(value ?? "").toLocaleLowerCase().includes(normalizedFilter))
    ));
}

/** Apply the same header sort and a case-insensitive quick filter to query result rows. */
export function filterAndSortLocalRows(
  rows: GridCellValue[][],
  columnNames: string[],
  filter: string,
  sortColumn: string | null,
  sortDir: "ASC" | "DESC",
) {
  const filtered = filterRowsWithSourceIndices(rows, filter).map(({ row }) => row);
  const columnIndex = sortColumn ? columnNames.indexOf(sortColumn) : -1;
  if (columnIndex < 0) return filtered;

  return filtered
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const compared = compareValues(left.row[columnIndex], right.row[columnIndex]);
      return compared === 0 ? left.index - right.index : sortDir === "ASC" ? compared : -compared;
    })
    .map(({ row }) => row);
}
