import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { getCurrentAppLanguage } from "../../../i18n";
import { useAIStore } from "../../../stores/aiStore";
import { useConnectionStore } from "../../../stores/connectionStore";
import { useQueryStore } from "../../../stores/queryStore";
import { type AIConversationMessage, type AIRequestIntent, type AIRequestMode } from "../../../types";
import { getActiveAIProvider, isLocalAIProvider } from "../../../utils/ai-provider-registry";
import { normalizeAIRequestError } from "../../../utils/ai-request-errors";
import { formatExecutionError } from "../../SQLEditor/SQLEditorUtils";
import { analyzeGeneratedSql, MAX_TABLE_NAMES_IN_CONTEXT, type SqlRiskAnalysis } from "../AISlidePanelUtils";
import {
  aiModeUsesSchemaContext,
  type AIWorkspaceAgentActionName,
  type AIWorkspaceAgentStep,
  type AIWorkspaceInteractionMode,
} from "../ai-workspace-types";
import {
  parseAIAgentToolAction,
  validateAIAgentReadonlySql,
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
import { findAgentSchemaMatches, isAgentRecordLookupRequest } from "../ai-agent-schema-search";
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
const MAX_REMOTE_AGENT_STEPS = 6;
const MAX_LOCAL_COMPLEX_AGENT_STEPS = 14;
const MAX_REMOTE_COMPLEX_AGENT_STEPS = 8;
const MAX_REMOTE_HISTORY_MESSAGES = 4;
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
  const { getTableStructure, getTableColumnsPreview, executeSandboxQuery } = useQueryStore(
    useShallow((state) => ({
      getTableStructure: state.getTableStructure,
      getTableColumnsPreview: state.getTableColumnsPreview,
      executeSandboxQuery: state.executeSandboxQuery,
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
      requestIdRef.current += 1;
    }
  }, [isOpen]);

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
          "You are an autonomous agent that takes action, not a consultant. Decide your own steps: locate unknown fields with search_schema, inspect the exact table with describe_table, then ACTUALLY run run_readonly_sql to gather the data needed to answer. Do not just suggest queries and do not ask the user which query to run first ? pick the most relevant one and run it yourself.",
          "When the user asks to see data, charts, counts, samples, distributions, or 'show me' anything, you MUST run at least one run_readonly_sql before finishing. Finishing with only suggestions and no executed query is a failure.",
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
          });

        const requestAgentAction = async (controllerPrompt: string, includeHistory: boolean, extraInstruction?: string) => {
          let rawAgentResponse = await askAI(
            extraInstruction
              ? `${controllerPrompt}\n\nRepair note:\n${extraInstruction}`
              : controllerPrompt,
            strictRecoveryContext || context,
            "panel",
            "agent",
            includeHistory ? requestHistory : []
          );
          if (requestId !== requestIdRef.current) {
            throw new Error(AI_REQUEST_REPLACED_MESSAGE);
          }

          try {
            return parseAIAgentToolAction(rawAgentResponse);
          } catch {
            rawAgentResponse = await askAI(
              [
                controllerPrompt,
                "",
                "The previous reply was not valid. Return the same next action again as valid JSON only.",
                'Example shape: {"action":"describe_table","message":"Need the schema first.","args":{"table":"users"}}',
              ].join("\n"),
              strictRecoveryContext || context,
              "panel",
              "agent",
              []
            );
            if (requestId !== requestIdRef.current) {
              throw new Error(AI_REQUEST_REPLACED_MESSAGE);
            }
            return parseAIAgentToolAction(rawAgentResponse);
          }
        };

        const runAgentTool = async (action: AIAgentToolAction) => {
          try {
            if (action.action === "list_tables") {
              return stringifyAgentObservation({
                database: currentDatabase || "Default",
                tableCount: latestTables.length,
                tables: latestTables.slice(0, MAX_TABLE_NAMES_IN_CONTEXT).map((table) => ({
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

              const scanned = await mapWithConcurrency(latestTables, 4, async (table) => {
                const identifier = buildWorkspaceTableIdentifier(table, currentDatabase) || table.name;
                try {
                  const columns = await getTableColumnsPreview(
                    connectionId!,
                    identifier,
                    currentDatabase || undefined,
                  );
                  return { identifier, columns, failed: false };
                } catch {
                  return { identifier, columns: [], failed: true };
                }
              });
              if (requestId !== requestIdRef.current) {
                throw new Error(AI_REQUEST_REPLACED_MESSAGE);
              }

              const matches = findAgentSchemaMatches(query, scanned);
              return stringifyAgentObservation({
                query,
                tablesScanned: scanned.length,
                tablesFailed: scanned.filter((entry) => entry.failed).length,
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

              const statements = validateAIAgentReadonlySql(sql);
              const queryResult = await executeSandboxQuery(connectionId!, statements);
              if (requestId !== requestIdRef.current) {
                throw new Error(AI_REQUEST_REPLACED_MESSAGE);
              }

              return summarizeAgentQueryObservation(queryResult);
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

        const agentRunnerResult = await runAIAgentToolLoop({
          workspaceToolsEnabled,
          stepBudget: agentStepBudget,
          initialSteps: agentTraceSteps,
          requestAction: ({ forceFinish, includeHistory, iteration, reason, steps }) => {
            const completedToolSteps = steps.filter((step) => step.action !== "plan");
            if (recordLookupRequest && iteration === 1 && completedToolSteps.length === 0) {
              return Promise.resolve({
                action: "search_schema" as const,
                message: "Locating the exact table and columns for this record",
                args: { query: normalizedPrompt },
              });
            }

            return requestAgentAction(
              buildControllerPrompt(forceFinish, instructionForRunnerRequest(reason), steps),
              includeHistory,
            );
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
            }
          },
        });
        agentTraceSteps = agentRunnerResult.steps;
        const finalization = await finalizeAgentResult({
          availableSchemaTables,
          buildControllerPrompt,
          initialAction: agentRunnerResult.finalAction,
          initialSteps: agentRunnerResult.steps,
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
  }, [activeProvider, aiConfigs, askAI, connectionId, currentDatabase, fetchTables, getTableColumnsPreview, getTableStructure, isLocalProvider, saveAIConfigs]);

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
