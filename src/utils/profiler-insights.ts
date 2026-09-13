/**
 * Profiler insights — deterministic heuristics over statement-store aggregates.
 *
 * P3 of the hybrid profiler. Turns raw per-statement counters (calls / mean time
 * / total time) into actionable warnings without needing a query plan. The
 * headline signal is the N+1 pattern: an application that runs one "list" query
 * then a cheap point-lookup per row collapses, in the engine's statement store,
 * into a single digest with a very high call count and a very low mean time — so
 * that shape is the classic N+1 fingerprint. Missing-index advice is delivered
 * separately by the EXPLAIN plan (see `index-advisor.ts`); these heuristics work
 * purely from aggregate numbers, so they run on every row with no round-trip.
 *
 * Everything here is pure and deterministic: the same stats always yield the
 * same insights, which keeps the unit tests honest.
 */

/** The per-statement counters the heuristics reason about. */
export interface StatementStat {
  /** Statement text (may be a normalized digest with `$1` / `?` placeholders). */
  queryText: string;
  /** Number of executions accumulated in the statement store. */
  calls: number;
  /** Mean execution time in milliseconds. */
  meanMs: number;
  /** Cumulative execution time in milliseconds. */
  totalMs: number;
}

export type ProfilerInsightCode = "n-plus-one" | "chatty" | "slow";
export type ProfilerInsightSeverity = "warn" | "info";

export interface ProfilerInsight {
  code: ProfilerInsightCode;
  severity: ProfilerInsightSeverity;
  /** Short badge label, e.g. `N+1?`. */
  label: string;
  /** One-line explanation carrying the concrete numbers. */
  message: string;
}

/**
 * A statement run this many times or more, with a mean at or below
 * {@link N_PLUS_ONE_MAX_MEAN_MS}, that reads like a single-row lookup is treated
 * as a probable N+1. The thresholds are intentionally conservative so a normal
 * hot query is not mislabelled.
 */
export const N_PLUS_ONE_MIN_CALLS = 50;
export const N_PLUS_ONE_MAX_MEAN_MS = 5;
/** Above this call count a statement is "chatty" even if it is not a lookup. */
export const CHATTY_MIN_CALLS = 1000;
/** At or above this mean time a single execution is individually slow. */
export const SLOW_MIN_MEAN_MS = 1000;

/** Equality / `IN` filtered SELECT — the shape an N+1 per-row lookup takes. */
const POINT_LOOKUP_RE = /^\s*select\b[\s\S]*\bwhere\b[\s\S]*(=|\bin\b)/i;

/** True when the statement looks like a single-row SELECT lookup. */
export function isPointLookup(queryText: string): boolean {
  return POINT_LOOKUP_RE.test(queryText);
}

/**
 * Parameter placeholders left behind by statement-store normalization
 * (`pg_stat_statements` uses `$1`, `performance_schema` uses `?`). EXPLAIN
 * cannot bind these, so a caller can warn before attempting to plan a digest.
 */
export function hasNormalizedPlaceholders(sql: string): boolean {
  return /\$\d+/.test(sql) || /(^|[\s,(=])\?($|[\s,)])/.test(sql);
}

function toLocale(value: number): string {
  return Math.round(value).toLocaleString();
}

/** Classify a single statement's aggregate counters into zero or more insights. */
export function analyzeStatement(stat: StatementStat): ProfilerInsight[] {
  const insights: ProfilerInsight[] = [];
  const calls = Math.max(0, Math.round(stat.calls));
  const mean = Math.max(0, stat.meanMs);

  if (calls >= N_PLUS_ONE_MIN_CALLS && mean <= N_PLUS_ONE_MAX_MEAN_MS && isPointLookup(stat.queryText)) {
    insights.push({
      code: "n-plus-one",
      severity: "warn",
      label: "N+1?",
      message: `Called ${toLocale(calls)}× at ${mean.toFixed(2)} ms each — a cheap point-lookup run this often is the classic N+1 signature. Consider batching with IN (...) or a JOIN.`,
    });
  } else if (calls >= CHATTY_MIN_CALLS) {
    insights.push({
      code: "chatty",
      severity: "info",
      label: "Chatty",
      message: `Executed ${toLocale(calls)} times. High call volume adds round-trip overhead even when each call is fast.`,
    });
  }

  if (mean >= SLOW_MIN_MEAN_MS) {
    insights.push({
      code: "slow",
      severity: "warn",
      label: "Slow",
      message: `Mean execution time is ${(mean / 1000).toFixed(2)} s. Run Explain to check the plan for full scans or a missing index.`,
    });
  }

  return insights;
}

/** The single highest-priority insight (warnings before info), or null. */
export function primaryInsight(stat: StatementStat): ProfilerInsight | null {
  const insights = analyzeStatement(stat);
  if (insights.length === 0) return null;
  const warn = insights.find((insight) => insight.severity === "warn");
  return warn ?? insights[0];
}
