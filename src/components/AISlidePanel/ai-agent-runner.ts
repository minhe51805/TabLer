import type { AgentTraceStep } from "./ai-agent-context";
import type {
  AIAgentFinishAction,
  AIAgentToolAction,
  AIAgentToolName,
} from "./ai-agent-tools";

export type AIAgentRunnerPhase =
  | "idle"
  | "requesting-action"
  | "running-tool"
  | "tool-completed"
  | "recovering-finish"
  | "finished"
  | "failed";

export type AIAgentActionRequestReason = "direct" | "iterate" | "budget";

export interface AIAgentActionRequest {
  forceFinish: boolean;
  includeHistory: boolean;
  iteration: number;
  reason: AIAgentActionRequestReason;
  steps: AgentTraceStep[];
}

export interface AIAgentRunnerSnapshot {
  phase: AIAgentRunnerPhase;
  iteration: number;
  stepBudget: number;
  /** Cumulative model tokens spent so far in this run (0 when untracked). */
  tokensUsed: number;
  requestReason?: AIAgentActionRequestReason;
  action?: AIAgentToolName;
  message?: string;
  error?: string;
  steps: AgentTraceStep[];
}

export interface AIAgentRunnerResult {
  finalAction: AIAgentFinishAction;
  steps: AgentTraceStep[];
  snapshots: AIAgentRunnerSnapshot[];
}

export interface RunAIAgentToolLoopOptions {
  workspaceToolsEnabled: boolean;
  stepBudget: number;
  /**
   * Optional cumulative token ceiling. When set (> 0), the loop stops
   * requesting new tools once spend reaches it and closes with a forced
   * budget finish. Independent from stepBudget: either limit can end the run.
   */
  tokenBudget?: number;
  /**
   * Reads the token cost of the most recent model call. Invoked once after
   * each action request; the runner accumulates the returned values. Omit to
   * disable token accounting (spend stays 0, matching legacy behavior).
   */
  getLastRequestTokens?: () => number;
  initialSteps?: AgentTraceStep[];
  requestAction: (request: AIAgentActionRequest) => Promise<AIAgentToolAction>;
  runTool: (action: AIAgentToolAction) => Promise<string>;
  recoverFinish: (reason: string) => Promise<AIAgentFinishAction>;
  onStateChange?: (snapshot: AIAgentRunnerSnapshot) => void;
}

const TOOL_BUDGET_EXHAUSTED_REASON =
  "The agent exhausted its tool budget without returning a final answer.";

/** Steps granted each time a productive run is extended past its budget. */
const EXTENSION_STEPS = 4;
/** Hard cap on extensions, so a chatty run can still never escape the guard. */
const MAX_STEP_EXTENSIONS = 2;

/** Loop-detection signature: same tool + same args counts as repeated work. */
function actionSignature(action: AIAgentToolAction): string {
  let argsText = "";
  try {
    argsText = JSON.stringify(action.args ?? {});
  } catch {
    argsText = "";
  }
  return `${action.action}:${argsText}`;
}

function cloneSteps(steps: AgentTraceStep[]) {
  return steps.map((step) => ({ ...step }));
}

function formatRunnerError(errorValue: unknown) {
  return errorValue instanceof Error ? errorValue.message : String(errorValue);
}

