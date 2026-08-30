import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { getCurrentAppLanguage } from "../../../i18n";
import { getManualProviderOverrideAt, useAIStore } from "../../../stores/aiStore";
import { useConnectionStore } from "../../../stores/connectionStore";
import { useQueryStore } from "../../../stores/queryStore";
import { type AIConversationMessage, type AIProviderConfig, type AIRequestAttachment, type AIRequestIntent, type AIRequestMode } from "../../../types";
import { buildAttachmentFileBlocks, toRequestAttachments, type AIAttachmentDraft } from "../../../utils/ai-attachments";
import { getActiveAIProvider, isLocalAIProvider } from "../../../utils/ai-provider-registry";
import { getAIFailoverConsent, requestAIFailoverConsent } from "../../../utils/ai-failover-consent";
import { normalizeAIRequestError } from "../../../utils/ai-request-errors";
import { getSemanticGlossary } from "../../../utils/semantic-glossary";
import { invokeMutation } from "../../../utils/tauri-utils";
import { analyzeGeneratedSql, type SqlRiskAnalysis } from "../AISlidePanelUtils";
import {
  type AIWorkspaceAgentActionName,
  type AIWorkspaceAgentStep,
  type AIWorkspaceInteractionMode,
} from "../ai-workspace-types";
import {
  type AIAgentFinishAction,
} from "../ai-agent-tools";
import {
  buildAgentControllerPrompt,
  buildAgentPlanPrompt,
  joinAgentInstructions,
  type AgentTraceStep,
  type AssistIntent,
} from "../ai-agent-context";
import {
  runAIAgentToolLoop,
  type AIAgentActionRequestReason,
} from "../ai-agent-runner";
import {
  DEFAULT_AGENT_TOKEN_BUDGET,
  extractAgentUsageTokens,
} from "../ai-agent-cost";
import {
  buildAgentEvidenceSummary,
  buildAgentFinalRecoveryPrompt,
  buildLocalAgentFallbackResponse,
} from "../ai-assist-prompts";
import type { AIMetricsWidgetSpec } from "../../../utils/metrics-board-templates";
import {
  buildSchemaContextRequiredMessage,
} from "../ai-agent-grounding";
import {
  formatExecutionError,
  isHighRiskStatement,
  isMutatingStatement,
} from "../../SQLEditor/SQLEditorUtils";
import { finalizeAgentResult } from "../ai-agent-finalization";
import { recoverNonAgentAssistResponse } from "../ai-assist-recovery";
import { yieldToBrowserFrame } from "../ai-async-utils";
import { prepareAIWorkspaceSchemaContext } from "../ai-schema-context-loader";
import { isAgentRecordLookupRequest } from "../ai-agent-schema-search";
import { resolveAgentRequestContext } from "../ai-agent-request-context";
import { agentToolAvailability, engineAwareDataPlaneHints } from "../ai-agent-engine-gates";
import { createAgentToolExecutor } from "../ai-agent-tool-executor";
import {
  createAgentActionRequestor,
  isSupersededAIRequestError,
  AI_REQUEST_REPLACED_MESSAGE,
} from "../ai-agent-action-requestor";
import { runAgentEvidenceLoop } from "../ai-agent-evidence-loop";

export { AI_REQUEST_REPLACED_MESSAGE, isSupersededAIRequestError };
import {
  buildRunnerInstructionForReason,
  formatActionFailureReason,
} from "../ai-agent-quality-gates";
import {
  extractSqlFromResponse,
  hasSqlStartKeyword,
  stripSqlCodeBlocksFromResponse,
} from "../ai-sql-response";
import { useAISqlRunner } from "./use-ai-sql-runner";

export type { AIExecutedSqlResult } from "./use-ai-sql-runner";

export interface AIGeneratedAssistResult {
  prompt: string;
  rawResponse: string;
  sql: string | null;
  risk?: SqlRiskAnalysis;
  intent: AssistIntent;
  reasoning?: string;
  agentSteps?: AIWorkspaceAgentStep[];
  /** Metrics widgets the agent designed for a dashboard request. */
  agentWidgets?: AIMetricsWidgetSpec[];
}

const MAX_AGENT_STEPS = 10;
const MAX_REMOTE_AGENT_STEPS = 8;
const MAX_LOCAL_COMPLEX_AGENT_STEPS = 14;
const MAX_REMOTE_COMPLEX_AGENT_STEPS = 10;

/**
 * Wait window before a promoted re-run, so a rate-limited endpoint has a
 * moment to recover before the next provider serves the step.
 */
const PROVIDER_RETRY_DELAY_MS = 1_200;

