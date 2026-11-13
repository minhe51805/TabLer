import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  List,
  Download,
  ChevronDown,
  Search,
  RefreshCw,
  ArrowUpDown,
  BarChart3,
  Wrench,
} from "lucide-react";
import { DataGridMaskIndicator } from "./DataGridMaskIndicator";
import { DataGridAnonymizerModal } from "./dialogs/DataGridAnonymizerModal";
import { DataGridRewindModal } from "./DataGridRewindModal";
import { getRewindCopy } from "./rewind-copy";
import { GenerateTestRowsDialog } from "../GenerateTestRows/GenerateTestRowsDialog";
import { getSeedRowsCopy } from "../GenerateTestRows/seed-rows-copy";
import { DataGridChartModal } from "./DataGridChartModal";
import { getDataGridChartCopy } from "./datagrid-chart-copy";
import { isNumericColumn } from "./chart-utils";
import { APP_EVENTS } from "../../utils/app-events";
import { EventCenter } from "../../stores/event-center";
import type { TableExportFormat } from "../../utils/export-formats";
import { getExportFormatsCopy } from "../../utils/export-formats-copy";
import { useDataGridSettings } from "../../stores/datagrid-settings-store";
import { useI18n } from "../../i18n";
import type { QueryResult } from "../../types";
import type { ResolvedColumn } from "./hooks/useDataGrid";
import type { AnonymizerStrategy } from "../../utils/anonymizer";
import type { DatabaseType } from "../../types/database";
import { getDataGridPowerCopy } from "./datagrid-power-copy";
import { ResultDiffControls } from "../ResultDiff/ResultDiffControls";
import {
  DataGridCopyMenu,
  DataGridExportMenu,
  DataGridRowsMenu,
  DataGridSettingsMenu,
  DataGridSortMenu,
  DataGridSqlMenu,
  DataGridToolsMenu,
} from "./DataGridToolbarMenus";
import { useDataGridToolbarAutoRefreshTicker } from "./hooks/useDataGridAutoRefresh";
import { useDataGridToolbarExportActions } from "./hooks/useDataGridToolbarExportActions";

export type DataGridToolbarMenuId =
  "settings" | "export" | "copy" | "sql" | "sort" | "rows" | "tools";

const EMPTY_RESOLVED_COLUMNS: ResolvedColumn[] = [];
const EMPTY_DATA_ROWS: (string | number | boolean | null)[][] = [];
const EMPTY_MULTI_SORT: Array<{ column: string; direction: "ASC" | "DESC"; priority: number }> = [];

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
  /** Number of pending redoable changes */
  redoableChanges?: number;
  /** Scoped undo handler for the Undo toolbar button */
  onUndo?: () => void;
  /** Scoped redo handler for the Redo toolbar button */
  onRedo?: () => void;
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
  /** Active connection — needed to list/restore its rewind checkpoints.
   *  The Rewind menu entry only appears when a connection id is available. */
  connectionId?: string;
  /** Open the Rewind checkpoint browser. Defaults to the built-in modal when
   *  a connectionId is provided; a caller may supply its own handler instead. */
  onOpenRewind?: () => void;
}

