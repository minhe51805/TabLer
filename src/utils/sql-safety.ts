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
