import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { ColumnDetail, QueryResult } from "../../../types";
import type { DatabaseType } from "../../../types/database";
import type { ConnectionConfig, ForeignKeyInfo } from "../../../types";
import { resolveDataWindowColumns } from "../data-window";
import { devLogError } from "../../../utils/logger";
import {
  buildTableCacheKey,
  buildTableScopeKey,
  isFreshCacheEntry,
  setBoundedMapEntry,
  tableCountCache,
  tablePageCache,
  PAGE_SIZE,
  type GridCellValue,
} from "./useDataGrid";
import {
  MAX_INLINE_STRUCTURE_CACHE_ENTRIES,
  MAX_TABLE_PAGE_CACHE_ENTRIES,
  MAX_TABLE_COUNT_CACHE_ENTRIES,
  TABLE_COUNT_CACHE_TTL_MS,
} from "../grid-cache-policy";

interface DataGridTableFetcherParams {
  // Row identity
  connectionId: string;
  tableName?: string;
  database?: string;

  // Sort / filter scope
  sortColumn: string | null;
  sortDir: "ASC" | "DESC";
  tableFilter: string;
  rowFocusFilter: string;

  // Lifecycle
  isActive: boolean;
  externalResult: QueryResult | null | undefined;

  // Structure state (read by ensureStructureLoaded)
  structureColumns: ColumnDetail[];
  structureStatus: "idle" | "loading" | "ready" | "failed";

  // Store actions
  getTableData: (
    connectionId: string,
    table: string,
    opts?: {
      database?: string;
      offset?: number;
      limit?: number;
      orderBy?: string;
      orderDir?: string;
      filter?: string;
    },
  ) => Promise<QueryResult>;
  countRows: (connectionId: string, table: string, database?: string) => Promise<number>;
  getTableStructure: (connectionId: string, table: string, database?: string) => Promise<{
    columns: ColumnDetail[];
    foreign_keys: ForeignKeyInfo[];
  }>;
  setColumnNameMap: (tableName: string, map: Record<number, string>) => void;
  setDbType: (tableName: string, dbType: DatabaseType | undefined) => void;

  connections: ConnectionConfig[];

  // Setters shared with the grid body
  setData: Dispatch<SetStateAction<QueryResult | null>>;
  setTotalRows: Dispatch<SetStateAction<number>>;
  setIsLoading: Dispatch<SetStateAction<boolean>>;
  setHasMoreTableRows: Dispatch<SetStateAction<boolean>>;
  setCurrentPage: Dispatch<SetStateAction<number>>;
  setStructureColumns: Dispatch<SetStateAction<ColumnDetail[]>>;
  setForeignKeys: Dispatch<SetStateAction<ForeignKeyInfo[]>>;
  setStructureStatus: Dispatch<SetStateAction<"idle" | "loading" | "ready" | "failed">>;
  setError: (message: string) => void;

  // Shared refs (named bundle prevents mix-ups at the call site)
  refs: {
    loadedTablePagesRef: RefObject<Map<number, QueryResult>>;
    dataScopeRef: RefObject<string>;
    requestIdRef: RefObject<number>;
    isActiveRef: RefObject<boolean>;
    isMountedRef: RefObject<boolean>;
    countRequestIdRef: RefObject<number>;
    countTimeoutRef: RefObject<number | null>;
    structurePromiseRef: RefObject<Promise<ColumnDetail[]> | null>;
    structureRetryAttemptRef: RefObject<number>;
    structureRetryTimeoutRef: RefObject<number | null>;
    structureRequestIdRef: RefObject<number>;
    inlineStructureCacheRef: {
      inlineStructureCache: Map<string, ColumnDetail[]>;
    };
  };
}

/**
 * Table-mode data loading for the grid: chunked page fetch with caching,
 * async row-count backfill and lazy structure loading with retries.
 * Callbacks are moved verbatim from the grid component body; the module-level
 * caches and their capacity policy stay in useDataGrid / grid-cache-policy.
 */
export function useDataGridTableFetcher({
  connectionId,
  tableName,
  database,
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
  refs,
}: DataGridTableFetcherParams) {
  const {
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
  } = refs;
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

  return {
    setLoadedTablePage,
    patchLoadedTableCell,
    fetchData,
    refreshTableFromStart,
    ensureStructureLoaded,
  };
}
