/**
 * Pure, side-effect-free helpers extracted from ai-agent-tool-executor: plan
 * normalization, column-stats scope/compute, query-parameter coercion, SQL
 * identifier quoting, and the static agent-SQL pre-flight. Unit-testable in
 * isolation (covered by the golden-set eval); the executor factory imports
 * these and the module re-exports them for back-compat.
 */
import type { DatabaseType, QueryParameterType } from "../../types";
import { findSystemCatalogReferences, getAgentSqlSchemaRequirements } from "./ai-agent-grounding";
import { normalizeIntentText } from "./ai-assist-intent";
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

/**
 * Structured tool failure contract: every failed call returns
 * `Tool error: <message> {"error","hint","retryable"}`. The human-readable
 * prefix stays first so existing "Tool error" detection (quality gates, trace
 * status) and substring assertions keep working; the JSON trailer is the
 * machine-readable part the model is told to follow.
 */
export function agentToolError(
  error: string,
  options?: { hint?: string; retryable?: boolean },
): string {
  return `Tool error: ${error} ${JSON.stringify({
    error,
    hint: options?.hint ?? null,
    retryable: options?.retryable === true,
  })}`;
}

/**
 * True when the failure is plausibly transient (timeout, connection, rate
 * limit, lock contention) so re-issuing the same call can succeed. Argument
 * and policy failures are never marked retryable.
 */
export function isRetryableAgentToolError(errorValue: unknown): boolean {
  const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
  return /timed?\s*out|timeout|connection|ECONN|network|rate.?limit|429|temporar|locked|busy|deadlock|try again/i.test(
    message,
  );
}

/**
 * Small edit distance (Levenshtein, two-row) used only for fuzzy table-name
 * suggestions — bounded inputs, no allocation concerns worth optimizing.
 */
function agentEditDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  let previous = new Array<number>(right.length + 1);
  let current = new Array<number>(right.length + 1);
  for (let j = 0; j <= right.length; j += 1) previous[j] = j;
  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    [previous, current] = [current, previous];
  }
  return previous[right.length];
}

/**
 * Fuzzy "did you mean" suggestions for a table name that matched nothing in
 * the workspace schema. Ranks catalog names by containment first, then by
 * edit distance on the last identifier segment, and returns at most `limit`
 * candidates (empty when nothing is close).
 */
export function suggestAgentTableNames(
  requested: string,
  availableTableNames: string[],
  limit = 3,
): string[] {
  const target = normalizeIntentText(requested);
  if (!target) return [];
  const targetTail = target.split(".").pop() ?? target;
  const scored = availableTableNames
    .map((candidate) => {
      const normalized = normalizeIntentText(candidate);
      const tail = normalized.split(".").pop() ?? normalized;
      let score: number;
      if (normalized === target || tail === targetTail) {
        score = 0;
      } else if (normalized.startsWith(target) || tail.startsWith(targetTail)) {
        score = 1;
      } else if (normalized.includes(target) || tail.includes(targetTail)) {
        score = 2;
      } else {
        const distance = agentEditDistance(tail, targetTail);
        // Only near-misses qualify: a 4-char name tolerates 1 edit, longer
        // names tolerate proportionally more.
        const tolerance = Math.max(1, Math.floor(targetTail.length / 3));
        if (distance > tolerance) return null;
        score = 3 + distance;
      }
      return { candidate, score };
    })
    .filter((entry): entry is { candidate: string; score: number } => entry !== null)
    .sort(
      (left, right) => left.score - right.score || left.candidate.localeCompare(right.candidate),
    );
  return scored.slice(0, limit).map((entry) => entry.candidate);
}

/**
 * Turns a backend SQL failure into a corrective hint for the model: syntax
 * errors surface the parser position when the engine reports one, missing
 * tables/columns get a re-verify instruction, permission errors are flagged
 * non-retryable by the caller via isRetryableAgentToolError.
 */
export function agentSqlErrorHint(errorValue: unknown): string | undefined {
  const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
  // PostgreSQL: "syntax error at or near \"x\"" + a separate "Position: N"
  // line; MySQL: "... near 'x' at line N"; SQLite: 'near "x": syntax error'.
  const positionMatch =
    message.match(/position[:\s]+(\d+)/i) ??
    message.match(/at line (\d+)/i) ??
    message.match(/line (\d+),?\s*col(?:umn)?\s*(\d+)/i);
  const nearMatch =
    message.match(/syntax error at or near "([^"]+)"/i) ??
    message.match(/near '([^']+)'/i) ??
    message.match(/near "([^"]+)"/i);
  if (/syntax error|parse error|unexpected token/i.test(message)) {
    const parts: string[] = [];
    if (nearMatch?.[1]) parts.push(`near "${nearMatch[1]}"`);
    if (positionMatch) {
      parts.push(
        positionMatch[2]
          ? `line ${positionMatch[1]}, column ${positionMatch[2]}`
          : /line/i.test(positionMatch[0])
            ? `line ${positionMatch[1]}`
            : `character position ${positionMatch[1]}`,
      );
    }
    return `SQL syntax error${parts.length > 0 ? ` (${parts.join("; ")})` : ""}. Fix the statement at that position and re-run; check quoting, commas and keyword spelling.`;
  }
  const missingTable =
    message.match(/relation "([^"]+)" does not exist/i) ??
    message.match(/table ['"`]?([A-Za-z0-9_.$]+)['"`]? (?:does not exist|doesn't exist)/i) ??
    message.match(/no such table: ([A-Za-z0-9_.$]+)/i) ??
    message.match(/invalid object name '([^']+)'/i);
  if (missingTable?.[1]) {
    return `Table "${missingTable[1]}" was not found by the engine. Re-check the exact name with list_tables or describe_table before retrying.`;
  }
  const missingColumn =
    message.match(/column "([^"]+)" does not exist/i) ??
    message.match(/unknown column ['"]([^'"]+)['"]/i) ??
    message.match(/no such column: ([A-Za-z0-9_.$]+)/i) ??
    message.match(/invalid column name '([^']+)'/i);
  if (missingColumn?.[1]) {
    return `Column "${missingColumn[1]}" does not exist. Re-check describe_table output and use only verified column names.`;
  }
  if (/permission denied|access denied|not authorized|insufficient privilege/i.test(message)) {
    return "The database role lacks permission for this statement. Do not retry the same query; report the restriction or pick a table the role can read.";
  }
  return undefined;
}
