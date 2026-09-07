import { Loader2, Plus, X } from "lucide-react";
import type { FormEvent } from "react";
import type { ColumnDetail } from "../../../types";
import { isBooleanColumn } from "../editors";
import type { ResolvedColumn } from "../hooks/useDataGrid";

interface InsertRowDialogProps {
  tableName?: string;
  columns: ColumnDetail[];
  draft: Record<string, string>;
  error: string | null;
  isSubmitting: boolean;
  onClose: () => void;
  onSubmit: (event?: FormEvent<HTMLFormElement>) => void;
  onDraftChange: (columnName: string, value: string) => void;
}

/** Portal content for the single-row insert dialog. */
export function InsertRowDialog({
  tableName,
  columns,
  draft,
  error,
  isSubmitting,
  onClose,
  onSubmit,
  onDraftChange,
}: InsertRowDialogProps) {
  return (
    <div className="datagrid-insert-dialog-backdrop" onClick={onClose}>
      <div
        className="datagrid-insert-dialog"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="datagrid-insert-dialog-title"
      >
        <div className="datagrid-insert-dialog-header">
          <div className="datagrid-insert-dialog-copy">
            <span className="datagrid-insert-dialog-kicker">Insert row</span>
            <h3 id="datagrid-insert-dialog-title" className="datagrid-insert-dialog-title">
              {tableName ? `Add row to ${tableName.split(".").pop() || tableName}` : "Add row"}
            </h3>
            <p className="datagrid-insert-dialog-description">
              Enter the required values below. Columns with database defaults are handled automatically.
            </p>
          </div>
          <button
            type="button"
            className="datagrid-insert-dialog-close"
            onClick={onClose}
            aria-label="Close insert dialog"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form className="datagrid-insert-dialog-form" onSubmit={onSubmit}>
          <div className="datagrid-insert-dialog-fields">
            {columns.map((column, index) => {
              const normalizedType = (column.column_type || column.data_type || "").toLowerCase();
              const usesTextarea =
                normalizedType.includes("json") ||
                normalizedType.includes("text") ||
                normalizedType.includes("blob");
              const isBooleanInput = isBooleanColumn(column as ResolvedColumn);
              const placeholder = isBooleanInput
                ? "true / false"
                : normalizedType.includes("uuid")
                  ? "UUID value"
                  : normalizedType.includes("int") || normalizedType.includes("numeric")
                    ? "Numeric value"
                    : column.is_nullable
                      ? "Leave blank for NULL"
                      : "Required value";

              return (
                <label key={column.name} className="datagrid-insert-field">
                  <span className="datagrid-insert-field-head">
                    <span className="datagrid-insert-field-name">{column.name}</span>
                    {!column.is_nullable && (
                      <span className="datagrid-insert-field-required">Required</span>
                    )}
                  </span>
                  <span className="datagrid-insert-field-meta">
                    {column.column_type || column.data_type}
                  </span>
                  {isBooleanInput ? (
                    <select
                      className="datagrid-insert-field-input"
                      value={draft[column.name] ?? ""}
                      onChange={(event) =>
                        onDraftChange(column.name, event.currentTarget.value)
                      }
                      autoFocus={index === 0}
                    >
                      {column.is_nullable && <option value="">NULL</option>}
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  ) : usesTextarea ? (
                    <textarea
                      className="datagrid-insert-field-input datagrid-insert-field-input-textarea"
                      value={draft[column.name] ?? ""}
                      onChange={(event) =>
                        onDraftChange(column.name, event.currentTarget.value)
                      }
                      placeholder={placeholder}
                      autoFocus={index === 0}
                      rows={4}
                    />
                  ) : (
                    <input
                      className="datagrid-insert-field-input"
                      type="text"
                      value={draft[column.name] ?? ""}
                      onChange={(event) =>
                        onDraftChange(column.name, event.currentTarget.value)
                      }
                      placeholder={placeholder}
                      autoFocus={index === 0}
                    />
                  )}
                </label>
              );
            })}
          </div>

          {error && (
            <div className="datagrid-insert-dialog-error">{error}</div>
          )}

          <div className="datagrid-insert-dialog-actions">
            <button
              type="button"
              className="datagrid-insert-dialog-btn"
              onClick={onClose}
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="datagrid-insert-dialog-btn is-primary"
              disabled={isSubmitting}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Inserting...
                </>
              ) : (
                <>
                  <Plus className="w-4 h-4" />
                  Insert row
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
