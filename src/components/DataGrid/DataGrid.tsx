import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  type ColumnDef,
} from "@tanstack/react-table";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Loader2,
  Key,
  Copy,
  Database,
  Trash2,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../stores/appStore";
import type { ColumnDetail, ColumnInfo, QueryResult, RowKeyValue } from "../../types";

interface Props {
  connectionId: string;
  tableName?: string;
  database?: string;
  queryResult?: QueryResult;
  isActive?: boolean;
}

interface EditingCell {
  row: number;
  col: number;
}

type GridCellValue = string | number | boolean | null;
type ResolvedColumn = ColumnInfo & { column_type?: string };
type StructureStatus = "idle" | "loading" | "ready" | "failed";

interface CachedTablePage {
  result: QueryResult;
  totalRows: number;
  cachedAt: number;
}

const PAGE_SIZE = 100;
const TABLE_PAGE_CACHE_TTL_MS = 120_000;
const TABLE_COUNT_CACHE_TTL_MS = 600_000;
const COUNT_ROWS_DEBOUNCE_MS = 800;
const MAX_TABLE_PAGE_CACHE_ENTRIES = 160;
const MAX_TABLE_COUNT_CACHE_ENTRIES = 96;
const MAX_INLINE_STRUCTURE_CACHE_ENTRIES = 96;
const MAX_QUERY_RESULT_RENDER_ROWS = 500;
const tablePageCache = new Map<string, CachedTablePage>();
const tableCountCache = new Map<string, { totalRows: number; cachedAt: number }>();
const inlineStructureCache = new Map<string, ColumnDetail[]>();

function buildTableScopeKey(connectionId: string, tableName: string, database?: string) {
  return `${connectionId}|${database || ""}|${tableName}`;
}

function buildTableCacheKey(
  connectionId: string,
  tableName: string,
  database?: string,
  page?: number,
  sortColumn?: string | null,
  sortDir?: "ASC" | "DESC"
) {
  return [
    connectionId,
    database || "",
    tableName,
    page ?? 0,
    sortColumn || "",
    sortDir || "",
  ].join("|");
}

function isFreshCacheEntry(cachedAt: number, ttlMs: number) {
  return Date.now() - cachedAt <= ttlMs;
}

function setBoundedMapEntry<K, V>(map: Map<K, V>, key: K, value: V, maxEntries: number) {
  if (map.has(key)) {
    map.delete(key);
  }
  map.set(key, value);

  while (map.size > maxEntries) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}

function matchesCacheScope(
  key: string,
  connectionId: string,
  database?: string,
  tableName?: string
) {
  const [cachedConnectionId, cachedDatabase = "", cachedTableName] = key.split("|", 3);
  if (cachedConnectionId !== connectionId) return false;
  if (database !== undefined && cachedDatabase !== (database || "")) return false;
  if (tableName !== undefined && cachedTableName !== tableName) return false;
  return true;
}

function buildColumnSignature(
  columns: Array<{
    name: string;
    data_type?: string;
    column_type?: string;
    is_nullable?: boolean;
    is_primary_key?: boolean;
    default_value?: string;
    extra?: string;
  }>
) {
  return columns
    .map(
      (column) =>
        [
          column.name,
          column.column_type || column.data_type || "",
          column.is_nullable ? "nullable" : "required",
          column.is_primary_key ? "pk" : "col",
          column.default_value || "",
          column.extra || "",
        ].join(":")
    )
    .join("|");
}

function invalidateTableCaches(
  connectionId: string,
  tableName: string,
  database?: string,
  options?: { invalidateStructure?: boolean }
) {
  invalidateTableScopeCaches(
    connectionId,
    database,
    tableName,
    Boolean(options?.invalidateStructure)
  );
}

