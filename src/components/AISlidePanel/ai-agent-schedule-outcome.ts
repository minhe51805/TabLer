/**
 * P10: how an unattended scheduled run describes itself back to the scheduler.
 *
 * The schedule row is the only durable record a scheduled agent task leaves, so
 * what gets written there has to be true:
 *
 *  * a resolved run is a completed run, and a thrown one is a failed run with
 *    the provider's own message — never a cheerful "ok" for work nobody did;
 *  * a refused write tool is *named* in the report, because a blocked step must
 *    not read as a step that succeeded;
 *  * every string is clamped to the same caps the Rust side enforces
 *    (`storage/schedule_storage.rs`), so one loud run cannot bloat the store.
 *
 * Kept pure and React-free (AISlidePanel rule: one file per concern) so the
 * report format is unit-testable on its own.
 */
import { isSupersededAIRequestError } from "./ai-agent-action-requestor";
import type { AIAgentToolName } from "./tool-schema/constants";

/** Mirrors `MAX_PERSISTED_SUMMARY_CHARS` in `storage/schedule_storage.rs`. */
export const MAX_AGENT_RUN_SUMMARY_CHARS = 400;
/** Mirrors `MAX_PERSISTED_ERROR_CHARS` in `storage/schedule_storage.rs`. */
export const MAX_AGENT_RUN_ERROR_CHARS = 500;
/** Tool names listed in one report before the rest are summarized as a count. */
export const MAX_REPORTED_BLOCKED_TOOLS = 6;

/** Collapses whitespace and truncates on a char boundary, like the Rust cap. */
export function clampReportText(text: string, maxChars: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

/**
 * The line naming the tools an unattended run reached for and was refused.
 * `null` when it never tried one — the common, compliant case.
 */
export function formatBlockedToolNote(
  tools: readonly AIAgentToolName[] | undefined,
): string | null {
  // Sorted so the same set of refusals always reads the same way, whichever
  // order the executor's trace happened to record them in.
  const unique = [...new Set(tools ?? [])].sort();
  if (unique.length === 0) return null;
  const listed = unique.slice(0, MAX_REPORTED_BLOCKED_TOOLS).join(", ");
  const remaining = unique.length - MAX_REPORTED_BLOCKED_TOOLS;
  const suffix = remaining > 0 ? ` (+${remaining} more)` : "";
  return `[read-only] refused ${unique.length} blocked tool call(s): ${listed}${suffix}`;
}

/**
 * The report persisted for a finished unattended run: the note first (so a tight
 * cap can never hide that a write was attempted), then the run's own findings.
 */
export function buildAgentRunSummary(params: {
  response: string;
  blockedTools?: readonly AIAgentToolName[];
}): string {
  const note = formatBlockedToolNote(params.blockedTools);
  const body = clampReportText(params.response, MAX_AGENT_RUN_SUMMARY_CHARS);
  if (note && body) return clampReportText(`${note} — ${body}`, MAX_AGENT_RUN_SUMMARY_CHARS);
  return note ?? body;
}

/**
 * The outcome a finished unattended run reports: the status its row records and
 * the report that goes with it.
 */
export interface FinishedAgentRunReport {
  /**
   * `needs_human` when the run reached for a tool it may not use — it stopped
   * short of something, so it is never `ok`; a person decides the rest.
   */
  status: "ok" | "needs_human";
  summary: string | null;
}

/**
 * Maps a run that finished (did not throw) onto its outcome. Kept pure and
 * shared so the mapping is unit-tested instead of living inside a React hook.
 */
export function describeFinishedAgentRun(params: {
  response: string;
  blockedTools?: readonly AIAgentToolName[];
}): FinishedAgentRunReport {
  const blockedTools = [...new Set(params.blockedTools ?? [])];
  const summary = buildAgentRunSummary({
    response: params.response,
    blockedTools,
  });
  return {
    status: blockedTools.length > 0 ? "needs_human" : "ok",
    summary: summary || null,
  };
}

/**
 * The error persisted for a run that threw. A superseded run is explained as
 * such instead of being reported as a provider failure, so the row says what
 * actually happened.
 */
export function describeAgentRunFailure(error: unknown): string {
  if (isSupersededAIRequestError(error)) {
    return clampReportText(
      "The run was replaced by another request in this workspace before it finished, so it produced no report.",
      MAX_AGENT_RUN_ERROR_CHARS,
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return clampReportText(
    message.trim() || "The scheduled agent task failed without an error message.",
    MAX_AGENT_RUN_ERROR_CHARS,
  );
}
