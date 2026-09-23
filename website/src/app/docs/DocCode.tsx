"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

/**
 * Code block with a copy-to-clipboard button. The button swaps to a check
 * mark for ~1.6s after a successful copy.
 */
export function DocCode({ lang, code }: { lang?: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard unavailable (permissions, insecure context) - no-op
    }
  };

  return (
    <pre className="doc-code" data-lang={lang}>
      <button
        type="button"
        className="doc-code-copy"
        onClick={copy}
        aria-label={copied ? "Copied" : "Copy code"}
        title={copied ? "Copied" : "Copy code"}
      >
        {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      </button>
      <code>{code}</code>
    </pre>
  );
}
