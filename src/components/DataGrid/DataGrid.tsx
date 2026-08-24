import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  type ColumnDef,
  type ColumnOrderState,
  type VisibilityState,
  type ColumnPinningState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Copy, Loader2, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useDataGridSettings } from "../../stores/datagrid-settings-store";
import { useChangeTrackingStore } from "../../stores/change-tracking-store";
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
import { lazy, Suspense } from "react";
import "./DataChart.css";

const DataChart = lazy(() => import("./DataChart").then((m) => ({ default: m.DataChart })));
import {
  PAGE_SIZE,
  invalidateTableScopeCaches,
  invalidateTableCaches,
  inlineStructureCacheRef,
  buildColumnSignature,
  buildResolvedColumns,
  isBooleanColumn,
  buildRowPrimaryKeys,
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
import { buildStableRowIdentity } from "./row-identity";
import { useConnectionCapabilities } from "../../hooks/useConnectionCapabilities";
import { isCapabilitySupported } from "../../types";

import { DataGridToolbar } from "./DataGridToolbar";
import { ChangeTrackingPreviewModal } from "./components/ChangeTrackingPreviewModal";
import { buildDataGridColumns, editingDraftRef } from "./DataGridColumns";
import { useDataGridCopySqlActions } from "./hooks/useDataGridCopySqlActions";
import { useDataGridInlineEditing } from "./hooks/useDataGridInlineEditing";
import { useDataGridStagedChanges } from "./hooks/useDataGridStagedChanges";
import { useDataGridSortFilter } from "./hooks/useDataGridSortFilter";
import { useDataGridRowSelection } from "./hooks/useDataGridRowSelection";
import { useDataGridDragReorder } from "./hooks/useDataGridDragReorder";
import { useDataGridTableFetcher } from "./hooks/useDataGridTableFetcher";
import { useDataGridRowMutations } from "./hooks/useDataGridRowMutations";
import { useDataGridTableExport } from "./hooks/useDataGridTableExport";
import { PasteRowsDialog } from "./dialogs/PasteRowsDialog";
import { buildRowFocusFilter } from "./row-focus";
import { InsertRowDialog } from "./dialogs/InsertRowDialog";
import { FkPreviewPopover } from "./dialogs/FkPreviewPopover";
import { DataGridContextMenu } from "./dialogs/DataGridContextMenu";
import type { ColumnDisplayFormat } from "./editors";

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
  const connections = useConnectionStore(
    (state) => state.connections as ConnectionConfig[],
  );
  const capabilityProfile = useConnectionCapabilities(connectionId);
  const allowsInlineEdit = isCapabilitySupported(capabilityProfile?.capabilities.inlineEdit);
  const allowsAtomicEdits = isCapabilitySupported(capabilityProfile?.capabilities.atomicEditQueue);
  const allowsCsvImport = isCapabilitySupported(capabilityProfile?.capabilities.atomicCsvImport);
  const allowsDataExport = isCapabilitySupported(capabilityProfile?.capabilities.dataExport);
  const initialColumnLayoutRef = useRef(getColumnLayout(connectionId, tableName ?? "", database));

  const {
    stagedChanges,
    stageChange,
    unstageChange,
    undoLast,
    redoLast,
    setColumnNameMap,
    setDbType,
    getChangeCount,
    history,
    future,
  } = useChangeTrackingStore();

  const [data, setData] = useState<QueryResult | null>(externalResult || null);
  const [structureColumns, setStructureColumns] = useState<ColumnDetail[]>([]);
  const [foreignKeys, setForeignKeys] = useState<import("../../types").ForeignKeyInfo[]>([]);
  const [lookupValuesCache, setLookupValuesCache] = useState<Map<string, Array<{ value: string | number; label: string }>>>(new Map());
  const [totalRows, setTotalRows] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);
  const [hasMoreTableRows, setHasMoreTableRows] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [structureStatus, setStructureStatus] = useState<StructureStatus>(
    externalResult ? "ready" : "idle",
  );
  const [sortColumn, setSortColumn] = useState<string | null>(initialColumnLayoutRef.current.sort?.column ?? null);
  const [sortDir, setSortDir] = useState<"ASC" | "DESC">(initialColumnLayoutRef.current.sort?.direction ?? "ASC");
  const [filterDraft, setFilterDraft] = useState(initialColumnLayoutRef.current.filter);
  const [tableFilter, setTableFilter] = useState(initialColumnLayoutRef.current.filter);
  /** Multi-column sort: array of {column, direction, priority}. Priority 1 = highest. */
  const [multiSort, setMultiSort] = useState<Array<{ column: string; direction: "ASC" | "DESC"; priority: number }>>([]);
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
  const [fkPreview, setFkPreview] = useState<{ table: string; column: string; value: string | number | boolean; rowIndex: number; colIndex: number } | null>(null);
  const [fkPreviewData, setFkPreviewData] = useState<import("../../types").QueryResult | null>(null);
  const [isLoadingFkPreview, setIsLoadingFkPreview] = useState(false);
  const [viewMode, setViewMode] = useState<"table" | "chart">(initialViewMode);
  const [columnSizes, setColumnSizes] = useState<Record<string, number>>(() =>
    getColumnWidths(connectionId, tableName ?? "", database),
  );
  const [columnOrder, setColumnOrder] = useState<ColumnOrderState>(initialColumnLayoutRef.current.order);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(initialColumnLayoutRef.current.visibility);
  const [columnPinning, setColumnPinning] = useState<ColumnPinningState>(initialColumnLayoutRef.current.pinning);
  const rowFocusFilter = useMemo(() => buildRowFocusFilter(rowFocus), [rowFocus]);
  const [columnDisplayFormats, setColumnDisplayFormats] = useState<Record<string, ColumnDisplayFormat>>({});
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; type: "cell" | "header" | "row"; colName?: string; rowIndex?: number } | null>(null);
  /** Row drag-and-drop state */
  const [dragSourceIndex, setDragSourceIndex] = useState<number | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  const [orderColumn, setOrderColumn] = useState<string | null>(null);
  const columnNamesRef = useRef<string[]>([]);
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
  const editorRef = useRef<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null>(null);
  const rowSelectionAnchorRef = useRef<string | null>(null);
  const dataGridInstanceIdRef = useRef(`datagrid-${Math.random().toString(36).slice(2)}`);
  const csvImportOperationIdRef = useRef<string | null>(null);
  const tableExportOperationIdRef = useRef<string | null>(null);
  const loadedTablePagesRef = useRef(new Map<number, QueryResult>());
  const assignInputRef = useCallback((element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null) => {
    editorRef.current = element;
  }, []);


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
    }).then((cleanup) => { unlisten = cleanup; }).catch(() => {
      // Browser-only tests and previews do not expose Tauri's event bridge.
    });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    void listen<{ operationId: string; exportedRows: number }>(
      "table-export-progress",
      (event) => {
        if (event.payload.operationId !== tableExportOperationIdRef.current) return;
        setExportedRowCount(event.payload.exportedRows);
      },
    ).then((cleanup) => { unlisten = cleanup; }).catch(() => {
      // Browser-only tests and previews do not expose Tauri's event bridge.
    });
    return () => unlisten?.();
  }, []);

  const setSelectedCell = useCallback((
    cell: { row: number; col: number } | null,
    modifiers: GridSelectionModifiers = {},
  ) => {
    if (!cell) {
      setGridSelection(createEmptyGridSelection());
      return;
    }
    tableWrapRef.current?.focus({ preventScroll: true });
    setGridSelection((previous) => selectGridCell(
      previous,
      cell,
      {
        rowCount: data?.rows.length ?? 0,
        columnCount: structureColumns.length || data?.columns.length || 0,
      },
      modifiers,
    ));
  }, [data?.columns.length, data?.rows.length, structureColumns.length]);

  const isCellSelected = useCallback(
    (row: number, col: number) => isGridCellSelected(gridSelection, { row, col }),
    [gridSelection],
  );

  useEffect(() => {
    setViewMode(initialViewMode);
  }, [initialViewMode]);

  const handleViewModeChange = useCallback((mode: "table" | "chart") => {
    setViewMode(mode);
    onViewModeChange?.(mode);
  }, [onViewModeChange]);

  useEffect(() => {
    const element = tableWrapRef.current;
    if (!element || viewMode !== "table") return;

    const handleGridKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;

      const bounds = {
        rowCount: data?.rows.length ?? 0,
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
  }, [data?.columns.length, data?.rows.length, structureColumns.length, viewMode]);

  const {
    patchLoadedTableCell,
    fetchData,
    refreshTableFromStart,
    ensureStructureLoaded,
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
  const undoableChanges = history.length;
  const redoableChanges = future.length;


  useEffect(() => {
    if (externalResult) {
      setData(externalResult);
      loadedTablePagesRef.current.clear();
      setStructureColumns([]);
      setTotalRows(externalResult.rows.length);
      setIsLoading(false);
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
      saveColumnLayout(connectionId, tableName, {
        order: columnOrder,
        visibility: columnVisibility,
        pinning: {
          left: columnPinning.left ?? [],
          right: columnPinning.right ?? [],
        },
        sort: sortColumn ? { column: sortColumn, direction: sortDir } : null,
        filter: filterDraft,
      }, database);
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
  const dataColumnSignature = useMemo(() => buildColumnSignature(dataColumns), [dataColumns]);
  const structureColumnSignature = useMemo(
    () => buildColumnSignature(structureColumns),
    [structureColumns],
  );

  const resolvedColumns = useMemo<ResolvedColumn[]>(() => {
    if (dataColumns.length === 0) return [];
    const cols = buildResolvedColumns(dataColumns, structureColumns);
    columnNamesRef.current = cols.map((c) => c.name);
    return cols;
  }, [dataColumnSignature, structureColumnSignature]);

  const primaryKeyColumns = useMemo(
    () => resolvedColumns.filter((column) => column.is_primary_key),
    [resolvedColumns],
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
  const setSelectedRows = useCallback((
    update: Set<number> | ((previous: Set<number>) => Set<number>),
  ) => {
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
  }, [rowIdentities]);

  const {
    reconcileStagedChanges,
    applyStagedChanges,
    discardStagedChanges,
  } = useDataGridStagedChanges({
    stagedChanges,
    tableName,
    database: database || undefined,
    connectionId,
    resolvedColumns,
    setData,
    setStagedRowIndices,
    setIsLoading,
    setError,
    unstageChange,
    applyTableUpdatesAtomically,
    invalidateTableCaches,
    refreshTableFromStart,
    dataGridInstanceIdRef,
  });

  useEffect(() => {
    if (!rowFocus || !data?.rows.length || externalResult) return;
    setSelectedRows(new Set([0]));
  }, [data, externalResult, rowFocus, setSelectedRows]);
;

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

  // Detect order/sort column on structure load
  useEffect(() => {
    if (structureColumns.length === 0) return;
    const ORDER_COLUMN_NAMES = [
      "row_order", "sort_order", "sort_index", "position", "seq", "sequence",
      "rank", "priority", "display_order", "display_order", "item_order",
      "order_index", "ordering", "sort_pos", "row_no", "rownum", "ord",
    ];
    const found = structureColumns.find((col) => {
      const n = col.name.toLowerCase();
      return ORDER_COLUMN_NAMES.some((on) => n.includes(on));
    });
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
      }
    };
  }, []);

  useEffect(() => {
    const handleStructureUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{
        connectionId: string;
        tableName: string;
        database?: string;
      }>).detail;

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
      const detail = (event as CustomEvent<{
        connectionId: string;
        database?: string;
        tableName?: string;
        invalidateStructure?: boolean;
        sourceId?: string;
      }>).detail;

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

      if (!tableName || externalResult || !isActiveRef.current) return;
      if (detail.tableName && detail.tableName !== tableName) return;
      if (detail.sourceId === dataGridInstanceIdRef.current) return;

      void fetchData(currentPage);
    };

    window.addEventListener("table-data-updated", handleTableDataUpdated);
    return () => {
      window.removeEventListener("table-data-updated", handleTableDataUpdated);
    };
  }, [connectionId, currentPage, database, externalResult, fetchData, tableName]);

  useEffect(() => {
    setEditingCell(null);
    setEditingSeedValue("");
    editingDraftRef.current = "";
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
  useEffect(() => {
    if (!editingCell) return;

    const rafId = window.requestAnimationFrame(() => {
      const element = editorRef.current;
      if (!element) return;
      element.focus();
      if ("select" in element) {
        element.select();
      }
    });

    return () => window.cancelAnimationFrame(rafId);
  }, [editingCell]);

  // Listen for global undo/redo commands from AppKeyboardHandler
  useEffect(() => {
    if (!isActive) return;

    const handleUndo = () => {
      if (undoableChanges === 0) return;
      const nextChanges = undoLast();
      if (nextChanges) reconcileStagedChanges(nextChanges);
    };

    const handleRedo = () => {
      if (redoableChanges === 0) return;
      const nextChanges = redoLast();
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
      const { row: rowIdx, col: colIdx } = selectedCell;
      const col = resolvedColumns[colIdx];
      if (!col) return;
      const fkInfo = foreignKeys.find((fk) => fk.column === col.name);
      if (!fkInfo) return;
      const cellValue = data.rows[rowIdx]?.[colIdx];
      if (cellValue === null || cellValue === undefined) return;
      const valueStr = typeof cellValue === "string" ? `'${cellValue.replace(/'/g, "''")}'` : String(cellValue);
      const filter = `${fkInfo.referenced_column} = ${valueStr}`;
      setFkPreview({ table: fkInfo.referenced_table, column: fkInfo.referenced_column, value: cellValue, rowIndex: rowIdx, colIndex: colIdx });
      setFkPreviewData(null);
      setIsLoadingFkPreview(true);
      void getTableData(connectionId, fkInfo.referenced_table, { database, limit: 5, filter })
        .then((result) => { setFkPreviewData(result); })
        .catch((err) => { console.warn("[FK Preview] failed to load:", err); })
        .finally(() => { setIsLoadingFkPreview(false); });
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
  const {
    handleSort,
    handleFilterChange,
    handleMultiSortClear,
    handleSortAsc,
    handleSortDesc,
  } = useDataGridSortFilter({
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
  const handleColumnAutoFit = useCallback((colId: string) => {
    if (colId === "_row_num") return;
    const wrap = tableWrapRef.current;
    if (!wrap) return;

    // Find column index from ref
    const colIndex = columnNamesRef.current.indexOf(colId);
    if (colIndex < 0) return;

    // Measure header text width
    const headerEl = wrap.querySelector(`th[data-col-id="${colId}"]`);
    const headerWidth = headerEl?.textContent?.length ?? colId.length;
    const headerSize = Math.max(40, headerWidth * 8.5 + 32);

    // Measure content width from rendered cells
    let maxContentWidth = 0;
    const cellSelector = `.datagrid-row td:nth-child(${colIndex + 2})`;
    const cellEls = wrap.querySelectorAll<HTMLElement>(cellSelector);
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
  }, []);

  // Context menu handler
  const handleContextMenu = useCallback((
    e: React.MouseEvent,
    type: "cell" | "header" | "row",
    colName?: string,
    rowIndex?: number,
  ) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, type, colName, rowIndex });
  }, []);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => setContextMenu(null);
    document.addEventListener("click", handler, { once: true });
    document.addEventListener("contextmenu", handler, { once: true });
    return () => document.removeEventListener("click", handler);
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
      EventCenter.emit("row-inspector-open", {
        rowIndex: absoluteRowNumber,
        row,
        columns: resolvedColumns,
        primaryKeyValues: pkValues,
        tableName,
        database,
      });
    },
    [data, resolvedColumns, primaryKeyColumns, tableName, database],
  );

  const canAttemptInlineEdit = Boolean(
    tableName && !externalResult && allowsInlineEdit && allowsAtomicEdits,
  );
  const canSelectRows = Boolean(tableName && !externalResult && primaryKeyColumns.length > 0);
  const isTableEditable = Boolean(
    tableName
      && !externalResult
      && allowsInlineEdit
      && allowsAtomicEdits
      && structureStatus === "ready"
      && primaryKeyColumns.length > 0,
  );
  const selectedRowCount = selectedRows.size;
  const filteredTableRowIndices = useMemo(() => {
    if (!data || externalResult) return [];
    return filterRowsWithSourceIndices(data.rows, tableFilter).map(({ sourceIndex }) => sourceIndex);
  }, [data, externalResult, tableFilter]);
  const allVisibleRowsSelected = Boolean(
    canSelectRows
      && filteredTableRowIndices.length
      && filteredTableRowIndices.every((rowIndex) => selectedRows.has(rowIndex)),
  );

  const {
    startEditingCell,
    cancelEditingCell,
    commitEditingCell,
    handleEditorBlur,
  } = useDataGridInlineEditing({
    canAttemptInlineEdit,
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
    editingDraftRef,
    editorRef,
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

    invalidateTableCaches,
    refreshTableFromStart,

    dataGridInstanceIdRef,
  })
  const {
    handleDragStart,
    handleDragOver,
    handleDrop,
    handleDragEnd,
  } = useDataGridDragReorder({
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
      const preview = buildPastePreview(parsed, resolvedColumns.map((column) => column.name));
      if (preview.mappings.length === 0) throw new Error("No CSV headers match columns in the selected table.");
      setPastePreview(preview);
      setCsvFileSelection({
        filePath: file.filePath,
        delimiter: file.delimiter,
        byteSize: file.byteSize,
        isTruncated: file.isTruncated,
      });
      const sizeLabel = file.byteSize >= 1024 * 1024
        ? `${(file.byteSize / (1024 * 1024)).toFixed(1)} MB`
        : `${Math.max(1, Math.round(file.byteSize / 1024))} KB`;
      setPasteSourceLabel(`${file.fileName} (${sizeLabel}, streaming import)`);
      setIsPasteDialogOpen(true);
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
    }
  }, [resolvedColumns, setError, tableName]);



  /** Apply all staged changes to the database (commit) */
  const {
    handleRowSelection,
    handleToggleSelectAllRows,
  } = useDataGridRowSelection({
    canSelectRows,
    data,
    rowIdentities,
    filteredTableRowIndices,
    setSelectedRows,
    rowSelectionAnchorRef,
  });



  const {
    handleFullTableExport,
    handleCancelFullTableExport,
  } = useDataGridTableExport({
    tableName,
    database: database || undefined,
    connectionId,
    sortColumn,
    sortDir,
    rowFocusFilter,
    isExportingFull,
    setIsExportingFull,
    setExportedRowCount,
    setError,
    exportTableData,
    cancelTableExport,
    tableExportOperationIdRef,
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
  });

  const filteredTableRows = useMemo(() => {
    if (!data || externalResult) return [];
    return filterRowsWithSourceIndices(data.rows, tableFilter);
  }, [data, externalResult, tableFilter]);

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
  const displayedRowIndices = useMemo(
    () => externalResult ? displayedRows.map((_, index) => index) : filteredTableRows.map(({ sourceIndex }) => sourceIndex),
    [displayedRows, externalResult, filteredTableRows],
  );

  const isQueryResultTruncated = Boolean(externalResult && data?.truncated);

  // Derive dbType and date format for date cell formatting
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
      handleSort,
      handleRowSelection,
      handleToggleSelectAllRows,
      handleEditorBlur,
      startEditingCell,
      commitEditingCell,
      cancelEditingCell,
      structureStatus,
      assignInputRef,
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
    });
  }, [
    cancelEditingCell,
    canSelectRows,
    canAttemptInlineEdit,
    commitEditingCell,
    handleRowSelection,
    handleToggleSelectAllRows,
    handleEditorBlur,
    copiedCell,
    currentPage,
    data,
    editingCell,
    editingSeedValue,
    allVisibleRowsSelected,
    resolvedColumns,
    savingCell,
    selectedCell,
    setSelectedCell,
    isCellSelected,
    selectedRows,
    sortColumn,
    sortDir,
    startEditingCell,
    structureStatus,
    handleCopyValue,
    handleSort,
    foreignKeys,
    lookupValuesCache,
    getForeignKeyLookupValues,
    connectionId,
    handleOpenRowInspector,
    handleColumnAutoFit,
    handleContextMenu,
    columnSizes,
    displayedRowIndices,
    multiSort,
    settings,
    dateFormat,
    dbType,
    connections,
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
    onColumnPinningChange: setColumnPinning,
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

  const estimatedRowHeight = settings.rowHeight === "small"
    ? 26
    : settings.rowHeight === "large"
      ? 38
      : 32;
  const rowVirtualizer = useVirtualizer({
    count: table.getRowModel().rows.length,
    getScrollElement: () => tableWrapRef.current,
    estimateSize: () => estimatedRowHeight,
    overscan: 12,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const virtualPaddingTop = virtualRows.length > 0 ? virtualRows[0].start : 0;
  const virtualPaddingBottom = virtualRows.length > 0
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
  const virtualPaddingRight = virtualColumns.length > 0
    ? columnVirtualizer.getTotalSize() - virtualColumns[virtualColumns.length - 1].end
    : 0;
  const pinnedWidth = [...leftPinnedColumns, ...rightPinnedColumns]
    .reduce((total, column) => total + column.getSize(), 0);
  const tableMinWidth = pinnedWidth + columnVirtualizer.getTotalSize();
  const renderedColumnCount = leftPinnedColumns.length + virtualColumns.length + rightPinnedColumns.length
    + Number(virtualPaddingLeft > 0)
    + Number(virtualPaddingRight > 0);
  const getVirtualSpacerStyle = (width: number) => ({
    width,
    minWidth: width,
    maxWidth: width,
  });
  const pinnedColumnStyle = (column: (typeof leftPinnedColumns)[number]) => {
    const pinned = column.getIsPinned();
    if (!pinned) return undefined;
    return {
      position: "sticky" as const,
      left: pinned === "left" ? column.getStart("left") : undefined,
      right: pinned === "right" ? column.getAfter("right") : undefined,
      zIndex: 3,
      background: "var(--bg-primary)",
    };
  };

  useEffect(() => {
    if (!tableName || externalResult || isLoading || !hasMoreTableRows || virtualRows.length === 0) return;
    const lastVisibleIndex = virtualRows[virtualRows.length - 1].index;
    const lastVisibleSourceIndex = displayedRowIndices[lastVisibleIndex] ?? lastVisibleIndex;
    if (lastVisibleSourceIndex >= (data?.rows.length ?? 0) - Math.max(24, Math.ceil(PAGE_SIZE / 4))) {
      setCurrentPage((page) => page + 1);
    }
  }, [data?.rows.length, displayedRowIndices, externalResult, hasMoreTableRows, isLoading, tableName, virtualRows]);

  const stagedChangeCount = stagedChanges.filter(
    (c) => c.tableName === tableName && c.database === database,
  ).length;
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
        <p className="datagrid-blank-state-copy">Select a table or run a query</p>
      </div>
    );
  }

  const gridFooter = (
    <div className="datagrid-footer">
      <div className="datagrid-footer-meta">
        {data && (
          <>
            <span className="datagrid-footer-pill strong">
              {visibleRowCount} row{visibleRowCount !== 1 ? "s" : ""}
            </span>
            {totalRows > 0 && (
              <span className="datagrid-footer-pill">of {totalRows.toLocaleString()} total</span>
            )}
            <span
              className={`datagrid-footer-pill${sortColumn || multiSort.length > 0 ? " info" : ""}`}
              title="Row sort order"
            >
              {sortColumn
                ? `${sortColumn} ${sortDir}`
                : multiSort.length > 0
                  ? multiSort
                      .map((s) => `${s.priority}.${s.column} ${s.direction}`)
                      .join(", ")
                  : "Natural order"}
            </span>
            {multiSort.length > 0 && (
              <button
                type="button"
                className="datagrid-sort-clear-btn"
                onClick={handleMultiSortClear}
                title="Clear all sorts"
              >
                <X className="w-3! h-3!" />
              </button>
            )}
            {tableName && (
              <span className={`datagrid-footer-pill ${isTableEditable ? "info" : ""}`}>
                {isTableEditable
                  ? "Inline edit ready"
                  : structureStatus === "loading"
                    ? "Loading edit metadata..."
                    : structureStatus === "idle"
                      ? "Edit on demand"
                      : "Retry edit load"}
              </span>
            )}
            {selectedRowCount > 0 && (
              <span className="datagrid-footer-pill warning">
                {selectedRowCount} selected
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );

  return (
    <>
    <div data-testid="data-grid" className={`datagrid-shell${externalResult ? "" : " compact"}${settings.rowHeight !== "medium" ? ` row-height-${settings.rowHeight}` : ""}${!settings.alternatingRows ? " alternating-rows-disabled" : ""}`}>
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
        isTableEditable={isTableEditable}
        canExportData={allowsDataExport}
        onExportFull={tableName && !externalResult ? handleFullTableExport : undefined}
        isExportingFull={isExportingFull}
        exportedRowCount={exportedRowCount}
        onCancelExport={handleCancelFullTableExport}
        canImportCsv={allowsCsvImport}
        structureStatus={structureStatus}
        resolvedColumns={resolvedColumns}
        dataRows={tableData}
        undoableChanges={undoableChanges}
        stagedChangeCount={tableName ? getChangeCount(tableName) : 0}
        onApplyChanges={applyStagedChanges}
        onDiscardChanges={discardStagedChanges}
      />

      <div
        className="datagrid-table-wrap"
        ref={tableWrapRef}
        tabIndex={0}
        role="grid"
        aria-label={tableName ? `${tableName} data grid` : "Query result data grid"}
      >
        {isQueryResultTruncated && (
          <div className="datagrid-query-result-notice">
            The database returned a partial result set. Refine the query or load more data to continue.
          </div>
        )}

        {isLoading && (
          <div className="datagrid-loading-overlay">
            <div className="datagrid-loading-card">
              <Loader2 className="!w-4 !h-4 animate-spin text-[var(--accent)]" />
              <span className="text-xs text-[var(--text-secondary)]">Loading data...</span>
            </div>
          </div>
        )}

        {viewMode === "chart" ? (
          <div className="datachart-view-wrap">
            <Suspense fallback={<div className="datachart-loading"><Loader2 className="w-5 h-5 animate-spin" /> Loading chart...</div>}>
              <DataChart resolvedColumns={resolvedColumns} queryResult={data} />
            </Suspense>
          </div>
        ) : (
          <table className="datagrid-table" style={{ minWidth: tableMinWidth, tableLayout: "fixed" }}>
          <thead
            className="datagrid-head"
            onContextMenu={(event) => {
              const header = (event.target as HTMLElement).closest("th.datagrid-th");
              const columnId = header?.getAttribute("data-col-id") ?? undefined;
              if (!columnId) return;
              event.preventDefault();
              handleContextMenu(event, "header", columnId);
            }}
          >
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {leftPinnedColumns.map((column) => {
                  const header = hg.headers.find((candidate) => candidate.column.id === column.id);
                  if (!header) return null;
                  const width = columnSizes[column.id] ?? column.getSize();
                  return (
                  <th
                    key={header.id}
                    className={`datagrid-th${column.id === "_row_num" ? " datagrid-th-index" : ""}`}
                    data-col-id={column.id}
                    style={{ width, minWidth: width, ...pinnedColumnStyle(column) }}
                  >
                    <div className="datagrid-th-inner">
                      {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                    </div>
                  </th>
                  );
                })}
                {virtualPaddingLeft > 0 && (
                  <th
                    aria-hidden="true"
                    className="datagrid-virtual-column-spacer"
                    style={getVirtualSpacerStyle(virtualPaddingLeft)}
                  />
                )}
                {virtualColumns.map((virtualColumn) => {
                  const column = virtualizableColumns[virtualColumn.index];
                  const header = hg.headers.find((candidate) => candidate.column.id === column.id);
                  if (!header) return null;
                  const width = columnSizes[header.column.id] ?? header.getSize();
                  return (
                    <th
                      key={header.id}
                      className="datagrid-th"
                      data-col-id={header.column.id}
                      style={{ width, minWidth: width }}
                    >
                      <div className="datagrid-th-inner">
                        {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                        <div
                          className="datagrid-col-resize-handle"
                          onMouseDown={header.getResizeHandler()}
                          onDoubleClick={() => handleColumnAutoFit(header.column.id)}
                          title="Drag to resize, double-click to auto-fit"
                        />
                      </div>
                    </th>
                  );
                })}
                {virtualPaddingRight > 0 && (
                  <th
                    aria-hidden="true"
                    className="datagrid-virtual-column-spacer"
                    style={getVirtualSpacerStyle(virtualPaddingRight)}
                  />
                )}
                {rightPinnedColumns.map((column) => {
                  const header = hg.headers.find((candidate) => candidate.column.id === column.id);
                  if (!header) return null;
                  const width = columnSizes[column.id] ?? column.getSize();
                  return (
                    <th
                      key={header.id}
                      className="datagrid-th"
                      data-col-id={column.id}
                      style={{ width, minWidth: width, ...pinnedColumnStyle(column) }}
                    >
                      <div className="datagrid-th-inner">
                        {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                      </div>
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody onContextMenu={(e) => {
            e.preventDefault();
            const target = e.target as HTMLElement;
            const rowEl = target.closest("tr.datagrid-row");
            const thEl = target.closest("th.datagrid-th");
            if (thEl) {
              const colId = thEl.getAttribute("data-col-id") || undefined;
              handleContextMenu(e, "header", colId);
            } else if (rowEl) {
              const rowIdx = rowEl.querySelector(".datagrid-index-selectable, .datagrid-index-value");
              if (rowIdx) {
                const idx = Number(rowIdx.textContent?.trim() ?? -1) - 1;
                handleContextMenu(e, "row", undefined, idx >= 0 ? idx : undefined);
              }
            } else {
              handleContextMenu(e, "cell");
            }
          }}>
            {virtualPaddingTop > 0 && (
              <tr aria-hidden="true" className="datagrid-virtual-spacer">
                <td colSpan={renderedColumnCount} style={{ height: virtualPaddingTop, padding: 0 }} />
              </tr>
            )}
            {virtualRows.map((virtualRow) => {
              const row = table.getRowModel().rows[virtualRow.index];
              const rowIdx = virtualRow.index;
              const sourceRowIndex = displayedRowIndices[rowIdx] ?? rowIdx;
              return (
              <tr
                key={row.id}
                data-index={sourceRowIndex}
                className={[
                  "datagrid-row",
                  rowIdx % 2 !== 0 ? "alt" : "",
                  selectedRows.has(sourceRowIndex) ? "selected" : "",
                  dragSourceIndex === sourceRowIndex ? "dragging" : "",
                  dropTargetIndex === sourceRowIndex ? "drop-target" : "",
                  isTableEditable && orderColumn ? "datagrid-row-draggable" : "",
                  stagedRowIndices.has(sourceRowIndex) ? "staged-change" : "",
                ].join(" ")}
                draggable={isTableEditable && !!orderColumn}
                onDragStart={() => handleDragStart(sourceRowIndex)}
                onDragOver={(e) => handleDragOver(e, sourceRowIndex)}
                onDrop={(e) => handleDrop(e, sourceRowIndex)}
                onDragEnd={handleDragEnd}
              >
                {leftPinnedColumns.map((column) => {
                  const cell = row.getVisibleCells().find((candidate) => candidate.column.id === column.id);
                  if (!cell) return null;
                  const width = columnSizes[column.id] ?? column.getSize();
                  return (
                  <td
                    key={cell.id}
                    className={[
                      "datagrid-td",
                      column.id === "_row_num" ? "datagrid-td-index" : "",
                      stagedRowIndices.has(sourceRowIndex) ? "staged-cell" : "",
                    ].join(" ")}
                    style={{ width, minWidth: width, ...pinnedColumnStyle(column) }}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                  );
                })}
                {virtualPaddingLeft > 0 && (
                  <td
                    aria-hidden="true"
                    className="datagrid-virtual-column-spacer"
                    style={getVirtualSpacerStyle(virtualPaddingLeft)}
                  />
                )}
                {virtualColumns.map((virtualColumn) => {
                  const column = virtualizableColumns[virtualColumn.index];
                  const cell = row.getVisibleCells().find((candidate) => candidate.column.id === column.id);
                  if (!cell) return null;
                  const width = columnSizes[cell.column.id] ?? cell.column.getSize();
                  return (
                    <td
                      key={cell.id}
                      className={[
                        "datagrid-td",
                        stagedRowIndices.has(sourceRowIndex) ? "staged-cell" : "",
                      ].join(" ")}
                      style={{ width, minWidth: width }}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  );
                })}
                {virtualPaddingRight > 0 && (
                  <td
                    aria-hidden="true"
                    className="datagrid-virtual-column-spacer"
                    style={getVirtualSpacerStyle(virtualPaddingRight)}
                  />
                )}
                {rightPinnedColumns.map((column) => {
                  const cell = row.getVisibleCells().find((candidate) => candidate.column.id === column.id);
                  if (!cell) return null;
                  const width = columnSizes[column.id] ?? column.getSize();
                  return (
                    <td
                      key={cell.id}
                      className={[
                        "datagrid-td",
                        stagedRowIndices.has(sourceRowIndex) ? "staged-cell" : "",
                      ].join(" ")}
                      style={{ width, minWidth: width, ...pinnedColumnStyle(column) }}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  );
                })}
              </tr>
              );
            })}
            {virtualPaddingBottom > 0 && (
              <tr aria-hidden="true" className="datagrid-virtual-spacer">
                <td colSpan={renderedColumnCount} style={{ height: virtualPaddingBottom, padding: 0 }} />
              </tr>
            )}
            {dropTargetIndex !== null && (
              <tr className="datagrid-row drop-indicator">
                <td colSpan={renderedColumnCount}>
                  <div className="datagrid-drop-indicator-line" />
                </td>
              </tr>
            )}
          </tbody>
        </table>
        )}

        {data && data.rows.length === 0 && (
          <div className="datagrid-empty">
            No rows to display
          </div>
        )}
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <DataGridContextMenu
          menu={contextMenu}
          connectionId={connectionId}
          database={database}
          tableName={tableName}
          columnDisplayFormats={columnDisplayFormats}
          table={table}
          onClose={() => setContextMenu(null)}
          onSortAsc={handleSortAsc}
          onSortDesc={handleSortDesc}
          onInsertRow={handleInsertRow}
          onDuplicateRowByIndex={handleDuplicateRowByIndex}
          onOpenRowInspector={handleOpenRowInspector}
          onColumnAutoFit={handleColumnAutoFit}
          setColumnOrder={setColumnOrder}
          setColumnPinning={setColumnPinning}
          setColumnSizes={setColumnSizes}
          setColumnVisibility={setColumnVisibility}
          setFilterDraft={setFilterDraft}
          setTableFilter={setTableFilter}
          setSortColumn={setSortColumn}
          setSortDir={setSortDir}
          setColumnDisplayFormats={setColumnDisplayFormats}
        />
      )}

      {/* FK Preview Popover */}
      {fkPreview && (
        <FkPreviewPopover
          fkPreview={fkPreview}
          isLoadingFkPreview={isLoadingFkPreview}
          fkPreviewData={fkPreviewData}
          onClose={() => setFkPreview(null)}
        />
      )}
      {!externalResult &&
        (footerPortalTarget ? (
          createPortal(gridFooter, footerPortalTarget)
        ) : (
          gridFooter
        ))}
    </div>
    {insertDialogModal}

    {/* Change Tracking Preview Modal */}
    {stagedChangeCount > 0 && typeof document !== "undefined"
      ? createPortal(
          <ChangeTrackingPreviewModal
            tableName={tableName}
            database={database}
            onApply={applyStagedChanges}
            onDiscard={discardStagedChanges}
            isApplying={isLoading}
          />,
          document.body,
        )
      : null}

      {/* Paste Rows Dialog */}
      {isPasteDialogOpen && pastePreview && typeof document !== "undefined"
        ? createPortal(
            <PasteRowsDialog
              tableName={tableName}
              pasteSourceLabel={pasteSourceLabel}
              csvFileSelection={csvFileSelection}
              isSubmittingPaste={isSubmittingPaste}
              isCancellingPaste={isCancellingPaste}
              csvImportProgress={csvImportProgress}
              pastePreview={pastePreview}
              onClose={() => closePasteDialog()}
              onSubmit={() => void handleSubmitPasteDialog()}
              onCancel={() => void handleCancelPasteImport()}
 />,
            document.body,
          )
        : null}
    </>
  );
}
