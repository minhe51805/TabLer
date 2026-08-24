import type { AgentTraceStep } from "./ai-agent-context";

/**
 * Claim verification: the agent must not cite figures that no tool ever
 * observed. This module extracts numbers from a draft final answer, collects
 * the numbers the trace actually witnessed (rowCount/affectedRows/counts and
 * sampled cell values), and reports unsupported claims.
 */

const NUMBER_PATTERN = /\b\d{1,3}(?:[.,\s]\d{3})+(?:[.,]\d+)?\b|\d+(?:[.,]\d+)?/g;
/** Numbers below this threshold are usually ordinals/ids ("3 notes") not statistics. */
const SIGNIFICANT_NUMBER_FLOOR = 5;
/** One stray number is tolerable; two or more trigger the verification round. */
export const VERIFICATION_UNSUPPORTED_LIMIT = 2;

export function normalizeClaimedNumber(raw: string): number | null {
  const stripped = raw.replace(/[.,\s]/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(stripped)) return null;
  const value = Number(stripped);
  return Number.isFinite(value) ? value : null;
}

export function extractClaimedNumbers(text: string): number[] {
  const claimed: number[] = [];
  for (const match of text.matchAll(NUMBER_PATTERN)) {
    const value = normalizeClaimedNumber(match[0]);
    if (value !== null && value >= SIGNIFICANT_NUMBER_FLOOR) claimed.push(value);
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

export function collectObservedNumbers(steps: AgentTraceStep[]): Set<number> {
  const observed = new Set<number>();
  for (const step of steps) {
    collectObservationNumbers(step.observation ?? "", observed);
    collectObservationNumbers(step.message ?? "", observed);
  }
  return observed;
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
    if (observed.has(claimed)) continue;
    unsupported.add(claimed);
  }

  return {
    ok: unsupported.size < VERIFICATION_UNSUPPORTED_LIMIT,
    unsupported: [...unsupported].slice(0, 8),
  };
}
