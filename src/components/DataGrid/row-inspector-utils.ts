import { buildRowPrimaryKeys, type GridCellValue, type ResolvedColumn } from "./hooks/useDataGrid";

export function buildRowInspectorPrimaryKeyValues(
  row: readonly GridCellValue[],
  columns: ResolvedColumn[],
  primaryKeyColumns: ResolvedColumn[],
): Record<string, GridCellValue> {
  const values: Record<string, GridCellValue> = {};
  for (const entry of buildRowPrimaryKeys([...row], columns, primaryKeyColumns)) {
    values[entry.column] = entry.value;
  }
  return values;
}
