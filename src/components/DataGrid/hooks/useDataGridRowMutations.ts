import { useCallback, type Dispatch, type FormEvent, type RefObject, type SetStateAction } from "react";
import type { ColumnDetail } from "../../../types";
import {
    parseEditorValue,
    buildRowPrimaryKeys,
    type ResolvedColumn,
  } from "./useDataGrid";
import { computeNewRowPlan, computeColumnPlan } from "./useInsertColumnPlan";
import { type CsvFileSelection } from "../dialogs/PasteRowsDialog";
import type { PastePreview } from "../../../utils/clipboard-parser";
import type { QueryResult } from "../../../types";

interface DataGridRowMutationsParams {
  tableName?: string;
  database?: string;
  connectionId: string;
  resolvedColumns: ResolvedColumn[];
  structureColumns: ColumnDetail[];
  data: QueryResult | null;
  selectedRows: Set<number>;
  primaryKeyColumns: ResolvedColumn[];

  // Insert dialog state
  insertDialogBaseValues: [string, unknown][];
  insertDialogColumns: ColumnDetail[];
  insertDraft: Record<string, string>;
  setInsertDialogColumns: Dispatch<SetStateAction<ColumnDetail[]>>;
  setInsertDialogBaseValues: Dispatch<SetStateAction<[string, unknown][]>>;
  setInsertDraft: Dispatch<SetStateAction<Record<string, string>>>;
  setInsertDialogError: Dispatch<SetStateAction<string | null>>;
  setIsInsertDialogOpen: Dispatch<SetStateAction<boolean>>;
  setIsSubmittingInsert: Dispatch<SetStateAction<boolean>>;

  // Paste / CSV import state
  pastePreview: PastePreview | null;
  csvFileSelection: CsvFileSelection | null;
  isSubmittingPaste: boolean;
  isCancellingPaste: boolean;
  setPastePreview: Dispatch<SetStateAction<PastePreview | null>>;
  setCsvFileSelection: Dispatch<SetStateAction<CsvFileSelection | null>>;
  setIsPasteDialogOpen: Dispatch<SetStateAction<boolean>>;
  setIsSubmittingPaste: Dispatch<SetStateAction<boolean>>;
  setIsCancellingPaste: Dispatch<SetStateAction<boolean>>;
  setPasteSourceLabel: Dispatch<SetStateAction<string>>;
  setDragSourceIndex: Dispatch<SetStateAction<number | null>>;
  setDropTargetIndex: Dispatch<SetStateAction<number | null>>;
  setCsvImportProgress: Dispatch<SetStateAction<{
    processedRows: number;
    processedBytes: number;
    totalBytes: number;
  } | null>>;
  setError: (message: string) => void;
  setSelectedRows: Dispatch<SetStateAction<Set<number>>>;
  setSelectedCell: (cell: { row: number; col: number } | null) => void;
  cancelEditingCell: () => void;
  setData: Dispatch<SetStateAction<QueryResult | null>>;
  setIsDeletingRows: Dispatch<SetStateAction<boolean>>;
  setTotalRows: Dispatch<SetStateAction<number>>;
  rowSelectionAnchorRef: RefObject<string | null>;
  deleteTableRows: (
    connectionId: string,
    request: { table: string; database?: string; rows: Array<Array<{ column: string; value: string | number | boolean | null }>> },
  ) => Promise<number>;

  csvImportOperationIdRef: RefObject<string | null>;

  // Store actions
  insertTableRow: (
    connectionId: string,
    request: { table: string; database?: string; values: [string, unknown][] },
  ) => Promise<unknown>;
  insertTableRowsAtomically: (
    connectionId: string,
    rows: Array<{ table: string; database?: string; values: [string, unknown][] }>,
    operationId: string,
  ) => Promise<unknown>;
  importCsvFileAtomically: (
    connectionId: string,
    request: {
      filePath: string;
      table: string;
      database?: string;
      delimiter: "csv" | "tsv";
      hasHeaders: boolean;
      mappings: Array<{ sourceIndex: number; targetColumn: string }>;
    },
    operationId: string,
  ) => Promise<unknown>;
  cancelCsvImport: (operationId: string) => Promise<boolean>;

