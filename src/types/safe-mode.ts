/** Safe mode protection levels for query execution. */

export type SafeModeLevel = 0 | 1 | 2 | 3 | 4 | 5;

/** Label and description for each safe mode level. */
export const SAFE_MODE_LABELS: Record<SafeModeLevel, { label: string; description: string }> = {
  0: {
    label: "Disabled",
    description: "No protection — all SQL statements are allowed without restrictions.",
  },
  1: {
    label: "Read Only",
    description: "Only SELECT, SHOW, EXPLAIN, WITH queries are allowed. All write operations are blocked.",
  },
  2: {
    label: "Low Risk",
    description: "SELECT + INSERT only. UPDATE and DELETE operations are blocked.",
  },
  3: {
    label: "Standard",
    description: "INSERT, UPDATE, DELETE require confirmation. DROP, TRUNCATE, ALTER (except RENAME), CREATE TABLE are blocked.",
  },
  4: {
    label: "Strict",
    description: "Confirmation required for ALL writes: INSERT, UPDATE, DELETE, ALTER, CREATE, DROP, TRUNCATE, GRANT, REVOKE.",
  },
  5: {
    label: "Paranoid",
    description: "Confirmation required for SELECT and ALL writes. Full SQL preview + estimated affected rows shown before execution.",
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
export const LEVEL3_CONFIRM_PATTERNS = [
  /^\s*INSERT\s+/i,
  /^\s*UPDATE\s+/i,
  /^\s*DELETE\s+/i,
];

/** Statements requiring confirmation at level 4+. */
export const LEVEL4_CONFIRM_PATTERNS = [
  /^\s*ALTER\s+/i,
  /^\s*CREATE\s+(?!TABLE\b)/i,
  /^\s*GRANT\s+/i,
  /^\s*REVOKE\s+/i,
  /^\s*DROP\s+/i,
  /^\s*TRUNCATE\s+/i,
];

/** Pattern: ALTER TABLE ... RENAME COLUMN (allowed at level 3). */
export const RENAME_COLUMN_PATTERN = /^\s*ALTER\s+TABLE\s+\S+\s+RENAME\s+COLUMN\s+/i;

/** Determine the risk type of a SQL statement. */
export function classifyStatement(sql: string): StatementRiskType {
  const trimmed = sql.trim();

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

  return "read";
}

/** Check if a statement is always blocked at a given level. */
export function isBlockedAtLevel(level: SafeModeLevel, sql: string): boolean {
  const trimmed = sql.trim();

  switch (level) {
    case 0: // Disabled — nothing blocked
      return false;

    case 1: {
      // Read only: block everything except SELECT family
      const readPattern = /^\s*(SELECT|SHOW|EXPLAIN|WITH|DESCRIBE|DESC)\s+/i;
      return !readPattern.test(trimmed);
    }

    case 2: {
      // Low risk: allow SELECT + INSERT only
      const allowed = /^\s*(SELECT|SHOW|EXPLAIN|WITH|DESCRIBE|DESC|INSERT)\s+/i;
      return !allowed.test(trimmed);
    }

    case 3: {
      // Standard: block DROP, TRUNCATE, CREATE TABLE, ALTER (except RENAME COLUMN)
      for (const pattern of ALWAYS_BLOCKED_PATTERNS) {
        if (pattern.test(trimmed)) return true;
      }
      // Block ALTER (except RENAME COLUMN) at level 3
      if (/^\s*ALTER\s+/i.test(trimmed) && !RENAME_COLUMN_PATTERN.test(trimmed)) {
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
  const trimmed = sql.trim();

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
}
