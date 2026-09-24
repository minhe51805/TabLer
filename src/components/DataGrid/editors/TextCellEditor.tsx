import { useEffect } from "react";
import type { ICellEditorProps } from "./types";
import { getDataGridCopy } from "../datagrid-copy";
import { getCurrentAppLanguage } from "../../../i18n";

export function TextCellEditor({
  seedValue,
  inputRef,
  column,
  isNullable,
  onChange,
  onCommit,
  onCancel,
}: ICellEditorProps) {
  const copy = getDataGridCopy(getCurrentAppLanguage()).editor;

  useEffect(() => {
    const input = (inputRef as React.MutableRefObject<HTMLInputElement | null>)?.current;
    input?.focus();
    input?.select();
  }, [inputRef]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onCommit(e.currentTarget.value);
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="flex items-center gap-1">
      <input
        ref={(el) => {
          (inputRef as React.MutableRefObject<HTMLInputElement | null>).current = el;
        }}
        type="text"
        defaultValue={seedValue}
        className="datagrid-cell-editor"
        // Typed text is stored verbatim — the literal "NULL" stays a string.
        // Real NULL only comes from the button below (or the range-clear
        // gestures), so the placeholder must not promise otherwise.
        placeholder={column.is_nullable ? copy.textPlaceholder : ""}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() =>
          onCommit(
            (inputRef as React.MutableRefObject<HTMLInputElement | null>).current?.value ?? "",
          )
        }
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      />
      {isNullable && (
        <button
          type="button"
          className="datagrid-set-null-btn text-xs px-1 text-[var(--text-muted)]"
          title={copy.setNullTitle}
          // Keep the input's blur commit from racing the explicit null commit.
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            onCommit(null);
          }}
        >
          {copy.setNull}
        </button>
      )}
    </div>
  );
}
