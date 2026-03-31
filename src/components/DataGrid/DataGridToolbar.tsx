import { Database, FileJson, FileSpreadsheet, Loader2, Trash2, Undo2, Redo2, Plus, Copy, FilePen } from "lucide-react";
import { exportToCSV, exportToJSON } from "../../utils/export-utils";
import type { ResolvedColumn } from "./hooks/useDataGrid";

interface DataGridToolbarProps {
  tableName?: string;
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
  isTableEditable: boolean;
  structureStatus: "idle" | "loading" | "ready" | "failed";
  /** Column definitions for export (uses resolved display name) */
  resolvedColumns?: ResolvedColumn[];
  /** Raw row data to export (uses same row order as displayed in grid) */
  dataRows?: (string | number | boolean | null)[][];
  /** Number of pending undoable changes */
  undoableChanges?: number;
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
  externalResult,
  columnCount,
  visibleRowCount,
  sortColumn,
  sortDir,
  selectedRowCount,
  isDeletingRows,
  handleDeleteSelectedRows,
  handleInsertRow,
  handleCopyAsInsert,
  handleCopyAsUpdate,
  isTableEditable,
  structureStatus,
  resolvedColumns = [],
  dataRows = [],
  undoableChanges = 0,
}: DataGridToolbarProps) {
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
  const activeSortLabel = sortColumn ? `${sortColumn} ${sortDir}` : "Natural order";

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

  return (
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
          <span className={`datagrid-stat-pill ${sortColumn ? "active" : ""}`}>
            {sortColumn ? activeSortLabel : "Natural order"}
          </span>
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

          {selectedRowCount > 0 && (
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
            </>
          )}

          {undoableChanges > 0 && (
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

          {selectedRowCount > 0 && (
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
        </div>
      </div>
    </div>
  );
}
