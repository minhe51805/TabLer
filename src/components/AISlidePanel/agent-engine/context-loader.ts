import { useAIChatWorkspaceStore } from "../../../stores/aiChatWorkspaceStore";
import { useConnectionStore } from "../../../stores/connectionStore";
import { useSkillPrefsStore } from "../../../stores/skillPrefsStore";
import { useUIStore } from "../../../stores/uiStore";
import { getSemanticGlossary } from "../../../utils/semantic-glossary";
import { invokeWithTimeout } from "../../../utils/tauri-utils";
import { AI_REQUEST_REPLACED_MESSAGE } from "../ai-agent-action-requestor";
import { joinAgentInstructions, type AssistIntent } from "../ai-agent-context";
import { agentToolAvailability, engineAwareDataPlaneHints } from "../ai-agent-engine-gates";
import { isAgentRecordLookupRequest } from "../ai-agent-schema-search";
import { yieldToBrowserFrame } from "../ai-async-utils";
import { prepareAIWorkspaceSchemaContext } from "../ai-schema-context-loader";
import type { AIWorkspaceInteractionMode } from "../ai-workspace-types";
import { getAgentMemoryIndex } from "../hooks/use-agent-memory";
import type { AgentAssistContext, LoadedAgentWorkspaceContext } from "./types";

const MAX_AGENT_STEPS = 10;
const MAX_REMOTE_AGENT_STEPS = 10;
const MAX_LOCAL_COMPLEX_AGENT_STEPS = 14;
const MAX_REMOTE_COMPLEX_AGENT_STEPS = 12;

// Skill catalogs rarely change mid-session; caching for a minute keeps the
// per-run filesystem discovery scan from repeating on every agent run.
let skillsCatalogCache: {
  at: number;
  entries: { name: string; description: string; source: string }[];
} | null = null;
const SKILLS_CATALOG_TTL_MS = 60_000;

if (typeof window !== "undefined") {
  window.addEventListener("agent-skills-changed", () => {
    skillsCatalogCache = null;
  });
}

export async function loadAgentWorkspaceContext(params: {
  ctx: AgentAssistContext;
  requestId: number;
  normalizedPrompt: string;
  assistIntent: AssistIntent;
  interactionMode: AIWorkspaceInteractionMode;
  needsWorkspaceContext: boolean;
  schemaSharingEnabled: boolean;
  schemaContextEnabled: boolean;
  wantsVisualization: boolean;
  wantsMetricsBoard: boolean;
}): Promise<LoadedAgentWorkspaceContext> {
  const {
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
  } = params;
  const {
    activeDbType,
    connectionId,
    currentDatabase,
    fetchTables,
    getTableColumnsPreview,
    getTableStructure,
    isLocalProvider,
    requestIdRef,
    aiSchemaCodecCacheRef,
  } = ctx;

  let latestTables = useConnectionStore.getState().tables ?? [];

  if (schemaContextEnabled && latestTables.length === 0) {
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
        ? "This is a metrics/dashboard/summary request. Inspect the relevant tables, then in finish.args.metricsWidgets return exactly the widgets the user asked for — if they named a count or listed cards, match that number and those cards; only choose a sensible 3-6 set yourself when the request leaves the contents open. Each widget needs a clear title, a type (scoreboard for single totals, bar/pie/line for grouped aggregates, table for detailed breakdowns), and a runnable read-only query grounded in the verified schema. Build the board yourself; do not ask the user which widgets they want."
        : toolAvailability.documentPropose
          ? "This is a metrics/dashboard/summary request. Inspect the relevant collections, then in finish.args.metricsWidgets return exactly the widgets the user asked for — if they named a count or listed cards, match that number and those cards; only choose a sensible 3-6 set yourself when the request leaves the contents open. Each widget needs a clear title, a type (scoreboard for single totals, bar/pie/line for grouped aggregates, table for detailed breakdowns), and a runnable read-only SELECT query grounded in the verified schema — the metrics board translates SELECT ... GROUP BY into a MongoDB aggregation pipeline automatically. Build the board yourself; do not ask the user which widgets they want."
          : "This is a metrics/dashboard/summary request. Inspect the relevant tables with describe_table and sample_table_data, then summarize in finish.args.response. Omit SQL-shaped widget queries."
      : undefined,
  );

  if (interactionMode !== "agent") {
    return {
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
      workspaceBoundDatabase: null,
      knownDatabaseNames: [],
      agentStepBudget,
    };
  }

  const cachedTableSummaries =
    workspaceToolsEnabled && relationalSchemaSummaryByTable.size > 0
      ? [...relationalSchemaSummaryByTable.entries()]
          .filter(([tableName]) => availableSchemaTables.includes(tableName))
          .map(([, summary]) => summary)
      : undefined;

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

  const availableSkills = workspaceToolsEnabled
    ? await (async () => {
        if (skillsCatalogCache && Date.now() - skillsCatalogCache.at < SKILLS_CATALOG_TTL_MS) {
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
          .filter((entry) => useSkillPrefsStore.getState().isEnabled(entry.name))
          .slice(0, 32),
      )
    : undefined;

  const agentMemoryIndex = await getAgentMemoryIndex({
    workspaceToolsEnabled,
    connectionId,
    database: currentDatabase ?? null,
  });

  const queryTabs = workspaceToolsEnabled
    ? useUIStore
        .getState()
        .tabs.filter((tab) => tab.type === "query" && tab.connectionId === connectionId)
        .slice(0, 8)
        .map((tab) => {
          const fullSql = tab.content ?? "";
          const sql =
            fullSql.length > 2_000
              ? `${fullSql.slice(0, 2_000)}\n…[TRUNCATED — showing 2,000 of ${fullSql.length} chars. Never propose a full replacement for content you have not seen.]`
              : fullSql;
          return { tabId: tab.id, title: tab.title, sql };
        })
    : undefined;

  const workspaceStoreState = useAIChatWorkspaceStore.getState();
  const workspaceBoundDatabase =
    workspaceStoreState.workspaces.find(
      (workspace) => workspace.id === workspaceStoreState.activeWorkspaceId,
    )?.database ?? null;
  const knownDatabaseNames = useConnectionStore.getState().databases.map((item) => item.name);

  return {
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
  };
}
