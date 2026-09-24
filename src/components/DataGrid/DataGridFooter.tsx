import { X } from "lucide-react";
import type { QueryResult } from "../../types";
import type { AppLanguage, useI18n } from "../../i18n";
import { getDataGridCopy } from "./datagrid-copy";
import type { StructureStatus } from "./hooks/useDataGrid";

/** Status pills under the grid: row counts, sort state, edit readiness, and
 *  the selection count. Rendered inline or portaled into the app statusbar
 *  slot by the parent. */
export function DataGridFooter({
  data,
  visibleRowCount,
  totalRows,
  clientSideOnly,
  tableFilter,
  sortColumn,
  sortDir,
  multiSort,
  tableName,
  isTableEditable,
  structureStatus,
  selectedRowCount,
  language,
  t,
  onClearMultiSort,
}: {
  data: QueryResult | null;
  visibleRowCount: number;
  totalRows: number;
  clientSideOnly: boolean;
  tableFilter: string;
  sortColumn: string | null;
  sortDir: "ASC" | "DESC";
  multiSort: { priority: number; column: string; direction: string }[];
  tableName?: string;
  isTableEditable: boolean;
  structureStatus: StructureStatus;
  selectedRowCount: number;
  language: AppLanguage;
  t: ReturnType<typeof useI18n>["t"];
  onClearMultiSort: () => void;
}) {
  return (
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
            {clientSideOnly && tableFilter.trim() !== "" && (
              <span className="datagrid-footer-pill warning">
                {getDataGridCopy(language).grid.filterLoadedOnly}
              </span>
            )}
            <span
              className={`datagrid-footer-pill${sortColumn || multiSort.length > 0 ? " info" : ""}`}
              title={t("datagrid.rowSortOrderTitle")}
            >
              {sortColumn
                ? `${sortColumn} ${sortDir}`
                : multiSort.length > 0
                  ? multiSort.map((s) => `${s.priority}.${s.column} ${s.direction}`).join(", ")
                  : "Natural order"}
            </span>
            {multiSort.length > 0 && (
              <button
                type="button"
                className="datagrid-sort-clear-btn"
                onClick={onClearMultiSort}
                title={t("datagrid.clearAllSorts")}
              >
                <X className="w-3! h-3!" />
              </button>
            )}
            {tableName && (
              <span className={`datagrid-footer-pill ${isTableEditable ? "info" : ""}`}>
                {isTableEditable
                  ? "Inline edit ready"
                  : structureStatus === "loading"
                    ? t("datagrid.loadingEditMeta")
                    : structureStatus === "idle"
                      ? "Edit on demand"
                      : "Retry edit load"}
              </span>
            )}
            {selectedRowCount > 0 && (
              <span className="datagrid-footer-pill warning">{selectedRowCount} selected</span>
            )}
          </>
        )}
      </div>
    </div>
  );
}
