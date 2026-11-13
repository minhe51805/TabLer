import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentAppLanguage } from "../../../i18n";
import { useAppLayoutStore } from "../../../stores/appLayoutStore";
import { EventCenter } from "../../../stores/event-center";
import type { ConnectionConfig, ForeignKeyInfo, QueryResult } from "../../../types";
import { APP_EVENTS } from "../../../utils/app-events";
import { getRowInspectorCopy } from "../../RowInspector/row-inspector-copy";
import { loadColumnStats } from "../column-stats-runner";
import type { ColumnStats } from "../dialogs/ColumnStatsPopover";
import { getPrimaryGridRange, isMultiCellRange } from "../grid-range-operations";
import { buildStableRowIdentity } from "../row-identity";
import {
  buildRowInspectorPrimaryKeyValues,
  matchesRowInspectorEditScope,
} from "../row-inspector-utils";
import type { DataGridStoreApi } from "../store/dataGridStore";
import type { DataGridColumnMasks } from "./useDataGridColumnMasks";
import type { GridCellValue, ResolvedColumn } from "./useDataGrid";

export interface ContextMenuState {
  x: number;
  y: number;
  type: "cell" | "header" | "row";
  colName?: string;
  rowIndex?: number;
}

export interface FkPreviewState {
  table: string;
  column: string;
  value: string | number | boolean;
  rowIndex: number;
  colIndex: number;
}

export interface UseDataGridInspectorAndPopoversParams {
  connectionId: string;
  database?: string;
  tableName?: string;
  externalResult?: QueryResult;
  isActive: boolean;
  isTableEditable: boolean;
  data: QueryResult | null;
  resolvedColumns: ResolvedColumn[];
  primaryKeyColumns: ResolvedColumn[];
  foreignKeys: ForeignKeyInfo[];
  displayedRowsLength: number;
  displayedRowIndices: number[];
  selectedRows: Set<number>;
  columnMasks: DataGridColumnMasks;
  dataGridStore: DataGridStoreApi;
  dataGridInstanceIdRef: { current: string };
  connections: ConnectionConfig[];
  getTableData: (
    connectionId: string,
    table: string,
    options?: { database?: string; limit?: number; filter?: string },
  ) => Promise<QueryResult>;
  executeQuery: (connectionId: string, sql: string) => Promise<QueryResult>;
  getForeignKeyLookupValues: (
    connectionId: string,
    table: string,
    column: string,
  ) => Promise<Array<{ value: string | number; label: string }>>;
  setError: (message: string) => void;
  editCellFromInspector: (
    rowIndex: number,
    colIndex: number,
    committed: GridCellValue,
  ) => Promise<void>;
}

/**
 * Floating UI state for `<DataGrid />`: context menu, FK preview popover,
 * column stats popover, bulk set-range dialog, and Row Inspector integration.
 * Reads `dataGridStore` imperatively so cell selection never re-renders the grid.
 */
