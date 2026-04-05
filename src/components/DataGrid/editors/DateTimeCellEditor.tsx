import { useEffect } from "react";
import type { ICellEditorProps } from "./types";
import { formatDate, parseDate } from "../../../stores/dateFormatStore";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

interface Props extends ICellEditorProps {
  editorType: "date" | "datetime" | "time";
  /** Custom display format (e.g. "yyyy-MM-dd HH:mm:ss") */
  dateFormat?: string;
}

export function DateTimeCellEditor({
  seedValue,
  inputRef,
  isNullable,
  onChange,
  onCommit,
  onCancel,
  editorType,
  dateFormat,
}: Props) {
  useEffect(() => {
    const input = (inputRef as React.MutableRefObject<HTMLInputElement | null>)?.current;
    input?.focus();
    input?.select();
  }, []);

  const parseSeedValue = (seed: string): string => {
    if (/^null$/i.test(seed)) return "";
    // Seed is in DB/custom format. Try custom format first if provided,
    // otherwise fall back to common DB format detection.
    if (dateFormat && seed.trim()) {
      // Try to parse using the custom format's date value and format back to input format
      const parsed = parseDate(seed);
      if (parsed) {
        // Build expected display date for the editor
        if (editorType === "datetime") {
          return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
        }
        if (editorType === "time") {
          return `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
        }
        return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
      }
    }
    // Fallback: common DB formats
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
    // Convert input value to a Date, then format with custom format if provided
    const parsed = parseDate(
      editorType === "datetime"
        ? inputValue.replace("T", " ")
        : editorType === "time"
        ? `1970-01-01 ${inputValue}`
        : inputValue
    );
    if (parsed && dateFormat) {
      return formatDate(parsed, dateFormat);
    }
    // Fallback output format
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
