import type { ConnectionConfig } from "../../types";
import { normalizedStatementIsDisguisedWrite } from "../../utils/sqlStatements";
import { explainAnalyzeInnerStatement, stripLeadingSqlNoise } from "../../utils/sql-safety";

const INLINE_COMPLETION_CACHE_MS = 120_000;
const INLINE_COMPLETION_MIN_INTERVAL_MS = 2_000;
const INLINE_COMPLETION_TABLE_LIMIT = 40;
const MAX_DAILY_INLINE_COMPLETIONS = 100;

const PROTECTED_RUN_MUTATING_PREFIXES = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "REPLACE",
  "MERGE",
  "CREATE",
  "ALTER",
  "DROP",
  "TRUNCATE",
  "GRANT",
  "REVOKE",
  "COMMENT",
  "RENAME",
  "COPY",
  "VACUUM",
  "CALL",
  "DO ",
  "LOCK",
  "UNLOCK",
  "LOAD",
  "EXECUTE",
  "EXEC",
  "ANALYZE",
  "REINDEX",
  "REFRESH",
  "NOTIFY",
  "DISCARD",
  "FLUSH",
  "KILL",
  "INSTALL",
  "IMPORT",
  "EXPORT",
  "BACKUP",
  "RESTORE",
  "CHECKPOINT",
] as const;

const PROTECTED_RUN_SESSION_PREFIXES = [
  "USE",
  "SET SEARCH_PATH",
  "ATTACH",
  "DETACH",
  "SET ROLE",
  "SET SESSION",
  "SET NAMES",
  "SET CHARACTER SET",
] as const;

export function formatExecutionError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error:\s*/, "");
}

export function normalizeStatementForGuard(statement: string) {
  return stripLeadingSqlNoise(statement).replace(/\s+/g, " ").trim().toUpperCase();
}

export function stripIdentifierWrapper(identifier: string) {
  const trimmed = identifier.trim();
  if (
    (trimmed.startsWith("`") && trimmed.endsWith("`")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function extractLeadingUseDirective(
  sql: string,
): { database: string; remainingSql: string } | { error: string } | null {
  const trimmed = stripLeadingSqlNoise(sql).trimStart();
  if (!/^USE\s+/i.test(trimmed)) return null;

  const newlineIndex = trimmed.indexOf("\n");
  const semicolonIndex = trimmed.indexOf(";");
  const endsAtSemicolon =
    semicolonIndex !== -1 && (newlineIndex === -1 || semicolonIndex < newlineIndex);

  const directive = endsAtSemicolon
    ? trimmed.slice(0, semicolonIndex + 1)
    : newlineIndex === -1
      ? trimmed
      : trimmed.slice(0, newlineIndex);
  const remainingSql = endsAtSemicolon
    ? trimmed.slice(semicolonIndex + 1)
    : newlineIndex === -1
      ? ""
      : trimmed.slice(newlineIndex + 1);

  const rawTarget = directive
    .replace(/^USE\s+/i, "")
    .replace(/;$/, "")
    .trim();
  if (!rawTarget) {
    return {
      error:
        "Sandbox gateway found an empty USE statement. Choose the active database from the UI or provide a database name.",
    };
  }

  const normalizedTarget = stripIdentifierWrapper(rawTarget);
  if (/\s/.test(normalizedTarget)) {
    return {
      error:
        "Sandbox gateway could not understand the USE directive. Use `USE <database>` on its own line before the rest of the SQL.",
    };
  }
  if (normalizedTarget.includes(".")) {
    return {
      error:
        "Sandbox gateway only accepts USE <database>. Choose the database from the UI, or run the write against a fully qualified table like `INSERT INTO db.table ...`.",
    };
  }

  return { database: normalizedTarget, remainingSql };
}

export function isSessionSwitchStatement(statement: string) {
  const normalized = normalizeStatementForGuard(statement);
  return PROTECTED_RUN_SESSION_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/** True when `EXPLAIN ANALYZE` wraps a statement that is not a pure read —
    the analyze form EXECUTES the wrapped statement, so
    `EXPLAIN ANALYZE DELETE ...` mutates. `EXPLAIN ANALYZE SELECT` stays a read. */
export function isExplainAnalyzeMutating(statement: string) {
  const inner = explainAnalyzeInnerStatement(normalizeStatementForGuard(statement));
  if (!inner) return false;
  if (inner.startsWith("EXPLAIN")) return isExplainAnalyzeMutating(inner);
  const readPrefixes = ["SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "PRAGMA", "VALUES", "TABLE"];
  if (readPrefixes.some((prefix) => inner.startsWith(prefix))) {
    return normalizedStatementIsDisguisedWrite(inner);
  }
  return true;
}

export function isMutatingStatement(statement: string) {
  const normalized = normalizeStatementForGuard(statement);
  if (!normalized) return false;
  if (normalizedStatementIsDisguisedWrite(normalized)) return true;
  if (isExplainAnalyzeMutating(statement)) return true;
  return PROTECTED_RUN_MUTATING_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function isHighRiskStatement(statement: string) {
  const normalized = normalizeStatementForGuard(statement);
  if (!normalized) return false;

  // `EXPLAIN ANALYZE <stmt>` executes the wrapped statement — it inherits the
  // risk of whatever it analyzes.
  const explainInner = explainAnalyzeInnerStatement(normalized);
  if (explainInner) {
    return isHighRiskStatement(explainInner);
  }

  if (
    normalized.startsWith("DROP ") ||
    normalized.startsWith("TRUNCATE ") ||
    normalized.startsWith("GRANT ") ||
    normalized.startsWith("REVOKE ") ||
    normalized.startsWith("ALTER USER ") ||
    normalized.startsWith("CREATE USER ") ||
    normalized.startsWith("DROP USER ")
  ) {
    return true;
  }
  if (normalized.startsWith("DELETE ") && !normalized.includes(" WHERE ")) return true;
  if (normalized.startsWith("UPDATE ") && !normalized.includes(" WHERE ")) return true;
  return false;
}

export function isTrustedInlineCompletionConnection(connection?: ConnectionConfig) {
  if (!connection) return false;
  if (connection.db_type === "sqlite") return true;
  const normalizedHost = (connection.host || "").trim().toLowerCase();
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(normalizedHost);
}

export function normalizeInlineSuggestion(rawSuggestion: string, textUntilPosition: string) {
  let suggestion = rawSuggestion
    .replace(/^```[a-z]*\s*\n?/i, "")
    .replace(/\n?```$/i, "")
    .trim();
  if (suggestion.toLowerCase().startsWith(textUntilPosition.trim().toLowerCase())) {
    suggestion = suggestion.slice(textUntilPosition.trim().length).trim();
  }
  return suggestion;
}

export {
  INLINE_COMPLETION_CACHE_MS,
  INLINE_COMPLETION_MIN_INTERVAL_MS,
  INLINE_COMPLETION_TABLE_LIMIT,
  MAX_DAILY_INLINE_COMPLETIONS,
};
