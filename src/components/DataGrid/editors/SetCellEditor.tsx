/**
 * SET Cell Editor — MySQL SET type multi-select editor.
 * SET columns store multiple values as comma-separated strings.
 * Unlike ENUM (single choice), SET allows selecting multiple values.
 */
import { useState } from "react";
import type { ICellEditorProps } from "./types";

export function SetCellEditor({
  value,
  onChange,
  onCommit,
  onCancel,
  setValues = [],
  isNullable,
}: Omit<ICellEditorProps, "enumValues"> & { setValues?: string[] }) {
  // Parse stored value into set of selected values
  const [selected, setSelected] = useState<Set<string>>(() => {
    if (value === null || value === undefined || value === "") {
      return new Set<string>();
    }
    const str = String(value);
    return new Set(str.split(",").map((v) => v.trim()).filter(Boolean));
  });

  const handleToggle = (val: string) => {
    const next = new Set(selected);
    if (next.has(val)) {
      next.delete(val);
    } else {
      next.add(val);
    }
    setSelected(next);
    // Also update the onChange so blur commits correctly
    const joined = Array.from(next).join(",");
    onChange(joined);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      const joined = Array.from(selected).join(",");
      onCommit(joined || null);
    }
  };

  return (
    <div
      className="datagrid-set-editor"
      onKeyDown={handleKeyDown}
      role="listbox"
      aria-multiselectable="true"
    >
      {isNullable && (
        <button
          type="button"
          className={`datagrid-set-option ${selected.size === 0 ? "selected" : ""}`}
          onClick={() => {
            setSelected(new Set());
            onChange("");
          }}
        >
          <span className="datagrid-set-checkbox" />
          <span className="datagrid-set-label">NULL</span>
        </button>
      )}
      {setValues.map((val) => (
        <button
          key={val}
          type="button"
          role="option"
          aria-selected={selected.has(val)}
          className={`datagrid-set-option ${selected.has(val) ? "selected" : ""}`}
          onClick={() => handleToggle(val)}
        >
          <span className={`datagrid-set-checkbox ${selected.has(val) ? "checked" : ""}`}>
            {selected.has(val) && (
              <svg viewBox="0 0 10 8" fill="none" className="datagrid-set-check-icon">
                <path
                  d="M1 4L3.5 6.5L9 1"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </span>
          <span className="datagrid-set-label">{val}</span>
        </button>
      ))}
      <div className="datagrid-set-footer">
        <span className="datagrid-set-selected-count">
          {selected.size > 0 ? `${selected.size} selected` : "None selected"}
        </span>
        <span className="datagrid-set-hint">Ctrl+Enter to commit</span>
      </div>
    </div>
  );
}

/** Parse SET values from MySQL column type string.
 * Example: "set('val1','val2','val3')" -> ["val1", "val2", "val3"]
 */
export function parseSetValues(columnType: string): string[] {
  const match = columnType.match(/^set\((.+)\)$/i);
  if (!match) return [];
  // Parse quoted values: 'val1','val2',...
  const inner = match[1];
  const values: string[] = [];
  const regex = /'([^'\\]*(?:\\.[^'\\]*)*)'/g;
  let m;
  while ((m = regex.exec(inner)) !== null) {
    values.push(m[1].replace(/\\'/g, "'"));
  }
  return values;
}
