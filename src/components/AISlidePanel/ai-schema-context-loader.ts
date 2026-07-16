import type { ColumnDetail, TableInfo, TableStructure } from "../../types/database";
import {
  MAX_AI_SCHEMA_CODEC_CACHE_ENTRIES,
  MAX_TABLE_NAMES_IN_CONTEXT,
  encodeStructureForAI,
  inferAISchemaCodecMode,
  pickRelevantTables,
} from "./AISlidePanelUtils";
import {
  buildAgentRecoveryContext,
  buildAgentVisibleTableNames,
  buildSchemaCapsuleContext,
  buildSchemaCapsulePreview,
  buildWorkspaceTableIdentifier,
  type AssistIntent,
} from "./ai-agent-context";
import { mapWithConcurrency, setBoundedCacheEntry, yieldToBrowserFrame } from "./ai-async-utils";
import type { AIWorkspaceInteractionMode } from "./ai-workspace-types";

const MAX_OVERVIEW_SCHEMA_TABLES = 12;
const MAX_SCHEMA_FETCH_CONCURRENCY = 2;
const MAX_REMOTE_AGENT_SCHEMA_TABLES = 3;
const MAX_REMOTE_AGENT_VISIBLE_TABLES = 12;
const MAX_REMOTE_AGENT_OVERVIEW_TABLES = 4;
const MAX_LOCAL_AGENT_VISIBLE_TABLES = 24;

export interface PreparedAIWorkspaceSchemaContext {
  agentPromptTableNames: string[];
  availableSchemaTables: string[];
  context: string;
  contextVisibleTableNames: string[];
  relationalSchemaSummaryByTable: Map<string, string>;
  strictRecoveryContext: string;
}

interface PrepareAIWorkspaceSchemaContextOptions {
  connectionId: string;
  currentDatabase: string | null;
  interactionMode: AIWorkspaceInteractionMode;
  intent: AssistIntent;
  isCurrentRequest: () => boolean;
  isLocalProvider: boolean;
  normalizedPrompt: string;
  schemaCodecCache: Map<string, string>;
  schemaContextEnabled: boolean;
  tables: TableInfo[];
  getTableColumnsPreview: (connectionId: string, table: string, database?: string) => Promise<ColumnDetail[]>;
  getTableStructure: (connectionId: string, table: string, database?: string) => Promise<TableStructure>;
}

