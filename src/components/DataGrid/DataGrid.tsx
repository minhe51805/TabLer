import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import {
  useReactTable,
  getCoreRowModel,
  type ColumnDef,
  type ColumnOrderState,
  type VisibilityState,
  type ColumnPinningState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useI18n, translateCurrent, getCurrentAppLanguage } from "../../i18n";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Copy, Loader2 } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useDataGridSettings } from "../../stores/datagrid-settings-store";
import {
  useChangeTrackingStore,
  changeScopeKey,
  changeMatchesScope,
} from "../../stores/change-tracking-store";
import { useConnectionStore } from "../../stores/connectionStore";
import { useGlobalErrorStore } from "../../stores/globalErrorStore";
import { useQueryStore } from "../../stores/queryStore";
import { EventCenter } from "../../stores/event-center";
import {
  parseClipboardText,
  buildPastePreview,
  type PastePreview,
} from "../../utils/clipboard-parser";
import type { ColumnDetail, ConnectionConfig, QueryResult, TableRowFocus } from "../../types";
import { devLogError } from "../../utils/logger";
import { invokeMutation } from "../../utils/tauri-utils";
import { quoteIdentifier } from "../../utils/sql-generator";
import { emitAppToast } from "../../utils/app-toast";
import { isMutatingStatement } from "../SQLEditor/SQLEditorUtils";
import { lazy, Suspense } from "react";
import "./DataChart.css";
import { getDataGridChartCopy } from "./datagrid-chart-copy";
import { getDataGridPowerCopy } from "./datagrid-power-copy";
import { getDataGridCopy } from "./datagrid-copy";

const DataChart = lazy(() => import("./DataChart").then((m) => ({ default: m.DataChart })));
import {
  PAGE_SIZE,
  invalidateTableScopeCaches,
  invalidateTableCaches,
  inlineStructureCacheRef,
  buildResolvedColumns,
  isBooleanColumn,
  isNumericColumn,
  buildRowPrimaryKeys,
  resolveTableFilter,
  type ResolvedColumn,
  type GridCellValue,
  type StructureStatus,
  type EditingCell,
} from "./hooks/useDataGrid";
import { getColumnWidths, saveColumnWidth } from "../../stores/column-width-store";
import { getColumnLayout, saveColumnLayout } from "../../stores/column-layout-store";
import { useDateFormatStore } from "../../stores/dateFormatStore";
import { filterAndSortLocalRows, filterRowsWithSourceIndices } from "./local-result-operations";
import {
  createEmptyGridSelection,
  isGridCellSelected,
  moveGridSelection,
  selectEntireGrid,
  selectGridCell,
  type GridSelectionModifiers,
} from "./grid-selection";
import { getPrimaryGridRange, isMultiCellRange } from "./grid-range-operations";
import { buildStableRowIdentity } from "./row-identity";
import { useConnectionCapabilities } from "../../hooks/useConnectionCapabilities";
import { useAppLayoutStore } from "../../stores/appLayoutStore";
import { isCapabilitySupported } from "../../types";

import { DataGridToolbar } from "./DataGridToolbar";
import { buildDataGridColumns } from "./DataGridColumns";
import { useDataGridCopySqlActions } from "./hooks/useDataGridCopySqlActions";
import { useDataGridInlineEditing } from "./hooks/useDataGridInlineEditing";
import { useDataGridRangeOperations } from "./hooks/useDataGridRangeOperations";
import { useDataGridStagedChanges } from "./hooks/useDataGridStagedChanges";
import { useDataGridSortFilter } from "./hooks/useDataGridSortFilter";
import { useDataGridRowSelection } from "./hooks/useDataGridRowSelection";
import { useDataGridDragReorder } from "./hooks/useDataGridDragReorder";
import { useDataGridTableFetcher } from "./hooks/useDataGridTableFetcher";
import { useDataGridRowMutations } from "./hooks/useDataGridRowMutations";
import { useDataGridTableExport } from "./hooks/useDataGridTableExport";
import { useDataGridColumnMasks } from "./hooks/useDataGridColumnMasks";
import { buildRowFocusFilter } from "./row-focus";
import { InsertRowDialog } from "./dialogs/InsertRowDialog";
import { type ColumnStats } from "./dialogs/ColumnStatsPopover";
import { hasNumericValues } from "./chart-utils";
import type { ColumnDisplayFormat } from "./editors";
import { DataGridOverlays } from "./DataGridOverlays";
import { DataGridTableView } from "./DataGridTableView";
import { DataGridFooter } from "./DataGridFooter";

/** Minimum width that must remain for scrollable (unpinned) columns. Pinning
 *  that would leave less than this is refused so the grid never becomes a
 *  wall of frozen columns. */
const MIN_UNPINNED_VIEWPORT_PX = 160;

interface Props {
  connectionId: string;
  tableName?: string;
  database?: string;
  queryResult?: QueryResult;
  isActive?: boolean;
  initialViewMode?: "table" | "chart";
  onViewModeChange?: (mode: "table" | "chart") => void;
  rowFocus?: TableRowFocus;
}

