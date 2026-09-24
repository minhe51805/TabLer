import { useEffect, useState } from "react";
import type { ICellEditorProps } from "./types";
import { getDataGridCopy } from "../datagrid-copy";
import { getCurrentAppLanguage } from "../../../i18n";

const MAX_HEX_SIZE = 10 * 1024; // 10KB limit

export function HexCellEditor({
  seedValue,
  inputRef,
  isNullable,
  onChange,
  onCommit,
  onCancel,
}: ICellEditorProps) {
  const [localValue, setLocalValue] = useState(() => {
    if (/^null$/i.test(seedValue)) return "";
    // seedValue is hex string, format with spaces every 2 chars
    const normalized = seedValue.replace(/\s+/g, "");
    return normalized.replace(/(..)/g, "$1 ").trim();
  });
  const [isValid, setIsValid] = useState(true);
  const [errorMsg, setErrorMsg] = useState("");
  const [asciiPreview, setAsciiPreview] = useState("");
  const copy = getDataGridCopy(getCurrentAppLanguage()).editor;

  useEffect(() => {
    const textarea = (inputRef as React.MutableRefObject<HTMLTextAreaElement | null>)?.current;
    textarea?.focus();
  }, [inputRef]);

  useEffect(() => {
    const validateHex = (hex: string) => {
      // Empty input is the NULL gesture for nullable columns; the literal
      // text "null" is not hex and must fail validation below, not commit NULL.
      if (!hex.trim()) {
        setIsValid(true);
        setErrorMsg("");
        setAsciiPreview("");
        return;
      }
      const normalized = hex.replace(/\s+/g, "").toLowerCase();
      if (!/^[0-9a-f]*$/i.test(normalized)) {
        setIsValid(false);
        setErrorMsg(copy.hexInvalidChars);
        setAsciiPreview("");
        return;
      }
      if (normalized.length % 2 !== 0) {
        setIsValid(false);
        setErrorMsg(copy.hexOddDigits);
        setAsciiPreview("");
        return;
      }
      if (normalized.length > MAX_HEX_SIZE) {
        setIsValid(false);
        setErrorMsg(copy.hexTooLarge(MAX_HEX_SIZE));
        setAsciiPreview("");
        return;
      }
      setIsValid(true);
      setErrorMsg("");
      // Show ASCII preview for printable chars
      try {
        const bytes = normalized.match(/.{1,2}/g) || [];
        const ascii = bytes
          .map((b) => {
            const code = parseInt(b, 16);
            return code >= 32 && code <= 126 ? String.fromCharCode(code) : ".";
          })
          .join("");
        setAsciiPreview(ascii);
      } catch {
        setAsciiPreview("");
      }
    };
    validateHex(localValue);
  }, [localValue, copy]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setLocalValue(val);
    onChange(val);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      // Always close on Enter — let DB validate
      if (!localValue.trim() || /^null$/i.test(localValue)) {
        onCommit(null);
      } else {
        onCommit(localValue.replace(/\s+/g, ""));
      }
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
          // Always commit on blur — let DB validate hex format
          if (!localValue.trim()) {
            onCommit(isNullable ? null : "");
          } else {
            onCommit(localValue.replace(/\s+/g, ""));
          }
        }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        className={`datagrid-cell-editor datagrid-cell-hex font-mono ${!isValid ? "border-red-500" : ""}`}
        rows={4}
        cols={40}
        spellCheck={false}
        placeholder="48 65 6c 6c 6f"
      />
      {asciiPreview && (
        <span className="text-xs text-[var(--text-muted)] font-mono break-all">
          ASCII: {asciiPreview}
        </span>
      )}
      {!isValid && <span className="text-xs text-red-500">{errorMsg}</span>}
    </div>
  );
}
