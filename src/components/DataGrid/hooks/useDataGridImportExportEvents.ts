import { useCallback, useEffect, type Dispatch, type SetStateAction } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { EventCenter } from "../../../stores/event-center";
import type { ColumnDetail, QueryResult } from "../../../types";
import { APP_EVENTS } from "../../../utils/app-events";
import {
  buildPastePreview,
  parseClipboardText,
  type PastePreview,
} from "../../../utils/clipboard-parser";
import { invokeMutation } from "../../../utils/tauri-utils";
import {
  invalidateTableCaches,
  invalidateTableScopeCaches,
  type ResolvedColumn,
} from "./useDataGrid";

export interface UseDataGridImportExportEventsParams {
  connectionId: string;
  tableName?: string;
  database?: string;
  externalResult?: QueryResult;
  isActive: boolean;
  currentPage: number;
  resolvedColumns: ResolvedColumn[];
  fetchData: (page: number) => Promise<void>;
  setError: (message: string) => void;
  setCsvImportProgress: Dispatch<
    SetStateAction<{
      processedRows: number;
      processedBytes: number;
      totalBytes: number;
    } | null>
  >;
  setExportedRowCount: Dispatch<SetStateAction<number>>;
  setPastePreview: Dispatch<SetStateAction<PastePreview | null>>;
  setCsvFileSelection: Dispatch<
    SetStateAction<{
      filePath: string;
      delimiter: "csv" | "tsv";
      byteSize: number;
      isTruncated: boolean;
    } | null>
  >;
  setPasteSourceLabel: Dispatch<SetStateAction<string>>;
  setIsPasteDialogOpen: Dispatch<SetStateAction<boolean>>;
  refs: {
    csvImportOperationIdRef: { current: string | null };
    tableExportOperationIdRef: { current: string | null };
    isMountedRef: { current: boolean };
    isActiveRef: { current: boolean };
    requestIdRef: { current: number };
    structureRequestIdRef: { current: number };
    structurePromiseRef: { current: Promise<ColumnDetail[]> | null };
    structureRetryAttemptRef: { current: number };
    structureRetryTimeoutRef: { current: number | null };
    countTimeoutRef: { current: number | null };
    pendingDataRefreshRef: { current: boolean };
    dataGridInstanceIdRef: { current: string };
  };
}

/**
 * Tauri progress listeners, table cache invalidation / deferred refresh event
 * bridge, lifecycle cleanup, and clipboard/CSV import triggers for `<DataGrid />`.
 */
