import React from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { ExternalLink } from "lucide-react";
import type {
  EditingCell,
  GridCellValue,
  ResolvedColumn,
} from "./hooks/useDataGrid";
import type { ForeignKeyInfo } from "../../types";
import {
  getCellEditorType,
  isGeometryColumn,
  isBlobColumn,
  formatCellValueForDisplay,
  type ColumnDisplayFormat,
} from "./editors";
import { renderGeometryCell } from "../../utils/geometry-renderer";
import { ColumnHeader } from "./DataGridColumnHeader";
import { getFaviconUrl, getUrlDomain, isImageUrl, isUrlCell } from "./urlCellDetection";
import { renderCellEditor, type LookupValue } from "./cellEditorResolver";
import { formatDate, parseDate } from "../../stores/dateFormatStore";

interface EditingDraft {
  current: string;
}

export type { LookupValue };

interface SetSelectedCellFn {
  (
    cell: { row: number; col: number } | null,
    modifiers?: { extend?: boolean; additive?: boolean },
  ): void;
}

interface DataGridColumnsProps {
  resolvedColumns: ResolvedColumn[];
  canSelectRows: boolean;
  canAttemptInlineEdit: boolean;
  selectedRows: Set<number>;
  selectedCell: { row: number; col: number } | null;
  isCellSelected: (row: number, col: number) => boolean;
  editingCell: EditingCell | null;
  editingSeedValue: string;
  savingCell: EditingCell | null;
  sortColumn: string | null;
  sortDir: "ASC" | "DESC";
  /** Absolute offset of the first loaded row; keeps row identity stable across chunks. */
  rowOffset: number;
  /** Maps a filtered visible row back to its source row in the loaded data window. */
  rowIndexMap?: number[];
  copiedCell: string | null;
  editingDraftRef: EditingDraft;
  handleSort: (colName: string, event?: MouseEvent) => void;
  handleRowSelection: (rowIndex: number, event?: Pick<MouseEvent, "shiftKey" | "metaKey" | "ctrlKey">) => void;
  handleToggleSelectAllRows: () => void;
  handleEditorBlur: () => void;
  handleCopyValue: (value: GridCellValue, cellKey: string) => void;
  startEditingCell: (rowIndex: number, colIndex: number) => Promise<void>;
  commitEditingCell: () => Promise<void>;
  cancelEditingCell: () => void;
  structureStatus: "idle" | "loading" | "ready" | "failed";
  assignInputRef: (element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null) => void;
  allVisibleRowsSelected: boolean;
  isBooleanColumn: (column: ResolvedColumn) => boolean;
  setSelectedCell: SetSelectedCellFn;
  /** All foreign keys for the current table */
  foreignKeys?: ForeignKeyInfo[];
  /** Lookup values cache: key = `${table}|${column}`, value = LookupValue[] */
  lookupValuesCache?: Map<string, LookupValue[]>;
  /** Callback to load FK lookup values from backend */
  onLoadLookupValues?: (table: string, column: string) => Promise<LookupValue[]>;
  /** Connection ID for FK lookups */
  connectionId?: string;
  /** Callback when a row index is double-clicked to open the inspector */
  onOpenRowInspector?: (rowIndex: number) => void;
  /** Auto-fit column to content */
  onColumnAutoFit?: (colId: string) => void;
  /** Context menu handler */
  onContextMenu?: (e: React.MouseEvent, type: "cell" | "header" | "row", colName?: string, rowIndex?: number) => void;
  /** Current column sizes (for manual resize) */
  columnSizes?: Record<string, number>;
  /** Multi-column sort state */
  multiSort?: Array<{ column: string; direction: "ASC" | "DESC"; priority: number }>;
  /** NULL display placeholder (e.g. "NULL", "—", "(null)") */
  nullPlaceholder?: string;
  /** Custom date format string for date/datetime/time cells */
  dateFormat?: string;
  /** Database type for default date format fallback */
  dbType?: string;
  /** Custom display formatting overrides per column */
  columnDisplayFormats?: Record<string, ColumnDisplayFormat>;
}

