import { useEffect, useRef, useState } from "react";
import type { ICellEditorProps } from "./types";
import type { GridCellValue } from "../hooks/useDataGrid";

export interface LookupValue {
  value: unknown;
  label: string;
}

interface FKEditorProps extends ICellEditorProps {
  connectionId: string;
  onLoadLookupValues: (table: string, column: string) => Promise<LookupValue[]>;
}

export function FKLookupCellEditor({
  seedValue,
  inputRef,
  isNullable,
  referencedTable,
  referencedColumn,
  lookupValues = [],
  onChange,
  onCommit,
  onCancel,
  connectionId: _connectionId,
  onLoadLookupValues,
}: FKEditorProps) {
  const selectRef = useRef<HTMLSelectElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [values, setValues] = useState<LookupValue[]>(lookupValues);
  const [selectedLabel, setSelectedLabel] = useState(() => {
    const found = lookupValues.find((v) => String(v.value) === String(seedValue));
    return found ? found.label : seedValue;
  });
  const [error, setError] = useState<string | null>(null);

  // Store latest callback in ref to avoid stale closure in useEffect
  const onLoadLookupValuesRef = useRef(onLoadLookupValues);
  onLoadLookupValuesRef.current = onLoadLookupValues;

  useEffect(() => {
    if (!referencedTable || !referencedColumn) {
      setError("FK reference not available");
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);
    const currentSeed = seedValue;
    onLoadLookupValuesRef.current(referencedTable, referencedColumn)
      .then((result) => {
        setValues(result);
        const found = result.find((v) => String(v.value) === String(currentSeed));
        setSelectedLabel(found ? found.label : currentSeed);
      })
      .catch((err) => {
        setError(String(err));
      })
      .finally(() => {
        setIsLoading(false);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- seedValue included to re-resolve label when value changes
  }, [referencedTable, referencedColumn, seedValue]);

  useEffect(() => {
    selectRef.current?.focus();
  }, [isLoading]);

  const filteredValues = filter
    ? values.filter((v) => v.label.toLowerCase().includes(filter.toLowerCase()))
    : values;

  const displayValue = filter ? filter : selectedLabel;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 px-2 py-1">
        <span className="animate-spin inline-block w-3 h-3 border border-[var(--accent)] border-t-transparent rounded-full" />
        <span className="text-xs text-[var(--text-muted)]">Loading...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-2 py-1">
        <span className="text-xs text-red-500">Error: {error}</span>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex flex-col gap-1 min-w-[250px]">
      <input
        type="text"
        autoFocus
        value={displayValue}
        onChange={(e) => {
          setFilter(e.target.value);
          setSelectedLabel(e.target.value);
          const found = values.find((v) =>
            v.label.toLowerCase() === e.target.value.toLowerCase()
          );
          if (found) {
            onChange(String(found.value));
          } else {
            onChange(e.target.value);
          }
        }}
        className="datagrid-enum-filter w-full text-xs px-2"
        placeholder={`Search ${referencedTable}...`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      />
      <select
        ref={(el) => {
          selectRef.current = el;
          if (inputRef) {
            (inputRef as React.MutableRefObject<HTMLSelectElement | null>).current = el;
          }
        }}
        className="datagrid-cell-editor datagrid-cell-select w-full"
        value={
          values.find((v) => String(v.value) === String(seedValue))
            ? String(seedValue)
            : ""
        }
        onChange={(e) => {
          const val = e.target.value;
          setSelectedLabel(val);
          setFilter("");
          const found = values.find((v) => String(v.value) === val);
          if (found) {
            onChange(String(found.value));
            // Also commit immediately on selection so the value is persisted
            onCommit(found.value as GridCellValue);
          }
        }}
        onBlur={() => {
          // On blur, resolve the selected value through the lookup map
          // so we commit the actual stored value, not the display label
          const selected = selectRef.current?.value;
          if (selected === "NULL") {
            onCommit(null);
          } else if (selected) {
            const resolved = values.find((v) => String(v.value) === selected);
            if (resolved) {
              onCommit(resolved.value as GridCellValue);
            } else {
              onCancel();
            }
          } else {
            onCancel();
          }
        }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        size={Math.min(8, filteredValues.length + (isNullable ? 1 : 0))}
      >
        {isNullable && <option value="NULL">NULL</option>}
        {filteredValues.map((item) => (
          <option key={String(item.value)} value={String(item.value)}>
            {item.label}
          </option>
        ))}
        {filteredValues.length === 0 && !isNullable && (
          <option value="" disabled>No matches</option>
        )}
      </select>
      <span className="text-xs text-[var(--text-muted)]">
        {values.length} values
      </span>
    </div>
  );
}
