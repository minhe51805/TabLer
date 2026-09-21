/**
 * Pure helpers for the Ctrl+K inline AI edit flow in the SQL editor:
 * locating the statement under the cursor, building the rewrite prompt,
 * extracting SQL from the model's reply, and computing the line diff that
 * drives the preview decorations.
 */

export interface StatementRange {
  /** Character offset of the first non-whitespace character of the statement. */
  start: number;
  /** Character offset just past the last non-whitespace character. */
  end: number;
}

/** Mirrors the dollar-quoted string detection in utils/sqlStatements. */
function matchDollarQuoteTag(sql: string, start: number): string | null {
  if (sql[start] !== "$") return null;
  const taggedMatch = sql.slice(start).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$/);
  if (taggedMatch) return taggedMatch[0];
  return sql.startsWith("$$", start) ? "$$" : null;
}

/**
 * Finds the statement containing `offset` in `sql`, splitting on top-level
 * semicolons with the same string/comment/dollar-quote awareness as
 * `splitSqlStatements`. When the offset sits in whitespace between two
 * statements the NEXT statement wins (Ctrl+K at a blank line edits forward);
 * an offset past the last statement returns that last statement.
 * Returns null when the document holds no statement at all.
 */
export function findStatementRangeAt(sql: string, offset: number): StatementRange | null {
  const ranges: StatementRange[] = [];
  let currentStart = 0;
  let inString = false;
  let stringChar = "";
  let inLineComment = false;
  let inBlockComment = false;
  let dollarQuoteTag: string | null = null;

  const pushRange = (from: number, to: number) => {
    let start = from;
    let end = to;
    while (start < end && /\s/.test(sql[start])) start += 1;
    while (end > start && /\s/.test(sql[end - 1])) end -= 1;
    if (end > start) ranges.push({ start, end });
  };

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (dollarQuoteTag) {
      if (sql.startsWith(dollarQuoteTag, i)) {
        i += dollarQuoteTag.length - 1;
        dollarQuoteTag = null;
      }
      continue;
    }
    if (!inString && ch === "-" && next === "-") {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (!inString && ch === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (!inString && ch === "$") {
      const tag = matchDollarQuoteTag(sql, i);
      if (tag) {
        dollarQuoteTag = tag;
        i += tag.length - 1;
        continue;
      }
    }
    if (inString && ch === "\\" && i + 1 < sql.length) {
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      if (!inString) {
        inString = true;
        stringChar = ch;
        continue;
      }
      if (ch === stringChar) {
        if (sql[i + 1] === stringChar) {
          i += 1;
        } else {
          inString = false;
          stringChar = "";
        }
      }
      continue;
    }
    if (ch === ";" && !inString) {
      pushRange(currentStart, i);
      currentStart = i + 1;
    }
  }
  pushRange(currentStart, sql.length);

  if (ranges.length === 0) return null;
  return ranges.find((range) => offset <= range.end) ?? ranges[ranges.length - 1];
}

/** Rewrite prompt for the inline edit — terse, single-statement contract. */
export function buildInlineEditPrompt(params: {
  instruction: string;
  sql: string;
  dialect?: string;
  databaseLabel?: string | null;
}): string {
  const { instruction, sql, dialect, databaseLabel } = params;
  return [
    sql.trim()
      ? "Rewrite the SQL statement below according to the instruction."
      : "Write a SQL statement according to the instruction.",
    "Return ONLY the rewritten SQL — no markdown fences, no explanations, no surrounding prose.",
    "Preserve the statement's semantics except where the instruction asks for a change.",
    dialect ? `SQL dialect: ${dialect}.` : null,
    databaseLabel ? `Database: ${databaseLabel}.` : null,
    `Instruction: ${instruction}`,
    "",
    sql.trim() ? sql.trim() : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Pulls the SQL out of the model's reply. The prompt asks for raw SQL, but
 * models still wrap answers in fences — take the first fenced block when one
 * exists, otherwise strip a stray leading `sql` language tag and trim.
 */
export function extractSqlFromAiResponse(response: string): string {
  const fenced = response.match(/```(?:sql)?\s*\n([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  return response
    .trim()
    .replace(/^sql\s*\n/i, "")
    .trim();
}

export type LineDiffOp =
  | { type: "equal"; line: string }
  | { type: "insert"; line: string }
  | { type: "delete"; line: string };

/**
 * Line-level diff between the replaced text and the AI rewrite. Common
 * prefix/suffix collapse to `equal` so the preview only decorates the changed
 * middle; the middle itself is a small LCS so interleaved edits still render
 * as added/removed lines instead of one big changed block.
 */
export function diffLines(oldText: string, newText: string): LineDiffOp[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const oldMid = oldLines.slice(prefix, oldLines.length - suffix);
  const newMid = newLines.slice(prefix, newLines.length - suffix);

  const ops: LineDiffOp[] = oldLines.slice(0, prefix).map((line) => ({ type: "equal", line }));

  // LCS over the changed middle. Editor statements are small; cap the DP so a
  // pathological paste cannot allocate a huge matrix — past the cap the whole
  // middle degrades to delete-all + insert-all, which still previews correctly.
  const MAX_LCS_CELLS = 250_000;
  if (oldMid.length * newMid.length <= MAX_LCS_CELLS && oldMid.length > 0 && newMid.length > 0) {
    const rows = oldMid.length + 1;
    const cols = newMid.length + 1;
    const table = new Uint32Array(rows * cols);
    for (let i = oldMid.length - 1; i >= 0; i -= 1) {
      for (let j = newMid.length - 1; j >= 0; j -= 1) {
        table[i * cols + j] =
          oldMid[i] === newMid[j]
            ? table[(i + 1) * cols + j + 1] + 1
            : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < oldMid.length && j < newMid.length) {
      if (oldMid[i] === newMid[j]) {
        ops.push({ type: "equal", line: oldMid[i] });
        i += 1;
        j += 1;
      } else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) {
        ops.push({ type: "delete", line: oldMid[i] });
        i += 1;
      } else {
        ops.push({ type: "insert", line: newMid[j] });
        j += 1;
      }
    }
    while (i < oldMid.length) {
      ops.push({ type: "delete", line: oldMid[i] });
      i += 1;
    }
    while (j < newMid.length) {
      ops.push({ type: "insert", line: newMid[j] });
      j += 1;
    }
  } else {
    for (const line of oldMid) ops.push({ type: "delete", line });
    for (const line of newMid) ops.push({ type: "insert", line });
  }

  for (let k = oldLines.length - suffix; k < oldLines.length; k += 1) {
    ops.push({ type: "equal", line: oldLines[k] });
  }
  return ops;
}