export const DataGridToolbar = React.memo(function DataGridToolbar({
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
  resolvedColumns = EMPTY_RESOLVED_COLUMNS,
  primaryKeyColumns = EMPTY_RESOLVED_COLUMNS,
  dataRows = EMPTY_DATA_ROWS,
  anonymizerRows,
  undoableChanges = 0,
  redoableChanges = 0,
  onUndo,
  onRedo,
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
  multiSort = EMPTY_MULTI_SORT,
  onClearMultiSort,
  onSortColumn,
  autoRefreshMs = 0,
  onAutoRefreshMsChange,
  autoRefreshTick,
  autoRefreshPaused = false,
  autoRefreshBusy = false,
  connectionId,
  onOpenRewind,
  diffResult = null,
  dbType,
  onToggleRowInspector,
  rowInspectorOpen = false,
  maskedColumns,
  onUnmaskColumn,
  onUnmaskAll,
}: DataGridToolbarProps) {
  const [openMenu, setOpenMenu] = useState<DataGridToolbarMenuId | null>(null);
  const [showRewind, setShowRewind] = useState(false);
  const [showAnonymizer, setShowAnonymizer] = useState(false);
  const [showSeedRows, setShowSeedRows] = useState(false);
  const [showChartModal, setShowChartModal] = useState(false);
  const settingsBtnRef = useRef<HTMLSpanElement>(null);
  const exportBtnRef = useRef<HTMLSpanElement>(null);
  const copyBtnRef = useRef<HTMLSpanElement>(null);
  const sqlBtnRef = useRef<HTMLSpanElement>(null);
  const sortBtnRef = useRef<HTMLSpanElement>(null);
  const rowsBtnRef = useRef<HTMLSpanElement>(null);
  const toolsBtnRef = useRef<HTMLSpanElement>(null);
  const { settings, updateSettings } = useDataGridSettings();
  const { t, language } = useI18n();
  const chartCopy = getDataGridChartCopy(language);
  const exportCopy = getExportFormatsCopy(language);
  const powerCopy = getDataGridPowerCopy(language);
  const rewindCopy = getRewindCopy(language);

  const toggleMenu = useCallback((id: DataGridToolbarMenuId) => {
    setOpenMenu((prev) => (prev === id ? null : id));
  }, []);
  const closeMenu = useCallback(() => setOpenMenu(null), []);

  /** True when at least one column can feed a numeric Y axis. */
  const hasNumericColumn = useMemo(
    () =>
      dataRows.length > 0 &&
      resolvedColumns.some((column, index) => isNumericColumn(column, dataRows, index)),
    [resolvedColumns, dataRows],
  );

  const canAutoRefresh = useDataGridToolbarAutoRefreshTicker({
    autoRefreshMs,
    onAutoRefreshMsChange,
    autoRefreshTick,
    autoRefreshPaused,
    autoRefreshBusy,
  });

  /** Rewind entry in the Tools menu: a caller-supplied handler wins, otherwise
   *  the toolbar's own checkpoint modal opens when a connection id is known. */
  const handleOpenRewind = onOpenRewind ?? (connectionId ? () => setShowRewind(true) : undefined);

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

  useEffect(() => {
    if (!openMenu) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && exportBtnRef.current?.contains(target)) return;
      if (target && settingsBtnRef.current?.contains(target)) return;
      if (target && copyBtnRef.current?.contains(target)) return;
      if (target && sqlBtnRef.current?.contains(target)) return;
      if (target && sortBtnRef.current?.contains(target)) return;
      if (target && rowsBtnRef.current?.contains(target)) return;
      if (target && toolsBtnRef.current?.contains(target)) return;
      const inPopover =
        target instanceof Element &&
        target.closest(".datagrid-export-menu, .datagrid-settings-popover");
      if (inPopover) return;
      setOpenMenu(null);
    };
    window.addEventListener("mousedown", handlePointerDown, true);
    return () => window.removeEventListener("mousedown", handlePointerDown, true);
  }, [openMenu]);

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

  const {
    fullFormats,
    pluginFormats,
    canExport,
    handleExportCSV,
    handleExportTSV,
    handleExportJSON,
    handleExportXLSX,
    handleExportMarkdown,
    handleExportXML,
    handleExportNDJSON,
    handleExportHtml,
    handleExportSQL,
    handleExportMQL,
    handlePluginExport,
    handleCopyCSV,
    handleCopyTSV,
    handleCopyMarkdown,
    handleCopyInsert,
    handleCopyJSON,
    handleCopyMQL,
    handleCopyPlugin,
  } = useDataGridToolbarExportActions({
    tableName,
    database,
    dbType,
    resolvedColumns,
    dataRows,
    canExportData,
    onExportFull,
    t,
  });

  return (
    <div className="datagrid-topbar" data-tour="grid-toolbar">
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
          {((isTableEditable && structureStatus === "ready") ||
            (isTableEditable && canImportCsv && tableName)) && (
            <span
              ref={rowsBtnRef}
              className="popover-container"
              data-popover={powerCopy.toolbar.rows}
            >
              <button
                type="button"
                className={`datagrid-footer-action ${openMenu === "rows" ? "active" : ""}`}
                onClick={() => toggleMenu("rows")}
                title={powerCopy.toolbar.rows}
                aria-haspopup="menu"
                aria-expanded={openMenu === "rows"}
              >
                <Plus className="!w-3.5 !h-3.5" />
                <span>{powerCopy.toolbar.rows}</span>
                <ChevronDown className="!w-3 !h-3" />
              </button>
            </span>
          )}

          {selectedRowCount > 0 && tableName && (
            <span
              ref={sqlBtnRef}
              className="popover-container"
              data-popover={t("datagrid.copySelectedSqlPopover", { count: selectedRowCount })}
            >
              <button
                type="button"
                className={`datagrid-footer-action ${openMenu === "sql" ? "active" : ""}`}
                onClick={() => toggleMenu("sql")}
                title={t("datagrid.copySelectedSqlTitle")}
                aria-haspopup="menu"
                aria-expanded={openMenu === "sql"}
              >
                <Braces className="!w-3.5 !h-3.5" />
                <span>SQL</span>
                <ChevronDown className="!w-3 !h-3" />
              </button>
            </span>
          )}

          {(undoableChanges > 0 || redoableChanges > 0) && tableName && (
            <>
              <button
                type="button"
                className="datagrid-footer-action"
                disabled={undoableChanges === 0}
                onClick={() => (onUndo ? onUndo() : EventCenter.emit(APP_EVENTS.datagridUndo))}
                title={t("datagrid.undoTitle")}
              >
                <Undo2 className="!w-3.5 !h-3.5" />
                <span>{t("datagrid.undo")}</span>
              </button>
              <button
                type="button"
                className="datagrid-footer-action"
                disabled={redoableChanges === 0}
                onClick={() => (onRedo ? onRedo() : EventCenter.emit(APP_EVENTS.datagridRedo))}
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
            open={openMenu === "sql"}
            anchorRef={sqlBtnRef}
            hasPk={(primaryKeyColumns?.length ?? 0) > 0}
            t={t}
            onCopyAsInsert={handleCopyAsInsert}
            onCopyAsUpdate={handleCopyAsUpdate}
            onCopyAsInsertParam={handleCopyAsInsertParam}
            onCopyAsUpdateParam={handleCopyAsUpdateParam}
            onCopyAsDeleteParam={handleCopyAsDeleteParam}
            onClose={closeMenu}
          />

          <DataGridRowsMenu
            open={openMenu === "rows"}
            anchorRef={rowsBtnRef}
            canInsert={isTableEditable && structureStatus === "ready"}
            canSeed={isTableEditable && structureStatus === "ready" && Boolean(tableName)}
            canPaste={Boolean(isTableEditable && canImportCsv && tableName)}
            canImportCsv={Boolean(isTableEditable && canImportCsv && tableName)}
            t={t}
            seedLabel={getSeedRowsCopy(language).menuItem}
            onInsertRow={() => void handleInsertRow()}
            onSeedRows={() => setShowSeedRows(true)}
            onPasteRows={() => void onPasteRows?.()}
            onImportCsv={() => void onImportCsv?.()}
            onClose={closeMenu}
          />

          <DataGridToolsMenu
            open={openMenu === "tools"}
            anchorRef={toolsBtnRef}
            canChart={hasNumericColumn}
            canInspect={Boolean(onToggleRowInspector)}
            rowInspectorOpen={rowInspectorOpen}
            canAutoRefresh={canAutoRefresh}
            autoRefreshMs={autoRefreshMs}
            chartCopy={chartCopy}
            powerCopy={powerCopy}
            onChart={() => setShowChartModal(true)}
            onToggleRowInspector={onToggleRowInspector}
            rewindCopy={rewindCopy}
            onOpenRewind={handleOpenRewind}
            onAutoRefreshMsChange={onAutoRefreshMsChange}
            onClose={closeMenu}
          />

          <span
            ref={exportBtnRef}
            className="popover-container"
            data-popover={canExport ? t("datagrid.exportPopover") : t("datagrid.noDataExport")}
          >
            <button
              type="button"
              className={`datagrid-footer-action ${openMenu === "export" ? "active" : ""}`}
              onClick={() => toggleMenu("export")}
              disabled={!canExport || isExportingFull}
              title={t("datagrid.exportTitle")}
              aria-haspopup="menu"
              aria-expanded={openMenu === "export"}
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
              className={`datagrid-footer-action datagrid-icon-action ${openMenu === "copy" ? "active" : ""}`}
              onClick={() => toggleMenu("copy")}
              disabled={!canExport}
              title={t("datagrid.copyDataPopover")}
              aria-label={t("datagrid.copyDataPopover")}
              aria-haspopup="menu"
              aria-expanded={openMenu === "copy"}
            >
              <Copy className="!w-3.5 !h-3.5" />
            </button>
          </span>
          <span ref={sortBtnRef} className="popover-container" data-popover={sortMenuHint}>
            <button
              type="button"
              className={`datagrid-footer-action ${openMenu === "sort" ? "active" : ""}`}
              onClick={() => toggleMenu("sort")}
              title={t("datagrid.sortRows")}
              aria-haspopup="menu"
              aria-expanded={openMenu === "sort"}
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
          {(hasNumericColumn || onToggleRowInspector || canAutoRefresh) && (
            <span
              ref={toolsBtnRef}
              className="popover-container"
              data-popover={powerCopy.toolbar.tools}
            >
              <button
                type="button"
                className={`datagrid-footer-action${autoRefreshMs > 0 ? " active" : ""}${openMenu === "tools" ? " active" : ""}`}
                onClick={() => toggleMenu("tools")}
                title={powerCopy.toolbar.tools}
                aria-haspopup="menu"
                aria-expanded={openMenu === "tools"}
              >
                <Wrench className="!w-3.5 !h-3.5" />
                <span>{powerCopy.toolbar.tools}</span>
                <ChevronDown className="!w-3 !h-3" />
              </button>
            </span>
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
            open={openMenu === "export"}
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
            onClose={closeMenu}
          />

          <DataGridCopyMenu
            open={openMenu === "copy"}
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
            onClose={closeMenu}
          />

          <DataGridSortMenu
            open={openMenu === "sort"}
            anchorRef={sortBtnRef}
            resolvedColumns={resolvedColumns}
            sortColumn={sortColumn}
            sortDir={sortDir}
            multiSort={multiSort}
            t={t}
            onSortColumn={onSortColumn}
            onClearMultiSort={onClearMultiSort}
            onClose={closeMenu}
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
              className={`datagrid-footer-action ${openMenu === "settings" ? "active" : ""}`}
              onClick={() => toggleMenu("settings")}
              title={t("datagrid.settingsTitle")}
              aria-haspopup="menu"
              aria-expanded={openMenu === "settings"}
            >
              <Settings2 className="!w-3.5 !h-3.5" />
            </button>
          </span>

          <DataGridSettingsMenu
            open={openMenu === "settings"}
            anchorRef={settingsBtnRef}
            settings={settings}
            updateSettings={updateSettings}
            t={t}
            onClose={closeMenu}
          />
        </div>

        {/* View mode toggle — inside the actions row so it flows/wraps with
            the buttons instead of detaching as a floating box. */}
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
      {showRewind && connectionId && (
        <DataGridRewindModal
          connectionId={connectionId}
          onClose={() => setShowRewind(false)}
          onRestored={onReloadData}
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
});
