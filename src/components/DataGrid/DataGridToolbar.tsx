import { FileJson, FileSpreadsheet, Loader2, Trash2, Undo2, Redo2, Plus, Copy, FilePen, Braces, Settings2, X, FileCode, ClipboardPaste, FileUp, List, BarChart3, Download, ChevronDown, Search, RefreshCw, ArrowUpDown } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { buildCsvContent, buildJsonContent, buildTsvContent, exportToCSV, exportToJSON } from "../../utils/export-utils";
import { exportXLSX } from "../../utils/export-xlsx";
import { buildMqlContent, exportToMQL } from "../../utils/export-mql";
import { serializePluginFormat } from "../../utils/plugin-format-runtime";
import { emitAppToast } from "../../utils/app-toast";
import { useDataGridSettings } from "../../stores/datagrid-settings-store";
import { usePluginStore } from "../../stores/pluginStore";
import {
  downloadPluginFormat,
  getEnabledPluginFormats,
  type RuntimePluginFormat,
} from "../../utils/plugin-format-runtime";
import type { ResolvedColumn } from "./hooks/useDataGrid";

interface DataGridToolbarProps {
  viewMode?: "table" | "chart";
  onViewModeChange?: (mode: "table" | "chart") => void;
  tableName?: string;
  database?: string;
  externalResult?: import("../../types").QueryResult;
  selectedRowCount: number;
  isDeletingRows: boolean;
  handleDeleteSelectedRows: () => void;
  handleInsertRow: () => void;
  handleCopyAsInsert: () => void;
  handleCopyAsUpdate: () => void;
  handleCopyAsInsertParam: () => void;
  handleCopyAsUpdateParam: () => void;
  handleCopyAsDeleteParam: () => void;
  isTableEditable: boolean;
  structureStatus: "idle" | "loading" | "ready" | "failed";
  /** Column definitions for export (uses resolved display name) */
  resolvedColumns?: ResolvedColumn[];
  /** Primary key columns for parameterized SQL generation */
  primaryKeyColumns?: ResolvedColumn[];
  /** Raw row data to export (uses same row order as displayed in grid) */
  dataRows?: (string | number | boolean | null)[][];
  /** Number of pending undoable changes */
  undoableChanges?: number;
  /** Multi-column sort state */
  multiSort?: Array<{ column: string; direction: "ASC" | "DESC"; priority: number }>;
  /** Clear all multi-column sorts */
  onClearMultiSort?: () => void;
  /** Currently sorted column (single sort) */
  sortColumn?: string | null;
  /** Current single-sort direction */
  sortDir?: "ASC" | "DESC";
  /** Set the single-sort column (toggles direction when already active) */
  onSortColumn?: (colName: string) => void;
  /** Trigger paste rows from clipboard */
  onPasteRows?: () => void;
  onImportCsv?: () => void;
  /** Number of pending staged changes in the change tracking queue */
  stagedChangeCount?: number;
  /** Apply all staged changes to the database */
  onApplyChanges?: () => void;
  /** Discard all staged changes */
  onDiscardChanges?: () => void;
  filterValue?: string;
  onFilterChange?: (value: string) => void;
  canExportData?: boolean;
  /** Refetch the current table from the database (manual reload button) */
  onReloadData?: () => void | Promise<void>;
  /** True while the reload refetch is in flight — swaps the icon for a spinner */
  isReloadingData?: boolean;
  canImportCsv?: boolean;
  onExportFull?: (format: "csv" | "jsonl") => void;
  isExportingFull?: boolean;
  exportedRowCount?: number;
  onCancelExport?: () => void;
}

function buildExportFilename(tableName: string | undefined, extension: string): string {
  const base = tableName
    ? tableName.replace(/[^a-zA-Z0-9_.-]/g, "_").split(".").pop() || tableName
    : "table_export";
  const date = new Date().toISOString().slice(0, 10);
  return `${base}_${date}.${extension}`;
}

