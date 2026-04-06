import { Database, FileJson, FileSpreadsheet, Loader2, Trash2, Undo2, Redo2, Plus, Copy, FilePen, Terminal, Braces, Settings2, X, FileCode, ClipboardPaste } from "lucide-react";
import { useState, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { exportToCSV, exportToJSON } from "../../utils/export-utils";
import { exportXLSX } from "../../utils/export-xlsx";
import { exportToMQL } from "../../utils/export-mql";
import { useDataGridSettings } from "../../stores/datagrid-settings-store";
import type { ResolvedColumn } from "./hooks/useDataGrid";

interface DataGridToolbarProps {
  tableName?: string;
  database?: string;
  externalResult?: import("../../types").QueryResult;
  columnCount: number;
  visibleRowCount: number;
  sortColumn: string | null;
  sortDir: "ASC" | "DESC";
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
  /** Trigger paste rows from clipboard */
  onPasteRows?: () => void;
  /** Number of pending staged changes in the change tracking queue */
  stagedChangeCount?: number;
  /** Apply all staged changes to the database */
  onApplyChanges?: () => void;
  /** Discard all staged changes */
  onDiscardChanges?: () => void;
}

function buildExportFilename(tableName: string | undefined, extension: string): string {
  const base = tableName
    ? tableName.replace(/[^a-zA-Z0-9_.-]/g, "_").split(".").pop() || tableName
    : "table_export";
  const date = new Date().toISOString().slice(0, 10);
  return `${base}_${date}.${extension}`;
}

export function DataGridToolbar({
  tableName,
  database,
  externalResult,
  columnCount,
  visibleRowCount,
  sortColumn,
  sortDir,
  selectedRowCount,
  multiSort = [],
  onClearMultiSort,
  onPasteRows,
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
}: DataGridToolbarProps) {
  const [showSettings, setShowSettings] = useState(false);
  const settingsBtnRef = useRef<HTMLSpanElement>(null);
  const { settings, updateSettings } = useDataGridSettings();
  const compactQuery = externalResult?.query?.replace(/\s+/g, " ").trim() ?? "";
  const dataViewTitle = tableName ? tableName.split(".").pop() || tableName : "Result set";
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
  const activeSortLabel = sortColumn
    ? sortColumn + " " + sortDir
    : multiSort.length > 0
      ? multiSort
          .map((s) => `${s.priority}.${s.column} ${s.direction}`)
          .join(", ")
      : "Natural order";

  const canExport = resolvedColumns.length > 0 && dataRows.length > 0;
  const exportFilenameBase = tableName
    ? tableName.replace(/[^a-zA-Z0-9_.-]/g, "_").split(".").pop() || tableName
    : "table_export";

  const handleExportCSV = () => {
    if (!canExport) return;
    const cols = resolvedColumns.map((c) => c.name);
    exportToCSV(cols, dataRows, buildExportFilename(exportFilenameBase, "csv"));
  };

  const handleExportJSON = () => {
    if (!canExport) return;
    const cols = resolvedColumns.map((c) => c.name);
    exportToJSON(cols, dataRows, buildExportFilename(exportFilenameBase, "json"));
  };

  const handleExportXLSX = () => {
    if (!canExport) return;
    const cols = resolvedColumns.map((c) => ({ name: c.name, data_type: c.data_type || "" }));
    exportXLSX(
      [{ name: tableName || "Result", columns: cols, rows: dataRows }],
      buildExportFilename(exportFilenameBase, "xlsx"),
    );
  };

  const handleExportMQL = async () => {
    if (!canExport) return;
    const cols = resolvedColumns.map((c) => c.name);
    await exportToMQL({
      collectionName: tableName,
      databaseName: database,
      columns: cols,
      rows: dataRows,
    });
  };

  return (
    <div className="datagrid-topbar">
      <div className="datagrid-topbar-copy">
        <span className="datagrid-topbar-kicker">{tableName ? "Workspace Data" : "Execution Result"}</span>
        <div className="datagrid-topbar-title-row">
          {tableName ? (
            <Database className="w-4 h-4 text-[var(--fintech-green)]" />
          ) : (
            <Terminal className="w-4 h-4 text-[var(--fintech-cyan)]" />
          )}
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
          <span className={`datagrid-stat-pill ${sortColumn || multiSort.length > 0 ? "active" : ""}`}>
            {activeSortLabel}
          </span>
          {multiSort.length > 0 && onClearMultiSort && (
            <button
              type="button"
              className="datagrid-sort-clear-btn"
              onClick={onClearMultiSort}
              title="Clear all sorts"
            >
              <X className="w-3! h-3!" />
            </button>
          )}
          {stagedChangeCount > 0 && (
            <span className="datagrid-stat-pill staged-change-badge" title="Staged changes pending">
              {stagedChangeCount} staged
            </span>
          )}
        </div>

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

          {isTableEditable && tableName && (
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

          {selectedRowCount > 0 && tableName && (
            <>
              <span
                className="popover-container"
                data-popover={`Copy ${selectedRowCount} selected row${selectedRowCount > 1 ? "s" : ""} as INSERT SQL`}
              >
                <button
                  type="button"
                  className="datagrid-footer-action"
                  onClick={() => void handleCopyAsInsert()}
                  title="Copy as INSERT SQL"
                >
                  <Copy className="!w-3.5 !h-3.5" />
                  <span>Copy INSERT</span>
                </button>
              </span>

              <span
                className="popover-container"
                data-popover={`Copy ${selectedRowCount} selected row${selectedRowCount > 1 ? "s" : ""} as UPDATE SQL`}
              >
                <button
                  type="button"
                  className="datagrid-footer-action"
                  onClick={() => void handleCopyAsUpdate()}
                  title="Copy as UPDATE SQL"
                >
                  <FilePen className="!w-3.5 !h-3.5" />
                  <span>Copy UPDATE</span>
                </button>
              </span>

              <span
                className="popover-container"
                data-popover="Copy INSERT SQL with $.columnName placeholders"
              >
                <button
                  type="button"
                  className="datagrid-footer-action"
                  onClick={() => void handleCopyAsInsertParam()}
                  title="Copy parameterized INSERT SQL"
                >
                  <Braces className="!w-3.5 !h-3.5" />
                  <span>INSERT $.</span>
                </button>
              </span>

              <span
                className="popover-container"
                data-popover="Copy UPDATE SQL with $.columnName placeholders"
              >
                <button
                  type="button"
                  className="datagrid-footer-action"
                  onClick={() => void handleCopyAsUpdateParam()}
                  title="Copy parameterized UPDATE SQL"
                >
                  <Braces className="!w-3.5 !h-3.5" />
                  <span>UPDATE $.</span>
                </button>
              </span>

              {selectedRowCount > 0 && tableName && primaryKeyColumns?.length > 0 && (
                <span
                  className="popover-container"
                  data-popover="Copy DELETE SQL with $.columnName placeholders"
                >
                  <button
                    type="button"
                    className="datagrid-footer-action"
                    onClick={() => void handleCopyAsDeleteParam()}
                    title="Copy parameterized DELETE SQL"
                  >
                    <Braces className="!w-3.5 !h-3.5" />
                    <span>DELETE $.</span>
                  </button>
                </span>
              )}
            </>
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

          <span
            className="popover-container"
            data-popover={canExport ? "Export data as CSV" : "No data to export"}
          >
            <button
              type="button"
              className="datagrid-footer-action"
              onClick={handleExportCSV}
              disabled={!canExport}
              title="Export to CSV"
            >
              <FileSpreadsheet className="!w-3.5 !h-3.5" />
              <span>CSV</span>
            </button>
          </span>

          <span
            className="popover-container"
            data-popover={canExport ? "Export data as JSON" : "No data to export"}
          >
            <button
              type="button"
              className="datagrid-footer-action"
              onClick={handleExportJSON}
              disabled={!canExport}
              title="Export to JSON"
            >
              <FileJson className="!w-3.5 !h-3.5" />
              <span>JSON</span>
            </button>
          </span>

          <span
            className="popover-container"
            data-popover={canExport ? "Export data as XLSX (Excel)" : "No data to export"}
          >
            <button
              type="button"
              className="datagrid-footer-action"
              onClick={handleExportXLSX}
              disabled={!canExport}
              title="Export to XLSX (Excel)"
            >
              <FileSpreadsheet className="!w-3.5 !h-3.5" />
              <span>XLSX</span>
            </button>
          </span>

          <span
            className="popover-container"
            data-popover={canExport ? "Export data as MongoDB shell script" : "No data to export"}
          >
            <button
              type="button"
              className="datagrid-footer-action"
              onClick={() => void handleExportMQL()}
              disabled={!canExport}
              title="Export to MQL (MongoDB Shell)"
            >
              <FileCode className="!w-3.5 !h-3.5" />
              <span>MQL</span>
            </button>
          </span>

          {selectedRowCount > 0 && tableName && (
            <span
              className="popover-container"
              data-popover={`Delete ${selectedRowCount} selected row${selectedRowCount > 1 ? "s" : ""}`}
            >
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
              onClick={() => setShowSettings((v) => !v)}
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
      </div>
    </div>
  );
}
