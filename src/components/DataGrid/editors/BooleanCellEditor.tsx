import { useEffect, useRef } from "react";
import type { ICellEditorProps } from "./types";

export function BooleanCellEditor({
  seedValue,
  inputRef,
  isNullable,
  onChange,
  onCommit,
  onCancel,
}: ICellEditorProps) {
  const selectRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    if (selectRef.current) {
      selectRef.current.focus();
      // select() is available on HTMLInputElement but not HTMLSelectElement
      // Use type assertion for compatibility
      void (selectRef.current as unknown as HTMLInputElement).select?.();
    }
  }, []);

  const getValue = () => selectRef.current?.value ?? "NULL";

  const handleKeyDown = (e: React.KeyboardEvent<HTMLSelectElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const val = getValue();
      if (val === "true") onCommit(true);
      else if (val === "false") onCommit(false);
      else if (isNullable) onCommit(null);
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <select
      ref={(el) => {
        selectRef.current = el;
        if (inputRef) {
          (inputRef as React.MutableRefObject<HTMLSelectElement | null>).current = el;
        }
      }}
      className="datagrid-cell-editor datagrid-cell-select"
      defaultValue={seedValue}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => {
        const val = getValue();
        if (val === "true") onCommit(true);
        else if (val === "false") onCommit(false);
        else if (isNullable) onCommit(null);
      }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={handleKeyDown}
    >
      <option value="true">true</option>
      <option value="false">false</option>
      {isNullable && <option value="NULL">NULL</option>}
    </select>
  );
}
