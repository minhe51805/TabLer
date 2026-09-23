import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { ConnectionConfig, DatabaseType, QueryResult } from "../../../types";
import { getCurrentAppLanguage } from "../../../i18n";
import { quoteIdentifier } from "../../../utils/sql-generator";
import { getDataGridCopy } from "../datagrid-copy";
import { buildRowPrimaryKeys, type ResolvedColumn } from "./useDataGrid";

/** SQL literal for a cell value — mirrors cellToSql in utils/sql-generator. */
function sqlLiteral(value: unknown, dbType: DatabaseType | undefined): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return String(value);
  const str = typeof value === "object" ? JSON.stringify(value) : String(value);
  // MSSQL needs the N'' prefix for unicode strings; every dialect quotes
  // strings — an unquoted literal would silently corrupt the WHERE clause.
  return dbType === "mssql" ? `N'${str.replace(/'/g, "''")}'` : `'${str.replace(/'/g, "''")}'`;
}

interface DataGridDragReorderParams {
  tableName?: string;
  database?: string;
  connectionId: string;
  data: QueryResult | null;
  resolvedColumns: ResolvedColumn[];
  primaryKeyColumns: ResolvedColumn[];
  orderColumn?: string | null;
  connections: ConnectionConfig[];

  dragSourceIndex: number | null;

  setDragSourceIndex: Dispatch<SetStateAction<number | null>>;
  setDropTargetIndex: Dispatch<SetStateAction<number | null>>;
  setError: (message: string) => void;
  executeQuery: (connectionId: string, sql: string) => Promise<unknown>;
  invalidateTableCaches: (connectionId: string, tableName: string, database?: string) => void;
  refreshTableFromStart: () => Promise<unknown>;

  dataGridInstanceIdRef: RefObject<string>;
}

/**
 * Drag-and-drop row reordering driven by a sequence column.
 * Handlers are moved verbatim from the grid component body.
 */
export function useDataGridDragReorder({
  tableName,
  database,
  connectionId,
  data,
  resolvedColumns,
  primaryKeyColumns,
  orderColumn,
  connections,

  dragSourceIndex,

  setDragSourceIndex,
  setDropTargetIndex,
  setError,
  executeQuery,
  invalidateTableCaches,
  refreshTableFromStart,

  dataGridInstanceIdRef,
}: DataGridDragReorderParams) {
  const handleDragStart = useCallback(
    (rowIndex: number) => {
      setDragSourceIndex(rowIndex);
    },
    [setDragSourceIndex],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent, rowIndex: number) => {
      e.preventDefault();
      setDropTargetIndex(rowIndex);
    },
    [setDropTargetIndex],
  );

  const handleDrop = useCallback(
    async (e: React.DragEvent, targetIndex: number) => {
      e.preventDefault();
      if (dragSourceIndex === null || dragSourceIndex === targetIndex) {
        setDragSourceIndex(null);
        setDropTargetIndex(null);
        return;
      }
      const copy = getDataGridCopy(getCurrentAppLanguage());
      if (!tableName || !data || primaryKeyColumns.length === 0 || !orderColumn) {
        setError(copy.reorder.noOrderColumn);
        setDragSourceIndex(null);
        setDropTargetIndex(null);
        return;
      }

      const sourceRow = data.rows[dragSourceIndex];
      const targetRow = data.rows[targetIndex];
      if (!sourceRow || !targetRow) {
        setDragSourceIndex(null);
        setDropTargetIndex(null);
        return;
      }

      const sourcePk = buildRowPrimaryKeys(sourceRow, resolvedColumns, primaryKeyColumns);
      const targetPk = buildRowPrimaryKeys(targetRow, resolvedColumns, primaryKeyColumns);

      const orderColumnIndex = resolvedColumns.findIndex((c) => c.name === orderColumn);
      if (orderColumnIndex < 0) {
        setError(copy.reorder.noOrderColumn);
        setDragSourceIndex(null);
        setDropTargetIndex(null);
        return;
      }
      const sourceOrderValue = sourceRow[orderColumnIndex];
      const targetOrderValue = targetRow[orderColumnIndex];

      const connection = connections.find((c: ConnectionConfig) => c.id === connectionId);
      const dbType = connection?.db_type;

      const quotedTable = quoteIdentifier(tableName, dbType);
      const quotedOrderColumn = quoteIdentifier(orderColumn, dbType);
      const sourceCond = sourcePk
        .map((pk) => `${quoteIdentifier(pk.column, dbType)} = ${sqlLiteral(pk.value, dbType)}`)
        .join(" AND ");
      const targetCond = targetPk
        .map((pk) => `${quoteIdentifier(pk.column, dbType)} = ${sqlLiteral(pk.value, dbType)}`)
        .join(" AND ");

      // One atomic UPDATE: a CASE picks the swapped value per matched row, so a
      // failure can never leave a half-swap behind (unlike the old two-statement
      // pair, which had no transaction around it).
      const sql =
        `UPDATE ${quotedTable} SET ${quotedOrderColumn} = CASE ` +
        `WHEN ${sourceCond} THEN ${sqlLiteral(targetOrderValue, dbType)} ` +
        `WHEN ${targetCond} THEN ${sqlLiteral(sourceOrderValue, dbType)} ` +
        `ELSE ${quotedOrderColumn} END WHERE (${sourceCond}) OR (${targetCond});`;

      const confirmed = window.confirm(
        copy.reorder.confirm(tableName, orderColumn, sourceOrderValue, targetOrderValue, sql),
      );
      if (!confirmed) {
        setDragSourceIndex(null);
        setDropTargetIndex(null);
        return;
      }

      try {
        await executeQuery(connectionId, sql);

        invalidateTableCaches(connectionId, tableName, database);
        window.dispatchEvent(
          new CustomEvent("table-data-updated", {
            detail: { connectionId, database, tableName, sourceId: dataGridInstanceIdRef.current },
          }),
        );
        await refreshTableFromStart();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(`Reorder failed: ${message}`);
      } finally {
        setDragSourceIndex(null);
        setDropTargetIndex(null);
      }
    },
    [
      dragSourceIndex,
      tableName,
      data,
      primaryKeyColumns,
      orderColumn,
      resolvedColumns,
      connections,
      setDragSourceIndex,
      setDropTargetIndex,
      setError,
      connectionId,
      executeQuery,
      invalidateTableCaches,
      database,
      dataGridInstanceIdRef,
      refreshTableFromStart,
    ],
  );

  const handleDragEnd = useCallback(() => {
    setDragSourceIndex(null);
    setDropTargetIndex(null);
  }, [setDragSourceIndex, setDropTargetIndex]);

  return {
    handleDragStart,
    handleDragOver,
    handleDrop,
    handleDragEnd,
  };
}
