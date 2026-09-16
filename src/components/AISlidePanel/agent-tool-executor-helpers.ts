/**
 * Pure, side-effect-free helpers extracted from ai-agent-tool-executor: plan
 * normalization, column-stats scope/compute, query-parameter coercion, SQL
 * identifier quoting, and the static agent-SQL pre-flight. Unit-testable in
 * isolation (covered by the golden-set eval); the executor factory imports
 * these and the module re-exports them for back-compat.
 */
import type { DatabaseType, QueryParameterType } from "../../types";
import { findSystemCatalogReferences, getAgentSqlSchemaRequirements } from "./ai-agent-grounding";
import { AI_AGENT_COLUMN_STATS_MAX_TABLE_ROWS, validateAIAgentReadonlySql } from "./ai-agent-tools";

/**
 * Appended to SQL tool errors when the database itself gave up on the
 * statement (timeout). A timeout is actionable feedback: the model can run a
 * narrower statement instead of concluding the table is unreadable.
 */
export function agentQueryTimeoutHint(errorValue: unknown): string {
  const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
  return /timed?\s*out/i.test(message)
    ? " The database gave up on this query. Run a narrower statement instead: filter on a key column, select only the needed columns, and add a LIMIT."
    : "";
}

/** Scope of the sample_table_data column-statistics enrichment. */
export type AgentColumnStatsScope = "whole" | "sample" | "off";

const AGENT_PLAN_STATUSES = new Set(["pending", "in_progress", "done"]);

/**
 * Sanitizes raw update_plan `args.steps` into a bounded, status-valid
 * checklist: non-object entries and blank titles are dropped, statuses fall
 * back to "pending", titles are capped, and the list is truncated to the
 * schema maximum. Exported pure for the golden-set eval.
 */
export function normalizeAgentPlanSteps(
  raw: unknown,
  maxSteps: number,
): import("./ai-agent-context").AgentPlanStep[] {
  if (!Array.isArray(raw)) return [];
  const steps: import("./ai-agent-context").AgentPlanStep[] = [];
  for (const entry of raw) {
    if (steps.length >= maxSteps) break;
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const title = typeof record.title === "string" ? record.title.trim() : "";
    if (!title) continue;
    const status =
      typeof record.status === "string" && AGENT_PLAN_STATUSES.has(record.status)
        ? (record.status as import("./ai-agent-context").AgentPlanStep["status"])
        : "pending";
    steps.push({ title: title.slice(0, 160), status });
  }
  return steps;
}

/**
 * Resolves how sample_table_data computes column statistics. "whole" runs one
 * aggregate over every row in the table — only safe when the catalog rowCount
 * is known and small. Large or unknown-size tables use "sample" (stats from
 * the rows already fetched) so a peek can never become a full-table scan.
 */
export function resolveColumnStatsScope(
  requested: string | undefined,
  knownRowCount: number | null,
): AgentColumnStatsScope {
  if (requested === "off") return "off";
  if (requested === "sample") return "sample";
  return knownRowCount !== null && knownRowCount <= AI_AGENT_COLUMN_STATS_MAX_TABLE_ROWS
    ? "whole"
    : "sample";
}

/**
 * Column statistics computed in memory from an already-fetched result page —
 * the honest fallback for tables too big (or of unknown size) for a
 * whole-table aggregate. Rows are positional, matching QueryResult.rows.
 */
export function computeSampleColumnStats(
  rows: Array<Array<string | number | boolean | null>>,
  columns: Array<{ name: string; index: number }>,
): Array<{ column: string; nullRatio: number; distinctCount: number }> {
  const total = rows.length;
  if (total === 0) return [];
  return columns.map(({ name, index }) => {
    const distinct = new Set<string>();
    let nullCount = 0;
    for (const row of rows) {
      const value = row[index];
      if (value === null || value === undefined || value === "") {
        nullCount += 1;
        continue;
      }
      distinct.add(String(value));
    }
    return {
      column: name,
      nullRatio: Math.round((nullCount / total) * 1000) / 1000,
      distinctCount: distinct.size,
    };
  });
}
const AGENT_PARAMETER_DATA_TYPES = new Set<string>([
  "text",
  "integer",
  "decimal",
  "boolean",
  "json",
  "null",
]);

