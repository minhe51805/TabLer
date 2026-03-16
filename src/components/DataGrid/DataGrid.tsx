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
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../stores/appStore";
import type { ColumnDetail, ColumnInfo, QueryResult } from "../../types";

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

const PAGE_SIZE = 200;

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
    setError,
  } = useAppStore(
    useShallow((state) => ({
      getTableData: state.getTableData,
      countRows: state.countRows,
      getTableStructure: state.getTableStructure,
      updateTableCell: state.updateTableCell,
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
  const [editingCell, setEditingCell] = useState<EditingCell | null>(null);
  const [editingSeedValue, setEditingSeedValue] = useState("");
  const [savingCell, setSavingCell] = useState<EditingCell | null>(null);
  const [copiedCell, setCopiedCell] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const structureRequestIdRef = useRef(0);
  const structurePromiseRef = useRef<Promise<ColumnDetail[]> | null>(null);
  const isMountedRef = useRef(true);
  const isActiveRef = useRef(isActive);
  const editorRef = useRef<HTMLInputElement | HTMLSelectElement | null>(null);
  const editingDraftRef = useRef("");
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
          setTotalRows(needsExactCount ? PAGE_SIZE + 1 : result.rows.length);

          if (needsExactCount) {
            void countRows(connectionId, tableName, database)
              .then((count) => {
                if (
                  !isMountedRef.current ||
                  requestId !== requestIdRef.current ||
                  !isActiveRef.current
                ) {
                  return;
                }
                setTotalRows(count);
              })
              .catch((error) => {
                console.error("Failed to count table rows:", error);
              });
          }
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
    isActiveRef.current = isActive;
  }, [isActive]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      requestIdRef.current += 1;
      structureRequestIdRef.current += 1;
      structurePromiseRef.current = null;
    };
  }, []);

  useEffect(() => {
    setEditingCell(null);
    setEditingSeedValue("");
    editingDraftRef.current = "";
    setSavingCell(null);
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

  const resolvedColumns = useMemo<ResolvedColumn[]>(() => {
    if (!data || data.columns.length === 0) return [];
    return buildResolvedColumns(data.columns, structureColumns);
  }, [data, structureColumns]);

  const primaryKeyColumns = useMemo(
    () => resolvedColumns.filter((column) => column.is_primary_key),
    [resolvedColumns]
  );
  const canAttemptInlineEdit = Boolean(tableName && !externalResult);
  const isTableEditable = Boolean(
    tableName && !externalResult && structureStatus === "ready" && primaryKeyColumns.length > 0
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

      if (!column || !rowValues || column.is_primary_key || primaryKeys.length === 0) {
        return;
      }

      const seedValue = editorValueFromCell(rowValues[colIndex] as GridCellValue);
      setEditingSeedValue(seedValue);
      editingDraftRef.current = seedValue;
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

      const primaryKeys = primaryKeyColumns.map((pkColumn) => {
        const pkIndex = resolvedColumns.findIndex((column) => column.name === pkColumn.name);
        const pkValue = rowValues[pkIndex] as GridCellValue;
        return {
          column: pkColumn.name,
          value: pkValue,
        };
      });

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

      cancelEditingCell();
      await fetchData(currentPage);
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

  const columns = useMemo<ColumnDef<any, any>[]>(() => {
    if (!data || resolvedColumns.length === 0) return [];

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
              onClick={() => {
                if (
                  isEditableColumn &&
                  !isEditing &&
                  selectedCell?.row === rowIndex &&
                  selectedCell?.col === idx
                ) {
                  void startEditingCell(rowIndex, idx);
                  return;
                }
                setSelectedCell({ row: rowIndex, col: idx });
              }}
              onDoubleClick={() => {
                if (isEditableColumn) {
                  void startEditingCell(rowIndex, idx);
                  return;
                }
                handleCopyValue(value, cellKey);
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
                    onBlur={() => void commitEditingCell()}
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
                    onBlur={() => void commitEditingCell()}
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
    canAttemptInlineEdit,
    commitEditingCell,
    copiedCell,
    currentPage,
    data,
    editingCell,
    editingSeedValue,
    resolvedColumns,
    savingCell,
    selectedCell,
    sortColumn,
    sortDir,
    startEditingCell,
    structureStatus,
  ]);

  const tableData = useMemo(() => data?.rows || [], [data]);

  const table = useReactTable({
    data: tableData,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
  const visibleRowCount = data?.rows.length ?? 0;
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
      ? "Click once to select, click again or double-click to edit. Press Enter to save or type NULL to clear."
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

          <div className="datagrid-topbar-stats">
            <span className="datagrid-stat-pill">{columnCount} columns</span>
            <span className="datagrid-stat-pill">{visibleRowCount} loaded</span>
            <span className={`datagrid-stat-pill ${sortColumn ? "active" : ""}`}>{activeSortLabel}</span>
          </div>
        </div>
      )}

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
              {tableName && !externalResult && (
                <span className={`datagrid-footer-pill ${isTableEditable ? "info" : ""}`}>
                  {inlineEditStatusLabel}
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
