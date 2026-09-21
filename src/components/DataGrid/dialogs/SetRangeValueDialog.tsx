import { Check, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { getCurrentAppLanguage } from "../../../i18n";
import { getDataGridPowerCopy } from "../datagrid-power-copy";

interface SetRangeValueDialogProps {
  /** Number of cells covered by the current selection (display only). */
  cellCount: number;
  error: string | null;
  onClose: () => void;
  /** Stages the value; returns an error message to display or null on success. */
  onSubmit: (raw: string | null) => string | null;
  onError: (message: string | null) => void;
}

/**
 * "Set selected cells to…" dialog: one value (or NULL) staged across the
 * current multi-cell selection via the change-tracking queue.
 */
export function SetRangeValueDialog({
  cellCount,
  error,
  onClose,
  onSubmit,
  onError,
}: SetRangeValueDialogProps) {
  const copy = getDataGridPowerCopy(getCurrentAppLanguage());
  const [value, setValue] = useState("");
  const [setToNull, setSetToNull] = useState(false);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const failure = onSubmit(setToNull ? null : value);
    if (failure === null) {
      onClose();
    } else {
      onError(failure);
    }
  };

  return (
    <div className="datagrid-insert-dialog-backdrop" onClick={onClose}>
      <div
        className="datagrid-insert-dialog"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="datagrid-set-range-dialog-title"
      >
        <div className="datagrid-insert-dialog-header">
          <div className="datagrid-insert-dialog-copy">
            <h3 id="datagrid-set-range-dialog-title" className="datagrid-insert-dialog-title">
              {copy.setCells.title}
            </h3>
            <p className="datagrid-insert-dialog-description">
              {copy.setCells.description(cellCount)}
            </p>
          </div>
          <button
            type="button"
            className="datagrid-insert-dialog-close"
            onClick={onClose}
            aria-label={copy.setCells.cancel}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form className="datagrid-insert-dialog-form" onSubmit={handleSubmit}>
          <div className="datagrid-insert-dialog-fields">
            <label className="datagrid-insert-field">
              <span className="datagrid-insert-field-head">
                <span className="datagrid-insert-field-name">{copy.setCells.valueLabel}</span>
              </span>
              <input
                className="datagrid-insert-field-input"
                type="text"
                value={value}
                onChange={(event) => setValue(event.currentTarget.value)}
                disabled={setToNull}
                autoFocus
              />
            </label>
            <label className="datagrid-insert-field" style={{ flexDirection: "row", gap: 8 }}>
              <input
                type="checkbox"
                checked={setToNull}
                onChange={(event) => setSetToNull(event.currentTarget.checked)}
              />
              <span className="datagrid-insert-field-name">{copy.setCells.nullLabel}</span>
            </label>
          </div>

          {error && <div className="datagrid-insert-dialog-error">{error}</div>}

          <div className="datagrid-insert-dialog-actions">
            <button type="button" className="datagrid-insert-dialog-btn" onClick={onClose}>
              {copy.setCells.cancel}
            </button>
            <button type="submit" className="datagrid-insert-dialog-btn is-primary">
              <Check className="w-4 h-4" />
              {copy.setCells.apply}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