function formatProviderFailoverNote(
  language: string,
  failed: AIProviderConfig | undefined,
  promoted: AIProviderConfig | null,
) {
  const failedLabel = failed?.name?.trim() || failed?.model || "AI provider";
  if (!promoted) {
    return language === "vi"
      ? `Provider "${failedLabel}" đang lỗi — đã tự thử lại. Bạn chỉ cấu hình một provider nên chưa có provider nào để chuyển sang.`
      : `Provider "${failedLabel}" failed — retried automatically. Only one provider is configured, so there is nothing to switch to.`;
  }
  const nextLabel = promoted.name?.trim() || promoted.model;
  return language === "vi"
    ? `Provider "${failedLabel}" đang lỗi — đã tự chuyển sang provider "${nextLabel}" và chạy lại.`
    : `Provider "${failedLabel}" failed — switched to provider "${nextLabel}" and re-ran automatically.`;
}

/**
 * Second line of the failover note: what happened when the promoted provider
 * was actually tried, with the REAL underlying reason (HTTP status, bad key,
 * connection refused...) so the user can go fix that provider's config.
 */
function formatProviderFollowUpNote(
  language: string,
  provider: AIProviderConfig | null | undefined,
  rawReason: string,
) {
  const label = provider?.name?.trim()
    || provider?.model
    || (language === "vi" ? "provider hiện tại" : "the current provider");
  const shortReason = rawReason.length > 180 ? `${rawReason.slice(0, 180)}…` : rawReason;
  return language === "vi"
    ? `Provider "${label}" cũng trả lời lỗi: ${shortReason}`
    : `Provider "${label}" also failed: ${shortReason}`;
}
/** Upper bound for tables scanned per search_schema call; large catalogs are prioritized, not fully scanned. */
/** Pause before retrying a transient provider failure inside the agent loop. */
/** Rate limits need a longer cooldown than blips; one patient retry still beats failing the run. */


