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
  if (!condition.operator) return true;
  const needle = value.toLowerCase();

  switch (condition.operator) {
    case "equals":
      return needle === condition.value.toLowerCase();
    case "not_equals":
      return needle !== condition.value.toLowerCase();
    case "contains":
      return needle.includes(condition.value.toLowerCase());
    case "not_contains":
      return !needle.includes(condition.value.toLowerCase());
    case "starts_with":
      return needle.startsWith(condition.value.toLowerCase());
    case "ends_with":
      return needle.endsWith(condition.value.toLowerCase());
    case "is_empty":
      return needle === "" || needle === "null";
    case "is_not_empty":
      return needle !== "" && needle !== "null";
    case "like":
      try {
        const escaped = condition.value.replace(/%/g, ".*").replace(/_/g, ".");
        return new RegExp(`^${escaped}$`, "i").test(value);
      } catch {
        return false;
      }
    case "not_like":
      try {
        const escaped = condition.value.replace(/%/g, ".*").replace(/_/g, ".");
        return !new RegExp(`^${escaped}$`, "i").test(value);
      } catch {
        return false;
      }
    case "regex_match":
      try {
        return new RegExp(condition.value, "i").test(value);
      } catch {
        return false;
      }
    case "in_list": {
      const items = condition.value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      return items.includes(needle);
    }
    case "not_in_list": {
      const items = condition.value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      return !items.includes(needle);
    }
    case "greater_than":
      return needle > condition.value.toLowerCase();
    case "less_than":
      return needle < condition.value.toLowerCase();
    case "greater_or_equal":
      return needle >= condition.value.toLowerCase();
    case "less_or_equal":
      return needle <= condition.value.toLowerCase();
    case "raw_sql":
      // raw_sql is applied separately; skip here
      return true;
    default:
      return true;
  }
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