function invalidateTableScopeCaches(
  connectionId: string,
  database?: string,
  tableName?: string,
  invalidateStructure = false
) {
  for (const key of tableCountCache.keys()) {
    if (matchesCacheScope(key, connectionId, database, tableName)) {
      tableCountCache.delete(key);
    }
  }

  for (const key of tablePageCache.keys()) {
    if (matchesCacheScope(key, connectionId, database, tableName)) {
      tablePageCache.delete(key);
    }
  }

  if (invalidateStructure) {
    for (const key of inlineStructureCache.keys()) {
      if (matchesCacheScope(key, connectionId, database, tableName)) {
        inlineStructureCache.delete(key);
      }
    }
  }
}

function isBooleanColumn(column: ResolvedColumn) {
  return /(bool)/i.test(column.column_type || column.data_type || "");
}

function isNumericColumn(column: ResolvedColumn) {
  return /(int|numeric|decimal|float|double|real|serial|money)/i.test(
    column.column_type || column.data_type || ""
  );
}

function editorValueFromCell(value: GridCellValue) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function buildResolvedColumns(
  dataColumns: ColumnInfo[],
  structureColumns: ColumnDetail[]
): ResolvedColumn[] {
  if (dataColumns.length === 0) return [];

  const structureByName = new Map(structureColumns.map((column) => [column.name, column]));
  return dataColumns.map((column) => {
    const structureColumn = structureByName.get(column.name);
    if (!structureColumn) return column;

    return {
      ...column,
      data_type: structureColumn.data_type || column.data_type,
      column_type: structureColumn.column_type,
      is_nullable: structureColumn.is_nullable,
      is_primary_key: structureColumn.is_primary_key,
      default_value: structureColumn.default_value,
    };
  });
}

function areCellValuesEqual(left: GridCellValue, right: GridCellValue) {
  if (left === right) return true;
  if (left === null || right === null) return left === right;
  return String(left) === String(right);
}

function parseEditorValue(rawValue: string, column: ResolvedColumn): GridCellValue {
  const trimmed = rawValue.trim();

  if (/^null$/i.test(trimmed)) {
    return null;
  }

  if (isBooleanColumn(column)) {
    if (/^(true|t|1|yes)$/i.test(trimmed)) return true;
    if (/^(false|f|0|no)$/i.test(trimmed)) return false;
    throw new Error("Boolean values must be true or false.");
  }

  if (isNumericColumn(column)) {
    if (!/^[-+]?\d+(\.\d+)?$/.test(trimmed)) {
      throw new Error("Numeric columns only accept valid numbers.");
    }
    return Number(trimmed);
  }

  return rawValue;
}

function buildRowPrimaryKeys(
  rowValues: unknown[],
  resolvedColumns: ResolvedColumn[],
  primaryKeyColumns: ResolvedColumn[]
): RowKeyValue[] {
  return primaryKeyColumns.map((pkColumn) => {
    const pkIndex = resolvedColumns.findIndex((column) => column.name === pkColumn.name);
    return {
      column: pkColumn.name,
      value: (rowValues[pkIndex] as GridCellValue) ?? null,
    };
  });
}

