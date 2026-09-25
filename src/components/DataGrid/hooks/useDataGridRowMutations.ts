import {
  useCallback,
  type Dispatch,
  type FormEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import type { ColumnDetail } from "../../../types";
import type { StagedChangeInput } from "../../../stores/change-tracking-store";
import type { AtomicCsvImportSummary } from "../../../stores/queryStore";
import { parseEditorValue, buildRowPrimaryKeys, type ResolvedColumn } from "./useDataGrid";
import { computeNewRowPlan, computeColumnPlan } from "./useInsertColumnPlan";
import { type CsvFileSelection } from "../dialogs/PasteRowsDialog";
import type { PastePreview } from "../../../utils/clipboard-parser";
import type { QueryResult } from "../../../types";
import { emitAppToast } from "../../../utils/app-toast";
import { getCurrentAppLanguage } from "../../../i18n";
import { getDataGridPowerCopy } from "../datagrid-power-copy";
import { getDataGridCopy } from "../datagrid-copy";

interface DataGridRowMutationsParams {
  tableName?: string;
  database?: string;
  connectionId: string;
  resolvedColumns: ResolvedColumn[];
  structureColumns: ColumnDetail[];
  data: QueryResult | null;
  selectedRows: Set<number>;
  /** Source indices of the rows currently visible after the quick filter. */
  filteredTableRowIndices: number[];
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
  /** When true the insert dialog stages a queued insert instead of inserting directly. */
  insertDialogStages: boolean;
  setInsertDialogStages: Dispatch<SetStateAction<boolean>>;

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
  setCsvImportProgress: Dispatch<
    SetStateAction<{
      processedRows: number;
      processedBytes: number;
      totalBytes: number;
    } | null>
  >;
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
    request: {
      table: string;
      database?: string;
      rows: Array<Array<{ column: string; value: string | number | boolean | null }>>;
    },
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
  ) => Promise<AtomicCsvImportSummary>;
  cancelCsvImport: (operationId: string) => Promise<boolean>;

  /** Change-tracking queue: staged inserts land in the review modal. */
  stageChange: (change: StagedChangeInput) => void;
  invalidateTableCaches: (connectionId: string, tableName: string, database?: string) => void;
  refreshTableFromStart: () => Promise<unknown>;

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
  filteredTableRowIndices,
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
  insertDialogStages,
  setInsertDialogStages,

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

  stageChange,

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
    setInsertDialogStages(false);
  }, [
    setInsertDialogBaseValues,
    setInsertDialogColumns,
    setInsertDialogError,
    setInsertDialogStages,
    setInsertDraft,
    setIsInsertDialogOpen,
    setIsSubmittingInsert,
  ]);

  const closePasteDialog = useCallback(
    (force = false) => {
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
    },
    [
      isSubmittingPaste,
      setCsvFileSelection,
      setCsvImportProgress,
      setDragSourceIndex,
      setDropTargetIndex,
      setIsCancellingPaste,
      setIsPasteDialogOpen,
      setIsSubmittingPaste,
      setPastePreview,
      setPasteSourceLabel,
    ],
  );

  const analyzeInsertPlan = useCallback(() => {
    return computeNewRowPlan(structureColumns);
  }, [structureColumns]);

  const performInsertRow = useCallback(
    async (values: [string, unknown][]) => {
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
    },
    [
      connectionId,
      dataGridInstanceIdRef,
      database,
      insertTableRow,
      invalidateTableCaches,
      refreshTableFromStart,
      tableName,
    ],
  );

  /**
   * Queue a row insert in the change-tracking review modal. Column keys are
   * resolved-column indices — the store maps them to names for the SQL
   * preview, matching the staged-update convention.
   */
  const stageInsertValues = useCallback(
    (values: [string, unknown][]) => {
      if (!tableName) return;
      const indexByName = new Map(resolvedColumns.map((column, index) => [column.name, index]));
      const columns: Record<string, { old: unknown; new: unknown }> = {};
      const originalRow: (string | number | boolean | null)[] = resolvedColumns.map(() => null);
      for (const [name, value] of values) {
        const colIndex = indexByName.get(name);
        if (colIndex === undefined) continue;
        columns[colIndex] = { old: null, new: value };
        originalRow[colIndex] = value as string | number | boolean | null;
      }
      if (Object.keys(columns).length === 0) {
        emitAppToast({
          title: getDataGridPowerCopy(getCurrentAppLanguage()).duplicate.nothingToDuplicate,
          tone: "info",
        });
        return;
      }
      stageChange({
        type: "insert",
        connectionId,
        tableName,
        database,
        // No source row exists — inserts have no grid row to highlight.
        rowIndex: -1,
        rowKey: {},
        columns,
        originalRow,
      });
      emitAppToast({
        title: getDataGridPowerCopy(getCurrentAppLanguage()).duplicate.stagedToast,
        tone: "success",
      });
    },
    [connectionId, database, resolvedColumns, stageChange, tableName],
  );

  const handleInsertRow = useCallback(async () => {
    if (!tableName || structureColumns.length === 0) {
      return;
    }

    const { baseValues, promptColumns } = analyzeInsertPlan();

    if (promptColumns.length > 0) {
      setInsertDialogStages(false);
      setInsertDialogColumns(promptColumns);
      setInsertDialogBaseValues(baseValues);
      setInsertDraft(Object.fromEntries(promptColumns.map((column) => [column.name, ""])));
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
    setInsertDialogBaseValues,
    setInsertDialogColumns,
    setInsertDialogError,
    setInsertDialogStages,
    setInsertDraft,
    setIsInsertDialogOpen,
    structureColumns.length,
    tableName,
  ]);

  const handleInsertDraftChange = useCallback(
    (columnName: string, value: string) => {
      setInsertDraft((previous) => ({
        ...previous,
        [columnName]: value,
      }));
    },
    [setInsertDraft],
  );

  const handleSubmitInsertDialog = useCallback(
    async (event?: FormEvent<HTMLFormElement>) => {
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

      // Duplicate-row flow: queue the insert in the review modal instead of
      // executing it immediately.
      if (insertDialogStages) {
        stageInsertValues(nextValues);
        closeInsertDialog();
        return;
      }

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
    },
    [
      closeInsertDialog,
      insertDialogBaseValues,
      insertDialogColumns,
      insertDialogStages,
      insertDraft,
      performInsertRow,
      setInsertDialogError,
      setIsSubmittingInsert,
      stageInsertValues,
    ],
  );

  const handleSubmitPasteDialog = useCallback(async () => {
    if (!pastePreview || !tableName || !connectionId) return;

    const columnsByName = new Map(resolvedColumns.map((column) => [column.name, column]));
    let validatedRows: [string, unknown][][];
    try {
      validatedRows = pastePreview.insertRows.map((row, rowIndex) =>
        row.map(([columnName, rawValue]) => {
          const column = columnsByName.get(columnName);
          if (!column || rawValue === null) return [columnName, rawValue];
          try {
            return [columnName, parseEditorValue(String(rawValue), column)];
          } catch (errorValue) {
            const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
            throw new Error(`CSV row ${rowIndex + 1}, column ${columnName}: ${message}`);
          }
        }),
      );
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
        const importSummary = await importCsvFileAtomically(
          connectionId,
          {
            filePath: csvFileSelection.filePath,
            table: tableName,
            database,
            delimiter: csvFileSelection.delimiter,
            hasHeaders: pastePreview.firstRowWasHeader,
            mappings: pastePreview.mappings.map((mapping) => ({
              sourceIndex: mapping.clipboardIndex,
              targetColumn: mapping.tableColumnName,
            })),
          },
          operationId,
        );
        // Post-import verification is advisory: the import itself already
        // committed, so a count mismatch (or a failed COUNT) is only worth a
        // toast, never a rollback.
        const verifyMismatch =
          importSummary.verifiedRows !== null &&
          importSummary.verifiedRows !== importSummary.insertedRows;
        const verifyWarnings = verifyMismatch
          ? [
              `Post-import verification counted ${importSummary.verifiedRows} new row(s); the driver reported ${importSummary.insertedRows} inserted.`,
              ...importSummary.warnings,
            ]
          : importSummary.warnings;
        for (const warning of verifyWarnings) {
          emitAppToast({
            title: "CSV import verification",
            description: warning,
            tone: "info",
          });
        }
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
  }, [
    pastePreview,
    tableName,
    connectionId,
    resolvedColumns,
    setIsSubmittingPaste,
    setIsCancellingPaste,
    setCsvImportProgress,
    csvImportOperationIdRef,
    setError,
    csvFileSelection,
    invalidateTableCaches,
    database,
    dataGridInstanceIdRef,
    refreshTableFromStart,
    closePasteDialog,
    importCsvFileAtomically,
    insertTableRowsAtomically,
  ]);

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
  }, [cancelCsvImport, csvImportOperationIdRef, isCancellingPaste, setError, setIsCancellingPaste]);

  // ---- Duplicate flows (staged insert in the review queue)

  /**
   * Stage a copy of `sourceRow` as an insert. Auto-generated PKs and columns
   * with database defaults are excluded so the database assigns them; when a
   * column still needs a user value (non-auto PK, non-nullable NULL source)
   * the insert dialog opens in stage mode so the result still lands in the
   * review modal.
   */
  const stageDuplicateRow = useCallback(
    (sourceRow: unknown[]) => {
      if (!tableName || structureColumns.length === 0) return;

      const { baseValues, promptColumns } = computeColumnPlan(structureColumns, sourceRow);

      if (promptColumns.length === 0) {
        stageInsertValues(baseValues);
        return;
      }

      setInsertDialogStages(true);
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
    },
    [
      tableName,
      structureColumns,
      stageInsertValues,
      setInsertDialogStages,
      setInsertDialogColumns,
      setInsertDialogBaseValues,
      setInsertDraft,
      setInsertDialogError,
      setIsInsertDialogOpen,
    ],
  );

  const handleDuplicateRowByIndex = useCallback(
    async (rowIndex: number) => {
      const sourceRow = data?.rows[rowIndex];
      if (!sourceRow) return;
      stageDuplicateRow(sourceRow);
    },
    [data?.rows, stageDuplicateRow],
  );

  /** Delete all selected rows after confirmation. */
  const handleDeleteSelectedRows = useCallback(async () => {
    if (!tableName || !data || selectedRows.size === 0 || primaryKeyColumns.length === 0) {
      return;
    }

    // Selection stores source indices into data.rows, so a quick filter can
    // leave selected rows the user cannot see. Only visible rows may be
    // deleted — hidden ones stay selected and untouched.
    const visibleRowSet = new Set(filteredTableRowIndices);
    const sortedRows = Array.from(selectedRows)
      .filter((rowIndex) => visibleRowSet.has(rowIndex))
      .sort((left, right) => left - right);
    const hiddenSelectedCount = selectedRows.size - sortedRows.length;

    const copy = getDataGridCopy(getCurrentAppLanguage());
    if (sortedRows.length === 0) {
      setError(copy.deleteRows.hiddenOnly);
      return;
    }

    const hiddenNote =
      hiddenSelectedCount > 0 ? copy.deleteRows.hiddenNote(hiddenSelectedCount) : "";
    const shouldDelete = window.confirm(
      copy.deleteRows.confirm(sortedRows.length, tableName, hiddenNote),
    );
    if (!shouldDelete) return;

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

      const partialDelete = affectedRows < sortedRows.length;
      if (partialDelete) {
        // The backend reports only a count — which rows survived is unknown,
        // so skip the optimistic removal and let the refresh below show the
        // real state. The toast keeps the partial failure visible.
        emitAppToast({
          title: copy.deleteRows.partialTitle,
          description: copy.deleteRows.partialDescription(affectedRows, sortedRows.length),
          tone: "error",
        });
      } else {
        const deletedRowSet = new Set(sortedRows);
        setData((previous) => {
          if (!previous) return previous;
          return {
            ...previous,
            rows: previous.rows.filter((_, index) => !deletedRowSet.has(index)),
          };
        });
      }
      setTotalRows((previous) => Math.max(0, previous - affectedRows));
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
    tableName,
    data,
    selectedRows,
    filteredTableRowIndices,
    primaryKeyColumns,
    setIsDeletingRows,
    deleteTableRows,
    connectionId,
    database,
    setData,
    setTotalRows,
    setSelectedRows,
    rowSelectionAnchorRef,
    cancelEditingCell,
    setSelectedCell,
    invalidateTableCaches,
    dataGridInstanceIdRef,
    refreshTableFromStart,
    resolvedColumns,
    setError,
  ]);

  const handleDuplicateRow = useCallback(async () => {
    if (selectedRows.size === 0) return;

    const firstSelectedIndex = Math.min(...Array.from(selectedRows));
    const sourceRow = data?.rows[firstSelectedIndex];
    if (!sourceRow) return;
    stageDuplicateRow(sourceRow);
  }, [selectedRows, data?.rows, stageDuplicateRow]);

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