  invalidateTableCaches: (connectionId: string, tableName: string, database?: string) => void;
  refreshTableFromStart: () => Promise<void>;

  dataGridInstanceIdRef: RefObject<string>;
}

/**
 * Row-mutation flow for the grid: single-row insert (plan → prompt → submit)
 * plus the paste/CSV atomic import pipeline and its cancellation.
 * Handlers are moved verbatim from the grid component body.
 */
export function useDataGridRowMutations({
  tableName,
  database,
  connectionId,
  resolvedColumns,
  structureColumns,
  data,
  selectedRows,
  primaryKeyColumns,

  insertDialogBaseValues,
  insertDialogColumns,
  insertDraft,
  setInsertDialogColumns,
  setInsertDialogBaseValues,
  setInsertDraft,
  setInsertDialogError,
  setIsInsertDialogOpen,
  setIsSubmittingInsert,

  pastePreview,
  csvFileSelection,
  isCancellingPaste,
  isSubmittingPaste,
  setPastePreview,
  setCsvFileSelection,
  setPasteSourceLabel,
  setIsPasteDialogOpen,
  setDragSourceIndex,
  setDropTargetIndex,
  setIsSubmittingPaste,
  setIsCancellingPaste,
  setCsvImportProgress,
  setError,
  setSelectedRows,
  setSelectedCell,
  cancelEditingCell,
  setIsDeletingRows,
  setTotalRows,
  setData,
  rowSelectionAnchorRef,
  deleteTableRows,

  csvImportOperationIdRef,

  insertTableRow,
  insertTableRowsAtomically,
  importCsvFileAtomically,
  cancelCsvImport,

  invalidateTableCaches,
  refreshTableFromStart,

  dataGridInstanceIdRef,
}: DataGridRowMutationsParams) {
  const closeInsertDialog = useCallback(() => {
    setIsInsertDialogOpen(false);
    setInsertDialogColumns([]);
    setInsertDialogBaseValues([]);
    setInsertDraft({});
    setInsertDialogError(null);
    setIsSubmittingInsert(false);
  }, []);

  const closePasteDialog = useCallback((force = false) => {
    if (isSubmittingPaste && !force) return;
    setIsPasteDialogOpen(false);
    setPastePreview(null);
    setPasteSourceLabel("Clipboard data");
    setCsvFileSelection(null);
    setCsvImportProgress(null);
    setIsSubmittingPaste(false);
    setIsCancellingPaste(false);
    setDragSourceIndex(null);
    setDropTargetIndex(null);
  }, [isSubmittingPaste]);

  const analyzeInsertPlan = useCallback(() => {
    return computeNewRowPlan(structureColumns);
  }, [structureColumns]);

  const performInsertRow = useCallback(async (values: [string, unknown][]) => {
    if (!tableName) return;

    await insertTableRow(connectionId, {
      table: tableName,
      database,
      values,
    });

    invalidateTableCaches(connectionId, tableName, database);
    window.dispatchEvent(
      new CustomEvent("table-data-updated", {
        detail: {
          connectionId,
          database,
          tableName,
          sourceId: dataGridInstanceIdRef.current,
        },
      }),
    );
    await refreshTableFromStart();
  }, [connectionId, database, insertTableRow, refreshTableFromStart, tableName]);

  const handleInsertRow = useCallback(async () => {
    if (!tableName || structureColumns.length === 0) {
      return;
    }

    const { baseValues, promptColumns } = analyzeInsertPlan();

    if (promptColumns.length > 0) {
      setInsertDialogColumns(promptColumns);
      setInsertDialogBaseValues(baseValues);
      setInsertDraft(
        Object.fromEntries(promptColumns.map((column) => [column.name, ""])),
      );
      setInsertDialogError(null);
      setIsInsertDialogOpen(true);
      return;
    }

    try {
      await performInsertRow(baseValues);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setError(`Insert row failed: ${message}`);
    }
  }, [
    analyzeInsertPlan,
    performInsertRow,
    setError,
    structureColumns.length,
    tableName,
  ]);

  const handleInsertDraftChange = useCallback((columnName: string, value: string) => {
    setInsertDraft((previous) => ({
      ...previous,
      [columnName]: value,
    }));
  }, []);

  const handleSubmitInsertDialog = useCallback(async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();

    const missingColumns: string[] = [];
    const nextValues: [string, unknown][] = [...insertDialogBaseValues];

    for (const column of insertDialogColumns) {
      const rawValue = insertDraft[column.name] ?? "";
      const trimmed = rawValue.trim();

      if (trimmed.length === 0) {
        if (!column.is_nullable) {
          missingColumns.push(column.name);
        } else {
          nextValues.push([column.name, null]);
        }
        continue;
      }

      try {
        nextValues.push([column.name, parseEditorValue(rawValue, column as ResolvedColumn)]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setInsertDialogError(`${column.name}: ${message}`);
        return;
      }
    }

    if (missingColumns.length > 0) {
      setInsertDialogError(`Please enter values for: ${missingColumns.join(", ")}`);
      return;
    }

    setInsertDialogError(null);
    setIsSubmittingInsert(true);

    try {
      await performInsertRow(nextValues);
      closeInsertDialog();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setInsertDialogError(`Insert row failed: ${message}`);
    } finally {
      setIsSubmittingInsert(false);
    }
  }, [closeInsertDialog, insertDialogBaseValues, insertDialogColumns, insertDraft, performInsertRow]);

  const handleSubmitPasteDialog = useCallback(async () => {
    if (!pastePreview || !tableName || !connectionId) return;

    const columnsByName = new Map(resolvedColumns.map((column) => [column.name, column]));
    let validatedRows: [string, unknown][][];
    try {
      validatedRows = pastePreview.insertRows.map((row, rowIndex) => row.map(([columnName, rawValue]) => {
        const column = columnsByName.get(columnName);
        if (!column || rawValue === null) return [columnName, rawValue];
        try {
          return [columnName, parseEditorValue(String(rawValue), column)];
        } catch (errorValue) {
          const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
          throw new Error(`CSV row ${rowIndex + 1}, column ${columnName}: ${message}`);
        }
      }));
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
      return;
    }

    setIsSubmittingPaste(true);
    setIsCancellingPaste(false);
    setCsvImportProgress(null);
    const operationId = `csv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    csvImportOperationIdRef.current = operationId;
    try {
      if (csvFileSelection) {
        await importCsvFileAtomically(connectionId, {
          filePath: csvFileSelection.filePath,
          table: tableName,
          database,
          delimiter: csvFileSelection.delimiter,
          hasHeaders: pastePreview.firstRowWasHeader,
          mappings: pastePreview.mappings.map((mapping) => ({
            sourceIndex: mapping.clipboardIndex,
            targetColumn: mapping.tableColumnName,
          })),
        }, operationId);
      } else {
        await insertTableRowsAtomically(
          connectionId,
          validatedRows.map((values) => ({ table: tableName, database, values })),
          operationId,
        );
      }

      invalidateTableCaches(connectionId, tableName, database);
      window.dispatchEvent(
        new CustomEvent("table-data-updated", {
          detail: { connectionId, database, tableName, sourceId: dataGridInstanceIdRef.current },
        }),
      );
      await refreshTableFromStart();
      closePasteDialog(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setError(`CSV import was rolled back: ${message}`);
    } finally {
      csvImportOperationIdRef.current = null;
      setIsSubmittingPaste(false);
      setIsCancellingPaste(false);
      setCsvImportProgress(null);
    }
  }, [csvFileSelection, pastePreview, tableName, connectionId, database, importCsvFileAtomically, insertTableRowsAtomically, setError, invalidateTableCaches, refreshTableFromStart, closePasteDialog, resolvedColumns]);

  const handleCancelPasteImport = useCallback(async () => {
    const operationId = csvImportOperationIdRef.current;
    if (!operationId || isCancellingPaste) return;
    setIsCancellingPaste(true);
    try {
      const accepted = await cancelCsvImport(operationId);
      if (!accepted) {
        setError("The CSV import had already completed and could not be cancelled.");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setError(`Could not cancel CSV import: ${message}`);
      setIsCancellingPaste(false);
    }
  }, [cancelCsvImport, isCancellingPaste, setError]);


// ---- Duplicate flows (insert dialog prefilled from an existing row)
  const handleDuplicateRowByIndex = useCallback(async (rowIndex: number) => {
    if (!tableName || structureColumns.length === 0) return;

    const sourceRow = data?.rows[rowIndex];
    if (!sourceRow) return;

    const { baseValues, promptColumns } = computeColumnPlan(structureColumns, sourceRow);

    setInsertDialogColumns(promptColumns);
    setInsertDialogBaseValues(baseValues);
    setInsertDraft(
      Object.fromEntries(
        promptColumns.map((column) => {
          const colIdx = structureColumns.indexOf(column);
          const val = sourceRow[colIdx];
          return [column.name, val !== null ? String(val) : ""];
        }),
      ),
    );
    setInsertDialogError(null);
    setIsInsertDialogOpen(true);
  }, [tableName, structureColumns, data]);

/** Delete all selected rows after confirmation. */
  const handleDeleteSelectedRows = useCallback(async () => {
    if (!tableName || !data || selectedRows.size === 0 || primaryKeyColumns.length === 0) {
      return;
    }

    const shouldDelete = window.confirm(
      `Delete ${selectedRows.size} selected row${selectedRows.size === 1 ? "" : "s"} from ${tableName}? This cannot be undone.`,
    );
    if (!shouldDelete) return;

    const sortedRows = Array.from(selectedRows).sort((left, right) => left - right);

    setIsDeletingRows(true);
    try {
      const rows = sortedRows.map((rowIndex) => {
        const rowValues = data.rows[rowIndex];
        if (!rowValues) {
          throw new Error("One of the selected rows no longer exists in the current page.");
        }
        return buildRowPrimaryKeys(rowValues, resolvedColumns, primaryKeyColumns);
      });

      const affectedRows = await deleteTableRows(connectionId, {
        table: tableName,
        database,
        rows,
      });

      if (affectedRows === 0) {
        throw new Error("Database did not delete any rows for the current selection.");
      }

      const deletedRowSet = new Set(sortedRows);
      setData((previous) => {
        if (!previous) return previous;
        return {
          ...previous,
          rows: previous.rows.filter((_, index) => !deletedRowSet.has(index)),
        };
      });
      setTotalRows((previous) => Math.max(0, previous - sortedRows.length));
      setSelectedRows(new Set());
      rowSelectionAnchorRef.current = null;
      cancelEditingCell();
      setSelectedCell(null);

      invalidateTableCaches(connectionId, tableName, database);
      window.dispatchEvent(
        new CustomEvent("table-data-updated", {
          detail: {
            connectionId,
            database,
            tableName,
            sourceId: dataGridInstanceIdRef.current,
          },
        }),
      );

      await refreshTableFromStart();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setError(`Delete rows failed: ${message}`);
    } finally {
      setIsDeletingRows(false);
    }
  }, [
    cancelEditingCell,
    connectionId,
    data,
    database,
    deleteTableRows,
    refreshTableFromStart,
    primaryKeyColumns,
    resolvedColumns,
    selectedRows,
    setSelectedCell,
    setError,
    setSelectedRows,
    tableName,
  ]);

  const handleDuplicateRow = useCallback(async () => {
    if (!tableName || structureColumns.length === 0 || selectedRows.size === 0) return;

    const firstSelectedIndex = Math.min(...Array.from(selectedRows));
    const sourceRow = data?.rows[firstSelectedIndex];
    if (!sourceRow) return;

    const { baseValues, promptColumns } = computeColumnPlan(structureColumns, sourceRow ?? null);

    setInsertDialogColumns(promptColumns);
    setInsertDialogBaseValues(baseValues);
    setInsertDraft(
      Object.fromEntries(
        promptColumns.map((column) => {
          const colIdx = structureColumns.indexOf(column);
          const val = sourceRow ? sourceRow[colIdx] : null;
          return [column.name, val !== null ? String(val) : ""];
        }),
      ),
    );
    setInsertDialogError(null);
    setIsInsertDialogOpen(true);
  }, [tableName, structureColumns, selectedRows, data]);

  return {
    closeInsertDialog,
    closePasteDialog,
    analyzeInsertPlan,
    performInsertRow,
    handleInsertRow,
    handleInsertDraftChange,
    handleSubmitInsertDialog,
    handleSubmitPasteDialog,
    handleCancelPasteImport,
    handleDuplicateRowByIndex,
    handleDeleteSelectedRows,
    handleDuplicateRow,
  };
}
