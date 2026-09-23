/**
 * Query runtime: error formatting, timeouts, SQL helpers, metric extraction, execution.
 */

import { invoke } from "@tauri-apps/api/core";
import { translateCurrent } from "../../../i18n";
import type { QueryResult } from "../../../types";
import {
  normalizedStatementIsDisguisedWrite,
  splitSqlStatements,
} from "../../../utils/sqlStatements";
import { stripLeadingSqlNoise } from "../../../utils/sql-safety";
import { METRICS_QUERY_TIMEOUT_MS } from "./metrics-grid-config";

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

export function formatExecutionError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error:\s*/, "");
}

// ---------------------------------------------------------------------------
// Timeout wrapper
// ---------------------------------------------------------------------------

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------------

/** Removes ALL SQL comments (line + block) while preserving string literals,
    so keyword checks cannot be dodged with comment or `--` tricks. */
function stripSqlComments(statement: string) {
  let result = "";
  let index = 0;
  while (index < statement.length) {
    const char = statement[index];
    const next = statement[index + 1];
    if (char === "'" || char === '"' || char === "`") {
      const quoteEnd = statement.indexOf(char, index + 1);
      if (quoteEnd === -1) {
        result += statement.slice(index);
        break;
      }
      result += statement.slice(index, quoteEnd + 1);
      index = quoteEnd + 1;
      continue;
    }
    if (char === "-" && next === "-") {
      const lineEnd = statement.indexOf("\n", index + 2);
      if (lineEnd === -1) break;
      result += " ";
      index = lineEnd + 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const commentEnd = statement.indexOf("*/", index + 2);
      if (commentEnd === -1) break;
      result += " ";
      index = commentEnd + 2;
      continue;
    }
    result += char;
    index += 1;
  }
  return result;
}

