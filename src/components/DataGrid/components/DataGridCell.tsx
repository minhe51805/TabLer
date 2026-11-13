import React, { useContext } from "react";
import { ExternalLink } from "lucide-react";
import type { ForeignKeyInfo } from "../../../types";
import { getCurrentAppLanguage } from "../../../i18n";
import { formatDate, parseDate } from "../../../stores/dateFormatStore";
import { renderGeometryCell } from "../../../utils/geometry-renderer";
import { renderCellEditor, type LookupValue } from "../cellEditorResolver";
import { getDataGridCopy } from "../datagrid-copy";
import { getDataGridMaskingCopy } from "../datagrid-masking-copy";
import { formatCellValueForDisplay, type ColumnDisplayFormat } from "../editors";
import { isGridCellSelected } from "../grid-selection";
import type { EditingCell, GridCellValue, ResolvedColumn } from "../hooks/useDataGrid";
import { DataGridStoreContext, useOptionalDataGridStore } from "../store/dataGridStore";
import { getFaviconUrl, getUrlDomain, isImageUrl, isUrlCell } from "../urlCellDetection";

/** Per-grid inline-edit draft. Created inside DataGrid (useRef) — never a
 *  module singleton, or two mounted grids would share one draft. */
export interface EditingDraft {
  current: string;
}

export interface SetSelectedCellFn {
  (
    cell: { row: number; col: number } | null,
    modifiers?: { extend?: boolean; additive?: boolean },
  ): void;
}

export interface DataGridRowIndexHeaderProps {
  canSelectRows: boolean;
  allVisibleRowsSelected?: boolean;
  handleToggleSelectAllRows: () => void;
}

export const DataGridRowIndexHeader = React.memo(function DataGridRowIndexHeader({
  canSelectRows,
  allVisibleRowsSelected,
  handleToggleSelectAllRows,
}: DataGridRowIndexHeaderProps) {
  const copy = getDataGridCopy(getCurrentAppLanguage());
  const isAllSelected = useOptionalDataGridStore(
    (state) => state.allVisibleRowsSelected,
    allVisibleRowsSelected ?? false,
  );

  return canSelectRows ? (
    <button
      type="button"
      className={`datagrid-index-toggle ${isAllSelected ? "active" : ""}`}
      onClick={handleToggleSelectAllRows}
      title={isAllSelected ? copy.rowHeader.clearSelectedRows : copy.rowHeader.selectAllVisibleRows}
    >
      #
    </button>
  ) : (
    <span className="datagrid-index-label">#</span>
  );
});

export interface DataGridRowIndexCellProps {
  rowIndex: number;
  rowOffset: number;
  rowIndexMap?: number[];
  canSelectRows: boolean;
  selectedRows?: Set<number>;
  handleRowSelection: (
    rowIndex: number,
    event?: Pick<MouseEvent, "shiftKey" | "metaKey" | "ctrlKey">,
  ) => void;
  onOpenRowInspector?: (rowIndex: number) => void;
}

export const DataGridRowIndexCell = React.memo(function DataGridRowIndexCell({
  rowIndex,
  rowOffset,
  rowIndexMap,
  canSelectRows,
  selectedRows,
  handleRowSelection,
  onOpenRowInspector,
}: DataGridRowIndexCellProps) {
  const copy = getDataGridCopy(getCurrentAppLanguage());
  const sourceRowIndex = rowIndexMap?.[rowIndex] ?? rowIndex;
  const isSelected = useOptionalDataGridStore(
    (state) => state.selectedRows.has(sourceRowIndex),
    selectedRows?.has(sourceRowIndex) ?? false,
  );

  return canSelectRows ? (
    <button
      type="button"
      className={`datagrid-index-value datagrid-index-selectable ${isSelected ? "selected" : ""}`}
      onClick={(event) => {
        event.stopPropagation();
        handleRowSelection(sourceRowIndex, event.nativeEvent);
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onOpenRowInspector?.(sourceRowIndex);
      }}
      title={isSelected ? copy.rowHeader.rowSelected : copy.rowHeader.selectRowInspect}
    >
      {rowOffset + sourceRowIndex + 1}
    </button>
  ) : (
    <span className="datagrid-index-value">{rowOffset + sourceRowIndex + 1}</span>
  );
});

export interface DataGridBodyCellProps {
  col: ResolvedColumn;
  colIndex: number;
  rowIndex: number;
  sourceRowIndex: number;
  value: GridCellValue;
  isDateColumn: boolean;
  isGeometry: boolean;
  isBlob: boolean;
  displayFormat: ColumnDisplayFormat;
  isActivelyMasked: boolean;
  maskedCell: GridCellValue;
  maskPending: boolean;
  isEditableColumn: boolean;
  nullPlaceholder: string;
  dateFormat?: string;
  foreignKeys: ForeignKeyInfo[];
  lookupValuesCache?: Map<string, LookupValue[]>;
  onLoadLookupValues?: (table: string, column: string) => Promise<LookupValue[]>;
  connectionId?: string;
  editingDraftRef: EditingDraft;
  editingTouchedRef: { current: boolean };
  startEditingCell: (rowIndex: number, colIndex: number) => Promise<boolean>;
  commitEditingCell: (committed?: GridCellValue) => Promise<void>;
  cancelEditingCell: () => void;
  handleCopyValue: (value: GridCellValue, cellKey: string) => void;
  setSelectedCell: SetSelectedCellFn;
  selectedCell?: { row: number; col: number } | null;
  isCellSelected?: (row: number, col: number) => boolean;
  editingCell?: EditingCell | null;
  editingSeedValue?: string;
  savingCell?: EditingCell | null;
  copiedCell?: string | null;
}

