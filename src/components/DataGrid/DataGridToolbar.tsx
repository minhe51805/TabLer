import {
  Loader2,
  Trash2,
  Undo2,
  Redo2,
  Plus,
  Copy,
  Braces,
  Settings2,
  X,
  ClipboardPaste,
  FileUp,
  List,
  BarChart3,
  Download,
  ChevronDown,
  Search,
  RefreshCw,
  Timer,
  ArrowUpDown,
  Dices,
  PanelRight,
} from "lucide-react";
import { DataGridMaskIndicator } from "./DataGridMaskIndicator";
import { DataGridAnonymizerModal } from "./dialogs/DataGridAnonymizerModal";
import { GenerateTestRowsDialog } from "../GenerateTestRows/GenerateTestRowsDialog";
import { getSeedRowsCopy } from "../GenerateTestRows/seed-rows-copy";
import { DataGridChartModal } from "./DataGridChartModal";
import { getDataGridChartCopy } from "./datagrid-chart-copy";
import { isNumericColumn } from "./chart-utils";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildCsvContent,
  buildJsonContent,
  buildMarkdownTableContent,
  buildTsvContent,
  exportToCSV,
  exportToJSON,
  exportToMarkdown,
  exportToNDJSON,
  exportToTSV,
  exportToHtml,
} from "../../utils/export-utils";
import { exportToXML } from "../../utils/export-xml";
import { exportXLSX } from "../../utils/export-xlsx";
import { buildMqlContent, exportToMQL } from "../../utils/export-mql";
import {
  DEFAULT_EXPORT_FORMATS,
  getCompiledExportFormats,
  type ExportFormatInfo,
  type TableExportFormat,
} from "../../utils/export-formats";
import { getExportFormatsCopy } from "../../utils/export-formats-copy";
import { saveExportFile } from "../../utils/tauri-utils";
import { generateInsertSql } from "../../utils/sql-generator";
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
import type { QueryResult } from "../../types";
import type { ResolvedColumn } from "./hooks/useDataGrid";
import type { AnonymizerStrategy } from "../../utils/anonymizer";
import type { DatabaseType } from "../../types/database";
import { getDataGridPowerCopy } from "./datagrid-power-copy";
import { ResultDiffControls } from "../ResultDiff/ResultDiffControls";
import {
  DataGridCopyMenu,
  DataGridExportMenu,
  DataGridRefreshMenu,
  DataGridSettingsMenu,
  DataGridSortMenu,
  DataGridSqlMenu,
} from "./DataGridToolbarMenus";

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
  /** Raw rows for the anonymizer modal — it applies its own salt, so it must
   *  never receive the already-masked view matrix. */
  anonymizerRows?: (string | number | boolean | null)[][];
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
  onExportFull?: (format: TableExportFormat) => void;
  isExportingFull?: boolean;
  exportedRowCount?: number;
  onCancelExport?: () => void;
  /** Current auto-refresh interval in ms; 0 = off. Omit to hide the control. */
  autoRefreshMs?: number;
  /** Change the auto-refresh interval (0 disables). */
  onAutoRefreshMsChange?: (ms: number) => void;
  /** Invoked when the countdown reaches zero — re-runs the current query. */
  autoRefreshTick?: () => void;
  /** Freeze the countdown while true (e.g. background tab). */
  autoRefreshPaused?: boolean;
  /** Skip a tick while a refresh is already in flight. */
  autoRefreshBusy?: boolean;
  /** Full result shown in the grid — feeds the pin/compare result-diff control. */
  diffResult?: QueryResult | null;
  /** Dialect for INSERT copy generation. */
  dbType?: DatabaseType;
  /** Toggle the row-detail inspector for the active/selected row. */
  onToggleRowInspector?: () => void;
  /** True while the row inspector panel is open (button active state). */
  rowInspectorOpen?: boolean;
  /** View-time masking: column name → strategy for masked columns. */
  maskedColumns?: Record<string, AnonymizerStrategy>;
  /** Remove the mask rule for one column. */
  onUnmaskColumn?: (column: string) => void;
  /** Remove every mask rule in the current table scope. */
  onUnmaskAll?: () => void;
}

