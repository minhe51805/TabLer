import { useEffect, useRef, useState } from "react";
import type { ICellEditorProps } from "./types";

export function EnumCellEditor({
  seedValue,
  inputRef,
  isNullable,
  enumValues = [],
  onChange,
  onCommit,
  onCancel,
}: ICellEditorProps) {
  const selectRef = useRef<HTMLSelectElement>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    selectRef.current?.focus();
  }, []);

  const filteredValues = filter
    ? enumValues.filter((v) => v.toLowerCase().includes(filter.toLowerCase()))
    : enumValues;

  const getValue = () => selectRef.current?.value ?? "NULL";

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const val = getValue();
      if (val === "NULL") onCommit(null);
      else if (val) onCommit(val);
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  // Determine seed: try exact match first
  const defaultVal = enumValues.includes(seedValue)
    ? seedValue
    : enumValues.includes(seedValue.replace(/^['"]|['"]$/g, ""))
      ? seedValue.replace(/^['"]|['"]$/g, "")
      : "NULL";

  return (
    <div className="relative flex flex-col gap-1">
      <input
        type="text"
        placeholder="Filter..."
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        className="datagrid-enum-filter w-full text-xs px-1"
        onClick={(e) => e.stopPropagation()}
      />
      <select
        ref={(el) => {
          selectRef.current = el;
          if (inputRef) {
            (inputRef as React.MutableRefObject<HTMLSelectElement | null>).current = el;
          }
        }}
        className="datagrid-cell-editor datagrid-cell-select w-full"
        defaultValue={defaultVal}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => {
          const val = getValue();
          if (val === "NULL") onCommit(null);
          else if (val) onCommit(val);
        }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        size={Math.min(6, filteredValues.length + (isNullable ? 1 : 0))}
      >
        {isNullable && <option value="NULL">NULL</option>}
        {filteredValues.map((val) => (
          <option key={val} value={val}>{val}</option>
        ))}
      </select>
    </div>
  );
}
