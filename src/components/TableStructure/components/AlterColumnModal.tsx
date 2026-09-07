import { AlertCircle, Check, FileCode, Trash2, X } from "lucide-react";
import type { DefaultMode } from "../utils/dialect-sql-generator";
import type { ColumnEditorState, BuildColumnSqlResult } from "../utils/dialect-sql-generator";

interface Props {
  columnEditor: ColumnEditorState;
  sqlPreview: BuildColumnSqlResult;
  editorError: string | null;
  dbType: string;
  onClose: () => void;
  onUpdate: (updates: Partial<ColumnEditorState>) => void;
  onStageChange: () => void;
  onStageDelete: () => void;
  onOpenSql: () => void;
}

export function AlterColumnModal({
  columnEditor,
  sqlPreview,
  editorError,
  dbType,
  onClose,
  onUpdate,
  onStageChange,
  onStageDelete,
  onOpenSql,
}: Props) {
  return (
    <div className="structure-editor-overlay" onClick={onClose}>
      <div className="structure-editor-modal" onClick={(event) => event.stopPropagation()}>
        <div className="structure-editor-header">
          <div className="structure-editor-copy">
            <span className="structure-topbar-kicker">Column Action</span>
            <h3 className="structure-editor-title">Edit {columnEditor.originalName}</h3>
            <p className="structure-editor-subtitle">
              Stage column edits or deletion first, then review the generated SQL before applying.
            </p>
          </div>

          <button
            type="button"
            className="structure-editor-close"
            onClick={onClose}
            aria-label="Close column editor"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="structure-editor-grid">
          <label className="structure-editor-field">
            <span className="form-label">Column Name</span>
            <input
              className="input"
              value={columnEditor.name}
              onChange={(event) => onUpdate({ name: event.target.value })}
            />
          </label>

          <label className="structure-editor-field">
            <span className="form-label">Type</span>
            <input
              className="input"
              value={columnEditor.dataType}
              onChange={(event) => onUpdate({ dataType: event.target.value })}
            />
          </label>

          <label className="structure-editor-field">
            <span className="form-label">Nullable</span>
            <button
              type="button"
              className={`structure-toggle ${columnEditor.nullable ? "on" : ""}`}
              disabled={columnEditor.isPrimaryKey}
              onClick={() => onUpdate({ nullable: !columnEditor.nullable })}
            >
              <span className="structure-toggle-track">
                <span className="structure-toggle-thumb" />
              </span>
              <span className="structure-toggle-copy">
                {columnEditor.isPrimaryKey
                  ? "Primary keys stay NOT NULL"
                  : columnEditor.nullable
                    ? "Allows NULL"
                    : "Requires a value"}
              </span>
            </button>
          </label>

          <div className="structure-editor-field structure-editor-field-wide">
            <span className="form-label">Default Behavior</span>
            <div className="structure-mode-group">
              {(["keep", "set", "drop"] as DefaultMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={`structure-mode-btn ${columnEditor.defaultMode === mode ? "active" : ""}`}
                  onClick={() => onUpdate({ defaultMode: mode })}
                >
                  {mode === "keep"
                    ? "Keep current"
                    : mode === "set"
                      ? "Set new default"
                      : "Drop default"}
                </button>
              ))}
            </div>
          </div>

          <label className="structure-editor-field structure-editor-field-wide">
            <span className="form-label">Default SQL Expression</span>
            <input
              className="input"
              value={columnEditor.defaultValue}
              disabled={columnEditor.defaultMode !== "set"}
              placeholder="'value', CURRENT_TIMESTAMP, gen_random_uuid()"
              onChange={(event) => onUpdate({ defaultValue: event.target.value })}
            />
            <span className="structure-editor-hint">
              Enter raw SQL. For strings, wrap the value in single quotes.
            </span>
          </label>
        </div>

        <div className="structure-editor-preview-shell">
          <div className="structure-editor-preview-head">
            <span className="form-label">SQL Preview</span>
            <span className={`structure-editor-db-pill ${dbType === "sqlite" ? "muted" : ""}`}>
              {dbType.toUpperCase()}
            </span>
          </div>
          <pre className="structure-editor-preview">
            {sqlPreview.error
              ? sqlPreview.error
              : sqlPreview.statements.length > 0
                ? `${sqlPreview.statements.join(";\n")};`
                : "Change a field above to generate ALTER TABLE SQL."}
          </pre>
        </div>

        {editorError && (
          <div className="structure-editor-alert">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{editorError}</span>
          </div>
        )}

        <div className="structure-editor-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>

          <div className="structure-editor-footer-actions">
            <button
              type="button"
              className="btn btn-secondary danger"
              onClick={onStageDelete}
            >
              <Trash2 className="w-4 h-4" />
              <span>Stage Delete</span>
            </button>

            <button
              type="button"
              className="btn btn-secondary"
              onClick={onOpenSql}
              disabled={!!sqlPreview.error || sqlPreview.statements.length === 0}
            >
              <FileCode className="w-4 h-4" />
              <span>Open SQL</span>
            </button>

            <button
              type="button"
              className="btn btn-primary"
              onClick={onStageChange}
              disabled={!!sqlPreview.error || sqlPreview.statements.length === 0}
            >
              <Check className="w-4 h-4" />
              <span>Stage Change</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
