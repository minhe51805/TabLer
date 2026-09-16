import type { AIAgentActionRequestReason } from "./ai-agent-runner";
import type { AIAgentFinishAction } from "./ai-agent-tools";
import type { AgentTraceStep } from "./ai-agent-context";
import { joinAgentInstructions } from "./ai-agent-context";
import { verifyAgentResponseAgainstEvidence } from "./ai-agent-verification";

/**
 * Pure quality gates used by the agent evidence loop.
 * Extracted from use-ai-slide-panel so they can be unit-tested in isolation.
 */

/** True when at least one executed read produced a real (non-error) observation. */
export function hasExecutedReadStep(steps: AgentTraceStep[]): boolean {
  return steps.some(
    (step) =>
      (step.action === "run_readonly_sql"
        || step.action === "run_parameterized_sql"
        || step.action === "find_value"
        || step.action === "sample_table_data")
      && Boolean(step.observation)
      && !step.observation.startsWith("Tool error")
      && !step.observation.startsWith("Tool blocked"),
  );
}

/** True when a finish action carries a non-empty SQL string argument. */
export function finishHasSql(action: AIAgentFinishAction): boolean {
  return typeof action.args?.sql === "string" && Boolean(action.args.sql.trim());
}

import { readStepFacts } from "./ai-agent-context";

/**
 * Matches claims that a query/sandbox run executed successfully (covering the
 * UI languages). Used to catch finishes that celebrate a run which actually
 * failed — the trace, not the model, is the source of truth.
 */
const SUCCESS_CLAIM_PATTERN =
  /(?:successfully\s+(?:ran|executed)|ran\s+successfully|executed\s+successfully|(?:query|sql|sandbox)\s+(?:ran|executed|works?)\s+(?:fine|ok|correctly|well)|th\u1ef1c\s*thi\s*(?:th\u00e0nh\s*c\u00f4ng|\u0111\u00fang|\u1ed5n)|\u0111\u00fang\s*th\u1ef1c\s*thi|ch\u1ea1y\s*(?:th\u00e0nh\s*c\u00f4ng|\u0111\u00fang|\u1ed5n)|\u0111\u00e3\s*ch\u1ea1y\s*(?:th\u00e0nh\s*c\u00f4ng|\u0111\u00fang)|沙箱?运行成功|执行成功|성공적으로\s*실행|başarıyla\s*(?:çalıştır|çalış|gerçekleştir|uygula)|başarılı\s*(?:şekilde\s*)?(?:çalıştır|çalış|gerçekleştir|uygula)\w*|sorgu\s*başarılı|başarıyla\s*tamamlandı)/i;

/** True when the response asserts a successful execution. */
export function responseClaimsSuccessfulExecution(response: string | undefined): boolean {
  return typeof response === "string" && SUCCESS_CLAIM_PATTERN.test(response);
}

/** True when at least one read observation proves a real, error-free run. */
export function hasSuccessfulReadStep(steps: AgentTraceStep[]): boolean {
  return steps.some(
    (step) =>
      (step.action === "run_readonly_sql"
        || step.action === "run_parameterized_sql"
        || step.action === "find_value"
        || step.action === "sample_table_data")
      && Boolean(step.observation)
      && !step.observation.startsWith("Tool error")
      && !step.observation.startsWith("Tool blocked")
      && hasSuccessfulReadEvidence(step),
  );
}

/**
 * Structured-facts-first evidence check (roadmap #7): when the executor
 * embedded facts, they are the source of truth (rows actually returned);
 * older traces without facts fall back to the legacy observation regex.
 */
function hasSuccessfulReadEvidence(step: AgentTraceStep): boolean {
  const facts = readStepFacts(step);
  if (facts && facts.rowsReturned !== undefined) {
    return facts.rowsReturned > 0;
  }
  return step.action === "sample_table_data" || /"sandboxed"/.test(step.observation);
}

/** True when the response text contains a markdown table block. */
export function responseHasMarkdownTable(response: string | undefined): boolean {
  return typeof response === "string" && /\|[^\n]+\|\s*\n\|[ :-]+\|/.test(response);
}

