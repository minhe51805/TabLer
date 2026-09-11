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
import { CHARS_PER_TOKEN, WORKSPACE_CONTEXT_MESSAGE_PREFIX } from "../../utils/ai-context-compact";

/**
 * Approximate TOKEN budget for the verbatim tail a REMOTE provider replays.
 * Trimming by tokens (chars ÷ CHARS_PER_TOKEN) rather than a fixed message
 * count means long turns cost their real size while short turns are kept
 * generously — no more chopping to an arbitrary N messages. Nothing is lost:
 * older context lives in the compacted workspace digest, which
 * `trimRemoteHistory` always preserves at the head. Local providers replay the
 * full history (it is already model- and back-end-clamped upstream).
 */
export const REMOTE_HISTORY_TOKEN_BUDGET = 2_000;

/**
 * Trims a remote provider's replayed history to `tokenBudget` (≈ tokens),
 * keeping the newest turns first, while ALWAYS preserving the leading
 * workspace-context digest pair so cross-turn memory survives. Replaces the old
 * fixed 4-message slice, which silently dropped the digest (it sits at the
 * head) as soon as a couple of fresh turns arrived.
 */
export function trimRemoteHistory(
  history: AIConversationMessage[],
  tokenBudget = REMOTE_HISTORY_TOKEN_BUDGET,
): AIConversationMessage[] {
  if (history.length <= 1) return history;

  const charBudget = Math.max(0, tokenBudget) * CHARS_PER_TOKEN;
  const hasDigest =
    typeof history[0]?.content === "string"
    && history[0].content.startsWith(WORKSPACE_CONTEXT_MESSAGE_PREFIX);
  const head = hasDigest ? history.slice(0, 2) : [];
  const tail = hasDigest ? history.slice(2) : history;

  let remaining = charBudget - head.reduce((sum, message) => sum + message.content.length, 0);
  const keptTail: AIConversationMessage[] = [];
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    const cost = tail[index].content.length;
    // Always keep at least the newest turn, even if it alone exceeds the budget.
    if (keptTail.length > 0 && cost > remaining) break;
    remaining -= cost;
    keptTail.unshift(tail[index]);
  }
  return [...head, ...keptTail];
}

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
        : trimRemoteHistory(input.history);

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
