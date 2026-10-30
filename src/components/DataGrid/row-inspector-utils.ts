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

export interface RowInspectorEditScope {
  gridInstanceId?: string;
  connectionId?: string;
  tableName?: string;
  database?: string | null;
}

export function matchesRowInspectorEditScope(
  detail: RowInspectorEditScope,
  current: RowInspectorEditScope,
): boolean {
  return (
    detail.gridInstanceId === current.gridInstanceId &&
    detail.connectionId === current.connectionId &&
    detail.tableName === current.tableName &&
    (detail.database ?? null) === (current.database ?? null)
  );
}
