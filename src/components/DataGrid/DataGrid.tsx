import { useState, useEffect, useMemo, useCallback, useRef, type FormEvent } from "react";
import { createPortal } from "react-dom";
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  type ColumnDef,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Copy, Loader2, Plus, X, ClipboardPaste } from "lucide-react";
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
import { computeNewRowPlan, computeColumnPlan } from "./hooks/useInsertColumnPlan";
import { lazy, Suspense } from "react";
import "./DataChart.css";

const DataChart = lazy(() => import("./DataChart").then((m) => ({ default: m.DataChart })));
import {
  PAGE_SIZE,
  buildTableScopeKey,
  buildTableCacheKey,
  isFreshCacheEntry,
  setBoundedMapEntry,
  invalidateTableScopeCaches,
  invalidateTableCaches,
  tablePageCache,
  tableCountCache,
  inlineStructureCacheRef,
  buildColumnSignature,
  buildResolvedColumns,
  isBooleanColumn,
  editorValueFromCell,
  parseEditorValue,
  areCellValuesEqual,
  buildRowPrimaryKeys,
  type ResolvedColumn,
  type GridCellValue,
  type StructureStatus,
  type EditingCell,
} from "./hooks/useDataGrid";
import { getColumnWidths, saveColumnWidth } from "../../stores/column-width-store";
import { useDateFormatStore } from "../../stores/dateFormatStore";
import { filterAndSortLocalRows, filterRowsWithSourceIndices } from "./local-result-operations";
import { resolveDataWindowColumns } from "./data-window";
import { useConnectionCapabilities } from "../../hooks/useConnectionCapabilities";
import { isCapabilitySupported } from "../../types";

const TABLE_COUNT_CACHE_TTL_MS = 600_000;
import { DataGridToolbar } from "./DataGridToolbar";
import { ChangeTrackingPreviewModal } from "./components/ChangeTrackingPreviewModal";
import { buildDataGridColumns, editingDraftRef } from "./DataGridColumns";
import type { ColumnDisplayFormat } from "./editors";
import {
  generateInsertSql,
  generateUpdateSql,
  generateInsertSqlParameterized,
  generateUpdateSqlParameterized,
  generateDeleteSqlParameterized,
  copyToClipboard,
} from "../../utils/sql-generator";

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

const MAX_TABLE_PAGE_CACHE_ENTRIES = 48;
const MAX_TABLE_COUNT_CACHE_ENTRIES = 24;
const MAX_INLINE_STRUCTURE_CACHE_ENTRIES = 48;

