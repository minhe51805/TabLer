import { getCurrentAppLanguage } from "../../i18n";
import { useAIStore } from "../../stores/aiStore";
import type { AIConversationMessage } from "../../types";
import { buildAttachmentFileBlocks, toRequestAttachments } from "../../utils/ai-attachments";
import { getActiveAIProvider } from "../../utils/ai-provider-registry";
import { normalizeAIRequestError } from "../../utils/ai-request-errors";
import { trackUsage } from "../../utils/usage-counter";
import {
  AI_REQUEST_REPLACED_MESSAGE,
  isSupersededAIRequestError,
} from "./ai-agent-action-requestor";
import {
  extractAgentUsageBreakdown,
  extractAgentUsageTokens,
  recordSessionModelUsage,
} from "./ai-agent-cost";
import { buildSchemaContextRequiredMessage } from "./ai-agent-grounding";
import { resolveAgentRequestContext } from "./ai-agent-request-context";
import { isTrivialAssistIntent } from "./ai-assist-intent";
import { yieldToBrowserFrame } from "./ai-async-utils";
import { loadAgentWorkspaceContext } from "./agent-engine/context-loader";
import { finalizeAgentRun, finalizeNonAgentAssist } from "./agent-engine/post-run-pipeline";
import { driveAgentTurns } from "./agent-engine/turn-driver";
import type {
  AgentAssistContext,
  AgentAssistOptions,
  AskAI,
  AskAIAgentTurn,
} from "./agent-engine/types";
import type { AIGeneratedAssistResult } from "./hooks/use-ai-slide-panel";

export type { AgentAssistContext, AgentAssistOptions };

