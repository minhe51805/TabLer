import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { getCurrentAppLanguage } from "../../../i18n";
import { useAIStore } from "../../../stores/aiStore";
import { useConnectionStore } from "../../../stores/connectionStore";
import { useQueryStore } from "../../../stores/queryStore";
import { type AIConversationMessage, type AIRequestIntent, type AIRequestMode } from "../../../types";
import { getActiveAIProvider, isLocalAIProvider } from "../../../utils/ai-provider-registry";
import { normalizeAIRequestError } from "../../../utils/ai-request-errors";
import { getSemanticGlossary, saveSemanticGlossaryEntry } from "../../../utils/semantic-glossary";
import {
  formatExecutionError,
  isHighRiskStatement,
  isMutatingStatement,
  isSessionSwitchStatement,
} from "../../SQLEditor/SQLEditorUtils";
import { analyzeGeneratedSql, type SqlRiskAnalysis } from "../AISlidePanelUtils";
import {
  aiModeUsesSchemaContext,
  type AIWorkspaceAgentActionName,
  type AIWorkspaceAgentStep,
  type AIWorkspaceInteractionMode,
} from "../ai-workspace-types";
import {
  AI_AGENT_BATCH_DESCRIBE_LIMIT,
  AI_AGENT_SAMPLE_MAX_ROWS,
  parseAIAgentToolAction,
  type AIAgentFinishAction,
  type AIAgentToolAction,
} from "../ai-agent-tools";
import {
  buildAgentControllerPrompt,
  buildAgentPlanPrompt,
  buildWorkspaceTableIdentifier,
  joinAgentInstructions,
  type AgentTraceStep,
  type AssistIntent,
} from "../ai-agent-context";
import {
  runAIAgentToolLoop,
  type AIAgentActionRequestReason,
} from "../ai-agent-runner";
import {
  buildAgentEvidenceSummary,
  buildAgentFinalRecoveryPrompt,
  buildLocalAgentFallbackResponse,
} from "../ai-assist-prompts";
import type { AIMetricsWidgetSpec } from "../../../utils/metrics-board-templates";
import {
  inferAssistIntent,
  isMetricsBoardRequest,
  isVisualizationRequest,
  isWorkspaceScopedIntent,
} from "../ai-assist-intent";
import {
  buildSchemaContextRequiredMessage,
  findMatchingTableName,
  getAgentSqlSchemaRequirements,
  stringifyAgentObservation,
  summarizeAgentQueryObservation,
  summarizeAgentSchemaSummaryObservation,
  summarizeAgentStructureObservation,
} from "../ai-agent-grounding";
import { finalizeAgentResult } from "../ai-agent-finalization";
import { recoverNonAgentAssistResponse } from "../ai-assist-recovery";
import { mapWithConcurrency, yieldToBrowserFrame } from "../ai-async-utils";
import { prepareAIWorkspaceSchemaContext } from "../ai-schema-context-loader";
import { findAgentSchemaMatches, isAgentRecordLookupRequest, prioritizeSchemaScanCandidates } from "../ai-agent-schema-search";
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
const MAX_REMOTE_HISTORY_MESSAGES = 4;
/** Upper bound for tables scanned per search_schema call; large catalogs are prioritized, not fully scanned. */
const MAX_AGENT_SCHEMA_SCAN_TABLES = 120;
/** Pause before retrying a transient provider failure inside the agent loop. */
const AGENT_TRANSIENT_RETRY_DELAY_MS = 800;
/** Rate limits need a longer cooldown than blips; one patient retry still beats failing the run. */
const AGENT_RATE_LIMIT_RETRY_DELAY_MS = 5_000;
export const AI_REQUEST_REPLACED_MESSAGE = "This AI request was replaced by a newer one.";

