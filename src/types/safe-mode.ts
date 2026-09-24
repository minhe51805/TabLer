/** Safe mode protection levels for query execution. */

import { normalizedStatementIsDisguisedWrite } from "../utils/sqlStatements";
import {
  explainAnalyzeInnerStatement,
  explainInnerStatement,
  stripLeadingSqlNoise,
} from "../utils/sql-safety";

export type SafeModeLevel = 0 | 1 | 2 | 3 | 4 | 5;
export type ConnectionEnvironment = "development" | "staging" | "production" | "unknown";

export const CONNECTION_ENVIRONMENT_LABELS: Record<ConnectionEnvironment, string> = {
  development: "Development",
  staging: "Staging",
  production: "Production",
  unknown: "Unclassified",
};

/** Label and description for each safe mode level. */
export const SAFE_MODE_LABELS: Record<SafeModeLevel, { label: string; description: string }> = {
  0: {
    label: "Disabled",
    description: "No protection — all SQL statements are allowed without restrictions.",
  },
  1: {
    label: "Read Only",
    description:
      "Only SELECT, SHOW, EXPLAIN, WITH queries are allowed. All write operations are blocked.",
  },
  2: {
    label: "Low Risk",
    description: "SELECT + INSERT only. UPDATE and DELETE operations are blocked.",
  },
  3: {
    label: "Standard",
    description:
      "INSERT, UPDATE, DELETE require confirmation. DROP, TRUNCATE, ALTER (except RENAME), CREATE TABLE are blocked.",
  },
  4: {
    label: "Strict",
    description:
      "Confirmation required for ALL writes: INSERT, UPDATE, DELETE, ALTER, CREATE, DROP, TRUNCATE, GRANT, REVOKE.",
  },
  5: {
    label: "Paranoid",
    description:
      "Confirmation required for SELECT and ALL writes. Full SQL preview + estimated affected rows shown before execution.",
  },
};

/** SQL statement types classified by risk level. */
export type StatementRiskType = "read" | "insert" | "update" | "delete" | "ddl" | "dcl" | "blocked";

/** Statements that are always blocked regardless of level. */
export const ALWAYS_BLOCKED_PATTERNS = [
  /^\s*DROP\s+/i,
  /^\s*TRUNCATE\s+/i,
  /^\s*CREATE\s+TABLE\b/i,
];

/** Statements requiring confirmation at level 3+. */
export const LEVEL3_CONFIRM_PATTERNS = [/^\s*INSERT\s+/i, /^\s*UPDATE\s+/i, /^\s*DELETE\s+/i];

/** Statements requiring confirmation at level 4+. */
export const LEVEL4_CONFIRM_PATTERNS = [
  /^\s*ALTER\s+/i,
  /^\s*CREATE\s+(?!TABLE\b)/i,
  /^\s*GRANT\s+/i,
  /^\s*REVOKE\s+/i,
  /^\s*DROP\s+/i,
  /^\s*TRUNCATE\s+/i,
];

/** Pattern: ALTER TABLE ... RENAME COLUMN only (allowed at level 3). Every
 *  comma-separated action must be a RENAME COLUMN — a combined
 *  `RENAME COLUMN a TO b, DROP COLUMN c` must NOT match (mirrors the backend
 *  is_rename_column_only check which requires all AlterTableOperations to be
 *  renames). */
export const RENAME_COLUMN_PATTERN = /^\s*ALTER\s+TABLE\s+\S+\s+RENAME\s+COLUMN\s+[^;]+$/i;

/** True when an ALTER TABLE statement consists solely of RENAME COLUMN
 *  actions. Conservative: any action keyword other than RENAME COLUMN
 *  (DROP/ADD/CHANGE/MODIFY/ALTER/RENAME TO) disqualifies it. */
export function isRenameColumnOnly(statement: string): boolean {
  const trimmed = statement.trim().replace(/;+\s*$/, "");
  if (!RENAME_COLUMN_PATTERN.test(trimmed)) return false;
  const actions = trimmed.replace(/^\s*ALTER\s+TABLE\s+\S+\s+/i, "");
  // Split top-level commas (no parens expected in rename lists, but guard anyway).
  const parts = actions.split(",");
  return parts.every((part) => /^\s*RENAME\s+COLUMN\s+/i.test(part));
}

/** Read-only leading keywords an `EXPLAIN ANALYZE` may legitimately wrap. */
const EXPLAIN_ANALYZE_READ_PREFIXES = [
  "SELECT",
  "WITH",
  "SHOW",
  "DESCRIBE",
  "DESC",
  "EXPLAIN",
  "PRAGMA",
  "VALUES",
  "TABLE",
];

/** True when a normalized (uppercased, whitespace-collapsed) statement
    mutates despite wearing a read-looking prefix: `SELECT ... INTO`,
    data-modifying CTE bodies, `PRAGMA` writes, and `EXPLAIN <write>` — the
    ANALYZE form EXECUTES the wrapped statement, and the backend classifier
    treats even the planning form as non-read (a read-only surface must not
    plan mutations), so both inherit the inner statement's mutation. */
