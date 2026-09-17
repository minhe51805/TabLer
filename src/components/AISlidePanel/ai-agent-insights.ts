/**
 * Proactive insight engine (P8).
 *
 * The gap this closes: today a finding exists only *inside* an answer to a
 * question — nothing ever volunteers one. This module produces findings the
 * agent surfaces on its own.
 *
 * Two rules make it more than a chatbot gimmick, and both are mechanical:
 *
 * 1. **An insight with no executed query behind it is dropped.** Every insight
 *    carries `evidence.executedSql` + `evidence.rowCount`, taken from facts the
 *    trace already recorded. A detector that cannot point at a query that ran
 *    cannot emit a card — that is enforced here, not asked of the model.
 * 2. **Confidence is computed from evidence strength, never claimed.** The
 *    graders below map an observed number (null ratio, distinct count) onto a
 *    score, so a model that "feels" 90 % confident cannot print a 90.
 *
 * The run-end pass is deliberately **synchronous and pure**: it reads steps,
 * returns findings, and takes no model callback. That is its entire
 * justification — it costs zero extra model calls.
 */
/**
 * The collector consumes `readStepFacts` / `AgentTraceStep`: an insight may only
 * cite a statement the trace recorded, so the evidence lives on the step facts
 * (`AgentStepEvidence`) rather than being reconstructed here.
 */
import { readStepFacts, type AgentColumnStats, type AgentTraceStep } from "./ai-agent-context";

/** Finding families this engine can prove. Adding one means adding a detector. */
export type InsightKind = "high-null-column" | "soft-delete-candidate" | "constant-column";

/** What ran, how much it proved, and a stable id for dedupe. */
export interface InsightEvidence {
  /** The statement that produced the numbers below. Required — no evidence, no card. */
  executedSql: string;
  /** Rows the evidence statement actually saw. Must be > 0. */
  rowCount: number;
  /** Stable fingerprint of (kind, table, column, executedSql) for dedupe. */
  digest: string;
}

export interface InsightSuggestedAction {
  /** Button label, e.g. "Drop the filter". */
  label: string;
  /** SQL pre-filled into the composer when the user takes the suggestion. */
  prefill: string;
  /** True when running the suggestion can modify data or schema. */
  danger: boolean;
}

export interface AgentInsight {
  /** `kind:table:column` — also the dedupe key from the plan. */
  id: string;
  kind: InsightKind;
  table: string;
  column?: string;
  title: string;
  detail: string;
  evidence: InsightEvidence;
  /** 0–100, computed by the graders below. */
  confidence: number;
  suggestedAction: InsightSuggestedAction;
  /** Skill whose knowledge produced the finding, when a skill was involved. */
  skillUsed?: string;
  /** When the card was first stored (ms epoch). */
  seenAt?: number;
}

/**
 * Only findings at or above this bar are shown — the §2.5 review rubric ported
 * to a machine. A speculative detector (say 55) can run and be filtered out,
 * which is exactly the behaviour we want from "name smells like a join column
 * but there is no FK".
 */
export const INSIGHT_MIN_CONFIDENCE = 80;

/** An insight engine that cries wolf is worse than none: hard caps. */
export const INSIGHT_MAX_PER_RUN = 3;
export const INSIGHT_MAX_STORED = 20;
/** A finding will not resurface within this window, per id. */
export const INSIGHT_COOLDOWN_MILLIS = 24 * 60 * 60 * 1000;

/** Below this row count the numbers are too thin to draw a conclusion from. */
const MIN_ROWS_FOR_EVIDENCE = 20;

/** A column at or above this NULL ratio is effectively "never populated". */
const HIGH_NULL_SATURATION = 0.995;
/** Values between the floor and saturation grade linearly up to the bar. */
const HIGH_NULL_FLOOR = 0.9;

/** Column names that conventionally mark a soft delete / archive flag. */
const SOFT_DELETE_COLUMN_PATTERN =
  /^(is[_-]?)?(soft[_-]?)?(deleted|removed|archived|voided|obsolete|recycled|trashed)([_-]?(at|on|flag|time|date))?$/i;

/**
 * Grade a NULL ratio onto the confidence scale. Returns 0 when the observation
 * is too weak to be worth showing, so the detector drops it.
 */
export function gradeHighNullColumn(nullRatio: number): number {
  if (!Number.isFinite(nullRatio)) return 0;
  if (nullRatio >= HIGH_NULL_SATURATION) return 95;
  if (nullRatio < HIGH_NULL_FLOOR) return 0;
  const span = HIGH_NULL_SATURATION - HIGH_NULL_FLOOR;
  const progress = (nullRatio - HIGH_NULL_FLOOR) / span;
  return Math.round(79 + progress * 16);
}

/**
 * Grade "this column holds one value" — stronger with more rows observed,
 * because a single value across a large table is a real structural fact.
 */
