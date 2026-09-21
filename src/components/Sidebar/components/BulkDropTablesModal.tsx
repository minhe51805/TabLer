import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Loader2, X } from "lucide-react";
import type { BulkActionsCopy } from "../bulk-actions-copy";

/** Typed phrase required to arm the destructive confirm button. */
export const BULK_DROP_CONFIRM_PHRASE = "DROP";

export interface BulkDropTablePreview {
  /** Qualified display name (schema.table where a schema exists). */
  qualifiedName: string;
  /** Read-only COUNT(*) preview; null while counting, undefined on failure. */
  rowCount: number | null | undefined;
}

interface BulkDropTablesModalProps {
  isOpen: boolean;
  tables: BulkDropTablePreview[];
  /** True while row-count previews are still loading. */
  isLoadingCounts: boolean;
  isDropping: boolean;
  copy: BulkActionsCopy;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Typed-phrase confirmation for dropping multiple explorer tables. The row
 * counts are fetched before/at open time so the user sees the blast radius
 * before typing the phrase.
 */
export function BulkDropTablesModal({
  isOpen,
  tables,
  isLoadingCounts,
  isDropping,
  copy,
  onConfirm,
  onCancel,
}: BulkDropTablesModalProps) {
  const [phrase, setPhrase] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    setPhrase("");
    inputRef.current?.focus();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isDropping) onCancel();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, isDropping, onCancel]);

  const knownTotal = useMemo(
    () =>
      tables.reduce<number | null>(
        (total, table) =>
          total === null || typeof table.rowCount !== "number" ? null : total + table.rowCount,
        0,
      ),
    [tables],
  );

  if (!isOpen) return null;

  const phraseOk = phrase.trim().toUpperCase() === BULK_DROP_CONFIRM_PHRASE;

  return createPortal(
    <div className="confirm-dialog-backdrop" onClick={() => !isDropping && onCancel()}>
      <div
        className="confirm-dialog bulk-drop-dialog"
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
      >
        <div className="confirm-dialog-header">
          <div className="confirm-dialog-header-icon">
            <AlertTriangle className="w-5 h-5" />
          </div>
          <button
            type="button"
            className="confirm-dialog-close"
            onClick={onCancel}
            disabled={isDropping}
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="confirm-dialog-body">
          <h3 className="confirm-dialog-title">{copy.dropTitle(tables.length)}</h3>
          <p className="confirm-dialog-message">{copy.dropDescription}</p>

          <div className="bulk-drop-table-list">
            {tables.map((table) => (
              <div key={table.qualifiedName} className="bulk-drop-table-row">
                <span className="bulk-drop-table-name" title={table.qualifiedName}>
                  {table.qualifiedName}
                </span>
                <span className="bulk-drop-table-count">
                  {table.rowCount === null || isLoadingCounts ? (
                    <span className="bulk-drop-count-pending">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      {copy.dropRowsLoading}
                    </span>
                  ) : typeof table.rowCount === "number" ? (
                    `${table.rowCount.toLocaleString()} ${copy.dropRowsColumn.toLowerCase()}`
                  ) : (
                    copy.dropRowsUnknown
                  )}
                </span>
              </div>
            ))}
          </div>

          {knownTotal !== null && (
            <p className="bulk-drop-total">{copy.dropTotalRows(knownTotal)}</p>
          )}

          <label className="bulk-drop-phrase-label">
            {copy.dropTypePhrase(BULK_DROP_CONFIRM_PHRASE)}
            <input
              ref={inputRef}
              type="text"
              className="bulk-drop-phrase-input"
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              placeholder={BULK_DROP_CONFIRM_PHRASE}
              disabled={isDropping}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        </div>
        <div className="confirm-dialog-actions">
          <button
            type="button"
            className="confirm-dialog-btn confirm-dialog-btn-cancel"
            onClick={onCancel}
            disabled={isDropping}
          >
            {copy.cancel}
          </button>
          <button
            type="button"
            className="confirm-dialog-btn confirm-dialog-btn-confirm"
            onClick={onConfirm}
            disabled={!phraseOk || isDropping || isLoadingCounts}
          >
            {isDropping ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            {copy.dropConfirm(tables.length)}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
