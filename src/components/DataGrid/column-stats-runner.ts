import type { QueryResult } from "../../types";
import { quoteIdentifier } from "../../utils/sql-generator";
import type { DatabaseType } from "../../types";
import type { ResolvedColumn } from "./hooks/useDataGrid";
import { isNumericColumn } from "./editors/cell-editor-registry";
import { hasNumericValues } from "./chart-utils";
import type { ColumnStats } from "./dialogs/ColumnStatsPopover";

export interface LoadColumnStatsParams {
  connectionId: string;
  tableName: string;
  column: ResolvedColumn;
  columnIndex: number;
  dataRows: QueryResult["rows"];
  databaseType?: DatabaseType;
  executeQuery: (connectionId: string, sql: string) => Promise<QueryResult>;
  isCurrent: () => boolean;
}

export async function loadColumnStats({
  connectionId,
  tableName,
  column,
  columnIndex,
  dataRows,
  databaseType,
  executeQuery,
  isCurrent,
}: LoadColumnStatsParams): Promise<ColumnStats | null> {
  const quotedTable = quoteIdentifier(tableName, databaseType);
  const quotedColumn = quoteIdentifier(column.name, databaseType);
  const result = await executeQuery(
    connectionId,
    `SELECT COUNT(*) AS total, COUNT(DISTINCT ${quotedColumn}) AS distinct_count, SUM(CASE WHEN ${quotedColumn} IS NULL THEN 1 ELSE 0 END) AS null_count FROM ${quotedTable}`,
  );
  if (!isCurrent()) return null;

  const row = result.rows[0];
  const stats: ColumnStats = {
    total: typeof row?.[0] === "number" ? row[0] : Number(row?.[0] ?? 0),
    distinct: typeof row?.[1] === "number" ? row[1] : Number(row?.[1] ?? 0),
    nulls: typeof row?.[2] === "number" ? row[2] : Number(row?.[2] ?? 0),
  };

  const numeric = isNumericColumn(column) || hasNumericValues(dataRows, columnIndex);
  if (numeric) {
    try {
      const aggregates = await executeQuery(
        connectionId,
        `SELECT MIN(${quotedColumn}) AS min_value, MAX(${quotedColumn}) AS max_value, AVG(${quotedColumn}) AS avg_value FROM ${quotedTable}`,
      );
      if (!isCurrent()) return null;
      const aggregateRow = aggregates.rows[0];
      stats.min = aggregateRow?.[0] ?? null;
      stats.max = aggregateRow?.[1] ?? null;
      stats.avg = aggregateRow?.[2] ?? null;
    } catch {
      // Aggregates unsupported for this type — counts still stand.
    }
  }
  return isCurrent() ? stats : null;
}