export function gradeConstantColumn(distinctCount: number, rowCount: number): number {
  if (!Number.isFinite(distinctCount) || distinctCount > 1) return 0;
  if (rowCount >= 200) return 90;
  if (rowCount >= MIN_ROWS_FOR_EVIDENCE) return 84;
  return 0;
}

/**
 * FNV-1a over the insight's identifying facts. A plain hash keeps the module
 * dependency-free and the digest reproducible across runs and platforms, which
 * is what dedupe and the cooldown window rely on.
 */
export function computeInsightDigest(parts: readonly string[]): string {
  const input = parts.join("\u0000");
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    // FNV prime, applied with shifts so the value stays inside 32 bits.
    hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** The dedupe key from the plan: one card per (kind, table, column). */
export function buildInsightId(kind: InsightKind, table: string, column?: string): string {
  return `${kind}:${table}:${column ?? "*"}`;
}

/** Facts a detector needs, assembled from one trace step. */
interface InsightSource {
  table: string;
  executedSql: string;
  rowCount: number;
}

/**
 * A detector turns one observation into zero or more insights. Detectors are
 * pure: same source in, same insights out.
 */
type InsightDetector = (source: InsightSource, stats: AgentColumnStats) => AgentInsight | null;

function build(options: {
  kind: InsightKind;
  source: InsightSource;
  column?: string;
  title: string;
  detail: string;
  confidence: number;
  suggestedAction: InsightSuggestedAction;
}): AgentInsight {
  const { kind, source, column, title, detail, confidence, suggestedAction } = options;
  return {
    id: buildInsightId(kind, source.table, column),
    kind,
    table: source.table,
    ...(column ? { column } : {}),
    title,
    detail,
    evidence: {
      executedSql: source.executedSql,
      rowCount: source.rowCount,
      digest: computeInsightDigest([kind, source.table, column ?? "", source.executedSql]),
    },
    confidence,
    suggestedAction,
  };
}

/**
 * A column that is 100 % NULL is dead weight: it costs a filter slot in every
 * query written against it and returns nothing. High confidence because the
 * evidence is an exact count, not an inference.
 */
const detectHighNullColumn: InsightDetector = (source, stats) => {
  const confidence = gradeHighNullColumn(stats.nullRatio);
  if (confidence === 0) return null;
  if (softDeleteColumnPatternMatches(stats.column)) return null;
  const percent = Math.round(stats.nullRatio * 1000) / 10;
  return build({
    kind: "high-null-column",
    source,
    column: stats.column,
    title: `${source.table}.${stats.column} is never populated`,
    detail:
      `${percent}% of the ${source.rowCount} rows this query saw are NULL, ` +
      `with only ${stats.distinctCount} distinct value(s). Any predicate on this ` +
      `column currently filters nothing.`,
    confidence,
    suggestedAction: {
      label: "Count real values",
      prefill: `SELECT COUNT(*) AS total, COUNT(${stats.column}) AS populated FROM ${source.table};`,
      danger: false,
    },
  });
};

/**
 * A name that follows the soft-delete convention while the column is
 * effectively always NULL means the soft-delete filter is dead code — the
 * query pays for it on every read and never excludes a row.
 */
function softDeleteColumnPatternMatches(column: string): boolean {
  return SOFT_DELETE_COLUMN_PATTERN.test(column.trim());
}

const detectSoftDeleteCandidate: InsightDetector = (source, stats) => {
  if (!softDeleteColumnPatternMatches(stats.column)) return null;
  const confidence = gradeSoftDeleteCandidate(stats.nullRatio, source.rowCount);
  if (confidence === 0) return null;
  const percent = Math.round(stats.nullRatio * 1000) / 10;
  return build({
    kind: "soft-delete-candidate",
    source,
    column: stats.column,
    title: `${source.table}.${stats.column} looks like a soft-delete flag that never fires`,
    detail:
      `${percent}% of the ${source.rowCount} rows seen are NULL. If this column is ` +
      `a soft delete, every \`${stats.column} IS NULL\` filter in hot queries is ` +
      `dead weight; confirm with the owner before removing it.`,
    confidence,
    suggestedAction: {
      label: "Check the flag",
      prefill:
        `SELECT COUNT(*) AS total, ` +
        `SUM(CASE WHEN ${stats.column} IS NULL THEN 1 ELSE 0 END) AS unset ` +
        `FROM ${source.table};`,
      danger: false,
    },
  });
};

/**
 * A column with a single distinct value across a large table is usually a
 * missed default, an abandoned feature flag, or a migration that never
 * finished — all worth a look, none of them destructive to investigate.
 */
const detectConstantColumn: InsightDetector = (source, stats) => {
  const confidence = gradeConstantColumn(stats.distinctCount, source.rowCount);
  if (confidence === 0) return null;
  return build({
    kind: "constant-column",
    source,
    column: stats.column,
    title: `${source.table}.${stats.column} holds a single value`,
    detail:
      `${source.rowCount} rows were observed with ${stats.distinctCount} distinct ` +
      `value(s) in this column. Grouping, filtering or indexing on it cannot ` +
      `narrow a result set today.`,
    confidence,
    suggestedAction: {
      label: "Show the value",
      prefill: `SELECT ${stats.column}, COUNT(*) FROM ${source.table} GROUP BY ${stats.column};`,
      danger: false,
    },
  });
};

/**
 * Detector registry. Order is presentation order for equally-confident cards;
 * `note_insight` accumulates matches in this order so ties break predictably.
 */
export const INSIGHT_DETECTORS: readonly InsightDetector[] = [
  detectSoftDeleteCandidate,
  detectHighNullColumn,
  detectConstantColumn,
];

// ---------------------------------------------------------------------------
// Run-end collector
// ---------------------------------------------------------------------------
//
// A pure loop over the trace: no model callback, no I/O, so an insight costs
// zero extra model calls. This is the pass's entire justification.
//
// A card is emitted only from evidence — the statement a step ran and the rows
// that statement saw (`insightEvidence` on the facts footer). A step with
// column stats but no executed statement is skipped rather than dressed up: the
// one rule that makes the engine trustworthy is that every card traces back to
// a query, and it is enforced here rather than asked of the model.
//
// Which steps can fund a card is a deliberate consequence of that rule:
// `run_readonly_sql` / `run_parameterized_sql` record the SQL they were handed,
// and `sample_table_data` records evidence only when it ran the whole-table
// aggregate. The sample path itself is driver-side pagination with no SQL text
// in the frontend, so it reports no evidence and funds nothing.

/**
 * Collect the findings a finished run has proven, strongest first.
 *
 * Synchronous and pure by construction: it reads the trace it is given and
 * returns cards. Detectors decide what is provable; this pass enforces only the
 * shared policy — evidence required, the confidence bar, one card per
 * `(kind, table, column)`, and a hard per-run cap.
 */
export function collectRunEndInsights(steps: readonly AgentTraceStep[]): AgentInsight[] {
  const byId = new Map<string, AgentInsight>();
  for (const step of steps) {
    const facts = readStepFacts(step);
    const evidence = facts?.insightEvidence;
    if (!facts || !evidence) continue;
    // Too few rows and the numbers do not support a conclusion, however
    // saturated they look (the same floor the graders use).
    if (!Number.isFinite(evidence.rowCount) || evidence.rowCount < MIN_ROWS_FOR_EVIDENCE) continue;
    const table = facts.tables?.find((name) => typeof name === "string" && name.trim())?.trim();
    if (!table) continue;
    const source: InsightSource = {
      table,
      executedSql: evidence.executedSql,
      rowCount: evidence.rowCount,
    };
    for (const stats of facts.columnStats ?? []) {
      for (const detector of INSIGHT_DETECTORS) {
        const insight = detector(source, stats);
        if (!insight || insight.confidence < INSIGHT_MIN_CONFIDENCE) continue;
        const previous = byId.get(insight.id);
        // The same finding proven twice in one run: keep the stronger proof.
        if (!previous || insight.confidence > previous.confidence) byId.set(insight.id, insight);
      }
    }
  }
  return [...byId.values()]
    .sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id))
    .slice(0, INSIGHT_MAX_PER_RUN);
}