export function useAISlidePanel({ isOpen }: { isOpen: boolean }) {
  const {
    askAIWithReasoning,
    cancelAIRequest,
    aiConfigs,
    requestPhase,
    saveAIConfigs,
  } = useAIStore(
    useShallow((state) => ({
      askAIWithReasoning: state.askAIWithReasoning,
      cancelAIRequest: state.cancelAIRequest,
      aiConfigs: state.aiConfigs,
      requestPhase: state.requestPhase,
      saveAIConfigs: state.saveAIConfigs,
    }))
  );
  const {
    tables,
    fetchTables,
    switchDatabase,
    activeConnectionId: connectionId,
    currentDatabase,
    activeDbType,
  } = useConnectionStore(
    useShallow((state) => ({
      tables: state.tables,
      fetchTables: state.fetchTables,
      switchDatabase: state.switchDatabase,
      activeConnectionId: state.activeConnectionId,
      currentDatabase: state.currentDatabase,
      activeDbType: state.connections.find((connection) => connection.id === state.activeConnectionId)?.db_type,
    })),
  );
  const { getTableStructure, getTableColumnsPreview, getTableData, executeSandboxQuery, executeAgentReadonlyQuery, previewWriteTransaction } = useQueryStore(
    useShallow((state) => ({
      getTableStructure: state.getTableStructure,
      getTableColumnsPreview: state.getTableColumnsPreview,
      getTableData: state.getTableData,
      executeSandboxQuery: state.executeSandboxQuery,
      executeAgentReadonlyQuery: state.executeAgentReadonlyQuery,
      previewWriteTransaction: state.previewWriteTransaction,
    })),
  );

  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { isRunning, runSql } = useAISqlRunner({
    connectionId,
    executeSandboxQuery,
    setError,
    switchDatabase,
  });

  const aiSchemaCodecCacheRef = useRef(new Map<string, string>());
  const requestIdRef = useRef(0);
  // Captures the model's real reasoning from the most recent askAI call so the
  // final assistant bubble can show genuine thinking instead of fabricated steps.
  const lastReasoningRef = useRef<string | undefined>(undefined);

  const askAI = useCallback(
    async (
      prompt: string,
      context: string,
      mode: AIRequestMode = "panel",
      intent: AIRequestIntent = "sql",
      history: AIConversationMessage[] = [],
      attachments?: AIRequestAttachment[],
    ): Promise<string> => {
      const { text, reasoning } = await askAIWithReasoning(prompt, context, mode, intent, history, attachments);
      if (reasoning && reasoning.trim()) {
        lastReasoningRef.current = reasoning.trim();
      }
      return text;
    },
    [askAIWithReasoning],
  );

  const activeProvider = getActiveAIProvider(aiConfigs);
  const isLocalProvider = isLocalAIProvider(activeProvider);
  const tableContextCount = tables?.length || 0;

  useEffect(() => {
    aiSchemaCodecCacheRef.current.clear();
  }, [connectionId, currentDatabase]);

  useEffect(() => {
    const handleTableDataUpdated = (
      event: Event
    ) => {
      const detail = (event as CustomEvent<{
        connectionId?: string;
        database?: string;
        invalidateStructure?: boolean;
      }>).detail;

      if (!detail?.invalidateStructure) return;
      if (detail.connectionId !== connectionId) return;

      const detailDatabase = detail.database || "";
      const activeDatabaseName = currentDatabase || "";
      if (detailDatabase && activeDatabaseName && detailDatabase !== activeDatabaseName) return;

      aiSchemaCodecCacheRef.current.clear();
    };

    window.addEventListener("table-data-updated", handleTableDataUpdated);
    return () => window.removeEventListener("table-data-updated", handleTableDataUpdated);
  }, [connectionId, currentDatabase]);

  useEffect(() => {
    if (isOpen) {
      setError(null);
    } else {
      // Closing the panel must also stop the backend stream; bumping the
      // request id alone only silences the result, the provider keeps
      // generating until it finishes on its own.
      requestIdRef.current += 1;
      void cancelAIRequest();
    }
  }, [isOpen, cancelAIRequest]);

  const cancelGeneration = useCallback(() => {
    if (!isGenerating) return;
    requestIdRef.current += 1;
    setIsGenerating(false);
    setError(null);
    void cancelAIRequest();
  }, [cancelAIRequest, isGenerating]);

  const generateAssist = useCallback(async (
    prompt: string,
    history: AIConversationMessage[] = [],
    options?: {
      interactionMode?: AIWorkspaceInteractionMode;
      requestDataReadConsent?: () => Promise<boolean>;
      userPrompt?: string;
      onAgentProgress?: (steps: AIWorkspaceAgentStep[]) => void;
      /** Files/images attached by the user for this turn (composer pipeline). */
      attachments?: AIAttachmentDraft[];
    }
  ): Promise<AIGeneratedAssistResult> => {
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt) {
      const message = "Write a request first.";
      setError(message);
      throw new Error(message);
    }
    // Text-file contents ride inside the prompt text (Codex-style); images ride
    // the multimodal attachment channel and are only sent on the first request
    // of a run so the token cost is paid once, not per agent step.
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
    const requestId = ++requestIdRef.current;
    lastReasoningRef.current = undefined;
    const requestDataReadConsent = options?.requestDataReadConsent;
    const onAgentProgress = options?.onAgentProgress;
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

      let effectiveProvider = activeProvider;
      let schemaSharingEnabled = effectiveProvider.allow_schema_context;

      if (needsWorkspaceContext && modeUsesSchemaContext && !schemaSharingEnabled) {
        const nextConfigs = aiConfigs.map((config) => (
          config.id === effectiveProvider.id
            ? { ...config, allow_schema_context: true }
            : config
        ));

        const { aiConfigs: savedConfigs } = await saveAIConfigs(nextConfigs, {}, []);
        effectiveProvider = getActiveAIProvider(savedConfigs) ?? { ...effectiveProvider, allow_schema_context: true };
        schemaSharingEnabled = effectiveProvider.allow_schema_context;
      }

      const schemaContextEnabled =
        needsWorkspaceContext &&
        schemaSharingEnabled &&
        modeUsesSchemaContext;
      const requiresSchemaCatalog = schemaContextEnabled;

      let latestTables = useConnectionStore.getState().tables ?? [];

      if (requiresSchemaCatalog && latestTables.length === 0) {
        if (connectionId && currentDatabase) {
          await fetchTables(connectionId, currentDatabase);
        }
        if (requestId !== requestIdRef.current) {
          throw new Error(AI_REQUEST_REPLACED_MESSAGE);
        }
        await yieldToBrowserFrame();
        latestTables = useConnectionStore.getState().tables ?? [];
        if (latestTables.length === 0) {
          throw new Error("No tables were found in the current database.");
        }
      }

      if (needsWorkspaceContext && modeUsesSchemaContext && !schemaSharingEnabled) {
        return {
          prompt: normalizedPrompt,
          rawResponse: buildSchemaContextRequiredMessage(
            appLanguage,
            currentDatabase,
            effectiveProvider.name || "AI provider",
            interactionMode,
            schemaSharingEnabled
          ),
          sql: null,
          intent: assistIntent,
        };
      }

      if (assistIntent === "overview" && !schemaContextEnabled) {
        return {
          prompt: normalizedPrompt,
          rawResponse: buildSchemaContextRequiredMessage(
            appLanguage,
            currentDatabase,
            effectiveProvider.name || "AI provider",
            interactionMode,
            schemaSharingEnabled
          ),
          sql: null,
          intent: assistIntent,
        };
      }

      const {
        agentPromptTableNames,
        availableSchemaTables,
        context,
        relationalSchemaSummaryByTable,
        strictRecoveryContext,
      } = await prepareAIWorkspaceSchemaContext({
        connectionId: connectionId!,
        currentDatabase,
        interactionMode,
        intent: assistIntent,
        isCurrentRequest: () => requestId === requestIdRef.current,
        isLocalProvider,
        normalizedPrompt,
        schemaCodecCache: aiSchemaCodecCacheRef.current,
        schemaContextEnabled,
        tables: latestTables,
        getTableColumnsPreview,
        getTableStructure,
      });

      if (interactionMode === "agent") {
        let agentTraceSteps: AgentTraceStep[] = [];
        const inspectedAgentTables = new Set<string>();
        // Snapshot completed steps plus an optional in-flight step, then stream
        // them to the UI so the bubble can show the agent working live.
        const publishAgentProgress = (pending?: { action: AIWorkspaceAgentActionName; message: string }) => {
          if (!onAgentProgress) return;
          const completed: AIWorkspaceAgentStep[] = agentTraceSteps.map((step) => ({
            step: step.step,
            action: step.action,
            message: step.message,
            observation: step.observation,
            status: step.observation.startsWith("Tool error") || step.observation.startsWith("Tool blocked")
              ? "error"
              : "done",
          }));
          if (pending) {
            completed.push({
              step: agentTraceSteps.length + 1,
              action: pending.action,
              message: pending.message,
              status: "running",
            });
          }
          onAgentProgress(completed);
        };
        const needsExtendedAgentBudget = wantsVisualization || assistIntent === "overview";
        const agentStepBudget = isLocalProvider
          ? (needsExtendedAgentBudget ? MAX_LOCAL_COMPLEX_AGENT_STEPS : MAX_AGENT_STEPS)
          : (needsExtendedAgentBudget ? MAX_REMOTE_COMPLEX_AGENT_STEPS : MAX_REMOTE_AGENT_STEPS);
        const workspaceToolsEnabled =
          schemaContextEnabled &&
          availableSchemaTables.length > 0 &&
          Boolean(connectionId);
        const toolAvailability = agentToolAvailability(activeDbType);
        const recordLookupRequest = workspaceToolsEnabled && isAgentRecordLookupRequest(normalizedPrompt);
        const workspaceToolStatus = workspaceToolsEnabled
              ? toolAvailability.sqlRead
                ? "Database tools are available if grounded workspace evidence is needed."
                : `Database tools are available on ${toolAvailability.engineLabel}, but SQL tools (run_readonly_sql, preview_write) are disabled for this engine.`
          : !connectionId
            ? "No active database connection is selected, so respond without workspace tools."
            : !needsWorkspaceContext
              ? "This request is broader than database work, so answer directly unless the user explicitly asks for workspace data."
              : !schemaSharingEnabled
                ? "Schema sharing is disabled for the current provider, so workspace tools are unavailable for this turn."
                : "No verified schema snapshot is available for tool use on this turn.";
        const dataPlaneHints = engineAwareDataPlaneHints(toolAvailability);
        const sharedAgentInstruction = joinAgentInstructions(
          dataPlaneHints.gather,
          dataPlaneHints.mustRead,
          dataPlaneHints.finishSql,
          !isLocalProvider
            ? "Be efficient: a few targeted tool calls are better than exploring every table, but never skip running the query that produces the answer."
            : undefined,
          wantsVisualization
            ? toolAvailability.sqlRead
              ? "For a chart or visualization request, run a chart-friendly aggregate query (e.g. GROUP BY ... COUNT(*)) and return that exact SQL in finish.args.sql plus a short chart recommendation."
              : "For a chart or visualization request, sample the relevant data and describe the chart in finish.args.response. Omit finish.args.sql."
            : undefined,
          wantsMetricsBoard
            ? toolAvailability.sqlRead
              ? "This is a metrics/dashboard/summary request. Inspect the relevant tables, then in finish.args.metricsWidgets return 3-6 widgets that form a useful board. Each widget needs a clear title, a type (scoreboard for single totals, bar/pie/line for grouped aggregates, table for detailed breakdowns), and a runnable read-only query grounded in the verified schema. Build the board yourself; do not ask the user which widgets they want."
              : "This is a metrics/dashboard/summary request. Inspect the relevant tables with describe_table and sample_table_data, then summarize in finish.args.response. Omit SQL-shaped widget queries."
            : undefined
        );
        // Summaries already fetched while preparing schema context are injected
        // into every controller prompt so the agent does not spend tool steps
        // re-describing tables it can already see.
        const cachedTableSummaries = workspaceToolsEnabled && relationalSchemaSummaryByTable.size > 0
          ? [...relationalSchemaSummaryByTable.entries()]
              .filter(([tableName]) => availableSchemaTables.includes(tableName))
              .map(([, summary]) => summary)
          : undefined;

        // Verified business semantics for this connection/database scope are
        // injected so analyses never contradict curated definitions.
        const glossaryLines = workspaceToolsEnabled && connectionId
          ? await getSemanticGlossary(connectionId, currentDatabase || undefined)
              .then((entries) => entries.slice(0, 24).map((entry) =>
                `- ${entry.term}${entry.kind !== "term" ? ` (${entry.kind})` : ""}: ${entry.definition}`,
              ))
              .catch(() => [] as string[])
          : undefined;

        // Agent Skills: frontmatter-only catalog (progressive disclosure — the
        // agent loads the full SKILL.md body through the skill tool on demand).
        const availableSkills = await invokeMutation<
          { name: string; description: string }[]
        >("list_ai_skills", {}).catch(() => [] as { name: string; description: string }[]);

        const buildControllerPrompt = (
          forceFinish: boolean,
          extraInstruction?: string,
          steps: AgentTraceStep[] = agentTraceSteps,
        ) =>
          buildAgentControllerPrompt({
            userPrompt: promptForRequest,
            assistIntent,
            currentDatabase,
            availableTableNames: agentPromptTableNames.length > 0 ? agentPromptTableNames : availableSchemaTables,
            steps,
            workspaceToolsEnabled,
            workspaceToolStatus,
            toolAvailability,
            forceFinish,
            extraInstruction,
            cachedTableSummaries,
            glossaryLines,
            availableSkills,
          });

        // Model-call layer: transient retry + parse-repair (extracted).
        const { requestAgentAction } = createAgentActionRequestor({
          askAI,
          context,
          strictRecoveryContext,
          requestId,
          requestIdRef,
          requestHistory,
        });
        const { runAgentTool } = createAgentToolExecutor({
          connectionId,
          currentDatabase,
          latestTables,
          availableSchemaTables,
          relationalSchemaSummaryByTable,
          inspectedAgentTables,
          requestId,
          requestIdRef,
          requestDataReadConsent,
          publishAgentProgress,
          getTableColumnsPreview,
          getTableStructure,
          getTableData,
          executeReadonlyQuery: executeAgentReadonlyQuery,
          previewWriteTransaction,
          toolAvailability,
        });

        const recoverAgentFinishAction = async (reason: string): Promise<AIAgentFinishAction> => {
          const allowedTables = agentPromptTableNames.length > 0 ? agentPromptTableNames : availableSchemaTables;
          const fallbackResponse = buildLocalAgentFallbackResponse({
            language: appLanguage,
            currentDatabase,
            availableTableNames: allowedTables,
            wantsVisualization,
            steps: agentTraceSteps,
          });
          const failoverNoteSuffix = failoverNoteLines.length > 0
            ? `\n\n*${failoverNoteLines.join(" ")}*`
            : "";

          try {
            const recoveredResponse = await askAI(
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
              []
            );
            if (requestId !== requestIdRef.current) {
              throw new Error(AI_REQUEST_REPLACED_MESSAGE);
            }

            const trimmedResponse = recoveredResponse.trim() || fallbackResponse;
            // When providers died mid-run, surface the automatic switch right
            // under the recovery answer in a quiet, italic side note.
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

            return {
              action: "finish",
              message: reason,
              args: {
                response: `${fallbackResponse}${failoverNoteSuffix}`,
              },
            };
          }
        };

        // Opening acknowledgement: let the model restate what it understood and
        // sketch a short plan before any tool runs, so the user sees it "get it"
        // the way Claude's agent does, instead of silently working.
        if (workspaceToolsEnabled) {
          publishAgentProgress({ action: "plan", message: "" });
          try {
            const planText = await askAI(
              buildAgentPlanPrompt({
                userPrompt: normalizedPrompt,
                assistIntent,
                currentDatabase,
                availableTableNames: agentPromptTableNames.length > 0 ? agentPromptTableNames : availableSchemaTables,
                appLanguage,
              }),
              strictRecoveryContext || context,
              "panel",
              "explain",
              []
            );
            if (requestId !== requestIdRef.current) {
              throw new Error(AI_REQUEST_REPLACED_MESSAGE);
            }
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
            // A failed plan turn is non-fatal; carry on with the tool loop.
          }
        }

        const instructionForRunnerRequest = (reason: AIAgentActionRequestReason) =>
          buildRunnerInstructionForReason(reason, sharedAgentInstruction);

        let consecutiveActionFailures = 0;
        let endedWithAskUser = false;
        // Provider failover: each failure promotes the NEXT enabled provider
        // (selector follows, note line recorded) and re-runs the step, until
        // every enabled provider has had a turn as primary. Only then does the
        // run fall back to the canned recovery answer.
        const failedProviderIds = new Set<string>();
        const failoverNoteLines: string[] = [];
        let providerRetryCount = 0;
        // A provider the user picked manually during this run must not be
        // silently rotated away by automatic failover.
        const runStartedAt = Date.now();

        // Announce a manual provider pick (mid-run) in the same step log the
        // automatic failover note uses, so the conversation shows the switch.
        const handleManualProviderSwitch = (event: Event) => {
          const detail = (event as CustomEvent<{ providerLabel?: string }>).detail;
          const nextLabel = detail?.providerLabel?.trim();
          if (!nextLabel) return;
          const note = appLanguage === "vi"
            ? `Bạn đã chọn provider "${nextLabel}" — các bước tiếp theo sẽ chạy trên provider này.`
            : `You switched to provider "${nextLabel}" — the following steps run on it.`;
          failoverNoteLines.push(note);
          publishAgentProgress({ action: "think", message: note });
        };
        window.addEventListener("ai-provider-switched-during-run", handleManualProviderSwitch);

        let agentRunnerResult: Awaited<ReturnType<typeof runAIAgentToolLoop>> | undefined;
        try {
          agentRunnerResult = await runAIAgentToolLoop({
          workspaceToolsEnabled,
          stepBudget: agentStepBudget,
          tokenBudget: DEFAULT_AGENT_TOKEN_BUDGET,
          // streamingUsage holds the most recent model call's raw usage; the
          // runner accumulates this after each action request.
          getLastRequestTokens: () =>
            extractAgentUsageTokens(useAIStore.getState().streamingUsage),
          initialSteps: agentTraceSteps,
          requestAction: async ({ forceFinish, includeHistory, iteration, reason, steps }) => {
            const completedToolSteps = steps.filter((step) => step.action !== "plan");
            if (recordLookupRequest && iteration === 1 && completedToolSteps.length === 0) {
              return Promise.resolve({
                action: "search_schema" as const,
                message: "Locating the exact table and columns for this record",
                args: { query: normalizedPrompt },
              });
            }

            const controllerPrompt = buildControllerPrompt(
              forceFinish,
              instructionForRunnerRequest(reason),
              steps,
            );
            try {
              // Images ride only the first controller call of the run; later
              // steps see the tools' observations instead (token cost once).
              const action = await requestAgentAction(
                controllerPrompt,
                includeHistory,
                undefined,
                iteration === 1 && imageAttachments.length > 0 ? imageAttachments : undefined,
              );
              consecutiveActionFailures = 0;
              if (action.action === "ask_user") {
                // The harness runs one agent turn per user message, so a
                // clarifying question ends the turn: the reply arrives as the
                // next message with full history attached.
                endedWithAskUser = true;
                const optionsBlock = action.args.options?.length
                  ? `\n\n${action.args.options.map((option, index) => `${index + 1}. ${option}`).join("\n")}`
                  : "";
                const suffix = appLanguage === "vi"
                  ? "\n\n_(Trả lời bằng số thứ tự hoặc nội dung của bạn.)_"
                  : "\n\n_(Reply with an option number or your own answer.)_";
                agentTraceSteps = [
                  ...steps,
                  {
                    step: steps.length + 1,
                    action: "ask_user",
                    message: action.args.question,
                    observation: "",
                  },
                ];
                publishAgentProgress();
                return {
                  action: "finish" as const,
                  message: action.message || "Asking the user for clarification.",
                  args: { response: `${action.args.question}${optionsBlock}${suffix}` },
                };
              }
              return action;
            } catch (errorValue) {
              if (isSupersededAIRequestError(errorValue)) throw errorValue;
              const requestError = normalizeAIRequestError(errorValue);
              // Anything except a user-initiated cancel is worth a promoted
              // re-run: rate limits surface as "provider", garbage bodies as
              // "invalid-response", and odd transport failures as "unknown" -
              // refusing to retry on those was exactly the silent-stop bug.
              const failoverEligible = requestError.code !== "cancelled";

              // A dead or rate-limited provider must not end the run: exactly
              // once per run, promote the next configured provider, tell the
              // user inline, wait out the transient window, then re-run this
              // same step. Later failures retry on the promoted provider
              // instead of rotating providers again.
              const enabledProviderCount = useAIStore
                .getState()
                .aiConfigs.filter((config) => config.is_enabled).length;
              const canPromoteFurther =
                providerRetryCount < Math.max(0, enabledProviderCount - 1);

              const userPickedProviderDuringRun =
                getManualProviderOverrideAt() > runStartedAt;

              if (failoverEligible && canPromoteFurther && !userPickedProviderDuringRun) {
                // The very first failure asks for permission before the agent
                // ever switches providers on its own. An approval (or decline)
                // is remembered, so the question never comes back.
                let failoverAllowed = getAIFailoverConsent() === "approved";
                if (!failoverAllowed && getAIFailoverConsent() === "unset") {
                  failoverAllowed = await requestAIFailoverConsent();
                }
                if (failoverAllowed) {
                  providerRetryCount += 1;
                  const failedProvider = getActiveAIProvider(useAIStore.getState().aiConfigs);
                  if (failedProvider) failedProviderIds.add(failedProvider.id);
                  const promoted = useAIStore.getState().promoteNextEnabledProvider();
                  failoverNoteLines.push(
                    formatProviderFailoverNote(appLanguage, failedProvider, promoted),
                  );
                  publishAgentProgress({
                    action: "think",
                    message: failoverNoteLines[failoverNoteLines.length - 1],
                  });
                  await new Promise((resolve) =>
                    setTimeout(resolve, PROVIDER_RETRY_DELAY_MS),
                  );
                  try {
                    const promotedRetryAction = await requestAgentAction(controllerPrompt, false);
                    consecutiveActionFailures = 0;
                    return promotedRetryAction;
                  } catch (promotedRetryError) {
                    if (isSupersededAIRequestError(promotedRetryError)) throw promotedRetryError;
                    const promotedFailedProvider = getActiveAIProvider(
                      useAIStore.getState().aiConfigs,
                    );
                    // The promoted provider also failed - keep its REAL reason so
                    // the recovery note can tell the user what to go fix.
                    failoverNoteLines.push(
                      formatProviderFollowUpNote(
                        appLanguage,
                        promotedFailedProvider,
                        formatActionFailureReason(promotedRetryError),
                      ),
                    );
                    // Fall through to the standard same-provider retry below.
                  }
                }
                // Declined: stay on the failing provider and fall through to
                // the ordinary same-provider retry / recovery path below.
              }

              // One bad model turn must not discard the evidence already
              // gathered: retry the same prompt once, then salvage the run
              // through the finish-recovery path instead of failing outright.
              consecutiveActionFailures += 1;
              if (consecutiveActionFailures >= 2) {
                return recoverAgentFinishAction(
                  `The agent could not return a valid action: ${formatActionFailureReason(errorValue)}`,
                );
              }
              try {
                const retriedAction = await requestAgentAction(controllerPrompt, false);
                consecutiveActionFailures = 0;
                return retriedAction;
              } catch (retryError) {
                if (isSupersededAIRequestError(retryError)) throw retryError;
                failoverNoteLines.push(
                  formatProviderFollowUpNote(
                    appLanguage,
                    getActiveAIProvider(useAIStore.getState().aiConfigs),
                    formatActionFailureReason(retryError),
                  ),
                );
                return recoverAgentFinishAction(
                  `The agent could not return a valid action: ${formatActionFailureReason(retryError)}`,
                );
              }
            }
          },
          runTool: runAgentTool,
          recoverFinish: recoverAgentFinishAction,
          onStateChange: (snapshot) => {
            agentTraceSteps = snapshot.steps.map((step) => ({ ...step }));
            if (snapshot.phase === "running-tool" && snapshot.action) {
              publishAgentProgress({
                action: snapshot.action,
                message: snapshot.message || "No message provided.",
              });
            } else if (snapshot.phase === "tool-completed") {
              publishAgentProgress();
            } else if (snapshot.phase === "requesting-action") {
              // The model call is the longest part of every step; show it
              // explicitly so the trace never looks frozen between tools.
              publishAgentProgress({
                action: "think",
                message:
                  snapshot.requestReason === "budget"
                    ? "Tool budget reached — wrapping up with the evidence gathered."
                    : snapshot.requestReason === "direct"
                      ? "Composing response."
                      : `Deciding next action (step ${Math.min(snapshot.iteration, snapshot.stepBudget)}).`,
              });
            } else if (snapshot.phase === "recovering-finish") {
              publishAgentProgress({ action: "think", message: "Finalizing answer." });
            }
          },
        });
        } finally {
          // Always detach, including when the run throws mid-loop; otherwise a
        // failed run leaks its manual-switch listener (and its closures).
          window.removeEventListener("ai-provider-switched-during-run", handleManualProviderSwitch);
        }
        if (!agentRunnerResult) {
          throw new Error("Agent runner returned no result");
        }
        agentTraceSteps = agentRunnerResult.steps;
        let finalAction = agentRunnerResult.finalAction;
        let finalSteps = agentRunnerResult.steps;
        if (endedWithAskUser && typeof finalAction.args?.response === "string") {
          const askStep: AgentTraceStep = {
            step: finalSteps.length + 1,
            action: "ask_user",
            message: finalAction.args.response,
            observation: "",
          };
          finalSteps = [...finalSteps, askStep];
          agentTraceSteps = [...agentTraceSteps, askStep];
        }

        // Quality gate: a data-seeking request must not end in a finish that
        // neither executed a read nor proposed SQL — that is how runs used to
        // stop with "I have enough data" and no deliverable. The gate retries
        // a bounded number of rounds, then accepts the best available answer.
        // Quality gate: bounded evidence-recovery rounds via ai-agent-evidence-loop.
        const wantsReportTable = /(báo cáo|bảng báo cáo|report|tổng hợp|summary|dashboard)/i.test(normalizedPrompt);

        ({ finalAction, finalSteps } = await runAgentEvidenceLoop({
          workspaceToolsEnabled,
          endedWithAskUser,
          assistIntent,
          wantsReportTable,
          sharedAgentInstruction,
          initialAction: finalAction,
          initialSteps: finalSteps,
          requestAgentAction,
          buildControllerPrompt,
          isSupersededAIRequestError,
          runAgentTool,
          publishAgentProgress,
          recoverAgentFinishAction,
        }));

        // Best-effort debug artifact: persist the full snapshot stream so
        // failed or surprising runs can be replayed offline.
        try {
          const traceLines = [
            JSON.stringify({
              kind: "meta",
              at: new Date().toISOString(),
              prompt: normalizedPrompt,
              intent: assistIntent,
              connectionId,
              database: currentDatabase,
              workspaceToolsEnabled,
            }),
            ...agentRunnerResult.snapshots.map((snapshot) =>
              JSON.stringify({
                kind: "snapshot",
                phase: snapshot.phase,
                iteration: snapshot.iteration,
                action: snapshot.action ?? null,
                steps: snapshot.steps,
              }),
            ),
            JSON.stringify({ kind: "final", steps: finalSteps }),
          ].join("\n");
          void invokeMutation<string>("save_agent_trace", { requestId, content: traceLines }).catch(
            () => undefined,
          );
        } catch {
          // Tracing must never break the run.
        }

        const finalization = await finalizeAgentResult({
          availableSchemaTables,
          buildControllerPrompt,
          initialAction: finalAction,
          initialSteps: finalSteps,
          recoverFinishAction: recoverAgentFinishAction,
          requestAgentAction,
          sharedAgentInstruction,
          validateSql: async (proposedSql) => {
            // Mutating proposals are already guarded by preview/confirmation
            // flows; the pre-flight only verifies read-only SQL.
            if (isMutatingStatement(proposedSql) || isHighRiskStatement(proposedSql)) {
              return null;
            }
            if (!connectionId || requestId !== requestIdRef.current) {
              return null;
            }
            if (requestDataReadConsent) {
              const approved = await requestDataReadConsent();
              if (!approved) return null;
            }
            if (requestId !== requestIdRef.current) {
              return null;
            }
            try {
              await executeSandboxQuery(connectionId, [proposedSql], true);
              return null;
            } catch (errorValue) {
              if (isSupersededAIRequestError(errorValue)) {
                throw errorValue;
              }
              return formatExecutionError(errorValue);
            }
          },
        });
        const hasValidSql = Boolean(finalization.sql);

        return {
          prompt: normalizedPrompt,
          rawResponse: finalization.rawResponse,
          sql: finalization.sql,
          risk: hasValidSql && finalization.sql ? analyzeGeneratedSql(finalization.sql) : undefined,
          intent: assistIntent,
          reasoning: lastReasoningRef.current,
          agentSteps: finalization.agentSteps,
          agentWidgets: finalization.agentWidgets,
        };

      }
      const finalResponse = await recoverNonAgentAssistResponse({
        appLanguage,
        askAI: (requestPrompt, requestContext, requestHistory) => askAI(requestPrompt, requestContext, "panel", assistIntent, requestHistory),
        availableSchemaTables,
        context,
        currentDatabase,
        fastRemoteRecovery,
        intent: assistIntent,
        isCurrentRequest: () => requestId === requestIdRef.current,
        normalizedPrompt: promptForRequest,
        requestHistory,
        schemaContextEnabled,
        strictRecoveryContext,
        wantsVisualization,
      });
      const extractedSql = extractSqlFromResponse(finalResponse);
      const hasValidSql = hasSqlStartKeyword(extractedSql);
      const shouldAttachSql =
        hasValidSql &&
        (
          assistIntent === "sql" ||
          assistIntent === "optimize" ||
          assistIntent === "fix-error" ||
          wantsVisualization
        );

      return {
        prompt: normalizedPrompt,
        rawResponse: finalResponse,
        sql: shouldAttachSql ? extractedSql : null,
        risk: hasValidSql ? analyzeGeneratedSql(extractedSql) : undefined,
        intent: assistIntent,
        reasoning: lastReasoningRef.current,
      };
    } catch (errorValue) {
      if (isSupersededAIRequestError(errorValue)) {
        throw (errorValue instanceof Error ? errorValue : new Error(AI_REQUEST_REPLACED_MESSAGE));
      }

      const requestError = normalizeAIRequestError(errorValue);
      setError(requestError.message);
      throw requestError;
    } finally {
      if (requestId === requestIdRef.current) {
        setIsGenerating(false);
      }
    }
  }, [activeDbType, activeProvider, aiConfigs, askAI, connectionId, currentDatabase, executeAgentReadonlyQuery, executeSandboxQuery, fetchTables, getTableColumnsPreview, getTableData, getTableStructure, isLocalProvider, previewWriteTransaction, saveAIConfigs]);

  const copyText = useCallback(async (text: string) => {
    await navigator.clipboard.writeText(text);
  }, []);

  const insertSql = useCallback((sql: string, risk?: SqlRiskAnalysis) => {
    const computedRisk = risk ?? analyzeGeneratedSql(sql);
    if (computedRisk.level === "dangerous") {
      const message = computedRisk.reason || "Potentially destructive SQL cannot be inserted directly.";
      setError(message);
      return false;
    }
    window.dispatchEvent(new CustomEvent("insert-sql-from-ai", { detail: { sql } }));
    return true;
  }, []);

  return {
    activeProvider,
    tableContextCount,
    connectionId,
    currentDatabase,
    error,
    setError,
    isGenerating,
    isCancelling: requestPhase === "cancelling",
    isRunning,
    cancelGeneration,
    generateAssist,
    copyText,
    insertSql,
    runSql,
  };
}