export function DataGrid({
  connectionId,
  tableName,
  database,
  queryResult: externalResult,
  isActive = true,
}: Props) {
  const {
    getTableData,
    countRows,
    getTableStructure,
    updateTableCell,
    deleteTableRows,
    setError,
  } = useAppStore(
    useShallow((state) => ({
      getTableData: state.getTableData,
      countRows: state.countRows,
      getTableStructure: state.getTableStructure,
      updateTableCell: state.updateTableCell,
      deleteTableRows: state.deleteTableRows,
      setError: state.setError,
    }))
  );

  const [data, setData] = useState<QueryResult | null>(externalResult || null);
  const [structureColumns, setStructureColumns] = useState<ColumnDetail[]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [structureStatus, setStructureStatus] = useState<StructureStatus>(
    externalResult ? "ready" : "idle"
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
  const requestIdRef = useRef(0);
  const structureRequestIdRef = useRef(0);
  const structurePromiseRef = useRef<Promise<ColumnDetail[]> | null>(null);
  const countTimeoutRef = useRef<number | null>(null);
  const isMountedRef = useRef(true);
  const isActiveRef = useRef(isActive);
  const editorRef = useRef<HTMLInputElement | HTMLSelectElement | null>(null);
  const editingDraftRef = useRef("");
  const editingOpenedAtRef = useRef(0);
  const rowSelectionAnchorRef = useRef<number | null>(null);
  const dataGridInstanceIdRef = useRef(`datagrid-${Math.random().toString(36).slice(2)}`);
  const assignInputRef = useCallback((element: HTMLInputElement | null) => {
    editorRef.current = element;
  }, []);
  const assignSelectRef = useCallback((element: HTMLSelectElement | null) => {
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
        sortDir
      );
      const cachedPage = tablePageCache.get(tableCacheKey);
      const tableScopeKey = buildTableScopeKey(connectionId, tableName, database);
      const cachedCount = tableCountCache.get(tableScopeKey);
      const hasFreshCount = Boolean(
        cachedCount && isFreshCacheEntry(cachedCount.cachedAt, TABLE_COUNT_CACHE_TTL_MS)
      );

      if (cachedPage && isFreshCacheEntry(cachedPage.cachedAt, TABLE_PAGE_CACHE_TTL_MS)) {
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
            })
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
          setBoundedMapEntry(tablePageCache, tableCacheKey, {
            result,
            totalRows: nextTotalRows,
            cachedAt: Date.now(),
          }, MAX_TABLE_PAGE_CACHE_ENTRIES);

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

                  setBoundedMapEntry(tableCountCache, tableScopeKey, {
                    totalRows: count,
                    cachedAt: Date.now(),
                  }, MAX_TABLE_COUNT_CACHE_ENTRIES);
                  setBoundedMapEntry(tablePageCache, tableCacheKey, {
                    result,
                    totalRows: count,
                    cachedAt: Date.now(),
                  }, MAX_TABLE_PAGE_CACHE_ENTRIES);
                  setTotalRows(count);
                })
                .catch((error) => {
                  console.error("Failed to count table rows:", error);
                });
            }, COUNT_ROWS_DEBOUNCE_MS);
          } else {
            setBoundedMapEntry(tableCountCache, tableScopeKey, {
              totalRows: nextTotalRows,
              cachedAt: Date.now(),
            }, MAX_TABLE_COUNT_CACHE_ENTRIES);
          }
        } else {
          const fallbackTotalRows = cachedCount?.totalRows || page * PAGE_SIZE + result.rows.length;
          setBoundedMapEntry(tablePageCache, tableCacheKey, {
            result,
            totalRows: fallbackTotalRows,
            cachedAt: Date.now(),
          }, MAX_TABLE_PAGE_CACHE_ENTRIES);
        }
      } catch (e) {
        if (!isMountedRef.current || requestId !== requestIdRef.current) return;
        console.error("Failed to fetch table data:", e);
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
    ]
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
    const cachedStructure = inlineStructureCache.get(structureCacheKey);
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
          inlineStructureCache,
          structureCacheKey,
          structure.columns,
          MAX_INLINE_STRUCTURE_CACHE_ENTRIES
        );
        setStructureColumns(structure.columns);
        setStructureStatus("ready");
        return structure.columns;
      })
      .catch((error) => {
        if (!isMountedRef.current || requestId !== structureRequestIdRef.current) {
          return [] as ColumnDetail[];
        }

        console.error("Failed to load table structure for inline edit:", error);
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
        console.error("Inline edit metadata warmup failed:", error);
      });
    }, 180);

    return () => window.clearTimeout(warmupId);
  }, [data, ensureStructureLoaded, externalResult, isActive, structureStatus, tableName]);

  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

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
        Boolean(detail.invalidateStructure)
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

  const handleSort = (colName: string) => {
    if (sortColumn === colName) {
      setSortDir((prev) => (prev === "ASC" ? "DESC" : "ASC"));
    } else {
      setSortColumn(colName);
      setSortDir("ASC");
    }
    setCurrentPage(0);
  };

  const handleCopyValue = (value: GridCellValue, cellKey: string) => {
    navigator.clipboard.writeText(value === null ? "NULL" : String(value));
    setCopiedCell(cellKey);
    setTimeout(() => setCopiedCell(null), 1200);
  };

  const dataColumns = data?.columns || [];
  const dataColumnSignature = useMemo(() => buildColumnSignature(dataColumns), [dataColumns]);
  const structureColumnSignature = useMemo(
    () => buildColumnSignature(structureColumns),
    [structureColumns]
  );

  const resolvedColumns = useMemo<ResolvedColumn[]>(() => {
    if (dataColumns.length === 0) return [];
    return buildResolvedColumns(dataColumns, structureColumns);
  }, [dataColumnSignature, structureColumnSignature]);

  const primaryKeyColumns = useMemo(
    () => resolvedColumns.filter((column) => column.is_primary_key),
    [resolvedColumns]
  );
  const canAttemptInlineEdit = Boolean(tableName && !externalResult);
  const canSelectRows = Boolean(tableName && !externalResult && primaryKeyColumns.length > 0);
  const isTableEditable = Boolean(
    tableName && !externalResult && structureStatus === "ready" && primaryKeyColumns.length > 0
  );
  const selectedRowCount = selectedRows.size;
  const allVisibleRowsSelected = Boolean(
    canSelectRows && data?.rows.length && selectedRows.size === data.rows.length
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
    ]
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
          "Database did not persist the change. The row may not be updatable or the key match returned 0 rows."
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
    [canSelectRows, data]
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
      `Delete ${selectedRows.size} selected row${selectedRows.size === 1 ? "" : "s"} from ${tableName}? This cannot be undone.`
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
        })
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

  const displayedRows = useMemo(() => {
    if (!data?.rows) return [];
    if (!externalResult) return data.rows;
    return data.rows.slice(0, MAX_QUERY_RESULT_RENDER_ROWS);
  }, [data, externalResult]);

  const isQueryResultTruncated = Boolean(
    externalResult && ((data?.truncated ?? false) || (data?.rows.length ?? 0) > MAX_QUERY_RESULT_RENDER_ROWS)
  );

  const columns = useMemo<ColumnDef<any, any>[]>(() => {
    if (!data || resolvedColumns.length === 0) return [];

    return [
      {
        id: "_row_num",
        header: () =>
          canSelectRows ? (
            <button
              type="button"
              className={`datagrid-index-toggle ${allVisibleRowsSelected ? "active" : ""}`}
              onClick={handleToggleSelectAllRows}
              title={allVisibleRowsSelected ? "Clear selected rows" : "Select all visible rows"}
            >
              #
            </button>
          ) : (
            <span className="datagrid-index-label">#</span>
          ),
        cell: ({ row }) =>
          canSelectRows ? (
            <button
              type="button"
              className={`datagrid-index-value datagrid-index-selectable ${selectedRows.has(row.index) ? "selected" : ""}`}
              onClick={(event) => {
                event.stopPropagation();
                handleRowSelection(row.index, event.nativeEvent);
              }}
              title={selectedRows.has(row.index) ? "Row selected" : "Select row"}
            >
              {currentPage * PAGE_SIZE + row.index + 1}
            </button>
          ) : (
            <span className="datagrid-index-value">
              {currentPage * PAGE_SIZE + row.index + 1}
            </span>
          ),
        size: 72,
      },
      ...resolvedColumns.map((col, idx) => ({
        id: col.name,
        header: () => (
          <button
            className="flex items-center gap-1.5 w-full text-left font-semibold group/header"
            onClick={() => handleSort(col.name)}
          >
            {col.is_primary_key && <Key className="w-3 h-3 text-[var(--warning)] shrink-0" />}
            <span className="truncate">{col.name}</span>
            {sortColumn === col.name ? (
              sortDir === "ASC" ? (
                <ArrowUp className="w-3 h-3 shrink-0 text-[var(--accent)]" />
              ) : (
                <ArrowDown className="w-3 h-3 shrink-0 text-[var(--accent)]" />
              )
            ) : (
              <ArrowUpDown className="w-3 h-3 shrink-0 opacity-0 group-hover/header:opacity-50 transition-opacity" />
            )}
          </button>
        ),
        accessorFn: (row: any[]) => row[idx],
        cell: ({ getValue, row: tableRow }: any) => {
          const value = getValue() as GridCellValue;
          const rowIndex = tableRow.index;
          const isSelected = selectedCell?.row === rowIndex && selectedCell?.col === idx;
          const isEditing = editingCell?.row === rowIndex && editingCell?.col === idx;
          const isSaving = savingCell?.row === rowIndex && savingCell?.col === idx;
          const isEditableColumn =
            canAttemptInlineEdit && (structureStatus !== "ready" || !col.is_primary_key);
          const cellKey = `${rowIndex}-${idx}`;

          return (
            <div
              className={[
                "datagrid-cell",
                isSelected ? "selected" : "",
                value === null ? "null-value" : "",
                isEditableColumn ? "editable" : "",
                isEditing ? "editing" : "",
                isSaving ? "saving" : "",
              ].join(" ")}
              onMouseDown={(event) => {
                if (!isEditableColumn || isEditing) return;

                const isRepeatSelection =
                  selectedCell?.row === rowIndex && selectedCell?.col === idx;
                if (isRepeatSelection || event.detail >= 2) {
                  event.preventDefault();
                  event.stopPropagation();
                  void startEditingCell(rowIndex, idx);
                }
              }}
              onClick={() => {
                if (!isEditing) {
                  setSelectedCell({ row: rowIndex, col: idx });
                }
              }}
              onDoubleClick={() => {
                if (!isEditableColumn) {
                  handleCopyValue(value, cellKey);
                }
              }}
            >
              {copiedCell === cellKey && (
                <span className="absolute -top-5 left-1/2 -translate-x-1/2 text-[10px] bg-[var(--accent)] text-[var(--bg-primary)] px-1.5 py-0.5 rounded-md whitespace-nowrap z-10 font-semibold">
                  Copied
                </span>
              )}

              {isEditing ? (
                isBooleanColumn(col) ? (
                  <select
                    ref={assignSelectRef}
                    className="datagrid-cell-editor datagrid-cell-select"
                    defaultValue={editingSeedValue}
                    onChange={(event) => {
                      editingDraftRef.current = event.target.value;
                    }}
                    onBlur={handleEditorBlur}
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void commitEditingCell();
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        cancelEditingCell();
                      }
                    }}
                  >
                    <option value="true">true</option>
                    <option value="false">false</option>
                    <option value="NULL">NULL</option>
                  </select>
                ) : (
                  <input
                    ref={assignInputRef}
                    defaultValue={editingSeedValue}
                    className="datagrid-cell-editor"
                    placeholder={col.is_nullable ? "Type NULL to clear" : ""}
                    onChange={(event) => {
                      editingDraftRef.current = event.target.value;
                    }}
                    onBlur={handleEditorBlur}
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void commitEditingCell();
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        cancelEditingCell();
                      }
                    }}
                  />
                )
              ) : (
                <>
                  {isSaving && <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--accent)] shrink-0" />}
                  <span className="datagrid-cell-value">{value === null ? "NULL" : String(value)}</span>
                </>
              )}
            </div>
          );
        },
        size: 180,
      })),
    ];
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
  ]);

  const tableData = useMemo(() => displayedRows, [displayedRows]);

  const table = useReactTable({
    data: tableData,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
  const visibleRowCount = tableData.length;
  const columnCount = resolvedColumns.length;
  const compactQuery = externalResult?.query?.replace(/\s+/g, " ").trim() ?? "";
  const showTopbar = !externalResult;
  const dataViewTitle = tableName ? tableName.split(".").pop() || tableName : "Result set";
  const inlineEditStatusLabel = isTableEditable
    ? "Inline edit ready"
    : structureStatus === "loading"
      ? "Loading edit metadata..."
      : structureStatus === "idle"
        ? "Edit on demand"
        : "Retry edit load";
  const dataViewSubtitle = tableName
    ? isTableEditable
      ? "Use # to select rows. Click a cell once to select, then click again or double-click to edit. Press Enter to save or type NULL to clear."
      : structureStatus === "loading"
        ? "Loading inline edit metadata for this table..."
      : structureStatus === "idle"
          ? "Browsing table rows. Inline edit metadata loads the first time you edit a cell."
          : "Browsing table rows. Inline edit metadata could not be loaded. Click a cell to retry."
    : compactQuery
      ? compactQuery
      : "Rows returned from the latest SQL execution.";
  const activeSortLabel = sortColumn ? `${sortColumn} ${sortDir}` : "Natural order";

  if (!data && !isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-[var(--text-muted)] select-none">
        <Copy className="w-10 h-10 mb-3 opacity-20" />
        <p className="text-sm opacity-70">Select a table or run a query</p>
      </div>
    );
  }

  return (
    <div className={`datagrid-shell ${showTopbar ? "" : "compact"}`}>
      {showTopbar && (
        <div className="datagrid-topbar">
          <div className="datagrid-topbar-copy">
            <span className="datagrid-topbar-kicker">{tableName ? "Table Data" : "Query Result"}</span>
            <div className="datagrid-topbar-title-row">
              <Database className="w-4 h-4 text-[var(--accent-hover)]" />
              <h3 className="datagrid-topbar-title">{dataViewTitle}</h3>
            </div>
            <p className="datagrid-topbar-subtitle" title={dataViewSubtitle}>
              {dataViewSubtitle}
            </p>
          </div>

          <div className="datagrid-topbar-side">
            <div className="datagrid-topbar-stats">
              <span className="datagrid-stat-pill">{columnCount} columns</span>
              <span className="datagrid-stat-pill">{visibleRowCount} loaded</span>
              <span className={`datagrid-stat-pill ${sortColumn ? "active" : ""}`}>{activeSortLabel}</span>
            </div>

            {selectedRowCount > 0 && (
              <div className="datagrid-topbar-actions">
                <button
                  type="button"
                  className="datagrid-footer-action danger"
                  onClick={() => void handleDeleteSelectedRows()}
                  disabled={isDeletingRows}
                >
                  {isDeletingRows ? (
                    <Loader2 className="!w-3.5 !h-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="!w-3.5 !h-3.5" />
                  )}
                  <span>Delete selected</span>
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="datagrid-table-wrap">
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
                    style={{ width: header.getSize(), minWidth: header.getSize() }}
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
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
                  {inlineEditStatusLabel}
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
          <div className="datagrid-pagination">
            <button
              onClick={() => setCurrentPage(0)}
              disabled={currentPage === 0}
              className="datagrid-page-btn"
            >
              <ChevronsLeft className="!w-3.5 !h-3.5" />
            </button>
            <button
              onClick={() => setCurrentPage((page) => Math.max(0, page - 1))}
              disabled={currentPage === 0}
              className="datagrid-page-btn"
            >
              <ChevronLeft className="!w-3.5 !h-3.5" />
            </button>
            <span className="datagrid-page-status">
              {currentPage + 1} / {totalPages}
            </span>
            <button
              onClick={() => setCurrentPage((page) => Math.min(totalPages - 1, page + 1))}
              disabled={currentPage >= totalPages - 1}
              className="datagrid-page-btn"
            >
              <ChevronRight className="!w-3.5 !h-3.5" />
            </button>
            <button
              onClick={() => setCurrentPage(totalPages - 1)}
              disabled={currentPage >= totalPages - 1}
              className="datagrid-page-btn"
            >
              <ChevronsRight className="!w-3.5 !h-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
