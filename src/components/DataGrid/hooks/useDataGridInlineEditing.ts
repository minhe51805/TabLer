import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { QueryResult } from "../../../types";
import type { StagedChangeInput } from "../../../stores/change-tracking-store";
import {
  areCellValuesEqual,
  buildResolvedColumns,
  buildRowPrimaryKeys,
  editorValueFromCell,
  parseEditorValue,
  type GridCellValue,
  type ResolvedColumn,
} from "./useDataGrid";
import { buildStableRowIdentity } from "../row-identity";
import type { ColumnDetail } from "../../../types";

interface EditingCell {
  row: number;
  col: number;
}

type StageChangeFn = (change: StagedChangeInput) => void;

interface DataGridInlineEditingParams {
  canAttemptInlineEdit: boolean;
  connectionId: string;
  data: QueryResult | null;
  tableName?: string;
  database?: string;
  resolvedColumns: ResolvedColumn[];
  primaryKeyColumns: ResolvedColumn[];
  structureStatus: "idle" | "loading" | "ready" | "failed";
  editingCell: EditingCell | null;

  setEditingCell: Dispatch<SetStateAction<EditingCell | null>>;
  setEditingSeedValue: Dispatch<SetStateAction<string>>;
  setSavingCell: Dispatch<SetStateAction<EditingCell | null>>;
  setStagedRowIndices: Dispatch<SetStateAction<Set<number>>>;
  setData: Dispatch<SetStateAction<QueryResult | null>>;

  setSelectedCell: (cell: { row: number; col: number } | null) => void;
  setError: (message: string) => void;
  stageChange: StageChangeFn;
  patchLoadedTableCell: (rowIndex: number, colIndex: number, value: GridCellValue) => void;
  ensureStructureLoaded: () => Promise<ColumnDetail[]>;
  /** Columns actively masked — inline edit is refused so the editor never
   *  seeds from (or stages over) a masked value. */
  maskedColumnNames?: ReadonlySet<string>;

  editingDraftRef: { current: string };
  /** Set true by the editor's onChange — an untouched blur must not stage
   *  the seed text (e.g. "NULL" shown for a null cell) as a real edit. */
  editingTouchedRef: { current: boolean };
}

/**
 * Inline cell-editing flow for the data grid: start/cancel/commit plus the
 * blur handler that commits unless the editor just opened. Handlers are moved
 * verbatim from the grid component body.
 */
