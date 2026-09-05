import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { getCurrentAppLanguage } from "../../../i18n";
import { getManualProviderOverrideAt, useAIStore } from "../../../stores/aiStore";
import { useConnectionStore } from "../../../stores/connectionStore";
import { useAIChatWorkspaceStore } from "../../../stores/aiChatWorkspaceStore";
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
  canonicalizeAgentArgs,
  isRepeatTrackedAction,
  mergeRunNotes,
  previewAgentArgs,
  REPEAT_CALL_GENTLE_REMINDER,
  repeatCallDetailedReminder,
  type AgentTraceStep,
  type AssistIntent,
} from "../ai-agent-context";
import {
  runAIAgentToolLoop,
  type AIAgentActionRequestReason,
} from "../ai-agent-runner";
import { getAgentMemoryIndex } from "./use-agent-memory";
import { emitAppToast } from "../../../utils/app-toast";
import { useUIStore } from "../../../stores/uiStore";
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

// Skill catalogs rarely change mid-session; caching for a minute keeps the
// per-run filesystem discovery scan from repeating on every agent run.
let skillsCatalogCache: {
  at: number;
  entries: { name: string; description: string; source: string }[];
} | null = null;
const SKILLS_CATALOG_TTL_MS = 60_000;

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
const MAX_REMOTE_AGENT_STEPS = 10;
const MAX_LOCAL_COMPLEX_AGENT_STEPS = 14;
const MAX_REMOTE_COMPLEX_AGENT_STEPS = 12;

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
  const { getTableStructure, getTableColumnsPreview, getTableData, executeSandboxQuery, executeAgentReadonlyQuery, executeAgentParameterizedQuery, previewWriteTransaction } = useQueryStore(
    useShallow((state) => ({
      getTableStructure: state.getTableStructure,
      getTableColumnsPreview: state.getTableColumnsPreview,
      getTableData: state.getTableData,
      executeSandboxQuery: state.executeSandboxQuery,
      executeAgentReadonlyQuery: state.executeAgentReadonlyQuery,
      executeAgentParameterizedQuery: state.executeAgentParameterizedQuery,
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

  const listCheckpoints = useCallback(
    (listConnectionId: string) =>
      invokeMutation<Array<{ fileName: string; label: string; createdAt: number; engine: string; database: string | null; tableCount: number; rowCount: number; sizeBytes: number }>>(
        "list_database_checkpoints",
        { connectionId: listConnectionId },
      ),
    [],
  );
  const restoreCheckpoint = useCallback(
    async (restoreConnectionId: string, fileName: string, restoreDbType: string) => {
      const result = await invokeMutation<{ warning?: string | null }>(
        "restore_database_checkpoint",
        {
          connectionId: restoreConnectionId,
          fileName,
          dbType: restoreDbType,
        },
      );
      // The rollback itself succeeded, but its safety snapshot may not have —
      // the user must know /rollback has no fresh fallback point.
      if (result?.warning) {
        emitAppToast({
          tone: "error",
          title: "Pre-restore snapshot failed",
          description: result.warning,
          durationMs: 10_000,
        });
      }
      return result;
    },
    [],
  );

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
      options?: { correlationId?: string },
    ): Promise<string> => {
      const { text, reasoning } = await askAIWithReasoning(prompt, context, mode, intent, history, attachments, options);
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
        // Live checklist posted through update_plan — re-read on every
        // controller prompt build so the model always sees current statuses.
        let agentPlanLines: string[] = [];
        // Seed inspection state from the schema context: tables whose verified
        // summaries were already fetched (and injected into the controller
        // prompt as "Pre-inspected tables — do NOT call describe_table for
        // these") count as inspected, so run_readonly_sql's describe-gate can
        // never contradict the prompt by blocking a read the prompt itself
        // encouraged. Keys use the same workspace identifier format as
        // availableSchemaTables, matching findMatchingTableName results.
        const inspectedAgentTables = new Set<string>(relationalSchemaSummaryByTable.keys());
        // Snapshot completed steps plus an optional in-flight step, then stream
        // them to the UI so the bubble can show the agent working live.
        // Manual provider switches are kept separately because agentTraceSteps
        // is overwritten by the runner's snapshots and would drop the note.
        const manualSwitchNotes: AgentTraceStep[] = [];
        const publishAgentProgress = (pending?: { action: AIWorkspaceAgentActionName; message: string }) => {
          if (!onAgentProgress) return;
          const completed: AIWorkspaceAgentStep[] = [
            ...agentTraceSteps.map((step): AIWorkspaceAgentStep => ({
              step: step.step,
              action: step.action,
              message: step.message,
              observation: step.observation,
              status: step.observation.startsWith("Tool error") || step.observation.startsWith("Tool blocked")
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
          // Renumber sequentially: runner snapshots grow over time, so the
          // stored note ordinals would otherwise collide with runner steps
          // and produce duplicate React keys in the step list.
          completed.forEach((step, index) => {
            step.step = index + 1;
          });
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
        // Security: only GLOBAL skills are injected. Workspace skill folders
        // ship inside repositories the user merely opened, so their
        // descriptions must never reach the prompt without an explicit
        // opt-in surface. The command is called without a workspace_dir, so
        // discovery already scans the global root only — the filter keeps
        // that guarantee explicit on the client side as well.
        const availableSkills = workspaceToolsEnabled
          ? await (async () => {
              if (skillsCatalogCache && Date.now() - skillsCatalogCache.at < SKILLS_CATALOG_TTL_MS) {
                return skillsCatalogCache.entries;
              }
              try {
                const entries = await invokeMutation<
                  { name: string; description: string; source: string }[]
                >("list_ai_skills", {});
                skillsCatalogCache = { at: Date.now(), entries };
                return entries;
              } catch (error) {
                console.warn("[AIWorkspace] skill catalog unavailable:", error);
                return [] as { name: string; description: string; source: string }[];
              }
            })().then((entries) =>
              entries
                .filter((entry) => entry.source === "global")
                .slice(0, 32),
            )
          : undefined;

        // Agent memory: frontmatter-only index for THIS (connection, database)
        // scope — same progressive-disclosure contract as skills (see
        // use-agent-memory.ts for the scope-keyed TTL cache contract).
        const agentMemoryIndex = await getAgentMemoryIndex({
          workspaceToolsEnabled,
          connectionId,
          database: currentDatabase ?? null,
        });

        // Open query tabs on this connection: edit_query_sql needs their
        // tabIds and the current SQL so the model can propose targeted fixes.
        const queryTabs = workspaceToolsEnabled
          ? useUIStore
              .getState()
              .tabs.filter((tab) => tab.type === "query" && tab.connectionId === connectionId)
              .slice(0, 8)
              .map((tab) => {
                const fullSql = tab.content ?? "";
                // Long tabs are truncated WITH a loud marker, so the model
                // never mistakes a partial view for the whole file and never
                // proposes a full replacement built on unseen tail content.
                const sql =
                  fullSql.length > 2_000
                    ? `${fullSql.slice(0, 2_000)}\n…[TRUNCATED — showing 2,000 of ${fullSql.length} chars. Never propose a full replacement for content you have not seen.]`
                    : fullSql;
                return { tabId: tab.id, title: tab.title, sql };
              })
          : undefined;

        // Honest database-mismatch signal: if the user explicitly names a
        // database other than the one this request is scoped to, the prompt
        // says so instead of letting schema evidence silently contradict them.
        const workspaceStoreState = useAIChatWorkspaceStore.getState();
        const workspaceBoundDatabase = workspaceStoreState
          .workspaces.find(
            (workspace) => workspace.id === workspaceStoreState.activeWorkspaceId,
          )?.database ?? null;
        const knownDatabaseNames = useConnectionStore.getState().databases.map((item) => item.name);

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
          });

        // Model-call layer: transient retry + parse-repair (extracted).
        // Retry waits are published as transient "think" steps so a slow
        // rate-limited provider never looks like a frozen run.
        const { requestAgentAction } = createAgentActionRequestor({
          askAI,
          context,
          strictRecoveryContext,
          requestId,
          requestIdRef,
          requestHistory,
          // Stamps every model call of this run so chain-failover events from
          // parallel non-agent requests never leak into this trace.
          correlationId: `agent-run-${requestId}`,
          onRetryWait: ({ delayMs, reason, retry, maxRetries }) => {
            const seconds = Math.max(1, Math.round(delayMs / 1000));
            const transientNote = appLanguage === "vi"
              ? reason === "rate-limit"
                ? `Bị rate limit — chờ ${seconds}s rồi thử lại…`
                : `Lỗi tạm thời từ provider — thử lại sau ${seconds}s…`
              : reason === "rate-limit"
                ? `Rate limited — waiting ${seconds}s before retrying…`
                : `Transient provider error — retrying in ${seconds}s…`;
            publishAgentProgress({ action: "think", message: transientNote });
            // Settled note: survives reloads through the persisted trace.
            const settledNote = appLanguage === "vi"
              ? `Đã chờ ${seconds}s do ${reason === "rate-limit" ? "rate limit" : "lỗi tạm thời"} trước khi thử lại (lần ${retry}/${maxRetries}).`
              : `Waited ${seconds}s due to ${reason === "rate-limit" ? "rate limiting" : "a transient error"} before retrying (attempt ${retry}/${maxRetries}).`;
            manualSwitchNotes.push({
              step: agentTraceSteps.length + manualSwitchNotes.length + 1,
              action: "think",
              message: settledNote,
              observation: "In-line retry wait.",
            });
          },
        });
        const { runAgentTool } = createAgentToolExecutor({
          // Fail-closed: an absent catalog means NO skill may load, otherwise
          // a model could call the skill tool for entries never vetted.
          allowedSkillNames: availableSkills?.map((entry) => entry.name) ?? [],
          // Memory tools must operate on the run's (connection, database)
          // scope — a null scope would orphan saves into global/default.
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
            // dispatchEvent runs listeners synchronously, so a handled event
            // has already added the tab to the UI store. Verify instead of
            // blindly returning true: if no new query tab appeared, report
            // failure so the agent's observation cannot claim a tab that was
            // never opened.
            return useUIStore
              .getState()
              .tabs.some((tab) => tab.type === "query" && !tabIdsBefore.has(tab.id));
          },
          requestDataReadConsent,
          publishAgentProgress,
          onAgentPlanUpdate: (plan) => {
            agentPlanLines = plan.map((step, index) =>
              `${index + 1}. [${step.status}] ${step.title}`);
          },
          createCheckpoint: (label) => {
            const state = useConnectionStore.getState();
            const dbType = state.connections.find(
              (connection) => connection.id === connectionId,
            )?.db_type;
            if (!connectionId || !dbType) {
              return Promise.reject(new Error("No active connection for checkpoint."));
            }
            return invokeMutation<{ fileName: string; label: string; tableCount: number; rowCount: number }>(
              "create_database_checkpoint",
              {
                connectionId,
                database: state.currentDatabase || null,
                dbType,
                label: label ?? null,
              },
            );
          },
          listCheckpoints,
          restoreCheckpoint,
          language: appLanguage,
          delegateSubAnalysis: async (instruction, focusTables) => {
            const delegatePrompt = [
              "You are a side-analysis helper for a workspace agent. The agent hands you focused, self-contained questions mid-run.",
              focusTables.length > 0 ? `Focus tables: ${focusTables.join(", ")}.` : "",
              "Answer in at most 8 short lines of plain text (no SQL fences, no tool talk).",
              "Ground everything in the attached schema context; if it is not enough, say exactly what is missing instead of inventing tables or columns.",
              "",
              "Instruction:",
              instruction,
            ].filter(Boolean).join("\n");
            return askAI(
              delegatePrompt,
              strictRecoveryContext || context,
              "panel",
              "general",
              [],
              undefined,
              // Same correlation as the run's own model calls so failover
              // notes stay in this run's trace.
              { correlationId: `agent-run-${requestId}` },
            );
          },
          getTableColumnsPreview,
          getTableStructure,
          getTableData,
          executeReadonlyQuery: executeAgentReadonlyQuery,
          executeParameterizedReadonlyQuery: executeAgentParameterizedQuery,
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
              [],
              undefined,
              { correlationId: `agent-run-${requestId}` },
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
        // Repeat-call guard (learned from deepseek-harness): a chain of
        // identical tool calls injects a corrective reminder into the next
        // controller prompt — gentle at 3 repeats, detailed at 5.
        let repeatChain: { key: string; count: number } | null = null;
        let pendingRepeatReminder: string | null = null;
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

        // Announce a manual provider pick (mid-run) as a settled step in the
        // live trace, so the conversation shows the switch right below the
        // running step — like the automatic failover note. The in-flight model
        // call is cancelled so the current step re-runs on the new provider
        // instead of finishing on the old one (the action loop retries it).
        const handleManualProviderSwitch = (event: Event) => {
          const detail = (event as CustomEvent<{ providerLabel?: string }>).detail;
          const nextLabel = detail?.providerLabel?.trim();
          if (!nextLabel) return;
          const note = appLanguage === "vi"
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

        // The request-level failover chain (aiStore) moves to the next
        // enabled provider when one hangs or errors; surface that as a
        // settled step note so the wait is never silent.
        const handleChainFailoverNote = (event: Event) => {
          const detail = (event as CustomEvent<{
            failedProvider?: string;
            failedModel?: string | null;
            reason?: string;
            attempt?: number;
            total?: number;
            correlationId?: string;
          }>).detail;
          // Only failovers of THIS run's own model calls — parallel requests
          // (SQL explain, dashboard previews) must not leak into the trace.
          if (!detail?.correlationId || detail.correlationId !== `agent-run-${requestId}`) return;
          const failed = detail.failedProvider?.trim();
          if (!failed) return;
          // The chain now walks provider → its other models → next provider, so
          // the failed stop may be a model switch, not a provider switch.
          const failedModel = detail.failedModel?.trim();
          const failedLabel = failedModel ? `${failed} (model ${failedModel})` : failed;
          const attemptLabel = `${detail?.attempt ?? "?"}/${detail?.total ?? "?"}`;
          const note = appLanguage === "vi"
            ? `Provider "${failedLabel}" lỗi (${detail?.reason ?? "không xác định"}) — đang thử model/provider tiếp theo (${attemptLabel})…`
            : `Provider "${failedLabel}" failed (${detail?.reason ?? "error"}) — trying the next model/provider (${attemptLabel})…`;
          manualSwitchNotes.push({
            step: agentTraceSteps.length + manualSwitchNotes.length + 1,
            action: "think",
            message: note,
            observation: "Model/provider failover within the request chain.",
          });
          publishAgentProgress();
        };
        window.addEventListener("ai-provider-chain-failover", handleChainFailoverNote);

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

            let controllerPrompt = buildControllerPrompt(
              forceFinish,
              instructionForRunnerRequest(reason),
              steps,
            );
            if (pendingRepeatReminder) {
              controllerPrompt = `${controllerPrompt}\n\n${pendingRepeatReminder}`;
              pendingRepeatReminder = null;
            }
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
              // Advance the repeat-call chain for tracked (tool-argument)
              // actions; meta actions leave it untouched (dsh semantics).
              if (isRepeatTrackedAction(action.action)) {
                const key = JSON.stringify([action.action, canonicalizeAgentArgs(action.args)]);
                repeatChain = repeatChain?.key === key
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
              // A bare finish (no response, no message, no SQL) throws away
              // every observation the run gathered. Flaky models emit these
              // under long step histories — give them one force-finish chance
              // to summarize the evidence before the canned fallback takes over.
              if (
                action.action === "finish"
                && !String(action.args?.response ?? "").trim()
                && !String(action.message ?? "").trim()
                && !action.args?.sql
                && steps.some((step) => step.action !== "plan" && step.action !== "think")
              ) {
                try {
                  const repairedFinish = await requestAgentAction(
                    buildControllerPrompt(
                      true,
                      joinAgentInstructions(
                        sharedAgentInstruction,
                        "Your finish action contained no user-facing response. Return the finish action again with args.response summarizing the findings from the observations above, in the user's language.",
                      ),
                    ),
                    false,
                  );
                  const repairedHasPayload =
                    repairedFinish.action === "finish"
                    && (
                      Boolean(String(repairedFinish.args?.response ?? "").trim())
                      || Boolean(String(repairedFinish.message ?? "").trim())
                      || Boolean(repairedFinish.args?.sql)
                    );
                  if (repairedHasPayload) return repairedFinish;
                } catch (repairError) {
                  if (isSupersededAIRequestError(repairError)) throw repairError;
                  // Repair call failed — the local evidence summary below takes over.
                }
                // The model could not summarize even with the repair nudge.
                // Never end on a canned non-answer: build the floor response
                // from the run's own trace (bilingual, evidence-backed).
                const failoverNoteSuffix = failoverNoteLines.length > 0
                  ? `\n\n*${failoverNoteLines.join(" ")}*`
                  : "";
                return {
                  action: "finish" as const,
                  message: reason,
                  args: {
                    response: `${buildLocalAgentFallbackResponse({
                      language: appLanguage,
                      currentDatabase,
                      availableTableNames: agentPromptTableNames.length > 0 ? agentPromptTableNames : availableSchemaTables,
                      wantsVisualization,
                      steps,
                    })}${failoverNoteSuffix}`,
                  },
                };
              }
              return action;
            } catch (errorValue) {
              if (isSupersededAIRequestError(errorValue)) throw errorValue;
              let requestError = normalizeAIRequestError(errorValue);
              let failureReason = formatActionFailureReason(errorValue);
              // A manual provider switch intentionally cancels the in-flight
              // call: re-run this same step on the newly picked provider right
              // away instead of finishing it on the old one. Not a failure.
              if (requestError.code === "cancelled") {
                if (requestId !== requestIdRef.current) {
                  // The run was stopped or replaced while we waited — unwind.
                  throw new Error(AI_REQUEST_REPLACED_MESSAGE);
                }
                try {
                  return await requestAgentAction(controllerPrompt, false);
                } catch (switchRetryError) {
                  if (isSupersededAIRequestError(switchRetryError)) throw switchRetryError;
                  requestError = normalizeAIRequestError(switchRetryError);
                  if (requestError.code === "cancelled") {
                    // Cancelled again — the run itself was stopped; unwind.
                    throw switchRetryError;
                  }
                  failureReason = formatActionFailureReason(switchRetryError);
                }
              }
              // Anything except a user-initiated cancel is worth a promoted
              // re-run: rate limits surface as "provider", garbage bodies as
              // "invalid-response", and odd transport failures as "unknown" -
              // refusing to retry on those was exactly the silent-stop bug.
              // (A deliberate mid-run switch cancel is fully handled above.)
              const failoverEligible = true;

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
                  `The agent could not return a valid action: ${failureReason}`,
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
          window.removeEventListener("ai-provider-chain-failover", handleChainFailoverNote);
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
          // Persist the run notes (switches, chain failovers, retry waits)
          // alongside the runner trace so they survive reloads.
          agentSteps: mergeRunNotes(finalization.agentSteps ?? [], manualSwitchNotes),
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
  }, [activeDbType, activeProvider, aiConfigs, askAI, cancelAIRequest, connectionId, currentDatabase, executeAgentParameterizedQuery, executeAgentReadonlyQuery, executeSandboxQuery, fetchTables, getTableColumnsPreview, getTableData, getTableStructure, isLocalProvider, previewWriteTransaction, saveAIConfigs]);

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
    listCheckpoints,
    restoreCheckpoint,
  };
}