export async function runAIAgentToolLoop(
  options: RunAIAgentToolLoopOptions,
): Promise<AIAgentRunnerResult> {
  const stepBudget = Math.max(1, Math.floor(options.stepBudget));
  const tokenBudget = options.tokenBudget && options.tokenBudget > 0
    ? Math.floor(options.tokenBudget)
    : 0;
  let steps = cloneSteps(options.initialSteps || []);
  const snapshots: AIAgentRunnerSnapshot[] = [];
  let iteration = 0;
  let tokensUsed = 0;
  // Adaptive budget state: the base budget can grow in bounded extensions
  // while the run keeps doing new (non-repeating) work.
  let effectiveBudget = stepBudget;
  let extensionsUsed = 0;
  const signatureHistory: string[] = [];
  /** Productive = the recent window is not the same action+args on repeat. */
  const isRunProductive = () =>
    new Set(signatureHistory.slice(-EXTENSION_STEPS)).size >= 2;

  const emit = (
    phase: AIAgentRunnerPhase,
    details: Partial<Omit<AIAgentRunnerSnapshot, "phase" | "iteration" | "stepBudget" | "tokensUsed" | "steps">> = {},
  ) => {
    const snapshot: AIAgentRunnerSnapshot = {
      phase,
      iteration,
      stepBudget: effectiveBudget,
      tokensUsed,
      ...details,
      steps: cloneSteps(steps),
    };
    snapshots.push(snapshot);
    options.onStateChange?.(snapshot);
  };

  const requestAction = async (
    reason: AIAgentActionRequestReason,
    forceFinish: boolean,
    includeHistory: boolean,
  ) => {
    emit("requesting-action", { requestReason: reason });
    const action = await options.requestAction({
      forceFinish,
      includeHistory,
      iteration,
      reason,
      steps: cloneSteps(steps),
    });
    if (options.getLastRequestTokens) {
      const spent = options.getLastRequestTokens();
      if (typeof spent === "number" && Number.isFinite(spent) && spent > 0) {
        tokensUsed += Math.floor(spent);
      }
    }
    return action;
  };

  const tokenBudgetExhausted = () => tokenBudget > 0 && tokensUsed >= tokenBudget;

  emit("idle");

  try {
    let finalAction: AIAgentToolAction | null = null;

    if (!options.workspaceToolsEnabled) {
      finalAction = await requestAction("direct", true, true);
    } else {
      for (iteration = 1; ; iteration += 1) {
        const overStepBudget = iteration > effectiveBudget;
        if (overStepBudget && !tokenBudgetExhausted()) {
          // Adaptive extension: a run still doing new, non-repeating work gets
          // bounded extra steps instead of being cut off mid-investigation.
          if (extensionsUsed < MAX_STEP_EXTENSIONS && isRunProductive()) {
            extensionsUsed += 1;
            effectiveBudget = iteration + EXTENSION_STEPS - 1;
          } else {
            break; // close through the forced budget finish below
          }
        }

        const action = await requestAction(
          "iterate",
          iteration >= effectiveBudget || tokenBudgetExhausted(),
          iteration === 1,
        );

        if (action.action === "finish") {
          finalAction = action;
          break;
        }

        emit("running-tool", {
          action: action.action,
          message: action.message || "No message provided.",
        });
        const observation = await options.runTool(action);
        steps = [
          ...steps,
          {
            step: steps.length + 1,
            action: action.action,
            message: action.message || "No message provided.",
            observation,
          },
        ];
        signatureHistory.push(actionSignature(action));
        emit("tool-completed", {
          action: action.action,
          message: action.message || "No message provided.",
        });

        // A token ceiling ends the tool phase early even with steps to spare,
        // so a run can never keep spending after the budget is reached.
        if (tokenBudgetExhausted()) {
          break;
        }
      }

      if (!finalAction) {
        iteration = effectiveBudget + 1;
        finalAction = await requestAction("budget", true, false);
      }
    }

    if (finalAction.action !== "finish") {
      emit("recovering-finish", {
        action: finalAction.action,
        message: TOOL_BUDGET_EXHAUSTED_REASON,
      });
      finalAction = await options.recoverFinish(TOOL_BUDGET_EXHAUSTED_REASON);
    }

    if (finalAction.action !== "finish") {
      throw new Error("Agent finish recovery returned another tool action.");
    }

    emit("finished", {
      action: finalAction.action,
      message: finalAction.message,
    });

    return {
      finalAction,
      steps: cloneSteps(steps),
      snapshots,
    };
  } catch (errorValue) {
    emit("failed", { error: formatRunnerError(errorValue) });
    throw errorValue;
  }
}