/** Normalizes any thrown value into a human-readable failure reason. */
export function formatActionFailureReason(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}

/** Default bounded number of evidence-retry rounds before accepting the best answer. */
export const MAX_EVIDENCE_ROUNDS = 2;
/**
 * Hard ceiling on evidence rounds for complex requests. Reports, dashboards and
 * overviews synthesize multiple reads, so they earn one extra self-correction
 * round — but never more, so a stubborn run still cannot loop forever.
 */
export const MAX_EVIDENCE_ROUNDS_CEILING = 3;

/**
 * Adaptive round budget: simple asks get the conservative default; complex,
 * synthesis-heavy asks (a report/dashboard, or an overview intent) get one more
 * round to gather and self-check evidence. Always clamped to
 * [1, MAX_EVIDENCE_ROUNDS_CEILING] so the loop stays bounded.
 */
export function resolveEvidenceRounds(params: {
  assistIntent: string;
  wantsReportTable: boolean;
}): number {
  const isComplex = params.wantsReportTable || params.assistIntent === "overview";
  const rounds = isComplex ? MAX_EVIDENCE_ROUNDS_CEILING : MAX_EVIDENCE_ROUNDS;
  return Math.max(1, Math.min(rounds, MAX_EVIDENCE_ROUNDS_CEILING));
}

/**
 * A short self-critique checklist appended to recovery instructions: before
 * accepting a finish, the model must re-read its own answer against the trace
 * and correct anything the evidence does not support. This turns the recovery
 * round from "gather more" into a genuine self-review pass.
 */
export const SELF_CRITIQUE_CHECKLIST =
  "Before you finish, critique your own draft against the tool observations: (1) every figure, table and column name you cite must appear in a real observation above — remove or correct anything that does not; (2) do not claim any run, write or UI effect the trace does not confirm; (3) if a claim cannot be backed by evidence, drop it or gather the evidence first.";

export interface EvidenceGateEvaluation {
  isFinish: boolean;
  missingData: boolean;
  response: string;
  missingReportTable: boolean;
  falseSuccessClaim: boolean;
  verification: ReturnType<typeof verifyAgentResponseAgainstEvidence>;
  composeOnly: boolean;
  needsMoreEvidence: boolean;
}

/**
 * Full evaluation of whether an agent finish needs another evidence round.
 * Pure: identical inputs always yield the identical verdict.
 */
export function evaluateEvidenceGate(params: {
  finalAction: AIAgentFinishAction;
  steps: AgentTraceStep[];
  wantsReportTable: boolean;
  /**
   * Verified live-schema names (e.g. availableSchemaTables), allow-listed
   * alongside trace-witnessed names so a real table the run never happened to
   * touch is never mistaken for a fabrication.
   */
  knownIdentifiers?: Iterable<string>;
}): EvidenceGateEvaluation {
  const { finalAction, steps, wantsReportTable, knownIdentifiers } = params;
  const isFinish = finalAction.action === "finish";
  if (!isFinish) {
    return {
      isFinish,
      missingData: false,
      response: "",
      missingReportTable: false,
      falseSuccessClaim: false,
      verification: { ok: true, unsupported: [], unsupportedIdentifiers: [] } as ReturnType<typeof verifyAgentResponseAgainstEvidence>,
      composeOnly: false,
      needsMoreEvidence: false,
    };
  }
  const missingData = !finishHasSql(finalAction) && !hasExecutedReadStep(steps);
  const response =
    typeof finalAction.args?.response === "string" ? finalAction.args.response : "";
  const missingReportTable = wantsReportTable && !responseHasMarkdownTable(response);
  const verification = verifyAgentResponseAgainstEvidence(response, steps, knownIdentifiers);
  const falseSuccessClaim = responseClaimsSuccessfulExecution(response) && !hasSuccessfulReadStep(steps);
  const needsMoreEvidence = missingData || missingReportTable || falseSuccessClaim || !verification.ok;
  return {
    isFinish,
    missingData,
    response,
    missingReportTable,
    falseSuccessClaim,
    verification,
    composeOnly: !missingData && !falseSuccessClaim && verification.ok,
    needsMoreEvidence,
  };
}

