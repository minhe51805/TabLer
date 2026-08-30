import type { RefObject } from "react";
import type { AIConversationMessage, AIRequestAttachment, AIRequestIntent, AIRequestMode } from "../../types";
import { normalizeAIRequestError } from "../../utils/ai-request-errors";
import { parseAIAgentToolAction } from "./ai-agent-tools";

/** Message used to signal that a newer AI request replaced the current one. */
export const AI_REQUEST_REPLACED_MESSAGE = "This AI request was replaced by a newer one.";

export function isSupersededAIRequestError(errorValue: unknown): boolean {
  if (errorValue instanceof Error) {
    return errorValue.message === AI_REQUEST_REPLACED_MESSAGE;
  }

  return String(errorValue) === AI_REQUEST_REPLACED_MESSAGE;
}

const AGENT_TRANSIENT_RETRY_DELAY_MS = 800;
const AGENT_RATE_LIMIT_RETRY_DELAY_MS = 5_000;

interface AgentActionRequestorDeps {
  /** Streaming completion callback bound to the active provider. */
  askAI: (
    prompt: string,
    context: string,
    mode?: AIRequestMode,
    intent?: AIRequestIntent,
    history?: AIConversationMessage[],
    attachments?: AIRequestAttachment[],
  ) => Promise<string>;
  context: string;
  strictRecoveryContext: string | null;
  /** Monotonic id captured when generateAssist started; guards against superseded runs. */
  requestId: number;
  requestIdRef: RefObject<number>;
  requestHistory: AIConversationMessage[];
}

/**
 * Model-call layer of the agent runtime: one-shot retry for transient
 * transport failures plus a parse-repair loop that shows the model its own
 * invalid JSON so it can correct the format. Extracted verbatim from
 * use-ai-slide-panel.
 */
export function createAgentActionRequestor(deps: AgentActionRequestorDeps) {
  const {
    askAI,
    context,
    strictRecoveryContext,
    requestId,
    requestIdRef,
    requestHistory,
  } = deps;

  const askAgentWithTransientRetry = async (
    prompt: string,
    history: AIConversationMessage[] = [],
    attachments?: AIRequestAttachment[],
  ) => {
    try {
      return await askAI(prompt, strictRecoveryContext || context, "panel", "agent", history, attachments);
    } catch (errorValue) {
      if (isSupersededAIRequestError(errorValue)) throw errorValue;
      const requestError = normalizeAIRequestError(errorValue);
      if (requestError.code !== "timeout" && requestError.code !== "provider") throw errorValue;
      const rateLimited = /rate limit|429|quota|too many requests/i.test(requestError.message);
      await new Promise((resolve) => setTimeout(
        resolve,
        rateLimited ? AGENT_RATE_LIMIT_RETRY_DELAY_MS : AGENT_TRANSIENT_RETRY_DELAY_MS,
      ));
      return askAI(prompt, strictRecoveryContext || context, "panel", "agent", history, attachments);
    }
  };

  const requestAgentAction = async (
    controllerPrompt: string,
    includeHistory: boolean,
    extraInstruction?: string,
    attachments?: AIRequestAttachment[],
  ): Promise<ReturnType<typeof parseAIAgentToolAction>> => {
    let rawAgentResponse = await askAgentWithTransientRetry(
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
      rawAgentResponse = await askAgentWithTransientRetry(
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

  return { askAgentWithTransientRetry, requestAgentAction };
}
