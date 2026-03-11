import { useState, useEffect, useMemo, useCallback } from "react";
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
} from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import type { QueryResult } from "../../types";

interface Props {
  connectionId: string;
  tableName?: string;
  database?: string;
  queryResult?: QueryResult;
}

const PAGE_SIZE = 200;

export function DataGrid({
  connectionId,
  tableName,
  database,
  queryResult: externalResult,
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

  const fetchData = useCallback(
    async (page: number) => {
      if (!tableName) return;
      setIsLoading(true);
      try {
        const result = await getTableData(connectionId, tableName, {
          database,
          offset: page * PAGE_SIZE,
          limit: PAGE_SIZE,
          orderBy: sortColumn || undefined,
          orderDir: sortColumn ? sortDir : undefined,
        });
        setData(result);
        if (page === 0) {
          const count = await countRows(connectionId, tableName, database);
          setTotalRows(count);
        }
      } catch (e) {
        console.error("Failed to fetch table data:", e);
      }
      setIsLoading(false);
    },
    [connectionId, tableName, database, sortColumn, sortDir, getTableData, countRows]
  );

  useEffect(() => {
    if (externalResult) {
      setData(externalResult);
      setTotalRows(externalResult.rows.length);
    } else if (tableName) {
      fetchData(0);
    }
  }, [tableName, externalResult]);

  useEffect(() => {
    if (tableName && !externalResult) {
      fetchData(currentPage);
    }
  }, [currentPage, sortColumn, sortDir]);

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
        header: "#",
        cell: ({ row }) => (
          <span className="text-[var(--text-muted)] text-[11px] tabular-nums select-none">
            {currentPage * PAGE_SIZE + row.index + 1}
          </span>
        ),
        size: 58,
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

  if (!data && !isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-[var(--text-muted)] select-none">
        <Copy className="w-10 h-10 mb-3 opacity-20" />
        <p className="text-sm opacity-70">Select a table or run a query</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full !px-2">
      <div className="flex-1 overflow-auto relative">
        {isLoading && (
          <div className="absolute inset-0 bg-[var(--bg-primary)]/70 flex items-center justify-center z-10 backdrop-blur-[1px]">
            <div className="flex items-center gap-2.5 !px-4 !py-2.5 bg-[var(--bg-surface)] border border-white/10 rounded-md shadow-lg">
              <Loader2 className="!w-4 !h-4 animate-spin text-[var(--accent)]" />
              <span className="text-xs text-[var(--text-secondary)]">Loading data...</span>
            </div>
          </div>
        )}

        <table className="w-full border-collapse text-[13px]">
          <thead className="sticky top-0 z-[5]">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((header) => (
                  <th
                    key={header.id}
                    className="!px-2.5 !py-2 text-left bg-[var(--bg-secondary)] border-b border-r border-[var(--border-color)] text-[11px] font-bold text-[var(--text-muted)] uppercase tracking-wider whitespace-nowrap"
                    style={{ width: header.getSize() }}
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
                className={`
                  border-b border-[var(--border-color)] transition-colors
                  hover:bg-[var(--bg-hover)]/25
                  ${rowIdx % 2 !== 0 ? "bg-[rgba(255,255,255,0.015)]" : ""}
                `}
              >
                {row.getVisibleCells().map((cell) => (
                  <td
                    key={cell.id}
                    className="!px-0 !py-0 border-r border-[var(--border-color)] max-w-[420px] relative"
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>

        {data && data.rows.length === 0 && (
          <div className="flex items-center justify-center py-16 text-[var(--text-muted)] text-sm">
            No rows to display
          </div>
        )}
      </div>

      <div className="flex items-center justify-between !px-3 !py-2 bg-[rgba(255,255,255,0.02)] border-t border-[var(--border-color)] text-[11px] text-[var(--text-muted)] flex-shrink-0">
        <div className="flex items-center !gap-3">
          {data && (
            <>
              <span className="font-semibold tabular-nums">
                {data.rows.length} row{data.rows.length !== 1 ? "s" : ""}
              </span>
              {totalRows > 0 && (
                <span className="opacity-70">of {totalRows.toLocaleString()} total</span>
              )}
              {data.execution_time_ms > 0 && (
                <span className="text-[var(--success)]">{data.execution_time_ms}ms</span>
              )}
            </>
          )}
        </div>

        {!externalResult && tableName && totalPages > 1 && (
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => setCurrentPage(0)}
              disabled={currentPage === 0}
              className="btn-ghost p-1 disabled:opacity-20"
            >
              <ChevronsLeft className="!w-3.5 !h-3.5" />
            </button>
            <button
              onClick={() => setCurrentPage((p) => Math.max(0, p - 1))}
              disabled={currentPage === 0}
              className="btn-ghost p-1 disabled:opacity-20"
            >
              <ChevronLeft className="!w-3.5 !h-3.5" />
            </button>
            <span className="!px-2 tabular-nums font-semibold">
              {currentPage + 1} / {totalPages}
            </span>
            <button
              onClick={() => setCurrentPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={currentPage >= totalPages - 1}
              className="btn-ghost p-1 disabled:opacity-20"
            >
              <ChevronRight className="!w-3.5 !h-3.5" />
            </button>
            <button
              onClick={() => setCurrentPage(totalPages - 1)}
              disabled={currentPage >= totalPages - 1}
              className="btn-ghost p-1 disabled:opacity-20"
            >
              <ChevronsRight className="!w-3.5 !h-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
