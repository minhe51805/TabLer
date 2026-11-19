import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { useReactTable, getCoreRowModel, type ColumnDef } from "@tanstack/react-table";
import { useI18n } from "../../i18n";
import { Copy, Loader2 } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useDataGridSettings } from "../../stores/datagrid-settings-store";
import {
  useChangeTrackingStore,
  changeScopeKey,
  changeMatchesScope,
  type ScopedStagedChange,
} from "../../stores/change-tracking-store";
import { useConnectionStore } from "../../stores/connectionStore";
import { useGlobalErrorStore } from "../../stores/globalErrorStore";
import { useQueryStore } from "../../stores/queryStore";
import type { PastePreview } from "../../utils/clipboard-parser";
import type { ColumnDetail, ConnectionConfig, QueryResult, TableRowFocus } from "../../types";
import { lazy, Suspense } from "react";
import "./DataChart.css";
import { getDataGridCopy } from "./datagrid-copy";

const DataChart = lazy(() => import("./DataChart").then((m) => ({ default: m.DataChart })));
import {
  invalidateTableCaches,
  inlineStructureCacheRef,
  isBooleanColumn,
  type GridCellValue,
  type StructureStatus,
} from "./hooks/useDataGrid";
import { getColumnLayout } from "../../stores/column-layout-store";
import { useDateFormatStore } from "../../stores/dateFormatStore";
import {
  createEmptyGridSelection,
  selectGridCell,
  type GridSelectionModifiers,
} from "./grid-selection";
import { useConnectionCapabilities } from "../../hooks/useConnectionCapabilities";
import { isCapabilitySupported } from "../../types";

import { DataGridToolbar } from "./DataGridToolbar";
import { buildDataGridColumns } from "./DataGridColumns";
import { DataGridStoreProvider, createDataGridStore } from "./store/dataGridStore";
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
import { useDataGridAutoRefreshController } from "./hooks/useDataGridAutoRefresh";
import { useDataGridColumnLayout } from "./hooks/useDataGridColumnLayout";
import { useDataGridInspectorAndPopovers } from "./hooks/useDataGridInspectorAndPopovers";
import { useDataGridKeyboardNav } from "./hooks/useDataGridKeyboardNav";
import { useDataGridViewProjection } from "./hooks/useDataGridViewProjection";
import { useDataGridImportExportEvents } from "./hooks/useDataGridImportExportEvents";
import { useDataGridVirtualization } from "./hooks/useDataGridVirtualization";
import { DataGridOverlays } from "./DataGridOverlays";
import { DataGridTableView } from "./DataGridTableView";
import { DataGridFooter } from "./DataGridFooter";

