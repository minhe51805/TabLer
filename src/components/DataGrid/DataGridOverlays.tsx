import { createPortal } from "react-dom";
import type { Dispatch, FormEvent, SetStateAction } from "react";
import type { Table } from "@tanstack/react-table";
import type { ColumnDetail, DatabaseType, QueryResult } from "../../types";
import type { PastePreview } from "../../utils/clipboard-parser";
import type { ResolvedColumn } from "./hooks/useDataGrid";
import type { ColumnDisplayFormat } from "./editors";
import type { ColumnStats } from "./dialogs/ColumnStatsPopover";
import { ColumnStatsPopover } from "./dialogs/ColumnStatsPopover";
import { DataGridContextMenu } from "./dialogs/DataGridContextMenu";
import { FkPreviewPopover } from "./dialogs/FkPreviewPopover";
import { InsertRowDialog } from "./dialogs/InsertRowDialog";
import { PasteRowsDialog } from "./dialogs/PasteRowsDialog";
import { SetRangeValueDialog } from "./dialogs/SetRangeValueDialog";
import { ChangeTrackingPreviewModal } from "./components/ChangeTrackingPreviewModal";
import type { ColumnOrderState, VisibilityState, ColumnPinningState } from "@tanstack/react-table";
import type { DataGridColumnMasks } from "./hooks/useDataGridColumnMasks";
import { getPrimaryGridRange, isMultiCellRange } from "./grid-range-operations";
import { useOptionalDataGridStore } from "./store/dataGridStore";

/** Everything the floating overlays (context menu, popovers, dialogs) need
 *  from the grid — bundled so DataGrid's render stays readable. */
export interface DataGridOverlaysProps {
  connectionId: string;
  database?: string;
  tableName?: string;
  externalResult?: QueryResult;
  dbType?: DatabaseType;
  data: QueryResult | null;
  resolvedColumns: ResolvedColumn[];
  table: Table<unknown[]>;
  selectedRows: Set<number>;
  columnDisplayFormats: Record<string, ColumnDisplayFormat>;
  pinBudgetPx: number;
  isLoading: boolean;
  stagedChangeCount: number;
  canAttemptInlineEdit: boolean;
  /** View-time column masking state for the header context menu + copies. */
  columnMasks?: DataGridColumnMasks;
  selectedRangeCellCount?: number;
  contextMenu: {
    x: number;
    y: number;
    type: "cell" | "header" | "row";
    colName?: string;
    rowIndex?: number;
  } | null;
  fkPreview: {
    table: string;
    column: string;
    value: string | number | boolean;
    rowIndex: number;
    colIndex: number;
  } | null;
  fkPreviewData: QueryResult | null;
  isLoadingFkPreview: boolean;
  columnStats: { column: string; stats: ColumnStats | null } | null;
  columnStatsError: string | null;
  isLoadingColumnStats: boolean;
  setRangeDialog: { open: boolean; cellCount: number; error: string | null };
  isPasteDialogOpen: boolean;
  pastePreview: PastePreview | null;
  pasteSourceLabel: string;
  csvFileSelection: {
    filePath: string;
    delimiter: "csv" | "tsv";
    byteSize: number;
    isTruncated: boolean;
  } | null;
  isSubmittingPaste: boolean;
  isCancellingPaste: boolean;
  csvImportProgress: {
    processedRows: number;
    processedBytes: number;
    totalBytes: number;
  } | null;
  onCloseContextMenu: () => void;
  onColumnStats?: (colName: string) => void;
  onSortAsc: (colId: string) => void;
  onSortDesc: (colId: string) => void;
  onInsertRow: () => void;
  onDuplicateRowByIndex: (rowIndex: number) => Promise<void>;
  onOpenRowInspector: (rowIndex: number) => void;
  onColumnAutoFit: (colId: string) => void;
  onSetRangeValue?: () => void;
  setColumnOrder: Dispatch<SetStateAction<ColumnOrderState>>;
  setColumnPinning: Dispatch<SetStateAction<ColumnPinningState>>;
  setColumnSizes: Dispatch<SetStateAction<Record<string, number>>>;
  setColumnVisibility: Dispatch<SetStateAction<VisibilityState>>;
  setFilterDraft: Dispatch<SetStateAction<string>>;
  setTableFilter: Dispatch<SetStateAction<string>>;
  setSortColumn: Dispatch<SetStateAction<string | null>>;
  setSortDir: Dispatch<SetStateAction<"ASC" | "DESC">>;
  setColumnDisplayFormats: Dispatch<SetStateAction<Record<string, ColumnDisplayFormat>>>;
  onCloseFkPreview: () => void;
  onCloseSetRangeDialog: () => void;
  onCloseColumnStats: () => void;
  onSetRangeSubmit: (raw: string | null) => string | null;
  onSetRangeError: (message: string | null) => void;
  onApplyStagedChanges: () => void;
  onDiscardStagedChanges: () => void;
  onClosePasteDialog: () => void;
  onSubmitPasteDialog: () => void;
  onCancelPasteImport: () => void;
  isInsertDialogOpen?: boolean;
  insertDialogColumns?: ColumnDetail[];
  insertDraft?: Record<string, string>;
  insertDialogError?: string | null;
  isSubmittingInsert?: boolean;
  onCloseInsertDialog?: () => void;
  onSubmitInsertDialog?: (event?: FormEvent<HTMLFormElement>) => void;
  onInsertDraftChange?: (columnName: string, value: string) => void;
}

