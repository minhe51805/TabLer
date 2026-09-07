import { useEffect } from "react";
import type { ICellEditorProps } from "./types";

export function TextCellEditor({
  seedValue,
  inputRef,
  column,
  onChange,
  onCommit,
  onCancel,
}: ICellEditorProps) {
  useEffect(() => {
    const input = (inputRef as React.MutableRefObject<HTMLInputElement | null>)?.current;
    input?.focus();
    input?.select();
  }, []);

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
    <input
      ref={(el) => {
        (inputRef as React.MutableRefObject<HTMLInputElement | null>).current = el;
      }}
      type="text"
      defaultValue={seedValue}
      className="datagrid-cell-editor"
      placeholder={column.is_nullable ? "Type NULL to clear" : ""}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => onCommit((inputRef as React.MutableRefObject<HTMLInputElement | null>).current?.value ?? "")}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={handleKeyDown}
    />
  );
}
