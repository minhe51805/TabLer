import { useEffect, useState } from "react";
import type { ICellEditorProps } from "./types";
import { getDataGridCopy } from "../datagrid-copy";
import { getCurrentAppLanguage } from "../../../i18n";

export function JSONCellEditor({
  seedValue,
  inputRef,
  isNullable,
  onChange,
  onCommit,
  onCancel,
}: ICellEditorProps) {
  const [localValue, setLocalValue] = useState(() => {
    if (/^null$/i.test(seedValue)) return "";
    // Try to pretty-print the JSON
    try {
      const parsed = JSON.parse(seedValue);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return seedValue;
    }
  });
  const [isValid, setIsValid] = useState(true);
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    const textarea = (inputRef as React.MutableRefObject<HTMLTextAreaElement | null>)?.current;
    textarea?.focus();
  }, [inputRef]);

  const copy = getDataGridCopy(getCurrentAppLanguage()).editor;

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setLocalValue(val);
    // Empty input is the NULL gesture for nullable columns; the literal text
    // "null" is valid JSON and must be stored as JSON null, not SQL NULL.
    if (!val.trim()) {
      setIsValid(true);
      setErrorMsg("");
      onChange("");
      return;
    }
    try {
      JSON.parse(val);
      setIsValid(true);
      setErrorMsg("");
      onChange(val);
    } catch (err) {
      setIsValid(false);
      setErrorMsg(err instanceof Error ? err.message : copy.jsonInvalid);
      onChange(val); // Still allow typing but show error
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const textarea = e.currentTarget;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const newValue = localValue.substring(0, start) + "  " + localValue.substring(end);
      setLocalValue(newValue);
      onChange(newValue);
      // Restore cursor position after state update
      requestAnimationFrame(() => {
        textarea.selectionStart = textarea.selectionEnd = start + 2;
      });
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onCommit(isNullable && !localValue.trim() ? null : localValue);
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="flex flex-col gap-0.5 min-w-[300px]">
      <textarea
        ref={(el) => {
          (inputRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = el;
        }}
        value={localValue}
        onChange={handleChange}
        onBlur={() => {
          onCommit(isNullable && !localValue.trim() ? null : localValue);
        }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        className={`datagrid-cell-editor datagrid-cell-json ${!isValid ? "border-red-500" : ""}`}
        rows={6}
        cols={40}
        spellCheck={false}
      />
      {!isValid && (
        <span className="text-xs text-red-500 truncate" title={errorMsg}>
          {errorMsg || copy.jsonInvalid}
        </span>
      )}
      {isValid && <span className="text-xs text-[var(--text-muted)]">{copy.jsonCommitHint}</span>}
    </div>
  );
}
