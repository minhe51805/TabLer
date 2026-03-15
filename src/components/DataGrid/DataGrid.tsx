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
} from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import type { QueryResult } from "../../types";

interface Props {
  connectionId: string;
  tableName?: string;
  database?: string;
  queryResult?: QueryResult;
  isActive?: boolean;
}

const PAGE_SIZE = 200;

export function DataGrid({
  connectionId,
  tableName,
  database,
  queryResult: externalResult,
  isActive = true,
}: Props) {
  const { getTableData, countRows } = useAppStore();

  const [data, setData] = useState<QueryResult | null>(externalResult || null);
  const [totalRows, setTotalRows] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"ASC" | "DESC">("ASC");
  const [selectedCell, setSelectedCell] = useState<{ row: number; col: number } | null>(null);
  const [copiedCell, setCopiedCell] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const isMountedRef = useRef(true);
  const isActiveRef = useRef(isActive);

  const fetchData = useCallback(
    async (page: number) => {
      if (!tableName || !isActive) return;

      const requestId = ++requestIdRef.current;
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

        if (page === 0 && isActiveRef.current) {
          void countRows(connectionId, tableName, database)
            .then((count) => {
              if (!isMountedRef.current || requestId !== requestIdRef.current || !isActiveRef.current) {
                return;
              }
              setTotalRows(count);
            })
            .catch((error) => {
              console.error("Failed to count table rows:", error);
            });
        }
      } catch (e) {
        if (!isMountedRef.current || requestId !== requestIdRef.current) return;
        console.error("Failed to fetch table data:", e);
        setIsLoading(false);
      }
    },
    [connectionId, tableName, database, sortColumn, sortDir, getTableData, countRows, isActive]
  );

  useEffect(() => {
    if (externalResult) {
      setData(externalResult);
      setTotalRows(externalResult.rows.length);
      setIsLoading(false);
      return;
    }

    setData(null);
    setTotalRows(0);
    setCurrentPage(0);
    requestIdRef.current += 1;
  }, [tableName, connectionId, database, externalResult]);

  useEffect(() => {
    if (!tableName || externalResult || !isActive) return;
    void fetchData(currentPage);
  }, [currentPage, externalResult, fetchData, isActive, tableName]);

  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      requestIdRef.current += 1;
    };
  }, []);

  const handleSort = (colName: string) => {
    if (sortColumn === colName) {
      setSortDir((prev) => (prev === "ASC" ? "DESC" : "ASC"));
    } else {
      setSortColumn(colName);
      setSortDir("ASC");
    }
    setCurrentPage(0);
  };

  const handleCopyValue = (value: any, cellKey: string) => {
    navigator.clipboard.writeText(value === null ? "NULL" : String(value));
    setCopiedCell(cellKey);
    setTimeout(() => setCopiedCell(null), 1200);
  };

  const columns = useMemo<ColumnDef<any, any>[]>(() => {
    if (!data || data.columns.length === 0) return [];

    return [
      {
        id: "_row_num",
        header: () => <span className="datagrid-index-label">#</span>,
        cell: ({ row }) => (
          <span className="datagrid-index-value">
            {currentPage * PAGE_SIZE + row.index + 1}
          </span>
        ),
        size: 72,
      },
      ...data.columns.map((col, idx) => ({
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
          const value = getValue();
          const isSelected = selectedCell?.row === tableRow.index && selectedCell?.col === idx;
          const cellKey = `${tableRow.index}-${idx}`;

          return (
            <div
              className={`datagrid-cell ${isSelected ? "selected" : ""} ${value === null ? "null-value" : ""}`}
              onClick={() => setSelectedCell({ row: tableRow.index, col: idx })}
              onDoubleClick={() => handleCopyValue(value, cellKey)}
            >
              {copiedCell === cellKey && (
                <span className="absolute -top-5 left-1/2 -translate-x-1/2 text-[10px] bg-[var(--accent)] text-[var(--bg-primary)] px-1.5 py-0.5 rounded-md whitespace-nowrap z-10 font-semibold">
                  Copied
                </span>
              )}
              {value === null ? "NULL" : String(value)}
            </div>
          );
        },
        size: 180,
      })),
    ];
  }, [data, sortColumn, sortDir, selectedCell, currentPage, copiedCell]);

  const tableData = useMemo(() => data?.rows || [], [data]);

  const table = useReactTable({
    data: tableData,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
  const visibleRowCount = data?.rows.length ?? 0;
  const columnCount = data?.columns.length ?? 0;
  const compactQuery = externalResult?.query?.replace(/\s+/g, " ").trim() ?? "";
  const dataViewTitle = tableName ? tableName.split(".").pop() || tableName : "Result set";
  const dataViewSubtitle = tableName
    ? database
      ? `Browsing rows from ${database}. Double-click a cell to copy its value.`
      : "Browsing table rows. Double-click a cell to copy its value."
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
    <div className="datagrid-shell">
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

        <div className="datagrid-topbar-stats">
          <span className="datagrid-stat-pill">{columnCount} columns</span>
          <span className="datagrid-stat-pill">{visibleRowCount} loaded</span>
          <span className={`datagrid-stat-pill ${sortColumn ? "active" : ""}`}>{activeSortLabel}</span>
        </div>
      </div>

      <div className="datagrid-table-wrap">
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
                className={`datagrid-row ${rowIdx % 2 !== 0 ? "alt" : ""}`}
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
              {totalRows > 0 && (
                <span className="datagrid-footer-pill">of {totalRows.toLocaleString()} total</span>
              )}
              {data.execution_time_ms > 0 && (
                <span className="datagrid-footer-pill success">{data.execution_time_ms}ms</span>
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
              onClick={() => setCurrentPage((p) => Math.max(0, p - 1))}
              disabled={currentPage === 0}
              className="datagrid-page-btn"
            >
              <ChevronLeft className="!w-3.5 !h-3.5" />
            </button>
            <span className="datagrid-page-status">
              {currentPage + 1} / {totalPages}
            </span>
            <button
              onClick={() => setCurrentPage((p) => Math.min(totalPages - 1, p + 1))}
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
