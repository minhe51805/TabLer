import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { QueryResult } from "../../../types";
import type { StagedChangeInput } from "../../../stores/change-tracking-store";
import { emitAppToast } from "../../../utils/app-toast";
import { getCurrentAppLanguage, translateCurrent } from "../../../i18n";
import { buildStableRowIdentity } from "../row-identity";
import { getDataGridPowerCopy } from "../datagrid-power-copy";
import type { GridSelectionState } from "../grid-selection";
import {
  buildRangeTsv,
  getPrimaryGridRange,
  isMultiCellRange,
  parseRangePasteMatrix,
  planClearUpdates,
  planFillDownUpdates,
  planPasteUpdates,
  planSetValueUpdates,
  type RangeCellValue,
  type RangeColumnLike,
  type RangeUpdateContext,
  type RangeUpdatePlan,
} from "../grid-range-operations";
import {
  areCellValuesEqual,
  buildRowPrimaryKeys,
  parseEditorValue,
  type GridCellValue,
  type ResolvedColumn,
} from "./useDataGrid";

interface DataGridRangeOperationsParams {
  /**
   * Selection state lives in DISPLAYED row space: keyboard navigation,
   * Ctrl+A and cell clicks all address the rows the user can see, so
   * filtered-out rows can never enter a range.
   */
  gridSelection: GridSelectionState;
  data: QueryResult | null;
  /** Rows in display order (quick filter + local sort applied). */
  displayedRows: GridCellValue[][];
  /** displayed index → source index into data.rows. */
  displayedRowIndices: number[];
  resolvedColumns: ResolvedColumn[];
  primaryKeyColumns: ResolvedColumn[];
  tableName?: string;
  connectionId: string;
  database?: string;
  /** Same gate as inline editing — range operations stage nothing when false. */
  enabled: boolean;

  stageChanges: (changes: StagedChangeInput[]) => void;
  setData: Dispatch<SetStateAction<QueryResult | null>>;
  setStagedRowIndices: Dispatch<SetStateAction<Set<number>>>;
  patchLoadedTableCell: (rowIndex: number, colIndex: number, value: GridCellValue) => void;
  setError: (message: string) => void;
}

/**
 * Range editing (copy / paste / delete / fill-down) for the DataGrid.
 *
 * Every mutation goes through the same staged-change queue as single-cell
 * inline editing: the whole batch is ONE undo/redo unit, the review modal
 * still gates the database write, and the optimistic grid update plus the
 * chunk-cache patch mirror commitEditingCell exactly.
 */
