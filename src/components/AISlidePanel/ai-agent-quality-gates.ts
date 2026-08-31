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
      && (step.action === "sample_table_data" || /"sandboxed"/.test(step.observation)),
  );
}

/** True when the response text contains a markdown table block. */
export function responseHasMarkdownTable(response: string | undefined): boolean {
  return typeof response === "string" && /\|[^\n]+\|\s*\n\|[ :-]+\|/.test(response);
}

/** Normalizes any thrown value into a human-readable failure reason. */
export function formatActionFailureReason(errorValue: unknown): string {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}

/** Bounded number of evidence-retry rounds before accepting the best answer. */
export const MAX_EVIDENCE_ROUNDS = 2;

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
}): EvidenceGateEvaluation {
  const { finalAction, steps, wantsReportTable } = params;
  const isFinish = finalAction.action === "finish";
  if (!isFinish) {
    return {
      isFinish,
      missingData: false,
      response: "",
      missingReportTable: false,
      falseSuccessClaim: false,
      verification: { ok: true, unsupported: [] } as ReturnType<typeof verifyAgentResponseAgainstEvidence>,
      composeOnly: false,
      needsMoreEvidence: false,
    };
  }
  const missingData = !finishHasSql(finalAction) && !hasExecutedReadStep(steps);
  const response =
    typeof finalAction.args?.response === "string" ? finalAction.args.response : "";
  const missingReportTable = wantsReportTable && !responseHasMarkdownTable(response);
  const verification = verifyAgentResponseAgainstEvidence(response, steps);
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
  return composeOnly
    ? "The evidence is already gathered. Finish now: args.response MUST contain ONE complete markdown table — | header | row, |---| separator, then data rows — summarizing the verified data, followed by at most three short notes."
    : lastChance
      ? "This is the final round. Run the one read that answers the request, or finish with the complete answer built from the evidence already gathered. Do not end with a promise."
      : !verification.ok
        ? `Your answer cites figures that no tool observation supports (e.g. ${verification.unsupported.slice(0, 4).join(", ")}). Either run the read that verifies them, or correct the answer to cite only observed figures.`
        : "Your previous finish returned no SQL and no executed query, but this request needs real workspace data. Either call sample_table_data, describe_tables, or run_readonly_sql now, or if that is genuinely impossible, finish again with a complete explanation instead of a promise.";
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