export function buildDataGridColumns({
  resolvedColumns,
  canSelectRows,
  canAttemptInlineEdit,
  selectedRows,
  selectedCell,
  isCellSelected,
  editingCell,
  editingSeedValue,
  savingCell,
  sortColumn,
  sortDir,
  rowOffset,
  rowIndexMap,
  copiedCell,
  editingDraftRef,
  handleSort,
  handleRowSelection,
  handleToggleSelectAllRows,
  handleEditorBlur: _handleEditorBlur,
  startEditingCell,
  commitEditingCell,
  cancelEditingCell,
  structureStatus,
  assignInputRef: _assignInputRef,
  allVisibleRowsSelected,
  isBooleanColumn: _isBooleanColumn,
  handleCopyValue,
  setSelectedCell,
  foreignKeys = [],
  lookupValuesCache,
  onLoadLookupValues,
  connectionId,
  onOpenRowInspector,
  columnSizes,
  multiSort = [],
  nullPlaceholder = "NULL",
  dateFormat,
  dbType: _dbType,
  columnDisplayFormats = {},
}: DataGridColumnsProps): ColumnDef<unknown[], unknown>[] {
  return [
    {
      id: "_row_num",
      header: () =>
        canSelectRows ? (
          <button
            type="button"
            className={`datagrid-index-toggle ${allVisibleRowsSelected ? "active" : ""}`}
            onClick={handleToggleSelectAllRows}
            title={allVisibleRowsSelected ? "Clear selected rows" : "Select all visible rows"}
          >
            #
          </button>
        ) : (
          <span className="datagrid-index-label">#</span>
        ),
      cell: ({ row }) => {
        const sourceRowIndex = rowIndexMap?.[row.index] ?? row.index;
        return canSelectRows ? (
          <button
            type="button"
            className={`datagrid-index-value datagrid-index-selectable ${selectedRows.has(sourceRowIndex) ? "selected" : ""}`}
            onClick={(event) => {
              event.stopPropagation();
              handleRowSelection(sourceRowIndex, event.nativeEvent);
            }}
            onDoubleClick={(event) => {
              event.stopPropagation();
              onOpenRowInspector?.(sourceRowIndex);
            }}
            title={selectedRows.has(sourceRowIndex) ? "Row selected" : "Select row, double-click to inspect"}
          >
            {rowOffset + sourceRowIndex + 1}
          </button>
        ) : (
          <span className="datagrid-index-value">
            {rowOffset + sourceRowIndex + 1}
          </span>
        );
      },
      size: 72,
      minSize: 40,
      maxSize: 800,
    },
    ...resolvedColumns.map((col, idx) => {
      // Per-column invariants hoisted out of the per-cell renderer: these only
      // depend on the column definition, not on individual cells.
      const columnEditorType = getCellEditorType(col, undefined, undefined);
      const isDateColumn =
        columnEditorType === "date" || columnEditorType === "datetime" || columnEditorType === "time";
      const isGeometry = isGeometryColumn(col);
      const isBlob = isBlobColumn(col);
      const displayFormat = columnDisplayFormats[col.name] || "default";
      const isEditableColumn =
        canAttemptInlineEdit && (structureStatus !== "ready" || !col.is_primary_key);

      const multiEntry = multiSort.find((s) => s.column === col.name);
      const headerIsSorted = sortColumn === col.name || !!multiEntry;
      const headerDir: "ASC" | "DESC" = multiEntry ? multiEntry.direction : sortDir;
      const headerPriority = multiEntry ? multiEntry.priority : null;

      return {
      id: col.name,
      size: columnSizes?.[col.name] ?? 150,
      minSize: 40,
      maxSize: 800,
      header: () => (
        <ColumnHeader
          columnName={col.name}
          isPrimaryKey={!!col.is_primary_key}
          isSorted={headerIsSorted}
          dir={headerDir}
          priority={headerPriority}
          onSort={handleSort}
        />
      ),
      accessorFn: (row: unknown[]) => (row as (string | number | boolean | null)[])[idx],
      cell: ({ getValue, row: tableRow }: { getValue: () => unknown; row: { index: number } }) => {
        const value = getValue() as GridCellValue;
        const rowIndex = tableRow.index;
        const sourceRowIndex = rowIndexMap?.[rowIndex] ?? rowIndex;
        const isSelected = isCellSelected(sourceRowIndex, idx);
        const isEditing = editingCell?.row === sourceRowIndex && editingCell?.col === idx;
        const isSaving = savingCell?.row === sourceRowIndex && savingCell?.col === idx;
        const cellKey = `${sourceRowIndex}-${idx}`;
        const stringValue = value === null ? null : String(value);
        const isUrl = isUrlCell(stringValue);
        const isImageCell = isUrl && stringValue !== null && isImageUrl(stringValue);

        // Custom date formatting (date detection hoisted per column)
        let displayValue: string | null = null;
        if (isDateColumn && dateFormat && stringValue !== null) {
          const parsed = parseDate(stringValue);
          displayValue = parsed ? formatDate(parsed, dateFormat) : stringValue;
        }

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
            onMouseDown={(event) => {
              if (!isEditableColumn || isEditing) return;

              const isRepeatSelection =
                selectedCell?.row === sourceRowIndex && selectedCell?.col === idx;
              if (isRepeatSelection || event.detail >= 2) {
                event.preventDefault();
                event.stopPropagation();
                void startEditingCell(sourceRowIndex, idx);
              }
            }}
            onClick={(event) => {
              if (!isEditing) {
                setSelectedCell(
                  { row: sourceRowIndex, col: idx },
                  {
                    extend: event.shiftKey,
                    additive: event.metaKey || event.ctrlKey,
                  },
                );
              }
            }}
            onDoubleClick={() => {
              if (!isEditableColumn) {
                handleCopyValue(value, cellKey);
              }
            }}
          >
            {copiedCell === cellKey && (
              <span className="absolute -top-5 left-1/2 -translate-x-1/2 text-[10px] bg-[var(--accent)] text-[var(--bg-primary)] px-1.5 py-0.5 rounded-md whitespace-nowrap z-10 font-semibold">
                Copied
              </span>
            )}

            {isEditing ? (
              renderCellEditor({
                col,
                value,
                foreignKeys,
                lookupValuesCache,
                onLoadLookupValues,
                connectionId,
                editingSeedValue,
                editingDraftRef,
                commitEditingCell,
                cancelEditingCell,
                dateFormat,
              })
            ) : (
              <>
                {isSaving && (
                  <span className="animate-spin inline-block w-3.5 h-3.5 border-2 border-[var(--accent)] border-t-transparent rounded-full" />
                )}
                {isImageCell && stringValue !== null ? (
                  <div className="datagrid-url-cell">
                    <img
                      src={stringValue}
                      alt=""
                      className="datagrid-cell-thumb"
                      loading="lazy"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = "none";
                      }}
                    />
                    <a
                      href={stringValue}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="datagrid-cell-value datagrid-url-link"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <ExternalLink className="w-2.5! h-2.5!" />
                      <span>{getUrlDomain(stringValue)}</span>
                    </a>
                  </div>
                ) : isUrl && stringValue !== null ? (
                  <div className="datagrid-url-cell">
                    {(() => {
                      const faviconUrl = getFaviconUrl(stringValue);
                      return faviconUrl ? (
                        <img
                          src={faviconUrl}
                          alt=""
                          className="datagrid-cell-thumb datagrid-cell-favicon"
                          loading="lazy"
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.display = "none";
                          }}
                        />
                      ) : null;
                    })()}
                    <a
                      href={stringValue}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="datagrid-cell-value datagrid-url-link"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <ExternalLink className="w-2.5! h-2.5!" />
                      <span>{getUrlDomain(stringValue)}</span>
                    </a>
                  </div>
                ) : isDateColumn && displayValue !== null ? (
                  <span className="datagrid-cell-value datagrid-cell-date" title={`Original: ${stringValue}`}>{displayValue}</span>
                ) : isGeometry && stringValue !== null ? (
                  (() => {
                    const geo = renderGeometryCell(stringValue);
                    return (
                      <span className="datagrid-cell-value" title={stringValue}>
                        {geo.emoji} {geo.display}
                      </span>
                    );
                  })()
                ) : (
                  <span className="datagrid-cell-value" data-null-placeholder={nullPlaceholder}>
                    {value === null
                      ? nullPlaceholder
                      : formatCellValueForDisplay(value, displayFormat, isBlob)}
                  </span>
                )}
              </>
            )}
          </div>
        );
      },
      };
    }),
  ];
}

// Shared ref for the cell editor draft value
export const editingDraftRef: { current: string } = { current: "" };



