import type { RefObject } from "react";
import type { AIConversationMessage, AIRequestAttachment, AIRequestIntent, AIRequestMode } from "../../types";
import { normalizeAIRequestError } from "../../utils/ai-request-errors";
import { parseAIAgentToolAction } from "./ai-agent-tools";
import {
  computeAgentRetryDelay,
  DEFAULT_AGENT_RETRY_POLICY,
  type AgentRetryPolicy,
} from "./ai-retry-policy";

/** Message used to signal that a newer AI request replaced the current one. */
export const AI_REQUEST_REPLACED_MESSAGE = "This AI request was replaced by a newer one.";

export function isSupersededAIRequestError(errorValue: unknown): boolean {
  if (errorValue instanceof Error) {
    return errorValue.message === AI_REQUEST_REPLACED_MESSAGE;
  }

  return String(errorValue) === AI_REQUEST_REPLACED_MESSAGE;
}

/** Info surfaced to the caller before one in-line retry wait starts. */
export interface AgentRetryWaitInfo {
  delayMs: number;
  reason: "rate-limit" | "transient";
  retryAfterMs?: number;
  /** 1-based retry attempt about to run. */
  retry: number;
  maxRetries: number;
}

interface AgentActionRequestorDeps {
  /** Streaming completion callback bound to the active provider. */
  askAI: (
    prompt: string,
    context: string,
    mode?: AIRequestMode,
    intent?: AIRequestIntent,
    history?: AIConversationMessage[],
    attachments?: AIRequestAttachment[],
    options?: { correlationId?: string },
  ) => Promise<string>;
  context: string;
  strictRecoveryContext: string | null;
  /** Monotonic id captured when generateAssist started; guards against superseded runs. */
  requestId: number;
  requestIdRef: RefObject<number>;
  requestHistory: AIConversationMessage[];
  /** Notified before each in-line retry wait so the UI can show the wait. */
  onRetryWait?: (info: AgentRetryWaitInfo) => void;
  /** Correlation id stamped onto every model call of this run (event scoping). */
  correlationId?: string;
  /** Injectable for tests; defaults to the shared agent policy. */
  retryPolicy?: AgentRetryPolicy;
  /** Random sample for jitter; injectable for deterministic tests. */
  random?: () => number;
}

/**
 * Model-call layer of the agent runtime: policy-driven retry for transient
 * failures (bounded, exponential backoff with jitter, honoring the provider's
 * Retry-After) plus a parse-repair loop that shows the model its own invalid
 * JSON so it can correct the format.
 */
export function createAgentActionRequestor(deps: AgentActionRequestorDeps) {
  const {
    askAI,
    context,
    strictRecoveryContext,
    requestId,
    requestIdRef,
    requestHistory,
    onRetryWait,
    correlationId,
    retryPolicy = DEFAULT_AGENT_RETRY_POLICY,
    random = Math.random,
  } = deps;

  const correlationOptions = correlationId !== undefined
    ? { correlationId }
    : undefined;

  const askAgentWithPolicyRetry = async (
    prompt: string,
    history: AIConversationMessage[] = [],
    attachments?: AIRequestAttachment[],
  ) => {
    let lastError: unknown;
    for (let retry = 0; retry <= retryPolicy.maxRetries; retry += 1) {
      try {
        return await askAI(prompt, strictRecoveryContext || context, "panel", "agent", history, attachments, correlationOptions);
      } catch (errorValue) {
        if (isSupersededAIRequestError(errorValue)) throw errorValue;
        lastError = errorValue;
        const requestError = normalizeAIRequestError(errorValue);
        if (!retryPolicy.retryableCodes.includes(requestError.code)) throw errorValue;
        if (retry >= retryPolicy.maxRetries) break;
        const rateLimited = /rate limit|429|quota|too many requests/i.test(requestError.message);
        const delayMs = computeAgentRetryDelay({
          retry: retry + 1,
          policy: retryPolicy,
          rateLimited,
          providerRetryAfterMs: requestError.providerRetryAfterMs,
          random,
        });
        // `null` = the provider asked for a wait longer than the policy
        // allows in-line; hand the failure to failover/recovery instead.
        if (delayMs === null) throw errorValue;
        onRetryWait?.({
          delayMs,
          reason: rateLimited ? "rate-limit" : "transient",
          retryAfterMs: requestError.providerRetryAfterMs,
          retry: retry + 1,
          maxRetries: retryPolicy.maxRetries,
        });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw lastError;
  };

  const requestAgentAction = async (
    controllerPrompt: string,
    includeHistory: boolean,
    extraInstruction?: string,
    attachments?: AIRequestAttachment[],
  ): Promise<ReturnType<typeof parseAIAgentToolAction>> => {
    let rawAgentResponse = await askAgentWithPolicyRetry(
      extraInstruction
        ? `${controllerPrompt}\n\nRepair note:\n${extraInstruction}`
        : controllerPrompt,
      includeHistory ? requestHistory : [],
      attachments,
    );
    if (requestId !== requestIdRef.current) {
      throw new Error(AI_REQUEST_REPLACED_MESSAGE);
    }

    try {
      return parseAIAgentToolAction(rawAgentResponse);
    } catch (parseError) {
      if (isSupersededAIRequestError(parseError)) throw parseError;
      const parseDetail = parseError instanceof Error ? parseError.message : String(parseError);
      const invalidSnippet = rawAgentResponse.trim().slice(0, 600);
      // Show the model its own broken output so it can correct the format
      // instead of repeating the same mistake blindly.
      rawAgentResponse = await askAgentWithPolicyRetry(
        [
          controllerPrompt,
          "",
          `The previous reply was not valid (${parseDetail}). Return the same next action again as valid JSON only.`,
          'Example shape: {"action":"describe_table","message":"Need the schema first.","args":{"table":"users"}}',
          invalidSnippet ? `Previous reply for reference:\n${invalidSnippet}` : "",
        ].filter(Boolean).join("\n"),
        []
      );
      if (requestId !== requestIdRef.current) {
        throw new Error(AI_REQUEST_REPLACED_MESSAGE);
      }
      return parseAIAgentToolAction(rawAgentResponse);
    }
  };

  return { askAgentWithPolicyRetry, requestAgentAction };
}
