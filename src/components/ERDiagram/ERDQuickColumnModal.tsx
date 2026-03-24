import { AlertCircle, Check, FileCode, X } from "lucide-react";
import type { ColumnEditorState, BuildColumnSqlResult, DefaultMode } from "../TableStructure/utils/dialect-sql-generator";

interface Props {
  tableName: string;
  columnName: string;
  dbType: string;
  editor: ColumnEditorState;
  sqlPreview: BuildColumnSqlResult;
  editorError: string | null;
  isSaving: boolean;
  onClose: () => void;
  onUpdate: (updates: Partial<ColumnEditorState>) => void;
  onApply: () => void;
  onOpenFullEditor: () => void;
}

export function ERDQuickColumnModal({
  tableName,
  columnName,
  dbType,
  editor,
  sqlPreview,
  editorError,
  isSaving,
  onClose,
  onUpdate,
  onApply,
  onOpenFullEditor,
}: Props) {
  return (
    <div className="erd-quick-editor-backdrop" onClick={onClose}>
      <div className="erd-quick-editor-shell" onClick={(event) => event.stopPropagation()}>
        <div className="erd-quick-editor-header">
          <div className="erd-quick-editor-copy">
            <span className="erd-quick-editor-kicker">Quick Column Edit</span>
            <strong className="erd-quick-editor-title">{columnName}</strong>
            <span className="erd-quick-editor-meta">{tableName}</span>
          </div>

          <button type="button" className="erd-quick-editor-close" onClick={onClose} aria-label="Close quick editor">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="erd-quick-editor-grid">
          <label className="erd-quick-editor-field">
            <span className="form-label">Column name</span>
            <input className="input" value={editor.name} onChange={(event) => onUpdate({ name: event.target.value })} />
          </label>

          <label className="erd-quick-editor-field">
            <span className="form-label">Type</span>
            <input className="input" value={editor.dataType} onChange={(event) => onUpdate({ dataType: event.target.value })} />
          </label>

          <label className="erd-quick-editor-field erd-quick-editor-field-wide">
            <span className="form-label">Nullable</span>
            <button
              type="button"
              className={`structure-toggle ${editor.nullable ? "on" : ""}`}
              disabled={editor.isPrimaryKey}
              onClick={() => onUpdate({ nullable: !editor.nullable })}
            >
              <span className="structure-toggle-track">
                <span className="structure-toggle-thumb" />
              </span>
              <span className="structure-toggle-copy">
                {editor.isPrimaryKey ? "Primary keys stay NOT NULL" : editor.nullable ? "Allows NULL" : "Requires a value"}
              </span>
            </button>
          </label>

          <div className="erd-quick-editor-field erd-quick-editor-field-wide">
            <span className="form-label">Default</span>
            <div className="structure-mode-group">
              {(["keep", "set", "drop"] as DefaultMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={`structure-mode-btn ${editor.defaultMode === mode ? "active" : ""}`}
                  onClick={() => onUpdate({ defaultMode: mode })}
                >
                  {mode === "keep" ? "Keep" : mode === "set" ? "Set" : "Drop"}
                </button>
              ))}
            </div>
          </div>

          <label className="erd-quick-editor-field erd-quick-editor-field-wide">
            <span className="form-label">Default expression</span>
            <input
              className="input"
              value={editor.defaultValue}
              disabled={editor.defaultMode !== "set"}
              placeholder="'value', CURRENT_TIMESTAMP, gen_random_uuid()"
              onChange={(event) => onUpdate({ defaultValue: event.target.value })}
            />
          </label>
        </div>

        <div className="erd-quick-editor-preview">
          <div className="erd-quick-editor-preview-head">
            <span className="form-label">SQL preview</span>
            <span className="erd-quick-editor-db-pill">{dbType.toUpperCase()}</span>
          </div>
          <pre className="erd-quick-editor-code">
            {sqlPreview.error
              ? sqlPreview.error
              : sqlPreview.statements.length > 0
                ? `${sqlPreview.statements.join(";\n")};`
                : "Change a field above to generate ALTER TABLE SQL."}
          </pre>
        </div>

        {editorError && (
          <div className="erd-quick-editor-alert">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{editorError}</span>
          </div>
        )}

        <div className="erd-quick-editor-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-secondary" onClick={onOpenFullEditor}>
            <FileCode className="w-4 h-4" />
            <span>Full editor</span>
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onApply}
            disabled={isSaving || !!sqlPreview.error || sqlPreview.statements.length === 0}
          >
            {isSaving ? <span>Applying...</span> : <><Check className="w-4 h-4" /><span>Apply</span></>}
          </button>
        </div>
      </div>
    </div>
  );
}
