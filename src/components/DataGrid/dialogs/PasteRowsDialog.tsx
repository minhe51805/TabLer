import { ClipboardPaste, Loader2, X } from "lucide-react";
import type { PastePreview } from "../../../utils/clipboard-parser";
import { useI18n } from "../../../i18n";

export interface CsvFileSelection {
  filePath: string;
  delimiter: "csv" | "tsv";
  byteSize: number;
  isTruncated: boolean;
}

interface PasteRowsDialogProps {
  tableName?: string;
  pasteSourceLabel: string;
  csvFileSelection: CsvFileSelection | null;
  isSubmittingPaste: boolean;
  isCancellingPaste: boolean;
  csvImportProgress: {
    processedRows: number;
    processedBytes: number;
    totalBytes: number;
  } | null;
  pastePreview: PastePreview;
  onClose: () => void;
  onSubmit: () => void;
  onCancel: () => void;
}

/** Portal content for the paste / CSV-import preview dialog. */
export function PasteRowsDialog({
  tableName,
  pasteSourceLabel,
  csvFileSelection,
  isSubmittingPaste,
  isCancellingPaste,
  csvImportProgress,
  pastePreview,
  onClose,
  onSubmit,
  onCancel,
}: PasteRowsDialogProps) {
  const { t } = useI18n();
  return (
    <div className="datagrid-insert-dialog-backdrop" onClick={onClose}>
      <div
        className="datagrid-insert-dialog"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="datagrid-paste-dialog-title"
      >
        <div className="datagrid-insert-dialog-header">
          <div className="datagrid-insert-dialog-copy">
            <span className="datagrid-insert-dialog-kicker">{pasteSourceLabel}</span>
            <h3 id="datagrid-paste-dialog-title" className="datagrid-insert-dialog-title">
              {csvFileSelection
                ? t("datagrid.pasteImportInto", { table: tableName?.split(".").pop() || tableName || "table" })
                : tableName
                  ? t("datagrid.pasteInsertInto", { count: pastePreview.rowCount, table: tableName.split(".").pop() || tableName })
                  : t("datagrid.pasteInsertCount", { count: pastePreview.rowCount })}
            </h3>
            <p className="datagrid-insert-dialog-description">
              {t("datagrid.pasteDescription")} ({pastePreview.firstRowWasHeader ? t("datagrid.pasteHeadersDetected") : t("datagrid.pastePositional")}):
              {pastePreview.nullColumns.length > 0 && ` ${t("datagrid.pasteNullOmitted", { columns: pastePreview.nullColumns.join(", ") })}`}
              {pastePreview.skippedColumns.length > 0 && ` ${t("datagrid.pasteSkippedInline", { columns: pastePreview.skippedColumns.map((c) => `"${c.header}"`).join(", ") })}`}
            </p>
          </div>
          <button
            type="button"
            className="datagrid-insert-dialog-close"
            onClick={onClose}
            aria-label={t("datagrid.pasteCloseAria")}
            disabled={isSubmittingPaste}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="datagrid-paste-preview">
          {pastePreview.mappings.length > 0 && (
            <div className="datagrid-paste-mappings">
              <p className="datagrid-paste-section-label">{t("datagrid.pasteMappingsTitle")}</p>
              <table className="datagrid-paste-mapping-table">
                <thead>
                  <tr>
                    <th>{t("datagrid.pasteClipboardColumn")}</th>
                    <th></th>
                    <th>{t("datagrid.pasteTableColumn")}</th>
                  </tr>
                </thead>
                <tbody>
                  {pastePreview.mappings.map((m) => (
                    <tr key={m.tableColumnIndex}>
                      <td><code>{m.clipboardHeader}</code></td>
                      <td style={{ textAlign: "center" }}>→</td>
                      <td><code>{m.tableColumnName}</code></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {pastePreview.skippedColumns.length > 0 && (
            <div className="datagrid-paste-section">
              <p className="datagrid-paste-section-label">{t("datagrid.pasteSkippedTitle")}</p>
              <div className="datagrid-paste-chip-list">
                {pastePreview.skippedColumns.map((c) => (
                  <span key={c.index} className="datagrid-paste-chip skipped">{c.header || t("datagrid.pasteColumnFallback", { index: c.index + 1 })}</span>
                ))}
              </div>
            </div>
          )}
          <div className="datagrid-paste-summary">
            <strong>{pastePreview.rowCount}</strong> {csvFileSelection?.isTruncated ? t("datagrid.pastePreviewStreaming") : t("datagrid.pasteRowsToInsert")}
            {pastePreview.nullColumns.length > 0 && `, <strong>${pastePreview.nullColumns.length}</strong> ${t("datagrid.pasteNullDefaults", { count: pastePreview.nullColumns.length })}`}
          </div>
          {isSubmittingPaste && csvFileSelection && csvImportProgress && (
            <div className="datagrid-import-progress" aria-live="polite">
              <progress
                max={Math.max(1, csvImportProgress.totalBytes)}
                value={csvImportProgress.processedBytes}
              />
              <span>
                {t("datagrid.pasteRowsProcessed", { count: csvImportProgress.processedRows.toLocaleString() })}
                {csvImportProgress.totalBytes > 0
                  ? ` (${Math.min(100, Math.round((csvImportProgress.processedBytes / csvImportProgress.totalBytes) * 100))}%)`
                  : ""}
              </span>
            </div>
          )}
        </div>

        <div className="datagrid-insert-dialog-actions">
          <button
            type="button"
            className="datagrid-insert-dialog-btn"
            onClick={() => {
              if (isSubmittingPaste) {
                onCancel();
              } else {
                onClose();
              }
            }}
            disabled={isCancellingPaste}
          >
            {isSubmittingPaste ? (isCancellingPaste ? t("datagrid.pasteCancelling") : t("datagrid.pasteCancelImport")) : t("common.cancel")}
          </button>
          <button
            type="button"
            className="datagrid-insert-dialog-btn is-primary"
            onClick={onSubmit}
            disabled={isSubmittingPaste}
          >
            {isSubmittingPaste ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                {csvFileSelection ? t("datagrid.pasteStreaming") : t("datagrid.pasteImportingAtomic", { count: pastePreview.rowCount })}
              </>
            ) : (
              <>
                <ClipboardPaste className="w-4 h-4" />
                {csvFileSelection ? t("datagrid.pasteImportFull") : t("datagrid.pasteInsertCount", { count: pastePreview.rowCount })}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