export function DataGridToolbar({
  viewMode = "table",
  onViewModeChange,
  tableName,
  database,
  externalResult,
  selectedRowCount,
  onPasteRows,
  onImportCsv,
  isDeletingRows,
  handleDeleteSelectedRows,
  handleInsertRow,
  handleCopyAsInsert,
  handleCopyAsUpdate,
  handleCopyAsInsertParam,
  handleCopyAsUpdateParam,
  handleCopyAsDeleteParam,
  isTableEditable,
  structureStatus,
  resolvedColumns = [],
  primaryKeyColumns = [],
  dataRows = [],
  undoableChanges = 0,
  stagedChangeCount = 0,
  onApplyChanges,
  onDiscardChanges,
  filterValue = "",
  onFilterChange,
  canExportData = true,
  onReloadData,
  isReloadingData = false,
  canImportCsv = true,
  onExportFull,
  isExportingFull = false,
  exportedRowCount = 0,
  onCancelExport,
  sortColumn = null,
  sortDir = "ASC",
  multiSort = [],
  onClearMultiSort,
  onSortColumn,
}: DataGridToolbarProps) {
  const [showSettings, setShowSettings] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showCopyMenu, setShowCopyMenu] = useState(false);
  const [showSqlMenu, setShowSqlMenu] = useState(false);
  const [showSortMenu, setShowSortMenu] = useState(false);
  const settingsBtnRef = useRef<HTMLSpanElement>(null);
  const exportBtnRef = useRef<HTMLSpanElement>(null);
  const copyBtnRef = useRef<HTMLSpanElement>(null);
  const sqlBtnRef = useRef<HTMLSpanElement>(null);
  const sortBtnRef = useRef<HTMLSpanElement>(null);
  const { settings, updateSettings } = useDataGridSettings();

  /** "name ↑" style summary for the sort button label; null when unsorted. */
  const sortSummary = useMemo(() => {
    if (multiSort.length > 0) {
      const first = multiSort[0];
      const rest = multiSort.length - 1;
      return `${first.column} ${first.direction === "ASC" ? "↑" : "↓"}${rest > 0 ? ` +${rest}` : ""}`;
    }
    if (sortColumn) return `${sortColumn} ${sortDir === "ASC" ? "↑" : "↓"}`;
    return null;
  }, [multiSort, sortColumn, sortDir]);

  const sortMenuHint = multiSort.length > 0
    ? "Multi-column sort active — pick a column to add, or clear sorts"
    : sortColumn
      ? `Sorted by ${sortColumn} (${sortDir})`
      : "Sort rows by a column";
  const installedPlugins = usePluginStore((state) => state.plugins);
  const pluginsHaveLoaded = usePluginStore((state) => state.hasLoaded);
  const loadPlugins = usePluginStore((state) => state.loadPlugins);
  const pluginFormats = useMemo(
    () => getEnabledPluginFormats(installedPlugins),
    [installedPlugins],
  );

  useEffect(() => {
    if (!pluginsHaveLoaded) void loadPlugins();
  }, [loadPlugins, pluginsHaveLoaded]);

  useEffect(() => {
    if (!showExportMenu && !showSettings && !showCopyMenu && !showSqlMenu && !showSortMenu) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && exportBtnRef.current?.contains(target)) return;
      if (target && settingsBtnRef.current?.contains(target)) return;
      if (target && copyBtnRef.current?.contains(target)) return;
      if (target && sqlBtnRef.current?.contains(target)) return;
      if (target && sortBtnRef.current?.contains(target)) return;
      const inPopover = target instanceof Element && target.closest(".datagrid-export-menu, .datagrid-settings-popover");
      if (inPopover) return;
      setShowExportMenu(false);
      setShowSettings(false);
      setShowCopyMenu(false);
      setShowSqlMenu(false);
      setShowSortMenu(false);
    };
    window.addEventListener("mousedown", handlePointerDown, true);
    return () => window.removeEventListener("mousedown", handlePointerDown, true);
  }, [showExportMenu, showSettings, showCopyMenu, showSqlMenu, showSortMenu]);

  // Filter input: rendered on the left side of the grid toolbar.
  const showFilter = Boolean((tableName || externalResult) && onFilterChange);

  const filterControl = showFilter ? (
    <label className="datagrid-filter-control">
      <Search className="w-3.5 h-3.5" aria-hidden="true" />
      <input
        value={filterValue}
        onChange={(event) => onFilterChange?.(event.target.value)}
        placeholder="Filter rows"
        aria-label="Filter loaded rows"
      />
      {filterValue && (
        <button
          type="button"
          onClick={() => onFilterChange?.("")}
          aria-label="Clear table filter"
          title="Clear filter"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </label>
  ) : null;

  const canExport = canExportData && resolvedColumns.length > 0 && (dataRows.length > 0 || Boolean(tableName && onExportFull));
  const exportFilenameBase = tableName
    ? tableName.replace(/[^a-zA-Z0-9_.-]/g, "_").split(".").pop() || tableName
    : "table_export";

  const handleExportCSV = useCallback(() => {
    if (!canExport) return;
    if (tableName && onExportFull) {
      onExportFull("csv");
      return;
    }
    const cols = resolvedColumns.map((c) => c.name);
    exportToCSV(cols, dataRows, buildExportFilename(exportFilenameBase, "csv")).catch((error) => {
      emitAppToast({ title: "Export failed", description: String(error), tone: "error" });
    });
  }, [canExport, dataRows, exportFilenameBase, onExportFull, resolvedColumns, tableName]);

  const handleExportJSON = useCallback(() => {
    if (!canExport) return;
    if (tableName && onExportFull) {
      onExportFull("jsonl");
      return;
    }
    const cols = resolvedColumns.map((c) => c.name);
    exportToJSON(cols, dataRows, buildExportFilename(exportFilenameBase, "json")).catch((error) => {
      emitAppToast({ title: "Export failed", description: String(error), tone: "error" });
    });
  }, [canExport, dataRows, exportFilenameBase, onExportFull, resolvedColumns, tableName]);

  const handleExportXLSX = useCallback(async () => {
    if (!canExport) return;
    const cols = resolvedColumns.map((c) => ({ name: c.name, data_type: c.data_type || "" }));
    try {
      await exportXLSX(
        [{ name: tableName || "Result", columns: cols, rows: dataRows }],
        buildExportFilename(exportFilenameBase, "xlsx"),
      );
    } catch (error) {
      emitAppToast({ title: "Export failed", description: String(error), tone: "error" });
    }
  }, [canExport, dataRows, exportFilenameBase, resolvedColumns, tableName]);

  const handleExportMQL = useCallback(async () => {
    if (!canExport) return;
    const cols = resolvedColumns.map((c) => c.name);
    try {
      await exportToMQL({
        collectionName: tableName,
        databaseName: database,
        columns: cols,
        rows: dataRows,
      });
    } catch (error) {
      emitAppToast({ title: "Export failed", description: String(error), tone: "error" });
    }
  }, [canExport, dataRows, database, resolvedColumns, tableName]);

  const handlePluginExport = useCallback((format: RuntimePluginFormat) => {
    if (!canExport) return;
    downloadPluginFormat(
      format,
      resolvedColumns.map((column) => column.name),
      dataRows,
      buildExportFilename(exportFilenameBase, format.extension),
    ).catch((error) => {
      emitAppToast({ title: "Export failed", description: String(error), tone: "error" });
    });
  }, [canExport, dataRows, exportFilenameBase, resolvedColumns]);

  // Copy actions place the same bytes the export path would write onto the
  // clipboard (TSV stands in for XLSX, which is a binary format). Clipboard
  // writes work in the Tauri WebView, unlike anchor downloads.
  const copyText = useCallback(async (content: string, label: string) => {
    try {
      await navigator.clipboard.writeText(content);
      emitAppToast({
        title: `Copied as ${label}`,
        description: `${dataRows.length.toLocaleString()} row${dataRows.length === 1 ? "" : "s"} on the clipboard.`,
        tone: "success",
      });
    } catch (error) {
      emitAppToast({ title: "Copy failed", description: String(error), tone: "error" });
    }
  }, [dataRows.length]);

  const handleCopyCSV = useCallback(() => {
    const cols = resolvedColumns.map((c) => c.name);
    void copyText(buildCsvContent(cols, dataRows), "CSV");
  }, [copyText, dataRows, resolvedColumns]);

  const handleCopyTSV = useCallback(() => {
    const cols = resolvedColumns.map((c) => c.name);
    void copyText(buildTsvContent(cols, dataRows), "TSV");
  }, [copyText, dataRows, resolvedColumns]);

  const handleCopyJSON = useCallback(() => {
    const cols = resolvedColumns.map((c) => c.name);
    void copyText(buildJsonContent(cols, dataRows), "JSON");
  }, [copyText, dataRows, resolvedColumns]);

  const handleCopyMQL = useCallback(() => {
    void copyText(
      buildMqlContent({
        collectionName: tableName,
        databaseName: database,
        columns: resolvedColumns.map((c) => c.name),
        rows: dataRows,
      }),
      "MQL",
    );
  }, [copyText, dataRows, database, resolvedColumns, tableName]);

  const handleCopyPlugin = useCallback((format: RuntimePluginFormat) => {
    void copyText(
      serializePluginFormat(
        format,
        resolvedColumns.map((column) => column.name),
        dataRows,
      ),
      format.label,
    );
  }, [copyText, dataRows, resolvedColumns]);

  return (
    <div className="datagrid-topbar">
      {filterControl}

      {externalResult?.truncated && (
        <span
          className="datagrid-stat-pill"
          title={`The database returned the first ${dataRows.length.toLocaleString()} rows only. Refine the query (add LIMIT, filters or pagination) to see the rest.`}
        >
          Results capped at {dataRows.length.toLocaleString()} rows
        </span>
      )}

      <div className="datagrid-topbar-side">
        {stagedChangeCount > 0 && (
          <span className="datagrid-stat-pill staged-change-badge" title="Staged changes pending">
            {stagedChangeCount} staged
          </span>
        )}

        <div className="datagrid-topbar-actions">
          {isTableEditable && structureStatus === "ready" && (
            <span
              className="popover-container"
              data-popover="Insert new row"
            >
              <button
                type="button"
                className="datagrid-footer-action"
                onClick={() => void handleInsertRow()}
                title="Insert new row"
              >
                <Plus className="!w-3.5 !h-3.5" />
                <span>Insert Row</span>
              </button>
            </span>
          )}

          {isTableEditable && canImportCsv && tableName && (
            <span
              className="popover-container"
              data-popover="Paste rows from clipboard (TSV/CSV)"
            >
              <button
                type="button"
                className="datagrid-footer-action"
                onClick={() => void onPasteRows?.()}
                title="Paste rows from clipboard (Ctrl+Shift+V)"
              >
                <ClipboardPaste className="!w-3.5 !h-3.5" />
                <span>Paste Rows</span>
              </button>
            </span>
          )}
          {isTableEditable && canImportCsv && tableName && (
            <button type="button" className="datagrid-footer-action" onClick={() => void onImportCsv?.()} title="Import CSV file">
              <FileUp className="!w-3.5 !h-3.5" />
              <span>Import CSV</span>
            </button>
          )}

          {selectedRowCount > 0 && tableName && (
            <span ref={sqlBtnRef} className="popover-container" data-popover={`Copy ${selectedRowCount} selected row${selectedRowCount > 1 ? "s" : ""} as SQL`}>
              <button
                type="button"
                className={`datagrid-footer-action ${showSqlMenu ? "active" : ""}`}
                onClick={() => {
                  setShowSqlMenu((v) => !v);
                  setShowExportMenu(false);
                  setShowCopyMenu(false);
                  setShowSortMenu(false);
                  setShowSettings(false);
                }}
                title="Copy selected rows as SQL"
              >
                <Braces className="!w-3.5 !h-3.5" />
                <span>SQL</span>
                <ChevronDown className="!w-3 !h-3" />
              </button>
            </span>
          )}

          {undoableChanges > 0 && tableName && (
            <>
              <button
                type="button"
                className="datagrid-footer-action"
                onClick={() => window.dispatchEvent(new CustomEvent("datagrid-undo"))}
                title="Undo (Ctrl+Z)"
              >
                <Undo2 className="!w-3.5 !h-3.5" />
                <span>Undo</span>
              </button>
              <button
                type="button"
                className="datagrid-footer-action"
                onClick={() => window.dispatchEvent(new CustomEvent("datagrid-redo"))}
                title="Redo (Ctrl+Y)"
              >
                <Redo2 className="!w-3.5 !h-3.5" />
                <span>Redo</span>
              </button>
            </>
          )}

          {stagedChangeCount > 0 && (
            <span className="popover-container" data-popover={`${stagedChangeCount} change${stagedChangeCount > 1 ? "s" : ""} staged — preview before applying`}>
              <button
                type="button"
                className="datagrid-footer-action active"
                onClick={() => void onApplyChanges?.()}
                title="Apply all staged changes"
              >
                <Settings2 className="!w-3.5 !h-3.5" />
                <span>Apply {stagedChangeCount}</span>
              </button>
              <button
                type="button"
                className="datagrid-footer-action danger"
                onClick={() => void onDiscardChanges?.()}
                title="Discard all staged changes"
              >
                <X className="!w-3.5 !h-3.5" />
                <span>Discard</span>
              </button>
            </span>
          )}

          {useMemo(() => {
            if (!showSqlMenu || !sqlBtnRef.current) return null;
            const rect = sqlBtnRef.current.getBoundingClientRect();
            const top = rect.bottom + 6;
            const right = window.innerWidth - rect.right;
            const hasPk = (primaryKeyColumns?.length ?? 0) > 0;
            const sqlOptions: Array<{ label: string; hint: string; icon: typeof Braces; run: () => void }> = [
              { label: "INSERT", hint: "For the selected rows", icon: Copy, run: () => void handleCopyAsInsert() },
              { label: "UPDATE", hint: "For the selected rows", icon: FilePen, run: () => void handleCopyAsUpdate() },
              { label: "INSERT $.", hint: "Parameterized placeholders", icon: Braces, run: () => void handleCopyAsInsertParam() },
              { label: "UPDATE $.", hint: "Parameterized placeholders", icon: Braces, run: () => void handleCopyAsUpdateParam() },
              ...(hasPk
                ? [{ label: "DELETE $.", hint: "By primary key placeholders", icon: Braces, run: () => void handleCopyAsDeleteParam() }]
                : []),
            ];
            const sqlMenu = (
              <div className="datagrid-export-menu" style={{ position: "fixed", top, right, zIndex: 9999 }}>
                {sqlOptions.map((opt) => {
                  const OptIcon = opt.icon;
                  return (
                    <button
                      key={opt.label}
                      type="button"
                      className="datagrid-export-menu-item"
                      onClick={() => {
                        opt.run();
                        setShowSqlMenu(false);
                      }}
                    >
                      <OptIcon className="!w-4 !h-4" />
                      <span className="datagrid-export-menu-copy">
                        <strong>{opt.label}</strong>
                        <span>{opt.hint}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            );
            return createPortal(sqlMenu, document.body);
          }, [
            showSqlMenu,
            primaryKeyColumns,
            handleCopyAsInsert,
            handleCopyAsUpdate,
            handleCopyAsInsertParam,
            handleCopyAsUpdateParam,
            handleCopyAsDeleteParam,
          ])}

          <span ref={exportBtnRef} className="popover-container" data-popover={canExport ? "Export data" : "No data to export"}>
            <button
              type="button"
              className={`datagrid-footer-action ${showExportMenu ? "active" : ""}`}
              onClick={() => {
                setShowExportMenu((v) => !v);
                setShowSqlMenu(false);
                setShowCopyMenu(false);
                setShowSortMenu(false);
                setShowSettings(false);
              }}
              disabled={!canExport || isExportingFull}
              title="Export data"
            >
              {isExportingFull ? <Loader2 className="!w-3.5 !h-3.5 animate-spin" /> : <Download className="!w-3.5 !h-3.5" />}
              <span>{isExportingFull ? `${exportedRowCount.toLocaleString()} rows` : "Export"}</span>
              <ChevronDown className="!w-3 !h-3" />
            </button>
          </span>
          <span ref={copyBtnRef} className="popover-container" data-popover={canExport ? "Copy data to clipboard" : "No data to copy"}>
            <button
              type="button"
              className={`datagrid-footer-action datagrid-icon-action ${showCopyMenu ? "active" : ""}`}
              onClick={() => {
                setShowCopyMenu((v) => !v);
                setShowSqlMenu(false);
                setShowExportMenu(false);
                setShowSortMenu(false);
                setShowSettings(false);
              }}
              disabled={!canExport}
              title="Copy data to clipboard"
              aria-label="Copy data to clipboard"
            >
              <Copy className="!w-3.5 !h-3.5" />
            </button>
          </span>
          <span ref={sortBtnRef} className="popover-container" data-popover={sortMenuHint}>
            <button
              type="button"
              className={`datagrid-footer-action ${showSortMenu ? "active" : ""}`}
              onClick={() => {
                setShowSortMenu((v) => !v);
                setShowSqlMenu(false);
                setShowExportMenu(false);
                setShowCopyMenu(false);
                setShowSettings(false);
              }}
              title="Sort rows"
              aria-haspopup="menu"
              aria-expanded={showSortMenu}
            >
              <ArrowUpDown className="!w-3.5 !h-3.5" />
              {sortSummary && <span>{sortSummary}</span>}
              <ChevronDown className="!w-3 !h-3" />
            </button>
          </span>
          {onReloadData && (
            <button
              type="button"
              className="datagrid-footer-action datagrid-icon-action"
              onClick={() => void onReloadData()}
              disabled={isReloadingData}
              title="Reload data"
              aria-label="Reload data"
            >
              {isReloadingData ? (
                <Loader2 className="!w-3.5 !h-3.5 animate-spin" />
              ) : (
                <RefreshCw className="!w-3.5 !h-3.5" />
              )}
            </button>
          )}
          {isExportingFull && onCancelExport && (
            <button
              type="button"
              className="datagrid-footer-action danger"
              onClick={onCancelExport}
              title="Cancel full table export"
            >
              <X className="!w-3.5 !h-3.5" />
              <span>Stop export</span>
            </button>
          )}

          {useMemo(() => {
            if (!showExportMenu || !exportBtnRef.current) return null;
            const rect = exportBtnRef.current.getBoundingClientRect();
            const top = rect.bottom + 6;
            const right = window.innerWidth - rect.right;
            const exportOptions: Array<{ label: string; hint: string; icon: typeof FileSpreadsheet; run: () => void }> = [
              { label: tableName && onExportFull ? "Full CSV" : "CSV", hint: "Comma-separated values", icon: FileSpreadsheet, run: handleExportCSV },
              { label: tableName && onExportFull ? "Full JSONL" : "JSON", hint: "JSON Lines", icon: FileJson, run: handleExportJSON },
              { label: "XLSX", hint: "Excel workbook", icon: FileSpreadsheet, run: handleExportXLSX },
              { label: "MQL", hint: "Mongo shell script", icon: FileCode, run: () => void handleExportMQL() },
              ...pluginFormats.map((format) => ({
                label: format.label,
                hint: format.description || `${format.pluginName} plugin`,
                icon: FileCode,
                run: () => handlePluginExport(format),
              })),
            ];
            const menu = (
              <div className="datagrid-export-menu" style={{ position: "fixed", top, right, zIndex: 9999 }}>
                {exportOptions.map((opt) => {
                  const OptIcon = opt.icon;
                  return (
                    <button
                      key={opt.label}
                      type="button"
                      className="datagrid-export-menu-item"
                      onClick={() => {
                        opt.run();
                        setShowExportMenu(false);
                      }}
                    >
                      <OptIcon className="!w-4 !h-4" />
                      <span className="datagrid-export-menu-copy">
                        <strong>{opt.label}</strong>
                        <span>{opt.hint}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            );
            return createPortal(menu, document.body);
          }, [
            showExportMenu,
            pluginFormats,
            handleExportCSV,
            handleExportJSON,
            handleExportXLSX,
            handleExportMQL,
            handlePluginExport,
            onExportFull,
            tableName,
          ])}

          {useMemo(() => {
            if (!showCopyMenu || !copyBtnRef.current) return null;
            const rect = copyBtnRef.current.getBoundingClientRect();
            const top = rect.bottom + 6;
            const right = window.innerWidth - rect.right;
            const copyOptions: Array<{ label: string; hint: string; icon: typeof FileSpreadsheet; run: () => void }> = [
              { label: "CSV", hint: "Comma + header row", icon: FileSpreadsheet, run: handleCopyCSV },
              { label: "TSV", hint: "Tab-separated", icon: FileSpreadsheet, run: handleCopyTSV },
              { label: "JSON", hint: "One object per row", icon: FileJson, run: handleCopyJSON },
              { label: "MQL", hint: "Mongo shell inserts", icon: FileCode, run: handleCopyMQL },
              ...pluginFormats.map((format) => ({
                label: format.label,
                hint: format.description || `${format.pluginName} plugin`,
                icon: FileCode,
                run: () => handleCopyPlugin(format),
              })),
            ];
            const copyMenu = (
              <div className="datagrid-export-menu" style={{ position: "fixed", top, right, zIndex: 9999 }}>
                {copyOptions.map((opt) => {
                  const OptIcon = opt.icon;
                  return (
                    <button
                      key={opt.label}
                      type="button"
                      className="datagrid-export-menu-item"
                      onClick={() => {
                        opt.run();
                        setShowCopyMenu(false);
                      }}
                    >
                      <OptIcon className="!w-4 !h-4" />
                      <span className="datagrid-export-menu-copy">
                        <strong>{opt.label}</strong>
                        <span>{opt.hint}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            );
            return createPortal(copyMenu, document.body);
          }, [
            showCopyMenu,
            pluginFormats,
            handleCopyCSV,
            handleCopyTSV,
            handleCopyJSON,
            handleCopyMQL,
            handleCopyPlugin,
          ])}

          {useMemo(() => {
            if (!showSortMenu || !sortBtnRef.current || resolvedColumns.length === 0) return null;
            const rect = sortBtnRef.current.getBoundingClientRect();
            const top = rect.bottom + 6;
            const right = window.innerWidth - rect.right;
            const sortMenu = (
              <div className="datagrid-export-menu datagrid-sort-menu" style={{ position: "fixed", top, right, zIndex: 9999 }}>
                {resolvedColumns.map((col) => {
                  const entry = multiSort.find((item) => item.column === col.name);
                  const isSingle = sortColumn === col.name;
                  const label = entry
                    ? `${col.name} ${entry.direction === "ASC" ? "↑" : "↓"}${entry.priority}`
                    : isSingle
                      ? `${col.name} ${sortDir === "ASC" ? "↑" : "↓"}`
                      : col.name;
                  return (
                    <button
                      key={col.name}
                      type="button"
                      className={`datagrid-sort-menu-item${entry || isSingle ? " active" : ""}`}
                      onClick={() => {
                        onSortColumn?.(col.name);
                        setShowSortMenu(false);
                      }}
                    >
                      <ArrowUpDown className="!w-3.5 !h-3.5" />
                      <span>{label}</span>
                    </button>
                  );
                })}
                {(sortColumn || multiSort.length > 0) && (
                  <button
                    type="button"
                    className="datagrid-sort-menu-item danger"
                    onClick={() => {
                      onClearMultiSort?.();
                      onSortColumn?.("");
                      setShowSortMenu(false);
                    }}
                  >
                    <X className="!w-3.5 !h-3.5" />
                    <span>Clear sort</span>
                  </button>
                )}
              </div>
            );
            return createPortal(sortMenu, document.body);
          }, [
            showSortMenu,
            resolvedColumns,
            sortColumn,
            sortDir,
            multiSort,
            onSortColumn,
            onClearMultiSort,
          ])}

          {selectedRowCount > 0 && tableName && (
            <span
              className="popover-container"
              data-popover={`Delete ${selectedRowCount} selected row${selectedRowCount > 1 ? "s" : ""}`}
            >
              <button
                type="button"
                className="datagrid-footer-action danger datagrid-icon-action"
                onClick={() => void handleDeleteSelectedRows()}
                disabled={isDeletingRows}
                title={`Delete ${selectedRowCount} selected row${selectedRowCount > 1 ? "s" : ""}`}
                aria-label={`Delete ${selectedRowCount} selected row${selectedRowCount > 1 ? "s" : ""}`}
              >
                {isDeletingRows ? (
                  <Loader2 className="!w-3.5 !h-3.5 animate-spin" />
                ) : (
                  <Trash2 className="!w-3.5 !h-3.5" />
                )}
              </button>
            </span>
          )}

          <span
            ref={settingsBtnRef}
            className="popover-container"
            data-popover="Data grid settings"
          >
            <button
              type="button"
              className={`datagrid-footer-action ${showSettings ? "active" : ""}`}
              onClick={() => {
                setShowSettings((v) => !v);
                setShowSqlMenu(false);
                setShowExportMenu(false);
                setShowCopyMenu(false);
                setShowSortMenu(false);
              }}
              title="Data grid settings"
            >
              <Settings2 className="!w-3.5 !h-3.5" />
            </button>
          </span>

          {useMemo(() => {
            if (!showSettings || !settingsBtnRef.current) return null;
            const rect = settingsBtnRef.current.getBoundingClientRect();
            const top = rect.bottom + 6;
            const right = window.innerWidth - rect.right;
            const popoverContent = (
              <div
                className="datagrid-settings-popover"
                style={{ position: "fixed", top, right, zIndex: 9999 }}
              >
                <div className="datagrid-settings-popover-header">
                  <span className="datagrid-settings-popover-title">Grid Settings</span>
                  <button
                    type="button"
                    className="datagrid-settings-popover-close"
                    onClick={() => setShowSettings(false)}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
                <div className="datagrid-settings-section">
                  <label className="datagrid-settings-label">NULL display</label>
                  <input
                    type="text"
                    className="datagrid-settings-input"
                    value={settings.nullPlaceholder}
                    maxLength={20}
                    onChange={(e) => updateSettings({ nullPlaceholder: e.target.value })}
                    placeholder="NULL"
                  />
                </div>
                <div className="datagrid-settings-section">
                  <label className="datagrid-settings-label">Row height</label>
                  <div className="datagrid-settings-row">
                    {(["small", "medium", "large"] as const).map((size) => (
                      <button
                        key={size}
                        type="button"
                        className={`datagrid-settings-toggle ${settings.rowHeight === size ? "active" : ""}`}
                        onClick={() => updateSettings({ rowHeight: size })}
                      >
                        {size.charAt(0).toUpperCase() + size.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="datagrid-settings-section">
                  <label className="datagrid-settings-label">Alternating rows</label>
                  <button
                    type="button"
                    className={`datagrid-settings-toggle ${settings.alternatingRows ? "active" : ""}`}
                    onClick={() => updateSettings({ alternatingRows: !settings.alternatingRows })}
                  >
                    {settings.alternatingRows ? "On" : "Off"}
                  </button>
                </div>
              </div>
            );
            return createPortal(popoverContent, document.body);
          }, [showSettings, settings, updateSettings])}
        </div>

        {/* View mode toggle: Table / Chart (after the action buttons) */}
        <div className="datachart-toggle-group datagrid-view-toggle">
          <button
            type="button"
            className={`datachart-toggle-btn${viewMode === "table" ? " active" : ""}`}
            onClick={() => onViewModeChange?.("table")}
            title="Table view"
          >
            <List className="!w-3.5 !h-3.5" />
            <span>Table</span>
          </button>
          <button
            type="button"
            className={`datachart-toggle-btn${viewMode === "chart" ? " active" : ""}`}
            onClick={() => onViewModeChange?.("chart")}
            title="Chart view"
          >
            <BarChart3 className="!w-3.5 !h-3.5" />
            <span>Chart</span>
          </button>
        </div>
      </div>
    </div>
  );
}
