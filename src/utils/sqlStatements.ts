function matchDollarQuoteTag(sql: string, start: number) {
  if (sql[start] !== "$") return null;

  const taggedMatch = sql.slice(start).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$/);
  if (taggedMatch) return taggedMatch[0];

  return sql.startsWith("$$", start) ? "$$" : null;
}

export function splitSqlStatements(sql: string) {
  const text = sql.trim();
  if (!text) return [];
  if (!text.includes(";")) return [text];

  const statements: string[] = [];
  let currentStart = 0;
  let inString = false;
  let stringChar = "";
  let inLineComment = false;
  let inBlockComment = false;
  let dollarQuoteTag: string | null = null;

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
      }
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
      const statement = sql.slice(currentStart, i).trim();
      if (statement) {
        statements.push(statement);
      }
      currentStart = i + 1;
    }
  }

  const lastStatement = sql.slice(currentStart).trim();
  if (lastStatement) {
    statements.push(lastStatement);
  }

  return statements;
}

/// SQLite pragma functions that only read — `PRAGMA name(arg)` for these is a
/// read, any other call form is treated as a write. Mirrors the backend
/// allowlist in `utils::sql::ast_statement_kind`.
const READONLY_PRAGMA_NAMES: Record<string, true> = {
  TABLE_INFO: true,
  TABLE_XINFO: true,
  INDEX_INFO: true,
  INDEX_LIST: true,
  INDEX_XINFO: true,
  FOREIGN_KEY_LIST: true,
  DATABASE_LIST: true,
  COMPILE_OPTIONS: true,
  INTEGRITY_CHECK: true,
  QUICK_CHECK: true,
  FOREIGN_KEY_CHECK: true,
  COLLATION_LIST: true,
  FUNCTION_LIST: true,
  MODULE_LIST: true,
  PRAGMA_LIST: true,
  TABLE_LIST: true,
};

/// True when a statement whose leading keyword looks read-only (SELECT /
/// EXPLAIN / WITH / PRAGMA) actually mutates: `SELECT ... INTO`, a
/// data-modifying CTE body, `EXPLAIN ANALYZE <write>`, or `PRAGMA name = v`.
/// Operates on already-normalized text (uppercased, whitespace-collapsed).
export function normalizedStatementIsDisguisedWrite(normalized: string): boolean {
  if (!normalized) return false;
  if (normalized.startsWith("WITH")) {
    return /\b(INSERT|UPDATE|DELETE|MERGE)\b/.test(normalized);
  }
  if (normalized.startsWith("SELECT")) {
    return /\bINTO\b/.test(normalized);
  }
  if (normalized.startsWith("PRAGMA")) {
    // `PRAGMA name = v` assigns; `name(v)` is a write unless it is one of the
    // known read-only pragma functions (mirrors the backend allowlist).
    if (/=/.test(normalized)) return true;
    const callMatch = normalized.match(/^PRAGMA\s+(?:\w+\.)?(\w+)\s*\(/);
    if (!callMatch) return false;
    return !READONLY_PRAGMA_NAMES[callMatch[1]];
  }
  return false;
}
