import { AlertCircle, Check, FileCode, Loader2, X } from "lucide-react";
import type { StagedColumnChange } from "../utils/dialect-sql-generator";

interface Props {
  stagedColumnChanges: Record<string, StagedColumnChange>;
  destructiveChanges: StagedColumnChange[];
  reviewError: string | null;
  isApplyingChanges: boolean;
  pendingChangeCount: number;
  tableName: string;
  onDiscard: () => void;
  onApply: () => void;
  onOpenSql: () => void;
  onClose: () => void;
}

export function ReviewPanel({
  stagedColumnChanges,
  destructiveChanges,
  reviewError,
  isApplyingChanges,
  pendingChangeCount,
  onDiscard,
  onApply,
  onOpenSql,
  onClose,
}: Props) {
  return (
    <div className="structure-editor-overlay" onClick={onClose}>
      <div className="structure-editor-modal" onClick={(event) => event.stopPropagation()}>
        <div className="structure-editor-header">
          <div className="structure-editor-copy">
            <span className="structure-topbar-kicker">Schema Review</span>
            <h3 className="structure-editor-title">Review staged SQL</h3>
            <p className="structure-editor-subtitle">
              Preview every statement before it changes the table.
            </p>
          </div>

          <button
            type="button"
            className="structure-editor-close"
            onClick={onClose}
            aria-label="Close SQL review"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="structure-review-list">
          {destructiveChanges.length > 0 && (
            <div className="structure-editor-alert">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>
                This review includes {destructiveChanges.length} destructive change
                {destructiveChanges.length === 1 ? "" : "s"}. Dropped columns cannot be restored automatically.
              </span>
            </div>
          )}

          {Object.values(stagedColumnChanges).map((change) => (
            <div key={change.original.name} className="structure-review-card">
              <div className="structure-review-head">
                <span className="structure-review-title">
                  {change.action === "drop"
                    ? `Drop ${change.original.name}`
                    : `${change.original.name} -> ${change.draft?.name || change.original.name}`}
                </span>
                <span className="structure-inline-pill staged">
                  {change.action === "drop" ? "Delete column" : "Column change"}
                </span>
              </div>
              <pre className="structure-editor-preview">{`${change.statements.join(";\n")};`}</pre>
            </div>
          ))}
        </div>

        {reviewError && (
          <div className="structure-editor-alert">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{reviewError}</span>
          </div>
        )}

        <div className="structure-editor-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>

          <div className="structure-editor-footer-actions">
            <button type="button" className="btn btn-secondary" onClick={onDiscard}>
              Discard
            </button>
            <button type="button" className="btn btn-secondary" onClick={onOpenSql}>
              <FileCode className="w-4 h-4" />
              <span>Open SQL</span>
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={onApply}
              disabled={isApplyingChanges || pendingChangeCount === 0}
            >
              {isApplyingChanges ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Check className="w-4 h-4" />
              )}
              <span>Apply</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