export function useDataGridInlineEditing({
  canAttemptInlineEdit,
  connectionId,
  data,
  tableName,
  database,
  resolvedColumns,
  primaryKeyColumns,
  structureStatus,
  editingCell,

  setEditingCell,
  setEditingSeedValue,
  setSavingCell,
  setStagedRowIndices,
  setData,

  setSelectedCell,
  setError,
  stageChange,
  patchLoadedTableCell,
  ensureStructureLoaded,
  maskedColumnNames,
  editingDraftRef,
  editingTouchedRef,
}: DataGridInlineEditingParams) {
  const startEditingCell = useCallback(
    async (rowIndex: number, colIndex: number): Promise<boolean> => {
      if (!canAttemptInlineEdit || !data || !tableName) return false;

      setSelectedCell({ row: rowIndex, col: colIndex });

      let nextResolvedColumns = resolvedColumns;
      if (structureStatus !== "ready") {
        try {
          const loadedStructure = await ensureStructureLoaded();
          nextResolvedColumns = buildResolvedColumns(data.columns, loadedStructure);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setError(`Inline edit unavailable: ${message}`);
          return false;
        }
      }

      const primaryKeys = nextResolvedColumns.filter((column) => column.is_primary_key);
      const column = nextResolvedColumns[colIndex];
      const rowValues = data.rows[rowIndex];

      if (!column || !rowValues) {
        return false;
      }

      if (primaryKeys.length === 0) {
        setError(`Inline edit unavailable for ${tableName}: no primary key was detected.`);
        return false;
      }

      if (!buildStableRowIdentity(rowValues, nextResolvedColumns)) {
        setError(
          `Inline edit unavailable for ${tableName}: this row has an incomplete primary key.`,
        );
        return false;
      }

      if (column.is_primary_key) {
        setError(`Primary key column "${column.name}" is read-only in inline edit mode.`);
        return false;
      }

      if (maskedColumnNames?.has(column.name)) {
        setError(
          `Column "${column.name}" is masked — remove the mask or reveal it before editing.`,
        );
        return false;
      }

      const seedValue = editorValueFromCell(rowValues[colIndex] as GridCellValue);
      setEditingSeedValue(seedValue);
      editingDraftRef.current = seedValue;
      editingTouchedRef.current = false;
      setEditingCell({ row: rowIndex, col: colIndex });
      return true;
    },
    [
      canAttemptInlineEdit,
      data,
      tableName,
      setSelectedCell,
      resolvedColumns,
      structureStatus,
      setEditingSeedValue,
      editingDraftRef,
      editingTouchedRef,
      setEditingCell,
      ensureStructureLoaded,
      setError,
      maskedColumnNames,
    ],
  );

  const cancelEditingCell = useCallback(() => {
    setEditingCell(null);
    setEditingSeedValue("");
    editingDraftRef.current = "";
    editingTouchedRef.current = false;
  }, [editingDraftRef, editingTouchedRef, setEditingCell, setEditingSeedValue]);
  const commitEditingCell = useCallback(
    async (committed?: GridCellValue, cellOverride?: EditingCell) => {
      const targetCell = cellOverride ?? editingCell;
      if (!targetCell || !data || !tableName) return;

      const targetColumn = resolvedColumns[targetCell.col];
      const rowValues = data.rows[targetCell.row];
      if (
        !targetColumn ||
        !rowValues ||
        targetColumn.is_primary_key ||
        primaryKeyColumns.length === 0
      ) {
        cancelEditingCell();
        return;
      }

      if (!buildStableRowIdentity(rowValues, resolvedColumns)) {
        cancelEditingCell();
        setError(
          `Inline edit unavailable for ${tableName}: this row has an incomplete primary key.`,
        );
        return;
      }

      const currentValue = rowValues[targetCell.col] as GridCellValue;

      // Unedited commit (e.g. blur right after opening): the draft still holds
      // the seed — including the "NULL" placeholder shown for null cells — so
      // nothing was typed and nothing should be staged. The touched flag is
      // what separates this from deliberately typing the seed text back:
      // typing "NULL" into a null cell MUST stage the literal string.
      // Explicit editor commits (select options, NULL button) always count as
      // a user action.
      const seed = editorValueFromCell(currentValue);
      if (
        !editingTouchedRef.current &&
        (committed === undefined || committed === seed) &&
        editingDraftRef.current === seed
      ) {
        cancelEditingCell();
        return;
      }

      setSavingCell({ row: targetCell.row, col: targetCell.col });
      try {
        // `committed` is the editor's resolved value: null is the explicit NULL
        // gesture (never re-parsed), strings still go through the column-aware
        // parser so '1e5'/'.5' and bigint precision are handled in one place,
        // and numbers/booleans are final.
        let nextValue: GridCellValue;
        if (committed === undefined) {
          nextValue = parseEditorValue(editingDraftRef.current, targetColumn);
        } else if (typeof committed === "string") {
          nextValue = parseEditorValue(committed, targetColumn);
        } else {
          nextValue = committed;
        }

        if (areCellValuesEqual(currentValue, nextValue)) {
          cancelEditingCell();
          return;
        }

        const primaryKeys = buildRowPrimaryKeys(rowValues, resolvedColumns, primaryKeyColumns);
        const rowKeyRecord: Record<string, unknown> = {};
        for (const pk of primaryKeys) {
          rowKeyRecord[pk.column] = pk.value;
        }

        // Stage the change in the queue (change tracking)
        stageChange({
          type: "update",
          connectionId,
          tableName,
          database,
          rowIndex: targetCell.row,
          rowKey: rowKeyRecord,
          columns: {
            [targetCell.col]: { old: currentValue, new: nextValue },
          },
          originalRow: rowValues as (string | number | boolean | null)[],
        });

        // Keep the authoritative chunk cache in sync before virtual scrolling loads another page.
        patchLoadedTableCell(targetCell.row, targetCell.col, nextValue);
        setData((previous) => {
          if (!previous) return previous;
          const nextRows = previous.rows.map((row, index) => {
            if (index !== targetCell.row) return row;
            const nextRow = [...row];
            nextRow[targetCell.col] = nextValue;
            return nextRow;
          });
          return { ...previous, rows: nextRows };
        });

        // Track staged row for visual indicator
        setStagedRowIndices((prev) => new Set([...prev, targetCell.row]));
        cancelEditingCell();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setError(`Failed to stage change: ${message}`);
      } finally {
        setSavingCell(null);
      }
    },
    [
      cancelEditingCell,
      connectionId,
      data,
      database,
      editingCell,
      editingDraftRef,
      editingTouchedRef,
      patchLoadedTableCell,
      primaryKeyColumns,
      resolvedColumns,
      setData,
      setError,
      setSavingCell,
      setStagedRowIndices,
      stageChange,
      tableName,
    ],
  );

  const editCellFromInspector = useCallback(
    async (rowIndex: number, colIndex: number, committed: GridCellValue) => {
      const started = await startEditingCell(rowIndex, colIndex);
      if (!started) return;
      await commitEditingCell(committed, { row: rowIndex, col: colIndex });
    },
    [commitEditingCell, startEditingCell],
  );

  return {
    startEditingCell,
    cancelEditingCell,
    commitEditingCell,
    editCellFromInspector,
  };
}