function normalizedStatementMutates(normalized: string): boolean {
  if (normalizedStatementIsDisguisedWrite(normalized)) return true;
  const inner = explainInnerStatement(normalized);
  if (!inner) return false;
  if (EXPLAIN_ANALYZE_READ_PREFIXES.some((prefix) => inner.startsWith(prefix))) {
    return normalizedStatementMutates(inner);
  }
  return true;
}
/** Determine the risk type of a SQL statement. */
export function classifyStatement(sql: string): StatementRiskType {
  // Leading comments must not hide the real first keyword.
  const trimmed = stripLeadingSqlNoise(sql).trim();
  const normalized = trimmed.replace(/\s+/g, " ").toUpperCase();

  // SELECT ... INTO, EXPLAIN ANALYZE <write>, and mutating CTEs wear a read's
  // leading keyword — defer to the mutating-statement check before trusting it.
  if (
    /^\s*(SELECT|EXPLAIN|WITH|PRAGMA)\s*/i.test(trimmed) &&
    normalizedStatementMutates(normalized)
  ) {
    return "ddl";
  }
  if (/^\s*(SELECT|SHOW|EXPLAIN|WITH|DESCRIBE|DESC)\s+/i.test(trimmed)) {
    return "read";
  }
  if (/^\s*INSERT\s+/i.test(trimmed)) return "insert";
  if (/^\s*UPDATE\s+/i.test(trimmed)) return "update";
  if (/^\s*DELETE\s+/i.test(trimmed)) return "delete";
  if (/^\s*GRANT\s+/i.test(trimmed) || /^\s*REVOKE\s+/i.test(trimmed)) return "dcl";
  if (/^\s*ALTER\s+TABLE\s+\S+\s+RENAME\s+COLUMN\s+/i.test(trimmed)) return "ddl"; // RENAME is treated as confirmable at level 3
  if (/^\s*ALTER\s+/i.test(trimmed)) return "ddl";
  if (
    /^\s*CREATE\s+/i.test(trimmed) ||
    /^\s*DROP\s+/i.test(trimmed) ||
    /^\s*TRUNCATE\s+/i.test(trimmed)
  ) {
    return "ddl";
  }
  // Fail closed: anything unrecognized is not a read.
  return "ddl";
}

/** Check if a statement is always blocked at a given level. */
export function isBlockedAtLevel(level: SafeModeLevel, sql: string): boolean {
  // Leading comments must not hide the real first keyword.
  const trimmed = stripLeadingSqlNoise(sql).trim();
  const normalized = trimmed.replace(/\s+/g, " ").toUpperCase();

  // `EXPLAIN ANALYZE <stmt>` executes the wrapped statement — it inherits the
  // block status of whatever it analyzes.
  const explainInner = explainAnalyzeInnerStatement(normalized);
  if (explainInner) {
    return isBlockedAtLevel(level, explainInner);
  }

  switch (level) {
    case 0: // Disabled — nothing blocked
      return false;

    case 1: {
      // Read only: block everything except SELECT family — and even a
      // SELECT/EXPLAIN/WITH is blocked when it actually mutates (SELECT INTO,
      // EXPLAIN ANALYZE <write>, data-modifying CTE).
      const readPattern = /^\s*(SELECT|SHOW|EXPLAIN|WITH|DESCRIBE|DESC)\s+/i;
      return !readPattern.test(trimmed) || normalizedStatementMutates(normalized);
    }

    case 2: {
      // Low risk: allow SELECT + INSERT only
      const allowed = /^\s*(SELECT|SHOW|EXPLAIN|WITH|DESCRIBE|DESC|INSERT)\s+/i;
      if (!allowed.test(trimmed)) return true;
      // A disguised write is not "low risk" just because it starts with SELECT.
      return (
        /^\s*(SELECT|EXPLAIN|WITH)\s+/i.test(trimmed) && normalizedStatementMutates(normalized)
      );
    }
    case 3: {
      // Standard: block DROP, TRUNCATE, CREATE TABLE, ALTER (except RENAME COLUMN)
      for (const pattern of ALWAYS_BLOCKED_PATTERNS) {
        if (pattern.test(trimmed)) return true;
      }
      // Block ALTER (except RENAME COLUMN) at level 3
      if (/^\s*ALTER\s+/i.test(trimmed) && !isRenameColumnOnly(trimmed)) {
        return true;
      }
      return false;
    }

    case 4:
    case 5: {
      // Strict / Paranoid: all writes need confirmation, but not auto-blocked
      // Only DROP/TRUNCATE/CREATE TABLE are hard-blocked at level 4+
      for (const pattern of ALWAYS_BLOCKED_PATTERNS) {
        if (pattern.test(trimmed)) return true;
      }
      return false;
    }

    default:
      return false;
  }
}

/** Check if a statement requires confirmation at a given level. */
export function requiresConfirmationAtLevel(level: SafeModeLevel, sql: string): boolean {
  if (level < 3) return false;
  // Leading comments must not hide the real first keyword.
  const trimmed = stripLeadingSqlNoise(sql).trim();
  const normalized = trimmed.replace(/\s+/g, " ").toUpperCase();

  // A disguised write (SELECT INTO, mutating CTE, EXPLAIN ANALYZE <write>)
  // needs the same review as the write it performs.
  if (normalizedStatementMutates(normalized)) return true;

  if (level === 3) {
    for (const pattern of LEVEL3_CONFIRM_PATTERNS) {
      if (pattern.test(trimmed)) return true;
    }
  }

  if (level >= 4) {
    for (const pattern of [...LEVEL3_CONFIRM_PATTERNS, ...LEVEL4_CONFIRM_PATTERNS]) {
      if (pattern.test(trimmed)) return true;
    }
  }

  return false;
}

/** Settings stored per connection override. */
export interface ConnectionSafeModeOverride {
  connectionId: string;
  level: SafeModeLevel;
}

/** Global safe mode settings persisted to localStorage. */
export interface SafeModeSettings {
  globalLevel: SafeModeLevel;
  /** Admin password hash for bypassing levels 4-5 confirmation. */
  adminPasswordHash?: string;
  /** Per-connection overrides. */
  connectionOverrides: ConnectionSafeModeOverride[];
  /** Visual environment labels and production defaults, stored independently from credentials. */
  connectionEnvironments?: Record<string, ConnectionEnvironment>;
}
