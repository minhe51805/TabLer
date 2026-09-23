import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { getCurrentAppLanguage } from "../../../i18n";
import { getManualProviderOverrideAt, useAIStore } from "../../../stores/aiStore";
import { useConnectionStore } from "../../../stores/connectionStore";
import { useAIChatWorkspaceStore } from "../../../stores/aiChatWorkspaceStore";
import { useQueryStore } from "../../../stores/queryStore";
import {
  type AIConversationMessage,
  type AIProviderConfig,
  type AIRequestAttachment,
  type AIRequestIntent,
  type DatabaseType,
  type AIRequestMode,
  type QueryHistoryEntry,
  type QueryResult,
} from "../../../types";
import {
  buildAttachmentFileBlocks,
  toRequestAttachments,
  type AIAttachmentDraft,
} from "../../../utils/ai-attachments";
import { getActiveAIProvider, isLocalAIProvider } from "../../../utils/ai-provider-registry";
import {
  denyPendingAIFailoverConsent,
  getAIFailoverConsent,
  requestAIFailoverConsent,
} from "../../../utils/ai-failover-consent";
import { normalizeAIRequestError } from "../../../utils/ai-request-errors";
import { getSemanticGlossary } from "../../../utils/semantic-glossary";
import { invokeMutation, invokeWithTimeout } from "../../../utils/tauri-utils";
import {
  analyzeGeneratedSql,
  analyzeGeneratedSqlWithBackend,
  type SqlRiskAnalysis,
} from "../AISlidePanelUtils";
import { extractAskUserOptionsFromQuestion } from "../ai-conversation-state";
import { AI_AGENT_ASK_USER_OPTIONS_LIMIT } from "../ai-agent-tool-schema";
import {
  type AIWorkspaceAgentActionName,
  type AIWorkspaceAgentStep,
  type AIWorkspaceFailoverNote,
  type AIWorkspaceRunTraceEntry,
  type AIWorkspaceInteractionMode,
} from "../ai-workspace-types";
import { evaluateRunAgainstRules } from "../ai-agent-rules";
import { getLinkedWorkspaceDir } from "../../../hooks/useLinkedFolders";
import { type AIAgentFinishAction, type AIAgentToolName } from "../ai-agent-tools";
import {
  buildAgentControllerPrompt,
  buildAgentPlanPrompt,
  joinAgentInstructions,
  canonicalizeAgentArgs,
  countTrailingToolErrors,
  isRepeatTrackedAction,
  mergeRunNotes,
  previewAgentArgs,
  REPEAT_CALL_GENTLE_REMINDER,
  repeatCallDetailedReminder,
  toolErrorReflectionNudge,
  TOOL_ERROR_REFLECTION_THRESHOLD,
  type AgentTraceStep,
  type AssistIntent,
} from "../ai-agent-context";
import { runAIAgentToolLoop, type AIAgentActionRequestReason } from "../ai-agent-runner";
import { getAgentMemoryIndex } from "./use-agent-memory";
import { emitAppToast } from "../../../utils/app-toast";
import { useUIStore } from "../../../stores/uiStore";
import { buildInsightScope, useAgentInsightsStore } from "../../../stores/agent-insights-store";
import { useAgentLearningStore } from "../../../stores/agent-learning-store";
import { useSkillPrefsStore } from "../../../stores/skillPrefsStore";
import {
  AGENT_COMPACTION_KEEP_TAIL,
  AGENT_COMPACTION_TOKEN_THRESHOLD,
  DEFAULT_AGENT_TOKEN_BUDGET,
  extractAgentUsageBreakdown,
  extractAgentUsageTokens,
  recordSessionModelUsage,
} from "../ai-agent-cost";
import { isTrivialAssistIntent } from "../ai-assist-intent";
import {
  buildAgentEvidenceSummary,
  buildAgentFinalRecoveryPrompt,
  buildExplainSqlPrompt,
  buildFixSqlPrompt,
  buildLocalAgentFallbackResponse,
  buildOptimizeSqlPrompt,
} from "../ai-assist-prompts";
import type { AIMetricsWidgetSpec } from "../../../utils/metrics-board-templates";
import {
  buildSchemaContextRequiredMessage,
  summarizeAgentExplainPlanStructured,
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
import { manageAgentMetricsBoard } from "../agent-tools/metrics-board-manager";
import {
  createAgentActionRequestor,
  isSupersededAIRequestError,
  AI_REQUEST_REPLACED_MESSAGE,
} from "../ai-agent-action-requestor";
import { runAgentEvidenceLoop } from "../ai-agent-evidence-loop";
import { denyPendingAISqlConfirmation } from "../ai-sql-confirm";
import { denyPendingAICheckpointPick } from "../ai-checkpoint-picker";
import { collectRunEndInsights } from "../ai-agent-insights";
import { proposeRunLearnings } from "../ai-agent-learning";
import { trackUsage } from "../../../utils/usage-counter";

import {
  buildRunnerInstructionForReason,
  formatActionFailureReason,
  resolveEvidenceRounds,
} from "../ai-agent-quality-gates";
import {
  extractSqlFromResponse,
  hasSqlStartKeyword,
  stripSqlCodeBlocksFromResponse,
} from "../ai-sql-response";
import { parseEditorAssistCommand, type EditorAssistCommand } from "../ai-slash-commands";
import { buildExplainQuery, parseExplainOutput } from "../../../utils/explain-parser";
import { getIndexProposals, type IndexProposal } from "../../../utils/index-advisor";
import { useAISqlRunner } from "./use-ai-sql-runner";
import { useAIAutonomyStore } from "../../../stores/aiAutonomyStore";

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
  /** Structured options from an ask_user finish; rendered as quick-reply buttons. */
  askUserOptions?: string[];
  /** Provider-failover footer notes (short summary + full raw provider error)
   *  surfaced under the final answer with an info popover. */
  failoverNotes?: AIWorkspaceFailoverNote[];
  /**
   * P10: tools an unattended scheduled run tried to call but was refused. Only
   * present for an unattended run, and read back as evidence that the run
   * really stayed read-only (the allow-list is a claim; this is the trace).
   */
  unattendedBlockedTools?: AIAgentToolName[];
  /** Cumulative model tokens the run spent across every model call (0 when the
   *  provider reports no usage); the bubble footer shows it against the budget. */
  tokensUsed?: number;
  /** True when the token ceiling forced the finish — the answer may be
   *  truncated; the bubble footer warns instead of just showing the count. */
  tokenBudgetExhausted?: boolean;
  /** Model id that produced the run's answer (the configured fast model when
   *  the intent was trivial); the bubble footer shows it next to tokens. */
  modelUsed?: string;
  /** Ordered audit trail of the run's tool calls (name, args summary,
   *  duration, ok/fail, SQL) for the bubble's "Run details" section. */
  runTrace?: AIWorkspaceRunTraceEntry[];
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
 * A provider-failure footer note: a terse localized summary ("Provider X bị
 * lỗi") plus the FULL raw provider error kept as `detail`. The conversation
 * footer shows the summary and reveals the detail behind an info popover, so
 * the long provider payload (e.g. Gemini's multi-sentence "Invalid JSON payload
 * received..." dump) never floods the answer while staying one click away.
 */
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
/** Upper bound for tables scanned per search_schema call; large catalogs are prioritized, not fully scanned. */
/** Pause before retrying a transient provider failure inside the agent loop. */
/** Rate limits need a longer cooldown than blips; one patient retry still beats failing the run. */

export interface EditorAssistResolution {
  command: EditorAssistCommand;
  /** The expanded prompt that replaces the `/name` draft for the model. */
  prompt: string;
  /**
   * Context the command wanted but could not get (no editor SQL, no recorded
   * error, EXPLAIN failed). Surfaced as a toast via
   * `describeMissingCommandContextItems` so the user knows the agent will ask
   * instead of quietly guessing.
   */
  missingContext: string[];
}

/**
 * Expand `/explain`, `/optimize`, or `/fix` into the prompt the model actually
 * receives. The composer keeps showing the short command; this gathers the
 * real context — the SQL in the active editor tab (or the attached selection
 * when no query tab is focused), the last recorded query error for `/fix`,
 * and an EXPLAIN plan plus index-advisor proposals for `/optimize`.
 *
 * Every lookup degrades to a note inside the prompt instead of failing the
 * send: a missing editor or a failed EXPLAIN must never block the request.
 */
export async function resolveEditorAssistPrompt(params: {
  commandLine: string;
  connectionId: string | null;
  dbType: DatabaseType | undefined;
  databaseLabel: string | null;
  /** SQL the user explicitly attached to the composer, if any. */
  attachedSql?: string | null;
}): Promise<EditorAssistResolution | null> {
  const parsed = parseEditorAssistCommand(params.commandLine);
  if (!parsed) return null;

  const { tabs, activeTabId } = useUIStore.getState();
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const editorSql =
    activeTab?.type === "query" && activeTab.connectionId === params.connectionId
      ? activeTab.content?.trim() || null
      : null;
  const sql = editorSql ?? params.attachedSql?.trim() ?? null;
  const databaseLabel = params.databaseLabel?.trim() || null;
  const hint = parsed.arguments || undefined;
  const missing: string[] = [];
  if (!sql) missing.push("editor SQL");

  if (parsed.command === "explain") {
    return {
      command: parsed.command,
      prompt: buildExplainSqlPrompt({ sql, hint, databaseLabel }),
      missingContext: missing,
    };
  }

  if (parsed.command === "fix") {
    // The last error lives in query history: the editor records every failed
    // execution there, and history is the only place the error text survives
    // once the results pane re-renders.
    let lastError: string | null = null;
    let errorSql: string | null = null;
    try {
      const history = await invokeMutation<QueryHistoryEntry[]>("get_query_history", {
        connectionId: params.connectionId ?? null,
        search: null,
        limit: 50,
      });
      const errored = (history ?? []).find((entry) => entry.error?.trim());
      lastError = errored?.error?.trim() ?? null;
      errorSql = errored?.query_text?.trim() ?? null;
    } catch {
      // History is enrichment, never a blocker.
    }
    if (!lastError) missing.push("last query error");
    return {
      command: parsed.command,
      prompt: buildFixSqlPrompt({ sql, hint, databaseLabel, lastError, errorSql }),
      missingContext: missing,
    };
  }

  // /optimize — run a planning-only EXPLAIN through the agent read-only path
  // (never ANALYZE, so nothing executes) and feed the parsed plan to the same
  // index advisor the ExplainVisualizer uses.
  let planSummary: string | null = null;
  let indexProposals: IndexProposal[] = [];
  let planUnavailableNote: string | null = null;
  if (!params.connectionId) {
    planUnavailableNote = "no database connection is active";
  } else if (!sql) {
    planUnavailableNote = "there is no SQL to explain";
  } else {
    try {
      const dbType = params.dbType ?? "mongodb";
      const explainResult = await useQueryStore
        .getState()
        .executeAgentReadonlyQuery(params.connectionId, [buildExplainQuery(sql, dbType)]);
      planSummary = summarizeAgentExplainPlanStructured(explainResult, dbType) || null;
      // Same extraction the SQL editor's EXPLAIN button applies before parsing.
      const rawOutput: unknown =
        explainResult.rows.length === 1 && explainResult.columns.length === 1
          ? explainResult.rows[0][0]
          : explainResult.rows.map((row) =>
              Object.fromEntries(
                explainResult.columns.map((column, index) => [column.name, row[index]]),
              ),
            );
      const parsedPlan = parseExplainOutput(dbType, rawOutput);
      indexProposals = getIndexProposals(parsedPlan, sql);
      if (!planSummary) planUnavailableNote = "EXPLAIN returned no plan";
    } catch (errorValue) {
      planUnavailableNote = `EXPLAIN failed: ${
        errorValue instanceof Error ? errorValue.message : String(errorValue)
      }`;
    }
  }
  if (planUnavailableNote) missing.push("query plan");
  return {
    command: parsed.command,
    prompt: buildOptimizeSqlPrompt({
      sql,
      hint,
      databaseLabel,
      planSummary,
      planUnavailableNote,
      indexProposals,
    }),
    missingContext: missing,
  };
}

export function useAISlidePanel({
  isOpen,
  onGenerationCancelled,
}: {
  isOpen: boolean;
  /**
   * Called when the user stops a run so the panel can settle its own pending
   * consent dialogs (data-read, destructive). Module-level consents (failover,
   * SQL confirm, checkpoint pick) are denied inside cancelGeneration itself.
   */
  onGenerationCancelled?: () => void;
}) {
  const { askAIWithReasoning, cancelAIRequest, aiConfigs, requestPhase } = useAIStore(
    useShallow((state) => ({
      askAIWithReasoning: state.askAIWithReasoning,
      cancelAIRequest: state.cancelAIRequest,
      aiConfigs: state.aiConfigs,
      requestPhase: state.requestPhase,
    })),
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
      activeDbType: state.connections.find(
        (connection) => connection.id === state.activeConnectionId,
      )?.db_type,
    })),
  );
  const {
    getTableStructure,
    getTableColumnsPreview,
    getTableData,
    executeSandboxQuery,
    executeAgentReadonlyQuery,
    executeAgentParameterizedQuery,
    previewWriteTransaction,
  } = useQueryStore(
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
      invokeWithTimeout<
        Array<{
          fileName: string;
          label: string;
          createdAt: number;
          engine: string;
          database: string | null;
          tableCount: number;
          rowCount: number;
          sizeBytes: number;
        }>
      >(
        "list_database_checkpoints",
        { connectionId: listConnectionId },
        60_000,
        "Listing checkpoints",
      ),
    [],
  );
  const restoreCheckpoint = useCallback(
    async (restoreConnectionId: string, fileName: string, restoreDbType: string) => {
      // Bounded: a restore replays a full dump — a stuck backend call must not
      // hang the run (Stop cannot kill an in-flight invoke).
      const result = await invokeWithTimeout<{ warning?: string | null }>(
        "restore_database_checkpoint",
        {
          connectionId: restoreConnectionId,
          fileName,
          dbType: restoreDbType,
        },
        120_000,
        "Restoring checkpoint",
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
  // Captures the model id that produced the most recent askAI reply so the
  // run footer can name the model that answered (fast model included).
  const lastModelUsedRef = useRef<string | undefined>(undefined);

  const askAI = useCallback(
    async (
      prompt: string,
      context: string,
      mode: AIRequestMode = "panel",
      intent: AIRequestIntent = "sql",
      history: AIConversationMessage[] = [],
      attachments?: AIRequestAttachment[],
      options?: {
        correlationId?: string;
        unattendedReadOnly?: boolean;
        preferredModel?: string;
      },
    ): Promise<string> => {
      // Captured before the await: a reply landing after this run was
      // superseded must not overwrite the live run's reasoning/model refs or
      // ledger entries.
      const requestId = requestIdRef.current;
      const { text, reasoning, modelUsed } = await askAIWithReasoning(
        prompt,
        context,
        mode,
        intent,
        history,
        attachments,
        options,
      );
      if (requestId !== requestIdRef.current) {
        return text;
      }
      if (reasoning && reasoning.trim()) {
        lastReasoningRef.current = reasoning.trim();
      }
      if (modelUsed && modelUsed.trim()) {
        lastModelUsedRef.current = modelUsed.trim();
      }
      // Session cost ledger: every model call funnels through here, so the
      // header summary accumulates real usage per provider/model. The active
      // provider is read at completion time so a mid-call failover attributes
      // the spend to the provider that actually answered.
      const usage = extractAgentUsageBreakdown(useAIStore.getState().streamingUsage);
      const answeredProvider = getActiveAIProvider(useAIStore.getState().aiConfigs);
      recordSessionModelUsage(
        answeredProvider?.name?.trim() || answeredProvider?.provider_type || "unknown",
        lastModelUsedRef.current ?? answeredProvider?.model ?? "unknown",
        usage,
      );
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
    const handleTableDataUpdated = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          connectionId?: string;
          database?: string;
          invalidateStructure?: boolean;
        }>
      ).detail;

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
      // generating until it finishes on its own. Pending module-level
      // consents are denied too — a dialog nobody can see must not hold a
      // run (or a runSql call) open forever.
      requestIdRef.current += 1;
      void cancelAIRequest();
      denyPendingAIFailoverConsent();
      denyPendingAISqlConfirmation();
      denyPendingAICheckpointPick();
    }
  }, [isOpen, cancelAIRequest]);

  const cancelGeneration = useCallback(() => {
    // Settle every consent a stopped run could be waiting on: an unresolved
    // dialog promise would keep the run alive forever after Stop. Denials are
    // not persisted — a cancelled run is not a user decision.
    denyPendingAIFailoverConsent();
    denyPendingAISqlConfirmation();
    denyPendingAICheckpointPick();
    onGenerationCancelled?.();
    if (!isGenerating) return;
    requestIdRef.current += 1;
    setIsGenerating(false);
    setError(null);
    void cancelAIRequest();
  }, [cancelAIRequest, isGenerating, onGenerationCancelled]);

  const generateAssist = useCallback(
    async (
      prompt: string,
      history: AIConversationMessage[] = [],
      options?: {
        interactionMode?: AIWorkspaceInteractionMode;
        requestDataReadConsent?: () => Promise<boolean>;
        /** Per-call destructive confirmation — always dialogs, never standing. */
        requestDataDestructiveConsent?: (detail: {
          title: string;
          message: string;
          confirmText?: string;
          cancelText?: string;
        }) => Promise<boolean>;
        userPrompt?: string;
        onAgentProgress?: (
          steps: AIWorkspaceAgentStep[],
          runTrace?: AIWorkspaceRunTraceEntry[],
        ) => void;
        /** Files/images attached by the user for this turn (composer pipeline). */
        attachments?: AIAttachmentDraft[];
        /**
         * P10: this run was started by a scheduled agent task. Nobody is
         * watching, so the run is confined to the read-only tool surface — the
         * write/memory/checkpoint tools are absent from the catalog and refused
         * by the executor — and the model is told to report instead of asking.
         */
        unattendedReadOnly?: boolean;
        /**
         * A file command's `allowed-tools:` narrowing for this run only —
         * seeded into the executor as the initial tool restriction (same
         * narrowing-only contract as a loaded skill's allowed-tools).
         */
        commandToolRestriction?: string[];
      },
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
      // Local usage counter: one count per accepted run (empty prompts and
      // missing providers bail out above before this point).
      trackUsage("agent.run");
      // Per-run token accounting: every model call this run makes funnels
      // through `trackedAskAI`, which adds the provider's usage payload to the
      // total the bubble footer reports. The runner keeps its own counter for
      // the 120k budget; this one is the honest whole-run figure (it also
      // covers the plan turn, retries, evidence loop and finish recovery).
      let runTokensUsed = 0;
      // High-water mark of runTokensUsed already reported to the runner's
      // token budget; the delta between the two is what each action request
      // actually cost (plan/compaction/delegate calls spend too, so sampling
      // only the last call's usage would undercount the run).
      let runTokensSampled = 0;
      // Model id that produced the run's answer; the bubble footer shows it
      // next to the token total. Updated after every tracked call so a
      // mid-run failover still reports the model that actually answered.
      let runModelUsed: string | undefined;
      // Model routing: trivial asks (general chat, short explains, formatting)
      // go to the provider's configured fast_model when one is set. Assigned
      // once the intent classifier has run, below.
      let routedRequestModel: string | undefined;
      const trackedAskAI: typeof askAI = async (...args) => {
        const callOptions = args[6];
        if (routedRequestModel && !callOptions?.preferredModel) {
          args[6] = { ...callOptions, preferredModel: routedRequestModel };
        }
        const text = await askAI(...args);
        runTokensUsed += extractAgentUsageTokens(useAIStore.getState().streamingUsage);
        if (lastModelUsedRef.current) runModelUsed = lastModelUsedRef.current;
        return text;
      };
      const requestId = ++requestIdRef.current;
      lastReasoningRef.current = undefined;
      const requestDataReadConsent = options?.requestDataReadConsent;
      const requestDataDestructiveConsent = options?.requestDataDestructiveConsent;
      const onAgentProgress = options?.onAgentProgress;
      // P10: an unattended scheduled run is read-only. The flag rides the
      // request payload, the prompt catalog and the executor, so no single
      // layer has to be trusted on its own.
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

        let effectiveProvider = activeProvider;
        // Model routing: trivial intents take the provider's fast_model when
        // configured; agent runs stay on the primary model (they must emit
        // valid tool JSON, where a weaker model costs more than it saves).
        const configuredFastModel = effectiveProvider.fast_model?.trim() || undefined;
        routedRequestModel =
          interactionMode !== "agent" &&
          configuredFastModel &&
          isTrivialAssistIntent(assistIntent, normalizedPrompt)
            ? configuredFastModel
            : undefined;
        const schemaSharingEnabled = effectiveProvider.allow_schema_context;
        // The user turned schema sharing off for this provider — never flip
        // it back on silently. The buildSchemaContextRequiredMessage path
        // below answers with the choice instead of deciding for them.

        const schemaContextEnabled =
          needsWorkspaceContext && schemaSharingEnabled && modeUsesSchemaContext;
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
              schemaSharingEnabled,
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
              schemaSharingEnabled,
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
          // Assigned once the tool executor is created below; the audit trail
          // rides every progress publish so the bubble's "Run details" section
          // fills in live and survives a failed/cancelled run.
          let getAgentRunTrace: () => AIWorkspaceRunTraceEntry[] = () => [];
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
                  step.observation.startsWith("Tool error") ||
                  step.observation.startsWith("Tool blocked")
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
            onAgentProgress(completed, getAgentRunTrace());
          };
          // Liveness ticker for phases outside the runner's own think ticker:
          // the plan turn, long tool calls, evidence-loop rounds and
          // finalization model calls republish their pending step with
          // elapsed seconds so the trace never looks frozen.
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

          const needsExtendedAgentBudget = wantsVisualization || assistIntent === "overview";
          const agentStepBudget = isLocalProvider
            ? needsExtendedAgentBudget
              ? MAX_LOCAL_COMPLEX_AGENT_STEPS
              : MAX_AGENT_STEPS
            : needsExtendedAgentBudget
              ? MAX_REMOTE_COMPLEX_AGENT_STEPS
              : MAX_REMOTE_AGENT_STEPS;
          const workspaceToolsEnabled =
            schemaContextEnabled && availableSchemaTables.length > 0 && Boolean(connectionId);
          const toolAvailability = agentToolAvailability(activeDbType);
          const recordLookupRequest =
            workspaceToolsEnabled && isAgentRecordLookupRequest(normalizedPrompt);
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
                ? "This is a metrics/dashboard/summary request. Inspect the relevant tables, then in finish.args.metricsWidgets return exactly the widgets the user asked for — if they named a count or listed cards, match that number and those cards; only choose a sensible 3-6 set yourself when the request leaves the contents open. Each widget needs a clear title, a type (scoreboard for single totals, bar/pie/line for grouped aggregates, table for detailed breakdowns), and a runnable read-only query grounded in the verified schema. Build the board yourself; do not ask the user which widgets they want."
                : toolAvailability.documentPropose
                  ? "This is a metrics/dashboard/summary request. Inspect the relevant collections, then in finish.args.metricsWidgets return exactly the widgets the user asked for — if they named a count or listed cards, match that number and those cards; only choose a sensible 3-6 set yourself when the request leaves the contents open. Each widget needs a clear title, a type (scoreboard for single totals, bar/pie/line for grouped aggregates, table for detailed breakdowns), and a runnable read-only SELECT query grounded in the verified schema — the metrics board translates SELECT ... GROUP BY into a MongoDB aggregation pipeline automatically. Build the board yourself; do not ask the user which widgets they want."
                  : "This is a metrics/dashboard/summary request. Inspect the relevant tables with describe_table and sample_table_data, then summarize in finish.args.response. Omit SQL-shaped widget queries."
              : undefined,
          );
          // Summaries already fetched while preparing schema context are injected
          // into every controller prompt so the agent does not spend tool steps
          // re-describing tables it can already see.
          const cachedTableSummaries =
            workspaceToolsEnabled && relationalSchemaSummaryByTable.size > 0
              ? [...relationalSchemaSummaryByTable.entries()]
                  .filter(([tableName]) => availableSchemaTables.includes(tableName))
                  .map(([, summary]) => summary)
              : undefined;

          // Verified business semantics for this connection/database scope are
          // injected so analyses never contradict curated definitions.
          const glossaryLines =
            workspaceToolsEnabled && connectionId
              ? await getSemanticGlossary(connectionId, currentDatabase || undefined)
                  .then((entries) =>
                    entries
                      .slice(0, 24)
                      .map(
                        (entry) =>
                          `- ${entry.term}${entry.kind !== "term" ? ` (${entry.kind})` : ""}: ${entry.definition}`,
                      ),
                  )
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
                if (
                  skillsCatalogCache &&
                  Date.now() - skillsCatalogCache.at < SKILLS_CATALOG_TTL_MS
                ) {
                  return skillsCatalogCache.entries;
                }
                try {
                  const report = await invokeWithTimeout<{
                    skills: { name: string; description: string; source: string }[];
                    errors?: { path: string; reason: string }[];
                  }>("list_ai_skills", {}, 60_000, "Loading skill catalog");
                  const entries = report.skills ?? [];
                  skillsCatalogCache = { at: Date.now(), entries };
                  return entries;
                } catch (error) {
                  console.warn("[AIWorkspace] skill catalog unavailable:", error);
                  return [] as { name: string; description: string; source: string }[];
                }
              })().then((entries) =>
                entries
                  .filter((entry) => entry.source === "global")
                  // Per-skill opt-out: a skill the user disabled is not injected,
                  // so it costs nothing and the agent never sees it.
                  .filter((entry) => useSkillPrefsStore.getState().isEnabled(entry.name))
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
          const workspaceBoundDatabase =
            workspaceStoreState.workspaces.find(
              (workspace) => workspace.id === workspaceStoreState.activeWorkspaceId,
            )?.database ?? null;
          const knownDatabaseNames = useConnectionStore
            .getState()
            .databases.map((item) => item.name);

          // Context compaction: once the run's cumulative spend crosses ~70%
          // of the token budget, older trace steps are summarized into an
          // "Earlier context" block (one extra model call) and dropped from
          // subsequent prompts; the last few steps always stay verbatim.
          // `compactedThroughStep` is the highest step number already folded.
          let compactedThroughStep = 0;
          let compactedContext: string | undefined;
          const compactAgentTrace = async (steps: AgentTraceStep[]) => {
            if (runTokensUsed < AGENT_COMPACTION_TOKEN_THRESHOLD) return;
            const toolSteps = steps.filter(
              (step) => step.action !== "plan" && step.step > compactedThroughStep,
            );
            // Keep the tail verbatim; only fold when there is a real prefix
            // worth summarizing (at least 2 steps beyond the kept tail).
            const foldable = toolSteps.slice(
              0,
              Math.max(0, toolSteps.length - AGENT_COMPACTION_KEEP_TAIL),
            );
            if (foldable.length < 2) return;
            const foldLines = foldable
              .map((step) =>
                [
                  `Step ${step.step}`,
                  `Action: ${step.action}`,
                  `Message: ${step.message || "No message provided."}`,
                  `Observation: ${step.observation || "(none)"}`,
                ].join("\n"),
              )
              .join("\n\n");
            try {
              const summary = await trackedAskAI(
                [
                  "Summarize this agent run's earlier steps into a compact brief (max 8 bullet lines) for the agent's own continuation.",
                  "Preserve: verified table/column names, executed SQL results and row counts, errors encountered, and decisions already made. Drop boilerplate.",
                  compactedContext
                    ? `Previous summary (merge into the new one):\n${compactedContext}`
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
                // Compaction is a trivial summarization ask — route it to the
                // fast model when the provider has one configured.
                { preferredModel: configuredFastModel },
              );
              if (requestId !== requestIdRef.current) {
                throw new Error(AI_REQUEST_REPLACED_MESSAGE);
              }
              const trimmed = summary.trim();
              if (trimmed) {
                compactedContext = trimmed;
                compactedThroughStep = foldable[foldable.length - 1].step;
              }
            } catch (compactionError) {
              if (isSupersededAIRequestError(compactionError)) throw compactionError;
              // Compaction is best-effort: a failed summary call leaves the
              // raw trace in place (the prompt clamp still bounds it).
            }
          };

          const buildControllerPrompt = (
            forceFinish: boolean,
            extraInstruction?: string,
            steps: AgentTraceStep[] = agentTraceSteps,
          ) =>
            buildAgentControllerPrompt({
              userPrompt: promptForRequest,
              assistIntent,
              currentDatabase,
              availableTableNames:
                agentPromptTableNames.length > 0 ? agentPromptTableNames : availableSchemaTables,
              // Steps already folded into the compaction summary are dropped
              // from the verbatim trace; the summary carries their findings.
              steps: steps.filter((step) => step.step > compactedThroughStep),
              earlierContext: compactedContext,
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
            });

          // Model-call layer: transient retry + parse-repair (extracted).
          // Retry waits are published as transient "think" steps so a slow
          // rate-limited provider never looks like a frozen run.
          const { requestAgentAction } = createAgentActionRequestor({
            askAI: trackedAskAI,
            context,
            strictRecoveryContext,
            requestId,
            requestIdRef,
            requestHistory,
            // Multimodal images ride every model call of the run (handled inside
            // the requestor) so the step that composes the final answer still
            // sees them — vision agent runs used to lose the image after call #1.
            imageAttachments,
            // Stamps every model call of this run so chain-failover events from
            // parallel non-agent requests never leak into this trace.
            correlationId: `agent-run-${requestId}`,
            // P10: the read-only tool surface also narrows the native tool
            // payload of every model call in this run.
            unattendedReadOnly,
            onRetryWait: ({ delayMs, reason, retry, maxRetries }) => {
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
              // Settled note: survives reloads through the persisted trace.
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
            },
          });
          const { runAgentTool, getUnattendedBlockedTools, getRunTrace } = createAgentToolExecutor({
            // P10: an unattended scheduled run reaches only the read tools; the
            // executor refuses everything else by name.
            unattendedReadOnly,
            // Fail-closed: an absent catalog means NO skill may load, otherwise
            // a model could call the skill tool for entries never vetted.
            allowedSkillNames: availableSkills?.map((entry) => entry.name) ?? [],
            // A file command's `allowed-tools:` seeds the run's restriction —
            // same narrowing-only contract as a loaded skill's allowed-tools.
            initialToolRestriction: options?.commandToolRestriction,
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
            // manage_metrics_widget: board storage + layout + refresh live in
            // agent-tools/metrics-board-manager; the dep just binds the run's
            // connection/database scope.
            manageMetricsBoard: (request) =>
              manageAgentMetricsBoard(request, {
                connectionId,
                database: currentDatabase ?? null,
              }),
            // open_table_tab: same addTab shape as the record-link handler in
            // AISlidePanel (type "table" + connection/database scope). Verified
            // synchronously like openQueryTab so a failed open reports failure.
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
            // Guardrail rules (P6.1): the Rust engine owns rule loading, hot
            // reload and the verdict; the executor only consumes the folded
            // verdict. Passing the invoke wrapper here — instead of importing
            // Tauri inside the executor — is what keeps the executor's pure
            // decision table unit-testable without a runtime.
            evaluateGuardrailRules: async (statements, options) =>
              evaluateRunAgainstRules(statements, {
                isMutating: options.isMutating,
                // Callers may pin a workspace explicitly; otherwise fall back
                // to the first linked folder so <workspace>/rules/*.md load.
                workspaceDir:
                  options.workspaceDir !== undefined
                    ? options.workspaceDir
                    : await getLinkedWorkspaceDir(),
                // `invokeWithTimeout` requires an args bag; the rule payload
                // always has one, but the shared InvokeFn type allows
                // `undefined`. Bounded so a stalled rules engine cannot hang
                // the tool call.
                invoke: (command, args) =>
                  invokeWithTimeout(command, args ?? {}, 60_000, "Evaluating guardrail rules"),
              }),
            onAgentPlanUpdate: (plan) => {
              agentPlanLines = plan.map(
                (step, index) => `${index + 1}. [${step.status}] ${step.title}`,
              );
            },
            createCheckpoint: (label) => {
              const state = useConnectionStore.getState();
              const dbType = state.connections.find(
                (connection) => connection.id === connectionId,
              )?.db_type;
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
              return trackedAskAI(
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
            // Non-executing EXPLAIN dry-run for mutating edit_query_sql
            // proposals — the backend wraps the statement as `EXPLAIN <stmt>`
            // so the plan (or syntax error) lands on the review card before
            // the user accepts. Never executes the write itself.
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
            try {
              const planText = await runWithProgressTicker(
                { action: "plan", message: "Planning…" },
                () =>
                  trackedAskAI(
                    buildAgentPlanPrompt({
                      userPrompt: normalizedPrompt,
                      assistIntent,
                      currentDatabase,
                      availableTableNames:
                        agentPromptTableNames.length > 0
                          ? agentPromptTableNames
                          : availableSchemaTables,
                      appLanguage,
                    }),
                    strictRecoveryContext || context,
                    "panel",
                    "explain",
                    [],
                  ),
              );
              if (requestId !== requestIdRef.current) {
                throw new Error(AI_REQUEST_REPLACED_MESSAGE);
              }
              const cleanedPlan =
                stripSqlCodeBlocksFromResponse(planText).trim() || planText.trim();
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
          // Reflection guard: a streak of FAILING tool observations (different
          // tools/args, which the repeat-call chain misses) injects a one-time
          // step-back instruction. Tracks the deepest streak already nudged so a
          // transparent meta step never re-fires the same reflection.
          let lastReflectedToolErrorStreak = 0;
          // Provider failover: each failure promotes the NEXT enabled provider
          // (selector follows, note line recorded) and re-runs the step, until
          // every enabled provider has had a turn as primary. Only then does the
          // run fall back to the canned recovery answer.
          const failedProviderIds = new Set<string>();
          const failoverNoteLines: string[] = [];
          // Provider-FAILURE notes (with the raw error payload) are surfaced as a
          // compact footer under the answer instead of dumped into the markdown;
          // switch/info lines stay in failoverNoteLines (the short italic suffix).
          const failoverNotes: AIWorkspaceFailoverNote[] = [];
          let providerRetryCount = 0;
          // A provider the user picked manually during this run must not be
          // silently rotated away by automatic failover.
          const runStartedAt = Date.now();
          // The provider the user had when the run started: automatic
          // failover is a loan, not a switch — the run hands it back at the
          // end unless the user picked a different provider mid-run.
          const providerAtRunStart =
            getActiveAIProvider(useAIStore.getState().aiConfigs)?.id ?? null;

          // Announce a manual provider pick (mid-run) as a settled step in the
          // live trace, so the conversation shows the switch right below the
          // running step — like the automatic failover note. The in-flight model
          // call is cancelled so the current step re-runs on the new provider
          // instead of finishing on the old one (the action loop retries it).
          const handleManualProviderSwitch = (event: Event) => {
            const detail = (event as CustomEvent<{ providerLabel?: string }>).detail;
            const nextLabel = detail?.providerLabel?.trim();
            if (!nextLabel) return;
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

          // The request-level failover chain (aiStore) moves to the next
          // enabled provider when one hangs or errors; surface that as a
          // settled step note so the wait is never silent.
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

          let agentRunnerResult: Awaited<ReturnType<typeof runAIAgentToolLoop>> | undefined;
          try {
            agentRunnerResult = await runAIAgentToolLoop({
              workspaceToolsEnabled,
              stepBudget: agentStepBudget,
              tokenBudget: DEFAULT_AGENT_TOKEN_BUDGET,
              // The runner accumulates whatever this returns after each action
              // request. Reporting the DELTA of the run-wide counter (instead
              // of the last call's usage) means plan/compaction/delegate calls
              // and in-line retries all count toward the budget.
              getLastRequestTokens: () => {
                const delta = runTokensUsed - runTokensSampled;
                runTokensSampled = runTokensUsed;
                return delta;
              },
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

                // Context compaction: past ~70% of the token budget, fold the
                // older trace into an "Earlier context" summary so this call
                // (and every later one) stays small instead of hitting the
                // budget wall mid-investigation.
                await compactAgentTrace(steps);

                let controllerPrompt = buildControllerPrompt(
                  forceFinish,
                  instructionForRunnerRequest(reason),
                  steps,
                );
                if (pendingRepeatReminder) {
                  controllerPrompt = `${controllerPrompt}\n\n${pendingRepeatReminder}`;
                  pendingRepeatReminder = null;
                }
                // Mid-run reflection: after a streak of failing tool calls, nudge
                // the model to re-strategize (or finish honestly) once per new,
                // deeper streak. Never fired on a forced-finish turn — that turn
                // must return finish, not another tool attempt.
                const trailingToolErrors = forceFinish ? 0 : countTrailingToolErrors(steps);
                if (trailingToolErrors === 0) {
                  lastReflectedToolErrorStreak = 0;
                } else if (
                  trailingToolErrors >= TOOL_ERROR_REFLECTION_THRESHOLD &&
                  trailingToolErrors > lastReflectedToolErrorStreak
                ) {
                  controllerPrompt = `${controllerPrompt}\n\n${toolErrorReflectionNudge(trailingToolErrors)}`;
                  lastReflectedToolErrorStreak = trailingToolErrors;
                }
                // Liveness ticker: one model call can legitimately run for
                // minutes (timeout x failover chain x in-line retries). Without
                // a heartbeat the pending "Thinking..." step looks frozen, so
                // republish it with the elapsed time while the call is in flight.
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
                  // Images ride every controller call of the run (the requestor
                  // attaches the run's images) so whichever step composes the final
                  // answer can still see them. Sending only on call #1 made vision
                  // agent runs answer "I don't see any image."
                  const action = await requestAgentAction(controllerPrompt, includeHistory);
                  consecutiveActionFailures = 0;
                  // Advance the repeat-call chain for tracked (tool-argument)
                  // actions; meta actions leave it untouched (dsh semantics).
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
                  if (action.action === "ask_user") {
                    // The harness runs one agent turn per user message, so a
                    // clarifying question ends the turn: the reply arrives as the
                    // next message with full history attached.
                    endedWithAskUser = true;
                    const structuredOptions = Array.isArray(action.args.options)
                      ? action.args.options
                          .filter(
                            (value): value is string =>
                              typeof value === "string" && value.trim().length > 0,
                          )
                          .slice(0, AI_AGENT_ASK_USER_OPTIONS_LIMIT)
                      : [];
                    // Models often ignore the optional options array and write the
                    // choice list straight into the question text (live evidence:
                    // ask_user bubbles persisted with askUserOptions: []); recover
                    // the trailing list so the quick-reply buttons still render.
                    const questionText =
                      typeof action.args.question === "string" ? action.args.question.trim() : "";
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
                      ...steps,
                      {
                        step: steps.length + 1,
                        action: "ask_user",
                        message: askQuestion,
                        observation: "",
                      },
                    ];
                    publishAgentProgress();
                    return {
                      action: "finish" as const,
                      message: action.message || "Asking the user for clarification.",
                      args: {
                        response: `${askQuestion}${optionsBlock}${suffix}`,
                        options: askOptions,
                      },
                    };
                  }
                  // A bare finish (no response, no message, no SQL) throws away
                  // every observation the run gathered. Flaky models emit these
                  // under long step histories — give them one force-finish chance
                  // to summarize the evidence before the canned fallback takes over.
                  if (
                    action.action === "finish" &&
                    !String(action.args?.response ?? "").trim() &&
                    !String(action.message ?? "").trim() &&
                    !action.args?.sql &&
                    steps.some((step) => step.action !== "plan" && step.action !== "think")
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
                        repairedFinish.action === "finish" &&
                        (Boolean(String(repairedFinish.args?.response ?? "").trim()) ||
                          Boolean(String(repairedFinish.message ?? "").trim()) ||
                          Boolean(repairedFinish.args?.sql));
                      if (repairedHasPayload) return repairedFinish;
                    } catch (repairError) {
                      if (isSupersededAIRequestError(repairError)) throw repairError;
                      // Repair call failed — the local evidence summary below takes over.
                    }
                    // The model could not summarize even with the repair nudge.
                    // Never end on a canned non-answer: build the floor response
                    // from the run's own trace (bilingual, evidence-backed).
                    const failoverNoteSuffix =
                      failoverNoteLines.length > 0 ? `\n\n*${failoverNoteLines.join(" ")}*` : "";
                    return {
                      action: "finish" as const,
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
                  // Only a GENUINE provider-level failure may rotate providers: the
                  // endpoint hung ("timeout") or the provider itself rejected the
                  // call ("provider": rate limit, auth, network, HTTP status). A
                  // merely malformed model reply ("invalid-response") or an
                  // unclassified blip ("unknown") is NOT the provider being down, so
                  // it must never switch providers — it still falls through to the
                  // same-provider retry + finish-recovery path below, so there is no
                  // silent stop. This is what keeps a healthy provider from jumping
                  // on any user interaction: answering an ask_user prompt, clicking a
                  // confirm/consent button, or typing more never rotates the
                  // provider unless that provider actually failed.
                  // (A deliberate mid-run switch cancel is fully handled above.)
                  const failoverEligible =
                    requestError.code === "timeout" || requestError.code === "provider";

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

                  const userPickedProviderDuringRun = getManualProviderOverrideAt() > runStartedAt;

                  if (failoverEligible && canPromoteFurther && !userPickedProviderDuringRun) {
                    // The very first failure asks for permission before the agent
                    // ever switches providers on its own. An approval (or decline)
                    // is remembered, so the question never comes back.
                    let failoverAllowed = getAIFailoverConsent() === "approved";
                    // An unattended scheduled run can never show the consent
                    // dialog (the panel may be closed) — auto-deny so the run
                    // falls through to same-provider retry/recovery instead of
                    // hanging forever on a question nobody can answer.
                    if (
                      !unattendedReadOnly &&
                      !failoverAllowed &&
                      getAIFailoverConsent() === "unset"
                    ) {
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
                      await new Promise((resolve) => setTimeout(resolve, PROVIDER_RETRY_DELAY_MS));
                      try {
                        const promotedRetryAction = await requestAgentAction(
                          controllerPrompt,
                          false,
                        );
                        consecutiveActionFailures = 0;
                        return promotedRetryAction;
                      } catch (promotedRetryError) {
                        if (isSupersededAIRequestError(promotedRetryError))
                          throw promotedRetryError;
                        const promotedFailedProvider = getActiveAIProvider(
                          useAIStore.getState().aiConfigs,
                        );
                        // The promoted provider also failed - keep its REAL reason so
                        // the recovery note can tell the user what to go fix.
                        failoverNotes.push(
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
                    failoverNotes.push(
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
                } finally {
                  window.clearInterval(thinkTicker);
                }
              },
              runTool: runAgentTool,
              recoverFinish: recoverAgentFinishAction,
              onStateChange: (snapshot) => {
                agentTraceSteps = snapshot.steps.map((step) => ({ ...step }));
                if (snapshot.phase === "running-tool" && snapshot.action) {
                  // A tool call can run as long as a model call (backend
                  // invoke + consent wait); keep the same elapsed-time
                  // heartbeat so a slow tool never looks frozen.
                  startRunningPhaseTicker({
                    action: snapshot.action,
                    message: snapshot.message || "No message provided.",
                  });
                } else {
                  stopRunningPhaseTicker();
                  if (snapshot.phase === "tool-completed") {
                    publishAgentProgress();
                  } else if (snapshot.phase === "requesting-action") {
                    // The model call is the longest part of every step; show it
                    // explicitly so the trace never looks frozen between tools.
                    // Kept terse on purpose: this text is surfaced verbatim in the
                    // collapsed "Agent steps" header, so no step counters or long
                    // clauses — just the live verb.
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
            // The try's finally sits after the evidence loop and finalization
            // below so the listeners stay live for every phase of the run.
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
            const wantsReportTable =
              /(báo cáo|bảng báo cáo|report|tổng hợp|summary|dashboard)/i.test(normalizedPrompt);
            ({ finalAction, finalSteps } = await runAgentEvidenceLoop({
              workspaceToolsEnabled,
              endedWithAskUser,
              assistIntent,
              wantsReportTable,
              // Complex, synthesis-heavy asks (reports/overviews) earn one extra
              // self-correction round; simple asks keep the conservative default.
              maxRounds: resolveEvidenceRounds({ assistIntent, wantsReportTable }),
              // Allow-list the live schema names so claim verification never flags a
              // real table the run simply never touched as a fabrication.
              knownIdentifiers: availableSchemaTables,
              sharedAgentInstruction,
              initialAction: finalAction,
              initialSteps: finalSteps,
              // Post-loop model/tool calls get the same elapsed-time heartbeat
              // as the runner's own phases so the trace never looks frozen.
              requestAgentAction: (prompt, includeHistory) =>
                runWithProgressTicker({ action: "think", message: "Thinking…" }, () =>
                  requestAgentAction(prompt, includeHistory),
                ),
              buildControllerPrompt,
              isSupersededAIRequestError,
              runAgentTool: (action) =>
                runWithProgressTicker(
                  {
                    action: action.action,
                    message: action.message || "Gathering the missing data.",
                  },
                  () => runAgentTool(action),
                ),
              publishAgentProgress,
              recoverAgentFinishAction: (reason) =>
                runWithProgressTicker({ action: "think", message: "Finalizing answer." }, () =>
                  recoverAgentFinishAction(reason),
                ),
            }));

            // Proactive insights (P8): a pure, synchronous pass over the trace
            // the run already produced — no extra model call, and a card only
            // exists if a statement in that trace backs it. Collected before
            // finalization so the evidence is the run's own.
            if (requestId === requestIdRef.current) {
              const insights = collectRunEndInsights(finalSteps);
              const scope = buildInsightScope(connectionId, currentDatabase);
              useAgentInsightsStore.getState().recordRunInsights(insights, scope);
              // Learning loop (P9): the same evidence, offered as things the
              // workspace could keep. Nothing is written here — the user approves
              // each proposal on its card.
              useAgentLearningStore
                .getState()
                .recordRunLearnings(proposeRunLearnings({ insights, steps: finalSteps }), scope, {
                  connectionId,
                  database: currentDatabase,
                });
            }

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
              void invokeMutation<string>("save_agent_trace", {
                requestId,
                content: traceLines,
              }).catch(() => undefined);
            } catch {
              // Tracing must never break the run.
            }

            const finalization = await finalizeAgentResult({
              availableSchemaTables,
              buildControllerPrompt,
              sharedAgentInstruction,
              language: appLanguage,
              initialAction: finalAction,
              initialSteps: finalSteps,
              // Finalization model calls (finish repair, SQL pre-flight fix)
              // get the same elapsed-time heartbeat as the runner's phases.
              recoverFinishAction: (reason) =>
                runWithProgressTicker({ action: "think", message: "Finalizing answer." }, () =>
                  recoverAgentFinishAction(reason),
                ),
              requestAgentAction: (prompt, includeHistory) =>
                runWithProgressTicker({ action: "think", message: "Thinking…" }, () =>
                  requestAgentAction(prompt, includeHistory),
                ),
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
            // Structured options from an ask_user finish; the conversation view
            // renders them as one-click reply buttons on the final bubble.
            const finalActionArgs = (finalAction.args ?? {}) as Record<string, unknown>;
            const askUserOptions = Array.isArray(finalActionArgs.options)
              ? (finalActionArgs.options as unknown[])
                  .filter(
                    (value): value is string =>
                      typeof value === "string" && value.trim().length > 0,
                  )
                  .slice(0, 8)
              : undefined;
            const hasValidSql = Boolean(finalization.sql);

            return {
              prompt: normalizedPrompt,
              rawResponse: finalization.rawResponse,
              sql: finalization.sql,
              risk:
                hasValidSql && finalization.sql
                  ? await analyzeGeneratedSqlWithBackend(finalization.sql, activeDbType)
                  : undefined,
              intent: assistIntent,
              reasoning: lastReasoningRef.current,
              // Persist the run notes (switches, chain failovers, retry waits)
              // alongside the runner trace so they survive reloads.
              agentSteps: mergeRunNotes(finalization.agentSteps ?? [], manualSwitchNotes),
              agentWidgets: finalization.agentWidgets,
              askUserOptions,
              failoverNotes: failoverNotes.length > 0 ? failoverNotes : undefined,
              // Read-only compliance evidence: which tools an unattended run
              // reached for and was refused (empty = it never tried to write).
              unattendedBlockedTools: unattendedReadOnly ? getUnattendedBlockedTools() : undefined,
              tokensUsed: runTokensUsed,
              tokenBudgetExhausted: agentRunnerResult?.tokenBudgetExhausted === true || undefined,
              modelUsed: runModelUsed,
              runTrace: getRunTrace(),
            };
          } finally {
            // Detach only after EVERY phase (tool loop, evidence loop,
            // finalization) — a manual provider switch must be able to cancel
            // in-flight model calls in the post-loop phases too, and a failed
            // run must never leak its listeners or the liveness ticker.
            stopRunningPhaseTicker();
            window.removeEventListener(
              "ai-provider-switched-during-run",
              handleManualProviderSwitch,
            );
            window.removeEventListener("ai-provider-chain-failover", handleChainFailoverNote);
            // Automatic failover promoted a provider for THIS run only —
            // restore the user's pick so the selector doesn't silently stay
            // on a provider they never chose. A manual switch during the run
            // is the newer decision and wins.
            if (
              providerAtRunStart &&
              providerRetryCount > 0 &&
              getManualProviderOverrideAt() <= runStartedAt
            ) {
              useAIStore.getState().restoreProvider(providerAtRunStart);
            }
          }
        }
        const finalResponse = await recoverNonAgentAssistResponse({
          appLanguage,
          askAI: (requestPrompt, requestContext, requestHistory) =>
            trackedAskAI(requestPrompt, requestContext, "panel", assistIntent, requestHistory),
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
          (assistIntent === "sql" ||
            assistIntent === "optimize" ||
            assistIntent === "fix-error" ||
            wantsVisualization);

        return {
          prompt: normalizedPrompt,
          rawResponse: finalResponse,
          sql: shouldAttachSql ? extractedSql : null,
          risk: hasValidSql
            ? await analyzeGeneratedSqlWithBackend(extractedSql, activeDbType)
            : undefined,
          intent: assistIntent,
          reasoning: lastReasoningRef.current,
          tokensUsed: runTokensUsed,
          modelUsed: runModelUsed,
        };
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
    },
    [
      activeDbType,
      activeProvider,
      askAI,
      cancelAIRequest,
      connectionId,
      currentDatabase,
      executeAgentParameterizedQuery,
      executeAgentReadonlyQuery,
      executeSandboxQuery,
      fetchTables,
      getTableColumnsPreview,
      getTableData,
      getTableStructure,
      isLocalProvider,
      listCheckpoints,
      previewWriteTransaction,
      restoreCheckpoint,
    ],
  );

  const copyText = useCallback(async (text: string): Promise<boolean> => {
    if (!text) return false;
    // Primary path: async Clipboard API (works inside the Tauri WebView).
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // Fall through to the legacy execCommand path below.
    }
    // Fallback: hidden textarea + execCommand("copy") for contexts where the
    // async Clipboard API is unavailable or rejects (e.g. missing permission,
    // window not focused).
    try {
      if (typeof document === "undefined") return false;
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.top = "-9999px";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(textarea);
      return ok;
    } catch {
      return false;
    }
  }, []);

  const insertSql = useCallback((sql: string, risk?: SqlRiskAnalysis) => {
    const computedRisk = risk ?? analyzeGeneratedSql(sql);
    if (computedRisk.level === "dangerous") {
      const message =
        computedRisk.reason || "Potentially destructive SQL cannot be inserted directly.";
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
