import { useCallback, useRef, type Dispatch, type SetStateAction } from "react";
import type { QueryResult } from "../../../types";
import type { StagedChange } from "../../../types/change-tracking";
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

type StageChangeFn = (change: Omit<StagedChange, "id" | "timestamp" | "sqlPreview">) => void;

interface DataGridInlineEditingParams {
  canAttemptInlineEdit: boolean;
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

  editingDraftRef: { current: string };
  editorRef: { current: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null };
}

/**
 * Inline cell-editing flow for the data grid: start/cancel/commit plus the
 * blur handler that commits unless the editor just opened. Handlers are moved
 * verbatim from the grid component body.
 */
export function useDataGridInlineEditing({
  canAttemptInlineEdit,
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

  editingDraftRef,
  editorRef,
}: DataGridInlineEditingParams) {
  const editingOpenedAtRef = useRef(0);

  const startEditingCell = useCallback(
    async (rowIndex: number, colIndex: number) => {
      if (!canAttemptInlineEdit || !data || !tableName) return;

      setSelectedCell({ row: rowIndex, col: colIndex });

      let nextResolvedColumns = resolvedColumns;
      if (structureStatus !== "ready") {
        try {
          const loadedStructure = await ensureStructureLoaded();
          nextResolvedColumns = buildResolvedColumns(data.columns, loadedStructure);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setError(`Inline edit unavailable: ${message}`);
          return;
        }
      }

      const primaryKeys = nextResolvedColumns.filter((column) => column.is_primary_key);
      const column = nextResolvedColumns[colIndex];
      const rowValues = data.rows[rowIndex];

      if (!column || !rowValues) {
        return;
      }

      if (primaryKeys.length === 0) {
        setError(`Inline edit unavailable for ${tableName}: no primary key was detected.`);
        return;
      }

      if (!buildStableRowIdentity(rowValues, nextResolvedColumns)) {
        setError(`Inline edit unavailable for ${tableName}: this row has an incomplete primary key.`);
        return;
      }

      if (column.is_primary_key) {
        setError(`Primary key column "${column.name}" is read-only in inline edit mode.`);
        return;
      }

      const seedValue = editorValueFromCell(rowValues[colIndex] as GridCellValue);
      setEditingSeedValue(seedValue);
      editingDraftRef.current = seedValue;
      editingOpenedAtRef.current = Date.now();
      setEditingCell({ row: rowIndex, col: colIndex });
    },
    [
      canAttemptInlineEdit,
      data,
      ensureStructureLoaded,
      resolvedColumns,
      setSelectedCell,
      setError,
      structureStatus,
      tableName,
    ],
  );

  const cancelEditingCell = useCallback(() => {
    setEditingCell(null);
    setEditingSeedValue("");
    editingDraftRef.current = "";
    editingOpenedAtRef.current = 0;
  }, []);

  const commitEditingCell = useCallback(async () => {
    if (!editingCell || !data || !tableName) return;

    const targetColumn = resolvedColumns[editingCell.col];
    const rowValues = data.rows[editingCell.row];
    if (!targetColumn || !rowValues || targetColumn.is_primary_key || primaryKeyColumns.length === 0) {
      cancelEditingCell();
      return;
    }

    if (!buildStableRowIdentity(rowValues, resolvedColumns)) {
      cancelEditingCell();
      setError(`Inline edit unavailable for ${tableName}: this row has an incomplete primary key.`);
      return;
    }

    try {
      const nextValue = parseEditorValue(editingDraftRef.current, targetColumn);
      const currentValue = rowValues[editingCell.col] as GridCellValue;

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
        tableName,
        database,
        rowIndex: editingCell.row,
        rowKey: rowKeyRecord,
        columns: {
          [editingCell.col]: { old: currentValue, new: nextValue },
        },
        originalRow: rowValues as (string | number | boolean | null)[],
      });

      // Keep the authoritative chunk cache in sync before virtual scrolling loads another page.
      patchLoadedTableCell(editingCell.row, editingCell.col, nextValue);
      setData((previous) => {
        if (!previous) return previous;
        const nextRows = previous.rows.map((row, index) => {
          if (index !== editingCell.row) return row;
          const nextRow = [...row];
          nextRow[editingCell.col] = nextValue;
          return nextRow;
        });
        return { ...previous, rows: nextRows };
      });

      // Track staged row for visual indicator
      setStagedRowIndices((prev) => new Set([...prev, editingCell.row]));
      cancelEditingCell();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setError(`Failed to stage change: ${message}`);
    } finally {
      setSavingCell(null);
    }
  }, [
    cancelEditingCell,
    data,
    database,
    editingCell,
    patchLoadedTableCell,
    primaryKeyColumns,
    resolvedColumns,
    setError,
    stageChange,
    tableName,
  ]);

  const handleEditorBlur = useCallback(() => {
    if (Date.now() - editingOpenedAtRef.current < 160) {
      window.setTimeout(() => {
        editorRef.current?.focus();
        if (editorRef.current && "select" in editorRef.current) {
          editorRef.current.select();
        }
      }, 0);
      return;
    }

    void commitEditingCell();
  }, [commitEditingCell, editorRef]);

  return {
    startEditingCell,
    cancelEditingCell,
    commitEditingCell,
    handleEditorBlur,
  };
}
