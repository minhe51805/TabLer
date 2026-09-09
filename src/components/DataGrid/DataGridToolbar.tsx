import { FileJson, FileSpreadsheet, Loader2, Trash2, Undo2, Redo2, Plus, Copy, FilePen, Braces, Settings2, X, FileCode, ClipboardPaste, FileUp, List, BarChart3, Download, ChevronDown, Search, RefreshCw, ArrowUpDown } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { buildCsvContent, buildJsonContent, buildTsvContent, exportToCSV, exportToJSON } from "../../utils/export-utils";
import { exportXLSX } from "../../utils/export-xlsx";
import { buildMqlContent, exportToMQL } from "../../utils/export-mql";
import { serializePluginFormat } from "../../utils/plugin-format-runtime";
import { emitAppToast } from "../../utils/app-toast";
import { useDataGridSettings } from "../../stores/datagrid-settings-store";
import { useI18n } from "../../i18n";
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

  const { t } = useI18n();
  const sortMenuHint = multiSort.length > 0
    ? t("datagrid.sortHintMulti")
    : sortColumn
      ? t("datagrid.sortHintBy", { column: sortColumn, direction: sortDir })
      : t("datagrid.sortHintNone");
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
        placeholder={t("datagrid.filterRows")}
        aria-label={t("datagrid.filterRowsAria")}
      />
      {filterValue && (
        <button
          type="button"
          onClick={() => onFilterChange?.("")}
          aria-label={t("datagrid.clearFilterTitle")}
          title={t("datagrid.clearFilterTitle")}
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
      emitAppToast({ title: t("datagrid.exportFailed"), description: String(error), tone: "error" });
    });
  }, [canExport, dataRows, exportFilenameBase, onExportFull, resolvedColumns, tableName, t]);

  const handleExportJSON = useCallback(() => {
    if (!canExport) return;
    if (tableName && onExportFull) {
      onExportFull("jsonl");
      return;
    }
    const cols = resolvedColumns.map((c) => c.name);
    exportToJSON(cols, dataRows, buildExportFilename(exportFilenameBase, "json")).catch((error) => {
      emitAppToast({ title: t("datagrid.exportFailed"), description: String(error), tone: "error" });
    });
  }, [canExport, dataRows, exportFilenameBase, onExportFull, resolvedColumns, tableName, t]);

  const handleExportXLSX = useCallback(async () => {
    if (!canExport) return;
    const cols = resolvedColumns.map((c) => ({ name: c.name, data_type: c.data_type || "" }));
    try {
      await exportXLSX(
        [{ name: tableName || "Result", columns: cols, rows: dataRows }],
        buildExportFilename(exportFilenameBase, "xlsx"),
      );
    } catch (error) {
      emitAppToast({ title: t("datagrid.exportFailed"), description: String(error), tone: "error" });
    }
  }, [canExport, dataRows, exportFilenameBase, resolvedColumns, tableName, t]);

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
      emitAppToast({ title: t("datagrid.exportFailed"), description: String(error), tone: "error" });
    }
  }, [canExport, dataRows, database, resolvedColumns, tableName, t]);

  const handlePluginExport = useCallback((format: RuntimePluginFormat) => {
    if (!canExport) return;
    downloadPluginFormat(
      format,
      resolvedColumns.map((column) => column.name),
      dataRows,
      buildExportFilename(exportFilenameBase, format.extension),
    ).catch((error) => {
      emitAppToast({ title: t("datagrid.exportFailed"), description: String(error), tone: "error" });
    });
  }, [canExport, dataRows, exportFilenameBase, resolvedColumns, t]);

  // Copy actions place the same bytes the export path would write onto the
  // clipboard (TSV stands in for XLSX, which is a binary format). Clipboard
  // writes work in the Tauri WebView, unlike anchor downloads.
  const copyText = useCallback(async (content: string, label: string) => {
    try {
      await navigator.clipboard.writeText(content);
      emitAppToast({
        title: t("datagrid.copiedTitle", { format: label }),
        description: t("datagrid.copiedDescription", { count: dataRows.length }),
        tone: "success",
      });
    } catch (error) {
      emitAppToast({ title: t("datagrid.copyFailed"), description: String(error), tone: "error" });
    }
  }, [dataRows.length, t]);

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
          title={t("datagrid.resultsCappedTitle", { count: dataRows.length })}
        >
          {t("datagrid.resultsCapped", { count: dataRows.length })}
        </span>
      )}

      <div className="datagrid-topbar-side">
        {stagedChangeCount > 0 && (
          <span className="datagrid-stat-pill staged-change-badge" title={t("datagrid.stagedChangesPending")}>
            {t("datagrid.stagedCount", { count: stagedChangeCount })}
          </span>
        )}

        <div className="datagrid-topbar-actions">
          {isTableEditable && structureStatus === "ready" && (
            <span
              className="popover-container"
              data-popover={t("datagrid.insertRowTitle")}
            >
              <button
                type="button"
                className="datagrid-footer-action"
                onClick={() => void handleInsertRow()}
                title={t("datagrid.insertRowTitle")}
              >
                <Plus className="!w-3.5 !h-3.5" />
                <span>{t("datagrid.insertRow")}</span>
              </button>
            </span>
          )}

          {isTableEditable && canImportCsv && tableName && (
            <span
              className="popover-container"
              data-popover={t("datagrid.pasteRowsPopover")}
            >
              <button
                type="button"
                className="datagrid-footer-action"
                onClick={() => void onPasteRows?.()}
                title={t("datagrid.pasteRowsTitle")}
              >
                <ClipboardPaste className="!w-3.5 !h-3.5" />
                <span>{t("datagrid.pasteRows")}</span>
              </button>
            </span>
          )}
          {isTableEditable && canImportCsv && tableName && (
            <button type="button" className="datagrid-footer-action" onClick={() => void onImportCsv?.()} title={t("datagrid.importCsvTitle")}>
              <FileUp className="!w-3.5 !h-3.5" />
              <span>{t("datagrid.importCsv")}</span>
            </button>
          )}

          {selectedRowCount > 0 && tableName && (
            <span ref={sqlBtnRef} className="popover-container" data-popover={t("datagrid.copySelectedSqlPopover", { count: selectedRowCount })}>
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
                title={t("datagrid.copySelectedSqlTitle")}
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
                title={t("datagrid.undoTitle")}
              >
                <Undo2 className="!w-3.5 !h-3.5" />
                <span>{t("datagrid.undo")}</span>
              </button>
              <button
                type="button"
                className="datagrid-footer-action"
                onClick={() => window.dispatchEvent(new CustomEvent("datagrid-redo"))}
                title={t("datagrid.redoTitle")}
              >
                <Redo2 className="!w-3.5 !h-3.5" />
                <span>{t("datagrid.redo")}</span>
              </button>
            </>
          )}

          {stagedChangeCount > 0 && (
            <span className="popover-container" data-popover={t("datagrid.stagedPreviewPopover", { count: stagedChangeCount })}>
              <button
                type="button"
                className="datagrid-footer-action active"
                onClick={() => void onApplyChanges?.()}
                title={t("datagrid.applyTitle")}
              >
                <Settings2 className="!w-3.5 !h-3.5" />
                <span>{t("datagrid.applyCount", { count: stagedChangeCount })}</span>
              </button>
              <button
                type="button"
                className="datagrid-footer-action danger"
                onClick={() => void onDiscardChanges?.()}
                title={t("datagrid.discardTitle")}
              >
                <X className="!w-3.5 !h-3.5" />
                <span>{t("datagrid.discard")}</span>
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
              { label: "INSERT", hint: t("datagrid.sqlInsertHint"), icon: Copy, run: () => void handleCopyAsInsert() },
              { label: "UPDATE", hint: t("datagrid.sqlInsertHint"), icon: FilePen, run: () => void handleCopyAsUpdate() },
              { label: "INSERT $.", hint: t("datagrid.sqlParamHint"), icon: Braces, run: () => void handleCopyAsInsertParam() },
              { label: "UPDATE $.", hint: t("datagrid.sqlParamHint"), icon: Braces, run: () => void handleCopyAsUpdateParam() },
              ...(hasPk
                ? [{ label: "DELETE $.", hint: t("datagrid.sqlDeleteHint"), icon: Braces, run: () => void handleCopyAsDeleteParam() }]
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
            t,
          ])}

          <span ref={exportBtnRef} className="popover-container" data-popover={canExport ? t("datagrid.exportPopover") : t("datagrid.noDataExport")}>
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
              title={t("datagrid.exportTitle")}
            >
              {isExportingFull ? <Loader2 className="!w-3.5 !h-3.5 animate-spin" /> : <Download className="!w-3.5 !h-3.5" />}
              <span>{isExportingFull ? t("datagrid.exportingRows", { count: exportedRowCount }) : t("datagrid.export")}</span>
              <ChevronDown className="!w-3 !h-3" />
            </button>
          </span>
          <span ref={copyBtnRef} className="popover-container" data-popover={canExport ? t("datagrid.copyDataPopover") : t("datagrid.noDataCopy")}>
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
              title={t("datagrid.copyDataPopover")}
              aria-label={t("datagrid.copyDataPopover")}
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
              title={t("datagrid.sortRows")}
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
              title={t("datagrid.reloadData")}
              aria-label={t("datagrid.reloadData")}
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
              title={t("datagrid.cancelExportTitle")}
            >
              <X className="!w-3.5 !h-3.5" />
              <span>{t("datagrid.stopExport")}</span>
            </button>
          )}

          {useMemo(() => {
            if (!showExportMenu || !exportBtnRef.current) return null;
            const rect = exportBtnRef.current.getBoundingClientRect();
            const top = rect.bottom + 6;
            const right = window.innerWidth - rect.right;
            const exportOptions: Array<{ label: string; hint: string; icon: typeof FileSpreadsheet; run: () => void }> = [
              { label: tableName && onExportFull ? t("datagrid.exportFullCsv") : "CSV", hint: t("datagrid.exportHintCsv"), icon: FileSpreadsheet, run: handleExportCSV },
              { label: tableName && onExportFull ? t("datagrid.exportFullJsonl") : "JSON", hint: t("datagrid.exportHintJson"), icon: FileJson, run: handleExportJSON },
              { label: "XLSX", hint: t("datagrid.exportHintXlsx"), icon: FileSpreadsheet, run: handleExportXLSX },
              { label: "MQL", hint: t("datagrid.exportHintMql"), icon: FileCode, run: () => void handleExportMQL() },
              ...pluginFormats.map((format) => ({
                label: format.label,
                hint: format.description || t("datagrid.exportHintPlugin", { plugin: format.pluginName }),
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
            t,
          ])}

          {useMemo(() => {
            if (!showCopyMenu || !copyBtnRef.current) return null;
            const rect = copyBtnRef.current.getBoundingClientRect();
            const top = rect.bottom + 6;
            const right = window.innerWidth - rect.right;
            const copyOptions: Array<{ label: string; hint: string; icon: typeof FileSpreadsheet; run: () => void }> = [
              { label: "CSV", hint: t("datagrid.copyHintCsv"), icon: FileSpreadsheet, run: handleCopyCSV },
              { label: "TSV", hint: t("datagrid.copyHintTsv"), icon: FileSpreadsheet, run: handleCopyTSV },
              { label: "JSON", hint: t("datagrid.copyHintJson"), icon: FileJson, run: handleCopyJSON },
              { label: "MQL", hint: t("datagrid.copyHintMql"), icon: FileCode, run: handleCopyMQL },
              ...pluginFormats.map((format) => ({
                label: format.label,
                hint: format.description || t("datagrid.exportHintPlugin", { plugin: format.pluginName }),
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
            t,
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
                    <span>{t("datagrid.clearSort")}</span>
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
            t,
          ])}

          {selectedRowCount > 0 && tableName && (
            <span
              className="popover-container"
              data-popover={t("datagrid.deleteSelectedPopover", { count: selectedRowCount })}
            >
              <button
                type="button"
                className="datagrid-footer-action danger datagrid-icon-action"
                onClick={() => void handleDeleteSelectedRows()}
                disabled={isDeletingRows}
                title={t("datagrid.deleteSelectedTitle", { count: selectedRowCount })}
                aria-label={t("datagrid.deleteSelectedTitle", { count: selectedRowCount })}
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
            data-popover={t("datagrid.settingsPopover")}
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
              title={t("datagrid.settingsTitle")}
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
                  <span className="datagrid-settings-popover-title">{t("datagrid.gridSettings")}</span>
                  <button
                    type="button"
                    className="datagrid-settings-popover-close"
                    onClick={() => setShowSettings(false)}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
                <div className="datagrid-settings-section">
                  <label className="datagrid-settings-label">{t("datagrid.nullDisplay")}</label>
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
                  <label className="datagrid-settings-label">{t("datagrid.rowHeight")}</label>
                  <div className="datagrid-settings-row">
                    {(["small", "medium", "large"] as const).map((size) => (
                      <button
                        key={size}
                        type="button"
                        className={`datagrid-settings-toggle ${settings.rowHeight === size ? "active" : ""}`}
                        onClick={() => updateSettings({ rowHeight: size })}
                      >
                        {t(size === "small" ? "datagrid.sizeSmall" : size === "medium" ? "datagrid.sizeMedium" : "datagrid.sizeLarge")}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="datagrid-settings-section">
                  <label className="datagrid-settings-label">{t("datagrid.alternatingRows")}</label>
                  <button
                    type="button"
                    className={`datagrid-settings-toggle ${settings.alternatingRows ? "active" : ""}`}
                    onClick={() => updateSettings({ alternatingRows: !settings.alternatingRows })}
                  >
                    {t(settings.alternatingRows ? "datagrid.on" : "datagrid.off")}
                  </button>
                </div>
              </div>
            );
            return createPortal(popoverContent, document.body);
          }, [showSettings, settings, updateSettings, t])}
        </div>

        {/* View mode toggle: Table / Chart (after the action buttons) */}
        <div className="datachart-toggle-group datagrid-view-toggle">
          <button
            type="button"
            className={`datachart-toggle-btn${viewMode === "table" ? " active" : ""}`}
            onClick={() => onViewModeChange?.("table")}
            title={t("datagrid.tableView")}
          >
            <List className="!w-3.5 !h-3.5" />
            <span>{t("datagrid.table")}</span>
          </button>
          <button
            type="button"
            className={`datachart-toggle-btn${viewMode === "chart" ? " active" : ""}`}
            onClick={() => onViewModeChange?.("chart")}
            title={t("datagrid.chartView")}
          >
            <BarChart3 className="!w-3.5 !h-3.5" />
            <span>{t("datagrid.chart")}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
