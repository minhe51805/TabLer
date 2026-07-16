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
  initialSteps?: AgentTraceStep[];
  requestAction: (request: AIAgentActionRequest) => Promise<AIAgentToolAction>;
  runTool: (action: AIAgentToolAction) => Promise<string>;
  recoverFinish: (reason: string) => Promise<AIAgentFinishAction>;
  onStateChange?: (snapshot: AIAgentRunnerSnapshot) => void;
}

const TOOL_BUDGET_EXHAUSTED_REASON =
  "The agent exhausted its tool budget without returning a final answer.";

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
  let steps = cloneSteps(options.initialSteps || []);
  const snapshots: AIAgentRunnerSnapshot[] = [];
  let iteration = 0;

  const emit = (
    phase: AIAgentRunnerPhase,
    details: Partial<Omit<AIAgentRunnerSnapshot, "phase" | "iteration" | "stepBudget" | "steps">> = {},
  ) => {
    const snapshot: AIAgentRunnerSnapshot = {
      phase,
      iteration,
      stepBudget,
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
    return options.requestAction({
      forceFinish,
      includeHistory,
      iteration,
      reason,
      steps: cloneSteps(steps),
    });
  };

  emit("idle");

  try {
    let finalAction: AIAgentToolAction | null = null;

    if (!options.workspaceToolsEnabled) {
      finalAction = await requestAction("direct", true, true);
    } else {
      for (iteration = 1; iteration <= stepBudget; iteration += 1) {
        const action = await requestAction(
          "iterate",
          iteration === stepBudget,
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
        emit("tool-completed", {
          action: action.action,
          message: action.message || "No message provided.",
        });
      }

      if (!finalAction) {
        iteration = stepBudget + 1;
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
