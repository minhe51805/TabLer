import {
  getQualifiedTableName,
  getQuotedQualifiedTableName,
  quoteIdentifier,
} from "../SidebarUtils";
import type { TableInfo } from "../../../types";
import type { FilterCondition } from "../../../types/filter-presets";

/**
 * Pure SQL script templates and search-condition matching for the explorer.
 * No React or store dependencies.
 */
// ---------------------------------------------------------------------------
// Script builders
// ---------------------------------------------------------------------------

export function buildOverviewScript(
  table: Pick<TableInfo, "name" | "schema">,
  dbType?: string,
) {
  const qualified = getQuotedQualifiedTableName(table, dbType);
  return `-- Overview for ${getQualifiedTableName(table)}
SELECT COUNT(*) AS total_rows FROM ${qualified};

SELECT *
FROM ${qualified}
LIMIT 100;`;
}

export function buildSelectScript(table: Pick<TableInfo, "name" | "schema">, dbType?: string) {
  const qualified = getQuotedQualifiedTableName(table, dbType);
  return `SELECT *
FROM ${qualified}
LIMIT 1000;`;
}

export function buildInsertTemplate(table: Pick<TableInfo, "name" | "schema">, dbType?: string) {
  const qualified = getQuotedQualifiedTableName(table, dbType);
  return `INSERT INTO ${qualified} (
  -- columns
)
VALUES (
  -- values
);`;
}

export function buildUpdateTemplate(table: Pick<TableInfo, "name" | "schema">, dbType?: string) {
  const qualified = getQuotedQualifiedTableName(table, dbType);
  return `UPDATE ${qualified}
SET
  -- column = value
WHERE
  -- condition
;`;
}

export function buildDeleteTemplate(table: Pick<TableInfo, "name" | "schema">, dbType?: string) {
  const qualified = getQuotedQualifiedTableName(table, dbType);
  return `DELETE FROM ${qualified}
WHERE
  -- condition
;`;
}

export function buildCloneScript(table: Pick<TableInfo, "name" | "schema">, dbType?: string) {
  const source = getQuotedQualifiedTableName(table, dbType);
  const cloneName = quoteIdentifier(`${table.name}_copy`, dbType);
  return `-- Clone ${getQualifiedTableName(table)}
CREATE TABLE ${cloneName} AS
SELECT *
FROM ${source};`;
}

export function buildTruncateScript(table: Pick<TableInfo, "name" | "schema">, dbType?: string) {
  const qualified = getQuotedQualifiedTableName(table, dbType);
  if (dbType === "sqlite") {
    return `DELETE FROM ${qualified};`;
  }
  return `TRUNCATE TABLE ${qualified};`;
}

export function buildDropScript(table: Pick<TableInfo, "name" | "schema">, dbType?: string) {
  const qualified = getQuotedQualifiedTableName(table, dbType);
  return `DROP TABLE ${qualified};`;
}

// ---------------------------------------------------------------------------
// Filter logic
// ---------------------------------------------------------------------------

/** Apply a single filter condition to a table name or schema name */
export function applyCondition(
  value: string,
  condition: FilterCondition
): boolean {
  if (!condition?.operator) return true;
  // Harden against legacy/persisted conditions missing `value`.
  const target = (value ?? "").toLowerCase();
  const val = condition.value ?? "";

  switch (condition.operator) {
    case "equals":
      return target === val.toLowerCase();
    case "not_equals":
      return target !== val.toLowerCase();
    case "contains":
      return target.includes(val.toLowerCase());
    case "not_contains":
      return !target.includes(val.toLowerCase());
    case "starts_with":
      return target.startsWith(val.toLowerCase());
    case "ends_with":
      return target.endsWith(val.toLowerCase());
    case "is_empty":
      return target === "" || target === "null";
    case "is_not_empty":
      return target !== "" && target !== "null";
    case "like":
      try {
        const escaped = val.replace(/%/g, ".*").replace(/_/g, ".");
        return new RegExp(`^${escaped}$`, "i").test(value);
      } catch {
        return false;
      }
    case "not_like":
      try {
        const escaped = val.replace(/%/g, ".*").replace(/_/g, ".");
        return !new RegExp(`^${escaped}$`, "i").test(value);
      } catch {
        return false;
      }
    case "regex_match":
      try {
        return new RegExp(val, "i").test(value);
      } catch {
        return false;
      }
    case "in_list": {
      const items = val.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      return items.includes(target);
    }
    case "not_in_list": {
      const items = val.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      return !items.includes(target);
    }
    case "greater_than":
      return target > val.toLowerCase();
    case "less_than":
      return target < val.toLowerCase();
    case "greater_or_equal":
      return target >= val.toLowerCase();
    case "less_or_equal":
      return target <= val.toLowerCase();
    case "raw_sql":
      // raw_sql is applied separately; skip here
      return true;
    default:
      return true;
  }
}

/**
 * Apply all conditions, letting the caller pick which string each condition
 * targets (e.g. table name vs. schema) based on `condition.column`.
 */
export function applyConditionsWith(
  getValue: (condition: FilterCondition) => string,
  conditions: FilterCondition[],
  logic: "AND" | "OR"
): boolean {
  if (conditions.length === 0) return true;
  // Skip conditions with an empty value (e.g. an untouched date row): they
  // would otherwise filter everything out with operators like `equals`.
  // `is_empty`/`is_not_empty` are the exceptions — they operate on emptiness.
  const active = conditions.filter(
    (c) =>
      (c.value ?? "").trim() !== "" ||
      c.operator === "is_empty" ||
      c.operator === "is_not_empty",
  );
  if (active.length === 0) return true;
  const results = active.map((c) => applyCondition(getValue(c) ?? "", c));
  return logic === "AND" ? results.every(Boolean) : results.some(Boolean);
}

/** Apply all conditions to a single value using AND/OR logic */
export function applyConditions(
  value: string,
  conditions: FilterCondition[],
  logic: "AND" | "OR"
): boolean {
  if (conditions.length === 0) return true;
  const results = conditions.map((c) => applyCondition(value, c));
  return logic === "AND" ? results.every(Boolean) : results.some(Boolean);
}

// ---------------------------------------------------------------------------
// Mixed-state checkbox filter
// ---------------------------------------------------------------------------