export async function prepareAIWorkspaceSchemaContext(
  options: PrepareAIWorkspaceSchemaContextOptions,
): Promise<PreparedAIWorkspaceSchemaContext> {
  const {
    connectionId,
    currentDatabase,
    interactionMode,
    intent,
    isCurrentRequest,
    isLocalProvider,
    normalizedPrompt,
    schemaCodecCache,
    schemaContextEnabled,
    tables,
    getTableColumnsPreview,
    getTableStructure,
  } = options;
  let context = connectionId
    ? [
        "Workspace metadata:",
        `Current database: ${currentDatabase || "Default"}`,
        "Schema sharing enabled: yes",
      ].join("\n")
    : ["Workspace metadata:", "No active database connection is selected for this turn."].join("\n");
  const relationalSchemaSummaryByTable = new Map<string, string>();
  let availableSchemaTables: string[] = [];
  let strictRecoveryContext = "";
  let agentPromptTableNames: string[] = [];
  let contextVisibleTableNames: string[] = [];

  if (!schemaContextEnabled) {
    return {
      agentPromptTableNames,
      availableSchemaTables,
      context,
      contextVisibleTableNames,
      relationalSchemaSummaryByTable,
      strictRecoveryContext,
    };
  }

  availableSchemaTables = tables
    .map((table) => buildWorkspaceTableIdentifier(table, currentDatabase))
    .filter(Boolean);
  const tablesToFetch = intent === "overview"
    ? tables.slice(0, isLocalProvider ? MAX_OVERVIEW_SCHEMA_TABLES : MAX_REMOTE_AGENT_OVERVIEW_TABLES)
    : isLocalProvider
      ? pickRelevantTables(normalizedPrompt, tables)
      : pickRelevantTables(normalizedPrompt, tables).slice(0, MAX_REMOTE_AGENT_SCHEMA_TABLES);
  const schemaCodecMode = intent === "overview" ? "relational" : inferAISchemaCodecMode(normalizedPrompt);
  await yieldToBrowserFrame();
  const entries = await mapWithConcurrency(
    tablesToFetch,
    schemaCodecMode === "relational" ? MAX_SCHEMA_FETCH_CONCURRENCY : tablesToFetch.length,
    async (table) => {
      const tableName = buildWorkspaceTableIdentifier(table, currentDatabase) || table.name;
      const cacheKey = `${connectionId}:${currentDatabase || "default"}:${schemaCodecMode}:${tableName}`;
      const cached = schemaCodecCache.get(cacheKey);
      if (cached) {
        if (schemaCodecMode === "relational") relationalSchemaSummaryByTable.set(tableName, cached);
        return { tableName, summary: cached };
      }
      try {
        const structure = schemaCodecMode === "core"
          ? {
              columns: await getTableColumnsPreview(connectionId, tableName, currentDatabase || undefined),
              indexes: [],
              foreign_keys: [],
            }
          : await getTableStructure(connectionId, tableName, currentDatabase || undefined);
        const summary = encodeStructureForAI(tableName, structure, { mode: schemaCodecMode });
        setBoundedCacheEntry(schemaCodecCache, cacheKey, summary, MAX_AI_SCHEMA_CODEC_CACHE_ENTRIES);
        if (schemaCodecMode === "relational") relationalSchemaSummaryByTable.set(tableName, summary);
        return { tableName, summary };
      } catch {
        const summary = `T:${tableName}|C:[]`;
        setBoundedCacheEntry(schemaCodecCache, cacheKey, summary, MAX_AI_SCHEMA_CODEC_CACHE_ENTRIES);
        if (schemaCodecMode === "relational") relationalSchemaSummaryByTable.set(tableName, summary);
        return { tableName, summary };
      }
    },
  );
  if (!isCurrentRequest()) throw new Error("This AI request was replaced by a newer one.");
  await yieldToBrowserFrame();

  const schemaCapsulePreview = buildSchemaCapsulePreview(entries.map((entry) => entry.summary));
  const prioritizedAgentTableNames = entries.map((entry) => entry.tableName);
  contextVisibleTableNames = buildAgentVisibleTableNames(
    availableSchemaTables,
    prioritizedAgentTableNames,
    isLocalProvider ? MAX_TABLE_NAMES_IN_CONTEXT : MAX_REMOTE_AGENT_VISIBLE_TABLES,
  );
  agentPromptTableNames = interactionMode === "agent"
    ? buildAgentVisibleTableNames(
        availableSchemaTables,
        prioritizedAgentTableNames,
        isLocalProvider ? MAX_LOCAL_AGENT_VISIBLE_TABLES : MAX_REMOTE_AGENT_VISIBLE_TABLES,
      )
    : [];
  context = buildSchemaCapsuleContext({
    currentDatabase,
    totalTableCount: tables.length,
    visibleTableNames: contextVisibleTableNames,
    allVisible: tables.length <= contextVisibleTableNames.length,
    tableSchemas: entries.map((entry) => entry.summary),
    schemaCodecMode,
    truncatedOverview: intent === "overview" && tables.length > tablesToFetch.length,
  });
  strictRecoveryContext = interactionMode === "agent"
    ? buildAgentRecoveryContext({
        currentDatabase,
        availableTableNames: availableSchemaTables,
        visibleTableNames: agentPromptTableNames,
        schemaCapsulePreview,
      })
    : [
        `DB=${currentDatabase || "Default"}`,
        `TV=${(isLocalProvider ? availableSchemaTables : contextVisibleTableNames).join(",")}${!isLocalProvider && availableSchemaTables.length > contextVisibleTableNames.length ? ",..." : ""}`,
        schemaCapsulePreview ? `SCHEMA_PREVIEW=\n${schemaCapsulePreview}` : "",
        "RULE=Stay strictly inside the verified schema capsule.",
      ].filter(Boolean).join("\n");

  return {
    agentPromptTableNames,
    availableSchemaTables,
    context,
    contextVisibleTableNames,
    relationalSchemaSummaryByTable,
    strictRecoveryContext,
  };
}
