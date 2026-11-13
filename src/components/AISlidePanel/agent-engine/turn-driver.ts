import { getLinkedWorkspaceDir } from "../../../hooks/useLinkedFolders";
import type { AppLanguage } from "../../../i18n";
import { getManualProviderOverrideAt, useAIStore } from "../../../stores/aiStore";
import { useAIAutonomyStore } from "../../../stores/aiAutonomyStore";
import { useConnectionStore } from "../../../stores/connectionStore";
import { useUIStore } from "../../../stores/uiStore";
import type {
  AIConversationMessage,
  AIProviderConfig,
  AIRequestAttachment,
  CanonicalToolCall,
  QueryResult,
} from "../../../types";
import { getActiveAIProvider } from "../../../utils/ai-provider-registry";
import { normalizeAIRequestError } from "../../../utils/ai-request-errors";
import { invokeWithTimeout } from "../../../utils/tauri-utils";
import { manageAgentMetricsBoard } from "../agent-tools/metrics-board-manager";
import {
  AI_REQUEST_REPLACED_MESSAGE,
  isSupersededAIRequestError,
  type AgentRetryWaitInfo,
} from "../ai-agent-action-requestor";
import {
  canonicalizeAgentArgs,
  countTrailingToolErrors,
  isRepeatTrackedAction,
  joinAgentInstructions,
  previewAgentArgs,
  REPEAT_CALL_GENTLE_REMINDER,
  repeatCallDetailedReminder,
  TOOL_ERROR_REFLECTION_THRESHOLD,
  toolErrorReflectionNudge,
  type AgentTraceStep,
  type AssistIntent,
} from "../ai-agent-context";
import { buildAgentControllerPrompt, buildAgentPlanPrompt } from "../ai-agent-controller-prompt";
import { DEFAULT_AGENT_TOKEN_BUDGET } from "../ai-agent-cost";
import {
  buildRunnerInstructionForReason,
  formatActionFailureReason,
} from "../ai-agent-quality-gates";
import { evaluateRunAgainstRules } from "../ai-agent-rules";
import {
  runAIAgentToolLoop,
  type AIAgentActionRequestReason,
  type AIAgentRunnerResult,
  type AIAgentToolBatchItem,
} from "../ai-agent-runner";
import { createAgentToolExecutor } from "../ai-agent-tool-executor";
import { AI_AGENT_ASK_USER_OPTIONS_LIMIT } from "../ai-agent-tool-schema";
import {
  parseAIAgentToolAction,
  parseCanonicalToolCall,
  type AIAgentFinishAction,
  type AIAgentToolAction,
} from "../ai-agent-tools";
import {
  buildAgentEvidenceSummary,
  buildAgentFinalRecoveryPrompt,
  buildLocalAgentFallbackResponse,
} from "../ai-assist-prompts";
import { extractAskUserOptionsFromQuestion } from "../ai-conversation-state";
import { extractSqlFromResponse, stripSqlCodeBlocksFromResponse } from "../ai-sql-response";
import type {
  AIWorkspaceAgentActionName,
  AIWorkspaceAgentStep,
  AIWorkspaceFailoverNote,
  AIWorkspaceRunTraceEntry,
} from "../ai-workspace-types";
import { createMultiTurnTranscript } from "./multi-turn-transcript";
import type {
  AgentAssistContext,
  AgentAssistOptions,
  AskAI,
  AskAIAgentTurn,
  LoadedAgentWorkspaceContext,
} from "./types";

function formatProviderFollowUpNote(
  language: string,
  provider: AIProviderConfig | null | undefined,
  rawReason: string,
): AIWorkspaceFailoverNote {
  const label =
    provider?.name?.trim() ||
    provider?.model ||
    (language === "vi" ? "provider hiện tại" : "the current provider");
  const detail =
    rawReason.replace(/\s+/g, " ").trim() ||
    (language === "vi" ? "lỗi không xác định" : "unknown error");
  return {
    summary: language === "vi" ? `Provider "${label}" bị lỗi` : `Provider "${label}" failed`,
    detail,
  };
}

const TERMINAL_BACKEND_CODES = new Set([
  "ai-auth",
  "ai-bad-request",
  "rate-limited",
  "validation-error",
  "storage-error",
]);

/**
 * Auth failures, malformed requests, local rate-limit aborts, and validation/storage errors
 * are non-recoverable by retry/fallback; propagate them instead of burning extra calls.
 */
function getTerminalAbortError(errorValue: unknown) {
  const normalized = normalizeAIRequestError(errorValue);
  if (normalized.backendCode && TERMINAL_BACKEND_CODES.has(normalized.backendCode)) {
    return normalized;
  }
  return null;
}

export interface AgentTurnDriverResult {
  runnerResult: AIAgentRunnerResult;
  endedWithAskUser: boolean;
  manualSwitchNotes: AgentTraceStep[];
  failoverNotes: AIWorkspaceFailoverNote[];
  unattendedBlockedTools?: AIAgentToolAction["action"][];
  runTrace: AIWorkspaceRunTraceEntry[];
  buildControllerPrompt: (
    forceFinish: boolean,
    extraInstruction?: string,
    steps?: AgentTraceStep[],
  ) => string;
  requestSingleActionForPostGates: (
    controllerPrompt: string,
    includeHistory: boolean,
  ) => Promise<AIAgentToolAction>;
  runAgentTool: (action: AIAgentToolAction) => Promise<string>;
  recoverAgentFinishAction: (reason: string) => Promise<AIAgentFinishAction>;
  publishAgentProgress: (pending?: { action: AIWorkspaceAgentActionName; message: string }) => void;
  runWithProgressTicker: <T>(
    pending: { action: AIWorkspaceAgentActionName; message: string },
    work: () => Promise<T>,
  ) => Promise<T>;
  cleanup: () => void;
}

