import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAIStore } from "../../../stores/aiStore";
import { useConnectionStore } from "../../../stores/connectionStore";
import { useQueryStore } from "../../../stores/queryStore";
import {
  type AIConversationMessage,
  type AIRequestAttachment,
  type AIRequestIntent,
  type DatabaseType,
  type AIRequestMode,
  type QueryHistoryEntry,
} from "../../../types";
import { getActiveAIProvider, isLocalAIProvider } from "../../../utils/ai-provider-registry";
import { denyPendingAIFailoverConsent } from "../../../utils/ai-failover-consent";
import { invokeMutation, invokeWithTimeout } from "../../../utils/tauri-utils";
import { analyzeGeneratedSql, type SqlRiskAnalysis } from "../AISlidePanelUtils";
import {
  type AIWorkspaceAgentStep,
  type AIWorkspaceFailoverNote,
  type AIWorkspaceRunTraceEntry,
} from "../ai-workspace-types";
import { type AIAgentToolName } from "../ai-agent-tools";
import { type AssistIntent } from "../ai-agent-context";
import { emitAppToast } from "../../../utils/app-toast";
import { useUIStore } from "../../../stores/uiStore";
import { extractAgentUsageBreakdown, recordSessionModelUsage } from "../ai-agent-cost";
import {
  buildExplainSqlPrompt,
  buildFixSqlPrompt,
  buildOptimizeSqlPrompt,
} from "../ai-assist-prompts";
import type { AIMetricsWidgetSpec } from "../../../utils/metrics-board-templates";
import { summarizeAgentExplainPlanStructured } from "../ai-agent-grounding";
import { denyPendingAISqlConfirmation } from "../ai-sql-confirm";
import { denyPendingAICheckpointPick } from "../ai-checkpoint-picker";
import { parseEditorAssistCommand, type EditorAssistCommand } from "../ai-slash-commands";
import { buildExplainQuery, parseExplainOutput } from "../../../utils/explain-parser";
import { getIndexProposals, type IndexProposal } from "../../../utils/index-advisor";
import { useAISqlRunner } from "./use-ai-sql-runner";
import { runAgentAssist, type AgentAssistOptions } from "../ai-agent-generate";

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
      options?: AgentAssistOptions,
    ): Promise<AIGeneratedAssistResult> =>
      runAgentAssist(
        {
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
          setError,
          setIsGenerating,
          requestIdRef,
          lastReasoningRef,
          lastModelUsedRef,
          aiSchemaCodecCacheRef,
        },
        prompt,
        history,
        options,
      ),
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