export const DataGridBodyCell = React.memo(function DataGridBodyCell({
  col,
  colIndex,
  rowIndex,
  sourceRowIndex,
  value,
  isDateColumn,
  isGeometry,
  isBlob,
  displayFormat,
  isActivelyMasked,
  maskedCell,
  maskPending,
  isEditableColumn,
  nullPlaceholder,
  dateFormat,
  foreignKeys,
  lookupValuesCache,
  onLoadLookupValues,
  connectionId,
  editingDraftRef,
  editingTouchedRef,
  startEditingCell,
  commitEditingCell,
  cancelEditingCell,
  handleCopyValue,
  setSelectedCell,
  selectedCell,
  isCellSelected,
  editingCell,
  editingSeedValue,
  savingCell,
  copiedCell,
}: DataGridBodyCellProps) {
  const store = useContext(DataGridStoreContext);
  const copy = getDataGridCopy(getCurrentAppLanguage());
  const cellKey = `${sourceRowIndex}-${colIndex}`;

  const isSelected = useOptionalDataGridStore(
    (state) => isGridCellSelected(state.gridSelection, { row: rowIndex, col: colIndex }),
    isCellSelected ? isCellSelected(rowIndex, colIndex) : false,
  );
  const isEditing = useOptionalDataGridStore(
    (state) => state.editingCell?.row === sourceRowIndex && state.editingCell?.col === colIndex,
    editingCell?.row === sourceRowIndex && editingCell?.col === colIndex,
  );
  const isSaving = useOptionalDataGridStore(
    (state) => state.savingCell?.row === sourceRowIndex && state.savingCell?.col === colIndex,
    savingCell?.row === sourceRowIndex && savingCell?.col === colIndex,
  );
  const resolvedEditingSeedValue = useOptionalDataGridStore(
    (state) =>
      state.editingCell?.row === sourceRowIndex && state.editingCell?.col === colIndex
        ? state.editingSeedValue
        : "",
    editingSeedValue ?? "",
  );
  const isCopied = useOptionalDataGridStore(
    (state) => state.copiedCell === cellKey,
    copiedCell === cellKey,
  );

  const stringValue = value === null ? null : String(value);
  const isUrl = isUrlCell(stringValue);
  const isImageCell = isUrl && stringValue !== null && isImageUrl(stringValue);
  const maskingCopy = isActivelyMasked ? getDataGridMaskingCopy(getCurrentAppLanguage()) : null;

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

        const activeCell = store ? store.getState().gridSelection.activeCell : selectedCell;
        const isRepeatSelection = activeCell?.row === rowIndex && activeCell?.col === colIndex;
        if (isRepeatSelection || event.detail >= 2) {
          event.preventDefault();
          event.stopPropagation();
          void startEditingCell(sourceRowIndex, colIndex);
        }
      }}
      onClick={(event) => {
        if (!isEditing) {
          setSelectedCell(
            { row: sourceRowIndex, col: colIndex },
            {
              extend: event.shiftKey,
              additive: event.metaKey || event.ctrlKey,
            },
          );
        }
      }}
      onDoubleClick={() => {
        if (!isEditableColumn) {
          // Masked columns copy the masked value; while the async
          // anonymizer is still computing there is nothing safe to
          // copy, so the double-click is a no-op.
          if (isActivelyMasked) {
            if (!maskPending) handleCopyValue(maskedCell, cellKey);
            return;
          }
          handleCopyValue(value, cellKey);
        }
      }}
    >
      {isCopied && (
        <span className="absolute -top-5 left-1/2 -translate-x-1/2 text-[10px] bg-[var(--accent)] text-[var(--bg-primary)] px-1.5 py-0.5 rounded-md whitespace-nowrap z-10 font-semibold">
          {copy.grid.copied}
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
          editingSeedValue: resolvedEditingSeedValue,
          editingDraftRef,
          editingTouchedRef,
          commitEditingCell,
          cancelEditingCell,
          dateFormat,
        })
      ) : (
        <>
          {isSaving && (
            <span className="animate-spin inline-block w-3.5 h-3.5 border-2 border-[var(--accent)] border-t-transparent rounded-full" />
          )}
          {isActivelyMasked ? (
            <span
              className={`datagrid-cell-value masked${maskPending ? " masked-pending" : ""}`}
              data-null-placeholder={nullPlaceholder}
            >
              {maskPending
                ? maskingCopy?.pendingPlaceholder
                : maskedCell === null
                  ? nullPlaceholder
                  : String(maskedCell)}
            </span>
          ) : isImageCell && stringValue !== null ? (
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
            <span
              className="datagrid-cell-value datagrid-cell-date"
              title={`Original: ${stringValue}`}
            >
              {displayValue}
            </span>
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
});
