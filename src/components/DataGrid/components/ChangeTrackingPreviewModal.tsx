/**
 * Change Tracking Preview Modal — shows staged changes as SQL diff before commit.
 */
import { X, Copy, Check, AlertTriangle } from "lucide-react";
import { useChangeTrackingStore } from "../../../stores/change-tracking-store";

interface Props {
  tableName?: string;
  database?: string;
  onApply: () => void;
  onDiscard: () => void;
  isApplying?: boolean;
}

export function ChangeTrackingPreviewModal({
  tableName,
  database,
  onApply,
  onDiscard,
  isApplying = false,
}: Props) {
  const { stagedChanges, isPreviewOpen, selectedChangeId, selectChange } = useChangeTrackingStore();

  const tableChanges = stagedChanges.filter(
    (c) => c.tableName === tableName && c.database === database,
  );

  if (!isPreviewOpen || tableChanges.length === 0) {
    return null;
  }

  const selectedChange = tableChanges.find((c) => c.id === selectedChangeId) ?? tableChanges[0];

  const copySql = () => {
    const allSql = tableChanges.map((c) => c.sqlPreview).join("\n");
    void navigator.clipboard.writeText(allSql);
  };

  return (
    <div className="change-tracking-modal-backdrop" onClick={onDiscard}>
      <div
        className="change-tracking-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ct-modal-title"
      >
        {/* Header */}
        <div className="ct-modal-header">
          <div className="ct-modal-title-group">
            <span className="ct-modal-kicker">Change Tracking</span>
            <h3 id="ct-modal-title" className="ct-modal-title">
              Preview {tableChanges.length} change{tableChanges.length !== 1 ? "s" : ""}
            </h3>
            <p className="ct-modal-subtitle">
              Review the SQL that will be executed before applying changes
            </p>
          </div>
          <button
            type="button"
            className="ct-modal-close"
            onClick={onDiscard}
            aria-label="Close preview"
          >
            <X className="!w-4 !h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="ct-modal-body">
          {/* Change list sidebar */}
          <div className="ct-change-list">
            {tableChanges.map((change) => (
              <button
                key={change.id}
                type="button"
                className={`ct-change-item ${change.id === selectedChange?.id ? "selected" : ""}`}
                onClick={() => selectChange(change.id)}
              >
                <span className={`ct-change-type ct-change-type-${change.type}`}>
                  {change.type.toUpperCase()}
                </span>
                <span className="ct-change-preview">
                  {change.sqlPreview.split("\n")[0].slice(0, 40)}
                  {change.sqlPreview.length > 40 ? "..." : ""}
                </span>
              </button>
            ))}
          </div>

          {/* SQL Preview */}
          <div className="ct-sql-preview">
            <div className="ct-sql-preview-header">
              <span className="ct-sql-preview-label">SQL to execute</span>
              <button
                type="button"
                className="ct-copy-btn"
                onClick={copySql}
                title="Copy all SQL"
              >
                <Copy className="!w-3 !h-3" />
                <span>Copy all</span>
              </button>
            </div>
            {selectedChange ? (
              <div className="ct-sql-code">
                <pre>{selectedChange.sqlPreview}</pre>
              </div>
            ) : (
              <div className="ct-sql-code">
                <pre>{tableChanges.map((c) => c.sqlPreview).join("\n")}</pre>
              </div>
            )}

            {/* Diff detail */}
            {selectedChange && selectedChange.type === "update" && (
              <div className="ct-diff-detail">
                <div className="ct-diff-header">
                  <span className="ct-diff-title">Cell changes</span>
                </div>
                {Object.entries(selectedChange.columns).map(([colName, { old: oldVal, new: newVal }]) => (
                  <div key={colName} className="ct-diff-row">
                    <span className="ct-diff-col">{colName}</span>
                    <div className="ct-diff-values">
                      <span className="ct-diff-old" title="Old value">
                        {String(oldVal ?? "NULL")}
                      </span>
                      <span className="ct-diff-arrow">→</span>
                      <span className="ct-diff-new" title="New value">
                        {String(newVal ?? "NULL")}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="ct-modal-footer">
          <div className="ct-warning">
            <AlertTriangle className="!w-3 !h-3" />
            <span>Changes will be committed as a single transaction</span>
          </div>
          <div className="ct-modal-actions">
            <button
              type="button"
              className="ct-btn-secondary"
              onClick={onDiscard}
              disabled={isApplying}
            >
              <X className="!w-3.5 !h-3.5" />
              <span>Discard All</span>
            </button>
            <button
              type="button"
              className="ct-btn-primary"
              onClick={onApply}
              disabled={isApplying}
            >
              {isApplying ? (
                <>
                  <span className="ct-spinner" />
                  <span>Applying...</span>
                </>
              ) : (
                <>
                  <Check className="!w-3.5 !h-3.5" />
                  <span>Apply {tableChanges.length} Change{tableChanges.length !== 1 ? "s" : ""}</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
