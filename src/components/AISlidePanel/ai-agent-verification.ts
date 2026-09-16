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

/**
 * Identifier (table/column name) verification — the companion to number
 * verification. The model must not cite a table or column that neither the
 * live schema nor any tool observation ever mentioned. Extraction is
 * deliberately narrow (backticked names and dotted `table.column` references)
 * so ordinary prose never trips the gate, matching the conservative stance of
 * the numeric checks: being generous only risks missing a fabrication, never
 * accusing a real name.
 */

/** One stray identifier is tolerable; two or more trigger a verification round. */
export const IDENTIFIER_UNSUPPORTED_LIMIT = 2;
/** A "did you mean" hint only fires when a real name is at most this far. */
const IDENTIFIER_SUGGESTION_MAX_DISTANCE = 2;
/** Identifiers shorter than this are too generic to verify safely. */
const IDENTIFIER_MIN_LENGTH = 3;

/** Backticked or quoted identifiers: `orders`, "user_id", `public.users`. */
const BACKTICKED_IDENTIFIER_PATTERN = /[`"']([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)[`"']/g;
/** Dotted references in prose: orders.total, public.users. */
const DOTTED_IDENTIFIER_PATTERN = /\b[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*\b/g;
/** Structured name fields the harness writes into observations. */
const OBSERVATION_NAME_FIELD_PATTERN = /"(?:name|column|table|identifier|columnName|colName)"\s*:\s*"([^"\n]+)"/g;
/** `col:type` tokens from the schema capsule and describe_table output. */
const OBSERVATION_COLUMN_TOKEN_PATTERN = /\b([A-Za-z_][A-Za-z0-9_]*)\s*:\s*[A-Za-z]/g;

export function normalizeIdentifier(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[`"'[\]]/g, "")
    .trim();
}

/** A dotted `a.b` reference yields both the qualifier and the leaf name. */
function identifierSegments(raw: string): string[] {
  return normalizeIdentifier(raw)
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function addObservedIdentifier(into: Set<string>, raw: string) {
  for (const segment of identifierSegments(raw)) {
    if (segment.length >= IDENTIFIER_MIN_LENGTH) into.add(segment);
  }
}

/**
 * Identifiers the trace actually witnessed: the structured facts the executor
 * attaches (table names, column-stats columns) plus a generous regex sweep of
 * observation text (JSON name fields, backticked names, `col:type` tokens).
 * Generosity here only widens the allow-list, so it can never accuse a name.
 */
export function collectObservedIdentifiers(steps: AgentTraceStep[]): Set<string> {
  const observed = new Set<string>();
  for (const step of steps) {
    const facts = readStepFacts(step);
    if (facts) {
      for (const table of facts.tables ?? []) addObservedIdentifier(observed, table);
      for (const stat of facts.columnStats ?? []) addObservedIdentifier(observed, stat.column);
    }
    const text = `${step.observation ?? ""}\n${step.message ?? ""}`;
    for (const pattern of [
      OBSERVATION_NAME_FIELD_PATTERN,
      BACKTICKED_IDENTIFIER_PATTERN,
      OBSERVATION_COLUMN_TOKEN_PATTERN,
    ]) {
      for (const match of text.matchAll(pattern)) addObservedIdentifier(observed, match[1]);
    }
  }
  return observed;
}

/** Narrowly extracts the schema identifiers a draft answer cites as facts. */
export function extractClaimedIdentifiers(response: string): string[] {
  const claimed: string[] = [];
  for (const match of response.matchAll(BACKTICKED_IDENTIFIER_PATTERN)) claimed.push(match[1]);
  for (const match of response.matchAll(DOTTED_IDENTIFIER_PATTERN)) claimed.push(match[0]);
  return claimed;
}

/** Classic Levenshtein edit distance, used only for short identifiers. */
function editDistance(left: string, right: string): number {
  const rows = left.length + 1;
  const cols = right.length + 1;
  const distances = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let row = 0; row < rows; row += 1) distances[row][0] = row;
  for (let col = 0; col < cols; col += 1) distances[0][col] = col;
  for (let row = 1; row < rows; row += 1) {
    for (let col = 1; col < cols; col += 1) {
      const cost = left[row - 1] === right[col - 1] ? 0 : 1;
      distances[row][col] = Math.min(
        distances[row - 1][col] + 1,
        distances[row][col - 1] + 1,
        distances[row - 1][col - 1] + cost,
      );
    }
  }
  return distances[rows - 1][cols - 1];
}

/** Nearest allowed identifier within edit distance, for a "did you mean" hint. */
export function nearestKnownIdentifier(
  cited: string,
  candidates: Iterable<string>,
): string | undefined {
  const target = normalizeIdentifier(cited);
  if (target.length < IDENTIFIER_MIN_LENGTH) return undefined;
  const budget = Math.min(
    IDENTIFIER_SUGGESTION_MAX_DISTANCE,
    Math.max(1, Math.floor(target.length * 0.4)),
  );
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    if (candidate === target) return candidate;
    const distance = editDistance(target, candidate);
    if (distance > 0 && distance <= budget && distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

export interface UnsupportedIdentifier {
  cited: string;
  suggestion?: string;
}

export interface AgentResponseVerification {
  ok: boolean;
  unsupported: number[];
  unsupportedIdentifiers: UnsupportedIdentifier[];
}

export function verifyAgentResponseAgainstEvidence(
  response: string | undefined,
  steps: AgentTraceStep[],
  knownIdentifiers?: Iterable<string>,
): AgentResponseVerification {
  if (!response || !response.trim()) {
    return { ok: true, unsupported: [], unsupportedIdentifiers: [] };
  }

  const observed = collectObservedNumbers(steps);
  const unsupported = new Set<number>();
  for (const claimed of extractClaimedNumbers(response)) {
    if (numberIsObserved(claimed, observed)) continue;
    unsupported.add(claimed);
  }

  // Allow-list = names witnessed in the trace + the verified schema names the
  // caller supplies. A cited identifier absent from both is a likely
  // fabrication; the nearest allowed name (if close) becomes a repair hint.
  const allowedIdentifiers = collectObservedIdentifiers(steps);
  for (const known of knownIdentifiers ?? []) addObservedIdentifier(allowedIdentifiers, known);
  const unsupportedIdentifiers: UnsupportedIdentifier[] = [];
  const flagged = new Set<string>();
  for (const cited of extractClaimedIdentifiers(response)) {
    for (const segment of identifierSegments(cited)) {
      if (segment.length < IDENTIFIER_MIN_LENGTH) continue;
      if (allowedIdentifiers.has(segment)) continue;
      if (flagged.has(segment)) continue;
      flagged.add(segment);
      unsupportedIdentifiers.push({
        cited: segment,
        suggestion: nearestKnownIdentifier(segment, allowedIdentifiers),
      });
    }
  }

  return {
    ok:
      unsupported.size < VERIFICATION_UNSUPPORTED_LIMIT
      && unsupportedIdentifiers.length < IDENTIFIER_UNSUPPORTED_LIMIT,
    unsupported: [...unsupported].slice(0, 8),
    unsupportedIdentifiers: unsupportedIdentifiers.slice(0, 8),
  };
}