const EMPTY_STAGED_CHANGES: ScopedStagedChange[] = [];
const EMPTY_GRID_ROWS: GridCellValue[][] = [];

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

  const [dataGridStore] = useState(createDataGridStore);
  const { setEditingCell, setEditingSeedValue, setSavingCell, setCopiedCell } =
    dataGridStore.getState();
  const getEditingCell = useCallback(() => dataGridStore.getState().editingCell, [dataGridStore]);
  const getGridSelection = useCallback(
    () => dataGridStore.getState().gridSelection,
    [dataGridStore],
  );

  /** Scope key for this grid's staged-change queue (connection|db|table). */
  const changeScope = tableName ? changeScopeKey(connectionId, database, tableName) : "";

  const stagedChanges = useChangeTrackingStore(
    useShallow((state) =>
      changeScope
        ? state.stagedChanges.filter((c) => changeMatchesScope(c, changeScope))
        : EMPTY_STAGED_CHANGES,
    ),
  );
  const stagedChangeCount = stagedChanges.length;
  const undoableChanges = useChangeTrackingStore((state) =>
    changeScope ? (state.history[changeScope]?.length ?? 0) : 0,
  );
  const redoableChanges = useChangeTrackingStore((state) =>
    changeScope ? (state.future[changeScope]?.length ?? 0) : 0,
  );
  const {
    stageChange,
    stageChanges,
    unstageChanges,
    undoLast,
    openPreview,
    closePreview,
    redoLast,
    setColumnNameMap,
    setDbType,
  } = useChangeTrackingStore(
    useShallow((state) => ({
      stageChange: state.stageChange,
      stageChanges: state.stageChanges,
      unstageChanges: state.unstageChanges,
      undoLast: state.undoLast,
      openPreview: state.openPreview,
      closePreview: state.closePreview,
      redoLast: state.redoLast,
      setColumnNameMap: state.setColumnNameMap,
      setDbType: state.setDbType,
    })),
  );

  const initialColumnLayoutRef = useRef(getColumnLayout(connectionId, tableName ?? "", database));
  const [data, setData] = useState<QueryResult | null>(externalResult || null);
  const [structureColumns, setStructureColumns] = useState<ColumnDetail[]>([]);
  const [foreignKeys, setForeignKeys] = useState<import("../../types").ForeignKeyInfo[]>([]);
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
  const [isDeletingRows, setIsDeletingRows] = useState(false);
  const [isInsertDialogOpen, setIsInsertDialogOpen] = useState(false);
  const [insertDialogColumns, setInsertDialogColumns] = useState<ColumnDetail[]>([]);
  const [insertDialogBaseValues, setInsertDialogBaseValues] = useState<[string, unknown][]>([]);
  const [insertDraft, setInsertDraft] = useState<Record<string, string>>({});
  const [insertDialogError, setInsertDialogError] = useState<string | null>(null);
  const [isSubmittingInsert, setIsSubmittingInsert] = useState(false);
  /** When true the insert dialog stages a queued insert (duplicate-row flow). */
  const [insertDialogStages, setInsertDialogStages] = useState(false);
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
  const [viewMode, setViewMode] = useState<"table" | "chart">(initialViewMode);
  /** Row drag-and-drop state */
  const [dragSourceIndex, setDragSourceIndex] = useState<number | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
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
  const pendingDataRefreshRef = useRef(false);
  const loadedTablePagesRef = useRef(new Map<number, QueryResult>());

  const {
    rowFocusFilter,
    filterPlan,
    filteredTableRowIndices,
    displayedRows,
    displayedRowIndices,
    resolvedColumns,
    primaryKeyColumns,
    rowIdentities,
    selectedRows,
    setSelectedRows,
    isTableEditable,
    canAttemptInlineEdit,
    canSelectRows,
    selectedRowCount,
    tableData,
    isPageClamped,
  } = useDataGridViewProjection({
    connectionId,
    database,
    tableName,
    externalResult,
    data,
    structureColumns,
    structureStatus,
    connections,
    tableFilter,
    sortColumn,
    sortDir,
    rowFocus,
    allowsInlineEdit,
    allowsAtomicEdits,
    dataGridStore,
    columnNamesRef,
    rowSelectionAnchorRef,
  });

  const setSelectedCell = useCallback(
    (cell: { row: number; col: number } | null, modifiers: GridSelectionModifiers = {}) => {
      const { setGridSelection } = dataGridStore.getState();
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
    [
      data?.columns.length,
      dataGridStore,
      displayedRowIndices,
      displayedRows.length,
      structureColumns.length,
    ],
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

  const {
    columnSizes,
    setColumnSizes,
    columnOrder,
    setColumnOrder,
    columnVisibility,
    setColumnVisibility,
    columnPinning,
    setColumnPinning,
    columnDisplayFormats,
    setColumnDisplayFormats,
    orderColumn,
    restorePersistedColumnLayout,
    handleColumnAutoFit,
    handleColumnPinningChange,
    handleColumnSizingChange,
  } = useDataGridColumnLayout({
    connectionId,
    tableName,
    database,
    externalResult,
    structureColumns,
    sortColumn,
    sortDir,
    filterDraft,
    tableWrapRef,
    columnNamesRef,
  });

  const {
    patchLoadedTableCell,
    fetchData,
    refreshTableFromStart,
    ensureStructureLoaded,
    isReloadingData,
    handleReloadData,
  } = useDataGridTableFetcher({
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
    data,
    currentPage,
    rowFocusToken: rowFocus?.token,
    restorePersistedColumnLayout,
    setFilterDraft,
    setTableFilter,
    setSortColumn,
    setSortDir,
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

  const { autoRefreshMs, setAutoRefreshMs, canAutoRefresh, handleAutoRefreshTick } =
    useDataGridAutoRefreshController({
      tableName,
      externalResult,
      connectionId,
      refreshTableFromStart,
      isMountedRef,
      setData,
      setTotalRows,
      dataGridStore,
      stagedChangeCount,
    });

  useEffect(() => {
    if (filterDraft === tableFilter) return;
    const timeoutId = window.setTimeout(() => {
      setTableFilter(filterDraft);
    }, 250);
    return () => window.clearTimeout(timeoutId);
  }, [filterDraft, tableFilter]);

  // View-time column masking (A4): persisted per connection+table, masked
  // matrix precomputed over the displayed window. Reveal is session-only.
  const columnMasks = useDataGridColumnMasks(
    connectionId,
    database,
    tableName,
    resolvedColumns,
    displayedRows,
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

  const { handlePasteRowsFromClipboard, handleImportCsv } = useDataGridImportExportEvents({
    connectionId,
    tableName,
    database,
    externalResult,
    isActive,
    currentPage,
    resolvedColumns,
    fetchData,
    setError,
    setCsvImportProgress,
    setExportedRowCount,
    setPastePreview,
    setCsvFileSelection,
    setPasteSourceLabel,
    setIsPasteDialogOpen,
    refs: {
      csvImportOperationIdRef,
      tableExportOperationIdRef,
      isMountedRef,
      isActiveRef,
      requestIdRef,
      structureRequestIdRef,
      structurePromiseRef,
      structureRetryAttemptRef,
      structureRetryTimeoutRef,
      countTimeoutRef,
      pendingDataRefreshRef,
      dataGridInstanceIdRef,
    },
  });

  useEffect(() => {
    setEditingCell(null);
    setEditingSeedValue("");
    editingDraftRef.current = "";
    editingTouchedRef.current = false;
    setSavingCell(null);
  }, [
    tableName,
    currentPage,
    sortColumn,
    sortDir,
    externalResult,
    setEditingCell,
    setEditingSeedValue,
    setSavingCell,
  ]);

  // Reset multi-sort when switching tables
  useEffect(() => {
    setMultiSort([]);
  }, [tableName, connectionId, database]);

  // Reset view mode when switching data source
  useEffect(() => {
    setViewMode("table");
  }, [tableName, connectionId, database, externalResult]);

  const handleUndo = useCallback(() => {
    if (!changeScope || undoableChanges === 0) return;
    const nextChanges = undoLast(changeScope);
    if (nextChanges) reconcileStagedChanges(nextChanges);
  }, [changeScope, reconcileStagedChanges, undoLast, undoableChanges]);

  const handleRedo = useCallback(() => {
    if (!changeScope || redoableChanges === 0) return;
    const nextChanges = redoLast(changeScope);
    if (nextChanges) reconcileStagedChanges(nextChanges);
  }, [changeScope, reconcileStagedChanges, redoLast, redoableChanges]);

  const handleOpenChangePreview = useCallback(() => {
    if (changeScope) openPreview(changeScope);
  }, [changeScope, openPreview]);

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

  const handleCopyValue = useCallback(
    (value: GridCellValue, cellKey: string) => {
      navigator.clipboard.writeText(value === null ? "NULL" : String(value));
      setCopiedCell(cellKey);
      setTimeout(() => setCopiedCell(null), 1200);
    },
    [setCopiedCell],
  );

  const { startEditingCell, cancelEditingCell, commitEditingCell, editCellFromInspector } =
    useDataGridInlineEditing({
      canAttemptInlineEdit,
      connectionId,
      data,
      tableName,
      database: database || undefined,
      resolvedColumns,
      primaryKeyColumns,
      structureStatus,
      getEditingCell,
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
  } = useDataGridInspectorAndPopovers({
    connectionId,
    database: database || undefined,
    tableName,
    externalResult,
    isActive,
    isTableEditable,
    data,
    resolvedColumns,
    primaryKeyColumns,
    foreignKeys,
    displayedRowsLength: displayedRows.length,
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
  });

  const {
    handleRangeCopy,
    handleRangePaste,
    handleRangeDelete,
    handleRangeFillDown,
    handleRangeSetValue,
  } = useDataGridRangeOperations({
    getGridSelection,
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

  useDataGridKeyboardNav({
    viewMode,
    isActive,
    tableName,
    externalResult,
    tableWrapRef,
    dataColumnsLength: data?.columns.length ?? 0,
    displayedRowsLength: displayedRows.length,
    structureColumnsLength: structureColumns.length,
    dataGridStore,
    handleRangeCopy,
    handleRangePaste,
    handleRangeDelete,
    handleRangeFillDown,
    handlePasteRowsFromClipboard,
    handleDuplicateRow,
    handleUndo,
    handleRedo,
    isInsertDialogOpen,
    closeInsertDialog,
    isPasteDialogOpen,
    closePasteDialog,
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
    closeInsertDialog();
  }, [closeInsertDialog, connectionId, database, tableName]);

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

  // Derive dbType and date format for date cell formatting
  const { t, language } = useI18n();
  const connection = connections.find((c: ConnectionConfig) => c.id === connectionId);
  const dbType = connection?.db_type;
  const dateFormat = useDateFormatStore((s) => s.getFormat(connectionId, dbType));

  const hasData = Boolean(data);
  const columns = useMemo<ColumnDef<unknown[], unknown>[]>(() => {
    if (!hasData || resolvedColumns.length === 0) return [];

    return buildDataGridColumns({
      resolvedColumns,
      canSelectRows,
      canAttemptInlineEdit,
      sortColumn,
      sortDir,
      rowOffset: 0,
      rowIndexMap: displayedRowIndices,
      editingDraftRef,
      editingTouchedRef,
      handleSort,
      handleRowSelection,
      handleToggleSelectAllRows,
      startEditingCell,
      commitEditingCell,
      cancelEditingCell,
      structureStatus,
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
    hasData,
    resolvedColumns,
    canSelectRows,
    canAttemptInlineEdit,
    sortColumn,
    sortDir,
    displayedRowIndices,
    handleSort,
    handleRowSelection,
    handleToggleSelectAllRows,
    startEditingCell,
    commitEditingCell,
    cancelEditingCell,
    structureStatus,
    handleCopyValue,
    setSelectedCell,
    foreignKeys,
    lookupValuesCache,
    handleLoadLookupValues,
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
  ]);

  // eslint-disable-next-line react-hooks/incompatible-library
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
    onColumnPinningChange: (updater) =>
      handleColumnPinningChange(updater, (id) => table.getColumn(id)?.getSize() ?? 0),
    onColumnSizingChange: handleColumnSizingChange,
  });

  const {
    virtualRows,
    virtualPaddingTop,
    virtualPaddingBottom,
    leftPinnedColumns,
    virtualizableColumns,
    rightPinnedColumns,
    virtualColumns,
    virtualPaddingLeft,
    virtualPaddingRight,
    tableMinWidth,
    renderedColumnCount,
    pinBudgetPx,
    footerPortalTarget,
  } = useDataGridVirtualization({
    table,
    tableWrapRef,
    rowHeight: settings.rowHeight,
    tableName,
    externalResult,
    isLoading,
    hasMoreTableRows,
    displayedRowIndices,
    dataRowsLength: data?.rows.length ?? 0,
    setCurrentPage,
  });

  const handleToolbarSortColumn = useCallback(
    (colName: string) => {
      if (!colName) {
        setSortColumn(null);
        return;
      }
      handleSort(colName);
    },
    [handleSort],
  );

  const visibleRowCount = tableData.length;
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
    <DataGridStoreProvider store={dataGridStore}>
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
          dataRows={
            columnMasks.hasActiveMasks ? (columnMasks.maskedRows ?? EMPTY_GRID_ROWS) : tableData
          }
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
          redoableChanges={redoableChanges}
          onUndo={handleUndo}
          onRedo={handleRedo}
          stagedChangeCount={stagedChangeCount}
          onApplyChanges={handleOpenChangePreview}
          onDiscardChanges={discardStagedChanges}
          sortColumn={sortColumn}
          sortDir={sortDir}
          multiSort={multiSort}
          onClearMultiSort={handleMultiSortClear}
          onSortColumn={handleToolbarSortColumn}
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
          role="region"
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
              ariaLabel={
                tableName
                  ? getDataGridCopy(language).grid.ariaLabelTable(tableName)
                  : getDataGridCopy(language).grid.ariaLabelResult
              }
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
          onCloseColumnStats={handleCloseColumnStats}
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
          isInsertDialogOpen={isInsertDialogOpen}
          insertDialogColumns={insertDialogColumns}
          insertDraft={insertDraft}
          insertDialogError={insertDialogError}
          isSubmittingInsert={isSubmittingInsert}
          onCloseInsertDialog={closeInsertDialog}
          onSubmitInsertDialog={handleSubmitInsertDialog}
          onInsertDraftChange={handleInsertDraftChange}
        />
      </div>
    </DataGridStoreProvider>
  );
}
