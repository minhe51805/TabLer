import type { AssistIntent, AgentTraceStep } from "./ai-agent-context";
import { joinAgentInstructions } from "./ai-agent-context";
import { isWorkspaceScopedIntent } from "./ai-assist-intent";
import {
  buildAgentRecoveryInstruction,
  evaluateEvidenceGate,
  finishHasSql,
  MAX_EVIDENCE_ROUNDS,
} from "./ai-agent-quality-gates";
import type { AIAgentFinishAction, AIAgentToolAction } from "./ai-agent-tools";

/**
 * The bounded evidence-recovery loop for workspace agent runs.
 *
 * Extracted verbatim from use-ai-slide-panel: when a data-seeking finish
 * neither ran a read nor proposed SQL — or cites figures no observation
 * supports — this loop asks the controller for recovery rounds (max
 * MAX_EVIDENCE_ROUNDS), executes the requested tool, then demands a closing
 * finish. Superseded-request errors always propagate.
 */
export async function runAgentEvidenceLoop(params: {
  workspaceToolsEnabled: boolean;
  endedWithAskUser: boolean;
  assistIntent: AssistIntent;
  wantsReportTable: boolean;
  sharedAgentInstruction: string;
  initialAction: AIAgentFinishAction;
  initialSteps: AgentTraceStep[];
  requestAgentAction: (prompt: string, includeHistory: boolean) => Promise<AIAgentToolAction | AIAgentFinishAction>;
  buildControllerPrompt: (forceFinish: boolean, extraInstruction?: string, steps?: AgentTraceStep[]) => string;
  isSupersededAIRequestError: (errorValue: unknown) => boolean;
  runAgentTool: (action: AIAgentToolAction) => Promise<string>;
  publishAgentProgress: (pending?: { action: import("./ai-workspace-types").AIWorkspaceAgentActionName; message: string }) => void;
  recoverAgentFinishAction: (reason: string) => Promise<AIAgentFinishAction>;
}): Promise<{ finalAction: AIAgentFinishAction; finalSteps: AgentTraceStep[] }> {
  const {
    workspaceToolsEnabled,
    endedWithAskUser,
    assistIntent,
    wantsReportTable,
    sharedAgentInstruction,
    initialAction,
    initialSteps,
    requestAgentAction,
  buildControllerPrompt,
  isSupersededAIRequestError,
    runAgentTool,
    publishAgentProgress,
    recoverAgentFinishAction,
  } = params;

  let finalAction = initialAction;
  let finalSteps = initialSteps;

  const needsMoreEvidence = () =>
    evaluateEvidenceGate({ finalAction, steps: finalSteps, wantsReportTable }).needsMoreEvidence;

  let evidenceRoundsLeft = MAX_EVIDENCE_ROUNDS;

  while (
    workspaceToolsEnabled
    && !endedWithAskUser
    && evidenceRoundsLeft > 0
    && needsMoreEvidence()
    && isWorkspaceScopedIntent(assistIntent)
  ) {
    evidenceRoundsLeft -= 1;
    const lastChance = evidenceRoundsLeft === 0;
    const gateNow = evaluateEvidenceGate({ finalAction, steps: finalSteps, wantsReportTable });
    const composeOnly = gateNow.composeOnly;
    try {
      const recoveryInstruction = buildAgentRecoveryInstruction({
        lastChance,
        composeOnly,
        verification: gateNow.verification,
      });
      const recoveryAction = await requestAgentAction(
        buildControllerPrompt(
          lastChance || composeOnly,
          joinAgentInstructions(sharedAgentInstruction, recoveryInstruction),
          finalSteps,
        ),
        false,
      );
      if (recoveryAction.action === "finish") {
        if (finishHasSql(recoveryAction)) {
          finalAction = recoveryAction;
          break;
        }
        finalAction = recoveryAction;
        continue;
      }
      publishAgentProgress({
        action: recoveryAction.action,
        message: recoveryAction.message || "Gathering the missing data.",
      });
      const observation = await runAgentTool(recoveryAction);
      finalSteps = [
        ...finalSteps,
        {
          step: finalSteps.length + 1,
          action: recoveryAction.action,
          message: recoveryAction.message || "No message provided.",
          observation,
        },
      ];
      publishAgentProgress();
      const closingAction = await requestAgentAction(
        buildControllerPrompt(
          true,
          joinAgentInstructions(
            sharedAgentInstruction,
            "You now have fresh evidence. Finish now and summarize the actual results for the user.",
          ),
          finalSteps,
        ),
        false,
      );
      finalAction = closingAction.action === "finish"
        ? closingAction
        : await recoverAgentFinishAction("The agent could not conclude after its final data step.");
    } catch (errorValue) {
      if (isSupersededAIRequestError(errorValue)) throw errorValue;
      // The gate is best-effort; fall back to the current finish.
      break;
    }
  }

  return { finalAction, finalSteps };
}
