/**
 * Query runtime: error formatting, timeouts, SQL helpers, metric extraction, execution.
 */

import { invoke } from "@tauri-apps/api/core";
import { translateCurrent } from "../../../i18n";
import type { QueryResult } from "../../../types";
import { splitSqlStatements } from "../../../utils/sqlStatements";
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

function stripLeadingSqlNoise(statement: string) {
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

function normalizeSqlForMetrics(statement: string) {
  return stripLeadingSqlNoise(statement).replace(/\s+/g, " ").trim().toUpperCase();
}

export function validateMetricsQuery(sql: string): { ok: true; statement: string } | { ok: false; error: string } {
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

  if (
    normalized.startsWith("WITH") &&
    [" INSERT ", " UPDATE ", " DELETE ", " MERGE "].some((keyword) => normalized.includes(keyword))
  ) {
    return {
      ok: false,
      error: translateCurrent("metrics.validation.noMutatingCte"),
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

export async function executeMetricsQuery(connectionId: string, statement: string): Promise<QueryResult> {
  return enqueueMetricsQuery(() =>
    withTimeout<QueryResult>(
      invoke("execute_sandboxed_query", {
        connectionId,
        statements: [statement],
      }),
      METRICS_QUERY_TIMEOUT_MS,
      "Metrics query",
    ),
  );
}