export function isSupersededAIRequestError(errorValue: unknown) {
  if (errorValue instanceof Error) {
    return errorValue.message === AI_REQUEST_REPLACED_MESSAGE;
  }

  return String(errorValue) === AI_REQUEST_REPLACED_MESSAGE;
}

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
  } = useConnectionStore(
    useShallow((state) => ({
      tables: state.tables,
      fetchTables: state.fetchTables,
      switchDatabase: state.switchDatabase,
      activeConnectionId: state.activeConnectionId,
      currentDatabase: state.currentDatabase,
    })),
  );
  const { getTableStructure, getTableColumnsPreview, getTableData, executeSandboxQuery, previewWriteTransaction } = useQueryStore(
    useShallow((state) => ({
      getTableStructure: state.getTableStructure,
      getTableColumnsPreview: state.getTableColumnsPreview,
      getTableData: state.getTableData,
      executeSandboxQuery: state.executeSandboxQuery,
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
    ): Promise<string> => {
      const { text, reasoning } = await askAIWithReasoning(prompt, context, mode, intent, history);
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
    }
  ): Promise<AIGeneratedAssistResult> => {
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt) {
      const message = "Write a request first.";
      setError(message);
      throw new Error(message);
    }
    if (!activeProvider) {
      const message = "No AI provider is enabled yet. Configure one in Settings first.";
      setError(message);
      throw new Error(message);
    }

    setIsGenerating(true);
    setError(null);
    const requestId = ++requestIdRef.current;
    lastReasoningRef.current = undefined;
    const requestedInteractionMode = options?.interactionMode ?? "prompt";
    const requestDataReadConsent = options?.requestDataReadConsent;
    const onAgentProgress = options?.onAgentProgress;
    const requestIntentPrompt = options?.userPrompt?.trim() || normalizedPrompt;
    const assistIntent: AssistIntent = inferAssistIntent(requestIntentPrompt, requestedInteractionMode);
    const wantsVisualization = isVisualizationRequest(requestIntentPrompt);
    const wantsMetricsBoard = isMetricsBoardRequest(requestIntentPrompt);
    const interactionMode = requestedInteractionMode;
    // In agent mode, as long as there is a live connection we let the agent reach
    // for workspace tools even when the intent looks general ? that is what makes
    // it behave like a real autonomous agent instead of a plain chat reply.
    const agentCanUseWorkspace = requestedInteractionMode === "agent" && Boolean(connectionId);
    const needsWorkspaceContext = isWorkspaceScopedIntent(assistIntent) || agentCanUseWorkspace;
    const appLanguage = getCurrentAppLanguage();
    const modeUsesSchemaContext = aiModeUsesSchemaContext(interactionMode);
    const requestHistory =
      assistIntent === "overview"
        ? []
        : isLocalProvider
          ? history
          : history.slice(-MAX_REMOTE_HISTORY_MESSAGES);
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
        const recordLookupRequest = workspaceToolsEnabled && isAgentRecordLookupRequest(normalizedPrompt);
        const workspaceToolStatus = workspaceToolsEnabled
              ? "Database tools are available if grounded workspace evidence is needed."
          : !connectionId
            ? "No active database connection is selected, so respond without workspace tools."
            : !needsWorkspaceContext
              ? "This request is broader than database work, so answer directly unless the user explicitly asks for workspace data."
              : !schemaSharingEnabled
                ? "Schema sharing is disabled for the current provider, so workspace tools are unavailable for this turn."
                : "No verified schema snapshot is available for tool use on this turn.";
        const sharedAgentInstruction = joinAgentInstructions(
          "You are an autonomous agent that takes action, not a consultant. Decide your own steps: locate unknown fields with search_schema, inspect the exact table with describe_table, then ACTUALLY gather data yourself with sample_table_data or run_readonly_sql. Do not just suggest queries and do not ask the user which query to run first ? pick the most relevant one and run it yourself.",
          "When the user asks to see data, charts, counts, samples, distributions, or 'show me' anything, you MUST run at least one sample_table_data or run_readonly_sql before finishing. Finishing with only suggestions and no executed query is a failure.",
          "When you finish, put the single best runnable query in finish.args.sql (a real SELECT grounded in the verified schema) so it can be executed and shown to the user automatically.",
          !isLocalProvider
            ? "Be efficient: a few targeted tool calls are better than exploring every table, but never skip running the query that produces the answer."
            : undefined,
          wantsVisualization
            ? "For a chart or visualization request, run a chart-friendly aggregate query (e.g. GROUP BY ... COUNT(*)) and return that exact SQL in finish.args.sql plus a short chart recommendation."
            : undefined,
          wantsMetricsBoard
            ? "This is a metrics/dashboard/summary request. Inspect the relevant tables, then in finish.args.metricsWidgets return 3-6 widgets that form a useful board. Each widget needs a clear title, a type (scoreboard for single totals, bar/pie/line for grouped aggregates, table for detailed breakdowns), and a runnable read-only query grounded in the verified schema. Build the board yourself; do not ask the user which widgets they want."
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

        const buildControllerPrompt = (
          forceFinish: boolean,
          extraInstruction?: string,
          steps: AgentTraceStep[] = agentTraceSteps,
        ) =>
          buildAgentControllerPrompt({
            userPrompt: normalizedPrompt,
            assistIntent,
            currentDatabase,
            availableTableNames: agentPromptTableNames.length > 0 ? agentPromptTableNames : availableSchemaTables,
            steps,
            workspaceToolsEnabled,
            workspaceToolStatus,
            forceFinish,
            extraInstruction,
            cachedTableSummaries,
            glossaryLines,
          });

        // A single slow provider response must not discard an agent run that
        // may already have executed several successful tool steps, so
        // transport-level failures (timeout/provider) get one immediate retry.
        const askAgentWithTransientRetry = async (
          prompt: string,
          history: AIConversationMessage[],
        ) => {
          try {
            return await askAI(prompt, strictRecoveryContext || context, "panel", "agent", history);
          } catch (errorValue) {
            if (isSupersededAIRequestError(errorValue)) throw errorValue;
            const requestError = normalizeAIRequestError(errorValue);
            if (requestError.code !== "timeout" && requestError.code !== "provider") throw errorValue;
            const rateLimited = /rate limit|429|quota|too many requests/i.test(requestError.message);
            await new Promise((resolve) => setTimeout(
              resolve,
              rateLimited ? AGENT_RATE_LIMIT_RETRY_DELAY_MS : AGENT_TRANSIENT_RETRY_DELAY_MS,
            ));
            return askAI(prompt, strictRecoveryContext || context, "panel", "agent", history);
          }
        };

        const requestAgentAction = async (controllerPrompt: string, includeHistory: boolean, extraInstruction?: string) => {
          let rawAgentResponse = await askAgentWithTransientRetry(
            extraInstruction
              ? `${controllerPrompt}\n\nRepair note:\n${extraInstruction}`
              : controllerPrompt,
            includeHistory ? requestHistory : [],
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

        let lastExplorationToolKey = "";
        const runAgentTool = async (action: AIAgentToolAction) => {
          try {
            // Repeating an exploration call with identical arguments returns the
            // identical observation and burns a step from a tight budget.
            const explorationKey = action.action !== "run_readonly_sql" && action.action !== "sample_table_data"
              ? `${action.action}:${JSON.stringify(action.args ?? {})}`
              : "";
            if (explorationKey && explorationKey === lastExplorationToolKey) {
              const varyHint = action.action === "list_tables"
                ? ' Narrow with args {"pattern":"substring"} or {"schema":"..."}, or raise {"limit":200}.'
                : " Vary the arguments or move on to the next step.";
              return `Tool notice: identical ${action.action} call repeated — vary the arguments or continue.${varyHint}`;
            }
            if (explorationKey) {
              lastExplorationToolKey = explorationKey;
            }

            if (action.action === "list_tables") {
              const schemaFilter = typeof action.args?.schema === "string" ? action.args.schema.trim().toLowerCase() : "";
              const patternFilter = typeof action.args?.pattern === "string" ? action.args.pattern.trim().toLowerCase() : "";
              const limitFilter = typeof action.args?.limit === "number" && Number.isFinite(action.args.limit)
                ? Math.min(200, Math.max(1, Math.floor(action.args.limit)))
                : 200;
              const minRowsFilter = typeof action.args?.minRows === "number" && Number.isFinite(action.args.minRows)
                ? Math.max(1, Math.floor(action.args.minRows))
                : undefined;

              const filteredTables = latestTables.filter((table) => {
                const identifier = (buildWorkspaceTableIdentifier(table, currentDatabase) || table.name).toLowerCase();
                if (schemaFilter && (table.schema ?? "").toLowerCase() !== schemaFilter) return false;
                if (patternFilter && !identifier.includes(patternFilter) && !table.name.toLowerCase().includes(patternFilter)) {
                  return false;
                }
                if (minRowsFilter !== undefined && (table.row_count ?? 0) < minRowsFilter) return false;
                return true;
              });

              return stringifyAgentObservation({
                database: currentDatabase || "Default",
                catalogTables: latestTables.length,
                filtered: schemaFilter || patternFilter ? true : undefined,
                minRows: minRowsFilter,
                tableCount: filteredTables.length,
                truncated: filteredTables.length > limitFilter ? true : undefined,
                next:
                  filteredTables.length > limitFilter
                    ? `${filteredTables.length} tables exceed the ${limitFilter}-name preview. Narrow with args {"pattern":"substring"} or {"schema":"..."}, or raise {"limit":200}.`
                    : undefined,
                tables: filteredTables.slice(0, limitFilter).map((table) => ({
                  name: table.name,
                  schema: table.schema ?? null,
                  identifier: buildWorkspaceTableIdentifier(table, currentDatabase),
                  type: table.table_type,
                  rowCount: table.row_count ?? null,
                })),
              });
            }

            if (action.action === "search_schema") {
              const query = typeof action.args?.query === "string" ? action.args.query.trim() : "";
              if (!query) {
                return "Tool error: search_schema requires args.query.";
              }

              // Column-scanning every table means hundreds of metadata queries
              // on large catalogs, so prioritize name matches and cap the scan.
              const catalogEntries = latestTables.map((table) => ({
                identifier: buildWorkspaceTableIdentifier(table, currentDatabase) || table.name,
              }));
              const prioritizedIdentifiers = new Set(
                prioritizeSchemaScanCandidates(
                  catalogEntries.map((entry) => entry.identifier),
                  query,
                  MAX_AGENT_SCHEMA_SCAN_TABLES,
                ),
              );
              const scanEntries = catalogEntries.filter((entry) => prioritizedIdentifiers.has(entry.identifier));

              let scannedCount = 0;
              const scanned = await mapWithConcurrency(scanEntries, 4, async (entry) => {
                try {
                  const columns = await getTableColumnsPreview(
                    connectionId!,
                    entry.identifier,
                    currentDatabase || undefined,
                  );
                  return { identifier: entry.identifier, columns, failed: false };
                } catch {
                  return { identifier: entry.identifier, columns: [], failed: true };
                } finally {
                  scannedCount += 1;
                  if (scanEntries.length > 24 && scannedCount % 24 === 0) {
                    publishAgentProgress({
                      action: "search_schema",
                      message: `Scanning schema (${scannedCount}/${scanEntries.length})`,
                    });
                  }
                }
              });
              if (requestId !== requestIdRef.current) {
                throw new Error(AI_REQUEST_REPLACED_MESSAGE);
              }

              const matches = findAgentSchemaMatches(query, scanned);
              return stringifyAgentObservation({
                query,
                catalogTables: catalogEntries.length,
                tablesScanned: scanned.length,
                tablesFailed: scanned.filter((entry) => entry.failed).length,
                truncatedCatalog:
                  scanned.length < catalogEntries.length
                    ? `Only the ${scanned.length} tables whose names best match the query were scanned; ${catalogEntries.length - scanned.length} were skipped.`
                    : undefined,
                matches,
                next: matches.length > 0
                  ? "Call describe_table for the best matching table, then read the requested row data."
                  : "No matching columns were found in the scanned catalog. Do not claim a column is absent if tablesFailed is greater than zero.",
              });
            }

            if (action.action === "describe_table") {
              const requestedTable = typeof action.args?.table === "string" ? action.args.table.trim() : "";
              if (!requestedTable) {
                return "Tool error: describe_table requires args.table.";
              }

              const matchedTable = findMatchingTableName(requestedTable, availableSchemaTables);
              if (!matchedTable) {
                return `Tool error: Table "${requestedTable}" is not present in the current workspace schema.`;
              }

              const cachedSummary = relationalSchemaSummaryByTable.get(matchedTable);
              if (cachedSummary) {
                inspectedAgentTables.add(matchedTable);
                return summarizeAgentSchemaSummaryObservation(matchedTable, cachedSummary);
              }

              const structure = await getTableStructure(connectionId!, matchedTable, currentDatabase || undefined);
              if (requestId !== requestIdRef.current) {
                throw new Error(AI_REQUEST_REPLACED_MESSAGE);
              }

              inspectedAgentTables.add(matchedTable);
              return summarizeAgentStructureObservation(matchedTable, structure);
            }

            if (action.action === "describe_tables") {
              const requestedTables: unknown[] = Array.isArray(action.args?.tables) ? action.args.tables : [];
              const names = [...new Set(
                requestedTables
                  .filter((value): value is string | number => typeof value === "string" || typeof value === "number")
                  .map((value) => String(value).trim())
                  .filter(Boolean),
              )].slice(0, AI_AGENT_BATCH_DESCRIBE_LIMIT);
              if (names.length === 0) {
                return "Tool error: describe_tables requires a non-empty args.tables array.";
              }

              const sections: string[] = [];
              for (const requestedTable of names) {
                const matchedTable = findMatchingTableName(requestedTable, availableSchemaTables);
                if (!matchedTable) {
                  sections.push(`TABLE=${requestedTable} ERROR=Not present in the current workspace schema.`);
                  continue;
                }
                try {
                  const cachedSummary = relationalSchemaSummaryByTable.get(matchedTable);
                  if (cachedSummary) {
                    inspectedAgentTables.add(matchedTable);
                    sections.push(cachedSummary);
                    continue;
                  }
                  const structure = await getTableStructure(connectionId!, matchedTable, currentDatabase || undefined);
                  if (requestId !== requestIdRef.current) {
                    throw new Error(AI_REQUEST_REPLACED_MESSAGE);
                  }
                  inspectedAgentTables.add(matchedTable);
                  sections.push(summarizeAgentStructureObservation(matchedTable, structure));
                } catch (errorValue) {
                  if (isSupersededAIRequestError(errorValue)) throw errorValue;
                  sections.push(`TABLE=${matchedTable} ERROR=${formatExecutionError(errorValue)}`);
                }
              }

              return stringifyAgentObservation({
                described: sections.length,
                tables: sections.join("\n\n"),
              });
            }

            if (action.action === "sample_table_data") {
              const requestedTable = typeof action.args?.table === "string" ? action.args.table.trim() : "";
              if (!requestedTable) {
                return "Tool error: sample_table_data requires args.table.";
              }

              const matchedTable = findMatchingTableName(requestedTable, availableSchemaTables);
              if (!matchedTable) {
                return `Tool error: Table "${requestedTable}" is not present in the current workspace schema.`;
              }

              if (requestDataReadConsent) {
                const approved = await requestDataReadConsent();
                if (!approved) {
                  return "Tool blocked: The user did not grant permission to read live database rows for this request.";
                }
              }

              const requestedLimit = typeof action.args?.limit === "number" && Number.isFinite(action.args.limit)
                ? Math.min(AI_AGENT_SAMPLE_MAX_ROWS, Math.max(1, Math.floor(action.args.limit)))
                : 10;
              // get_table_data goes through the engine driver so identifiers are
              // quoted per dialect; no model-supplied SQL is involved here.
              const queryResult = await getTableData(connectionId!, matchedTable, {
                database: currentDatabase || undefined,
                limit: requestedLimit,
              });
              if (requestId !== requestIdRef.current) {
                throw new Error(AI_REQUEST_REPLACED_MESSAGE);
              }

              inspectedAgentTables.add(matchedTable);
              return summarizeAgentQueryObservation(queryResult);
            }

            if (action.action === "run_readonly_sql") {
              const sql = typeof action.args?.sql === "string" ? action.args.sql.trim() : "";
              if (!sql) {
                return "Tool error: run_readonly_sql requires args.sql.";
              }

              const schemaRequirements = getAgentSqlSchemaRequirements(
                sql,
                availableSchemaTables,
                inspectedAgentTables,
              );
              if (schemaRequirements.unknown.length > 0) {
                return `Tool blocked: SQL references unknown table(s): ${schemaRequirements.unknown.join(", ")}. Use list_tables and describe_table first.`;
              }
              if (schemaRequirements.uninspected.length > 0) {
                return `Tool blocked: Inspect the schema before reading rows. Call describe_table for: ${schemaRequirements.uninspected.join(", ")}.`;
              }

              if (requestDataReadConsent) {
                const approved = await requestDataReadConsent();
                if (!approved) {
                  return "Tool blocked: The user did not grant permission to read live database rows for this request.";
                }
              }

              const queryResult = await executeSandboxQuery(connectionId!, [sql], true);
              if (requestId !== requestIdRef.current) {
                throw new Error(AI_REQUEST_REPLACED_MESSAGE);
              }

              return summarizeAgentQueryObservation(queryResult);
            }

            if (action.action === "preview_write") {
              const requested = Array.isArray(action.args?.statements) ? action.args.statements : [];
              const statements = requested
                .filter((value): value is string => typeof value === "string")
                .map((value) => value.trim())
                .filter(Boolean);
              if (statements.length === 0) {
                return "Tool error: preview_write requires a non-empty args.statements array.";
              }

              // Safety rails: at least one real change, no session switching,
              // and explicit user consent before touching live rows.
              const mutatingCount = statements.filter(
                (statement) => isMutatingStatement(statement) || isHighRiskStatement(statement),
              ).length;
              if (mutatingCount === 0) {
                return "Tool error: preview_write requires at least one INSERT/UPDATE/DELETE/ALTER/CREATE statement. Use run_readonly_sql for reads.";
              }
              for (const statement of statements) {
                if (isSessionSwitchStatement(statement)) {
                  return "Tool blocked: session-switch statements are not allowed in write previews.";
                }
              }

              if (requestDataReadConsent) {
                const approved = await requestDataReadConsent();
                if (!approved) {
                  return "Tool blocked: The user did not grant permission to run the write preview for this request.";
                }
              }

              try {
                const preview = await previewWriteTransaction(connectionId!, statements);
                const summary = preview.results.map((result, index) => ({
                  statement: statements[index] ?? `statement ${index + 1}`,
                  affectedRows: result.affected_rows,
                  returnedRows: result.rows.length,
                  truncated: result.truncated || undefined,
                }));
                return stringifyAgentObservation({
                  rolledBack: true,
                  persisted: false,
                  note: "Executed inside one transaction and ROLLED BACK. Nothing was saved. Report these effects as a PREVIEW and direct the user to apply the final SQL through the approval flow.",
                  statementCount: statements.length,
                  results: summary,
                });
              } catch (errorValue) {
                if (isSupersededAIRequestError(errorValue)) throw errorValue;
                return `Tool error: ${formatExecutionError(errorValue)}`;
              }
            }

            if (action.action === "remember_term") {
              const term = typeof action.args?.term === "string" ? action.args.term.trim() : "";
              const definition = typeof action.args?.definition === "string" ? action.args.definition.trim() : "";
              if (!term || !definition) {
                return "Tool error: remember_term requires args.term and args.definition.";
              }
              try {
                await saveSemanticGlossaryEntry({
                  connectionId: connectionId!,
                  database: currentDatabase || undefined,
                  term,
                  definition,
                  kind: action.args?.kind,
                  source: "agent",
                });
                return stringifyAgentObservation({
                  saved: term,
                  definition,
                  note: "Saved to the business glossary; future runs for this database will see it automatically.",
                });
              } catch (errorValue) {
                if (isSupersededAIRequestError(errorValue)) throw errorValue;
                return `Tool error: could not save the glossary entry: ${formatExecutionError(errorValue)}`;
              }
            }

            return "Tool error: finish does not execute a tool observation.";
          } catch (errorValue) {
            if (isSupersededAIRequestError(errorValue)) {
              throw errorValue;
            }
            return `Tool error: ${formatExecutionError(errorValue)}`;
          }
        };

        const recoverAgentFinishAction = async (reason: string): Promise<AIAgentFinishAction> => {
          const allowedTables = agentPromptTableNames.length > 0 ? agentPromptTableNames : availableSchemaTables;
          const fallbackResponse = buildLocalAgentFallbackResponse({
            language: appLanguage,
            currentDatabase,
            availableTableNames: allowedTables,
            wantsVisualization,
            steps: agentTraceSteps,
          });

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
            const recoveredSql = extractSqlFromResponse(trimmedResponse);

            return {
              action: "finish",
              message: reason,
              args: {
                response: trimmedResponse,
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
                response: fallbackResponse,
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

        const instructionForRunnerRequest = (reason: AIAgentActionRequestReason) => {
          if (reason === "direct") {
            return joinAgentInstructions(
              sharedAgentInstruction,
              "Respond as a general-purpose assistant unless the user explicitly needs current workspace evidence."
            );
          }
          if (reason === "budget") {
            return joinAgentInstructions(
              sharedAgentInstruction,
              "You have reached the tool budget. Finish with the best grounded answer you can."
            );
          }
          return sharedAgentInstruction;
        };

        const formatActionFailureReason = (errorValue: unknown) =>
          errorValue instanceof Error ? errorValue.message : String(errorValue);
        let consecutiveActionFailures = 0;
        let endedWithAskUser = false;

        const agentRunnerResult = await runAIAgentToolLoop({
          workspaceToolsEnabled,
          stepBudget: agentStepBudget,
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
              const action = await requestAgentAction(controllerPrompt, includeHistory);
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
                      : `Deciding next action (step ${Math.min(snapshot.iteration, snapshot.stepBudget)}/${snapshot.stepBudget}).`,
              });
            } else if (snapshot.phase === "recovering-finish") {
              publishAgentProgress({ action: "think", message: "Finalizing answer." });
            }
          },
        });
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
        const hasExecutedReadStep = (steps: AgentTraceStep[]) => steps.some(
          (step) =>
            (step.action === "run_readonly_sql" || step.action === "sample_table_data")
            && Boolean(step.observation)
            && !step.observation.startsWith("Tool error")
            && !step.observation.startsWith("Tool blocked"),
        );
        const finishHasSql = (action: AIAgentFinishAction) =>
          typeof action.args?.sql === "string" && Boolean(action.args.sql.trim());

        const MAX_EVIDENCE_ROUNDS = 2;
        let evidenceRoundsLeft = MAX_EVIDENCE_ROUNDS;
        const wantsReportTable = /(báo cáo|bảng báo cáo|report|tổng hợp|summary|dashboard)/i.test(normalizedPrompt);
        const responseHasMarkdownTable = (response: string | undefined) =>
          typeof response === "string" && /\|[^\n]+\|\s*\n\|[ :-]+\|/.test(response);
        const needsMoreEvidence = () => {
          if (finalAction.action !== "finish") return false;
          const missingData = !finishHasSql(finalAction) && !hasExecutedReadStep(finalSteps);
          const response = typeof finalAction.args?.response === "string" ? finalAction.args.response : "";
          const missingReportTable = wantsReportTable && !responseHasMarkdownTable(response);
          return missingData || missingReportTable;
        };
        while (
          workspaceToolsEnabled
          && !endedWithAskUser
          && evidenceRoundsLeft > 0
          && needsMoreEvidence()
          && isWorkspaceScopedIntent(assistIntent)
        ) {
          evidenceRoundsLeft -= 1;
          const lastChance = evidenceRoundsLeft === 0;
          const missingDataNow = !finishHasSql(finalAction) && !hasExecutedReadStep(finalSteps);
          const composeOnly = !missingDataNow;
          try {
            const recoveryAction = await requestAgentAction(
              buildControllerPrompt(
                lastChance || composeOnly,
                joinAgentInstructions(
                  sharedAgentInstruction,
                  composeOnly
                    ? "The evidence is already gathered. Finish now: args.response MUST contain ONE complete markdown table — | header | row, |---| separator, then data rows — summarizing the verified data, followed by at most three short notes."
                    : lastChance
                      ? "This is the final round. Run the one read that answers the request, or finish with the complete answer built from the evidence already gathered. Do not end with a promise."
                      : "Your previous finish returned no SQL and no executed query, but this request needs real workspace data. Either call sample_table_data, describe_tables, or run_readonly_sql now, or if that is genuinely impossible, finish again with a complete explanation instead of a promise.",
                ),
                finalSteps,
              ),
              false,
            );
            if (recoveryAction.action === "finish") {
              if (finishHasSql(recoveryAction)) {
                finalAction = recoveryAction;
                break;
              }
              finalAction = recoveryAction;
              continue;
            }
            publishAgentProgress({
              action: recoveryAction.action,
              message: recoveryAction.message || "Gathering the missing data.",
            });
            const observation = await runAgentTool(recoveryAction);
            finalSteps = [
              ...finalSteps,
              {
                step: finalSteps.length + 1,
                action: recoveryAction.action,
                message: recoveryAction.message || "No message provided.",
                observation,
              },
            ];
            agentTraceSteps = finalSteps.map((step) => ({ ...step }));
            publishAgentProgress();
            const closingAction = await requestAgentAction(
              buildControllerPrompt(
                true,
                joinAgentInstructions(
                  sharedAgentInstruction,
                  "You now have fresh evidence. Finish now and summarize the actual results for the user.",
                ),
                finalSteps,
              ),
              false,
            );
            finalAction = closingAction.action === "finish"
              ? closingAction
              : await recoverAgentFinishAction("The agent could not conclude after its final data step.");
          } catch (errorValue) {
            if (isSupersededAIRequestError(errorValue)) throw errorValue;
            // The gate is best-effort; fall back to the current finish.
            break;
          }
        }

        const finalization = await finalizeAgentResult({
          availableSchemaTables,
          buildControllerPrompt,
          initialAction: finalAction,
          initialSteps: finalSteps,
          recoverFinishAction: recoverAgentFinishAction,
          requestAgentAction,
          sharedAgentInstruction,
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
        normalizedPrompt,
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
  }, [activeProvider, aiConfigs, askAI, connectionId, currentDatabase, executeSandboxQuery, fetchTables, getTableColumnsPreview, getTableData, getTableStructure, isLocalProvider, previewWriteTransaction, saveAIConfigs]);

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
