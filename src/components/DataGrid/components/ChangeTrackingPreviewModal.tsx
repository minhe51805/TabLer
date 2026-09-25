/**
 * Change Tracking Preview Modal — shows staged changes as SQL diff before commit.
 */
import { X, Check, AlertTriangle } from "lucide-react";
import { StagedChangeDetail } from "./StagedChangeDetail";
import {
  useChangeTrackingStore,
  changeScopeKey,
  changeMatchesScope,
} from "../../../stores/change-tracking-store";

interface Props {
  connectionId: string;
  tableName?: string;
  database?: string;
  onApply: () => void;
  onDiscard: () => void;
  isApplying?: boolean;
}

export function ChangeTrackingPreviewModal({
  connectionId,
  tableName,
  database,
  onApply,
  onDiscard,
  isApplying = false,
}: Props) {
  const { stagedChanges, isPreviewOpen, selectedChangeId, selectChange, closePreview } =
    useChangeTrackingStore();

  const scope = tableName ? changeScopeKey(connectionId, database, tableName) : "";
  const tableChanges = stagedChanges.filter((c) => changeMatchesScope(c, scope));

  if (!isPreviewOpen || tableChanges.length === 0) {
    return null;
  }

  const selectedChange = tableChanges.find((c) => c.id === selectedChangeId) ?? tableChanges[0];

  return (
    <div className="change-tracking-modal-backdrop" onClick={closePreview}>
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
          <button type="button" className="ct-modal-close" onClick={closePreview}>
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

          <StagedChangeDetail
            selectedChange={selectedChange}
            allChanges={tableChanges}
            sqlLabel="SQL to execute"
            copyAllLabel="Copy all"
            cellChangesLabel="Cell changes"
          />
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
                  <span>
                    Apply {tableChanges.length} Change{tableChanges.length !== 1 ? "s" : ""}
                  </span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
