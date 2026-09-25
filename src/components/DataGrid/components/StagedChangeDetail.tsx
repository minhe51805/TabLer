/**
 * StagedChangeDetail — shared SQL preview + cell-diff pane for staged
 * changes. Used by the per-grid ChangeTrackingPreviewModal and by the
 * Review Center's Pending edits tab.
 */

import { Copy } from "lucide-react";
import type { StagedChange } from "../../../types/change-tracking";

interface StagedChangeDetailProps {
  /** The change whose SQL/diff is shown; null renders nothing selectable. */
  selectedChange: StagedChange | null;
  /** All changes in scope — the copy button copies every preview. */
  allChanges: StagedChange[];
  sqlLabel: string;
  copyAllLabel: string;
  cellChangesLabel: string;
}

export function StagedChangeDetail({
  selectedChange,
  allChanges,
  sqlLabel,
  copyAllLabel,
  cellChangesLabel,
}: StagedChangeDetailProps) {
  const copySql = () => {
    const allSql = allChanges.map((c) => c.sqlPreview).join("\n");
    void navigator.clipboard.writeText(allSql);
  };

  return (
    <div className="ct-sql-preview">
      <div className="ct-sql-preview-header">
        <span className="ct-sql-preview-label">{sqlLabel}</span>
        <button type="button" className="ct-copy-btn" onClick={copySql} title={copyAllLabel}>
          <Copy className="!w-3 !h-3" />
          <span>{copyAllLabel}</span>
        </button>
      </div>
      {selectedChange ? (
        <div className="ct-sql-code">
          <pre>{selectedChange.sqlPreview}</pre>
        </div>
      ) : (
        <div className="ct-sql-code">
          <pre>{allChanges.map((c) => c.sqlPreview).join("\n")}</pre>
        </div>
      )}

      {selectedChange && selectedChange.type === "update" && (
        <div className="ct-diff-detail">
          <div className="ct-diff-header">
            <span className="ct-diff-title">{cellChangesLabel}</span>
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
  );
}
