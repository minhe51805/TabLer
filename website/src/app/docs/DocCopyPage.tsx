"use client";

import { useState } from "react";
import { Check, ClipboardCopy } from "lucide-react";

/**
 * "Copy page" button — copies the doc page's plain-text body so readers
 * can paste it into an LLM prompt or notes. Swaps to a check for ~1.6s.
 */
export function DocCopyPage({
  text,
  label,
  copiedLabel,
}: {
  text: string;
  label: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard unavailable — no-op
    }
  };

  return (
    <button
      type="button"
      className={`docs-copy-page${copied ? " is-copied" : ""}`}
      onClick={copy}
      aria-live="polite"
    >
      {copied ? (
        <Check size={14} aria-hidden="true" />
      ) : (
        <ClipboardCopy size={14} aria-hidden="true" />
      )}
      {copied ? copiedLabel : label}
    </button>
  );
}
