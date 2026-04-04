import { useState, useEffect, useMemo, useCallback, useRef, type FormEvent } from "react";
import { createPortal } from "react-dom";
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  type ColumnDef,
} from "@tanstack/react-table";
import { Copy, Loader2, Plus, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useDataGridSettings } from "../../stores/datagrid-settings-store";
import { useAppStore } from "../../stores/appStore";
import { EventCenter } from "../../stores/event-center";
import type { ColumnDetail, ConnectionConfig, QueryResult } from "../../types";
import { devLogError } from "../../utils/logger";
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

const TABLE_COUNT_CACHE_TTL_MS = 600_000;
import { DataGridToolbar } from "./DataGridToolbar";
import { DataGridPagination } from "./DataGridPagination";
import { buildDataGridColumns, editingDraftRef } from "./DataGridColumns";
import {
  generateInsertSql,
  generateUpdateSql,
  generateInsertSqlParameterized,
  generateUpdateSqlParameterized,
  generateDeleteSqlParameterized,
  copyToClipboard,
} from "../../utils/sql-generator";

const MAX_QUERY_RESULT_RENDER_ROWS = 500;

interface Props {
  connectionId: string;
  tableName?: string;
  database?: string;
  queryResult?: QueryResult;
  isActive?: boolean;
}

const MAX_TABLE_PAGE_CACHE_ENTRIES = 160;
const MAX_TABLE_COUNT_CACHE_ENTRIES = 96;
const MAX_INLINE_STRUCTURE_CACHE_ENTRIES = 96;