/** Floating layers above the grid: context menu, FK/column-stats popovers,
 *  insert/set-range/paste dialogs, and the staged-changes preview modal.
 *  All portal to document.body — see the context-menu comment for why. */
export function DataGridOverlays(props: DataGridOverlaysProps) {
  const {
    connectionId,
    database,
    tableName,
    externalResult,
    dbType,
    data,
    resolvedColumns,
    table,
    selectedRows,
    columnDisplayFormats,
    pinBudgetPx,
    isLoading,
    stagedChangeCount,
    canAttemptInlineEdit,
    columnMasks,
    selectedRangeCellCount,
    contextMenu,
    fkPreview,
    fkPreviewData,
    isLoadingFkPreview,
    columnStats,
    columnStatsError,
    isLoadingColumnStats,
    setRangeDialog,
    isPasteDialogOpen,
    pastePreview,
    pasteSourceLabel,
    csvFileSelection,
    isSubmittingPaste,
    isCancellingPaste,
    csvImportProgress,
    onCloseContextMenu,
    onColumnStats,
    onSortAsc,
    onSortDesc,
    onInsertRow,
    onDuplicateRowByIndex,
    onOpenRowInspector,
    onColumnAutoFit,
    onSetRangeValue,
    setColumnOrder,
    setColumnPinning,
    setColumnSizes,
    setColumnVisibility,
    setFilterDraft,
    setTableFilter,
    setSortColumn,
    setSortDir,
    setColumnDisplayFormats,
    onCloseFkPreview,
    onCloseColumnStats,
    onCloseSetRangeDialog,
    onSetRangeSubmit,
    onSetRangeError,
    onApplyStagedChanges,
    onDiscardStagedChanges,
    onClosePasteDialog,
    onSubmitPasteDialog,
    onCancelPasteImport,
    isInsertDialogOpen = false,
    insertDialogColumns = [],
    insertDraft = {},
    insertDialogError = null,
    isSubmittingInsert = false,
    onCloseInsertDialog,
    onSubmitInsertDialog,
    onInsertDraftChange,
  } = props;
  const storeSelectedRangeCellCount = useOptionalDataGridStore((s) => {
    if (!contextMenu || !data || resolvedColumns.length === 0) return 0;
    const range = getPrimaryGridRange(s.gridSelection, {
      rowCount: table.getRowModel().rows.length,
      columnCount: resolvedColumns.length,
    });
    if (!range || !isMultiCellRange(range)) return 0;
    return (range.endRow - range.startRow + 1) * (range.endCol - range.startCol + 1);
  }, 0);
  const effectiveSelectedRangeCellCount = selectedRangeCellCount ?? storeSelectedRangeCellCount;

  return (
    <>
      {/* Context Menu — portaled to document.body: ancestors like .main-content
  keep an animated transform applied, which turns them into the containing
  block for position:fixed and offsets the menu away from the cursor. */}
      {contextMenu &&
        createPortal(
          <DataGridContextMenu
            menu={contextMenu}
            connectionId={connectionId}
            database={database}
            tableName={tableName}
            columnDisplayFormats={columnDisplayFormats}
            table={table}
            dbType={dbType}
            selectedRows={selectedRows}
            sourceRows={data?.rows ?? []}
            resolvedColumns={resolvedColumns}
            columnMasks={columnMasks}
            onColumnStats={tableName && !externalResult ? onColumnStats : undefined}
            onClose={onCloseContextMenu}
            onSortAsc={onSortAsc}
            onSortDesc={onSortDesc}
            onInsertRow={onInsertRow}
            onDuplicateRowByIndex={onDuplicateRowByIndex}
            onOpenRowInspector={onOpenRowInspector}
            onColumnAutoFit={onColumnAutoFit}
            selectedRangeCellCount={effectiveSelectedRangeCellCount}
            onSetRangeValue={canAttemptInlineEdit ? onSetRangeValue : undefined}
            setColumnOrder={setColumnOrder}
            setColumnPinning={setColumnPinning}
            setColumnSizes={setColumnSizes}
            setColumnVisibility={setColumnVisibility}
            setFilterDraft={setFilterDraft}
            pinBudgetPx={pinBudgetPx}
            setTableFilter={setTableFilter}
            setSortColumn={setSortColumn}
            setSortDir={setSortDir}
            setColumnDisplayFormats={setColumnDisplayFormats}
          />,
          document.body,
        )}

      {/* FK Preview Popover */}
      {fkPreview && (
        <FkPreviewPopover
          fkPreview={fkPreview}
          isLoadingFkPreview={isLoadingFkPreview}
          fkPreviewData={fkPreviewData}
          onClose={onCloseFkPreview}
        />
      )}
      {columnStats && (
        <ColumnStatsPopover
          columnName={columnStats.column}
          stats={columnStats.stats}
          isLoading={isLoadingColumnStats}
          error={columnStatsError}
          onClose={onCloseColumnStats}
        />
      )}

      {/* "Set selected cells to…" bulk-edit dialog */}
      {setRangeDialog.open && typeof document !== "undefined"
        ? createPortal(
            <SetRangeValueDialog
              cellCount={setRangeDialog.cellCount}
              error={setRangeDialog.error}
              onClose={onCloseSetRangeDialog}
              onSubmit={onSetRangeSubmit}
              onError={onSetRangeError}
            />,
            document.body,
          )
        : null}

      {/* Change Tracking Preview Modal */}
      {stagedChangeCount > 0 && typeof document !== "undefined"
        ? createPortal(
            <ChangeTrackingPreviewModal
              connectionId={connectionId}
              tableName={tableName}
              database={database}
              onApply={onApplyStagedChanges}
              onDiscard={onDiscardStagedChanges}
              isApplying={isLoading}
            />,
            document.body,
          )
        : null}

      {/* Paste Rows Dialog */}
      {isPasteDialogOpen && pastePreview && typeof document !== "undefined"
        ? createPortal(
            <PasteRowsDialog
              tableName={tableName}
              pasteSourceLabel={pasteSourceLabel}
              csvFileSelection={csvFileSelection}
              isSubmittingPaste={isSubmittingPaste}
              isCancellingPaste={isCancellingPaste}
              csvImportProgress={csvImportProgress}
              pastePreview={pastePreview}
              onClose={onClosePasteDialog}
              onSubmit={onSubmitPasteDialog}
              onCancel={onCancelPasteImport}
            />,
            document.body,
          )
        : null}

      {isInsertDialogOpen &&
      onCloseInsertDialog &&
      onSubmitInsertDialog &&
      onInsertDraftChange &&
      typeof document !== "undefined"
        ? createPortal(
            <InsertRowDialog
              tableName={tableName}
              columns={insertDialogColumns}
              draft={insertDraft}
              error={insertDialogError}
              isSubmitting={isSubmittingInsert}
              onClose={onCloseInsertDialog}
              onSubmit={onSubmitInsertDialog}
              onDraftChange={onInsertDraftChange}
            />,
            document.body,
          )
        : null}
    </>
  );
}