/**
 * Infers the parameter data type from a raw JSON value, honouring an explicit
 * model-provided dataType when it is valid. Primitives bind directly; anything
 * else (objects/arrays) falls back to a JSON parameter.
 */
export function coerceAgentQueryParameter(
  name: string,
  rawValue: unknown,
  rawDataType?: unknown,
): { name: string; value: unknown; dataType: QueryParameterType } {
  let dataType: QueryParameterType = "text";
  let value = rawDataType === "null" ? null : rawValue;
  if (typeof rawDataType === "string" && AGENT_PARAMETER_DATA_TYPES.has(rawDataType)) {
    dataType = rawDataType as QueryParameterType;
    if (dataType === "null") value = null;
    if (dataType === "integer" && typeof value === "string") {
      const parsed = Number.parseInt(value, 10);
      value = Number.isFinite(parsed) ? parsed : value;
    }
    if (dataType === "decimal" && typeof value === "string") {
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed)) value = parsed;
    }
    if (dataType === "boolean" && typeof value === "string") {
      value = value.trim().toLowerCase() === "true";
    }
  } else if (typeof value === "number") {
    dataType = Number.isInteger(value) ? "integer" : "decimal";
  } else if (typeof value === "boolean") {
    dataType = "boolean";
  } else if (value !== null && (typeof value === "object" || Array.isArray(value))) {
    dataType = "json";
  }
  return { name, value, dataType };
}

/**
 * Quotes a (possibly schema-qualified) identifier per engine dialect so
 * agent-built SQL can never break out of the identifier context.
 */
export function agentSqlQuoteIdentifier(
  dbType: DatabaseType | undefined,
  identifier: string,
): string {
  const parts = identifier.trim().split(".").filter(Boolean);
  if (parts.length === 0) return identifier;
  if (dbType === "mysql" || dbType === "mariadb") {
    return parts.map((part) => `\`${part.replace(/`/g, "``")}\``).join(".");
  }
  if (dbType === "mssql") {
    return parts.map((part) => `[${part.replace(/]/g, "]]")}]`).join(".");
  }
  return parts.map((part) => `"${part.replace(/"/g, '""')}"`).join(".");
}

/**
 * Static pre-flight shared by run_parameterized_sql and check_sql. Returns
 * the first blocking reason, or null when the SQL passes all agent guards.
 */
export function analyzeAgentSqlForAgent(
  sql: string,
  availableSchemaTables: string[],
  inspectedAgentTables: Set<string>,
): { ok: true } | { ok: false; error: string } {
  try {
    validateAIAgentReadonlySql(sql);
  } catch (errorValue) {
    return {
      ok: false,
      error: errorValue instanceof Error ? errorValue.message : String(errorValue),
    };
  }
  const catalogRefs = findSystemCatalogReferences(sql);
  if (catalogRefs.length > 0) {
    return {
      ok: false,
      error: `SQL references system catalog objects (${catalogRefs.join(", ")}). Use list_tables, search_schema, or describe_table instead of system catalogs.`,
    };
  }
  const schemaRequirements = getAgentSqlSchemaRequirements(
    sql,
    availableSchemaTables,
    inspectedAgentTables,
  );
  if (schemaRequirements.unknown.length > 0) {
    return {
      ok: false,
      error: `SQL references unknown table(s): ${schemaRequirements.unknown.join(", ")}. Use list_tables and describe_table first.`,
    };
  }
  if (schemaRequirements.uninspected.length > 0) {
    return {
      ok: false,
      error: `Inspect the schema before reading rows. Call describe_table for: ${schemaRequirements.uninspected.join(", ")}.`,
    };
  }
  return { ok: true };
}
