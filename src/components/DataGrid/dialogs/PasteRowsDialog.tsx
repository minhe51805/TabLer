import { ClipboardPaste, Loader2, X } from "lucide-react";
import type { PastePreview } from "../../../utils/clipboard-parser";

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
                ? `Import full file into ${tableName?.split(".").pop() || tableName || "table"}`
                : tableName ? `Insert ${pastePreview.rowCount} row${pastePreview.rowCount !== 1 ? "s" : ""} into ${tableName.split(".").pop() || tableName}` : `Insert ${pastePreview.rowCount} row${pastePreview.rowCount !== 1 ? "s" : ""}`}
            </h3>
            <p className="datagrid-insert-dialog-description">
              Column mappings from clipboard ({pastePreview.firstRowWasHeader ? "headers detected" : "positional mapping"}):
              {pastePreview.nullColumns.length > 0 && ` Unmapped table columns are omitted so database defaults can apply: ${pastePreview.nullColumns.join(", ")}`}
              {pastePreview.skippedColumns.length > 0 && ` Skipped clipboard columns: ${pastePreview.skippedColumns.map((c) => `"${c.header}"`).join(", ")}`}
            </p>
          </div>
          <button
            type="button"
            className="datagrid-insert-dialog-close"
            onClick={onClose}
            aria-label="Close paste dialog"
            disabled={isSubmittingPaste}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="datagrid-paste-preview">
          {pastePreview.mappings.length > 0 && (
            <div className="datagrid-paste-mappings">
              <p className="datagrid-paste-section-label">Column mappings</p>
              <table className="datagrid-paste-mapping-table">
                <thead>
                  <tr>
                    <th>Clipboard column</th>
                    <th></th>
                    <th>Table column</th>
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
              <p className="datagrid-paste-section-label">Skipped clipboard columns (no matching table column)</p>
              <div className="datagrid-paste-chip-list">
                {pastePreview.skippedColumns.map((c) => (
                  <span key={c.index} className="datagrid-paste-chip skipped">{c.header || `Column ${c.index + 1}`}</span>
                ))}
              </div>
            </div>
          )}
          <div className="datagrid-paste-summary">
            <strong>{pastePreview.rowCount}</strong> {csvFileSelection?.isTruncated ? "preview rows checked; the full file will stream" : `row${pastePreview.rowCount !== 1 ? "s" : ""} to insert`}
            {pastePreview.nullColumns.length > 0 && `, <strong>${pastePreview.nullColumns.length}</strong> column(s) use database defaults`}
          </div>
          {isSubmittingPaste && csvFileSelection && csvImportProgress && (
            <div className="datagrid-import-progress" aria-live="polite">
              <progress
                max={Math.max(1, csvImportProgress.totalBytes)}
                value={csvImportProgress.processedBytes}
              />
              <span>
                {csvImportProgress.processedRows.toLocaleString()} rows processed
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
            {isSubmittingPaste ? (isCancellingPaste ? "Cancelling..." : "Cancel import") : "Cancel"}
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
                {csvFileSelection ? "Streaming file in one transaction..." : `Importing ${pastePreview.rowCount} rows atomically...`}
              </>
            ) : (
              <>
                <ClipboardPaste className="w-4 h-4" />
                {csvFileSelection ? "Import full file" : `Insert ${pastePreview.rowCount} row${pastePreview.rowCount !== 1 ? "s" : ""}`}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