/**
 * Fold a run's findings into what is already stored: one card per key, nothing
 * resurfacing inside the cooldown window, newest first, bounded in size.
 *
 * The caller supplies `keyOf` because an insight id is only unique *within the
 * database it was proved on* — two databases both having a `users.deleted_at`
 * is normal, and they are two different findings.
 *
 * The cooldown is what keeps a recurring check from nagging about the same
 * column on every run — a finding the user has seen is not news again tomorrow.
 * Fresher evidence replaces the card once the window has lapsed.
 */
export function mergeInsightCards<T extends AgentInsight>(
  stored: readonly T[],
  incoming: readonly T[],
  options: { now: number; keyOf: (insight: T) => string },
): T[] {
  const { now, keyOf } = options;
  const byKey = new Map(stored.map((insight) => [keyOf(insight), insight]));
  for (const insight of incoming) {
    const key = keyOf(insight);
    const existing = byKey.get(key);
    if (existing && now - (existing.seenAt ?? 0) < INSIGHT_COOLDOWN_MILLIS) continue;
    byKey.set(key, { ...insight, seenAt: now });
  }
  return [...byKey.values()]
    .sort((a, b) => (b.seenAt ?? 0) - (a.seenAt ?? 0) || b.confidence - a.confidence)
    .slice(0, INSIGHT_MAX_STORED);
}

/**
 * Grade a soft-delete candidate: the name has to match the convention *and* the
 * column has to look abandoned before this is worth raising.
 */
export function gradeSoftDeleteCandidate(nullRatio: number, rowCount: number): number {
  if (rowCount < MIN_ROWS_FOR_EVIDENCE) return 0;
  if (!Number.isFinite(nullRatio) || nullRatio < HIGH_NULL_FLOOR) return 0;
  return 86;
}