function buildExportFilename(tableName: string | undefined, extension: string): string {
  const base = tableName
    ? tableName
        .replace(/[^a-zA-Z0-9_.-]/g, "_")
        .split(".")
        .pop() || tableName
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
  anonymizerRows,
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
  autoRefreshMs = 0,
  onAutoRefreshMsChange,
  autoRefreshTick,
  autoRefreshPaused = false,
  autoRefreshBusy = false,
  diffResult = null,
  dbType,
  onToggleRowInspector,
  rowInspectorOpen = false,
  maskedColumns,
  onUnmaskColumn,
  onUnmaskAll,
}: DataGridToolbarProps) {
  const [showSettings, setShowSettings] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showCopyMenu, setShowCopyMenu] = useState(false);
  const [showAnonymizer, setShowAnonymizer] = useState(false);
  const [showSeedRows, setShowSeedRows] = useState(false);
  const [showSqlMenu, setShowSqlMenu] = useState(false);
  const [showSortMenu, setShowSortMenu] = useState(false);
  const [showRefreshMenu, setShowRefreshMenu] = useState(false);
  const [showChartModal, setShowChartModal] = useState(false);
  const [autoRefreshRemainingSec, setAutoRefreshRemainingSec] = useState(0);
  const settingsBtnRef = useRef<HTMLSpanElement>(null);
  const exportBtnRef = useRef<HTMLSpanElement>(null);
  const copyBtnRef = useRef<HTMLSpanElement>(null);
  const sqlBtnRef = useRef<HTMLSpanElement>(null);
  const sortBtnRef = useRef<HTMLSpanElement>(null);
  const refreshBtnRef = useRef<HTMLSpanElement>(null);
  const { settings, updateSettings } = useDataGridSettings();
  const { t, language } = useI18n();
  const chartCopy = getDataGridChartCopy(language);
  const exportCopy = getExportFormatsCopy(language);
  // Formats compiled into the backend; parquet is absent when the
  // `parquet-export` cargo feature is off.
  const [fullFormats, setFullFormats] = useState<ExportFormatInfo[]>(DEFAULT_EXPORT_FORMATS);
  useEffect(() => {
    let cancelled = false;
    void getCompiledExportFormats().then((formats) => {
      if (!cancelled) setFullFormats(formats);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const powerCopy = getDataGridPowerCopy(language);

  /** True when at least one column can feed a numeric Y axis. */
  const hasNumericColumn = useMemo(
    () =>
      dataRows.length > 0 &&
      resolvedColumns.some((column, index) => isNumericColumn(column, dataRows, index)),
    [resolvedColumns, dataRows],
  );

  const canAutoRefresh = Boolean(onAutoRefreshMsChange && autoRefreshTick);

  // Countdown ticker: ticks once per second, freezes while the page is hidden
  // or the grid is a background tab, and re-runs the query at zero.
  const autoRefreshTickRef = useRef(autoRefreshTick);
  const autoRefreshPausedRef = useRef(autoRefreshPaused);
  const autoRefreshBusyRef = useRef(autoRefreshBusy);
  useEffect(() => {
    autoRefreshTickRef.current = autoRefreshTick;
    autoRefreshPausedRef.current = autoRefreshPaused;
    autoRefreshBusyRef.current = autoRefreshBusy;
  });
  useEffect(() => {
    if (!canAutoRefresh || autoRefreshMs <= 0) {
      setAutoRefreshRemainingSec(0);
      return;
    }
    let nextRefreshAt = Date.now() + autoRefreshMs;
    setAutoRefreshRemainingSec(Math.ceil(autoRefreshMs / 1000));
    const intervalId = window.setInterval(() => {
      // Hidden page or background tab: push the deadline out instead of
      // burning the countdown, so refresh resumes where it left off.
      if (document.hidden || autoRefreshPausedRef.current) {
        nextRefreshAt += 1000;
        return;
      }
      const remaining = nextRefreshAt - Date.now();
      if (remaining > 0) {
        setAutoRefreshRemainingSec(Math.ceil(remaining / 1000));
        return;
      }
      nextRefreshAt = Date.now() + autoRefreshMs;
      setAutoRefreshRemainingSec(Math.ceil(autoRefreshMs / 1000));
      if (!autoRefreshBusyRef.current) autoRefreshTickRef.current?.();
    }, 1000);
    return () => window.clearInterval(intervalId);
  }, [autoRefreshMs, canAutoRefresh]);
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

  const sortMenuHint =
    multiSort.length > 0
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
    if (
      !showExportMenu &&
      !showSettings &&
      !showCopyMenu &&
      !showSqlMenu &&
      !showSortMenu &&
      !showRefreshMenu
    )
      return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && exportBtnRef.current?.contains(target)) return;
      if (target && settingsBtnRef.current?.contains(target)) return;
      if (target && copyBtnRef.current?.contains(target)) return;
      if (target && sqlBtnRef.current?.contains(target)) return;
      if (target && sortBtnRef.current?.contains(target)) return;
      if (target && refreshBtnRef.current?.contains(target)) return;
      const inPopover =
        target instanceof Element &&
        target.closest(".datagrid-export-menu, .datagrid-settings-popover");
      if (inPopover) return;
      setShowExportMenu(false);
      setShowSettings(false);
      setShowCopyMenu(false);
      setShowSqlMenu(false);
      setShowSortMenu(false);
      setShowRefreshMenu(false);
    };
    window.addEventListener("mousedown", handlePointerDown, true);
    return () => window.removeEventListener("mousedown", handlePointerDown, true);
  }, [showExportMenu, showSettings, showCopyMenu, showSqlMenu, showSortMenu, showRefreshMenu]);

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

  const canExport =
    canExportData &&
    resolvedColumns.length > 0 &&
    (dataRows.length > 0 || Boolean(tableName && onExportFull));
  const exportFilenameBase = tableName
    ? tableName
        .replace(/[^a-zA-Z0-9_.-]/g, "_")
        .split(".")
        .pop() || tableName
    : "table_export";
  const handleExportCSV = useCallback(() => {
    if (!canExport) return;
    const cols = resolvedColumns.map((c) => c.name);
    exportToCSV(cols, dataRows, buildExportFilename(exportFilenameBase, "csv")).catch((error) => {
      emitAppToast({
        title: t("datagrid.exportFailed"),
        description: String(error),
        tone: "error",
      });
    });
  }, [canExport, dataRows, exportFilenameBase, resolvedColumns, t]);

  const handleExportTSV = useCallback(() => {
    if (!canExport) return;
    const cols = resolvedColumns.map((c) => c.name);
    exportToTSV(cols, dataRows, buildExportFilename(exportFilenameBase, "tsv")).catch((error) => {
      emitAppToast({
        title: t("datagrid.exportFailed"),
        description: String(error),
        tone: "error",
      });
    });
  }, [canExport, dataRows, exportFilenameBase, resolvedColumns, t]);
  const handleExportJSON = useCallback(() => {
    if (!canExport) return;
    const cols = resolvedColumns.map((c) => c.name);
    exportToJSON(cols, dataRows, buildExportFilename(exportFilenameBase, "json")).catch((error) => {
      emitAppToast({
        title: t("datagrid.exportFailed"),
        description: String(error),
        tone: "error",
      });
    });
  }, [canExport, dataRows, exportFilenameBase, resolvedColumns, t]);

  const handleExportXLSX = useCallback(async () => {
    if (!canExport) return;
    const cols = resolvedColumns.map((c) => ({ name: c.name, data_type: c.data_type || "" }));
    try {
      await exportXLSX(
        [{ name: tableName || "Result", columns: cols, rows: dataRows }],
        buildExportFilename(exportFilenameBase, "xlsx"),
      );
    } catch (error) {
      emitAppToast({
        title: t("datagrid.exportFailed"),
        description: String(error),
        tone: "error",
      });
    }
  }, [canExport, dataRows, exportFilenameBase, resolvedColumns, tableName, t]);
  const handleExportMarkdown = useCallback(() => {
    if (!canExport) return;
    const cols = resolvedColumns.map((c) => c.name);
    exportToMarkdown(cols, dataRows, buildExportFilename(exportFilenameBase, "md")).catch(
      (error) => {
        emitAppToast({
          title: t("datagrid.exportFailed"),
          description: String(error),
          tone: "error",
        });
      },
    );
  }, [canExport, dataRows, exportFilenameBase, resolvedColumns, t]);

  const handleExportXML = useCallback(() => {
    if (!canExport) return;
    const cols = resolvedColumns.map((c) => c.name);
    exportToXML(cols, dataRows, buildExportFilename(exportFilenameBase, "xml")).catch((error) => {
      emitAppToast({
        title: t("datagrid.exportFailed"),
        description: String(error),
        tone: "error",
      });
    });
  }, [canExport, dataRows, exportFilenameBase, resolvedColumns, t]);

  const handleExportNDJSON = useCallback(() => {
    if (!canExport) return;
    const cols = resolvedColumns.map((c) => c.name);
    exportToNDJSON(cols, dataRows, buildExportFilename(exportFilenameBase, "ndjson")).catch(
      (error) => {
        emitAppToast({
          title: t("datagrid.exportFailed"),
          description: String(error),
          tone: "error",
        });
      },
    );
  }, [canExport, dataRows, exportFilenameBase, resolvedColumns, t]);

  const handleExportHtml = useCallback(() => {
    if (!canExport) return;
    const cols = resolvedColumns.map((c) => c.name);
    exportToHtml(cols, dataRows, buildExportFilename(exportFilenameBase, "html")).catch((error) => {
      emitAppToast({
        title: t("datagrid.exportFailed"),
        description: String(error),
        tone: "error",
      });
    });
  }, [canExport, dataRows, exportFilenameBase, resolvedColumns, t]);

  const handleExportSQL = useCallback(() => {
    if (!canExport || !tableName) return;
    const cols = resolvedColumns.map((c) => c.name);
    saveExportFile({
      fileName: buildExportFilename(exportFilenameBase, "sql"),
      content: generateInsertSql(tableName, cols, dataRows, dbType),
      filters: [{ name: "SQL", extensions: ["sql"] }],
    }).catch((error) => {
      emitAppToast({
        title: t("datagrid.exportFailed"),
        description: String(error),
        tone: "error",
      });
    });
  }, [canExport, dataRows, dbType, exportFilenameBase, resolvedColumns, tableName, t]);
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
      emitAppToast({
        title: t("datagrid.exportFailed"),
        description: String(error),
        tone: "error",
      });
    }
  }, [canExport, dataRows, database, resolvedColumns, tableName, t]);

  const handlePluginExport = useCallback(
    (format: RuntimePluginFormat) => {
      if (!canExport) return;
      downloadPluginFormat(
        format,
        resolvedColumns.map((column) => column.name),
        dataRows,
        buildExportFilename(exportFilenameBase, format.extension),
      ).catch((error) => {
        emitAppToast({
          title: t("datagrid.exportFailed"),
          description: String(error),
          tone: "error",
        });
      });
    },
    [canExport, dataRows, exportFilenameBase, resolvedColumns, t],
  );

  // Copy actions place the same bytes the export path would write onto the
  // clipboard (TSV stands in for XLSX, which is a binary format). Clipboard
  // writes work in the Tauri WebView, unlike anchor downloads.
  const copyText = useCallback(
    async (content: string, label: string) => {
      try {
        await navigator.clipboard.writeText(content);
        emitAppToast({
          title: t("datagrid.copiedTitle", { format: label }),
          description: t("datagrid.copiedDescription", { count: dataRows.length }),
          tone: "success",
        });
      } catch (error) {
        emitAppToast({
          title: t("datagrid.copyFailed"),
          description: String(error),
          tone: "error",
        });
      }
    },
    [dataRows.length, t],
  );

  const handleCopyCSV = useCallback(() => {
    const cols = resolvedColumns.map((c) => c.name);
    void copyText(buildCsvContent(cols, dataRows), "CSV");
  }, [copyText, dataRows, resolvedColumns]);

  const handleCopyTSV = useCallback(() => {
    const cols = resolvedColumns.map((c) => c.name);
    void copyText(buildTsvContent(cols, dataRows), "TSV");
  }, [copyText, dataRows, resolvedColumns]);
  const handleCopyMarkdown = useCallback(() => {
    const cols = resolvedColumns.map((c) => c.name);
    void copyText(buildMarkdownTableContent(cols, dataRows), "Markdown");
  }, [copyText, dataRows, resolvedColumns]);

  const handleCopyInsert = useCallback(() => {
    if (!tableName) return;
    const cols = resolvedColumns.map((c) => c.name);
    void copyText(generateInsertSql(tableName, cols, dataRows, dbType), "INSERT");
  }, [copyText, dataRows, dbType, resolvedColumns, tableName]);

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

  const handleCopyPlugin = useCallback(
    (format: RuntimePluginFormat) => {
      void copyText(
        serializePluginFormat(
          format,
          resolvedColumns.map((column) => column.name),
          dataRows,
        ),
        format.label,
      );
    },
    [copyText, dataRows, resolvedColumns],
  );

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
          <span
            className="datagrid-stat-pill staged-change-badge"
            title={t("datagrid.stagedChangesPending")}
          >
            {t("datagrid.stagedCount", { count: stagedChangeCount })}
          </span>
        )}

        <div className="datagrid-topbar-actions">
          {isTableEditable && structureStatus === "ready" && (
            <span className="popover-container" data-popover={t("datagrid.insertRowTitle")}>
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

          {isTableEditable && structureStatus === "ready" && tableName && (
            <span className="popover-container" data-popover={getSeedRowsCopy(language).menuItem}>
              <button
                type="button"
                className="datagrid-footer-action"
                onClick={() => setShowSeedRows(true)}
                title={getSeedRowsCopy(language).menuItem}
              >
                <Dices className="!w-3.5 !h-3.5" />
                <span>{getSeedRowsCopy(language).menuItem}</span>
              </button>
            </span>
          )}

          {isTableEditable && canImportCsv && tableName && (
            <span className="popover-container" data-popover={t("datagrid.pasteRowsPopover")}>
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
            <button
              type="button"
              className="datagrid-footer-action"
              onClick={() => void onImportCsv?.()}
              title={t("datagrid.importCsvTitle")}
            >
              <FileUp className="!w-3.5 !h-3.5" />
              <span>{t("datagrid.importCsv")}</span>
            </button>
          )}

          {selectedRowCount > 0 && tableName && (
            <span
              ref={sqlBtnRef}
              className="popover-container"
              data-popover={t("datagrid.copySelectedSqlPopover", { count: selectedRowCount })}
            >
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
            <span
              className="popover-container"
              data-popover={t("datagrid.stagedPreviewPopover", { count: stagedChangeCount })}
            >
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

          {maskedColumns && onUnmaskColumn && onUnmaskAll && (
            <DataGridMaskIndicator
              maskedColumns={maskedColumns}
              onUnmaskColumn={onUnmaskColumn}
              onUnmaskAll={onUnmaskAll}
            />
          )}

          <DataGridSqlMenu
            open={showSqlMenu}
            anchorRef={sqlBtnRef}
            hasPk={(primaryKeyColumns?.length ?? 0) > 0}
            t={t}
            onCopyAsInsert={handleCopyAsInsert}
            onCopyAsUpdate={handleCopyAsUpdate}
            onCopyAsInsertParam={handleCopyAsInsertParam}
            onCopyAsUpdateParam={handleCopyAsUpdateParam}
            onCopyAsDeleteParam={handleCopyAsDeleteParam}
            onClose={() => setShowSqlMenu(false)}
          />

          <span
            ref={exportBtnRef}
            className="popover-container"
            data-popover={canExport ? t("datagrid.exportPopover") : t("datagrid.noDataExport")}
          >
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
              {isExportingFull ? (
                <Loader2 className="!w-3.5 !h-3.5 animate-spin" />
              ) : (
                <Download className="!w-3.5 !h-3.5" />
              )}
              <span>
                {isExportingFull
                  ? t("datagrid.exportingRows", { count: exportedRowCount })
                  : t("datagrid.export")}
              </span>
              <ChevronDown className="!w-3 !h-3" />
            </button>
          </span>
          <span
            ref={copyBtnRef}
            className="popover-container"
            data-popover={canExport ? t("datagrid.copyDataPopover") : t("datagrid.noDataCopy")}
          >
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
          {canAutoRefresh && (
            <span
              ref={refreshBtnRef}
              className="popover-container"
              data-popover={chartCopy.autoRefresh.title}
            >
              <button
                type="button"
                className={`datagrid-footer-action${autoRefreshMs > 0 ? " active" : ""}${showRefreshMenu ? " active" : ""}`}
                onClick={() => {
                  setShowRefreshMenu((v) => !v);
                  setShowSqlMenu(false);
                  setShowExportMenu(false);
                  setShowCopyMenu(false);
                  setShowSortMenu(false);
                  setShowSettings(false);
                }}
                title={chartCopy.autoRefresh.title}
                aria-label={chartCopy.autoRefresh.title}
                aria-haspopup="menu"
                aria-expanded={showRefreshMenu}
              >
                <Timer className="!w-3.5 !h-3.5" />
                {autoRefreshMs > 0 && (
                  <span>{chartCopy.autoRefresh.countdown(autoRefreshRemainingSec)}</span>
                )}
                <ChevronDown className="!w-3 !h-3" />
              </button>
            </span>
          )}
          {hasNumericColumn && (
            <button
              type="button"
              className="datagrid-footer-action"
              onClick={() => setShowChartModal(true)}
              title={chartCopy.chart.buttonTitle}
              aria-label={chartCopy.chart.buttonTitle}
            >
              <BarChart3 className="!w-3.5 !h-3.5" />
              <span>{chartCopy.chart.title}</span>
            </button>
          )}
          {onToggleRowInspector && (
            <button
              type="button"
              className={`datagrid-footer-action datagrid-icon-action${rowInspectorOpen ? " active" : ""}`}
              onClick={onToggleRowInspector}
              title={powerCopy.rowInspector.button}
              aria-label={powerCopy.rowInspector.button}
              aria-pressed={rowInspectorOpen}
            >
              <PanelRight className="!w-3.5 !h-3.5" />
            </button>
          )}
          <DataGridRefreshMenu
            open={showRefreshMenu}
            anchorRef={refreshBtnRef}
            autoRefreshMs={autoRefreshMs}
            chartCopy={chartCopy}
            onAutoRefreshMsChange={onAutoRefreshMsChange}
            onClose={() => setShowRefreshMenu(false)}
          />
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
          {isExportingFull && (
            <span
              className="datagrid-export-progress"
              role="progressbar"
              aria-valuetext={t("datagrid.exportingRows", { count: exportedRowCount })}
              title={t("datagrid.exportingRows", { count: exportedRowCount })}
            >
              <span className="datagrid-export-progress-fill" />
            </span>
          )}

          <DataGridExportMenu
            open={showExportMenu}
            anchorRef={exportBtnRef}
            tableName={tableName}
            onExportFull={onExportFull}
            fullFormats={fullFormats}
            exportCopy={exportCopy}
            pluginFormats={pluginFormats}
            powerCopy={powerCopy}
            t={t}
            onExportCSV={handleExportCSV}
            onExportTSV={handleExportTSV}
            onExportJSON={handleExportJSON}
            onExportXLSX={handleExportXLSX}
            onExportMarkdown={handleExportMarkdown}
            onExportXML={handleExportXML}
            onExportHtml={handleExportHtml}
            onExportNDJSON={handleExportNDJSON}
            onExportSQL={handleExportSQL}
            onExportMQL={handleExportMQL}
            onPluginExport={handlePluginExport}
            onClose={() => setShowExportMenu(false)}
          />

          <DataGridCopyMenu
            open={showCopyMenu}
            anchorRef={copyBtnRef}
            tableName={tableName}
            pluginFormats={pluginFormats}
            powerCopy={powerCopy}
            t={t}
            onCopyCSV={handleCopyCSV}
            onCopyTSV={handleCopyTSV}
            onCopyJSON={handleCopyJSON}
            onCopyMarkdown={handleCopyMarkdown}
            onCopyInsert={handleCopyInsert}
            onCopyMQL={handleCopyMQL}
            onOpenAnonymizer={() => setShowAnonymizer(true)}
            onCopyPlugin={handleCopyPlugin}
            onClose={() => setShowCopyMenu(false)}
          />

          <DataGridSortMenu
            open={showSortMenu}
            anchorRef={sortBtnRef}
            resolvedColumns={resolvedColumns}
            sortColumn={sortColumn}
            sortDir={sortDir}
            multiSort={multiSort}
            t={t}
            onSortColumn={onSortColumn}
            onClearMultiSort={onClearMultiSort}
            onClose={() => setShowSortMenu(false)}
          />

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

          <ResultDiffControls
            result={diffResult}
            label={tableName ?? externalResult?.query ?? "result"}
          />

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

          <DataGridSettingsMenu
            open={showSettings}
            anchorRef={settingsBtnRef}
            settings={settings}
            updateSettings={updateSettings}
            t={t}
            onClose={() => setShowSettings(false)}
          />
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

      {showAnonymizer && (
        <DataGridAnonymizerModal
          columns={resolvedColumns}
          dataRows={anonymizerRows ?? dataRows}
          onClose={() => setShowAnonymizer(false)}
        />
      )}
      {showSeedRows && tableName && (
        <GenerateTestRowsDialog
          tableName={tableName}
          database={database}
          dbType={dbType}
          columns={resolvedColumns}
          onClose={() => setShowSeedRows(false)}
        />
      )}
      {showChartModal && (
        <DataGridChartModal
          resolvedColumns={resolvedColumns}
          rows={dataRows}
          onClose={() => setShowChartModal(false)}
        />
      )}
    </div>
  );
}
