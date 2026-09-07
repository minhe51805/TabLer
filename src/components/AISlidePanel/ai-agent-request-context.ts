import type { AIConversationMessage } from "../../types/ai";
import {
  inferAssistIntent,
  isMetricsBoardRequest,
  isVisualizationRequest,
  isWorkspaceScopedIntent,
} from "./ai-assist-intent";
import type { AssistIntent } from "./ai-agent-context";
import { aiModeUsesSchemaContext } from "./ai-workspace-types";
import type { AIWorkspaceInteractionMode } from "./ai-workspace-types";

/** Remote providers only see a bounded tail of the conversation. */
export const MAX_REMOTE_HISTORY_MESSAGES = 4;

export interface AgentRequestContextInput {
  prompt: string;
  /** Optional explicit user instruction; takes precedence over the prompt for intent detection. */
  userPrompt?: string;
  interactionMode: AIWorkspaceInteractionMode;
  connectionId: string | null;
  isLocalProvider: boolean;
  history: AIConversationMessage[];
}

export interface AgentRequestContext {
  normalizedPrompt: string;
  requestIntentPrompt: string;
  assistIntent: AssistIntent;
  /** Raw prompt signals (kept separate from intent for visualization/metrics routing). */
  wantsVisualization: boolean;
  wantsMetricsBoard: boolean;
  interactionMode: AIWorkspaceInteractionMode;
  agentCanUseWorkspace: boolean;
  needsWorkspaceContext: boolean;
  modeUsesSchemaContext: boolean;
  requestHistory: AIConversationMessage[];
}

/**
 * Resolves the pure request-routing decisions that precede any I/O in the
 * agent flow: intent, workspace gating and history trimming. Extracted from
 * use-ai-slide-panel so the rules can be unit-tested without mocks.
 */
export function resolveAgentRequestContext(
  input: AgentRequestContextInput,
): AgentRequestContext {
  const normalizedPrompt = input.prompt.trim();
  const requestIntentPrompt = input.userPrompt?.trim() || normalizedPrompt;
  const assistIntent = inferAssistIntent(requestIntentPrompt, input.interactionMode);
  const requestedInteractionMode = input.interactionMode;

  // In agent mode, as long as there is a live connection we let the agent reach
  // for workspace tools even when the intent looks general — that is what makes
  // it behave like a real autonomous agent instead of a plain chat reply.
  const agentCanUseWorkspace =
    requestedInteractionMode === "agent" && Boolean(input.connectionId);
  const needsWorkspaceContext =
    isWorkspaceScopedIntent(assistIntent) || agentCanUseWorkspace;
  const modeUsesSchemaContext = aiModeUsesSchemaContext(requestedInteractionMode);

  const requestHistory =
    assistIntent === "overview"
      ? []
      : input.isLocalProvider
        ? input.history
        : input.history.slice(-MAX_REMOTE_HISTORY_MESSAGES);

  return {
    normalizedPrompt,
    requestIntentPrompt,
    assistIntent,
    wantsVisualization: isVisualizationRequest(requestIntentPrompt),
    wantsMetricsBoard: isMetricsBoardRequest(requestIntentPrompt),
    interactionMode: requestedInteractionMode,
    agentCanUseWorkspace,
    needsWorkspaceContext,
    modeUsesSchemaContext,
    requestHistory,
  };
}