function normalizeSqlForMetrics(statement: string) {
  return stripSqlComments(stripLeadingSqlNoise(statement))
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

export function validateMetricsQuery(
  sql: string,
): { ok: true; statement: string } | { ok: false; error: string } {
  const statements = splitSqlStatements(sql)
    .map((statement) => statement.trim())
    .filter(Boolean);

  if (statements.length === 0) {
    return { ok: false, error: translateCurrent("metrics.validation.addQuery") };
  }

  if (statements.length > 1) {
    return { ok: false, error: translateCurrent("metrics.validation.singleStatement") };
  }

  const statement = statements[0];
  const normalized = normalizeSqlForMetrics(statement);
  if (!normalized) {
    return { ok: false, error: translateCurrent("metrics.validation.singleStatement") };
  }

  const readPrefixes = ["SELECT", "WITH", "SHOW", "DESCRIBE", "EXPLAIN", "PRAGMA"];
  const allowed = readPrefixes.some((prefix) => normalized.startsWith(prefix));
  if (!allowed) {
    return {
      ok: false,
      error: translateCurrent("metrics.validation.readOnlyOnly"),
    };
  }

  // EXPLAIN ANALYZE executes the wrapped statement server-side — it is never
  // a pure read, even for SELECT.
  if (/^EXPLAIN\s+ANALYZE\b/.test(normalized) || /^EXPLAIN\s*\([^)]*\bANALYZE\b/.test(normalized)) {
    return {
      ok: false,
      error: translateCurrent("metrics.validation.readOnlyOnly"),
    };
  }

  // Disguised writes behind a read-looking prefix: `SELECT ... INTO`,
  // data-modifying CTE bodies (`WITH x AS (DELETE ...)`), and PRAGMA
  // assignments / non-readonly pragma calls (`writable_schema`, `user_version`).
  if (normalizedStatementIsDisguisedWrite(normalized)) {
    return {
      ok: false,
      error: normalized.startsWith("WITH")
        ? translateCurrent("metrics.validation.noMutatingCte")
        : translateCurrent("metrics.validation.readOnlyOnly"),
    };
  }

  return { ok: true, statement };
}

// ---------------------------------------------------------------------------
// Number conversion
// ---------------------------------------------------------------------------

export function toNumber(value: string | number | boolean | null | undefined) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Metric data extraction
// ---------------------------------------------------------------------------

export function getMetricValue(result: QueryResult | null) {
  if (!result || result.rows.length === 0 || result.columns.length === 0) {
    return { primary: translateCurrent("metrics.widget.noData"), secondary: "" };
  }

  const row = result.rows[0];
  const numericIndex = row.findIndex((value) => toNumber(value) !== null);
  const primaryValue = numericIndex >= 0 ? row[numericIndex] : row[0];
  const secondaryIndex = row.findIndex((_, index) => index !== numericIndex && row[index] !== null);
  const secondaryValue =
    secondaryIndex >= 0
      ? `${result.columns[secondaryIndex]?.name || "detail"}: ${String(row[secondaryIndex])}`
      : result.columns[numericIndex >= 0 ? numericIndex : 0]?.name || "";

  return {
    primary: primaryValue === null ? "NULL" : String(primaryValue),
    secondary: secondaryValue,
  };
}

export function getSeries(result: QueryResult | null) {
  if (!result || result.rows.length === 0 || result.columns.length === 0) return [];

  return result.rows
    .map((row) => {
      const numericIndex = row.findIndex((value) => toNumber(value) !== null);
      if (numericIndex === -1) return null;

      const labelIndex = numericIndex === 0 ? 1 : 0;
      const numericValue = toNumber(row[numericIndex]);
      if (numericValue === null) return null;

      return {
        label:
          row[labelIndex] === undefined || row[labelIndex] === null
            ? result.columns[numericIndex]?.name || `Value ${numericIndex + 1}`
            : String(row[labelIndex]),
        value: numericValue,
      };
    })
    .filter((item): item is { label: string; value: number } => !!item)
    .slice(0, 8);
}

/** The column a chart's category labels came from — mirrors getSeries' pick. */
export function getSeriesLabelColumn(result: QueryResult | null): string | null {
  if (!result || result.rows.length === 0 || result.columns.length === 0) return null;
  const row = result.rows[0];
  const numericIndex = row.findIndex((value) => toNumber(value) !== null);
  if (numericIndex === -1) return null;
  const labelIndex = numericIndex === 0 ? 1 : 0;
  return result.columns[labelIndex]?.name ?? null;
}

// ---------------------------------------------------------------------------

// Query execution
// ---------------------------------------------------------------------------

const METRICS_QUERY_MAX_CONCURRENCY = 3;

type MetricsQueryTask = {
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

const metricsQueryQueue: MetricsQueryTask[] = [];
let activeMetricsQueries = 0;

function pumpMetricsQueryQueue() {
  while (activeMetricsQueries < METRICS_QUERY_MAX_CONCURRENCY && metricsQueryQueue.length > 0) {
    const task = metricsQueryQueue.shift();
    if (!task) return;

    activeMetricsQueries += 1;
    void task
      .run()
      .then((value) => {
        task.resolve(value);
      })
      .catch((error) => {
        task.reject(error);
      })
      .finally(() => {
        activeMetricsQueries = Math.max(0, activeMetricsQueries - 1);
        window.setTimeout(pumpMetricsQueryQueue, 0);
      });
  }
}

function enqueueMetricsQuery<T>(run: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    metricsQueryQueue.push({
      run: () => run(),
      resolve: (value) => resolve(value as T),
      reject,
    });
    pumpMetricsQueryQueue();
  });
}

export async function executeMetricsQuery(
  connectionId: string,
  statement: string,
): Promise<QueryResult> {
  return enqueueMetricsQuery(() =>
    withTimeout<QueryResult>(
      invoke("execute_sandboxed_query", {
        connectionId,
        statements: [statement],
        requireReadOnly: true,
        requestId: crypto.randomUUID(),
      }),
      METRICS_QUERY_TIMEOUT_MS,
      "Metrics query",
    ),
  );
}