export function useDataGridImportExportEvents({
  connectionId,
  tableName,
  database,
  externalResult,
  isActive,
  currentPage,
  resolvedColumns,
  fetchData,
  setError,
  setCsvImportProgress,
  setExportedRowCount,
  setPastePreview,
  setCsvFileSelection,
  setPasteSourceLabel,
  setIsPasteDialogOpen,
  refs,
}: UseDataGridImportExportEventsParams) {
  const {
    csvImportOperationIdRef,
    tableExportOperationIdRef,
    isMountedRef,
    isActiveRef,
    requestIdRef,
    structureRequestIdRef,
    structurePromiseRef,
    structureRetryAttemptRef,
    structureRetryTimeoutRef,
    countTimeoutRef,
    pendingDataRefreshRef,
    dataGridInstanceIdRef,
  } = refs;

  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive, isActiveRef]);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    void listen<{
      operationId: string;
      processedRows: number;
      processedBytes: number;
      totalBytes: number;
    }>("csv-import-progress", (event) => {
      if (event.payload.operationId !== csvImportOperationIdRef.current) return;
      setCsvImportProgress({
        processedRows: event.payload.processedRows,
        processedBytes: event.payload.processedBytes,
        totalBytes: event.payload.totalBytes,
      });
    })
      .then((cleanup) => {
        unlisten = cleanup;
      })
      .catch(() => {
        // Browser-only tests and previews do not expose Tauri's event bridge.
      });
    return () => unlisten?.();
  }, [csvImportOperationIdRef, setCsvImportProgress]);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    void listen<{ operationId: string; exportedRows: number }>("table-export-progress", (event) => {
      if (event.payload.operationId !== tableExportOperationIdRef.current) return;
      setExportedRowCount(event.payload.exportedRows);
    })
      .then((cleanup) => {
        unlisten = cleanup;
      })
      .catch(() => {
        // Browser-only tests and previews do not expose Tauri's event bridge.
      });
    return () => unlisten?.();
  }, [setExportedRowCount, tableExportOperationIdRef]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      requestIdRef.current += 1;
      structureRequestIdRef.current += 1;
      structurePromiseRef.current = null;
      structureRetryAttemptRef.current = 0;
      if (structureRetryTimeoutRef.current !== null) {
        window.clearTimeout(structureRetryTimeoutRef.current);
        structureRetryTimeoutRef.current = null;
      }
      if (countTimeoutRef.current !== null) {
        window.clearTimeout(countTimeoutRef.current);
        countTimeoutRef.current = null;
      }
    };
  }, [
    countTimeoutRef,
    isMountedRef,
    requestIdRef,
    structurePromiseRef,
    structureRequestIdRef,
    structureRetryAttemptRef,
    structureRetryTimeoutRef,
  ]);

  useEffect(() => {
    const handleStructureUpdated = (
      event: CustomEvent<{
        connectionId: string;
        tableName: string;
        database?: string;
      }>,
    ) => {
      const detail = event.detail;
      if (!detail) return;
      invalidateTableCaches(detail.connectionId, detail.tableName, detail.database, {
        invalidateStructure: true,
      });
    };

    return EventCenter.on(APP_EVENTS.tableStructureUpdated, handleStructureUpdated);
  }, []);

  useEffect(() => {
    const handleTableDataUpdated = (
      event: CustomEvent<{
        connectionId: string;
        database?: string;
        tableName?: string;
        invalidateStructure?: boolean;
        sourceId?: string;
      }>,
    ) => {
      const detail = event.detail;
      if (!detail || detail.connectionId !== connectionId) return;
      if (
        detail.database !== undefined &&
        database !== undefined &&
        (detail.database || "") !== (database || "")
      ) {
        return;
      }

      const invalidationDatabaseScope = database !== undefined ? detail.database : undefined;
      invalidateTableScopeCaches(
        detail.connectionId,
        invalidationDatabaseScope,
        detail.tableName,
        Boolean(detail.invalidateStructure),
      );

      if (!tableName || externalResult) return;
      if (detail.tableName && detail.tableName !== tableName) return;
      if (detail.sourceId === dataGridInstanceIdRef.current) return;

      if (!isActiveRef.current) {
        pendingDataRefreshRef.current = true;
        return;
      }

      pendingDataRefreshRef.current = false;
      void fetchData(currentPage);
    };

    return EventCenter.on(APP_EVENTS.tableDataUpdated, handleTableDataUpdated);
  }, [
    connectionId,
    currentPage,
    dataGridInstanceIdRef,
    database,
    externalResult,
    fetchData,
    isActiveRef,
    pendingDataRefreshRef,
    tableName,
  ]);

  // Deferred refresh: an update event may land while this grid is a
  // background tab; refetch on the next activation.
  useEffect(() => {
    if (!isActive || !tableName || externalResult) return;
    if (!pendingDataRefreshRef.current) return;
    pendingDataRefreshRef.current = false;
    void fetchData(currentPage);
  }, [currentPage, externalResult, fetchData, isActive, pendingDataRefreshRef, tableName]);

  const handlePasteRowsFromClipboard = useCallback(async () => {
    if (!tableName || resolvedColumns.length === 0) return;

    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      setError("Cannot read clipboard. Try using Ctrl+C to copy, then paste here.");
      return;
    }

    const parsed = parseClipboardText(text);
    if (!parsed) {
      setError("Clipboard does not contain valid TSV/CSV data.");
      return;
    }

    const tableColumnNames = resolvedColumns.map((c) => c.name);
    const preview = buildPastePreview(parsed, tableColumnNames);

    if (preview.mappings.length === 0) {
      setError(
        `No columns matched. Clipboard has ${parsed.columnCount} column(s), table has ${tableColumnNames.length} column(s). Check column names.`,
      );
      return;
    }

    setPastePreview(preview);
    setPasteSourceLabel("Clipboard data");
    setCsvFileSelection(null);
    setIsPasteDialogOpen(true);
  }, [
    resolvedColumns,
    setCsvFileSelection,
    setError,
    setIsPasteDialogOpen,
    setPastePreview,
    setPasteSourceLabel,
    tableName,
  ]);

  const handleImportCsv = useCallback(async () => {
    if (!tableName || resolvedColumns.length === 0) return;
    try {
      const file = await invokeMutation<{
        fileName: string;
        content: string;
        byteSize: number;
        filePath: string;
        isTruncated: boolean;
        delimiter: "csv" | "tsv";
      }>("read_csv_file", {});
      const parsed = parseClipboardText(file.content);
      if (!parsed) throw new Error("The selected file does not contain valid CSV or TSV data.");
      const preview = buildPastePreview(
        parsed,
        resolvedColumns.map((column) => column.name),
      );
      if (preview.mappings.length === 0)
        throw new Error("No CSV headers match columns in the selected table.");
      setPastePreview(preview);
      setCsvFileSelection({
        filePath: file.filePath,
        delimiter: file.delimiter,
        byteSize: file.byteSize,
        isTruncated: file.isTruncated,
      });
      const sizeLabel =
        file.byteSize >= 1024 * 1024
          ? `${(file.byteSize / (1024 * 1024)).toFixed(1)} MB`
          : `${Math.max(1, Math.round(file.byteSize / 1024))} KB`;
      setPasteSourceLabel(`${file.fileName} (${sizeLabel}, streaming import)`);
      setIsPasteDialogOpen(true);
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
    }
  }, [
    resolvedColumns,
    setCsvFileSelection,
    setError,
    setIsPasteDialogOpen,
    setPastePreview,
    setPasteSourceLabel,
    tableName,
  ]);

  return {
    handlePasteRowsFromClipboard,
    handleImportCsv,
  };
}