/**
 * Recovery text for a finish blocked by unsupported claims. Two independent
 * kinds of fabrication can trigger it — figures no observation witnessed and
 * table/column names absent from both the schema and the trace — so the
 * instruction names whichever applies (or both). Each fabricated identifier
 * carries a "did you mean <nearest real name>?" hint when a close match exists,
 * turning the block into an actionable correction rather than a vague warning.
 */
export function buildUnsupportedEvidenceInstruction(
  verification: ReturnType<typeof verifyAgentResponseAgainstEvidence>,
): string {
  const parts: string[] = [];
  if (verification.unsupported.length > 0) {
    parts.push(
      `Your answer cites figures that no tool observation supports (e.g. ${verification.unsupported
        .slice(0, 4)
        .join(", ")}).`,
    );
  }
  if (verification.unsupportedIdentifiers.length > 0) {
    const named = verification.unsupportedIdentifiers
      .slice(0, 4)
      .map((item) => (item.suggestion ? `${item.cited} (did you mean ${item.suggestion}?)` : item.cited))
      .join(", ");
    parts.push(
      `Your answer cites table/column names absent from both the workspace schema and every tool observation: ${named}.`,
    );
  }
  parts.push(
    "Either run the read that verifies them, or correct the answer to cite only names and figures the tools actually observed.",
  );
  return parts.join(" ");
}

/** Composes the controller instruction for an evidence-recovery round. */
export function buildAgentRecoveryInstruction(params: {
  lastChance: boolean;
  composeOnly: boolean;
  falseSuccessClaim?: boolean;
  verification: ReturnType<typeof verifyAgentResponseAgainstEvidence>;
}): string {
  const { lastChance, composeOnly, falseSuccessClaim, verification } = params;
  if (falseSuccessClaim) {
    return [
      "Your previous answer claimed the query/sandbox ran successfully, but the trace shows the run FAILED (see the Tool error steps).",
      "Never report success for a failed execution.",
      "Read the actual error, fix the cause (for column errors: re-check describe_table output and use only verified column names; for row counts use list_tables rowCount), re-run a read (sample_table_data, or run_readonly_sql on SQL engines), then finish with the truthful result.",
    ].join(" ");
  }
  if (composeOnly) {
    return "The evidence is already gathered. Finish now: args.response MUST contain ONE complete markdown table — | header | row, |---| separator, then data rows — summarizing the verified data, followed by at most three short notes.";
  }
  // Every remaining recovery branch closes with a self-critique pass so the
  // model re-reads its own draft against the trace before finishing.
  const base = lastChance
    ? "This is the final round. Run the one read that answers the request, or finish with the complete answer built from the evidence already gathered. Do not end with a promise."
    : !verification.ok
      ? buildUnsupportedEvidenceInstruction(verification)
      : "Your previous finish returned no SQL and no executed query, but this request needs real workspace data. Either call sample_table_data, describe_table, or run_readonly_sql now, or if that is genuinely impossible, finish again with a complete explanation instead of a promise.";
  return joinAgentInstructions(base, SELF_CRITIQUE_CHECKLIST);
}

/** Wraps the shared agent instruction for a specific action-request reason. */
export function buildRunnerInstructionForReason(
  reason: AIAgentActionRequestReason,
  sharedAgentInstruction: string,
): string {
  if (reason === "direct") {
    return joinAgentInstructions(
      sharedAgentInstruction,
      "Respond as a general-purpose assistant unless the user explicitly needs current workspace evidence.",
    );
  }
  if (reason === "budget") {
    return joinAgentInstructions(
      sharedAgentInstruction,
      "You have reached the tool budget. Finish with the best grounded answer you can.",
    );
  }
  return sharedAgentInstruction;
}
