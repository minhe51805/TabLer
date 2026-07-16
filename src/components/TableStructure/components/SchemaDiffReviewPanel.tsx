import { AlertCircle, FileCode, X } from "lucide-react";
import type { SchemaMigrationReview, TableSchemaDiff } from "@/utils/schema-diff";

interface Props {
  diff: TableSchemaDiff;
  review: SchemaMigrationReview;
  onOpenSql: () => void;
  onClose: () => void;
}

export function SchemaDiffReviewPanel({ diff, review, onOpenSql, onClose }: Props) {
  const changeCount = diff.addedColumns.length + diff.droppedColumns.length + diff.changedColumns.length;

  return (
    <div className="structure-editor-overlay" onClick={onClose}>
      <div className="structure-editor-modal schema-diff-modal" onClick={(event) => event.stopPropagation()}>
        <div className="structure-editor-header">
          <div className="structure-editor-copy">
            <span className="structure-topbar-kicker">Schema Diff</span>
            <h3 className="structure-editor-title">{changeCount ? `${changeCount} change${changeCount === 1 ? "" : "s"} since snapshot` : "No schema changes"}</h3>
            <p className="structure-editor-subtitle">Generated migration SQL is review-only. Nothing in this panel runs against the database.</p>
          </div>
          <button type="button" className="structure-editor-close" onClick={onClose} aria-label="Close schema diff">
            <X className="w-4 h-4" />
          </button>
        </div>

        {review.warnings.length > 0 && (
          <div className="structure-editor-alert">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{review.warnings.join(" ")}</span>
          </div>
        )}

        <div className="schema-diff-summary">
          <span className="schema-diff-count added">+{diff.addedColumns.length} added</span>
          <span className="schema-diff-count changed">~{diff.changedColumns.length} changed</span>
          <span className="schema-diff-count removed">-{diff.droppedColumns.length} removed</span>
        </div>

        {changeCount > 0 && (
          <div className="structure-review-list">
            {diff.addedColumns.map((column) => <div className="structure-review-card" key={`add-${column.name}`}><strong>Added {column.name}</strong><span>{column.column_type || column.data_type}</span></div>)}
            {diff.changedColumns.map((change) => <div className="structure-review-card" key={`change-${change.column}`}><strong>Changed {change.column}</strong><span>{change.fields.join(", ")}</span></div>)}
            {diff.droppedColumns.map((column) => <div className="structure-review-card destructive" key={`drop-${column.name}`}><strong>Removed {column.name}</strong><span>This is destructive and needs a backup review.</span></div>)}
          </div>
        )}

        {review.statements.length > 0 && <pre className="structure-editor-preview">{`${review.statements.join(";\n")};`}</pre>}

        <div className="structure-editor-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Close</button>
          {review.statements.length > 0 && <button type="button" className="btn btn-secondary" onClick={onOpenSql}><FileCode className="w-4 h-4" /><span>Open SQL draft</span></button>}
        </div>
      </div>
    </div>
  );
}
