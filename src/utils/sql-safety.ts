import { invokeWithTimeout } from "./tauri-utils";

export type SqlStatementKind = "read" | "write" | "schema" | "session" | "transaction" | "unknown";

export interface SqlStatementDecision {
  sql: string;
  kind: SqlStatementKind;
  readOnly: boolean;
}

export interface SqlSafetyDecision {
  statements: SqlStatementDecision[];
  readOnly: boolean;
  hasSchemaMutation: boolean;
  parseError?: string | null;
  /**
   * Set by the Safe Mode guard (not the classifier): the human explicitly
   * approved this exact run — confirmation dialog approved, or the standing
   * full-autonomy grant. Lets the backend relax its level 1-3 block.
   */
  userConfirmed?: boolean;
  /**
   * True when the SQL reaches the local filesystem, the network, or an OS
   * command through a dialect capability (e.g. `pg_read_file`, DuckDB
   * `read_csv`, MySQL `INTO OUTFILE`, Postgres `COPY ... TO PROGRAM`). The
   * sandbox boundary always rejects these regardless of read/write kind; the
   * UI can warn before sending.
   */
  filesystemAccess?: boolean;
}

export function classifySqlSafety(
  sql: string,
  databaseType?: string | null,
): Promise<SqlSafetyDecision> {
  return invokeWithTimeout<SqlSafetyDecision>(
    "classify_sql_safety",
    { sql, databaseType: databaseType ?? null },
    5_000,
    "Classifying SQL",
  );
}

// ---------------------------------------------------------------------------
// Shared statement-normalization helpers
// ---------------------------------------------------------------------------

/** Strips leading whitespace and SQL comments (`--` line, `/*` block) so
    keyword checks cannot be dodged by prefixing a statement with comments.
    Returns "" when the statement is nothing but comments. */
export function stripLeadingSqlNoise(statement: string) {
  let remaining = statement;
  while (true) {
    remaining = remaining.trimStart();
    if (remaining.startsWith("--")) {
      const nextLineIndex = remaining.indexOf("\n");
      if (nextLineIndex === -1) return "";
      remaining = remaining.slice(nextLineIndex + 1);
      continue;
    }
    if (remaining.startsWith("/*")) {
      const commentEnd = remaining.indexOf("*/");
      if (commentEnd === -1) return "";
      remaining = remaining.slice(commentEnd + 2);
      continue;
    }
    return remaining;
  }
}

/** Returns the statement wrapped by `EXPLAIN ANALYZE <stmt>` /
    `EXPLAIN (ANALYZE, ...) <stmt>`, or null when the statement is not an
    analyzing EXPLAIN. `ANALYZE OFF/FALSE/0` is a plain EXPLAIN — a read.
    Operates on already-normalized text (uppercased, whitespace-collapsed). */
export function explainAnalyzeInnerStatement(normalized: string): string | null {
  if (!normalized.startsWith("EXPLAIN")) return null;
  const rest = normalized.slice("EXPLAIN".length).trimStart();
  if (rest.startsWith("(")) {
    const closeIndex = rest.indexOf(")");
    if (closeIndex === -1) return null;
    const options = rest.slice(1, closeIndex);
    if (!/\bANALYZE\b/.test(options) || /\bANALYZE\s+(?:OFF|FALSE|0)\b/.test(options)) {
      return null;
    }
    return rest.slice(closeIndex + 1).trim() || null;
  }
  if (!/^ANALYZE\b/.test(rest) || /^ANALYZE\s+(?:OFF|FALSE|0)\b/.test(rest)) return null;
  return rest.replace(/^ANALYZE\b/, "").trim() || null;
}

/** Option words that may appear between `EXPLAIN` and the wrapped verb
    (Postgres option list, MySQL `FORMAT=`, SQL Server `PLAN FOR`, …).
    Mirrors the skip list in the backend classifier (agent_rules/parse.rs) so
    the frontend agrees on which statement an EXPLAIN actually wraps. */
const EXPLAIN_OPTION_WORDS: Record<string, true> = {
  EXPLAIN: true,
  ANALYZE: true,
  ANALYSE: true,
  VERBOSE: true,
  FORMAT: true,
  BUFFERS: true,
  WAL: true,
  TIMING: true,
  SUMMARY: true,
  MEMORY: true,
  SERIALIZE: true,
  SETTINGS: true,
  GENERIC_PLAN: true,
  TRUE: true,
  FALSE: true,
  ON: true,
  OFF: true,
  TEXT: true,
  XML: true,
  JSON: true,
  YAML: true,
  QUERY: true,
  PLAN: true,
  FOR: true,
  COSTS: true,
};

/** Returns the statement wrapped by `EXPLAIN <stmt>` — with or without
    ANALYZE — or null when the statement is not an EXPLAIN. Unlike
    `explainAnalyzeInnerStatement` this also matches the planning-only form:
    the backend classifier treats `EXPLAIN <write>` as non-read either way
    (a read-only surface must not plan mutations), so callers that mirror it
    need the inner statement for both forms.
    Operates on already-normalized text (uppercased, whitespace-collapsed). */
export function explainInnerStatement(normalized: string): string | null {
  if (!normalized.startsWith("EXPLAIN")) return null;
  let rest = normalized.slice("EXPLAIN".length).trimStart();
  // Parenthesized option list: `EXPLAIN (ANALYZE, COSTS, FORMAT JSON) <stmt>`.
  if (rest.startsWith("(")) {
    const closeIndex = rest.indexOf(")");
    if (closeIndex === -1) return null;
    rest = rest.slice(closeIndex + 1).trimStart();
    return rest || null;
  }
  // Bare-keyword options (`EXPLAIN ANALYZE`, `EXPLAIN QUERY PLAN`,
  // `EXPLAIN PLAN FOR`, `EXPLAIN FORMAT=JSON`): skip option words until the
  // wrapped verb. A non-word character (`=`, `(`, quote) ends the option run.
  while (rest) {
    const match = rest.match(/^([A-Z_]+)\b/);
    if (!match) break;
    const word = match[1];
    if (!EXPLAIN_OPTION_WORDS[word]) break;
    rest = rest.slice(word.length).trimStart();
    // `FORMAT=JSON` style: the option word is followed by `=VALUE`.
    if (rest.startsWith("=")) {
      const valueEnd = rest.search(/\s/);
      if (valueEnd === -1) return null;
      rest = rest.slice(valueEnd).trimStart();
    }
  }
  return rest || null;
}
