import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { ConnectionConfig, QueryResult } from "../../../types";
import { buildRowPrimaryKeys, type ResolvedColumn } from "./useDataGrid";

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
  refreshTableFromStart: () => Promise<void>;

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
  const handleDragStart = useCallback((rowIndex: number) => {
    setDragSourceIndex(rowIndex);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, rowIndex: number) => {
    e.preventDefault();
    setDropTargetIndex(rowIndex);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent, targetIndex: number) => {
    e.preventDefault();
    if (dragSourceIndex === null || dragSourceIndex === targetIndex) {
      setDragSourceIndex(null);
      setDropTargetIndex(null);
      return;
    }
    if (!tableName || !data || primaryKeyColumns.length === 0 || !orderColumn) {
      setError(
        "Cannot reorder rows: table has no sequence column (e.g., row_order, sort_order, position, seq). Add one to enable drag-and-drop reordering.",
      );
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

    // Build UPDATE statements to swap the order values
    const sourcePk = buildRowPrimaryKeys(sourceRow, resolvedColumns, primaryKeyColumns);
    const targetPk = buildRowPrimaryKeys(targetRow, resolvedColumns, primaryKeyColumns);

    const sourceOrderValue = sourceRow[resolvedColumns.findIndex((c) => c.name === orderColumn)];
    const targetOrderValue = targetRow[resolvedColumns.findIndex((c) => c.name === orderColumn)];

    const connection = connections.find((c: ConnectionConfig) => c.id === connectionId);
    const dbType = connection?.db_type;

    const needsQuoting =
      (dbType === "mysql" || dbType === "postgresql" || dbType === "mariadb" || dbType === "sqlite") &&
      typeof sourceOrderValue === "string";

    const fmt = (v: unknown) =>
      v === null ? "NULL" : typeof v === "number" ? String(v) : needsQuoting ? `'${String(v).replace(/'/g, "''")}'` : String(v);

    const sql1 = `UPDATE ${tableName} SET ${orderColumn} = ${fmt(targetOrderValue)} WHERE ${sourcePk.map((pk) => `${pk.column} = ${fmt(pk.value)}`).join(" AND ")};`;
    const sql2 = `UPDATE ${tableName} SET ${orderColumn} = ${fmt(sourceOrderValue)} WHERE ${targetPk.map((pk) => `${pk.column} = ${fmt(pk.value)}`).join(" AND ")};`;

    const confirmed = window.confirm(
      `Reorder rows?\n\nSource: ${tableName}[${orderColumn}] = ${sourceOrderValue}\nTarget: ${tableName}[${orderColumn}] = ${targetOrderValue}\n\nSQL to execute:\n${sql1}\n${sql2}`,
    );
    if (!confirmed) {
      setDragSourceIndex(null);
      setDropTargetIndex(null);
      return;
    }

    try {
      await executeQuery(connectionId, sql1);
      await executeQuery(connectionId, sql2);

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
  }, [dragSourceIndex, tableName, data, primaryKeyColumns, orderColumn, connections, connectionId, resolvedColumns, executeQuery, setError, invalidateTableCaches, database, refreshTableFromStart]);

  const handleDragEnd = useCallback(() => {
    setDragSourceIndex(null);
    setDropTargetIndex(null);
  }, []);

  return {
    handleDragStart,
    handleDragOver,
    handleDrop,
    handleDragEnd,
  };
}
