import { readStepFacts, type AgentStepFacts, type AgentTraceStep } from "./ai-agent-context";

/**
 * Claim verification: the agent must not cite figures that no tool ever
 * observed. This module extracts numbers from a draft final answer, collects
 * the numbers the trace actually witnessed, and reports unsupported claims.
 *
 * Witnessed numbers come from TWO sources (audit follow-up): the structured
 * `step.facts` the harness already attaches to every tool step (primary — no
 * parsing, and it carries fields the text regex never sees, like columnStats
 * distinct counts), and a conservative regex fallback over the observation
 * text for legacy steps that predate the facts footer.
 *
 * Claim extraction is deliberately conservative: numbers inside code spans or
 * SQL fences are not prose claims, dates and version strings are not
 * statistics, thousands/decimal separators are ambiguous across locales, and
 * rounding means a claimed figure rarely matches a witnessed value exactly.
 */

const NUMBER_PATTERN = /\b\d{1,3}(?:[.,\s]\d{3})+(?:[.,]\d+)?\b|\d+(?:[.,]\d+)?/g;
/** Numbers below this threshold are usually ordinals/ids ("3 notes") not statistics. */
const SIGNIFICANT_NUMBER_FLOOR = 5;
/** One stray number is tolerable; two or more trigger the verification round. */
export const VERIFICATION_UNSUPPORTED_LIMIT = 2;
/** Claimed figures may differ from witnessed ones by rounding this much. */
const RELATIVE_TOLERANCE = 0.005;
/** Small counts are commonly rounded to the nearest unit or ten. */
const SMALL_ABSOLUTE_TOLERANCE = 1;
const SMALL_ABSOLUTE_TOLERANCE_CEILING = 100;

/** Fenced blocks and inline code: their numbers are code, not claims. */
const CODE_SPAN_PATTERN = /```[\s\S]*?```|`[^`\n]*`/g;
/** ISO dates, slash dates, and times — never statistics. */
const DATE_TIME_TOKEN_PATTERN = /\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b\d{1,2}:\d{2}(?::\d{2})?\b/g;
/** Version-ish tokens (1.2.3, v2.11.4) — identifiers, not statistics. */
const VERSION_TOKEN_PATTERN = /\bv?\d+(?:\.\d+){2,}\b/g;

export function normalizeClaimedNumber(raw: string): number | null {
  const stripped = raw.replace(/[.,\s]/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(stripped)) return null;
  const value = Number(stripped);
  return Number.isFinite(value) ? value : null;
}

/**
 * Separator-ambiguous groups read differently across locales: "1.234" is
 * 1234 in vi/de and 1.234 in en. Both readings are claimed candidates — being
 * generous here only risks missing a fabrication, never accusing one.
 */
function claimedNumberCandidates(raw: string): number[] {
  const primary = normalizeClaimedNumber(raw);
  if (primary === null) return [];
  const candidates = [primary];
  const ambiguous = raw.match(/^(\d{1,3})([.,])(\d{1,2})$/);
  if (ambiguous) {
    const alternate = Number(`${ambiguous[1]}${ambiguous[3]}`);
    if (Number.isFinite(alternate) && alternate !== primary) candidates.push(alternate);
  }
  return candidates;
}

/** Removes spans whose numbers are never prose claims (code, dates, versions). */
function stripNonClaimSpans(text: string): string {
  return text
    .replace(CODE_SPAN_PATTERN, " ")
    .replace(DATE_TIME_TOKEN_PATTERN, " ")
    .replace(VERSION_TOKEN_PATTERN, " ");
}

export function extractClaimedNumbers(text: string): number[] {
  const claimed: number[] = [];
  for (const match of stripNonClaimSpans(text).matchAll(NUMBER_PATTERN)) {
    for (const value of claimedNumberCandidates(match[0])) {
      if (value >= SIGNIFICANT_NUMBER_FLOOR) claimed.push(value);
    }
  }
  return claimed;
}

function collectObservationNumbers(observation: string, into: Set<number>) {
  // Structured counters the harness itself writes into observations.
  for (const match of observation.matchAll(
    /"(?:rowCount|affectedRows|rowsAffected|totalRows|count|value|sample|tablesScanned|tablesFailed|described|catalogTables|tableCount|limit|statementCount|step)"\s*:\s*(-?\d+(?:\.\d+)?)/g,
  )) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) into.add(value);
  }
  // Any other sampled numeric cell value also counts as witnessed data.
  // Being generous here only risks missing a fabrication, never accusing one.
  for (const match of observation.matchAll(/":\s*(-?\d{3,}(?:\.\d+)?)(?=[\s,}\n])/g)) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) into.add(value);
  }
}

/** Witnessed numbers from the harness's own structured facts (no text parsing). */
function collectFactsNumbers(facts: AgentStepFacts, into: Set<number>) {
  if (typeof facts.rowsReturned === "number" && Number.isFinite(facts.rowsReturned)) {
    into.add(facts.rowsReturned);
  }
  for (const stat of facts.columnStats ?? []) {
    if (Number.isFinite(stat.distinctCount)) into.add(stat.distinctCount);
    if (Number.isFinite(stat.nullRatio)) {
      into.add(stat.nullRatio);
      // Responses habitually restate ratios as percentages ("12% null") —
      // accept both readings of a witnessed ratio.
      into.add(stat.nullRatio * 100);
    }
  }
}

export function collectObservedNumbers(steps: AgentTraceStep[]): Set<number> {
  const observed = new Set<number>();
  for (const step of steps) {
    // Primary: the structured facts the executor attached to this step.
    const facts = readStepFacts(step);
    if (facts) collectFactsNumbers(facts, observed);
    // Fallback: legacy observations that carry numbers only as text.
    collectObservationNumbers(step.observation ?? "", observed);
    collectObservationNumbers(step.message ?? "", observed);
  }
  return observed;
}

/**
 * A claim counts as witnessed when an observed number matches it exactly, or
 * within rounding distance: ±1 for small counts, 0.5% for larger figures.
 */
function numberIsObserved(value: number, observed: Set<number>): boolean {
  if (observed.has(value)) return true;
  for (const candidate of observed) {
    const delta = Math.abs(candidate - value);
    if (value < SMALL_ABSOLUTE_TOLERANCE_CEILING || candidate < SMALL_ABSOLUTE_TOLERANCE_CEILING) {
      if (delta <= SMALL_ABSOLUTE_TOLERANCE) return true;
    }
    if (delta <= Math.abs(value) * RELATIVE_TOLERANCE) return true;
  }
  return false;
}

export interface AgentResponseVerification {
  ok: boolean;
  unsupported: number[];
}

export function verifyAgentResponseAgainstEvidence(
  response: string | undefined,
  steps: AgentTraceStep[],
): AgentResponseVerification {
  if (!response || !response.trim()) return { ok: true, unsupported: [] };

  const observed = collectObservedNumbers(steps);
  const unsupported = new Set<number>();
  for (const claimed of extractClaimedNumbers(response)) {
    if (numberIsObserved(claimed, observed)) continue;
    unsupported.add(claimed);
  }

  return {
    ok: unsupported.size < VERIFICATION_UNSUPPORTED_LIMIT,
    unsupported: [...unsupported].slice(0, 8),
  };
}
