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
      (step.action === "run_readonly_sql" || step.action === "sample_table_data")
      && Boolean(step.observation)
      && !step.observation.startsWith("Tool error")
      && !step.observation.startsWith("Tool blocked"),
  );
}

/** True when a finish action carries a non-empty SQL string argument. */
export function finishHasSql(action: AIAgentFinishAction): boolean {
  return typeof action.args?.sql === "string" && Boolean(action.args.sql.trim());
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
  const needsMoreEvidence = missingData || missingReportTable || !verification.ok;
  return {
    isFinish,
    missingData,
    response,
    missingReportTable,
    verification,
    composeOnly: !missingData && verification.ok,
    needsMoreEvidence,
  };
}

/** Composes the controller instruction for an evidence-recovery round. */
export function buildAgentRecoveryInstruction(params: {
  lastChance: boolean;
  composeOnly: boolean;
  verification: ReturnType<typeof verifyAgentResponseAgainstEvidence>;
}): string {
  const { lastChance, composeOnly, verification } = params;
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