function buildRowFocusFilter(rowFocus: TableRowFocus | undefined) {
  if (!rowFocus) return "";
  const clauses = Object.entries(rowFocus.values).flatMap(([column, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(column)) return [];
    if (value === null) return [`${column} IS NULL`];
    if (typeof value === "number") return [Number.isFinite(value) ? `${column} = ${value}` : ""];
    if (typeof value === "boolean") return [`${column} = ${value ? "TRUE" : "FALSE"}`];
    return [`${column} = '${value.replace(/'/g, "''")}'`];
  }).filter(Boolean);
  return clauses.join(" AND ");
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

  const {
    stagedChanges,
    stageChange,
    unstageChange,
    setColumnNameMap,
    setDbType,
    getChangeCount,
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
  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"ASC" | "DESC">("ASC");
  const [filterDraft, setFilterDraft] = useState("");
  const [tableFilter, setTableFilter] = useState("");
  /** Multi-column sort: array of {column, direction, priority}. Priority 1 = highest. */
  const [multiSort, setMultiSort] = useState<Array<{ column: string; direction: "ASC" | "DESC"; priority: number }>>([]);
  const [selectedCell, setSelectedCell] = useState<{ row: number; col: number } | null>(null);
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [editingCell, setEditingCell] = useState<EditingCell | null>(null);
  const [editingSeedValue, setEditingSeedValue] = useState("");
  const [savingCell, setSavingCell] = useState<EditingCell | null>(null);
  const [isDeletingRows, setIsDeletingRows] = useState(false);
  const [copiedCell, setCopiedCell] = useState<string | null>(null);
  const [undoableChanges, setUndoableChanges] = useState(0);
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
  const [isSubmittingPaste, setIsSubmittingPaste] = useState(false);
  const [isCancellingPaste, setIsCancellingPaste] = useState(false);
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
  const editingOpenedAtRef = useRef(0);
  const rowSelectionAnchorRef = useRef<number | null>(null);
  const dataGridInstanceIdRef = useRef(`datagrid-${Math.random().toString(36).slice(2)}`);
  const csvImportOperationIdRef = useRef<string | null>(null);
  const loadedTablePagesRef = useRef(new Map<number, QueryResult>());
  const assignInputRef = useCallback((element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null) => {
    editorRef.current = element;
  }, []);

  useEffect(() => {
    setViewMode(initialViewMode);
  }, [initialViewMode]);

  const handleViewModeChange = useCallback((mode: "table" | "chart") => {
    setViewMode(mode);
    onViewModeChange?.(mode);
  }, [onViewModeChange]);

  const setLoadedTablePage = useCallback((page: number, result: QueryResult) => {
    if (page === 0) loadedTablePagesRef.current.clear();
    loadedTablePagesRef.current.set(page, result);
    const rows: QueryResult["rows"] = [];
    for (let index = 0; loadedTablePagesRef.current.has(index); index += 1) {
      rows.push(...(loadedTablePagesRef.current.get(index)?.rows ?? []));
    }
    const canonicalColumns = loadedTablePagesRef.current.get(0)?.columns ?? [];
    setData((previous) => ({
      ...result,
      columns: resolveDataWindowColumns(canonicalColumns, previous?.columns ?? [], result.columns),
      rows,
    }));
    setHasMoreTableRows(result.rows.length === PAGE_SIZE);
  }, []);

  const patchLoadedTableCell = useCallback((rowIndex: number, columnIndex: number, value: GridCellValue) => {
    const page = Math.floor(rowIndex / PAGE_SIZE);
    const pageRowIndex = rowIndex % PAGE_SIZE;
    const pageResult = loadedTablePagesRef.current.get(page);
    if (!pageResult?.rows[pageRowIndex]) return;

    const rows = pageResult.rows.map((row, index) => {
      if (index !== pageRowIndex) return row;
      const nextRow = [...row];
      nextRow[columnIndex] = value;
      return nextRow;
    });
    loadedTablePagesRef.current.set(page, { ...pageResult, rows });
  }, []);

  const fetchData = useCallback(
    async (page: number) => {
      if (!tableName || !isActive) return;

      const dataScope = `${connectionId}|${database || ""}|${tableName}|${sortColumn || ""}|${sortDir}|${rowFocusFilter}`;
      if (dataScopeRef.current !== dataScope) {
        dataScopeRef.current = dataScope;
        requestIdRef.current += 1;
      }
      const requestId = requestIdRef.current;
      const tableCacheKey = buildTableCacheKey(
        connectionId,
        tableName,
        database,
        page,
        sortColumn,
        sortDir,
        rowFocusFilter,
      );
      const cachedPage = tablePageCache.get(tableCacheKey);
      const tableScopeKey = buildTableScopeKey(connectionId, tableName, database);
      const cachedCount = tableCountCache.get(tableScopeKey);
      const hasFreshCount = !tableFilter.trim() && !rowFocusFilter && Boolean(
        cachedCount && isFreshCacheEntry(cachedCount.cachedAt, TABLE_COUNT_CACHE_TTL_MS),
      );

      if (cachedPage && isFreshCacheEntry(cachedPage.cachedAt, 120_000)) {
        setLoadedTablePage(page, cachedPage.result);
        setTotalRows(cachedPage.totalRows);
        setIsLoading(false);
        return;
      }

      if (cachedPage) {
        setLoadedTablePage(page, cachedPage.result);
        setTotalRows(cachedPage.totalRows);
      } else if (cachedCount && isFreshCacheEntry(cachedCount.cachedAt, TABLE_COUNT_CACHE_TTL_MS)) {
        setTotalRows(cachedCount.totalRows);
      }

      setIsLoading(true);

      try {
        const result = await getTableData(connectionId, tableName, {
          database,
          offset: page * PAGE_SIZE,
          limit: PAGE_SIZE,
          orderBy: sortColumn || undefined,
          orderDir: sortColumn ? sortDir : undefined,
          filter: rowFocusFilter || undefined,
        });

        if (!isMountedRef.current || requestId !== requestIdRef.current) return;

        setLoadedTablePage(page, result);
        setIsLoading(false);

        if (result.execution_time_ms >= 0) {
          window.dispatchEvent(
            new CustomEvent("workspace-activity", {
              detail: {
                connectionId,
                label: "Load",
                durationMs: result.execution_time_ms,
              },
            }),
          );
        }

        if (page === 0 && isActiveRef.current) {
          const needsExactCount = !rowFocusFilter && result.rows.length === PAGE_SIZE;
          const nextTotalRows = hasFreshCount
            ? cachedCount!.totalRows
            : needsExactCount
              ? PAGE_SIZE + 1
              : result.rows.length;
          setTotalRows(nextTotalRows);
          setBoundedMapEntry(
            tablePageCache,
            tableCacheKey,
            { result, totalRows: nextTotalRows, cachedAt: Date.now() },
            MAX_TABLE_PAGE_CACHE_ENTRIES,
          );

          if (needsExactCount && !hasFreshCount) {
            const countRequestId = countRequestIdRef.current;
            if (countTimeoutRef.current !== null) {
              window.clearTimeout(countTimeoutRef.current);
            }

            countTimeoutRef.current = window.setTimeout(() => {
              void countRows(connectionId, tableName, database)
                .then((count) => {
                  if (
                    !isMountedRef.current ||
                    countRequestId !== countRequestIdRef.current ||
                    !isActiveRef.current
                  ) {
                    return;
                  }

                  setBoundedMapEntry(
                    tableCountCache,
                    tableScopeKey,
                    { totalRows: count, cachedAt: Date.now() },
                    MAX_TABLE_COUNT_CACHE_ENTRIES,
                  );
                  setBoundedMapEntry(
                    tablePageCache,
                    tableCacheKey,
                    { result, totalRows: count, cachedAt: Date.now() },
                    MAX_TABLE_PAGE_CACHE_ENTRIES,
                  );
                  setTotalRows(count);
                })
                .catch((error) => {
                  devLogError("Failed to count table rows:", error);
                });
            }, 800);
          } else if (!tableFilter.trim() && !rowFocusFilter) {
            setBoundedMapEntry(
              tableCountCache,
              tableScopeKey,
              { totalRows: nextTotalRows, cachedAt: Date.now() },
              MAX_TABLE_COUNT_CACHE_ENTRIES,
            );
          }
        } else {
          const fallbackTotalRows = (!tableFilter.trim() && !rowFocusFilter ? cachedCount?.totalRows : undefined)
            || page * PAGE_SIZE + result.rows.length;
          setBoundedMapEntry(
            tablePageCache,
            tableCacheKey,
            { result, totalRows: fallbackTotalRows, cachedAt: Date.now() },
            MAX_TABLE_PAGE_CACHE_ENTRIES,
          );
        }
      } catch (e) {
        if (!isMountedRef.current || requestId !== requestIdRef.current) return;
        devLogError("Failed to fetch table data:", e);
        const message = e instanceof Error ? e.message : String(e);
        setError(`Could not load table data for ${tableName}: ${message}`);
        setIsLoading(false);
      }
    },
    [
      connectionId,
      tableName,
      database,
      sortColumn,
      sortDir,
      tableFilter,
      rowFocusFilter,
      getTableData,
      countRows,
      isActive,
      setError,
      setLoadedTablePage,
    ],
  );

  const refreshTableFromStart = useCallback(async () => {
    loadedTablePagesRef.current.clear();
    setHasMoreTableRows(true);
    setCurrentPage(0);
    await fetchData(0);
  }, [fetchData]);

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
    setFilterDraft("");
    setTableFilter("");
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
    if (!rowFocus || !data?.rows.length || externalResult) return;
    setSelectedRows(new Set([0]));
  }, [data, externalResult, rowFocus]);

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

  const ensureStructureLoaded = useCallback(async () => {
    if (!tableName || externalResult) {
      return [] as ColumnDetail[];
    }

    const structureCacheKey = `${connectionId}|${database || ""}|${tableName}`;
    const cachedStructure = inlineStructureCacheRef.inlineStructureCache.get(structureCacheKey);
    if (cachedStructure && cachedStructure.length > 0) {
      setStructureColumns(cachedStructure);
      setStructureStatus("ready");
      return cachedStructure;
    }

    if (structureStatus === "ready" && structureColumns.length > 0) {
      return structureColumns;
    }

    if (structurePromiseRef.current) {
      return structurePromiseRef.current;
    }

    const requestId = ++structureRequestIdRef.current;
    setStructureStatus("loading");

    const structurePromise = getTableStructure(connectionId, tableName, database)
      .then((structure) => {
        if (!isMountedRef.current || requestId !== structureRequestIdRef.current) {
          return [] as ColumnDetail[];
        }

        setBoundedMapEntry(
          inlineStructureCacheRef.inlineStructureCache,
          structureCacheKey,
          structure.columns,
          MAX_INLINE_STRUCTURE_CACHE_ENTRIES,
        );
        setStructureColumns(structure.columns);
        setForeignKeys(structure.foreign_keys);
        setStructureStatus("ready");
        structureRetryAttemptRef.current = 0;
        if (structureRetryTimeoutRef.current !== null) {
          window.clearTimeout(structureRetryTimeoutRef.current);
          structureRetryTimeoutRef.current = null;
        }

        // Setup change tracking column name map for SQL preview generation
        if (tableName) {
          const colNameMap: Record<number, string> = {};
          structure.columns.forEach((col, idx) => {
            colNameMap[idx] = col.name;
          });
          setColumnNameMap(tableName, colNameMap);

          const connection = connections.find((c: ConnectionConfig) => c.id === connectionId);
          setDbType(tableName, connection?.db_type);
        }
        return structure.columns;
      })
      .catch((error) => {
        if (!isMountedRef.current || requestId !== structureRequestIdRef.current) {
          return [] as ColumnDetail[];
        }

        devLogError("Failed to load table structure for inline edit:", error);
        setStructureColumns([]);
        const retryAttempt = ++structureRetryAttemptRef.current;
        if (retryAttempt <= 3) {
          const retryDelay = 300 * 2 ** (retryAttempt - 1);
          setStructureStatus("loading");
          if (structureRetryTimeoutRef.current !== null) {
            window.clearTimeout(structureRetryTimeoutRef.current);
          }
          structureRetryTimeoutRef.current = window.setTimeout(() => {
            if (isMountedRef.current && requestId === structureRequestIdRef.current) {
              setStructureStatus("idle");
            }
            structureRetryTimeoutRef.current = null;
          }, retryDelay);
        } else {
          setStructureStatus("failed");
        }
        throw error;
      })
      .finally(() => {
        if (structurePromiseRef.current === structurePromise) {
          structurePromiseRef.current = null;
        }
      });

    structurePromiseRef.current = structurePromise;
    return structurePromise;
  }, [
    connectionId,
    database,
    externalResult,
    getTableStructure,
    structureColumns,
    structureStatus,
    tableName,
  ]);

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

  const closeInsertDialog = useCallback(() => {
    setIsInsertDialogOpen(false);
    setInsertDialogColumns([]);
    setInsertDialogBaseValues([]);
    setInsertDraft({});
    setInsertDialogError(null);
    setIsSubmittingInsert(false);
  }, []);

  const closePasteDialog = useCallback((force = false) => {
    if (isSubmittingPaste && !force) return;
    setIsPasteDialogOpen(false);
    setPastePreview(null);
    setPasteSourceLabel("Clipboard data");
    setIsSubmittingPaste(false);
    setIsCancellingPaste(false);
    setDragSourceIndex(null);
    setDropTargetIndex(null);
  }, [isSubmittingPaste]);

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
    setIsPasteDialogOpen(true);
  }, [tableName, resolvedColumns, setError]);

  const handleImportCsv = useCallback(async () => {
    if (!tableName || resolvedColumns.length === 0) return;
    try {
      const file = await invokeMutation<{ fileName: string; content: string; byteSize: number }>("read_csv_file", {});
      const parsed = parseClipboardText(file.content);
      if (!parsed) throw new Error("The selected file does not contain valid CSV or TSV data.");
      const preview = buildPastePreview(parsed, resolvedColumns.map((column) => column.name));
      if (preview.mappings.length === 0) throw new Error("No CSV headers match columns in the selected table.");
      setPastePreview(preview);
      setPasteSourceLabel(file.fileName);
      setIsPasteDialogOpen(true);
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
    }
  }, [resolvedColumns, setError, tableName]);

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
    setSelectedRows(new Set());
    rowSelectionAnchorRef.current = null;
  }, [tableName, currentPage, sortColumn, sortDir, externalResult]);

  // Reset multi-sort when switching tables
  useEffect(() => {
    setMultiSort([]);
  }, [tableName, connectionId, database]);

  // Reset undo count when switching tables or clearing data
  useEffect(() => {
    setUndoableChanges(0);
  }, [tableName, connectionId, database]);

  // Reset view mode when switching data source
  useEffect(() => {
    setViewMode("table");
  }, [tableName, connectionId, database, externalResult]);

  /** Duplicate selected row(s) — opens insert dialog pre-filled with source row values. */
  const handleDuplicateRow = useCallback(async () => {
    if (!tableName || structureColumns.length === 0 || selectedRows.size === 0) return;

    const firstSelectedIndex = Math.min(...Array.from(selectedRows));
    const sourceRow = data?.rows[firstSelectedIndex];
    if (!sourceRow) return;

    const { baseValues, promptColumns } = computeColumnPlan(structureColumns, sourceRow ?? null);

    setInsertDialogColumns(promptColumns);
    setInsertDialogBaseValues(baseValues);
    setInsertDraft(
      Object.fromEntries(
        promptColumns.map((column) => {
          const colIdx = structureColumns.indexOf(column);
          const val = sourceRow ? sourceRow[colIdx] : null;
          return [column.name, val !== null ? String(val) : ""];
        }),
      ),
    );
    setInsertDialogError(null);
    setIsInsertDialogOpen(true);
  }, [tableName, structureColumns, selectedRows, data]);

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
      if (undoableChanges > 0) {
        void fetchData(currentPage);
        setUndoableChanges((prev) => Math.max(0, prev - 1));
      }
    };

    const handleRedo = () => {
      if (undoableChanges > 0) {
        void fetchData(currentPage);
      }
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
  }, [currentPage, fetchData, isActive, undoableChanges, selectedCell, foreignKeys, connectionId, database]);


  /** Server-side order is single-column so every loaded chunk uses one consistent order. */
  const handleSort = useCallback((colName: string) => {
    if (sortColumn === colName) {
      setSortDir((prev) => (prev === "ASC" ? "DESC" : "ASC"));
    } else {
      setMultiSort([]);
      setSortColumn(colName);
      setSortDir("ASC");
    }
    setCurrentPage(0);
  }, [sortColumn]);

  const handleFilterChange = useCallback((value: string) => {
    setFilterDraft(value);
  }, []);

  /** Add column to multi-sort at specific priority position */
  const handleMultiSortAdd = useCallback((colName: string, direction: "ASC" | "DESC") => {
    setMultiSort((prev) => {
      if (prev.some((s) => s.column === colName)) return prev;
      return [...prev, { column: colName, direction, priority: prev.length + 1 }];
    });
    setCurrentPage(0);
  }, []);

  /** Clear all multi-sort columns */
  const handleMultiSortClear = useCallback(() => {
    setMultiSort([]);
    setSortColumn(null);
    setSortDir("ASC");
    setCurrentPage(0);
  }, []);

  const handleSortAsc = useCallback((colName: string) => {
    if (multiSort.length > 0) {
      handleMultiSortAdd(colName, "ASC");
    } else {
      setSortColumn(colName);
      setSortDir("ASC");
      setCurrentPage(0);
    }
  }, [handleMultiSortAdd, multiSort.length]);

  const handleSortDesc = useCallback((colName: string) => {
    if (multiSort.length > 0) {
      handleMultiSortAdd(colName, "DESC");
    } else {
      setSortColumn(colName);
      setSortDir("DESC");
      setCurrentPage(0);
    }
  }, [handleMultiSortAdd, multiSort.length]);

  /** Duplicate a specific row by its page index (used by row context menu). */
  const handleDuplicateRowByIndex = useCallback(async (rowIndex: number) => {
    if (!tableName || structureColumns.length === 0) return;

    const sourceRow = data?.rows[rowIndex];
    if (!sourceRow) return;

    const { baseValues, promptColumns } = computeColumnPlan(structureColumns, sourceRow);

    setInsertDialogColumns(promptColumns);
    setInsertDialogBaseValues(baseValues);
    setInsertDraft(
      Object.fromEntries(
        promptColumns.map((column) => {
          const colIdx = structureColumns.indexOf(column);
          const val = sourceRow[colIdx];
          return [column.name, val !== null ? String(val) : ""];
        }),
      ),
    );
    setInsertDialogError(null);
    setIsInsertDialogOpen(true);
  }, [tableName, structureColumns, data]);

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

  const startEditingCell = useCallback(
    async (rowIndex: number, colIndex: number) => {
      if (!canAttemptInlineEdit || !data || !tableName) return;

      setSelectedCell({ row: rowIndex, col: colIndex });

      let nextResolvedColumns = resolvedColumns;
      if (structureStatus !== "ready") {
        try {
          const loadedStructure = await ensureStructureLoaded();
          nextResolvedColumns = buildResolvedColumns(data.columns, loadedStructure);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setError(`Inline edit unavailable: ${message}`);
          return;
        }
      }

      const primaryKeys = nextResolvedColumns.filter((column) => column.is_primary_key);
      const column = nextResolvedColumns[colIndex];
      const rowValues = data.rows[rowIndex];

      if (!column || !rowValues) {
        return;
      }

      if (primaryKeys.length === 0) {
        setError(`Inline edit unavailable for ${tableName}: no primary key was detected.`);
        return;
      }

      if (column.is_primary_key) {
        setError(`Primary key column "${column.name}" is read-only in inline edit mode.`);
        return;
      }

      const seedValue = editorValueFromCell(rowValues[colIndex] as GridCellValue);
      setEditingSeedValue(seedValue);
      editingDraftRef.current = seedValue;
      editingOpenedAtRef.current = Date.now();
      setEditingCell({ row: rowIndex, col: colIndex });
    },
    [
      canAttemptInlineEdit,
      data,
      ensureStructureLoaded,
      resolvedColumns,
      setError,
      structureStatus,
      tableName,
    ],
  );

  const cancelEditingCell = useCallback(() => {
    setEditingCell(null);
    setEditingSeedValue("");
    editingDraftRef.current = "";
    editingOpenedAtRef.current = 0;
  }, []);

  const commitEditingCell = useCallback(async () => {
    if (!editingCell || !data || !tableName) return;

    const targetColumn = resolvedColumns[editingCell.col];
    const rowValues = data.rows[editingCell.row];
    if (!targetColumn || !rowValues || targetColumn.is_primary_key || primaryKeyColumns.length === 0) {
      cancelEditingCell();
      return;
    }

    try {
      const nextValue = parseEditorValue(editingDraftRef.current, targetColumn);
      const currentValue = rowValues[editingCell.col] as GridCellValue;

      if (areCellValuesEqual(currentValue, nextValue)) {
        cancelEditingCell();
        return;
      }

      const primaryKeys = buildRowPrimaryKeys(rowValues, resolvedColumns, primaryKeyColumns);
      const rowKeyRecord: Record<string, unknown> = {};
      for (const pk of primaryKeys) {
        rowKeyRecord[pk.column] = pk.value;
      }

      // Stage the change in the queue (change tracking)
      stageChange({
        type: "update",
        tableName,
        database,
        rowIndex: editingCell.row,
        rowKey: rowKeyRecord,
        columns: {
          [editingCell.col]: { old: currentValue, new: nextValue },
        },
        originalRow: rowValues as (string | number | boolean | null)[],
      });

      // Keep the authoritative chunk cache in sync before virtual scrolling loads another page.
      patchLoadedTableCell(editingCell.row, editingCell.col, nextValue);
      setData((previous) => {
        if (!previous) return previous;
        const nextRows = previous.rows.map((row, index) => {
          if (index !== editingCell.row) return row;
          const nextRow = [...row];
          nextRow[editingCell.col] = nextValue;
          return nextRow;
        });
        return { ...previous, rows: nextRows };
      });

      // Track staged row for visual indicator
      setStagedRowIndices((prev) => new Set([...prev, editingCell.row]));
      cancelEditingCell();
      setUndoableChanges((prev) => prev + 1);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setError(`Failed to stage change: ${message}`);
    } finally {
      setSavingCell(null);
    }
  }, [
    cancelEditingCell,
    data,
    database,
    editingCell,
    patchLoadedTableCell,
    primaryKeyColumns,
    resolvedColumns,
    setError,
    stageChange,
    tableName,
  ]);

  const handleEditorBlur = useCallback(() => {
    if (Date.now() - editingOpenedAtRef.current < 160) {
      window.setTimeout(() => {
        editorRef.current?.focus();
        if (editorRef.current && "select" in editorRef.current) {
          editorRef.current.select();
        }
      }, 0);
      return;
    }

    void commitEditingCell();
  }, [commitEditingCell]);

  /** Apply all staged changes to the database (commit) */
  const applyStagedChanges = useCallback(async () => {
    const tableChanges = stagedChanges.filter((c) => c.tableName === tableName && c.database === database);
    if (tableChanges.length === 0) return;

    const updates = tableChanges.flatMap((change) => {
      if (change.type !== "update") return [];
      const primaryKeys = Object.entries(change.rowKey).map(([column, value]) => ({
        column,
        value: value as string | number | boolean | null,
      }));
      return Object.entries(change.columns).map(([targetColumn, diff]) => ({
        table: change.tableName,
        database: change.database,
        target_column: targetColumn,
        value: diff.new as string | number | boolean | null,
        primary_keys: primaryKeys,
      }));
    });
    if (updates.length === 0 || tableChanges.some((change) => change.type !== "update")) {
      setError("The edit queue contains an operation that cannot be committed atomically yet.");
      return;
    }

    setIsLoading(true);
    try {
      await applyTableUpdatesAtomically(connectionId, updates);

      // The optimistic queue changes only after the backend transaction commits.
      for (const change of tableChanges) {
        unstageChange(change.id);
      }
      setStagedRowIndices(new Set());

      invalidateTableCaches(connectionId, tableName ?? "", database);
      window.dispatchEvent(
        new CustomEvent("table-data-updated", {
          detail: { connectionId, database, tableName, sourceId: dataGridInstanceIdRef.current },
        }),
      );
      await refreshTableFromStart();

    } catch (errorValue) {
      const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
      setError(`No queued edits were committed: ${message}`);
    } finally {
      setIsLoading(false);
    }
  }, [applyTableUpdatesAtomically, stagedChanges, tableName, database, connectionId, unstageChange, invalidateTableCaches, refreshTableFromStart, setError]);

  /** Discard all staged changes for this table */
  const discardStagedChanges = useCallback(() => {
    const tableChanges = stagedChanges.filter((c) => c.tableName === tableName && c.database === database);
    for (const change of tableChanges) {
      unstageChange(change.id);
    }
    setStagedRowIndices(new Set());
    // Reload original data
    if (tableName) {
      void refreshTableFromStart();
    }
  }, [stagedChanges, tableName, database, unstageChange, refreshTableFromStart]);

  const handleRowSelection = useCallback(
    (rowIndex: number, event?: Pick<MouseEvent, "shiftKey" | "metaKey" | "ctrlKey">) => {
      if (!canSelectRows || !data?.rows[rowIndex]) return;

      setSelectedRows((previous) => {
        const next = new Set(previous);
        const anchor = rowSelectionAnchorRef.current;

        if (event?.shiftKey && anchor !== null) {
          const start = Math.min(anchor, rowIndex);
          const end = Math.max(anchor, rowIndex);
          next.clear();
          for (let index = start; index <= end; index += 1) {
            next.add(index);
          }
        } else if (event?.metaKey || event?.ctrlKey) {
          if (next.has(rowIndex)) {
            next.delete(rowIndex);
          } else {
            next.add(rowIndex);
          }
          rowSelectionAnchorRef.current = rowIndex;
        } else {
          const shouldClear = next.size === 1 && next.has(rowIndex);
          next.clear();
          if (!shouldClear) {
            next.add(rowIndex);
          }
          rowSelectionAnchorRef.current = shouldClear ? null : rowIndex;
        }

        return next;
      });
    },
    [canSelectRows, data],
  );

  const handleToggleSelectAllRows = useCallback(() => {
    if (!canSelectRows || filteredTableRowIndices.length === 0) return;

    setSelectedRows((previous) => {
      if (filteredTableRowIndices.every((rowIndex) => previous.has(rowIndex))) {
        rowSelectionAnchorRef.current = null;
        const next = new Set(previous);
        filteredTableRowIndices.forEach((rowIndex) => next.delete(rowIndex));
        return next;
      }

      const next = new Set(previous);
      filteredTableRowIndices.forEach((rowIndex) => next.add(rowIndex));
      rowSelectionAnchorRef.current = filteredTableRowIndices[0] ?? null;
      return next;
    });
  }, [canSelectRows, filteredTableRowIndices]);

  const handleDeleteSelectedRows = useCallback(async () => {
    if (!tableName || !data || selectedRows.size === 0 || primaryKeyColumns.length === 0) {
      return;
    }

    const shouldDelete = window.confirm(
      `Delete ${selectedRows.size} selected row${selectedRows.size === 1 ? "" : "s"} from ${tableName}? This cannot be undone.`,
    );
    if (!shouldDelete) return;

    const sortedRows = Array.from(selectedRows).sort((left, right) => left - right);

    setIsDeletingRows(true);
    try {
      const rows = sortedRows.map((rowIndex) => {
        const rowValues = data.rows[rowIndex];
        if (!rowValues) {
          throw new Error("One of the selected rows no longer exists in the current page.");
        }
        return buildRowPrimaryKeys(rowValues, resolvedColumns, primaryKeyColumns);
      });

      const affectedRows = await deleteTableRows(connectionId, {
        table: tableName,
        database,
        rows,
      });

      if (affectedRows === 0) {
        throw new Error("Database did not delete any rows for the current selection.");
      }

      const deletedRowSet = new Set(sortedRows);
      setData((previous) => {
        if (!previous) return previous;
        return {
          ...previous,
          rows: previous.rows.filter((_, index) => !deletedRowSet.has(index)),
        };
      });
      setTotalRows((previous) => Math.max(0, previous - sortedRows.length));
      setSelectedRows(new Set());
      rowSelectionAnchorRef.current = null;
      cancelEditingCell();
      setSelectedCell(null);

      invalidateTableCaches(connectionId, tableName, database);
      window.dispatchEvent(
        new CustomEvent("table-data-updated", {
          detail: {
            connectionId,
            database,
            tableName,
            sourceId: dataGridInstanceIdRef.current,
          },
        }),
      );

      await refreshTableFromStart();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setError(`Delete rows failed: ${message}`);
    } finally {
      setIsDeletingRows(false);
    }
  }, [
    cancelEditingCell,
    connectionId,
    data,
    database,
    deleteTableRows,
    refreshTableFromStart,
    primaryKeyColumns,
    resolvedColumns,
    selectedRows,
    setError,
    tableName,
  ]);

  const analyzeInsertPlan = useCallback(() => {
    return computeNewRowPlan(structureColumns);
  }, [structureColumns]);

  const performInsertRow = useCallback(async (values: [string, unknown][]) => {
    if (!tableName) return;

    await insertTableRow(connectionId, {
      table: tableName,
      database,
      values,
    });

    invalidateTableCaches(connectionId, tableName, database);
    window.dispatchEvent(
      new CustomEvent("table-data-updated", {
        detail: {
          connectionId,
          database,
          tableName,
          sourceId: dataGridInstanceIdRef.current,
        },
      }),
    );
    await refreshTableFromStart();
  }, [connectionId, database, insertTableRow, refreshTableFromStart, tableName]);

  const handleInsertRow = useCallback(async () => {
    if (!tableName || structureColumns.length === 0) {
      return;
    }

    const { baseValues, promptColumns } = analyzeInsertPlan();

    if (promptColumns.length > 0) {
      setInsertDialogColumns(promptColumns);
      setInsertDialogBaseValues(baseValues);
      setInsertDraft(
        Object.fromEntries(promptColumns.map((column) => [column.name, ""])),
      );
      setInsertDialogError(null);
      setIsInsertDialogOpen(true);
      return;
    }

    try {
      await performInsertRow(baseValues);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setError(`Insert row failed: ${message}`);
    }
  }, [
    analyzeInsertPlan,
    performInsertRow,
    setError,
    structureColumns.length,
    tableName,
  ]);

  const handleInsertDraftChange = useCallback((columnName: string, value: string) => {
    setInsertDraft((previous) => ({
      ...previous,
      [columnName]: value,
    }));
  }, []);

  const handleSubmitInsertDialog = useCallback(async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();

    const missingColumns: string[] = [];
    const nextValues: [string, unknown][] = [...insertDialogBaseValues];

    for (const column of insertDialogColumns) {
      const rawValue = insertDraft[column.name] ?? "";
      const trimmed = rawValue.trim();

      if (trimmed.length === 0) {
        if (!column.is_nullable) {
          missingColumns.push(column.name);
        } else {
          nextValues.push([column.name, null]);
        }
        continue;
      }

      try {
        nextValues.push([column.name, parseEditorValue(rawValue, column as ResolvedColumn)]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setInsertDialogError(`${column.name}: ${message}`);
        return;
      }
    }

    if (missingColumns.length > 0) {
      setInsertDialogError(`Please enter values for: ${missingColumns.join(", ")}`);
      return;
    }

    setInsertDialogError(null);
    setIsSubmittingInsert(true);

    try {
      await performInsertRow(nextValues);
      closeInsertDialog();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setInsertDialogError(`Insert row failed: ${message}`);
    } finally {
      setIsSubmittingInsert(false);
    }
  }, [closeInsertDialog, insertDialogBaseValues, insertDialogColumns, insertDraft, performInsertRow]);

  const handleSubmitPasteDialog = useCallback(async () => {
    if (!pastePreview || !tableName || !connectionId) return;

    const columnsByName = new Map(resolvedColumns.map((column) => [column.name, column]));
    let validatedRows: [string, unknown][][];
    try {
      validatedRows = pastePreview.insertRows.map((row, rowIndex) => row.map(([columnName, rawValue]) => {
        const column = columnsByName.get(columnName);
        if (!column || rawValue === null) return [columnName, rawValue];
        try {
          return [columnName, parseEditorValue(String(rawValue), column)];
        } catch (errorValue) {
          const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
          throw new Error(`CSV row ${rowIndex + 1}, column ${columnName}: ${message}`);
        }
      }));
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
      return;
    }

    setIsSubmittingPaste(true);
    setIsCancellingPaste(false);
    const operationId = `csv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    csvImportOperationIdRef.current = operationId;
    try {
      await insertTableRowsAtomically(
        connectionId,
        validatedRows.map((values) => ({ table: tableName, database, values })),
        operationId,
      );

      invalidateTableCaches(connectionId, tableName, database);
      window.dispatchEvent(
        new CustomEvent("table-data-updated", {
          detail: { connectionId, database, tableName, sourceId: dataGridInstanceIdRef.current },
        }),
      );
      await refreshTableFromStart();
      closePasteDialog(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setError(`CSV import was rolled back: ${message}`);
    } finally {
      csvImportOperationIdRef.current = null;
      setIsSubmittingPaste(false);
      setIsCancellingPaste(false);
    }
  }, [pastePreview, tableName, connectionId, database, insertTableRowsAtomically, setError, invalidateTableCaches, refreshTableFromStart, closePasteDialog, resolvedColumns]);

  const handleCancelPasteImport = useCallback(async () => {
    const operationId = csvImportOperationIdRef.current;
    if (!operationId || isCancellingPaste) return;
    setIsCancellingPaste(true);
    try {
      const accepted = await cancelCsvImport(operationId);
      if (!accepted) {
        setError("The CSV import had already completed and could not be cancelled.");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setError(`Could not cancel CSV import: ${message}`);
      setIsCancellingPaste(false);
    }
  }, [cancelCsvImport, isCancellingPaste, setError]);

  const handleCopyAsInsert = useCallback(async () => {
    if (selectedRows.size === 0 || !data || !tableName || resolvedColumns.length === 0) return;
    const connection = connections.find((c: ConnectionConfig) => c.id === connectionId);
    const dbType = connection?.db_type;
    const cols: string[] = resolvedColumns.map((c) => c.name);
    const rows = Array.from(selectedRows)
      .sort((a, b) => a - b)
      .map((i) => data.rows[i] as (string | number | boolean | null)[]);
    const sql = generateInsertSql(tableName, cols, rows, dbType);
    const ok = await copyToClipboard(sql);
    if (!ok) setError("Failed to copy SQL to clipboard.");
  }, [
    selectedRows,
    data,
    tableName,
    resolvedColumns,
    connections,
    connectionId,
    setError,
  ]);

  const handleCopyAsUpdate = useCallback(async () => {
    if (
      selectedRows.size === 0 ||
      !data ||
      !tableName ||
      resolvedColumns.length === 0 ||
      primaryKeyColumns.length === 0
    )
      return;
    const connection = connections.find((c: ConnectionConfig) => c.id === connectionId);
    const dbType = connection?.db_type;
    const cols: string[] = resolvedColumns.map((c) => c.name);
    const rows = Array.from(selectedRows)
      .sort((a, b) => a - b)
      .map((i) => data.rows[i] as (string | number | boolean | null)[]);
    const sql = generateUpdateSql(tableName, cols, rows, primaryKeyColumns.map((c) => c.name), dbType);
    const ok = await copyToClipboard(sql);
    if (!ok) setError("Failed to copy SQL to clipboard.");
  }, [
    selectedRows,
    data,
    tableName,
    resolvedColumns,
    primaryKeyColumns,
    connections,
    connectionId,
    setError,
  ]);

  const handleCopyAsInsertParam = useCallback(async () => {
    if (!tableName || resolvedColumns.length === 0) return;
    const connection = connections.find((c: ConnectionConfig) => c.id === connectionId);
    const dbType = connection?.db_type;
    const cols: string[] = resolvedColumns.map((c) => c.name);
    const sql = generateInsertSqlParameterized(tableName, cols, dbType);
    const ok = await copyToClipboard(sql);
    if (!ok) setError("Failed to copy SQL to clipboard.");
  }, [tableName, resolvedColumns, connections, connectionId, setError]);

  const handleCopyAsUpdateParam = useCallback(async () => {
    if (!tableName || resolvedColumns.length === 0 || primaryKeyColumns.length === 0) return;
    const connection = connections.find((c: ConnectionConfig) => c.id === connectionId);
    const dbType = connection?.db_type;
    const cols: string[] = resolvedColumns.map((c) => c.name);
    const sql = generateUpdateSqlParameterized(
      tableName,
      cols,
      primaryKeyColumns.map((c) => c.name),
      dbType,
    );
    const ok = await copyToClipboard(sql);
    if (!ok) setError("Failed to copy SQL to clipboard.");
  }, [tableName, resolvedColumns, primaryKeyColumns, connections, connectionId, setError]);

  const handleCopyAsDeleteParam = useCallback(async () => {
    if (!tableName || primaryKeyColumns.length === 0) return;
    const connection = connections.find((c: ConnectionConfig) => c.id === connectionId);
    const dbType = connection?.db_type;
    const sql = generateDeleteSqlParameterized(
      tableName,
      primaryKeyColumns.map((c) => c.name),
      dbType,
    );
    const ok = await copyToClipboard(sql);
    if (!ok) setError("Failed to copy SQL to clipboard.");
  }, [tableName, primaryKeyColumns, connections, connectionId, setError]);

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
    state: { columnSizing: columnSizes },
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
  const visibleLeafColumns = table.getVisibleLeafColumns();
  const indexColumn = visibleLeafColumns.find((column) => column.id === "_row_num");
  const virtualizableColumns = visibleLeafColumns.filter((column) => column.id !== "_row_num");
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
  const tableMinWidth = (indexColumn?.getSize() ?? 56) + columnVirtualizer.getTotalSize();
  const renderedColumnCount = 1 + virtualColumns.length
    + Number(virtualPaddingLeft > 0)
    + Number(virtualPaddingRight > 0);
  const getVirtualSpacerStyle = (width: number) => ({
    width,
    minWidth: width,
    maxWidth: width,
  });

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
  const columnCount = resolvedColumns.length;
  const insertDialogModal =
    isInsertDialogOpen && typeof document !== "undefined"
      ? createPortal(
          <div className="datagrid-insert-dialog-backdrop" onClick={closeInsertDialog}>
            <div
              className="datagrid-insert-dialog"
              onClick={(event) => event.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-labelledby="datagrid-insert-dialog-title"
            >
              <div className="datagrid-insert-dialog-header">
                <div className="datagrid-insert-dialog-copy">
                  <span className="datagrid-insert-dialog-kicker">Insert row</span>
                  <h3 id="datagrid-insert-dialog-title" className="datagrid-insert-dialog-title">
                    {tableName ? `Add row to ${tableName.split(".").pop() || tableName}` : "Add row"}
                  </h3>
                  <p className="datagrid-insert-dialog-description">
                    Enter the required values below. Columns with database defaults are handled automatically.
                  </p>
                </div>
                <button
                  type="button"
                  className="datagrid-insert-dialog-close"
                  onClick={closeInsertDialog}
                  aria-label="Close insert dialog"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <form className="datagrid-insert-dialog-form" onSubmit={handleSubmitInsertDialog}>
                <div className="datagrid-insert-dialog-fields">
                  {insertDialogColumns.map((column, index) => {
                    const normalizedType = (column.column_type || column.data_type || "").toLowerCase();
                    const usesTextarea =
                      normalizedType.includes("json") ||
                      normalizedType.includes("text") ||
                      normalizedType.includes("blob");
                    const isBooleanInput = isBooleanColumn(column as ResolvedColumn);
                    const placeholder = isBooleanInput
                      ? "true / false"
                      : normalizedType.includes("uuid")
                        ? "UUID value"
                        : normalizedType.includes("int") || normalizedType.includes("numeric")
                          ? "Numeric value"
                          : column.is_nullable
                            ? "Leave blank for NULL"
                            : "Required value";

                    return (
                      <label key={column.name} className="datagrid-insert-field">
                        <span className="datagrid-insert-field-head">
                          <span className="datagrid-insert-field-name">{column.name}</span>
                          {!column.is_nullable && (
                            <span className="datagrid-insert-field-required">Required</span>
                          )}
                        </span>
                        <span className="datagrid-insert-field-meta">
                          {column.column_type || column.data_type}
                        </span>
                        {isBooleanInput ? (
                          <select
                            className="datagrid-insert-field-input"
                            value={insertDraft[column.name] ?? ""}
                            onChange={(event) =>
                              handleInsertDraftChange(column.name, event.currentTarget.value)
                            }
                            autoFocus={index === 0}
                          >
                            {column.is_nullable && <option value="">NULL</option>}
                            <option value="true">true</option>
                            <option value="false">false</option>
                          </select>
                        ) : usesTextarea ? (
                          <textarea
                            className="datagrid-insert-field-input datagrid-insert-field-input-textarea"
                            value={insertDraft[column.name] ?? ""}
                            onChange={(event) =>
                              handleInsertDraftChange(column.name, event.currentTarget.value)
                            }
                            placeholder={placeholder}
                            autoFocus={index === 0}
                            rows={4}
                          />
                        ) : (
                          <input
                            className="datagrid-insert-field-input"
                            type="text"
                            value={insertDraft[column.name] ?? ""}
                            onChange={(event) =>
                              handleInsertDraftChange(column.name, event.currentTarget.value)
                            }
                            placeholder={placeholder}
                            autoFocus={index === 0}
                          />
                        )}
                      </label>
                    );
                  })}
                </div>

                {insertDialogError && (
                  <div className="datagrid-insert-dialog-error">{insertDialogError}</div>
                )}

                <div className="datagrid-insert-dialog-actions">
                  <button
                    type="button"
                    className="datagrid-insert-dialog-btn"
                    onClick={closeInsertDialog}
                    disabled={isSubmittingInsert}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="datagrid-insert-dialog-btn is-primary"
                    disabled={isSubmittingInsert}
                  >
                    {isSubmittingInsert ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Inserting...
                      </>
                    ) : (
                      <>
                        <Plus className="w-4 h-4" />
                        Insert row
                      </>
                    )}
                  </button>
                </div>
              </form>
            </div>
          </div>,
          document.body,
        )
      : null;

  if (!data && !isLoading) {
    return (
      <div className="datagrid-blank-state">
        <Copy className="w-10 h-10 mb-3 opacity-20" />
        <p className="datagrid-blank-state-copy">Select a table or run a query</p>
      </div>
    );
  }

  return (
    <>
    <div data-testid="data-grid" className={`datagrid-shell${externalResult ? "" : " compact"}${settings.rowHeight !== "medium" ? ` row-height-${settings.rowHeight}` : ""}${!settings.alternatingRows ? " alternating-rows-disabled" : ""}`}>
      <DataGridToolbar
        viewMode={viewMode}
        onViewModeChange={handleViewModeChange}
        tableName={tableName}
        database={database}
        externalResult={externalResult}
        columnCount={columnCount}
        visibleRowCount={visibleRowCount}
        executionTimeMs={data?.execution_time_ms ?? 0}
        sortColumn={sortColumn}
        sortDir={sortDir}
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
        editUnavailableReason={capabilityProfile && !allowsInlineEdit
          ? `${capabilityProfile.label} is read-only in TableR; editing actions are unavailable.`
          : undefined}
        canExportData={allowsDataExport}
        canImportCsv={allowsCsvImport}
        structureStatus={structureStatus}
        resolvedColumns={resolvedColumns}
        dataRows={tableData}
        undoableChanges={undoableChanges}
        multiSort={multiSort}
        onClearMultiSort={handleMultiSortClear}
        stagedChangeCount={tableName ? getChangeCount(tableName) : 0}
        onApplyChanges={applyStagedChanges}
        onDiscardChanges={discardStagedChanges}
      />

      <div className="datagrid-table-wrap" ref={tableWrapRef}>
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
          <thead className="datagrid-head">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.filter((header) => header.column.id === "_row_num").map((header) => (
                  <th key={header.id} className="datagrid-th datagrid-th-index" data-col-id={header.column.id}>
                    <div className="datagrid-th-inner">
                      {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                    </div>
                  </th>
                ))}
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
                {row.getVisibleCells().filter((cell) => cell.column.id === "_row_num").map((cell) => (
                  <td
                    key={cell.id}
                    className={[
                      "datagrid-td",
                      "datagrid-td-index",
                      stagedRowIndices.has(sourceRowIndex) ? "staged-cell" : "",
                    ].join(" ")}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
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
        <div
          className="datagrid-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {contextMenu.type === "header" && contextMenu.colName && (
            <>
              <button
                className="datagrid-context-menu-item"
                onClick={() => {
                  handleSortAsc(contextMenu.colName!);
                  setContextMenu(null);
                }}
              >
                Sort ascending
              </button>
              <button
                className="datagrid-context-menu-item"
                onClick={() => {
                  handleSortDesc(contextMenu.colName!);
                  setContextMenu(null);
                }}
              >
                Sort descending
              </button>
              <div className="datagrid-context-menu-separator" />
              <button
                className="datagrid-context-menu-item"
                onClick={() => {
                  void navigator.clipboard.writeText(contextMenu.colName!);
                  setContextMenu(null);
                }}
              >
                Copy column name
              </button>
              <button
                className="datagrid-context-menu-item"
                onClick={() => {
                  const sql = tableName
                    ? `SELECT ${contextMenu.colName} FROM ${tableName};`
                    : `SELECT ${contextMenu.colName};`;
                  void navigator.clipboard.writeText(sql);
                  setContextMenu(null);
                }}
              >
                Copy as SELECT
              </button>
              <div className="datagrid-context-menu-separator" />
              <button
                className="datagrid-context-menu-item"
                onClick={() => {
                  handleColumnAutoFit(contextMenu.colName!);
                  setContextMenu(null);
                }}
              >
                Auto-fit column
              </button>
              <div className="datagrid-context-menu-separator" />
              <div className="datagrid-context-menu-label" style={{ padding: "4px 12px", fontSize: "11px", color: "var(--text-muted)", fontWeight: 600, textTransform: "uppercase" }}>Display As</div>
              {(["default", "uuid", "hex", "text", "json"] as ColumnDisplayFormat[]).map((fmt) => (
                <button
                  key={fmt}
                  className="datagrid-context-menu-item"
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
                  onClick={() => {
                     setColumnDisplayFormats(prev => ({ ...prev, [contextMenu.colName!]: fmt }));
                     setContextMenu(null);
                  }}
                >
                  <span style={{ textTransform: "capitalize" }}>{fmt}</span>
                  {(columnDisplayFormats[contextMenu.colName!] || "default") === fmt && (
                    <span style={{ color: "var(--accent)" }}>✓</span>
                  )}
                </button>
              ))}
            </>
          )}
          {contextMenu.type === "row" && (
            <>
              <button
                className="datagrid-context-menu-item"
                onClick={() => {
                  handleOpenRowInspector(contextMenu.rowIndex ?? 0);
                  setContextMenu(null);
                }}
              >
                Inspect row
              </button>
              <button
                className="datagrid-context-menu-item"
                onClick={() => {
                  void handleDuplicateRowByIndex(contextMenu.rowIndex ?? 0);
                  setContextMenu(null);
                }}
              >
                Duplicate row
              </button>
            </>
          )}
          {contextMenu.type === "cell" && (
            <>
              <button
                className="datagrid-context-menu-item"
                onClick={() => {
                  handleInsertRow();
                  setContextMenu(null);
                }}
              >
                Add row
              </button>
            </>
          )}
        </div>
      )}

      {/* FK Preview Popover */}
      {fkPreview && (
        <div className="datagrid-fk-preview">
          <div className="datagrid-fk-preview-header">
            <span className="datagrid-fk-preview-title">
              FK Preview: {fkPreview.table}.{fkPreview.column}
            </span>
            <span className="datagrid-fk-preview-value">
              = {String(fkPreview.value)}
            </span>
            <button
              type="button"
              className="datagrid-fk-preview-close"
              onClick={() => setFkPreview(null)}
            >
              ×
            </button>
          </div>
          <div className="datagrid-fk-preview-body">
            {isLoadingFkPreview ? (
              <div className="datagrid-fk-preview-loading">Loading...</div>
            ) : fkPreviewData ? (
              fkPreviewData.rows.length > 0 ? (
                <table className="datagrid-fk-preview-table">
                  <thead>
                    <tr>
                      {fkPreviewData.columns.map((col) => (
                        <th key={col.name}>{col.name}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {fkPreviewData.rows.slice(0, 3).map((row, i) => (
                      <tr key={i}>
                        {row.map((cell, j) => (
                          <td key={j}>{cell === null ? "NULL" : String(cell)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="datagrid-fk-preview-empty">No matching row found</div>
              )
            ) : (
              <div className="datagrid-fk-preview-empty">Press Ctrl+Enter on an FK cell to preview</div>
            )}
          </div>
        </div>
      )}

      {!externalResult && (
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
                {data.execution_time_ms > 0 && (
                  <span className="datagrid-footer-pill success">{data.execution_time_ms}ms</span>
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

          {tableName && hasMoreTableRows && (
            <span className="datagrid-footer-pill">Scroll to load more</span>
          )}
        </div>
      )}
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
            <div className="datagrid-insert-dialog-backdrop" onClick={() => closePasteDialog()}>
              <div
                className="datagrid-insert-dialog"
                onClick={(event) => event.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-labelledby="datagrid-paste-dialog-title"
              >
                <div className="datagrid-insert-dialog-header">
                  <div className="datagrid-insert-dialog-copy">
                    <span className="datagrid-insert-dialog-kicker">{pasteSourceLabel}</span>
                    <h3 id="datagrid-paste-dialog-title" className="datagrid-insert-dialog-title">
                      {tableName ? `Insert ${pastePreview.rowCount} row${pastePreview.rowCount !== 1 ? "s" : ""} into ${tableName.split(".").pop() || tableName}` : `Insert ${pastePreview.rowCount} row${pastePreview.rowCount !== 1 ? "s" : ""}`}
                    </h3>
                    <p className="datagrid-insert-dialog-description">
                      Column mappings from clipboard ({pastePreview.firstRowWasHeader ? "headers detected" : "positional mapping"}):
                      {pastePreview.nullColumns.length > 0 && ` Unmapped table columns are omitted so database defaults can apply: ${pastePreview.nullColumns.join(", ")}`}
                      {pastePreview.skippedColumns.length > 0 && ` Skipped clipboard columns: ${pastePreview.skippedColumns.map((c) => `"${c.header}"`).join(", ")}`}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="datagrid-insert-dialog-close"
                    onClick={() => closePasteDialog()}
                    aria-label="Close paste dialog"
                    disabled={isSubmittingPaste}
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <div className="datagrid-paste-preview">
                  {pastePreview.mappings.length > 0 && (
                    <div className="datagrid-paste-mappings">
                      <p className="datagrid-paste-section-label">Column mappings</p>
                      <table className="datagrid-paste-mapping-table">
                        <thead>
                          <tr>
                            <th>Clipboard column</th>
                            <th></th>
                            <th>Table column</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pastePreview.mappings.map((m) => (
                            <tr key={m.tableColumnIndex}>
                              <td><code>{m.clipboardHeader}</code></td>
                              <td style={{ textAlign: "center" }}>→</td>
                              <td><code>{m.tableColumnName}</code></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {pastePreview.skippedColumns.length > 0 && (
                    <div className="datagrid-paste-section">
                      <p className="datagrid-paste-section-label">Skipped clipboard columns (no matching table column)</p>
                      <div className="datagrid-paste-chip-list">
                        {pastePreview.skippedColumns.map((c) => (
                          <span key={c.index} className="datagrid-paste-chip skipped">{c.header || `Column ${c.index + 1}`}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="datagrid-paste-summary">
                    <strong>{pastePreview.rowCount}</strong> row{pastePreview.rowCount !== 1 ? "s" : ""} to insert
                    {pastePreview.nullColumns.length > 0 && `, <strong>${pastePreview.nullColumns.length}</strong> column(s) use database defaults`}
                  </div>
                </div>

                <div className="datagrid-insert-dialog-actions">
                  <button
                    type="button"
                    className="datagrid-insert-dialog-btn"
                    onClick={() => {
                      if (isSubmittingPaste) {
                        void handleCancelPasteImport();
                      } else {
                        closePasteDialog();
                      }
                    }}
                    disabled={isCancellingPaste}
                  >
                    {isSubmittingPaste ? (isCancellingPaste ? "Cancelling..." : "Cancel import") : "Cancel"}
                  </button>
                  <button
                    type="button"
                    className="datagrid-insert-dialog-btn is-primary"
                    onClick={() => void handleSubmitPasteDialog()}
                    disabled={isSubmittingPaste}
                  >
                    {isSubmittingPaste ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Importing {pastePreview.rowCount} rows atomically...
                      </>
                    ) : (
                      <>
                        <ClipboardPaste className="w-4 h-4" />
                        Insert {pastePreview.rowCount} row{pastePreview.rowCount !== 1 ? "s" : ""}
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