export function useDataGridRangeOperations({
  gridSelection,
  data,
  displayedRows,
  displayedRowIndices,
  resolvedColumns,
  primaryKeyColumns,
  tableName,
  connectionId,
  database,
  enabled,
  stageChanges,
  setData,
  setStagedRowIndices,
  patchLoadedTableCell,
  setError,
}: DataGridRangeOperationsParams) {
  const buildContext = useCallback((): RangeUpdateContext | null => {
    if (!data) return null;
    return {
      // Plans walk the VISIBLE rows only — hidden rows are unreachable.
      rows: displayedRows as RangeCellValue[][],
      columns: resolvedColumns,
      // The walker feeds back columns from context.columns, which are the
      // same ResolvedColumn instances — the narrowing cast is safe.
      parseValue: (raw: string, column: RangeColumnLike) =>
        parseEditorValue(raw, column as ResolvedColumn),
      valuesEqual: areCellValuesEqual,
      rowIsTargetable: (rowIndex: number) => {
        const row = displayedRows[rowIndex];
        if (!row || primaryKeyColumns.length === 0) return false;
        return buildStableRowIdentity(row, resolvedColumns) !== null;
      },
    };
  }, [data, displayedRows, primaryKeyColumns, resolvedColumns]);

  /** Stage + optimistic-apply a planned batch. Returns false when nothing was staged. */
  const commitUpdates = useCallback(
    (plan: RangeUpdatePlan, toastTitle: string): boolean => {
      if (!enabled || !data || !tableName || plan.updates.length === 0) return false;

      // Plan updates carry displayed row indices; staged changes and the
      // chunk cache are keyed by source indices into data.rows.
      const changes: StagedChangeInput[] = [];
      for (const update of plan.updates) {
        const sourceRowIndex = displayedRowIndices[update.rowIndex];
        const rowValues = sourceRowIndex === undefined ? undefined : data.rows[sourceRowIndex];
        if (sourceRowIndex === undefined || !rowValues) continue;
        const rowKey: Record<string, unknown> = {};
        for (const pk of buildRowPrimaryKeys(rowValues, resolvedColumns, primaryKeyColumns)) {
          rowKey[pk.column] = pk.value;
        }
        changes.push({
          type: "update",
          connectionId,
          tableName,
          database,
          rowIndex: sourceRowIndex,
          rowKey,
          columns: { [update.colIndex]: { old: update.oldValue, new: update.nextValue } },
          originalRow: [...rowValues] as (string | number | boolean | null)[],
        });
      }
      if (changes.length === 0) return false;

      stageChanges(changes);

      // Same optimistic convention as commitEditingCell: grid state first,
      // then the authoritative chunk cache, then the staged-row highlight.
      setData((previous) => {
        if (!previous) return previous;
        const rows = previous.rows.map((row) => [...row]);
        for (const update of plan.updates) {
          const sourceRowIndex = displayedRowIndices[update.rowIndex];
          const row = sourceRowIndex === undefined ? undefined : rows[sourceRowIndex];
          if (row) row[update.colIndex] = update.nextValue as GridCellValue;
        }
        return { ...previous, rows };
      });
      for (const update of plan.updates) {
        const sourceRowIndex = displayedRowIndices[update.rowIndex];
        if (sourceRowIndex === undefined) continue;
        patchLoadedTableCell(sourceRowIndex, update.colIndex, update.nextValue as GridCellValue);
      }
      setStagedRowIndices((previous) => {
        const next = new Set(previous);
        for (const update of plan.updates) {
          const sourceRowIndex = displayedRowIndices[update.rowIndex];
          if (sourceRowIndex !== undefined) next.add(sourceRowIndex);
        }
        return next;
      });

      emitAppToast({ title: toastTitle, tone: "success" });
      return true;
    },
    [
      connectionId,
      database,
      data,
      displayedRowIndices,
      enabled,
      patchLoadedTableCell,
      primaryKeyColumns,
      resolvedColumns,
      setData,
      setStagedRowIndices,
      stageChanges,
      tableName,
    ],
  );

  /** Copy the selected rectangle as TSV. Returns true when the grid owned the shortcut. */
  const handleRangeCopy = useCallback((): boolean => {
    if (!data || displayedRows.length === 0 || resolvedColumns.length === 0) return false;
    const range = getPrimaryGridRange(gridSelection, {
      rowCount: displayedRows.length,
      columnCount: resolvedColumns.length,
    });
    if (!range) return false;
    const tsv = buildRangeTsv(displayedRows as RangeCellValue[][], range);
    if (!tsv) return false;
    navigator.clipboard
      .writeText(tsv)
      .then(() => {
        emitAppToast({ title: translateCurrent("datagrid.rangeCopySuccess"), tone: "success" });
      })
      .catch(() => {
        setError("Could not write to the clipboard.");
      });
    return true;
  }, [data, displayedRows, gridSelection, resolvedColumns, setError]);

  /**
   * Paste a TSV/CSV matrix at the active cell as ONE staged batch.
   * All-or-nothing: overflow past the loaded page or any per-cell parse
   * error refuses the whole paste. Returns true when the grid owned the
   * shortcut (checked synchronously so preventDefault is deterministic).
   */
  const handleRangePaste = useCallback((): boolean => {
    if (!enabled || !data) return false;
    const anchor = gridSelection.activeCell;
    if (!anchor) return false;

    void (async () => {
      let text: string;
      try {
        text = await navigator.clipboard.readText();
      } catch {
        setError("Cannot read the clipboard. Copy the cells again, then paste.");
        return;
      }
      const matrix = parseRangePasteMatrix(text);
      if (!matrix) return;
      const context = buildContext();
      if (!context) return;
      let plan;
      try {
        plan = planPasteUpdates({ anchor, matrix }, context);
      } catch (errorValue) {
        const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
        setError(`Paste refused: ${message}`);
        return;
      }
      if (plan.refused) {
        setError(
          `Paste refused: ${plan.refused.requestedRows} row(s) × ${plan.refused.requestedColumns} column(s) would extend past the loaded page.`,
        );
        return;
      }
      commitUpdates(plan, translateCurrent("datagrid.rangePasteStaged"));
    })();
    return true;
  }, [buildContext, commitUpdates, data, enabled, gridSelection, setError]);

  /** Stage NULL for every editable cell of the selection. */
  const handleRangeDelete = useCallback((): boolean => {
    if (!enabled) return false;
    const context = buildContext();
    if (!context) return false;
    const range = getPrimaryGridRange(gridSelection, {
      rowCount: context.rows.length,
      columnCount: context.columns.length,
    });
    if (!range) return false;
    return commitUpdates(
      planClearUpdates(range, context),
      translateCurrent("datagrid.rangeDeleteStaged"),
    );
  }, [buildContext, commitUpdates, enabled, gridSelection]);

  /**
   * Fill the range downward from its top row. Only claims the shortcut for a
   * multi-cell range so the global duplicate-row Ctrl+D keeps working.
   */
  const handleRangeFillDown = useCallback((): boolean => {
    if (!enabled) return false;
    const context = buildContext();
    if (!context) return false;
    const range = getPrimaryGridRange(gridSelection, {
      rowCount: context.rows.length,
      columnCount: context.columns.length,
    });
    if (!range || !isMultiCellRange(range)) return false;
    return commitUpdates(
      planFillDownUpdates(range, context),
      translateCurrent("datagrid.rangeFillStaged"),
    );
  }, [buildContext, commitUpdates, enabled, gridSelection]);

  /**
   * Stage one value across the whole selection ("Set selected cells to…").
   * `raw === null` stages NULL. Returns an error message for the dialog to
   * display, or null when the batch was staged.
   */
  const handleRangeSetValue = useCallback(
    (raw: string | null): string | null => {
      const copy = getDataGridPowerCopy(getCurrentAppLanguage());
      if (!enabled) return copy.setCells.errNotEditable;
      const context = buildContext();
      if (!context) return copy.setCells.errNoData;
      const range = getPrimaryGridRange(gridSelection, {
        rowCount: context.rows.length,
        columnCount: context.columns.length,
      });
      if (!range) return copy.setCells.errNoSelection;
      let plan: RangeUpdatePlan;
      try {
        plan = planSetValueUpdates(range, context, raw);
      } catch (errorValue) {
        return errorValue instanceof Error ? errorValue.message : String(errorValue);
      }
      if (plan.updates.length === 0) {
        return copy.setCells.errNoUpdates;
      }
      if (!commitUpdates(plan, copy.setCells.stagedToast(plan.updates.length))) {
        return copy.setCells.errStageFailed;
      }
      return null;
    },
    [buildContext, commitUpdates, enabled, gridSelection],
  );

  return {
    handleRangeCopy,
    handleRangePaste,
    handleRangeDelete,
    handleRangeFillDown,
    handleRangeSetValue,
  };
}