export function DataGrid({
  connectionId,
  tableName,
  database,
  queryResult: externalResult,
  isActive = true,
}: Props) {
  const { settings } = useDataGridSettings();
  const {
    getTableData,
    countRows,
    getTableStructure,
    updateTableCell,
    deleteTableRows,
    insertTableRow,
    setError,
    getForeignKeyLookupValues,
    connections,
  } = useAppStore(
    useShallow((state) => ({
      getTableData: state.getTableData,
      countRows: state.countRows,
      getTableStructure: state.getTableStructure,
      updateTableCell: state.updateTableCell,
      deleteTableRows: state.deleteTableRows,
      insertTableRow: state.insertTableRow,
      setError: state.setError,
      getForeignKeyLookupValues: state.getForeignKeyLookupValues,
      connections: state.connections as ConnectionConfig[],
    })),
  );

  const [data, setData] = useState<QueryResult | null>(externalResult || null);
  const [structureColumns, setStructureColumns] = useState<ColumnDetail[]>([]);
  const [foreignKeys, setForeignKeys] = useState<import("../../types").ForeignKeyInfo[]>([]);
  const [lookupValuesCache, setLookupValuesCache] = useState<Map<string, Array<{ value: string | number; label: string }>>>(new Map());
  const [totalRows, setTotalRows] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [structureStatus, setStructureStatus] = useState<StructureStatus>(
    externalResult ? "ready" : "idle",
  );
  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"ASC" | "DESC">("ASC");
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
  const [columnSizes, setColumnSizes] = useState<Record<string, number>>({});
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; type: "cell" | "header" | "row"; colName?: string; rowIndex?: number } | null>(null);
  const tableWrapRef = useRef<HTMLDivElement | null>(null);
  const columnNamesRef = useRef<string[]>([]);
  const requestIdRef = useRef(0);
  const structureRequestIdRef = useRef(0);
  const structurePromiseRef = useRef<Promise<ColumnDetail[]> | null>(null);
  const countTimeoutRef = useRef<number | null>(null);
  const isMountedRef = useRef(true);
  const isActiveRef = useRef(isActive);
  const editorRef = useRef<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null>(null);
  const editingOpenedAtRef = useRef(0);
  const rowSelectionAnchorRef = useRef<number | null>(null);
  const dataGridInstanceIdRef = useRef(`datagrid-${Math.random().toString(36).slice(2)}`);
  const assignInputRef = useCallback((element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null) => {
    editorRef.current = element;
  }, []);

  const fetchData = useCallback(
    async (page: number) => {
      if (!tableName || !isActive) return;

      const requestId = ++requestIdRef.current;
      const tableCacheKey = buildTableCacheKey(
        connectionId,
        tableName,
        database,
        page,
        sortColumn,
        sortDir,
      );
      const cachedPage = tablePageCache.get(tableCacheKey);
      const tableScopeKey = buildTableScopeKey(connectionId, tableName, database);
      const cachedCount = tableCountCache.get(tableScopeKey);
      const hasFreshCount = Boolean(
        cachedCount && isFreshCacheEntry(cachedCount.cachedAt, TABLE_COUNT_CACHE_TTL_MS),
      );

      if (cachedPage && isFreshCacheEntry(cachedPage.cachedAt, 120_000)) {
        setData(cachedPage.result);
        setTotalRows(cachedPage.totalRows);
        setIsLoading(false);
        return;
      }

      if (cachedPage) {
        setData(cachedPage.result);
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
        });

        if (!isMountedRef.current || requestId !== requestIdRef.current) return;

        setData(result);
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
          const needsExactCount = result.rows.length === PAGE_SIZE;
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
            if (countTimeoutRef.current !== null) {
              window.clearTimeout(countTimeoutRef.current);
            }

            countTimeoutRef.current = window.setTimeout(() => {
              void countRows(connectionId, tableName, database)
                .then((count) => {
                  if (
                    !isMountedRef.current ||
                    requestId !== requestIdRef.current ||
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
          } else {
            setBoundedMapEntry(
              tableCountCache,
              tableScopeKey,
              { totalRows: nextTotalRows, cachedAt: Date.now() },
              MAX_TABLE_COUNT_CACHE_ENTRIES,
            );
          }
        } else {
          const fallbackTotalRows = cachedCount?.totalRows || page * PAGE_SIZE + result.rows.length;
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
      getTableData,
      countRows,
      isActive,
      setError,
    ],
  );

  useEffect(() => {
    if (externalResult) {
      setData(externalResult);
      setStructureColumns([]);
      setTotalRows(externalResult.rows.length);
      setIsLoading(false);
      setStructureStatus("ready");
      structurePromiseRef.current = null;
      return;
    }

    setData(null);
    setStructureColumns([]);
    setTotalRows(0);
    setCurrentPage(0);
    setStructureStatus("idle");
    structurePromiseRef.current = null;
    requestIdRef.current += 1;
    structureRequestIdRef.current += 1;
  }, [tableName, connectionId, database, externalResult]);

  useEffect(() => {
    if (!tableName || externalResult || !isActive) return;
    void fetchData(currentPage);
  }, [currentPage, externalResult, fetchData, isActive, tableName]);

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
        return structure.columns;
      })
      .catch((error) => {
        if (!isMountedRef.current || requestId !== structureRequestIdRef.current) {
          return [] as ColumnDetail[];
        }

        devLogError("Failed to load table structure for inline edit:", error);
        setStructureColumns([]);
        setStructureStatus("failed");
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

  const closeInsertDialog = useCallback(() => {
    setIsInsertDialogOpen(false);
    setInsertDialogColumns([]);
    setInsertDialogBaseValues([]);
    setInsertDraft({});
    setInsertDialogError(null);
    setIsSubmittingInsert(false);
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
    closeInsertDialog();
  }, [closeInsertDialog, connectionId, database, tableName]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      requestIdRef.current += 1;
      structureRequestIdRef.current += 1;
      structurePromiseRef.current = null;
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

  // Reset undo count when switching tables or clearing data
  useEffect(() => {
    setUndoableChanges(0);
  }, [tableName, connectionId, database]);

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
    return () => {
      window.removeEventListener("datagrid-undo", handleUndo);
      window.removeEventListener("datagrid-redo", handleRedo);
    };
  }, [currentPage, fetchData, isActive, undoableChanges]);

  const handleSort = useCallback((colName: string) => {
    if (sortColumn === colName) {
      setSortDir((prev) => (prev === "ASC" ? "DESC" : "ASC"));
    } else {
      setSortColumn(colName);
      setSortDir("ASC");
    }
    setCurrentPage(0);
  }, [sortColumn]);

  const handleSortAsc = useCallback((colName: string) => {
    setSortColumn(colName);
    setSortDir("ASC");
    setCurrentPage(0);
  }, []);

  const handleSortDesc = useCallback((colName: string) => {
    setSortColumn(colName);
    setSortDir("DESC");
    setCurrentPage(0);
  }, []);

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

  const dataColumns = data?.columns || [];
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

  const handleOpenRowInspector = useCallback(
    (rowIndex: number) => {
      if (!data || !data.rows[rowIndex]) return;
      const row = data.rows[rowIndex];
      const absoluteRowNumber = currentPage * 100 + rowIndex + 1;
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
    [data, currentPage, resolvedColumns, primaryKeyColumns, tableName, database],
  );

  const canAttemptInlineEdit = Boolean(tableName && !externalResult);
  const canSelectRows = Boolean(tableName && !externalResult && primaryKeyColumns.length > 0);
  const isTableEditable = Boolean(
    tableName && !externalResult && structureStatus === "ready" && primaryKeyColumns.length > 0,
  );
  const selectedRowCount = selectedRows.size;
  const allVisibleRowsSelected = Boolean(
    canSelectRows && data?.rows.length && selectedRows.size === data.rows.length,
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

      setSavingCell(editingCell);
      const affectedRows = await updateTableCell(connectionId, {
        table: tableName,
        database,
        target_column: targetColumn.name,
        value: nextValue,
        primary_keys: primaryKeys,
      });

      if (affectedRows === 0) {
        throw new Error(
          "Database did not persist the change. The row may not be updatable or the key match returned 0 rows.",
        );
      }

      setData((previous) => {
        if (!previous) return previous;

        const nextRows = previous.rows.map((row, index) => {
          if (index !== editingCell.row) return row;
          const nextRow = [...row];
          nextRow[editingCell.col] = nextValue;
          return nextRow;
        });

        return {
          ...previous,
          rows: nextRows,
        };
      });

      invalidateTableCaches(connectionId, tableName, database);
      cancelEditingCell();
      setUndoableChanges((prev) => prev + 1);
      void fetchData(currentPage);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setError(`Inline update failed: ${message}`);
      window.setTimeout(() => {
        editorRef.current?.focus();
        if (editorRef.current && "select" in editorRef.current) {
          editorRef.current.select();
        }
      }, 0);
    } finally {
      setSavingCell(null);
    }
  }, [
    cancelEditingCell,
    connectionId,
    data,
    database,
    editingCell,
    fetchData,
    currentPage,
    primaryKeyColumns,
    resolvedColumns,
    setError,
    tableName,
    updateTableCell,
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
    if (!canSelectRows || !data?.rows.length) return;

    setSelectedRows((previous) => {
      if (previous.size === data.rows.length) {
        rowSelectionAnchorRef.current = null;
        return new Set();
      }

      const next = new Set<number>();
      data.rows.forEach((_, index) => next.add(index));
      rowSelectionAnchorRef.current = 0;
      return next;
    });
  }, [canSelectRows, data]);

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

      if (currentPage > 0 && data.rows.length === sortedRows.length) {
        setCurrentPage((page) => Math.max(0, page - 1));
      } else {
        void fetchData(currentPage);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setError(`Delete rows failed: ${message}`);
    } finally {
      setIsDeletingRows(false);
    }
  }, [
    cancelEditingCell,
    connectionId,
    currentPage,
    data,
    database,
    deleteTableRows,
    fetchData,
    primaryKeyColumns,
    resolvedColumns,
    selectedRows,
    setError,
    tableName,
  ]);

  const analyzeInsertPlan = useCallback(() => {
    const baseValues: [string, unknown][] = [];
    const promptColumns: ColumnDetail[] = [];

    for (const col of structureColumns) {
      const colType = (col.column_type || col.data_type || "").toLowerCase();
      const extra = (col.extra || "").toLowerCase();
      const defaultVal = (col.default_value || "").trim();
      const defaultLower = defaultVal.toLowerCase();
      const hasDatabaseDefault = defaultVal.length > 0;
      const isUuidColumn = colType.includes("uuid") || colType.includes("uniqueidentifier");
      const isAutoGeneratedColumn =
        colType.includes("serial") ||
        colType.includes("identity") ||
        extra.includes("auto_increment") ||
        extra.includes("generated") ||
        defaultLower.includes("nextval(") ||
        defaultLower.includes("gen_random_uuid(") ||
        defaultLower.includes("uuid_generate_v4(") ||
        defaultLower.includes("identity");

      if (col.is_primary_key) {
        if (isUuidColumn && !hasDatabaseDefault && !isAutoGeneratedColumn) {
          const uuid = crypto.randomUUID
            ? crypto.randomUUID()
            : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}-${Math.random().toString(16).slice(2, 6)}-${Math.random().toString(16).slice(2, 6)}-${Math.random().toString(16).slice(2, 14)}`;
          baseValues.push([col.name, uuid]);
        } else if (isAutoGeneratedColumn || hasDatabaseDefault) {
          continue;
        } else {
          promptColumns.push(col);
        }
        continue;
      }

      if (isAutoGeneratedColumn || hasDatabaseDefault) {
        continue;
      }

      if (!col.is_nullable) {
        promptColumns.push(col);
        continue;
      }

      baseValues.push([col.name, null]);
    }

    return { baseValues, promptColumns };
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
    await fetchData(currentPage);
  }, [connectionId, currentPage, database, fetchData, insertTableRow, tableName]);

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

  const displayedRows = useMemo(() => {
    if (!data?.rows) return [];
    if (!externalResult) return data.rows;
    return data.rows.slice(0, MAX_QUERY_RESULT_RENDER_ROWS);
  }, [data, externalResult]);

  const isQueryResultTruncated = Boolean(
    externalResult && ((data?.truncated ?? false) || (data?.rows.length ?? 0) > MAX_QUERY_RESULT_RENDER_ROWS),
  );

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
      currentPage,
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
      nullPlaceholder: settings.nullPlaceholder,
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
    settings,
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
        return next;
      });
    },
  });

  const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
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
    <div className={`datagrid-shell${externalResult ? "" : " compact"}${settings.rowHeight !== "medium" ? ` row-height-${settings.rowHeight}` : ""}${!settings.alternatingRows ? " alternating-rows-disabled" : ""}`}>
      <DataGridToolbar
        tableName={tableName}
        externalResult={externalResult}
        columnCount={columnCount}
        visibleRowCount={visibleRowCount}
        sortColumn={sortColumn}
        sortDir={sortDir}
        selectedRowCount={selectedRowCount}
        isDeletingRows={isDeletingRows}
        handleDeleteSelectedRows={handleDeleteSelectedRows}
        handleInsertRow={handleInsertRow}
        handleCopyAsInsert={handleCopyAsInsert}
        handleCopyAsUpdate={handleCopyAsUpdate}
        handleCopyAsInsertParam={handleCopyAsInsertParam}
        handleCopyAsUpdateParam={handleCopyAsUpdateParam}
        handleCopyAsDeleteParam={handleCopyAsDeleteParam}
        isTableEditable={isTableEditable}
        structureStatus={structureStatus}
        resolvedColumns={resolvedColumns}
        dataRows={tableData}
        undoableChanges={undoableChanges}
      />

      <div className="datagrid-table-wrap" ref={tableWrapRef}>
        {isQueryResultTruncated && (
          <div className="datagrid-query-result-notice">
            Showing the first {MAX_QUERY_RESULT_RENDER_ROWS.toLocaleString()} rows from a larger
            query result to keep the grid responsive.
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

        <table className="datagrid-table">
          <thead className="datagrid-head">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((header) => (
                  <th
                    key={header.id}
                    className={`datagrid-th ${header.column.id === "_row_num" ? "datagrid-th-index" : ""}`}
                    data-col-id={header.column.id}
                    style={{
                      width: columnSizes[header.column.id] ?? header.getSize(),
                      minWidth: columnSizes[header.column.id] ?? header.getSize(),
                    }}
                  >
                    <div className="datagrid-th-inner">
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                      {header.column.id !== "_row_num" && (
                        <div
                          className="datagrid-col-resize-handle"
                          onMouseDown={header.getResizeHandler()}
                          onDoubleClick={() => handleColumnAutoFit(header.column.id)}
                          title="Drag to resize, double-click to auto-fit"
                        />
                      )}
                    </div>
                  </th>
                ))}
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
            {table.getRowModel().rows.map((row, rowIdx) => (
              <tr
                key={row.id}
                className={`datagrid-row ${rowIdx % 2 !== 0 ? "alt" : ""} ${selectedRows.has(row.index) ? "selected" : ""}`}
              >
                {row.getVisibleCells().map((cell) => (
                  <td
                    key={cell.id}
                    className={`datagrid-td ${cell.column.id === "_row_num" ? "datagrid-td-index" : ""}`}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>

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
                  handleColumnAutoFit(contextMenu.colName!);
                  setContextMenu(null);
                }}
              >
                Auto-fit column
              </button>
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

      <div className="datagrid-footer">
        <div className="datagrid-footer-meta">
          {data && (
            <>
              <span className="datagrid-footer-pill strong">
                {visibleRowCount} row{visibleRowCount !== 1 ? "s" : ""}
              </span>
              {isQueryResultTruncated && (
                <span className="datagrid-footer-pill warning">
                  truncated at {visibleRowCount.toLocaleString()} rows
                </span>
              )}
              {totalRows > 0 && (
                <span className="datagrid-footer-pill">of {totalRows.toLocaleString()} total</span>
              )}
              {data.execution_time_ms > 0 && (
                <span className="datagrid-footer-pill success">{data.execution_time_ms}ms</span>
              )}
              {tableName && !externalResult && (
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

        {!externalResult && tableName && totalPages > 1 && (
          <DataGridPagination
            currentPage={currentPage}
            totalPages={totalPages}
            onPageChange={setCurrentPage}
          />
        )}
      </div>
    </div>
    {insertDialogModal}
    </>
  );
}
