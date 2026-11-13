import React from "react";
import type { ColumnDef } from "@tanstack/react-table";
import type { EditingCell, GridCellValue, ResolvedColumn } from "./hooks/useDataGrid";
import type { ForeignKeyInfo } from "../../types";
import {
  getCellEditorType,
  isGeometryColumn,
  isBlobColumn,
  type ColumnDisplayFormat,
} from "./editors";
import { ColumnHeader } from "./DataGridColumnHeader";
import type { LookupValue } from "./cellEditorResolver";
import {
  DataGridBodyCell,
  DataGridRowIndexCell,
  DataGridRowIndexHeader,
  type EditingDraft,
  type SetSelectedCellFn,
} from "./components/DataGridCell";
import "./datagrid-masking.css";

export type { EditingDraft, LookupValue };

const DEFAULT_FOREIGN_KEYS: ForeignKeyInfo[] = [];

interface DataGridColumnsProps {
  resolvedColumns: ResolvedColumn[];
  canSelectRows: boolean;
  canAttemptInlineEdit: boolean;
  selectedRows?: Set<number>;
  /** Active cell in DISPLAYED row space (matches gridSelection). */
  selectedCell?: { row: number; col: number } | null;
  isCellSelected?: (row: number, col: number) => boolean;
  editingCell?: EditingCell | null;
  editingSeedValue?: string;
  savingCell?: EditingCell | null;
  sortColumn: string | null;
  sortDir: "ASC" | "DESC";
  /** Absolute offset of the first loaded row; keeps row identity stable across chunks. */
  rowOffset: number;
  /** Maps a filtered visible row back to its source row in the loaded data window. */
  rowIndexMap?: number[];
  copiedCell?: string | null;
  editingDraftRef: EditingDraft;
  /** Set true by editor onChange — distinguishes an untouched blur from a
   *  deliberate retype of the seed text (e.g. literal "NULL"). */
  editingTouchedRef: { current: boolean };
  handleSort: (colName: string, event?: MouseEvent) => void;
  handleRowSelection: (
    rowIndex: number,
    event?: Pick<MouseEvent, "shiftKey" | "metaKey" | "ctrlKey">,
  ) => void;
  handleToggleSelectAllRows: () => void;
  handleCopyValue: (value: GridCellValue, cellKey: string) => void;
  startEditingCell: (rowIndex: number, colIndex: number) => Promise<boolean>;
  commitEditingCell: (committed?: GridCellValue) => Promise<void>;
  cancelEditingCell: () => void;
  structureStatus: "idle" | "loading" | "ready" | "failed";
  allVisibleRowsSelected?: boolean;
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
  onContextMenu?: (
    e: React.MouseEvent,
    type: "cell" | "header" | "row",
    colName?: string,
    rowIndex?: number,
  ) => void;
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
  /** Columns with a mask rule (revealed or not) — drives the header badge. */
  maskedColumnNames?: ReadonlySet<string>;
  /** Columns actively rendering masked (rule set AND not revealed). */
  activeMaskedNames?: ReadonlySet<string>;
  /** Masked copy of the displayed rows, aligned by displayed row index. */
  maskedRows?: GridCellValue[][] | null;
  /** Session-only reveal toggle for the header badge. */
  onToggleMaskReveal?: (colName: string) => void;
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
  editingTouchedRef,
  handleSort,
  handleRowSelection,
  handleToggleSelectAllRows,
  startEditingCell,
  commitEditingCell,
  cancelEditingCell,
  structureStatus,
  allVisibleRowsSelected,
  isBooleanColumn: _isBooleanColumn,
  handleCopyValue,
  setSelectedCell,
  foreignKeys = DEFAULT_FOREIGN_KEYS,
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
  maskedColumnNames,
  activeMaskedNames,
  maskedRows,
  onToggleMaskReveal,
}: DataGridColumnsProps): ColumnDef<unknown[], unknown>[] {
  return [
    {
      id: "_row_num",
      header: () => (
        <DataGridRowIndexHeader
          canSelectRows={canSelectRows}
          allVisibleRowsSelected={allVisibleRowsSelected}
          handleToggleSelectAllRows={handleToggleSelectAllRows}
        />
      ),
      cell: ({ row }) => (
        <DataGridRowIndexCell
          rowIndex={row.index}
          rowOffset={rowOffset}
          rowIndexMap={rowIndexMap}
          canSelectRows={canSelectRows}
          selectedRows={selectedRows}
          handleRowSelection={handleRowSelection}
          onOpenRowInspector={onOpenRowInspector}
        />
      ),
      size: 72,
      minSize: 40,
      maxSize: 800,
    },
    ...resolvedColumns.map((col, idx) => {
      // Per-column invariants hoisted out of the per-cell renderer: these only
      // depend on the column definition, not on individual cells.
      const columnEditorType = getCellEditorType(col, undefined, undefined);
      const isDateColumn =
        columnEditorType === "date" ||
        columnEditorType === "datetime" ||
        columnEditorType === "time";
      const isGeometry = isGeometryColumn(col);
      const isBlob = isBlobColumn(col);
      const displayFormat = columnDisplayFormats[col.name] || "default";
      const isMasked = maskedColumnNames?.has(col.name) ?? false;
      const isActivelyMasked = activeMaskedNames?.has(col.name) ?? false;
      const isEditableColumn =
        canAttemptInlineEdit &&
        !isActivelyMasked &&
        (structureStatus !== "ready" || !col.is_primary_key);

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
            isMasked={isMasked}
            isRevealed={isMasked && !isActivelyMasked}
            onToggleMaskReveal={onToggleMaskReveal}
          />
        ),
        accessorFn: (row: unknown[]) => (row as (string | number | boolean | null)[])[idx],
        cell: ({
          getValue,
          row: tableRow,
        }: {
          getValue: () => unknown;
          row: { index: number };
        }) => {
          const rowIndex = tableRow.index;
          const sourceRowIndex = rowIndexMap?.[rowIndex] ?? rowIndex;
          // View-time masking: the masked matrix is aligned by displayed row
          // index; null means the async anonymizer is still computing.
          const maskedCell = isActivelyMasked ? (maskedRows?.[rowIndex]?.[idx] ?? null) : null;
          const maskPending = isActivelyMasked && maskedRows === null;

          return (
            <DataGridBodyCell
              col={col}
              colIndex={idx}
              rowIndex={rowIndex}
              sourceRowIndex={sourceRowIndex}
              value={getValue() as GridCellValue}
              isDateColumn={isDateColumn}
              isGeometry={isGeometry}
              isBlob={isBlob}
              displayFormat={displayFormat}
              isActivelyMasked={isActivelyMasked}
              maskedCell={maskedCell}
              maskPending={maskPending}
              isEditableColumn={isEditableColumn}
              nullPlaceholder={nullPlaceholder}
              dateFormat={dateFormat}
              foreignKeys={foreignKeys}
              lookupValuesCache={lookupValuesCache}
              onLoadLookupValues={onLoadLookupValues}
              connectionId={connectionId}
              editingDraftRef={editingDraftRef}
              editingTouchedRef={editingTouchedRef}
              startEditingCell={startEditingCell}
              commitEditingCell={commitEditingCell}
              cancelEditingCell={cancelEditingCell}
              handleCopyValue={handleCopyValue}
              setSelectedCell={setSelectedCell}
              selectedCell={selectedCell}
              isCellSelected={isCellSelected}
              editingCell={editingCell}
              editingSeedValue={editingSeedValue}
              savingCell={savingCell}
              copiedCell={copiedCell}
            />
          );
        },
      };
    }),
  ];
}
