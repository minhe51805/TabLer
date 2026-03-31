import { useEffect } from "react";
import type { ICellEditorProps } from "./types";

interface Props extends ICellEditorProps {
  editorType: "date" | "datetime" | "time";
}

export function DateTimeCellEditor({
  seedValue,
  inputRef,
  isNullable,
  onChange,
  onCommit,
  onCancel,
  editorType,
}: Props) {
  useEffect(() => {
    const input = (inputRef as React.MutableRefObject<HTMLInputElement | null>)?.current;
    input?.focus();
    input?.select();
  }, []);

  const parseSeedValue = (seed: string): string => {
    if (/^null$/i.test(seed)) return "";
    // Seed is in DB format like "2024-01-15 14:30:00"
    // Convert to input format
    if (editorType === "datetime") {
      // "2024-01-15 14:30:00" -> "2024-01-15T14:30"
      return seed.replace(" ", "T").slice(0, 16);
    }
    if (editorType === "time") {
      // "14:30:00" -> "14:30"
      return seed.slice(0, 5);
    }
    // date: "2024-01-15" -> "2024-01-15"
    return seed.slice(0, 10);
  };

  const formatOutput = (inputValue: string): string => {
    if (!inputValue) return "";
    if (editorType === "datetime") {
      // "2024-01-15T14:30" -> "2024-01-15 14:30:00"
      return inputValue.replace("T", " ") + ":00";
    }
    if (editorType === "time") {
      // "14:30" -> "14:30:00"
      return inputValue + ":00";
    }
    return inputValue;
  };

  const getInputType = (): string => {
    switch (editorType) {
      case "datetime": return "datetime-local";
      case "time": return "time";
      default: return "date";
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const val = (inputRef as React.MutableRefObject<HTMLInputElement | null>).current?.value;
      if (!val) {
        if (isNullable) onCommit(null);
        return;
      }
      onCommit(formatOutput(val));
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  const handleBlur = () => {
    const val = (inputRef as React.MutableRefObject<HTMLInputElement | null>).current?.value;
    if (!val) {
      if (isNullable) onCommit(null);
      return;
    }
    onCommit(formatOutput(val));
  };

  return (
    <input
      ref={(el) => {
        (inputRef as React.MutableRefObject<HTMLInputElement | null>).current = el;
      }}
      type={getInputType()}
      defaultValue={parseSeedValue(seedValue)}
      className="datagrid-cell-editor datagrid-cell-datetime"
      onChange={(e) => onChange(e.target.value)}
      onBlur={handleBlur}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={handleKeyDown}
    />
  );
}
