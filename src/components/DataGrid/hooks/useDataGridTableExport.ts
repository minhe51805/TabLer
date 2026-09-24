import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import { requestAppConfirmation } from "../../../stores/confirmStore";
import type { TableFilterPlan } from "./useDataGrid";
import { getCurrentAppLanguage } from "../../../i18n";
import { getDataGridMaskingCopy } from "../datagrid-masking-copy";

/** Error prefix the backend emits when the picked export path already exists. */
const EXPORT_FILE_EXISTS_CODE = "TABLER_EXPORT_FILE_EXISTS";

interface DataGridTableExportParams {
  tableName?: string;
  database?: string;
  connectionId: string;
  sortColumn: string | null;
  sortDir: "ASC" | "DESC";
  /** Resolved quick-filter plan: server clause + client-side-only flag. */
  filterPlan: TableFilterPlan;
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
      overwrite?: boolean;
    },
    operationId: string,
  ) => Promise<unknown>;
  cancelTableExport: (operationId: string) => Promise<unknown>;
  tableExportOperationIdRef: RefObject<string | null>;
  /** True while any column mask is active — streaming export cannot mask. */
  masksActive?: boolean;
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
  filterPlan,
  isExportingFull,
  setIsExportingFull,
  setExportedRowCount,
  setError,
  exportTableData,
  cancelTableExport,
  tableExportOperationIdRef,
  masksActive,
}: DataGridTableExportParams) {
  const handleFullTableExport = useCallback(
    async (format: "csv" | "jsonl") => {
      if (!tableName || isExportingFull) return;
      // A quick filter that can't compile to a server clause would silently
      // export unfiltered rows — refuse instead of producing a misleading file.
      if (filterPlan.clientSideOnly) {
        setError(
          "Cannot export with the current filter: it can only run over loaded rows. Clear the filter or narrow it to export matching rows.",
        );
        return;
      }
      // The backend streams raw rows — it cannot apply view masks, so a
      // full-table export under active masks would leak unmasked data.
      if (masksActive) {
        setError(getDataGridMaskingCopy(getCurrentAppLanguage()).exportBlocked);
        return;
      }
      const operationId = `export-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      tableExportOperationIdRef.current = operationId;
      setExportedRowCount(0);
      setIsExportingFull(true);
      const runExport = (overwrite: boolean) =>
        exportTableData(
          connectionId,
          {
            table: tableName,
            database,
            format,
            orderBy: sortColumn ?? undefined,
            orderDir: sortColumn ? sortDir : undefined,
            filter: filterPlan.serverFilter || undefined,
            overwrite,
          },
          operationId,
        );
      try {
        await runExport(false);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes(EXPORT_FILE_EXISTS_CODE)) {
          const confirmed = await requestAppConfirmation({
            title: "Replace existing file?",
            message: message.replace(`${EXPORT_FILE_EXISTS_CODE}: `, ""),
            confirmText: "Overwrite",
          });
          if (confirmed) {
            try {
              await runExport(true);
            } catch (retryError) {
              const retryMessage =
                retryError instanceof Error ? retryError.message : String(retryError);
              if (!/cancel/i.test(retryMessage))
                setError(`Full table export failed: ${retryMessage}`);
            }
          }
        } else if (!/cancel/i.test(message)) {
          setError(`Full table export failed: ${message}`);
        }
      } finally {
        tableExportOperationIdRef.current = null;
        setIsExportingFull(false);
      }
    },
    [
      connectionId,
      database,
      exportTableData,
      filterPlan,
      isExportingFull,
      setError,
      setExportedRowCount,
      setIsExportingFull,
      sortColumn,
      sortDir,
      tableExportOperationIdRef,
      masksActive,
      tableName,
    ],
  );

  const handleCancelFullTableExport = useCallback(async () => {
    const operationId = tableExportOperationIdRef.current;
    if (!operationId) return;
    try {
      await cancelTableExport(operationId);
    } catch (error) {
      setError(
        `Could not cancel table export: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }, [cancelTableExport, setError, tableExportOperationIdRef]);

  return {
    handleFullTableExport,
    handleCancelFullTableExport,
  };
}
