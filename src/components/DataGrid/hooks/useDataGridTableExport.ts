import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";

interface DataGridTableExportParams {
  tableName?: string;
  database?: string;
  connectionId: string;
  sortColumn: string | null;
  sortDir: "ASC" | "DESC";
  rowFocusFilter: string;
  isExportingFull: boolean;
  setIsExportingFull: Dispatch<SetStateAction<boolean>>;
  setExportedRowCount: Dispatch<SetStateAction<number>>;
  setError: (message: string) => void;
  exportTableData: (
    connectionId: string,
    request: {
      table: string;
      database?: string;
      format: "csv" | "jsonl";
      orderBy?: string;
      orderDir?: "ASC" | "DESC";
      filter?: string;
    },
    operationId: string,
  ) => Promise<unknown>;
  cancelTableExport: (operationId: string) => Promise<unknown>;
  tableExportOperationIdRef: RefObject<string | null>;
}

/**
 * Full-table streaming export (CSV / JSONL) with progress and cancellation.
 * Handlers are moved verbatim from the grid component body.
 */
export function useDataGridTableExport({
  tableName,
  database,
  connectionId,
  sortColumn,
  sortDir,
  rowFocusFilter,
  isExportingFull,
  setIsExportingFull,
  setExportedRowCount,
  setError,
  exportTableData,
  cancelTableExport,
  tableExportOperationIdRef,
}: DataGridTableExportParams) {
  const handleFullTableExport = useCallback(async (format: "csv" | "jsonl") => {
    if (!tableName || isExportingFull) return;
    const operationId = `export-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    tableExportOperationIdRef.current = operationId;
    setExportedRowCount(0);
    setIsExportingFull(true);
    try {
      await exportTableData(connectionId, {
        table: tableName,
        database,
        format,
        orderBy: sortColumn ?? undefined,
        orderDir: sortColumn ? sortDir : undefined,
        filter: rowFocusFilter || undefined,
      }, operationId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/cancel/i.test(message)) setError(`Full table export failed: ${message}`);
    } finally {
      tableExportOperationIdRef.current = null;
      setIsExportingFull(false);
    }
  }, [connectionId, database, exportTableData, isExportingFull, rowFocusFilter, setError, sortColumn, sortDir, tableName]);

  const handleCancelFullTableExport = useCallback(async () => {
    const operationId = tableExportOperationIdRef.current;
    if (!operationId) return;
    try {
      await cancelTableExport(operationId);
    } catch (error) {
      setError(`Could not cancel table export: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [cancelTableExport, setError]);

  return {
    handleFullTableExport,
    handleCancelFullTableExport,
  };
}