export async function driveAgentTurns(params: {
  ctx: AgentAssistContext;
  loaded: LoadedAgentWorkspaceContext;
  options?: AgentAssistOptions;
  requestId: number;
  normalizedPrompt: string;
  promptForRequest: string;
  assistIntent: AssistIntent;
  appLanguage: AppLanguage;
  wantsVisualization: boolean;
  unattendedReadOnly: boolean;
  configuredFastModel?: string;
  requestHistory: AIConversationMessage[];
  imageAttachments?: AIRequestAttachment[];
  trackedAskAI: AskAI;
  trackedAskAgentTurn: AskAIAgentTurn;
  getRunTokensUsed: () => number;
}): Promise<AgentTurnDriverResult> {
  const {
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
    getRunTokensUsed,
  } = params;

  const {
    activeDbType,
    cancelAIRequest,
    connectionId,
    currentDatabase,
    executeAgentParameterizedQuery,
    executeAgentReadonlyQuery,
    getTableColumnsPreview,
    getTableData,
    getTableStructure,
    listCheckpoints,
    previewWriteTransaction,
    restoreCheckpoint,
    requestIdRef,
  } = ctx;

  const {
    latestTables,
    agentPromptTableNames,
    availableSchemaTables,
    context,
    relationalSchemaSummaryByTable,
    strictRecoveryContext,
    workspaceToolsEnabled,
    toolAvailability,
    recordLookupRequest,
    workspaceToolStatus,
    sharedAgentInstruction,
    cachedTableSummaries,
    glossaryLines,
    availableSkills,
    agentMemoryIndex,
    queryTabs,
    workspaceBoundDatabase,
    knownDatabaseNames,
    agentStepBudget,
  } = loaded;

  const onAgentProgress = options?.onAgentProgress;
  const requestDataReadConsent = options?.requestDataReadConsent;
  const requestDataDestructiveConsent = options?.requestDataDestructiveConsent;
  const correlationId = `agent-run-${requestId}`;
  const assertActiveRequest = () => {
    if (requestId !== requestIdRef.current) {
      throw new Error(AI_REQUEST_REPLACED_MESSAGE);
    }
  };

  let agentTraceSteps: AgentTraceStep[] = [];
  let agentPlanLines: string[] = [];
  const inspectedAgentTables = new Set<string>(relationalSchemaSummaryByTable.keys());
  const manualSwitchNotes: AgentTraceStep[] = [];
  const failoverNoteLines: string[] = [];
  const failoverNotes: AIWorkspaceFailoverNote[] = [];
  let getAgentRunTrace: () => AIWorkspaceRunTraceEntry[] = () => [];
  let runTokensSampled = 0;

  const transcript = createMultiTurnTranscript();

  const publishAgentProgress = (pending?: {
    action: AIWorkspaceAgentActionName;
    message: string;
  }) => {
    if (!onAgentProgress) return;
    const completed: AIWorkspaceAgentStep[] = [
      ...agentTraceSteps.map((step): AIWorkspaceAgentStep => ({
        step: step.step,
        action: step.action,
        message: step.message,
        observation: step.observation,
        status:
          step.observation.startsWith("Tool error") || step.observation.startsWith("Tool blocked")
            ? "error"
            : "done",
      })),
      ...manualSwitchNotes.map((step) => ({
        step: step.step,
        action: step.action,
        message: step.message,
        observation: step.observation,
        status: "done" as const,
      })),
    ];
    if (pending) {
      completed.push({
        step: completed.length + 1,
        action: pending.action,
        message: pending.message,
        status: "running",
      });
    }
    completed.forEach((step, index) => {
      step.step = index + 1;
    });
    onAgentProgress(completed, getAgentRunTrace());
  };

  let runningPhaseTicker: number | null = null;
  const stopRunningPhaseTicker = () => {
    if (runningPhaseTicker !== null) {
      window.clearInterval(runningPhaseTicker);
      runningPhaseTicker = null;
    }
  };
  const startRunningPhaseTicker = (pending: {
    action: AIWorkspaceAgentActionName;
    message: string;
  }) => {
    stopRunningPhaseTicker();
    publishAgentProgress(pending);
    const startedAt = Date.now();
    runningPhaseTicker = window.setInterval(() => {
      const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
      publishAgentProgress({
        action: pending.action,
        message: `${pending.message} (${elapsedSeconds}s)`,
      });
    }, 5000);
  };
  const runWithProgressTicker = async <T>(
    pending: { action: AIWorkspaceAgentActionName; message: string },
    work: () => Promise<T>,
  ): Promise<T> => {
    startRunningPhaseTicker(pending);
    try {
      return await work();
    } finally {
      stopRunningPhaseTicker();
    }
  };

  const handleRetryWait = ({ delayMs, reason, retry, maxRetries }: AgentRetryWaitInfo) => {
    const seconds = Math.max(1, Math.round(delayMs / 1000));
    const transientNote =
      appLanguage === "vi"
        ? reason === "rate-limit"
          ? `Bị rate limit — chờ ${seconds}s rồi thử lại…`
          : `Lỗi tạm thời từ provider — thử lại sau ${seconds}s…`
        : reason === "rate-limit"
          ? `Rate limited — waiting ${seconds}s before retrying…`
          : `Transient provider error — retrying in ${seconds}s…`;
    publishAgentProgress({ action: "think", message: transientNote });
    const settledNote =
      appLanguage === "vi"
        ? `Đã chờ ${seconds}s do ${reason === "rate-limit" ? "rate limit" : "lỗi tạm thời"} trước khi thử lại (lần ${retry}/${maxRetries}).`
        : `Waited ${seconds}s due to ${reason === "rate-limit" ? "rate limiting" : "a transient error"} before retrying (attempt ${retry}/${maxRetries}).`;
    manualSwitchNotes.push({
      step: agentTraceSteps.length + manualSwitchNotes.length + 1,
      action: "think",
      message: settledNote,
      observation: "In-line retry wait.",
    });
  };

  const buildControllerPrompt = (
    forceFinish: boolean,
    extraInstruction?: string,
    steps: AgentTraceStep[] = agentTraceSteps,
    omitInlineStepObservations = false,
  ) =>
    buildAgentControllerPrompt({
      userPrompt: promptForRequest,
      assistIntent,
      currentDatabase,
      availableTableNames:
        agentPromptTableNames.length > 0 ? agentPromptTableNames : availableSchemaTables,
      steps: steps.filter((step) => step.step > transcript.getCompactedThroughStep()),
      earlierContext: transcript.getCompactedContext(),
      workspaceToolsEnabled,
      knownDatabaseNames,
      workspaceBoundDatabase,
      planLines: agentPlanLines,
      workspaceToolStatus,
      toolAvailability,
      forceFinish,
      extraInstruction,
      cachedTableSummaries,
      glossaryLines,
      availableSkills,
      agentMemoryIndex,
      queryTabs,
      unattendedReadOnly,
      agentAutonomy: useAIAutonomyStore.getState().getAutonomy(connectionId ?? ""),
      omitInlineStepObservations,
    });

  const { runAgentTool, getUnattendedBlockedTools, getRunTrace } = createAgentToolExecutor({
    unattendedReadOnly,
    allowedSkillNames: availableSkills?.map((entry) => entry.name) ?? [],
    initialToolRestriction: options?.commandToolRestriction,
    memoryScope: { connectionId, database: currentDatabase ?? null },
    connectionId,
    currentDatabase,
    dbType: activeDbType,
    latestTables,
    availableSchemaTables,
    relationalSchemaSummaryByTable,
    inspectedAgentTables,
    requestId,
    requestIdRef,
    openQueryTab: ({ sql: tabSql, title, autoRun }) => {
      const tabIdsBefore = new Set(useUIStore.getState().tabs.map((tab) => tab.id));
      window.dispatchEvent(
        new CustomEvent("open-ai-workspace-query", {
          detail: {
            sql: tabSql,
            connectionId,
            database: currentDatabase || undefined,
            title,
            resultViewMode: "table" as const,
            autoRun,
            focusWorkspace: true,
          },
        }),
      );
      return useUIStore
        .getState()
        .tabs.some((tab) => tab.type === "query" && !tabIdsBefore.has(tab.id));
    },
    manageMetricsBoard: (request) =>
      manageAgentMetricsBoard(request, {
        connectionId,
        database: currentDatabase ?? null,
      }),
    openTableTab: ({ table, database }) => {
      if (!connectionId) return false;
      const tabIdsBefore = new Set(useUIStore.getState().tabs.map((tab) => tab.id));
      useUIStore.getState().addTab({
        id: `table-${connectionId}-${database || currentDatabase || ""}-${table}-${crypto.randomUUID()}`,
        type: "table",
        title: table,
        connectionId,
        tableName: table,
        database: database || currentDatabase || undefined,
      });
      return useUIStore
        .getState()
        .tabs.some((tab) => tab.type === "table" && !tabIdsBefore.has(tab.id));
    },
    requestDataReadConsent,
    requestDataDestructiveConsent,
    publishAgentProgress,
    evaluateGuardrailRules: async (statements, ruleOptions) =>
      evaluateRunAgainstRules(statements, {
        isMutating: ruleOptions.isMutating,
        workspaceDir:
          ruleOptions.workspaceDir !== undefined
            ? ruleOptions.workspaceDir
            : await getLinkedWorkspaceDir(),
        invoke: (command, args) =>
          invokeWithTimeout(command, args ?? {}, 60_000, "Evaluating guardrail rules"),
      }),
    onAgentPlanUpdate: (plan) => {
      agentPlanLines = plan.map((step, index) => `${index + 1}. [${step.status}] ${step.title}`);
    },
    createCheckpoint: (label) => {
      const state = useConnectionStore.getState();
      const dbType = state.connections.find((c) => c.id === connectionId)?.db_type;
      if (!connectionId || !dbType) {
        return Promise.reject(new Error("No active connection for checkpoint."));
      }
      return invokeWithTimeout<{
        fileName: string;
        label: string;
        tableCount: number;
        rowCount: number;
      }>(
        "create_database_checkpoint",
        {
          connectionId,
          database: state.currentDatabase || null,
          dbType,
          label: label ?? null,
        },
        120_000,
        "Creating checkpoint",
      );
    },
    listCheckpoints,
    restoreCheckpoint,
    language: appLanguage,
    delegateSubAnalysis: async (instruction, focusTables) => {
      assertActiveRequest();
      const delegatePrompt = [
        "You are a side-analysis helper for a workspace agent. The agent hands you focused, self-contained questions mid-run.",
        focusTables.length > 0 ? `Focus tables: ${focusTables.join(", ")}.` : "",
        "Answer in at most 8 short lines of plain text (no SQL fences, no tool talk).",
        "Ground everything in the attached schema context; if it is not enough, say exactly what is missing instead of inventing tables or columns.",
        "",
        "Instruction:",
        instruction,
      ]
        .filter(Boolean)
        .join("\n");
      const delegateResponse = await trackedAskAI(
        delegatePrompt,
        strictRecoveryContext || context,
        "panel",
        "general",
        [],
        undefined,
        { correlationId, trackInPanel: false },
      );
      assertActiveRequest();
      return delegateResponse;
    },
    getTableColumnsPreview,
    getTableStructure,
    getTableData,
    executeReadonlyQuery: executeAgentReadonlyQuery,
    executeParameterizedReadonlyQuery: executeAgentParameterizedQuery,
    previewWriteTransaction,
    explainStatement: (explainConnectionId, explainSql) =>
      invokeWithTimeout<QueryResult>(
        "explain_agent_statement",
        {
          connectionId: explainConnectionId,
          sql: explainSql,
        },
        60_000,
        "Explaining statement",
      ),
    toolAvailability,
  });
  getAgentRunTrace = getRunTrace;

  const recoverAgentFinishAction = async (reason: string): Promise<AIAgentFinishAction> => {
    assertActiveRequest();
    const allowedTables =
      agentPromptTableNames.length > 0 ? agentPromptTableNames : availableSchemaTables;
    const fallbackResponse = buildLocalAgentFallbackResponse({
      language: appLanguage,
      currentDatabase,
      availableTableNames: allowedTables,
      wantsVisualization,
      steps: agentTraceSteps,
    });
    const failoverNoteSuffix =
      failoverNoteLines.length > 0 ? `\n\n*${failoverNoteLines.join(" ")}*` : "";

    try {
      const recoveredResponse = await trackedAskAI(
        buildAgentFinalRecoveryPrompt({
          userPrompt: normalizedPrompt,
          assistIntent,
          currentDatabase,
          availableTableNames: allowedTables,
          evidenceSummary: buildAgentEvidenceSummary(agentTraceSteps),
          wantsVisualization,
          reason,
        }),
        strictRecoveryContext || context,
        "panel",
        assistIntent === "overview" ? "overview" : "explain",
        [],
        undefined,
        { correlationId },
      );
      assertActiveRequest();

      const trimmedResponse = recoveredResponse.trim() || fallbackResponse;
      const responseWithFailoverNote = `${trimmedResponse}${failoverNoteSuffix}`;
      const recoveredSql = extractSqlFromResponse(trimmedResponse);

      return {
        action: "finish",
        message: reason,
        args: {
          response: responseWithFailoverNote,
          ...(recoveredSql ? { sql: recoveredSql } : {}),
        },
      };
    } catch (errorValue) {
      if (isSupersededAIRequestError(errorValue)) {
        throw errorValue;
      }
      assertActiveRequest();
      const terminalError = getTerminalAbortError(errorValue);
      if (terminalError) {
        throw terminalError;
      }

      return {
        action: "finish",
        message: reason,
        args: {
          response: `${fallbackResponse}${failoverNoteSuffix}`,
        },
      };
    }
  };

  if (workspaceToolsEnabled) {
    assertActiveRequest();
    try {
      const planText = await runWithProgressTicker({ action: "plan", message: "Planning…" }, () =>
        trackedAskAI(
          buildAgentPlanPrompt({
            userPrompt: normalizedPrompt,
            assistIntent,
            currentDatabase,
            availableTableNames:
              agentPromptTableNames.length > 0 ? agentPromptTableNames : availableSchemaTables,
            appLanguage,
          }),
          strictRecoveryContext || context,
          "panel",
          "explain",
          [],
          undefined,
          { correlationId },
        ),
      );
      assertActiveRequest();
      const cleanedPlan = stripSqlCodeBlocksFromResponse(planText).trim() || planText.trim();
      if (cleanedPlan) {
        agentTraceSteps.push({
          step: agentTraceSteps.length + 1,
          action: "plan",
          message: cleanedPlan,
          observation: "",
        });
        publishAgentProgress();
      }
    } catch (planError) {
      if (isSupersededAIRequestError(planError)) {
        throw planError;
      }
      assertActiveRequest();
      const terminalPlanError = getTerminalAbortError(planError);
      if (terminalPlanError) {
        throw terminalPlanError;
      }
      const normalizedPlanError = normalizeAIRequestError(planError);
      if (normalizedPlanError.code === "cancelled") {
        throw normalizedPlanError;
      }
    }
  }

  const runStartedAt = Date.now();
  const providerAtRunStart = getActiveAIProvider(useAIStore.getState().aiConfigs)?.id ?? null;
  let crossProviderOccurred = false;
  let manualProviderSwitchPending = false;

  const handleManualProviderSwitch = (event: Event) => {
    const detail = (event as CustomEvent<{ providerLabel?: string }>).detail;
    const nextLabel = detail?.providerLabel?.trim();
    if (!nextLabel) return;
    manualProviderSwitchPending = true;
    const note =
      appLanguage === "vi"
        ? `Bạn đã chọn provider "${nextLabel}" — lượt chạy sẽ tiếp tục trên provider này.`
        : `You switched to provider "${nextLabel}" — the run continues on it.`;
    failoverNoteLines.push(note);
    manualSwitchNotes.push({
      step: agentTraceSteps.length + manualSwitchNotes.length + 1,
      action: "think",
      message: note,
      observation: "Provider switched manually mid-run.",
    });
    publishAgentProgress();
    if (useAIStore.getState().activeAIRequestId) {
      void cancelAIRequest();
    }
  };
  window.addEventListener("ai-provider-switched-during-run", handleManualProviderSwitch);

  const handleChainFailoverNote = (event: Event) => {
    const detail = (
      event as CustomEvent<{
        failedProvider?: string;
        failedModel?: string | null;
        reason?: string;
        attempt?: number;
        total?: number;
        correlationId?: string;
      }>
    ).detail;
    if (!detail?.correlationId || detail.correlationId !== correlationId) return;
    const failed = detail.failedProvider?.trim();
    if (!failed) return;
    const failedModel = detail.failedModel?.trim();
    const failedLabel = failedModel ? `${failed} (model ${failedModel})` : failed;
    const attemptLabel = `${detail?.attempt ?? "?"}/${detail?.total ?? "?"}`;
    const note =
      appLanguage === "vi"
        ? `Provider "${failedLabel}" lỗi (${detail?.reason ?? "không xác định"}) — đang thử model/provider tiếp theo (${attemptLabel})…`
        : `Provider "${failedLabel}" failed (${detail?.reason ?? "error"}) — trying the next model/provider (${attemptLabel})…`;
    manualSwitchNotes.push({
      step: agentTraceSteps.length + manualSwitchNotes.length + 1,
      action: "think",
      message: note,
      observation: "Model/provider failover within the request chain.",
    });
    publishAgentProgress({ action: "think", message: note });
  };
  window.addEventListener("ai-provider-chain-failover", handleChainFailoverNote);

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    stopRunningPhaseTicker();
    window.removeEventListener("ai-provider-switched-during-run", handleManualProviderSwitch);
    window.removeEventListener("ai-provider-chain-failover", handleChainFailoverNote);
    if (
      providerAtRunStart &&
      crossProviderOccurred &&
      getManualProviderOverrideAt() <= runStartedAt
    ) {
      useAIStore.getState().restoreProvider(providerAtRunStart);
    }
  };

  let endedWithAskUser = false;
  let repeatChain: { key: string; count: number } | null = null;
  let pendingRepeatReminder: string | null = null;
  let lastReflectedToolErrorStreak = 0;

  const convertAskUserToFinish = (
    action: AIAgentToolAction,
    currentSteps: AgentTraceStep[],
  ): AIAgentFinishAction => {
    endedWithAskUser = true;
    const rawArgs = (action.args ?? {}) as Record<string, unknown>;
    const structuredOptions = Array.isArray(rawArgs.options)
      ? rawArgs.options
          .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
          .slice(0, AI_AGENT_ASK_USER_OPTIONS_LIMIT)
      : [];
    const questionText = typeof rawArgs.question === "string" ? rawArgs.question.trim() : "";
    const extracted =
      structuredOptions.length > 0
        ? { question: questionText, options: structuredOptions }
        : extractAskUserOptionsFromQuestion(questionText);
    const askQuestion = extracted.question;
    const askOptions = extracted.options;
    const optionsBlock = askOptions.length
      ? `\n\n${askOptions.map((option, index) => `${index + 1}. ${option}`).join("\n")}`
      : "";
    const suffix = askOptions.length
      ? appLanguage === "vi"
        ? "\n\n_(Trả lời bằng số thứ tự hoặc nội dung của bạn.)_"
        : "\n\n_(Reply with an option number or your own answer.)_"
      : "";
    agentTraceSteps = [
      ...currentSteps,
      {
        step: currentSteps.length + 1,
        action: "ask_user",
        message: askQuestion,
        observation: "",
      },
    ];
    publishAgentProgress();
    return {
      action: "finish",
      message: action.message || "Asking the user for clarification.",
      args: {
        response: `${askQuestion}${optionsBlock}${suffix}`,
        options: askOptions,
      },
    };
  };

  /**
   * Executes one model controller turn through the unified `aiStore.askAIAgentTurn`
   * coordinator and parses either structured `toolCalls` (supporting multi-tool
   * parallel batches) or text/JSON fallback (with 1x format repair).
   */
  const executeParsedTurn = async (
    controllerPrompt: string,
    includeHistory: boolean,
    useNativeMultiTurn: boolean,
  ): Promise<{
    items: AIAgentToolBatchItem[];
    rawToolCalls: CanonicalToolCall[];
    text: string;
    reasoning?: string;
    thoughtSignature?: string;
  }> => {
    const activeContext = strictRecoveryContext || context;
    const historyToSend = includeHistory ? requestHistory : [];
    const agentTurns = useNativeMultiTurn ? transcript.getTurns() : undefined;

    const invokeTurn = async (turnPrompt: string, turnHistory: AIConversationMessage[]) => {
      assertActiveRequest();
      const result = await trackedAskAgentTurn(
        turnPrompt,
        activeContext,
        turnHistory,
        imageAttachments,
        {
          correlationId,
          unattendedReadOnly,
          agentTurns,
          onRetryWait: handleRetryWait,
        },
      );
      assertActiveRequest();
      if (result.providerUsed && providerAtRunStart && result.providerUsed !== providerAtRunStart) {
        crossProviderOccurred = true;
      }
      return result;
    };

    const turnResult = await invokeTurn(controllerPrompt, historyToSend);

    // Path A: Native structured tool_calls returned directly on `AIResponse`.
    if (turnResult.toolCalls.length > 0) {
      const parsedItems: AIAgentToolBatchItem[] = [];
      let singleParseError: unknown = null;

      for (let i = 0; i < turnResult.toolCalls.length; i += 1) {
        const call = turnResult.toolCalls[i];
        const callId = call.id?.trim() || `call_${Date.now()}_${i + 1}`;
        try {
          const action = parseCanonicalToolCall(call, i === 0 ? turnResult.text : "");
          parsedItems.push({ callId, action });
        } catch (parseErr) {
          if (turnResult.toolCalls.length === 1) {
            singleParseError = parseErr;
          } else {
            // Keep valid sibling calls in a multi-tool batch instead of discarding the turn.
            console.warn("[AI Agent] Skipping invalid tool call in batch:", call.name, parseErr);
          }
        }
      }

      if (parsedItems.length > 0) {
        return {
          items: parsedItems,
          rawToolCalls: parsedItems.map((item) => ({
            id: item.callId,
            name: item.action.action,
            arguments: (item.action.args ?? {}) as Record<string, unknown>,
          })),
          text: turnResult.text,
          reasoning: turnResult.reasoning,
          thoughtSignature: turnResult.thoughtSignature,
        };
      }

      // Single native tool call had invalid schema args -> 1x repair prompt.
      const detail =
        singleParseError instanceof Error ? singleParseError.message : String(singleParseError);
      const repaired = await invokeTurn(
        [
          controllerPrompt,
          "",
          `The previous tool call had invalid arguments (${detail}). Invoke the tool again with valid arguments matching its schema.`,
        ].join("\n"),
        [],
      );
      if (repaired.toolCalls.length > 0) {
        const call = repaired.toolCalls[0];
        const callId = call.id?.trim() || `call_repair_${Date.now()}`;
        const action = parseCanonicalToolCall(call, repaired.text);
        return {
          items: [{ callId, action }],
          rawToolCalls: [
            {
              id: callId,
              name: action.action,
              arguments: (action.args ?? {}) as Record<string, unknown>,
            },
          ],
          text: repaired.text,
          reasoning: repaired.reasoning,
          thoughtSignature: repaired.thoughtSignature,
        };
      }
      const fallbackAction = parseAIAgentToolAction(repaired.text);
      const callId = `txt_repair_${Date.now()}`;
      return {
        items: [{ callId, action: fallbackAction }],
        rawToolCalls: [
          {
            id: callId,
            name: fallbackAction.action,
            arguments: (fallbackAction.args ?? {}) as Record<string, unknown>,
          },
        ],
        text: repaired.text,
        reasoning: repaired.reasoning,
        thoughtSignature: repaired.thoughtSignature,
      };
    }

    // Path B: Text/JSON fallback (text-only endpoints like `OllamaGenerate` or plain-text finals).
    try {
      const action = parseAIAgentToolAction(turnResult.text);
      const callId = `txt_call_${Date.now()}`;
      return {
        items: [{ callId, action }],
        rawToolCalls: [
          {
            id: callId,
            name: action.action,
            arguments: (action.args ?? {}) as Record<string, unknown>,
          },
        ],
        text: turnResult.text,
        reasoning: turnResult.reasoning,
        thoughtSignature: turnResult.thoughtSignature,
      };
    } catch (parseError) {
      if (isSupersededAIRequestError(parseError)) throw parseError;
      const parseDetail = parseError instanceof Error ? parseError.message : String(parseError);
      const invalidSnippet = turnResult.text.trim().slice(0, 600);
      const repaired = await invokeTurn(
        [
          controllerPrompt,
          "",
          `The previous reply was not valid (${parseDetail}). Invoke a native tool or return valid JSON only.`,
          'Example shape: {"action":"describe_table","message":"Need the schema first.","args":{"table":"users"}}',
          invalidSnippet ? `Previous reply for reference:\n${invalidSnippet}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        [],
      );
      if (repaired.toolCalls.length > 0) {
        const call = repaired.toolCalls[0];
        const callId = call.id?.trim() || `call_repair_${Date.now()}`;
        const action = parseCanonicalToolCall(call, repaired.text);
        return {
          items: [{ callId, action }],
          rawToolCalls: [
            {
              id: callId,
              name: action.action,
              arguments: (action.args ?? {}) as Record<string, unknown>,
            },
          ],
          text: repaired.text,
          reasoning: repaired.reasoning,
          thoughtSignature: repaired.thoughtSignature,
        };
      }
      const action = parseAIAgentToolAction(repaired.text);
      const callId = `txt_repair_${Date.now()}`;
      return {
        items: [{ callId, action }],
        rawToolCalls: [
          {
            id: callId,
            name: action.action,
            arguments: (action.args ?? {}) as Record<string, unknown>,
          },
        ],
        text: repaired.text,
        reasoning: repaired.reasoning,
        thoughtSignature: repaired.thoughtSignature,
      };
    }
  };

  const requestSingleActionForPostGates = async (
    controllerPrompt: string,
    includeHistory: boolean,
  ): Promise<AIAgentToolAction> => {
    const parsed = await executeParsedTurn(controllerPrompt, includeHistory, false);
    const finishItem = parsed.items.find((item) => item.action.action === "finish");
    return (finishItem ?? parsed.items[0]).action;
  };

  try {
    const runnerResult = await runAIAgentToolLoop({
      workspaceToolsEnabled,
      stepBudget: agentStepBudget,
      tokenBudget: DEFAULT_AGENT_TOKEN_BUDGET,
      getLastRequestTokens: () => {
        const currentTotal = getRunTokensUsed();
        const delta = currentTotal - runTokensSampled;
        runTokensSampled = currentTotal;
        return delta;
      },
      initialSteps: agentTraceSteps,
      onToolResult: ({ callId, action, observation, skipped }) => {
        transcript.recordToolResult({
          callId,
          toolName: action.action,
          observation,
          isError: skipped ? true : undefined,
          stepOrdinal: agentTraceSteps.length + 1,
        });
      },
      requestAction: async ({
        forceFinish,
        includeHistory,
        iteration,
        reason,
        steps,
      }): Promise<AIAgentToolAction | AIAgentToolBatchItem[]> => {
        assertActiveRequest();
        const completedToolSteps = steps.filter((step) => step.action !== "plan");
        if (recordLookupRequest && iteration === 1 && completedToolSteps.length === 0) {
          const fastCallId = "fast_lookup_1";
          const fastAction: AIAgentToolAction = {
            action: "search_schema",
            message: "Locating the exact table and columns for this record",
            args: { query: normalizedPrompt },
          };
          transcript.recordAssistantToolTurn({
            text: fastAction.message,
            toolCalls: [
              {
                id: fastCallId,
                name: "search_schema",
                arguments: { query: normalizedPrompt },
              },
            ],
            stepOrdinalHint: steps.length + 1,
          });
          return [{ callId: fastCallId, action: fastAction }];
        }

        // Compact older multi-turn groups when approaching token/character thresholds.
        try {
          await transcript.compactIfNeeded({
            steps,
            tokensUsed: getRunTokensUsed(),
            summarize: (foldLines, previousSummary) => {
              assertActiveRequest();
              return trackedAskAI(
                [
                  "Summarize this agent run's earlier steps into a compact brief (max 8 bullet lines) for the agent's own continuation.",
                  "Preserve: verified table/column names, executed SQL results and row counts, errors encountered, and decisions already made. Drop boilerplate.",
                  previousSummary
                    ? `Previous summary (merge into the new one):\n${previousSummary}`
                    : "",
                  `Steps to fold:\n${foldLines}`,
                ]
                  .filter(Boolean)
                  .join("\n\n"),
                context,
                "panel",
                "general",
                [],
                undefined,
                { preferredModel: configuredFastModel, correlationId, trackInPanel: false },
              );
            },
          });
        } catch (compactionErr) {
          if (isSupersededAIRequestError(compactionErr)) throw compactionErr;
          assertActiveRequest();
          const terminalCompactionError = getTerminalAbortError(compactionErr);
          if (terminalCompactionError) throw terminalCompactionError;
        }

        const hasMultiTurnHistory = transcript.getTurns().length > 0;
        let controllerPrompt = buildControllerPrompt(
          forceFinish,
          buildRunnerInstructionForReason(
            reason as AIAgentActionRequestReason,
            sharedAgentInstruction,
          ),
          steps,
          hasMultiTurnHistory,
        );

        const midRunNudges: string[] = [];
        if (pendingRepeatReminder) {
          midRunNudges.push(pendingRepeatReminder);
          pendingRepeatReminder = null;
        }
        const trailingToolErrors = forceFinish ? 0 : countTrailingToolErrors(steps);
        if (trailingToolErrors === 0) {
          lastReflectedToolErrorStreak = 0;
        } else if (
          trailingToolErrors >= TOOL_ERROR_REFLECTION_THRESHOLD &&
          trailingToolErrors > lastReflectedToolErrorStreak
        ) {
          midRunNudges.push(toolErrorReflectionNudge(trailingToolErrors));
          lastReflectedToolErrorStreak = trailingToolErrors;
        }
        if (midRunNudges.length > 0) {
          if (hasMultiTurnHistory) {
            transcript.recordUserGuidance(midRunNudges.join("\n\n"), steps.length);
          } else {
            controllerPrompt = `${controllerPrompt}\n\n${midRunNudges.join("\n\n")}`;
          }
        }

        const thinkBaseMessage =
          reason === "budget"
            ? "Wrapping up…"
            : reason === "direct"
              ? "Composing response…"
              : "Thinking…";
        const thinkStartedAt = Date.now();
        const thinkTicker = window.setInterval(() => {
          const elapsedSeconds = Math.round((Date.now() - thinkStartedAt) / 1000);
          publishAgentProgress({
            action: "think",
            message: `${thinkBaseMessage} (${elapsedSeconds}s)`,
          });
        }, 5000);

        try {
          let parsedTurn: Awaited<ReturnType<typeof executeParsedTurn>>;
          try {
            parsedTurn = await executeParsedTurn(controllerPrompt, includeHistory, true);
          } catch (errorValue) {
            if (isSupersededAIRequestError(errorValue)) throw errorValue;
            assertActiveRequest();
            const requestError = normalizeAIRequestError(errorValue);
            const terminalError = getTerminalAbortError(requestError);
            if (terminalError) {
              throw terminalError;
            }

            // Manual provider switch cancelled the in-flight call -> re-run once on the newly selected provider.
            if (requestError.code === "cancelled") {
              const wasManualSwitch =
                manualProviderSwitchPending || getManualProviderOverrideAt() > runStartedAt;
              if (!wasManualSwitch) {
                throw requestError;
              }
              manualProviderSwitchPending = false;
              parsedTurn = await executeParsedTurn(controllerPrompt, includeHistory, true);
            } else {
              failoverNotes.push(
                formatProviderFollowUpNote(
                  appLanguage,
                  getActiveAIProvider(useAIStore.getState().aiConfigs),
                  formatActionFailureReason(errorValue),
                ),
              );
              return recoverAgentFinishAction(
                `The agent could not return a valid action: ${formatActionFailureReason(errorValue)}`,
              );
            }
          }

          // Update repeat-call tracking across the batch.
          for (const { action } of parsedTurn.items) {
            if (isRepeatTrackedAction(action.action)) {
              const key = JSON.stringify([action.action, canonicalizeAgentArgs(action.args)]);
              repeatChain =
                repeatChain?.key === key
                  ? { key, count: repeatChain.count + 1 }
                  : { key, count: 1 };
              if (repeatChain.count === 3) {
                pendingRepeatReminder = REPEAT_CALL_GENTLE_REMINDER;
              } else if (repeatChain.count === 5) {
                pendingRepeatReminder = repeatCallDetailedReminder(
                  action.action,
                  repeatChain.count,
                  previewAgentArgs(canonicalizeAgentArgs(action.args)),
                );
              }
            }
          }

          // Handle `ask_user` anywhere in the batch as immediate clarifying termination.
          const askUserItem = parsedTurn.items.find((item) => item.action.action === "ask_user");
          if (askUserItem) {
            return convertAskUserToFinish(askUserItem.action, steps);
          }

          // Handle `finish` (including 1x repair when model emitted an empty finish after tool work).
          const finishItem = parsedTurn.items.find((item) => item.action.action === "finish");
          if (finishItem && parsedTurn.items.length === 1) {
            const finishAction = finishItem.action;
            if (
              finishAction.action === "finish" &&
              !String(finishAction.args?.response ?? "").trim() &&
              !String(finishAction.message ?? "").trim() &&
              !finishAction.args?.sql &&
              steps.some((step) => step.action !== "plan" && step.action !== "think")
            ) {
              try {
                const repairedFinish = await requestSingleActionForPostGates(
                  buildControllerPrompt(
                    true,
                    joinAgentInstructions(
                      sharedAgentInstruction,
                      "Your finish action contained no user-facing response. Return the finish action again with args.response summarizing the findings from the observations above, in the user's language.",
                    ),
                    steps,
                    false,
                  ),
                  false,
                );
                const repairedHasPayload =
                  repairedFinish.action === "finish" &&
                  (Boolean(String(repairedFinish.args?.response ?? "").trim()) ||
                    Boolean(String(repairedFinish.message ?? "").trim()) ||
                    Boolean(repairedFinish.args?.sql));
                if (repairedHasPayload) return repairedFinish;
              } catch (repairError) {
                if (isSupersededAIRequestError(repairError)) throw repairError;
                assertActiveRequest();
                const terminalRepairError = getTerminalAbortError(repairError);
                if (terminalRepairError) throw terminalRepairError;
              }
              const failoverNoteSuffix =
                failoverNoteLines.length > 0 ? `\n\n*${failoverNoteLines.join(" ")}*` : "";
              return {
                action: "finish",
                message: reason,
                args: {
                  response: `${buildLocalAgentFallbackResponse({
                    language: appLanguage,
                    currentDatabase,
                    availableTableNames:
                      agentPromptTableNames.length > 0
                        ? agentPromptTableNames
                        : availableSchemaTables,
                    wantsVisualization,
                    steps,
                  })}${failoverNoteSuffix}`,
                },
              };
            }
            return finishAction;
          }

          // Record assistant tool_use turn in canonical transcript before tools execute.
          const toolBatchCalls = parsedTurn.rawToolCalls.filter((call) => call.name !== "finish");
          if (toolBatchCalls.length > 0) {
            transcript.recordAssistantToolTurn({
              text: parsedTurn.text,
              reasoning: parsedTurn.reasoning,
              thoughtSignature: parsedTurn.thoughtSignature,
              toolCalls: toolBatchCalls,
              stepOrdinalHint: steps.length + toolBatchCalls.length,
            });
          }

          return parsedTurn.items;
        } finally {
          window.clearInterval(thinkTicker);
        }
      },
      runTool: async (action) => {
        assertActiveRequest();
        const observation = await runAgentTool(action);
        assertActiveRequest();
        return observation;
      },
      recoverFinish: recoverAgentFinishAction,
      onStateChange: (snapshot) => {
        agentTraceSteps = snapshot.steps.map((step) => ({ ...step }));
        if (snapshot.phase === "running-tool" && snapshot.action) {
          startRunningPhaseTicker({
            action: snapshot.action,
            message: snapshot.message || "No message provided.",
          });
        } else {
          stopRunningPhaseTicker();
          if (snapshot.phase === "tool-completed") {
            publishAgentProgress();
          } else if (snapshot.phase === "requesting-action") {
            publishAgentProgress({
              action: "think",
              message:
                snapshot.requestReason === "budget"
                  ? "Wrapping up…"
                  : snapshot.requestReason === "direct"
                    ? "Composing response…"
                    : "Thinking…",
            });
          } else if (snapshot.phase === "recovering-finish") {
            startRunningPhaseTicker({
              action: "think",
              message: "Finalizing answer.",
            });
          }
        }
      },
    });

    return {
      runnerResult,
      endedWithAskUser,
      manualSwitchNotes,
      failoverNotes,
      unattendedBlockedTools: unattendedReadOnly ? getUnattendedBlockedTools() : undefined,
      runTrace: getRunTrace(),
      buildControllerPrompt: (forceFinish, extraInstruction, steps) =>
        buildControllerPrompt(forceFinish, extraInstruction, steps, false),
      requestSingleActionForPostGates,
      runAgentTool,
      recoverAgentFinishAction,
      publishAgentProgress,
      runWithProgressTicker,
      cleanup,
    };
  } catch (err) {
    cleanup();
    throw err;
  }
}
