import { useEffect, useState } from "react";
import type { ICellEditorProps } from "./types";
import { parseWKB, parseWKT } from "../../../utils/geometry-renderer";

export function GeometryCellEditor({
  seedValue,
  inputRef,
  onChange,
  onCommit,
  onCancel,
}: ICellEditorProps) {
  const [localValue, setLocalValue] = useState(() => {
    if (/^null$/i.test(seedValue) || !seedValue) return "";
    // seedValue may be WKB hex or WKT string
    // Try to parse and show the WKT
    const wkt = parseWKB(seedValue) || parseWKT(seedValue) || seedValue;
    return wkt;
  });

  useEffect(() => {
    const input = (inputRef as React.MutableRefObject<HTMLTextAreaElement | null>)?.current;
    input?.focus();
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setLocalValue(e.target.value);
    onChange(e.target.value);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onCommit(localValue || null);
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="flex flex-col gap-1 min-w-[280px]">
      <textarea
        ref={(el) => {
          (inputRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = el;
        }}
        value={localValue}
        onChange={handleChange}
        onBlur={() => onCommit(localValue || null)}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        className="datagrid-cell-editor font-mono"
        rows={4}
        cols={50}
        placeholder="POINT(1 2) or WKB hex string"
        spellCheck={false}
      />
      <span className="text-xs text-[var(--text-muted)]">
        Enter WKT (POINT, LINESTRING, POLYGON...) or WKB hex string
      </span>
    </div>
  );
}