export async function runAgentAssist(
  ctx: AgentAssistContext,
  prompt: string,
  history: AIConversationMessage[] = [],
  options?: AgentAssistOptions,
): Promise<AIGeneratedAssistResult> {
  const {
    activeProvider,
    askAI,
    askAIAgentTurn,
    connectionId,
    currentDatabase,
    isLocalProvider,
    setError,
    setIsGenerating,
    requestIdRef,
    lastReasoningRef,
    lastModelUsedRef,
  } = ctx;

  const normalizedPrompt = prompt.trim();
  if (!normalizedPrompt) {
    const message = "Write a request first.";
    setError(message);
    throw new Error(message);
  }

  const attachmentDrafts = options?.attachments ?? [];
  const attachmentFileBlock = buildAttachmentFileBlocks(attachmentDrafts);
  const imageAttachments = toRequestAttachments(attachmentDrafts);
  const promptForRequest = attachmentFileBlock
    ? `${normalizedPrompt}\n\n${attachmentFileBlock}`
    : normalizedPrompt;

  if (!activeProvider) {
    const message = "No AI provider is enabled yet. Configure one in Settings first.";
    setError(message);
    throw new Error(message);
  }

  setIsGenerating(true);
  setError(null);
  trackUsage("agent.run");

  let runTokensUsed = 0;
  let runModelUsed: string | undefined;
  let routedRequestModel: string | undefined;

  const requestId = ++requestIdRef.current;
  lastReasoningRef.current = undefined;

  const trackedAskAI: AskAI = async (...args) => {
    const callOptions = args[6];
    if (routedRequestModel && !callOptions?.preferredModel) {
      args[6] = { ...callOptions, preferredModel: routedRequestModel };
    }
    const text = await askAI(...args);
    runTokensUsed += extractAgentUsageTokens(useAIStore.getState().streamingUsage);
    if (lastModelUsedRef.current) runModelUsed = lastModelUsedRef.current;
    return text;
  };

  const trackedAskAgentTurn: AskAIAgentTurn = async (
    turnPrompt,
    turnContext,
    turnHistory = [],
    turnAttachments,
    turnOptions,
  ) => {
    const invokeStructured = askAIAgentTurn ?? useAIStore.getState().askAIAgentTurn;
    if (invokeStructured) {
      const turn = await invokeStructured(
        turnPrompt,
        turnContext,
        turnHistory,
        turnAttachments,
        turnOptions,
      );
      const usageSource = turn.usage ?? useAIStore.getState().streamingUsage;
      runTokensUsed += extractAgentUsageTokens(usageSource);
      if (requestId === requestIdRef.current) {
        if (turn.reasoning?.trim()) {
          lastReasoningRef.current = turn.reasoning.trim();
        }
        if (turn.modelUsed?.trim()) {
          lastModelUsedRef.current = turn.modelUsed.trim();
          runModelUsed = turn.modelUsed.trim();
        }
        const usageBreakdown = extractAgentUsageBreakdown(usageSource);
        const answeredProvider =
          useAIStore.getState().aiConfigs.find((c) => c.id === turn.providerUsed) ??
          getActiveAIProvider(useAIStore.getState().aiConfigs);
        recordSessionModelUsage(
          answeredProvider?.name?.trim() || answeredProvider?.provider_type || "unknown",
          turn.modelUsed ?? answeredProvider?.model ?? "unknown",
          usageBreakdown,
        );
      }
      return turn;
    }

    // Fallback when a custom/mocked `ctx.askAI` is supplied without `askAIAgentTurn`.
    const text = await trackedAskAI(
      turnPrompt,
      turnContext,
      "panel",
      "agent",
      turnHistory,
      turnAttachments,
      turnOptions,
    );
    return {
      text,
      reasoning: lastReasoningRef.current,
      toolCalls: [],
      modelUsed: lastModelUsedRef.current,
    };
  };

  const unattendedReadOnly = options?.unattendedReadOnly === true;
  const {
    assistIntent,
    wantsVisualization,
    wantsMetricsBoard,
    interactionMode,
    needsWorkspaceContext,
    modeUsesSchemaContext,
    requestHistory,
  } = resolveAgentRequestContext({
    prompt: normalizedPrompt,
    userPrompt: options?.userPrompt,
    interactionMode: options?.interactionMode ?? "prompt",
    connectionId,
    isLocalProvider,
    history,
  });

  const appLanguage = getCurrentAppLanguage();
  const fastRemoteRecovery = !isLocalProvider && interactionMode !== "agent";

  try {
    await yieldToBrowserFrame();

    if (needsWorkspaceContext && !connectionId) {
      const message = "Connect to a database first if you want grounded workspace help.";
      setError(message);
      throw new Error(message);
    }

    const configuredFastModel = activeProvider.fast_model?.trim() || undefined;
    routedRequestModel =
      interactionMode !== "agent" &&
      configuredFastModel &&
      isTrivialAssistIntent(assistIntent, normalizedPrompt)
        ? configuredFastModel
        : undefined;

    const schemaSharingEnabled = activeProvider.allow_schema_context;
    const schemaContextEnabled =
      needsWorkspaceContext && schemaSharingEnabled && modeUsesSchemaContext;

    if (
      (needsWorkspaceContext && modeUsesSchemaContext && !schemaSharingEnabled) ||
      (assistIntent === "overview" && !schemaContextEnabled)
    ) {
      return {
        prompt: normalizedPrompt,
        rawResponse: buildSchemaContextRequiredMessage(
          appLanguage,
          currentDatabase,
          activeProvider.name || "AI provider",
          interactionMode,
          schemaSharingEnabled,
        ),
        sql: null,
        intent: assistIntent,
      };
    }

    const loaded = await loadAgentWorkspaceContext({
      ctx,
      requestId,
      normalizedPrompt,
      assistIntent,
      interactionMode,
      needsWorkspaceContext,
      schemaSharingEnabled,
      schemaContextEnabled,
      wantsVisualization,
      wantsMetricsBoard,
    });

    if (interactionMode === "agent") {
      const driver = await driveAgentTurns({
        ctx,
        loaded,
        options,
        requestId,
        normalizedPrompt,
        promptForRequest,
        assistIntent,
        appLanguage,
        wantsVisualization,
        unattendedReadOnly,
        configuredFastModel,
        requestHistory,
        imageAttachments,
        trackedAskAI,
        trackedAskAgentTurn,
        getRunTokensUsed: () => runTokensUsed,
      });

      return await finalizeAgentRun({
        ctx,
        loaded,
        driver,
        options,
        requestId,
        normalizedPrompt,
        assistIntent,
        appLanguage,
        unattendedReadOnly,
        runTokensUsed: () => runTokensUsed,
        runModelUsed: () => runModelUsed,
      });
    }

    return await finalizeNonAgentAssist({
      ctx,
      loaded,
      requestId,
      normalizedPrompt,
      promptForRequest,
      assistIntent,
      appLanguage,
      fastRemoteRecovery,
      schemaContextEnabled,
      wantsVisualization,
      requestHistory,
      trackedAskAI,
      runTokensUsed: () => runTokensUsed,
      runModelUsed: () => runModelUsed,
    });
  } catch (errorValue) {
    if (isSupersededAIRequestError(errorValue)) {
      throw errorValue instanceof Error ? errorValue : new Error(AI_REQUEST_REPLACED_MESSAGE);
    }

    const requestError = normalizeAIRequestError(errorValue);
    setError(requestError.message);
    throw requestError;
  } finally {
    if (requestId === requestIdRef.current) {
      setIsGenerating(false);
    }
  }
}
