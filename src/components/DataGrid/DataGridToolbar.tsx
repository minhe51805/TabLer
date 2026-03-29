import { Database, Loader2, Trash2 } from "lucide-react";

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
  isTableEditable: boolean;
  structureStatus: "idle" | "loading" | "ready" | "failed";
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
  isTableEditable,
  structureStatus,
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

        {selectedRowCount > 0 && (
          <div className="datagrid-topbar-actions">
            <span className="popover-container" data-popover={`Delete ${selectedRowCount} selected row${selectedRowCount > 1 ? "s" : ""}`}>
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
          </div>
        )}
      </div>
    </div>
  );
}
