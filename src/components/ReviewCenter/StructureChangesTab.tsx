/**
 * Structure Changes tab — pending column edits staged inside mounted
 * TableStructure tabs. Applying stays inside the table's own review panel
 * (it owns the destructive-change confirmations), so each row deep-links:
 * the modal closes and the structure tab opens its review overlay.
 */
import { Columns3, GitCompareArrows } from "lucide-react";
import { useStructureReviewRegistry } from "./structure-review-registry";
import { useReviewCenterStore } from "./review-center-store";
import type { ReviewCenterCopy } from "./review-center-copy";

interface StructureChangesTabProps {
  copy: ReviewCenterCopy;
}

export function StructureChangesTab({ copy }: StructureChangesTabProps) {
  const entries = useStructureReviewRegistry((s) => s.entries);
  const close = useReviewCenterStore((s) => s.close);

  const list = Object.values(entries).filter((entry) => entry.pendingCount > 0);

  if (list.length === 0) {
    return (
      <div className="rc-empty">
        <p>{copy.structure.empty}</p>
        <p className="rc-empty-hint">{copy.structure.hint}</p>
      </div>
    );
  }

  return (
    <div className="rc-structure-list">
      <p className="rc-structure-hint">{copy.structure.hint}</p>
      {list.map((entry) => (
        <div key={entry.key} className="rc-structure-row">
          <span className="rc-structure-icon">
            <Columns3 className="!w-4 !h-4" />
          </span>
          <div className="rc-structure-meta">
            <strong>{entry.tableName}</strong>
            <span>
              {entry.database ? `${entry.database} · ` : ""}
              {entry.connectionId}
            </span>
          </div>
          <span className="rc-pending-badge">
            {copy.structure.pendingBadge(entry.pendingCount)}
          </span>
          <div className="rc-structure-actions">
            <button
              type="button"
              className="rc-mini-btn"
              onClick={() => {
                close();
                entry.openSchemaDiff();
              }}
            >
              <GitCompareArrows className="!w-3 !h-3" />
              <span>{copy.structure.compareSnapshot}</span>
            </button>
            <button
              type="button"
              className="rc-mini-btn primary"
              onClick={() => {
                close();
                entry.openReview();
              }}
            >
              {copy.structure.openReview}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
