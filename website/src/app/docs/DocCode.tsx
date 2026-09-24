"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";

const SQL_KEYWORDS =
  /\b(SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|ON|GROUP|BY|ORDER|LIMIT|OFFSET|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|INDEX|DROP|ALTER|ADD|COLUMN|PRIMARY|KEY|FOREIGN|REFERENCES|NOT|NULL|DEFAULT|UNIQUE|CHECK|AND|OR|AS|DISTINCT|COUNT|SUM|AVG|MIN|MAX|CASE|WHEN|THEN|ELSE|END|IN|EXISTS|BETWEEN|LIKE|IS|HAVING|UNION|ALL|WITH|RETURNING|BEGIN|COMMIT|ROLLBACK)\b/gi;

const SHELL_KEYWORDS =
  /\b(cd|ls|mkdir|rm|cp|mv|cat|echo|export|sudo|chmod|chown|curl|wget|git|npm|npx|cargo|brew|apt|dnf|xattr|open|tar|unzip|grep|find|which)\b/g;

/**
 * Dependency-free syntax highlighting for the doc code blocks. Covers the
 * two languages the docs actually use — SQL and shell — with comments,
 * strings, numbers, and keywords. Everything else renders as plain text.
 */
function highlight(code: string, lang?: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const isSql = lang === "sql";
  const isShell = lang === "sh" || lang === "bash" || lang === "shell" || lang === "zsh";
  if (!isSql && !isShell) return [code];

  // one pass: comments → strings → numbers → keywords, left to right
  const pattern = isSql
    ? /(--[^\n]*)|('(?:[^'\\]|\\.)*')|(\b\d+(?:\.\d+)?\b)/g
    : /(#[^\n]*)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|(\b\d+(?:\.\d+)?\b)/g;

  let last = 0;
  let key = 0;
  const pushPlain = (text: string) => {
    if (!text) return;
    // keyword-highlight plain segments
    const kw = isSql ? SQL_KEYWORDS : SHELL_KEYWORDS;
    kw.lastIndex = 0;
    let kwLast = 0;
    let m: RegExpExecArray | null;
    while ((m = kw.exec(text))) {
      if (m.index > kwLast) nodes.push(text.slice(kwLast, m.index));
      nodes.push(
        <span key={key++} className="tok-kw">
          {m[0]}
        </span>,
      );
      kwLast = m.index + m[0].length;
    }
    if (kwLast < text.length) nodes.push(text.slice(kwLast));
  };

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code))) {
    if (match.index > last) pushPlain(code.slice(last, match.index));
    const cls = match[1] ? "tok-comment" : match[2] ? "tok-string" : "tok-number";
    nodes.push(
      <span key={key++} className={cls}>
        {match[0]}
      </span>,
    );
    last = match.index + match[0].length;
  }
  if (last < code.length) pushPlain(code.slice(last));
  return nodes;
}

/**
 * Code block with a copy-to-clipboard button. The button swaps to a check
 * mark for ~1.6s after a successful copy.
 */
export function DocCode({ lang, code }: { lang?: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const highlighted = useMemo(() => highlight(code, lang), [code, lang]);

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
      <code>{highlighted}</code>
    </pre>
  );
}