export function DataGrid({
  connectionId,
  tableName,
  database,
  queryResult: externalResult,
  isActive = true,
  initialViewMode = "table",
  onViewModeChange,
  rowFocus,
}: Props) {
  const { settings } = useDataGridSettings();
  const {
    getTableData,
    countRows,
    getTableStructure,
    applyTableUpdatesAtomically,
    deleteTableRows,
    insertTableRow,
    insertTableRowsAtomically,
    importCsvFileAtomically,
    exportTableData,
    cancelTableExport,
    cancelCsvImport,
    getForeignKeyLookupValues,
    executeQuery,
  } = useQueryStore(
    useShallow((state) => ({
      getTableData: state.getTableData,
      countRows: state.countRows,
      getTableStructure: state.getTableStructure,
      applyTableUpdatesAtomically: state.applyTableUpdatesAtomically,
      deleteTableRows: state.deleteTableRows,
      insertTableRow: state.insertTableRow,
      insertTableRowsAtomically: state.insertTableRowsAtomically,
      importCsvFileAtomically: state.importCsvFileAtomically,
      exportTableData: state.exportTableData,
      cancelTableExport: state.cancelTableExport,
      cancelCsvImport: state.cancelCsvImport,
      getForeignKeyLookupValues: state.getForeignKeyLookupValues,
      executeQuery: state.executeQuery,
    })),
  );
  const setError = useGlobalErrorStore((state) => state.setError);
  const connections = useConnectionStore((state) => state.connections as ConnectionConfig[]);
  const capabilityProfile = useConnectionCapabilities(connectionId);
  const allowsInlineEdit = isCapabilitySupported(capabilityProfile?.capabilities.inlineEdit);
  const allowsAtomicEdits = isCapabilitySupported(capabilityProfile?.capabilities.atomicEditQueue);
  const allowsCsvImport = isCapabilitySupported(capabilityProfile?.capabilities.atomicCsvImport);
  const allowsDataExport = isCapabilitySupported(capabilityProfile?.capabilities.dataExport);
  const initialColumnLayoutRef = useRef(getColumnLayout(connectionId, tableName ?? "", database));

  const {
    stagedChanges,
    stageChange,
    stageChanges,
    unstageChanges,
    undoLast,
    openPreview,
    closePreview,
    redoLast,
    setColumnNameMap,
    setDbType,
    getChangeCount,
    getUndoCount,
    getRedoCount,
  } = useChangeTrackingStore();

  const [data, setData] = useState<QueryResult | null>(externalResult || null);
  const [structureColumns, setStructureColumns] = useState<ColumnDetail[]>([]);
  const [foreignKeys, setForeignKeys] = useState<import("../../types").ForeignKeyInfo[]>([]);
  const [lookupValuesCache, setLookupValuesCache] = useState<
    Map<string, Array<{ value: string | number; label: string }>>
  >(new Map());
  const [isLoading, setIsLoading] = useState(false);
  /** True while the grid shows a cached page (see grid-cache-policy TTLs). */
  const [dataFromCache, setDataFromCache] = useState(false);
  const [totalRows, setTotalRows] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);
  const [hasMoreTableRows, setHasMoreTableRows] = useState(true);
  const [structureStatus, setStructureStatus] = useState<StructureStatus>(
    externalResult ? "ready" : "idle",
  );
  const [sortColumn, setSortColumn] = useState<string | null>(
    initialColumnLayoutRef.current.sort?.column ?? null,
  );
  const [sortDir, setSortDir] = useState<"ASC" | "DESC">(
    initialColumnLayoutRef.current.sort?.direction ?? "ASC",
  );
  const [filterDraft, setFilterDraft] = useState(initialColumnLayoutRef.current.filter);
  const [tableFilter, setTableFilter] = useState(initialColumnLayoutRef.current.filter);
  /** Multi-column sort: array of {column, direction, priority}. Priority 1 = highest. */
  const [multiSort, setMultiSort] = useState<
    Array<{ column: string; direction: "ASC" | "DESC"; priority: number }>
  >([]);
  const [gridSelection, setGridSelection] = useState(createEmptyGridSelection);
  const selectedCell = gridSelection.activeCell;
  const [selectedRowIdentities, setSelectedRowIdentities] = useState<Set<string>>(new Set());
  const [editingCell, setEditingCell] = useState<EditingCell | null>(null);
  const [editingSeedValue, setEditingSeedValue] = useState("");
  const [savingCell, setSavingCell] = useState<EditingCell | null>(null);
  const [isDeletingRows, setIsDeletingRows] = useState(false);
  const [copiedCell, setCopiedCell] = useState<string | null>(null);
  const [isInsertDialogOpen, setIsInsertDialogOpen] = useState(false);
  const [insertDialogColumns, setInsertDialogColumns] = useState<ColumnDetail[]>([]);
  const [insertDialogBaseValues, setInsertDialogBaseValues] = useState<[string, unknown][]>([]);
  const [insertDraft, setInsertDraft] = useState<Record<string, string>>({});
  const [insertDialogError, setInsertDialogError] = useState<string | null>(null);
  const [isSubmittingInsert, setIsSubmittingInsert] = useState(false);
  /** When true the insert dialog stages a queued insert (duplicate-row flow). */
  const [insertDialogStages, setInsertDialogStages] = useState(false);
  /** "Set selected cells to…" bulk-edit dialog state. */
  const [setRangeDialog, setSetRangeDialog] = useState<{
    open: boolean;
    cellCount: number;
    error: string | null;
  }>({ open: false, cellCount: 0, error: null });
  /** Paste dialog state */
  const [isPasteDialogOpen, setIsPasteDialogOpen] = useState(false);
  const [pastePreview, setPastePreview] = useState<PastePreview | null>(null);
  const [pasteSourceLabel, setPasteSourceLabel] = useState("Clipboard data");
  const [csvFileSelection, setCsvFileSelection] = useState<{
    filePath: string;
    delimiter: "csv" | "tsv";
    byteSize: number;
    isTruncated: boolean;
  } | null>(null);
  const [isSubmittingPaste, setIsSubmittingPaste] = useState(false);
  const [isCancellingPaste, setIsCancellingPaste] = useState(false);
  const [csvImportProgress, setCsvImportProgress] = useState<{
    processedRows: number;
    processedBytes: number;
    totalBytes: number;
  } | null>(null);
  const [isExportingFull, setIsExportingFull] = useState(false);
  const [exportedRowCount, setExportedRowCount] = useState(0);
  /** Set of row indices with pending staged changes */
  const [stagedRowIndices, setStagedRowIndices] = useState<Set<number>>(new Set());
  /** FK Preview: {table, column, value, rowIndex, colIndex} */
  const [fkPreview, setFkPreview] = useState<{
    table: string;
    column: string;
    value: string | number | boolean;
    rowIndex: number;
    colIndex: number;
  } | null>(null);
  const [fkPreviewData, setFkPreviewData] = useState<import("../../types").QueryResult | null>(
    null,
  );
  const [isLoadingFkPreview, setIsLoadingFkPreview] = useState(false);
  /** Column stats popover: which column, its aggregates, and query state. */
  const [columnStats, setColumnStats] = useState<{
    column: string;
    stats: ColumnStats | null;
  } | null>(null);
  const [columnStatsError, setColumnStatsError] = useState<string | null>(null);
  const [isLoadingColumnStats, setIsLoadingColumnStats] = useState(false);
  const [viewMode, setViewMode] = useState<"table" | "chart">(initialViewMode);
  const [columnSizes, setColumnSizes] = useState<Record<string, number>>(() =>
    getColumnWidths(connectionId, tableName ?? "", database),
  );
  const [columnOrder, setColumnOrder] = useState<ColumnOrderState>(
    initialColumnLayoutRef.current.order,
  );
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(
    initialColumnLayoutRef.current.visibility,
  );
  const [columnPinning, setColumnPinning] = useState<ColumnPinningState>(
    initialColumnLayoutRef.current.pinning,
  );
  const rowFocusFilter = useMemo(() => buildRowFocusFilter(rowFocus), [rowFocus]);
  /** Scope key for this grid's staged-change queue (connection|db|table). */
  const changeScope = tableName ? changeScopeKey(connectionId, database, tableName) : "";
  /** Resolved quick filter: server-side clause when expressible, else the
   *  client-side-only flag that limits filtering to loaded rows. */
  const filterPlan = useMemo(
    () =>
      resolveTableFilter(
        tableFilter,
        rowFocusFilter,
        structureColumns,
        connections.find((c) => c.id === connectionId)?.db_type,
      ),
    [tableFilter, rowFocusFilter, structureColumns, connections, connectionId],
  );
  const [columnDisplayFormats, setColumnDisplayFormats] = useState<
    Record<string, ColumnDisplayFormat>
  >({});
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    type: "cell" | "header" | "row";
    colName?: string;
    rowIndex?: number;
  } | null>(null);
  /** Row drag-and-drop state */
  const [dragSourceIndex, setDragSourceIndex] = useState<number | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  const [orderColumn, setOrderColumn] = useState<string | null>(null);
  const columnNamesRef = useRef<string[]>([]);
  /** Per-grid inline-edit draft — a ref, never a module singleton. */
  const editingDraftRef = useRef("");
  /** True once the user actually typed in the editor — distinguishes an
   *  untouched blur (no-op) from deliberately typing the seed text back. */
  const editingTouchedRef = useRef(false);
  const tableWrapRef = useRef<HTMLDivElement>(null);
  const requestIdRef = useRef(0);
  const dataScopeRef = useRef("");
  const countRequestIdRef = useRef(0);
  const structureRequestIdRef = useRef(0);
  const structurePromiseRef = useRef<Promise<ColumnDetail[]> | null>(null);
  const structureRetryAttemptRef = useRef(0);
  const structureRetryTimeoutRef = useRef<number | null>(null);
  const countTimeoutRef = useRef<number | null>(null);
  const isMountedRef = useRef(true);
  const isActiveRef = useRef(isActive);
  const rowSelectionAnchorRef = useRef<string | null>(null);
  const dataGridInstanceIdRef = useRef(`datagrid-${Math.random().toString(36).slice(2)}`);
  const csvImportOperationIdRef = useRef<string | null>(null);
  const tableExportOperationIdRef = useRef<string | null>(null);
  // A table-data-updated event that arrived while this grid was in a
  // background tab marks the data stale; refetch as soon as the tab is
  // active again (the event-time fetch is skipped for inactive grids).
  const pendingDataRefreshRef = useRef(false);
  const loadedTablePagesRef = useRef(new Map<number, QueryResult>());

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    void listen<{
      operationId: string;
      processedRows: number;
      processedBytes: number;
      totalBytes: number;
    }>("csv-import-progress", (event) => {
      if (event.payload.operationId !== csvImportOperationIdRef.current) return;
      setCsvImportProgress({
        processedRows: event.payload.processedRows,
        processedBytes: event.payload.processedBytes,
        totalBytes: event.payload.totalBytes,
      });
    })
      .then((cleanup) => {
        unlisten = cleanup;
      })
      .catch(() => {
        // Browser-only tests and previews do not expose Tauri's event bridge.
      });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    void listen<{ operationId: string; exportedRows: number }>("table-export-progress", (event) => {
      if (event.payload.operationId !== tableExportOperationIdRef.current) return;
      setExportedRowCount(event.payload.exportedRows);
    })
      .then((cleanup) => {
        unlisten = cleanup;
      })
      .catch(() => {
        // Browser-only tests and previews do not expose Tauri's event bridge.
      });
    return () => unlisten?.();
  }, []);

  // Displayed-row pipeline: the quick filter (and, for external results, the
  // client-side sort) decides which rows exist for the user. Selection and
  // range operations live in this displayed space so filtered-out rows can
  // never be selected, copied, or mutated.
  const filteredTableRows = useMemo(() => {
    if (!data || externalResult) return [];
    return filterRowsWithSourceIndices(data.rows, tableFilter);
  }, [data, externalResult, tableFilter]);

  const filteredTableRowIndices = useMemo(
    () => filteredTableRows.map(({ sourceIndex }) => sourceIndex),
    [filteredTableRows],
  );

  const displayedRows = useMemo(() => {
    if (!data) return [];
    if (!externalResult) return filteredTableRows.map(({ row }) => row);
    return filterAndSortLocalRows(
      data.rows as GridCellValue[][],
      data.columns.map((column) => column.name),
      tableFilter,
      sortColumn,
      sortDir,
    );
  }, [data, externalResult, filteredTableRows, sortColumn, sortDir, tableFilter]);

  const displayedRowIndices = useMemo(() => {
    if (!externalResult) return filteredTableRowIndices;
    // filterAndSortLocalRows preserves row identity, so each displayed row
    // maps back to its source index through a reference map — the row
    // inspector and context menu depend on this being exact.
    const sourceIndexByRow = new Map<GridCellValue[], number>();
    data?.rows.forEach((row, index) => {
      sourceIndexByRow.set(row as GridCellValue[], index);
    });
    return displayedRows.map((row, index) => sourceIndexByRow.get(row) ?? index);
  }, [data?.rows, displayedRows, externalResult, filteredTableRowIndices]);

  const setSelectedCell = useCallback(
    (cell: { row: number; col: number } | null, modifiers: GridSelectionModifiers = {}) => {
      if (!cell) {
        setGridSelection(createEmptyGridSelection());
        return;
      }
      // Callers pass SOURCE row indices (data.rows); the selection state is
      // kept in displayed row space so keyboard navigation and range
      // operations only ever touch visible rows.
      const displayedRow = displayedRowIndices.indexOf(cell.row);
      if (displayedRow < 0) return;
      tableWrapRef.current?.focus({ preventScroll: true });
      setGridSelection((previous) =>
        selectGridCell(
          previous,
          { row: displayedRow, col: cell.col },
          {
            rowCount: displayedRows.length,
            columnCount: structureColumns.length || data?.columns.length || 0,
          },
          modifiers,
        ),
      );
    },
    [data?.columns.length, displayedRowIndices, displayedRows.length, structureColumns.length],
  );

  const isCellSelected = useCallback(
    (row: number, col: number) => isGridCellSelected(gridSelection, { row, col }),
    [gridSelection],
  );

  useEffect(() => {
    setViewMode(initialViewMode);
  }, [initialViewMode]);

  const handleViewModeChange = useCallback(
    (mode: "table" | "chart") => {
      setViewMode(mode);
      onViewModeChange?.(mode);
    },
    [onViewModeChange],
  );

  useEffect(() => {
    const element = tableWrapRef.current;
    if (!element || viewMode !== "table") return;

    const handleGridKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;

      const bounds = {
        // Displayed rows only — arrow keys and Ctrl+A must skip filtered-out
        // rows entirely.
        rowCount: displayedRows.length,
        columnCount: structureColumns.length || data?.columns.length || 0,
      };
      if (bounds.rowCount === 0 || bounds.columnCount === 0) return;

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        setGridSelection(selectEntireGrid(bounds));
        return;
      }
      if (event.key === "Escape") {
        setGridSelection(createEmptyGridSelection());
        return;
      }

      const deltas: Record<string, { row: number; col: number }> = {
        ArrowUp: { row: -1, col: 0 },
        ArrowDown: { row: 1, col: 0 },
        ArrowLeft: { row: 0, col: -1 },
        ArrowRight: { row: 0, col: 1 },
      };
      const delta = deltas[event.key];
      if (!delta) return;

      event.preventDefault();
      setGridSelection((previous) => moveGridSelection(previous, delta, bounds, event.shiftKey));
    };

    element.addEventListener("keydown", handleGridKeyDown);
    return () => element.removeEventListener("keydown", handleGridKeyDown);
  }, [data?.columns.length, displayedRows.length, structureColumns.length, viewMode]);

  const { patchLoadedTableCell, fetchData, refreshTableFromStart, ensureStructureLoaded } =
    useDataGridTableFetcher({
      connectionId,
      tableName,
      database: database || undefined,
      sortColumn,
      sortDir,
      tableFilter,
      rowFocusFilter,
      isActive,
      externalResult,
      structureColumns,
      structureStatus,
      getTableData,
      countRows,
      getTableStructure,
      setColumnNameMap,
      setDbType,
      connections,
      setData,
      setTotalRows,
      setIsLoading,
      setHasMoreTableRows,
      setCurrentPage,
      setStructureColumns,
      setForeignKeys,
      setStructureStatus,
      setError,
      setDataFromCache,
      refs: {
        loadedTablePagesRef,
        dataScopeRef,
        requestIdRef,
        isActiveRef,
        isMountedRef,
        countRequestIdRef,
        countTimeoutRef,
        structurePromiseRef,
        structureRetryAttemptRef,
        structureRetryTimeoutRef,
        structureRequestIdRef,
        inlineStructureCacheRef,
      },
    });

  /** Reload button feedback: spinner while refetching, toast when done. */
  const [isReloadingData, setIsReloadingData] = useState(false);
  const handleReloadData = useCallback(async () => {
    if (isReloadingData) return;
    setIsReloadingData(true);
    const startedAt = Date.now();
    let ok = false;
    try {
      ok = await refreshTableFromStart();
    } finally {
      // Keep the spinner on screen for at least 450ms so a fast DB still shows
      // the rotation instead of flickering.
      const elapsed = Date.now() - startedAt;
      if (elapsed < 450) await new Promise((resolve) => setTimeout(resolve, 450 - elapsed));
      setIsReloadingData(false);
    }
    emitAppToast(
      ok
        ? { title: translateCurrent("datagrid.reloadSuccess"), tone: "success" }
        : {
            title: translateCurrent("datagrid.reloadFailed"),
            description: translateCurrent("datagrid.reloadFailedDesc"),
            tone: "error",
          },
    );
  }, [isReloadingData, refreshTableFromStart]);

  // ── Auto-refresh ──────────────────────────────────────────────────────────
  // Interval in ms; 0 = off. The countdown itself lives in the toolbar so the
  // 1s ticks don't re-render the whole grid.
  const [autoRefreshMs, setAutoRefreshMs] = useState(0);
  const autoRefreshInFlightRef = useRef(false);

  /** Auto-refresh only re-runs read-only statements — a mutating query would
      otherwise trip the Safe Mode confirm dialog on every tick. */
  const canAutoRefresh =
    Boolean(tableName && !externalResult) ||
    Boolean(
      externalResult?.query &&
      /^(select|with|show|explain|describe|desc|table|values)\b/i.test(
        externalResult.query.trim(),
      ) &&
      // `EXPLAIN ANALYZE <write>` (and other disguised writes like
      // `SELECT ... INTO`) execute the wrapped statement — never re-run them.
      !isMutatingStatement(externalResult.query),
    );
  const handleAutoRefreshTick = useCallback(async () => {
    if (autoRefreshInFlightRef.current || !isMountedRef.current) return;
    autoRefreshInFlightRef.current = true;
    try {
      if (externalResult) {
        // Query-result grid: re-run the SQL that produced this result.
        const sql = externalResult.query?.trim();
        if (!sql) return;
        const result = await invokeMutation<QueryResult>("execute_query", {
          connectionId,
          sql,
          requestId: crypto.randomUUID(),
          safeModeApprovedByUser: false,
        });
        if (result && isMountedRef.current) {
          setData(result);
          setTotalRows(result.rows.length);
        }
      } else {
        await refreshTableFromStart();
      }
    } catch (error) {
      devLogError("Auto-refresh failed", error);
    } finally {
      autoRefreshInFlightRef.current = false;
    }
  }, [connectionId, externalResult, refreshTableFromStart]);

  const undoableChanges = changeScope ? getUndoCount(changeScope) : 0;
  const redoableChanges = changeScope ? getRedoCount(changeScope) : 0;

  useEffect(() => {
    if (externalResult) {
      setData(externalResult);
      loadedTablePagesRef.current.clear();
      setStructureColumns([]);
      setTotalRows(externalResult.rows.length);
      setIsLoading(false);
      setDataFromCache(false);
      setStructureStatus("ready");
      structurePromiseRef.current = null;
      structureRetryAttemptRef.current = 0;
      if (structureRetryTimeoutRef.current !== null) {
        window.clearTimeout(structureRetryTimeoutRef.current);
        structureRetryTimeoutRef.current = null;
      }
      structureRequestIdRef.current += 1;
      return;
    }

    setData(null);
    loadedTablePagesRef.current.clear();
    setHasMoreTableRows(true);
    setStructureColumns([]);
    setTotalRows(0);
    setDataFromCache(false);
    setCurrentPage(0);
    const persistedLayout = getColumnLayout(connectionId, tableName ?? "", database);
    setFilterDraft(persistedLayout.filter);
    setTableFilter(persistedLayout.filter);
    setSortColumn(persistedLayout.sort?.column ?? null);
    setSortDir(persistedLayout.sort?.direction ?? "ASC");
    setColumnOrder(persistedLayout.order);
    setColumnVisibility(persistedLayout.visibility);
    setColumnPinning(persistedLayout.pinning);
    setStructureStatus("idle");
    structurePromiseRef.current = null;
    structureRetryAttemptRef.current = 0;
    if (structureRetryTimeoutRef.current !== null) {
      window.clearTimeout(structureRetryTimeoutRef.current);
      structureRetryTimeoutRef.current = null;
    }
    requestIdRef.current += 1;
    countRequestIdRef.current += 1;
    structureRequestIdRef.current += 1;
    // Restore persisted column widths for the new table
    setColumnSizes(getColumnWidths(connectionId, tableName ?? "", database));
  }, [tableName, connectionId, database, externalResult, rowFocus?.token]);

  useEffect(() => {
    if (!tableName || externalResult) return;
    const timeoutId = window.setTimeout(() => {
      saveColumnLayout(
        connectionId,
        tableName,
        {
          order: columnOrder,
          visibility: columnVisibility,
          pinning: {
            left: columnPinning.left ?? [],
            right: columnPinning.right ?? [],
          },
          sort: sortColumn ? { column: sortColumn, direction: sortDir } : null,
          filter: filterDraft,
        },
        database,
      );
    }, 150);
    return () => window.clearTimeout(timeoutId);
  }, [
    columnOrder,
    columnPinning,
    columnVisibility,
    connectionId,
    database,
    externalResult,
    filterDraft,
    sortColumn,
    sortDir,
    tableName,
  ]);

  useEffect(() => {
    if (!tableName || externalResult || !isActive) return;
    void fetchData(currentPage);
  }, [currentPage, externalResult, fetchData, isActive, tableName]);

  useEffect(() => {
    if (filterDraft === tableFilter) return;
    const timeoutId = window.setTimeout(() => {
      setTableFilter(filterDraft);
    }, 250);
    return () => window.clearTimeout(timeoutId);
  }, [filterDraft, tableFilter]);

  useEffect(() => {
    if (!tableName || externalResult || !isActive || !data) return;
    if (structureStatus !== "idle") return;

    const warmupId = window.setTimeout(() => {
      void ensureStructureLoaded().catch((error) => {
        devLogError("Inline edit metadata warmup failed:", error);
      });
    }, 180);

    return () => window.clearTimeout(warmupId);
  }, [data, ensureStructureLoaded, externalResult, isActive, structureStatus, tableName]);

  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  // Column resolution - must be declared before any callbacks that use resolvedColumns
  const dataColumns = data?.columns.length ? data.columns : structureColumns;

  const resolvedColumns = useMemo<ResolvedColumn[]>(() => {
    if (dataColumns.length === 0) return [];
    const cols = buildResolvedColumns(dataColumns, structureColumns);
    columnNamesRef.current = cols.map((c) => c.name);
    return cols;
  }, [dataColumns, structureColumns]);

  const primaryKeyColumns = useMemo(
    () => resolvedColumns.filter((column) => column.is_primary_key),
    [resolvedColumns],
  );

  // View-time column masking (A4): persisted per connection+table, masked
  // matrix precomputed over the displayed window. Reveal is session-only.
  const columnMasks = useDataGridColumnMasks(
    connectionId,
    database,
    tableName,
    resolvedColumns,
    displayedRows,
  );

  const rowIdentities = useMemo(
    () => (data?.rows ?? []).map((row) => buildStableRowIdentity(row, resolvedColumns)),
    [data?.rows, resolvedColumns],
  );
  const selectedRows = useMemo(() => {
    const indices = new Set<number>();
    rowIdentities.forEach((identity, index) => {
      if (identity && selectedRowIdentities.has(identity)) indices.add(index);
    });
    return indices;
  }, [rowIdentities, selectedRowIdentities]);
  const setSelectedRows = useCallback(
    (update: Set<number> | ((previous: Set<number>) => Set<number>)) => {
      setSelectedRowIdentities((previousIdentities) => {
        const previousIndices = new Set<number>();
        rowIdentities.forEach((identity, index) => {
          if (identity && previousIdentities.has(identity)) previousIndices.add(index);
        });
        const nextIndices = typeof update === "function" ? update(previousIndices) : update;
        const nextIdentities = new Set<string>();
        nextIndices.forEach((index) => {
          const identity = rowIdentities[index];
          if (identity) nextIdentities.add(identity);
        });
        return nextIdentities;
      });
    },
    [rowIdentities],
  );

  const { reconcileStagedChanges, applyStagedChanges, discardStagedChanges } =
    useDataGridStagedChanges({
      stagedChanges,
      tableName,
      database: database || undefined,
      connectionId,
      resolvedColumns,
      setData,
      setStagedRowIndices,
      setIsLoading,
      setError,
      unstageChanges,
      applyTableUpdatesAtomically,
      closePreview,
      insertTableRowsAtomically,
      invalidateTableCaches,
      patchLoadedTableCell,
      refreshTableFromStart,
      dataGridInstanceIdRef,
    });

  useEffect(() => {
    if (!rowFocus || !data?.rows.length || externalResult) return;
    setSelectedRows(new Set([0]));
  }, [data, externalResult, rowFocus, setSelectedRows]);
  const handlePasteRowsFromClipboard = useCallback(async () => {
    if (!tableName || resolvedColumns.length === 0) return;

    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      setError("Cannot read clipboard. Try using Ctrl+C to copy, then paste here.");
      return;
    }

    const parsed = parseClipboardText(text);
    if (!parsed) {
      setError("Clipboard does not contain valid TSV/CSV data.");
      return;
    }

    const tableColumnNames = resolvedColumns.map((c) => c.name);
    const preview = buildPastePreview(parsed, tableColumnNames);

    if (preview.mappings.length === 0) {
      setError(
        `No columns matched. Clipboard has ${parsed.columnCount} column(s), table has ${tableColumnNames.length} column(s). Check column names.`,
      );
      return;
    }

    setPastePreview(preview);
    setPasteSourceLabel("Clipboard data");
    setCsvFileSelection(null);
    setIsPasteDialogOpen(true);
  }, [tableName, resolvedColumns, setError]);

  // Ctrl+Shift+V: paste rows from clipboard (in DataGrid, not in insert mode)
  useEffect(() => {
    if (!isActive || !tableName || externalResult) return;

    const handlePasteRows = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key === "V") {
        event.preventDefault();
        void handlePasteRowsFromClipboard();
      }
    };

    window.addEventListener("keydown", handlePasteRows);
    return () => window.removeEventListener("keydown", handlePasteRows);
  }, [isActive, tableName, externalResult, handlePasteRowsFromClipboard]);

  // Detect order/sort column on structure load. Match is EXACT on the
  // normalized name (lowercase, non-alphanumerics stripped) — a substring
  // test would claim "record" (contains "ord"), "border", or "sequence_id"
  // as order columns and enable bogus drag-reorder.
  useEffect(() => {
    if (structureColumns.length === 0) return;
    const ORDER_COLUMN_NAMES = new Set([
      "roworder",
      "sortorder",
      "sortindex",
      "position",
      "seq",
      "sequence",
      "rank",
      "priority",
      "displayorder",
      "itemorder",
      "orderindex",
      "ordering",
      "sortpos",
      "rowno",
      "rownum",
      "ord",
      "order",
    ]);
    const found = structureColumns.find((col) =>
      ORDER_COLUMN_NAMES.has(col.name.toLowerCase().replace(/[^a-z0-9]/g, "")),
    );
    setOrderColumn(found?.name ?? null);
  }, [structureColumns]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      requestIdRef.current += 1;
      structureRequestIdRef.current += 1;
      structurePromiseRef.current = null;
      structureRetryAttemptRef.current = 0;
      if (structureRetryTimeoutRef.current !== null) {
        window.clearTimeout(structureRetryTimeoutRef.current);
        structureRetryTimeoutRef.current = null;
      }
      if (countTimeoutRef.current !== null) {
        window.clearTimeout(countTimeoutRef.current);
        countTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const handleStructureUpdated = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          connectionId: string;
          tableName: string;
          database?: string;
        }>
      ).detail;

      if (!detail) return;
      invalidateTableCaches(detail.connectionId, detail.tableName, detail.database, {
        invalidateStructure: true,
      });
    };

    window.addEventListener("table-structure-updated", handleStructureUpdated);
    return () => {
      window.removeEventListener("table-structure-updated", handleStructureUpdated);
    };
  }, []);

  useEffect(() => {
    const handleTableDataUpdated = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          connectionId: string;
          database?: string;
          tableName?: string;
          invalidateStructure?: boolean;
          sourceId?: string;
        }>
      ).detail;

      if (!detail || detail.connectionId !== connectionId) return;
      if (
        detail.database !== undefined &&
        database !== undefined &&
        (detail.database || "") !== (database || "")
      ) {
        return;
      }

      const invalidationDatabaseScope = database !== undefined ? detail.database : undefined;
      invalidateTableScopeCaches(
        detail.connectionId,
        invalidationDatabaseScope,
        detail.tableName,
        Boolean(detail.invalidateStructure),
      );

      if (!tableName || externalResult) return;
      if (detail.tableName && detail.tableName !== tableName) return;
      if (detail.sourceId === dataGridInstanceIdRef.current) return;

      if (!isActiveRef.current) {
        pendingDataRefreshRef.current = true;
        return;
      }

      pendingDataRefreshRef.current = false;
      void fetchData(currentPage);
    };

    window.addEventListener("table-data-updated", handleTableDataUpdated);
    return () => {
      window.removeEventListener("table-data-updated", handleTableDataUpdated);
    };
  }, [connectionId, currentPage, database, externalResult, fetchData, tableName]);

  // Deferred refresh: an update event may land while this grid is a
  // background tab; refetch on the next activation.
  useEffect(() => {
    if (!isActive || !tableName || externalResult) return;
    if (!pendingDataRefreshRef.current) return;
    pendingDataRefreshRef.current = false;
    void fetchData(currentPage);
  }, [isActive, currentPage, externalResult, fetchData, tableName]);

  useEffect(() => {
    setEditingCell(null);
    setEditingSeedValue("");
    editingDraftRef.current = "";
    editingTouchedRef.current = false;
    setSavingCell(null);
  }, [tableName, currentPage, sortColumn, sortDir, externalResult]);

  useEffect(() => {
    setSelectedRowIdentities(new Set());
    rowSelectionAnchorRef.current = null;
  }, [connectionId, database, externalResult, tableName]);

  // Reset multi-sort when switching tables
  useEffect(() => {
    setMultiSort([]);
  }, [tableName, connectionId, database]);

  // Reset view mode when switching data source
  useEffect(() => {
    setViewMode("table");
  }, [tableName, connectionId, database, externalResult]);

  /** Duplicate selected row(s) — opens insert dialog pre-filled with source row values. */

  // Listen for global undo/redo commands from AppKeyboardHandler
  useEffect(() => {
    if (!isActive) return;

    const handleUndo = () => {
      if (undoableChanges === 0) return;
      const nextChanges = undoLast(changeScope);
      if (nextChanges) reconcileStagedChanges(nextChanges);
    };

    const handleRedo = () => {
      if (redoableChanges === 0) return;
      const nextChanges = redoLast(changeScope);
      if (nextChanges) reconcileStagedChanges(nextChanges);
    };

    window.addEventListener("datagrid-undo", handleUndo);
    window.addEventListener("datagrid-redo", handleRedo);

    const handleDupRowEvent = () => {
      void handleDuplicateRow();
    };
    window.addEventListener("datagrid-duplicate-row", handleDupRowEvent);

    const handleFkPreviewEvent = () => {
      if (!selectedCell || !data || !resolvedColumns.length || !foreignKeys.length) return;
      // selectedCell is in displayed row space — map back to the source row.
      const rowIdx = displayedRowIndices[selectedCell.row];
      const colIdx = selectedCell.col;
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
    window.addEventListener("datagrid-fk-preview", handleFkPreviewEvent);

    return () => {
      window.removeEventListener("datagrid-undo", handleUndo);
      window.removeEventListener("datagrid-redo", handleRedo);
      window.removeEventListener("datagrid-duplicate-row", handleDupRowEvent);
      window.removeEventListener("datagrid-fk-preview", handleFkPreviewEvent);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    connectionId,
    data,
    database,
    displayedRowIndices,
    foreignKeys,
    getTableData,
    isActive,
    reconcileStagedChanges,
    redoLast,
    redoableChanges,
    resolvedColumns,
    selectedCell,
    undoLast,
    undoableChanges,
  ]);

  /** Server-side order is single-column so every loaded chunk uses one consistent order. */
  const { handleSort, handleFilterChange, handleMultiSortClear, handleSortAsc, handleSortDesc } =
    useDataGridSortFilter({
      sortColumn,
      multiSort,
      setMultiSort,
      setSortColumn,
      setSortDir,
      setCurrentPage,
      setFilterDraft,
    });

  const handleCopyValue = useCallback((value: GridCellValue, cellKey: string) => {
    navigator.clipboard.writeText(value === null ? "NULL" : String(value));
    setCopiedCell(cellKey);
    setTimeout(() => setCopiedCell(null), 1200);
  }, []);

  // Auto-fit column to content: double-click on divider
  const handleColumnAutoFit = useCallback(
    (colId: string) => {
      if (colId === "_row_num") return;
      const wrap = tableWrapRef.current;
      if (!wrap) return;

      if (columnNamesRef.current.indexOf(colId) < 0) return;

      // Measure header text width
      const headerEl = wrap.querySelector(`th[data-col-id="${CSS.escape(colId)}"]`);
      const headerWidth = headerEl?.textContent?.length ?? colId.length;
      const headerSize = Math.max(40, headerWidth * 8.5 + 32);

      // Measure content width from rendered cells. Cells carry data-col-id —
      // nth-child would count the virtual column spacers and land on the
      // wrong column under column virtualization.
      let maxContentWidth = 0;
      const cellEls = wrap.querySelectorAll<HTMLElement>(
        `.datagrid-row td[data-col-id="${CSS.escape(colId)}"]`,
      );
      cellEls.forEach((el) => {
        const clone = el.cloneNode(true) as HTMLElement;
        clone.style.position = "absolute";
        clone.style.visibility = "hidden";
        clone.style.whiteSpace = "nowrap";
        clone.style.width = "auto";
        clone.style.maxWidth = "none";
        clone.style.overflow = "visible";
        document.body.appendChild(clone);
        maxContentWidth = Math.max(maxContentWidth, clone.scrollWidth);
        document.body.removeChild(clone);
      });

      const newWidth = Math.max(40, Math.max(maxContentWidth + 22, headerSize));
      setColumnSizes((prev) => ({ ...prev, [colId]: newWidth }));
      if (tableName) saveColumnWidth(connectionId, tableName, colId, newWidth, database);
    },
    [connectionId, database, tableName],
  );

  // Context menu handler
  const handleContextMenu = useCallback(
    (e: React.MouseEvent, type: "cell" | "header" | "row", colName?: string, rowIndex?: number) => {
      e.preventDefault();
      // Keep this event away from the document-level close listener below —
      // otherwise a right-click while a menu is open (or a stale armed listener)
      // sets the fresh menu state back to null within the same event, and the
      // menu never appears.
      e.stopPropagation();
      setContextMenu({ x: e.clientX, y: e.clientY, type, colName, rowIndex });
    },
    [],
  );

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => setContextMenu(null);
    document.addEventListener("click", handler, { once: true });
    document.addEventListener("contextmenu", handler, { once: true });
    return () => {
      document.removeEventListener("click", handler);
      // The contextmenu listener is { once: true } but only consumes itself on
      // a contextmenu event; if the menu closes first (item click / re-render),
      // it stays armed and would swallow the NEXT right-click's menu. Remove it.
      document.removeEventListener("contextmenu", handler);
    };
  }, [contextMenu]);

  const handleOpenRowInspector = useCallback(
    (rowIndex: number) => {
      if (!data || !data.rows[rowIndex]) return;
      const row = data.rows[rowIndex];
      const absoluteRowNumber = rowIndex + 1;
      const pkEntries = buildRowPrimaryKeys(row, resolvedColumns, primaryKeyColumns);
      const pkValues: Record<string, string | number | boolean | null> = {};
      pkEntries.forEach((entry) => {
        pkValues[entry.column] = entry.value;
      });
      // Masked columns must not leak into the inspector — mask the row before
      // emitting so the panel shows exactly what the grid shows.
      void columnMasks.maskRows([row]).then(([maskedRow]) => {
        EventCenter.emit("row-inspector-open", {
          rowIndex: absoluteRowNumber,
          row: maskedRow ?? row,
          columns: resolvedColumns,
          primaryKeyValues: pkValues,
          tableName,
          database,
        });
      });
    },
    [data, resolvedColumns, primaryKeyColumns, tableName, database, columnMasks],
  );

  const rowInspectorOpen = useAppLayoutStore((state) => state.showRowInspector);

  /** Toolbar toggle: opens the inspector on the active cell's row (falling
   *  back to the first selected row, then the first row) or closes it. */
  const handleToggleRowInspector = useCallback(() => {
    if (rowInspectorOpen) {
      EventCenter.emit("row-inspector-close", undefined);
      return;
    }
    if (!data || data.rows.length === 0) return;
    // selectedCell is in displayed row space — map to the source row.
    const target =
      (selectedCell ? displayedRowIndices[selectedCell.row] : undefined) ??
      (selectedRows.size > 0 ? Math.min(...selectedRows) : 0);
    handleOpenRowInspector(target);
  }, [
    rowInspectorOpen,
    data,
    selectedCell,
    displayedRowIndices,
    selectedRows,
    handleOpenRowInspector,
  ]);

  /** Header context-menu "Column stats": runs aggregate SELECTs through the
   *  regular read-only query path and shows the results in a popover. Only
   *  offered for table-backed grids (tableName present, no external result). */
  const handleColumnStats = useCallback(
    (colName: string) => {
      if (!tableName || externalResult) return;
      const colIndex = resolvedColumns.findIndex((column) => column.name === colName);
      const column = colIndex >= 0 ? resolvedColumns[colIndex] : undefined;
      const statsDbType = connections.find((c: ConnectionConfig) => c.id === connectionId)?.db_type;
      const quotedTable = quoteIdentifier(tableName, statsDbType);
      const quotedColumn = quoteIdentifier(colName, statsDbType);
      setColumnStats({ column: colName, stats: null });
      setColumnStatsError(null);
      setIsLoadingColumnStats(true);
      void executeQuery(
        connectionId,
        `SELECT COUNT(*) AS total, COUNT(DISTINCT ${quotedColumn}) AS distinct_count, SUM(CASE WHEN ${quotedColumn} IS NULL THEN 1 ELSE 0 END) AS null_count FROM ${quotedTable}`,
      )
        .then(async (result) => {
          const row = result.rows[0];
          const stats: ColumnStats = {
            total: typeof row?.[0] === "number" ? row[0] : Number(row?.[0] ?? 0),
            distinct: typeof row?.[1] === "number" ? row[1] : Number(row?.[1] ?? 0),
            nulls: typeof row?.[2] === "number" ? row[2] : Number(row?.[2] ?? 0),
          };
          // MIN/MAX/AVG only for numeric columns — a separate query so a
          // type-sniff miss or an unsupported aggregate never loses the counts.
          const numeric =
            (column && isNumericColumn(column)) ||
            (colIndex >= 0 && hasNumericValues(data?.rows ?? [], colIndex));
          if (numeric) {
            try {
              const aggregates = await executeQuery(
                connectionId,
                `SELECT MIN(${quotedColumn}) AS min_value, MAX(${quotedColumn}) AS max_value, AVG(${quotedColumn}) AS avg_value FROM ${quotedTable}`,
              );
              const aggregateRow = aggregates.rows[0];
              stats.min = aggregateRow?.[0] ?? null;
              stats.max = aggregateRow?.[1] ?? null;
              stats.avg = aggregateRow?.[2] ?? null;
            } catch {
              // Aggregates unsupported for this type — counts still stand.
            }
          }
          setColumnStats({ column: colName, stats });
        })
        .catch((error) => {
          setColumnStatsError(String(error instanceof Error ? error.message : error));
        })
        .finally(() => {
          setIsLoadingColumnStats(false);
        });
    },
    [tableName, externalResult, resolvedColumns, connections, connectionId, executeQuery, data],
  );

  const canAttemptInlineEdit = Boolean(
    tableName && !externalResult && allowsInlineEdit && allowsAtomicEdits,
  );
  const canSelectRows = Boolean(tableName && !externalResult && primaryKeyColumns.length > 0);
  const isTableEditable = Boolean(
    tableName &&
    !externalResult &&
    allowsInlineEdit &&
    allowsAtomicEdits &&
    structureStatus === "ready" &&
    primaryKeyColumns.length > 0,
  );
  const selectedRowCount = selectedRows.size;
  const allVisibleRowsSelected = Boolean(
    canSelectRows &&
    filteredTableRowIndices.length &&
    filteredTableRowIndices.every((rowIndex) => selectedRows.has(rowIndex)),
  );

  const { startEditingCell, cancelEditingCell, commitEditingCell } = useDataGridInlineEditing({
    canAttemptInlineEdit,
    connectionId,
    data,
    tableName,
    database: database || undefined,
    resolvedColumns,
    primaryKeyColumns,
    structureStatus,
    editingCell,
    setEditingCell,
    setEditingSeedValue,
    setSavingCell,
    setStagedRowIndices,
    setData,
    setSelectedCell,
    setError,
    stageChange,
    patchLoadedTableCell,
    ensureStructureLoaded,
    maskedColumnNames: columnMasks.activeMaskedNames,
    editingDraftRef,
    editingTouchedRef,
  });

  const {
    handleRangeCopy,
    handleRangePaste,
    handleRangeDelete,
    handleRangeFillDown,
    handleRangeSetValue,
  } = useDataGridRangeOperations({
    gridSelection,
    data,
    displayedRows,
    displayedRowIndices,
    resolvedColumns,
    primaryKeyColumns,
    tableName,
    connectionId,
    database: database || undefined,
    enabled: canAttemptInlineEdit,
    stageChanges,
    setData,
    setStagedRowIndices,
    patchLoadedTableCell,
    setError,
    maskedColumnNames: columnMasks.activeMaskedNames,
    maskRowsForCopy: columnMasks.maskRows,
  });

  /** Cells covered by the active selection — gates the bulk-edit menu item. */
  const selectedRangeCellCount = useMemo(() => {
    if (!data || resolvedColumns.length === 0) return 0;
    const range = getPrimaryGridRange(gridSelection, {
      rowCount: displayedRows.length,
      columnCount: resolvedColumns.length,
    });
    if (!range || !isMultiCellRange(range)) return 0;
    return (range.endRow - range.startRow + 1) * (range.endCol - range.startCol + 1);
  }, [data, displayedRows.length, gridSelection, resolvedColumns.length]);

  const handleOpenSetRangeDialog = useCallback(() => {
    setSetRangeDialog({ open: true, cellCount: selectedRangeCellCount, error: null });
  }, [selectedRangeCellCount]);

  // Range editing keys (copy / paste / fill / clear). Kept separate from the
  // early selection-key effect because these depend on the staged-edit gate,
  // which is only known after the fetcher and capability wiring above.
  useEffect(() => {
    const element = tableWrapRef.current;
    if (!element || viewMode !== "table") return;

    const handleRangeEditingKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;

      const key = event.key.toLowerCase();
      const primary = event.ctrlKey || event.metaKey;

      if (primary && !event.shiftKey && !event.altKey && (key === "c" || key === "v")) {
        const handled = key === "c" ? handleRangeCopy() : handleRangePaste();
        if (handled) event.preventDefault();
        return;
      }
      if (primary && !event.shiftKey && !event.altKey && key === "d") {
        // Fill down only owns Ctrl+D for a multi-cell range; a plain active
        // cell keeps the global duplicate-row shortcut untouched.
        if (handleRangeFillDown()) event.preventDefault();
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        if (handleRangeDelete()) event.preventDefault();
      }
    };

    element.addEventListener("keydown", handleRangeEditingKeyDown);
    return () => element.removeEventListener("keydown", handleRangeEditingKeyDown);
  }, [handleRangeCopy, handleRangeDelete, handleRangeFillDown, handleRangePaste, viewMode]);
  const {
    closeInsertDialog,
    closePasteDialog,
    handleInsertRow,
    handleInsertDraftChange,
    handleSubmitInsertDialog,
    handleSubmitPasteDialog,
    handleCancelPasteImport,
    handleDuplicateRowByIndex,
    handleDeleteSelectedRows,
    handleDuplicateRow,
  } = useDataGridRowMutations({
    tableName,
    database: database || undefined,
    connectionId,
    resolvedColumns,
    structureColumns,
    data,
    selectedRows,
    filteredTableRowIndices,
    primaryKeyColumns,

    insertDialogBaseValues,
    insertDialogColumns,
    insertDraft,
    setInsertDialogColumns,
    setInsertDialogBaseValues,
    setInsertDraft,
    setInsertDialogError,
    setIsInsertDialogOpen,
    setIsSubmittingInsert,
    insertDialogStages,
    setInsertDialogStages,

    pastePreview,
    isSubmittingPaste,
    csvFileSelection,
    isCancellingPaste,
    setPastePreview,
    setCsvFileSelection,
    setPasteSourceLabel,
    setDragSourceIndex,
    setDropTargetIndex,
    setIsPasteDialogOpen,
    setIsSubmittingPaste,
    setIsCancellingPaste,
    setCsvImportProgress,
    setError,
    setSelectedRows,
    setSelectedCell,
    cancelEditingCell,
    setIsDeletingRows,
    deleteTableRows,
    setData,
    setTotalRows,
    rowSelectionAnchorRef,

    csvImportOperationIdRef,

    insertTableRow,
    insertTableRowsAtomically,
    importCsvFileAtomically,
    cancelCsvImport,

    stageChange,

    invalidateTableCaches,
    refreshTableFromStart,

    dataGridInstanceIdRef,
  });
  const { handleDragStart, handleDragOver, handleDrop, handleDragEnd } = useDataGridDragReorder({
    tableName,
    database: database || undefined,
    connectionId,
    data,
    resolvedColumns,
    primaryKeyColumns,
    orderColumn,
    dragSourceIndex,
    connections,
    setDragSourceIndex,
    setDropTargetIndex,
    setError,
    executeQuery,
    invalidateTableCaches,
    refreshTableFromStart,
    dataGridInstanceIdRef,
  });
  useEffect(() => {
    if (!isInsertDialogOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeInsertDialog();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closeInsertDialog, isInsertDialogOpen]);

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

  useEffect(() => {
    if (!isPasteDialogOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePasteDialog();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closePasteDialog, isPasteDialogOpen]);

  useEffect(() => {
    closeInsertDialog();
  }, [closeInsertDialog, connectionId, database, tableName]);
  const handleImportCsv = useCallback(async () => {
    if (!tableName || resolvedColumns.length === 0) return;
    try {
      const file = await invokeMutation<{
        fileName: string;
        content: string;
        byteSize: number;
        filePath: string;
        isTruncated: boolean;
        delimiter: "csv" | "tsv";
      }>("read_csv_file", {});
      const parsed = parseClipboardText(file.content);
      if (!parsed) throw new Error("The selected file does not contain valid CSV or TSV data.");
      const preview = buildPastePreview(
        parsed,
        resolvedColumns.map((column) => column.name),
      );
      if (preview.mappings.length === 0)
        throw new Error("No CSV headers match columns in the selected table.");
      setPastePreview(preview);
      setCsvFileSelection({
        filePath: file.filePath,
        delimiter: file.delimiter,
        byteSize: file.byteSize,
        isTruncated: file.isTruncated,
      });
      const sizeLabel =
        file.byteSize >= 1024 * 1024
          ? `${(file.byteSize / (1024 * 1024)).toFixed(1)} MB`
          : `${Math.max(1, Math.round(file.byteSize / 1024))} KB`;
      setPasteSourceLabel(`${file.fileName} (${sizeLabel}, streaming import)`);
      setIsPasteDialogOpen(true);
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
    }
  }, [resolvedColumns, setError, tableName]);

  /** Apply all staged changes to the database (commit) */
  const { handleRowSelection, handleToggleSelectAllRows } = useDataGridRowSelection({
    canSelectRows,
    data,
    rowIdentities,
    filteredTableRowIndices,
    setSelectedRows,
    rowSelectionAnchorRef,
  });

  const { handleFullTableExport, handleCancelFullTableExport } = useDataGridTableExport({
    tableName,
    database: database || undefined,
    connectionId,
    sortColumn,
    sortDir,
    filterPlan,
    isExportingFull,
    setIsExportingFull,
    setExportedRowCount,
    setError,
    exportTableData,
    cancelTableExport,
    tableExportOperationIdRef,
    masksActive: columnMasks.hasActiveMasks,
  });

  const {
    handleCopyAsInsert,
    handleCopyAsUpdate,
    handleCopyAsInsertParam,
    handleCopyAsUpdateParam,
    handleCopyAsDeleteParam,
  } = useDataGridCopySqlActions({
    selectedRows,
    data,
    tableName,
    resolvedColumns,
    primaryKeyColumns,
    connections,
    connectionId: connectionId ?? undefined,
    setError,
    maskRowsForCopy: columnMasks.maskRows,
  });

  // Table tabs are paginated — the banner only fires when a requested page
  // was clamped above MAX_TABLE_PAGE_ROWS. Query tabs surface the cap via
  // the toolbar badge instead: one indicator per surface, no duplicates.
  const isPageClamped = Boolean(!externalResult && data?.truncated);

  // Derive dbType and date format for date cell formatting
  const { t, language } = useI18n();
  const connection = connections.find((c: ConnectionConfig) => c.id === connectionId);
  const dbType = connection?.db_type;
  const dateFormat = useDateFormatStore((s) => s.getFormat(connectionId, dbType));

  const columns = useMemo<ColumnDef<unknown[], unknown>[]>(() => {
    if (!data || resolvedColumns.length === 0) return [];

    const handleLoadLookupValues = async (table: string, column: string) => {
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
    };

    return buildDataGridColumns({
      resolvedColumns,
      canSelectRows,
      canAttemptInlineEdit,
      selectedRows,
      selectedCell,
      isCellSelected,
      editingCell,
      editingSeedValue,
      savingCell,
      sortColumn,
      sortDir,
      rowOffset: 0,
      rowIndexMap: displayedRowIndices,
      copiedCell,
      editingDraftRef,
      editingTouchedRef,
      handleSort,
      handleRowSelection,
      handleToggleSelectAllRows,
      startEditingCell,
      commitEditingCell,
      cancelEditingCell,
      structureStatus,
      allVisibleRowsSelected,
      isBooleanColumn,
      handleCopyValue,
      setSelectedCell,
      foreignKeys,
      lookupValuesCache,
      onLoadLookupValues: handleLoadLookupValues,
      connectionId,
      onOpenRowInspector: handleOpenRowInspector,
      onColumnAutoFit: handleColumnAutoFit,
      onContextMenu: handleContextMenu,
      columnSizes,
      multiSort,
      nullPlaceholder: settings.nullPlaceholder,
      dateFormat,
      dbType,
      columnDisplayFormats,
      maskedColumnNames: columnMasks.maskedColumnNames,
      activeMaskedNames: columnMasks.activeMaskedNames,
      maskedRows: columnMasks.maskedRows,
      onToggleMaskReveal: columnMasks.toggleRevealed,
    });
  }, [
    data,
    resolvedColumns,
    canSelectRows,
    canAttemptInlineEdit,
    selectedRows,
    selectedCell,
    isCellSelected,
    editingCell,
    editingSeedValue,
    savingCell,
    sortColumn,
    sortDir,
    displayedRowIndices,
    copiedCell,
    handleSort,
    handleRowSelection,
    handleToggleSelectAllRows,
    startEditingCell,
    commitEditingCell,
    cancelEditingCell,
    structureStatus,
    allVisibleRowsSelected,
    handleCopyValue,
    setSelectedCell,
    foreignKeys,
    lookupValuesCache,
    connectionId,
    handleOpenRowInspector,
    handleColumnAutoFit,
    handleContextMenu,
    columnSizes,
    multiSort,
    settings.nullPlaceholder,
    dateFormat,
    dbType,
    columnDisplayFormats,
    columnMasks.maskedColumnNames,
    columnMasks.activeMaskedNames,
    columnMasks.maskedRows,
    columnMasks.toggleRevealed,
    getForeignKeyLookupValues,
  ]);

  const tableData = useMemo(() => displayedRows, [displayedRows]);

  const table = useReactTable({
    data: tableData,
    columns,
    getCoreRowModel: getCoreRowModel(),
    columnResizeMode: "onChange",
    state: {
      columnSizing: columnSizes,
      columnOrder,
      columnVisibility,
      columnPinning,
    },
    onColumnOrderChange: setColumnOrder,
    onColumnVisibilityChange: setColumnVisibility,
    onColumnPinningChange: (updater) => {
      setColumnPinning((prev) => {
        const next = typeof updater === "function" ? updater(prev) : updater;
        // Pin budget: pinned columns must leave a scrollable sliver, otherwise
        // the whole viewport freezes and horizontal scrolling becomes useless.
        const viewportWidth = tableWrapRef.current?.clientWidth ?? 0;
        if (viewportWidth > 0) {
          const pinnedTotal = [...(next.left ?? []), ...(next.right ?? [])].reduce(
            (total, id) => total + (table.getColumn(id)?.getSize() ?? 0),
            0,
          );
          if (pinnedTotal > viewportWidth - MIN_UNPINNED_VIEWPORT_PX) {
            emitAppToast({
              title: getDataGridPowerCopy(getCurrentAppLanguage()).pinning.limitToast,
              tone: "info",
            });
            return prev;
          }
        }
        return next;
      });
    },
    onColumnSizingChange: (updater) => {
      setColumnSizes((prev) => {
        const next = typeof updater === "function" ? updater(prev) : updater;
        // Persist each changed column width
        if (tableName) {
          for (const [colId, width] of Object.entries(next)) {
            if (prev[colId] !== width) {
              saveColumnWidth(connectionId, tableName, colId, width, database);
            }
          }
        }
        return next;
      });
    },
  });

  const estimatedRowHeight =
    settings.rowHeight === "small" ? 26 : settings.rowHeight === "large" ? 38 : 32;
  const rowVirtualizer = useVirtualizer({
    count: table.getRowModel().rows.length,
    getScrollElement: () => tableWrapRef.current,
    estimateSize: () => estimatedRowHeight,
    overscan: 12,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const virtualPaddingTop = virtualRows.length > 0 ? virtualRows[0].start : 0;
  const virtualPaddingBottom =
    virtualRows.length > 0
      ? rowVirtualizer.getTotalSize() - virtualRows[virtualRows.length - 1].end
      : 0;
  const leftPinnedColumns = table.getLeftVisibleLeafColumns();
  const virtualizableColumns = table.getCenterVisibleLeafColumns();
  const rightPinnedColumns = table.getRightVisibleLeafColumns();
  const columnVirtualizer = useVirtualizer({
    horizontal: true,
    count: virtualizableColumns.length,
    getScrollElement: () => tableWrapRef.current,
    estimateSize: (index) => virtualizableColumns[index]?.getSize() ?? 150,
    overscan: 3,
  });
  const virtualColumns = columnVirtualizer.getVirtualItems();
  const virtualPaddingLeft = virtualColumns.length > 0 ? virtualColumns[0].start : 0;
  const virtualPaddingRight =
    virtualColumns.length > 0
      ? columnVirtualizer.getTotalSize() - virtualColumns[virtualColumns.length - 1].end
      : 0;
  const pinnedWidth = [...leftPinnedColumns, ...rightPinnedColumns].reduce(
    (total, column) => total + column.getSize(),
    0,
  );
  const tableMinWidth = pinnedWidth + columnVirtualizer.getTotalSize();
  const renderedColumnCount =
    leftPinnedColumns.length +
    virtualColumns.length +
    rightPinnedColumns.length +
    Number(virtualPaddingLeft > 0) +
    Number(virtualPaddingRight > 0);
  /** Remaining pin budget in px: viewport minus already-pinned columns minus
   *  the reserved scrollable sliver. Non-positive disables further pinning. */
  const pinBudgetPx =
    (tableWrapRef.current?.clientWidth ?? 0) - pinnedWidth - MIN_UNPINNED_VIEWPORT_PX;

  useEffect(() => {
    if (!tableName || externalResult || isLoading || !hasMoreTableRows || virtualRows.length === 0)
      return;
    const lastVisibleIndex = virtualRows[virtualRows.length - 1].index;
    const lastVisibleSourceIndex = displayedRowIndices[lastVisibleIndex] ?? lastVisibleIndex;
    if (
      lastVisibleSourceIndex >=
      (data?.rows.length ?? 0) - Math.max(24, Math.ceil(PAGE_SIZE / 4))
    ) {
      setCurrentPage((page) => page + 1);
    }
  }, [
    data?.rows.length,
    displayedRowIndices,
    externalResult,
    hasMoreTableRows,
    isLoading,
    tableName,
    virtualRows,
  ]);

  const stagedChangeCount = stagedChanges.filter((c) =>
    changeScope ? changeMatchesScope(c, changeScope) : false,
  ).length;

  // Stop auto-refresh the moment the grid enters edit mode: a silent refetch
  // would clobber an in-progress cell edit or staged changes.
  useEffect(() => {
    if (autoRefreshMs > 0 && (editingCell !== null || stagedChangeCount > 0)) {
      setAutoRefreshMs(0);
      emitAppToast({
        title: getDataGridChartCopy(getCurrentAppLanguage()).autoRefresh.stoppedForEdit,
        tone: "info",
      });
    }
  }, [autoRefreshMs, editingCell, stagedChangeCount]);
  const visibleRowCount = tableData.length;
  const insertDialogModal =
    isInsertDialogOpen && typeof document !== "undefined"
      ? createPortal(
          <InsertRowDialog
            tableName={tableName}
            columns={insertDialogColumns}
            draft={insertDraft}
            error={insertDialogError}
            isSubmitting={isSubmittingInsert}
            onClose={closeInsertDialog}
            onSubmit={handleSubmitInsertDialog}
            onDraftChange={handleInsertDraftChange}
          />,
          document.body,
        )
      : null;
  // Footer pills portal into the app statusbar slot when available
  // (table workspace); fall back to the in-grid footer otherwise.
  const [footerPortalTarget, setFooterPortalTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (externalResult) {
      setFooterPortalTarget(null);
      return;
    }
    setFooterPortalTarget(document.getElementById("datagrid-footer-slot"));
  }, [externalResult]);
  if (!data && !isLoading) {
    return (
      <div className="datagrid-blank-state">
        <Copy className="w-10 h-10 mb-3 opacity-20" />
        <p className="datagrid-blank-state-copy">{t("datagrid.blankState")}</p>
      </div>
    );
  }

  const gridFooter = (
    <DataGridFooter
      data={data}
      visibleRowCount={visibleRowCount}
      totalRows={totalRows}
      clientSideOnly={filterPlan.clientSideOnly}
      tableFilter={tableFilter}
      sortColumn={sortColumn}
      sortDir={sortDir}
      multiSort={multiSort}
      dataFromCache={dataFromCache}
      isTableEditable={isTableEditable}
      structureStatus={structureStatus}
      selectedRowCount={selectedRowCount}
      language={language}
      t={t}
      tableName={tableName}
      onClearMultiSort={handleMultiSortClear}
    />
  );

  return (
    <>
      <div
        data-testid="data-grid"
        className={`datagrid-shell${externalResult ? "" : " compact"}${settings.rowHeight !== "medium" ? ` row-height-${settings.rowHeight}` : ""}${!settings.alternatingRows ? " alternating-rows-disabled" : ""}`}
      >
        <DataGridToolbar
          viewMode={viewMode}
          onViewModeChange={handleViewModeChange}
          tableName={tableName}
          database={database}
          externalResult={externalResult}
          filterValue={filterDraft}
          onFilterChange={handleFilterChange}
          selectedRowCount={selectedRowCount}
          isDeletingRows={isDeletingRows}
          handleDeleteSelectedRows={handleDeleteSelectedRows}
          handleInsertRow={handleInsertRow}
          onPasteRows={handlePasteRowsFromClipboard}
          onImportCsv={handleImportCsv}
          handleCopyAsInsert={handleCopyAsInsert}
          handleCopyAsUpdate={handleCopyAsUpdate}
          handleCopyAsInsertParam={handleCopyAsInsertParam}
          handleCopyAsUpdateParam={handleCopyAsUpdateParam}
          handleCopyAsDeleteParam={handleCopyAsDeleteParam}
          dataRows={columnMasks.hasActiveMasks ? (columnMasks.maskedRows ?? []) : tableData}
          anonymizerRows={tableData}
          isTableEditable={isTableEditable}
          canExportData={allowsDataExport}
          onReloadData={tableName && !externalResult ? handleReloadData : undefined}
          onExportFull={tableName && !externalResult ? handleFullTableExport : undefined}
          isExportingFull={isExportingFull}
          exportedRowCount={exportedRowCount}
          onCancelExport={handleCancelFullTableExport}
          isReloadingData={isReloadingData}
          canImportCsv={allowsCsvImport}
          structureStatus={structureStatus}
          resolvedColumns={resolvedColumns}
          autoRefreshMs={autoRefreshMs}
          onAutoRefreshMsChange={canAutoRefresh ? setAutoRefreshMs : undefined}
          autoRefreshTick={canAutoRefresh ? handleAutoRefreshTick : undefined}
          autoRefreshPaused={!isActive}
          autoRefreshBusy={isReloadingData || isLoading}
          undoableChanges={undoableChanges}
          stagedChangeCount={tableName ? getChangeCount(changeScope) : 0}
          onApplyChanges={openPreview}
          onDiscardChanges={discardStagedChanges}
          sortColumn={sortColumn}
          sortDir={sortDir}
          multiSort={multiSort}
          onClearMultiSort={handleMultiSortClear}
          onSortColumn={(colName) => {
            if (!colName) {
              setSortColumn(null);
              return;
            }
            handleSort(colName);
          }}
          diffResult={data}
          dbType={dbType}
          onToggleRowInspector={data && data.rows.length > 0 ? handleToggleRowInspector : undefined}
          rowInspectorOpen={rowInspectorOpen}
          maskedColumns={
            columnMasks.maskedColumnNames.size > 0 ? columnMasks.maskStrategies : undefined
          }
          onUnmaskColumn={columnMasks.unmaskColumn}
          onUnmaskAll={columnMasks.unmaskAll}
          connectionId={connectionId}
        />

        <div
          className="datagrid-table-wrap"
          ref={tableWrapRef}
          tabIndex={0}
          role="grid"
          aria-label={
            tableName
              ? getDataGridCopy(language).grid.ariaLabelTable(tableName)
              : getDataGridCopy(language).grid.ariaLabelResult
          }
        >
          {isPageClamped && (
            <div className="datagrid-query-result-notice">{t("datagrid.partialResultBanner")}</div>
          )}

          {isLoading && (
            <div className="datagrid-loading-overlay">
              <div className="datagrid-loading-card">
                <Loader2 className="!w-4 !h-4 animate-spin text-[var(--accent)]" />
                <span className="text-xs text-[var(--text-secondary)]">
                  {t("datagrid.loadingData")}
                </span>
              </div>
            </div>
          )}

          {viewMode === "chart" ? (
            <div className="datachart-view-wrap">
              <Suspense
                fallback={
                  <div className="datachart-loading">
                    <Loader2 className="w-5 h-5 animate-spin" />{" "}
                    {getDataGridCopy(language).grid.loadingChart}
                  </div>
                }
              >
                <DataChart resolvedColumns={resolvedColumns} queryResult={data} />
              </Suspense>
            </div>
          ) : (
            <DataGridTableView
              table={table}
              tableMinWidth={tableMinWidth}
              renderedColumnCount={renderedColumnCount}
              leftPinnedColumns={leftPinnedColumns}
              virtualizableColumns={virtualizableColumns}
              rightPinnedColumns={rightPinnedColumns}
              virtualColumns={virtualColumns}
              virtualRows={virtualRows}
              virtualPaddingTop={virtualPaddingTop}
              virtualPaddingBottom={virtualPaddingBottom}
              virtualPaddingLeft={virtualPaddingLeft}
              virtualPaddingRight={virtualPaddingRight}
              columnSizes={columnSizes}
              displayedRowIndices={displayedRowIndices}
              selectedRows={selectedRows}
              stagedRowIndices={stagedRowIndices}
              dragSourceIndex={dragSourceIndex}
              dropTargetIndex={dropTargetIndex}
              isTableEditable={isTableEditable}
              orderColumn={orderColumn}
              t={t}
              onContextMenu={handleContextMenu}
              onColumnAutoFit={handleColumnAutoFit}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              onDragEnd={handleDragEnd}
            />
          )}
          {data && data.rows.length === 0 && (
            <div className="datagrid-empty">{getDataGridCopy(language).grid.noRows}</div>
          )}
          {!externalResult &&
            (footerPortalTarget ? createPortal(gridFooter, footerPortalTarget) : gridFooter)}
        </div>

        <DataGridOverlays
          connectionId={connectionId}
          database={database}
          columnMasks={columnMasks}
          tableName={tableName}
          externalResult={externalResult}
          dbType={dbType}
          data={data}
          resolvedColumns={resolvedColumns}
          table={table}
          selectedRows={selectedRows}
          columnDisplayFormats={columnDisplayFormats}
          pinBudgetPx={pinBudgetPx}
          isLoading={isLoading}
          stagedChangeCount={stagedChangeCount}
          canAttemptInlineEdit={canAttemptInlineEdit}
          selectedRangeCellCount={selectedRangeCellCount}
          contextMenu={contextMenu}
          fkPreview={fkPreview}
          fkPreviewData={fkPreviewData}
          isLoadingFkPreview={isLoadingFkPreview}
          columnStats={columnStats}
          columnStatsError={columnStatsError}
          isLoadingColumnStats={isLoadingColumnStats}
          setRangeDialog={setRangeDialog}
          isPasteDialogOpen={isPasteDialogOpen}
          pastePreview={pastePreview}
          pasteSourceLabel={pasteSourceLabel}
          csvFileSelection={csvFileSelection}
          isSubmittingPaste={isSubmittingPaste}
          isCancellingPaste={isCancellingPaste}
          csvImportProgress={csvImportProgress}
          onCloseContextMenu={() => setContextMenu(null)}
          onColumnStats={handleColumnStats}
          onSortAsc={handleSortAsc}
          onSortDesc={handleSortDesc}
          onInsertRow={handleInsertRow}
          onDuplicateRowByIndex={handleDuplicateRowByIndex}
          onOpenRowInspector={handleOpenRowInspector}
          onColumnAutoFit={handleColumnAutoFit}
          onSetRangeValue={handleOpenSetRangeDialog}
          setColumnOrder={setColumnOrder}
          setColumnPinning={setColumnPinning}
          setColumnSizes={setColumnSizes}
          setColumnVisibility={setColumnVisibility}
          setFilterDraft={setFilterDraft}
          setTableFilter={setTableFilter}
          setSortColumn={setSortColumn}
          setSortDir={setSortDir}
          setColumnDisplayFormats={setColumnDisplayFormats}
          onCloseFkPreview={() => setFkPreview(null)}
          onCloseColumnStats={() => setColumnStats(null)}
          onCloseSetRangeDialog={() =>
            setSetRangeDialog((previous) => ({ ...previous, open: false }))
          }
          onSetRangeSubmit={handleRangeSetValue}
          onSetRangeError={(message) =>
            setSetRangeDialog((previous) => ({ ...previous, error: message }))
          }
          onApplyStagedChanges={applyStagedChanges}
          onDiscardStagedChanges={discardStagedChanges}
          onClosePasteDialog={closePasteDialog}
          onSubmitPasteDialog={() => void handleSubmitPasteDialog()}
          onCancelPasteImport={() => void handleCancelPasteImport()}
        />
      </div>
      {insertDialogModal}
    </>
  );
}
