import { useEffect } from "react";
import type { ICellEditorProps } from "./types";

export function NumericCellEditor({
  seedValue,
  inputRef,
  isNullable,
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
      const val = (inputRef as React.MutableRefObject<HTMLInputElement | null>).current?.value;
      if (val === null || val === undefined) return;
      const trimmed = val.trim();
      if (/^null$/i.test(trimmed)) {
        onCommit(null);
      } else if (/^[-+]?\d+(\.\d+)?$/.test(trimmed)) {
        onCommit(Number(trimmed));
      }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  // Determine step for decimal numbers
  const isDecimal = seedValue.includes(".");

  return (
    <input
      ref={(el) => {
        (inputRef as React.MutableRefObject<HTMLInputElement | null>).current = el;
      }}
      type="number"
      defaultValue={seedValue === "NULL" ? "" : seedValue}
      className="datagrid-cell-editor datagrid-cell-numeric"
      placeholder={isNullable ? "Type NULL" : ""}
      step={isDecimal ? "any" : "1"}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => {
        const val = (inputRef as React.MutableRefObject<HTMLInputElement | null>).current?.value;
        if (val === null || val === undefined) return;
        const trimmed = val.trim();
        if (/^null$/i.test(trimmed)) {
          onCommit(null);
        } else if (/^[-+]?\d+(\.\d+)?$/.test(trimmed)) {
          onCommit(Number(trimmed));
        }
      }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={handleKeyDown}
    />
  );
}