export function useDataGridInspectorAndPopovers({
  connectionId,
  database,
  tableName,
  externalResult,
  isActive,
  isTableEditable,
  data,
  resolvedColumns,
  primaryKeyColumns,
  foreignKeys,
  displayedRowsLength,
  displayedRowIndices,
  selectedRows,
  columnMasks,
  dataGridStore,
  dataGridInstanceIdRef,
  connections,
  getTableData,
  executeQuery,
  getForeignKeyLookupValues,
  setError,
  editCellFromInspector,
}: UseDataGridInspectorAndPopoversParams) {
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [fkPreview, setFkPreview] = useState<FkPreviewState | null>(null);
  const [fkPreviewData, setFkPreviewData] = useState<QueryResult | null>(null);
  const [isLoadingFkPreview, setIsLoadingFkPreview] = useState(false);
  const [lookupValuesCache, setLookupValuesCache] = useState<
    Map<string, Array<{ value: string | number; label: string }>>
  >(new Map());
  const [columnStats, setColumnStats] = useState<{
    column: string;
    stats: ColumnStats | null;
  } | null>(null);
  const [columnStatsError, setColumnStatsError] = useState<string | null>(null);
  const [isLoadingColumnStats, setIsLoadingColumnStats] = useState(false);
  const [setRangeDialog, setSetRangeDialog] = useState<{
    open: boolean;
    cellCount: number;
    error: string | null;
  }>({ open: false, cellCount: 0, error: null });

  const columnStatsRequestIdRef = useRef(0);
  const inspectorTargetRef = useRef<{
    rowIndex: number;
    rowIdentity: string | null;
  } | null>(null);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, type: "cell" | "header" | "row", colName?: string, rowIndex?: number) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({ x: e.clientX, y: e.clientY, type, colName, rowIndex });
    },
    [],
  );

  // Close context menu on outside click.
  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => setContextMenu(null);
    document.addEventListener("click", handler, { once: true });
    document.addEventListener("contextmenu", handler, { once: true });
    return () => {
      document.removeEventListener("click", handler);
      document.removeEventListener("contextmenu", handler);
    };
  }, [contextMenu]);

  const handleOpenRowInspector = useCallback(
    (rowIndex: number) => {
      if (!data || !data.rows[rowIndex]) return;
      const row = data.rows[rowIndex];
      const absoluteRowNumber = rowIndex + 1;
      inspectorTargetRef.current = {
        rowIndex,
        rowIdentity: buildStableRowIdentity(row, resolvedColumns),
      };
      // Masked columns must not leak into the inspector.
      void columnMasks.maskRows([row]).then(([maskedRow]) => {
        const inspectorRow = maskedRow ?? row;
        EventCenter.emit("row-inspector-open", {
          rowIndex: absoluteRowNumber,
          row: inspectorRow,
          columns: resolvedColumns,
          primaryKeyValues: buildRowInspectorPrimaryKeyValues(
            inspectorRow,
            resolvedColumns,
            primaryKeyColumns,
          ),
          tableName,
          database,
          canEdit: isTableEditable,
          maskedColumnNames: [...columnMasks.activeMaskedNames],
          gridInstanceId: dataGridInstanceIdRef.current,
          connectionId,
        });
      });
    },
    [
      data,
      resolvedColumns,
      primaryKeyColumns,
      tableName,
      database,
      columnMasks,
      dataGridInstanceIdRef,
      isTableEditable,
      connectionId,
    ],
  );

  const rowInspectorOpen = useAppLayoutStore((state) => state.showRowInspector);

  /** Toolbar toggle: reads active cell imperatively so selection changes stay isolated. */
  const handleToggleRowInspector = useCallback(() => {
    if (rowInspectorOpen) {
      EventCenter.emit("row-inspector-close", undefined);
      return;
    }
    if (!data || data.rows.length === 0) return;
    const activeCell = dataGridStore.getState().gridSelection.activeCell;
    const target =
      (activeCell ? displayedRowIndices[activeCell.row] : undefined) ??
      (selectedRows.size > 0 ? Math.min(...selectedRows) : 0);
    handleOpenRowInspector(target);
  }, [
    rowInspectorOpen,
    data,
    dataGridStore,
    displayedRowIndices,
    selectedRows,
    handleOpenRowInspector,
  ]);

  useEffect(() => {
    const offEdit = EventCenter.on("row-inspector-edit-cell", (event) => {
      const detail = event.detail;
      if (
        !matchesRowInspectorEditScope(detail, {
          gridInstanceId: dataGridInstanceIdRef.current,
          connectionId,
          tableName,
          database,
        }) ||
        externalResult ||
        !isTableEditable
      ) {
        return;
      }
      const target = inspectorTargetRef.current;
      const sourceRowIndex = detail.rowIndex - 1;
      const row = target?.rowIndex === sourceRowIndex ? data?.rows[sourceRowIndex] : undefined;
      if (!target || !row || buildStableRowIdentity(row, resolvedColumns) !== target.rowIdentity) {
        setError(getRowInspectorCopy(getCurrentAppLanguage()).staleRow);
        return;
      }
      const colIndex = resolvedColumns.findIndex((column) => column.name === detail.columnName);
      if (colIndex < 0) return;
      void editCellFromInspector(sourceRowIndex, colIndex, detail.value);
    });
    const offClose = EventCenter.on("row-inspector-close", () => {
      inspectorTargetRef.current = null;
    });
    return () => {
      offEdit();
      offClose();
    };
  }, [
    connectionId,
    tableName,
    database,
    dataGridInstanceIdRef,
    externalResult,
    isTableEditable,
    data,
    resolvedColumns,
    editCellFromInspector,
    setError,
  ]);

  // FK preview event from global shortcuts (reads activeCell imperatively).
  useEffect(() => {
    if (!isActive) return;
    const handleFkPreviewEvent = () => {
      const activeCell = dataGridStore.getState().gridSelection.activeCell;
      if (!activeCell || !data || !resolvedColumns.length || !foreignKeys.length) return;
      const rowIdx = displayedRowIndices[activeCell.row];
      const colIdx = activeCell.col;
      const col = resolvedColumns[colIdx];
      if (!col || rowIdx === undefined) return;
      const fkInfo = foreignKeys.find((fk) => fk.column === col.name);
      if (!fkInfo) return;
      const cellValue = data.rows[rowIdx]?.[colIdx];
      if (cellValue === null || cellValue === undefined) return;
      const valueStr =
        typeof cellValue === "string" ? `'${cellValue.replace(/'/g, "''")}'` : String(cellValue);
      const filter = `${fkInfo.referenced_column} = ${valueStr}`;
      setFkPreview({
        table: fkInfo.referenced_table,
        column: fkInfo.referenced_column,
        value: cellValue,
        rowIndex: rowIdx,
        colIndex: colIdx,
      });
      setFkPreviewData(null);
      setIsLoadingFkPreview(true);
      void getTableData(connectionId, fkInfo.referenced_table, { database, limit: 5, filter })
        .then((result) => {
          setFkPreviewData(result);
        })
        .catch((err) => {
          console.warn("[FK Preview] failed to load:", err);
        })
        .finally(() => {
          setIsLoadingFkPreview(false);
        });
    };

    return EventCenter.on(APP_EVENTS.datagridFkPreview, handleFkPreviewEvent);
  }, [
    connectionId,
    data,
    dataGridStore,
    database,
    displayedRowIndices,
    foreignKeys,
    getTableData,
    isActive,
    resolvedColumns,
  ]);

  useEffect(() => {
    columnStatsRequestIdRef.current += 1;
    setColumnStats(null);
    setColumnStatsError(null);
    setIsLoadingColumnStats(false);
  }, [connectionId, database, tableName]);

  const handleCloseColumnStats = useCallback(() => {
    columnStatsRequestIdRef.current += 1;
    setColumnStats(null);
    setColumnStatsError(null);
    setIsLoadingColumnStats(false);
  }, []);

  const handleColumnStats = useCallback(
    (colName: string) => {
      if (!tableName || externalResult) return;
      const columnIndex = resolvedColumns.findIndex((column) => column.name === colName);
      const column = columnIndex >= 0 ? resolvedColumns[columnIndex] : undefined;
      if (!column) return;
      const requestId = columnStatsRequestIdRef.current + 1;
      columnStatsRequestIdRef.current = requestId;
      const isCurrent = () => columnStatsRequestIdRef.current === requestId;
      setColumnStats({ column: colName, stats: null });
      setColumnStatsError(null);
      setIsLoadingColumnStats(true);
      void loadColumnStats({
        connectionId,
        tableName,
        column,
        columnIndex,
        dataRows: data?.rows ?? [],
        databaseType: connections.find((c: ConnectionConfig) => c.id === connectionId)?.db_type,
        executeQuery,
        isCurrent,
      })
        .then((stats) => {
          if (!isCurrent() || !stats) return;
          setColumnStats({ column: colName, stats });
        })
        .catch((error) => {
          if (isCurrent()) {
            setColumnStatsError(String(error instanceof Error ? error.message : error));
          }
        })
        .finally(() => {
          if (isCurrent()) setIsLoadingColumnStats(false);
        });
    },
    [tableName, externalResult, resolvedColumns, connections, connectionId, executeQuery, data],
  );

  const handleOpenSetRangeDialog = useCallback(() => {
    if (!data || resolvedColumns.length === 0) {
      setSetRangeDialog({ open: true, cellCount: 0, error: null });
      return;
    }
    const range = getPrimaryGridRange(dataGridStore.getState().gridSelection, {
      rowCount: displayedRowsLength,
      columnCount: resolvedColumns.length,
    });
    const cellCount =
      range && isMultiCellRange(range)
        ? (range.endRow - range.startRow + 1) * (range.endCol - range.startCol + 1)
        : 0;
    setSetRangeDialog({ open: true, cellCount, error: null });
  }, [data, dataGridStore, displayedRowsLength, resolvedColumns.length]);

  useEffect(() => {
    if (!setRangeDialog.open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setSetRangeDialog((previous) => ({ ...previous, open: false }));
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [setRangeDialog.open]);

  const handleLoadLookupValues = useCallback(
    async (table: string, column: string) => {
      const cacheKey = `${table}|${column}`;
      const cached = lookupValuesCache.get(cacheKey);
      if (cached) return cached;
      try {
        const values = await getForeignKeyLookupValues(connectionId, table, column);
        setLookupValuesCache((prev) => new Map(prev).set(cacheKey, values));
        return values;
      } catch {
        return [];
      }
    },
    [connectionId, getForeignKeyLookupValues, lookupValuesCache],
  );

  return {
    contextMenu,
    setContextMenu,
    handleContextMenu,
    fkPreview,
    setFkPreview,
    fkPreviewData,
    isLoadingFkPreview,
    lookupValuesCache,
    handleLoadLookupValues,
    columnStats,
    columnStatsError,
    isLoadingColumnStats,
    handleColumnStats,
    handleCloseColumnStats,
    setRangeDialog,
    setSetRangeDialog,
    handleOpenSetRangeDialog,
    rowInspectorOpen,
    handleOpenRowInspector,
    handleToggleRowInspector,
  };
}
