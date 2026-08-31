import type { TableInfo } from "../../types";
import {
  AI_SCHEMA_CODEC_VERSION,
  MAX_TABLE_NAMES_IN_CONTEXT,
  type AISchemaCodecMode,
} from "./AISlidePanelUtils";
import type { AgentToolAvailability } from "./ai-agent-engine-gates";
import { formatAgentToolCatalog, NATIVE_TOOL_CALLING_ENABLED } from "./ai-agent-tool-schema";
import type { AIWorkspaceAgentActionName } from "./ai-workspace-types";

export type AssistIntent = "sql" | "explain" | "overview" | "optimize" | "fix-error" | "general";

export interface AgentTraceStep {
  step: number;
  action: AIWorkspaceAgentActionName;
  message: string;
  observation: string;
}

const AI_SCHEMA_CODEC_LEGEND = "Legend T=table C=col:type!flags I=index F=fk flags=pk|nn|df|ai";
const MAX_SCHEMA_CAPSULE_PREVIEW_TABLES = 4;
const MAX_AGENT_PROMPT_CHARS = 48_000;
/** Pre-inspected summaries injected into the controller prompt to save describe_table steps. */
const MAX_PRE_INSPECTED_TABLE_SUMMARIES = 6;
/**
 * Table NAMES are tiny compared to schema capsules, so the controller prompt
 * carries the full catalog up to this bound — agents must not burn tool steps
 * re-listing what they can already see.
 */
const AGENT_FULL_CATALOG_NAME_LIMIT = 400;
/** Recent observations render in full up to this per-step character budget. */
const RECENT_OBSERVATION_CHAR_BUDGET = 2_000;
/** Older observations keep a condensed peek instead of disappearing entirely. */
const OLDER_OBSERVATION_PEEK_CHARS = 400;

function clampObservationText(text: string, budget: number) {
  const flat = text.trim();
  if (flat.length <= budget) return flat;
  return `${flat.slice(0, budget)}\n[observation truncated]`;
}

function normalizeName(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function buildWorkspaceTableIdentifier(
  table: Pick<TableInfo, "name" | "schema">,
  currentDatabase: string | null,
) {
  const tableName = table.name.trim();
  if (!tableName || tableName.includes(".")) return tableName;

  const schemaName = table.schema?.trim();
  if (!schemaName) return tableName;
  if (currentDatabase && normalizeName(schemaName) === normalizeName(currentDatabase)) {
    return tableName;
  }

  return `${schemaName}.${tableName}`;
}

export function buildAgentVisibleTableNames(
  allTableNames: string[],
  prioritizedTableNames: string[],
  limit: number,
) {
  const visibleTableNames: string[] = [];
  const seen = new Set<string>();

  for (const tableName of [...prioritizedTableNames, ...allTableNames]) {
    const normalized = normalizeName(tableName);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    visibleTableNames.push(tableName);
    if (visibleTableNames.length >= limit) break;
  }

  return visibleTableNames;
}

export function buildSchemaCapsulePreview(
  tableSchemas: string[],
  limit = MAX_SCHEMA_CAPSULE_PREVIEW_TABLES,
) {
  return tableSchemas.slice(0, limit).join("\n");
}

export function buildSchemaCapsuleContext(params: {
  currentDatabase: string | null;
  totalTableCount: number;
  visibleTableNames: string[];
  allVisible: boolean;
  tableSchemas: string[];
  schemaCodecMode: AISchemaCodecMode;
  truncatedOverview: boolean;
}) {
  const {
    currentDatabase,
    totalTableCount,
    visibleTableNames,
    allVisible,
    tableSchemas,
    schemaCodecMode,
    truncatedOverview,
  } = params;

  return [
    "Workspace schema capsule:",
    `DB=${currentDatabase || "Default"}`,
    `TC=${totalTableCount}`,
    `TV=${visibleTableNames.join(",")}${allVisible ? "" : ",..."}`,
    `SCHEMA=${AI_SCHEMA_CODEC_VERSION}|mode=${schemaCodecMode}|rowdata=0`,
    AI_SCHEMA_CODEC_LEGEND,
    ...tableSchemas,
    truncatedOverview ? "NOTE=Overview limited to current capsule tables." : "",
    "RULE=Use only tables in TV or capsule lines. Ask if a needed table is missing.",
  ].filter(Boolean).join("\n");
}

export function buildAgentRecoveryContext(params: {
  currentDatabase: string | null;
  availableTableNames: string[];
  visibleTableNames: string[];
  schemaCapsulePreview: string;
}) {
  const { currentDatabase, availableTableNames, visibleTableNames, schemaCapsulePreview } = params;
  return [
    `DB=${currentDatabase || "Default"}`,
    `TC=${availableTableNames.length}`,
    `TV=${visibleTableNames.join(",")}${availableTableNames.length > visibleTableNames.length ? ",..." : ""}`,
    schemaCapsulePreview ? `SCHEMA_PREVIEW=\n${schemaCapsulePreview}` : "",
    "RULE=list_tables for catalog; search_schema for unknown fields; describe_table before assuming columns; stay inside verified schema.",
  ].filter(Boolean).join("\n");
}

export function joinAgentInstructions(...parts: Array<string | undefined>) {
  return parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(" ");
}

export function buildAgentPlanPrompt(params: {
  userPrompt: string;
  assistIntent: AssistIntent;
  currentDatabase: string | null;
  availableTableNames: string[];
  appLanguage: string;
}) {
  const { userPrompt, assistIntent, currentDatabase, availableTableNames, appLanguage } = params;
  const visibleTables = availableTableNames.slice(0, MAX_TABLE_NAMES_IN_CONTEXT);
  const languageRule = appLanguage === "vi"
    ? "Reply in Vietnamese."
    : appLanguage === "zh"
      ? "Reply in Chinese."
      : appLanguage === "ko"
        ? "Reply in Korean."
        : appLanguage === "tr"
          ? "Reply in Turkish."
          : "Reply in English.";

  return [
    "You are an autonomous database agent about to work on a request.",
    "Briefly acknowledge what the user wants and state the plan you will execute now.",
    "Speak in the first person, warm and concise, like a senior engineer thinking out loud (max 3 short sentences).",
    "You will inspect the schema and run read-only queries yourself in the next steps, so commit to a concrete plan.",
    "Do not ask the user for clarification or which tables to use. Pick the most relevant verified tables yourself.",
    "Mention which tables you expect to inspect, but do not write SQL in this step.",
    "Do not use bullet lists or headings; write 2-3 natural sentences.",
    languageRule,
    "",
    `Goal type: ${assistIntent}.`,
    `Current database: ${currentDatabase || "Default"}.`,
    visibleTables.length > 0
      ? `Known tables: ${visibleTables.join(", ")}${availableTableNames.length > visibleTables.length ? ", ..." : ""}`
      : "No table list available yet.",
    "",
    "User request:",
    userPrompt,
  ].filter(Boolean).join("\n");
}

export function buildAgentControllerPrompt(params: {
  userPrompt: string;
  assistIntent: AssistIntent;
  currentDatabase: string | null;
  availableTableNames: string[];
  steps: AgentTraceStep[];
  workspaceToolsEnabled: boolean;
  workspaceToolStatus?: string;
  toolAvailability?: AgentToolAvailability;
  forceFinish?: boolean;
  extraInstruction?: string;
  cachedTableSummaries?: string[];
  glossaryLines?: string[];
  availableSkills?: { name: string; description: string }[];
}) {
  const {
    userPrompt,
    assistIntent,
    currentDatabase,
    availableTableNames,
    steps,
    workspaceToolsEnabled,
    workspaceToolStatus,
    toolAvailability,
    forceFinish,
    extraInstruction,
    cachedTableSummaries,
    glossaryLines,
    availableSkills,
  } = params;
  const visibleTables = availableTableNames.length <= AGENT_FULL_CATALOG_NAME_LIMIT
    ? availableTableNames
    : availableTableNames.slice(0, MAX_TABLE_NAMES_IN_CONTEXT);
  const catalogComplete = availableTableNames.length <= AGENT_FULL_CATALOG_NAME_LIMIT;
  const toolSteps = steps.filter((step) => step.action !== "plan");
  const recentFullObservations = 4;
  const priorSteps = toolSteps.length === 0
    ? "No tool actions have run yet."
    : toolSteps.map((step, index) => {
        const isRecent = index >= toolSteps.length - recentFullObservations;
        return [
          `Step ${step.step}`,
          `Action: ${step.action}`,
          `Message: ${step.message || "No message provided."}`,
          isRecent
            ? `Observation:\n${clampObservationText(step.observation, RECENT_OBSERVATION_CHAR_BUDGET)}`
            : `Observation (older, condensed):\n${clampObservationText(step.observation, OLDER_OBSERVATION_PEEK_CHARS)}`,
        ].join("\n");
      }).join("\n\n");
  const preInspectedSummaries = (cachedTableSummaries ?? []).slice(0, MAX_PRE_INSPECTED_TABLE_SUMMARIES);
  const sqlRead = toolAvailability?.sqlRead !== false;
  const sqlWritePreview = toolAvailability?.sqlWritePreview !== false;
  // With native function calling the 17-tool schema travels in the request's
  // `tools` parameter — duplicating it as prompt text wastes tokens. Keep only
  // the reply contract so text finals still parse.
  const availableActions = NATIVE_TOOL_CALLING_ENABLED
    ? [
        'Tools are attached to this request via native function calling — call them with the schemas supplied to the model.',
        'If you answer in text instead of invoking a tool, reply with exactly one JSON object: {"action":"<tool_name>","message":"short reason","args":{…}} using one of the native tool names (for the final answer use {"action":"finish",…}).',
      ]
    : formatAgentToolCatalog({
        workspaceToolsEnabled,
        availability: toolAvailability,
      });

  const assembled = [
    "Work as an autonomous workspace agent.",
    `Goal type: ${assistIntent}.`,
    `Current database: ${currentDatabase || "Default"}.`,
    workspaceToolsEnabled
      ? `Known tables (${availableTableNames.length}${catalogComplete ? ", complete list below" : ", truncated"}): ${visibleTables.join(", ")}${availableTableNames.length > visibleTables.length ? ", ..." : ""}`
      : "Known tables: unavailable for this turn unless the user explicitly provides them.",
    workspaceToolStatus ? `Workspace tools status: ${workspaceToolStatus}` : "",
    workspaceToolsEnabled && toolAvailability && !sqlRead
      ? `Engine: ${toolAvailability.engineLabel} (${toolAvailability.queryModel}). SQL tools are disabled; do not call run_readonly_sql or preview_write.`
      : "",
    preInspectedSummaries.length > 0
      ? [
          "Pre-inspected tables (schemas already verified below — do NOT call describe_table for these):",
          ...preInspectedSummaries,
        ].join("\n")
      : "",
    (glossaryLines ?? []).length > 0
      ? [
          "Business glossary (verified semantics — treat as source of truth, never contradict these):",
          ...(glossaryLines ?? []),
        ].join("\n")
      : "",
    (availableSkills ?? []).length > 0
      ? [
          "<available_skills>",
          ...(availableSkills ?? []).map((skill) =>
            `<skill><name>${skill.name}</name><description>${skill.description}</description></skill>`),
          "</available_skills>",
          "When the user's task matches one of these skill descriptions, call the skill tool with that name FIRST and follow the returned instructions.",
        ].join("\n")
      : "",
    "",
    "Available actions:",
    ...availableActions,
    "",
    "Rules:",
    "- Return exactly one JSON object and nothing else.",
    "- Write the message field as a short first-person thought that narrates your reasoning.",
    NATIVE_TOOL_CALLING_ENABLED
      ? "- Use only the native tool names provided via function calling."
      : "- Use only the action names above.",
    "- If the request is ambiguous about which table, metric, or meaning is intended, call ask_user once with one short question and up to 4 concrete options instead of guessing.",
    workspaceToolsEnabled
      ? "- Tables can be EMPTY. Before building any report, overview, or dashboard, prefer tables whose rowCount is greater than zero in list_tables output (or pass args {\"minRows\":1}), confirm with sample_table_data when unsure, and skip zero-row tables instead of presenting them as content."
      : "",
    workspaceToolsEnabled && sqlWritePreview
      ? "- To propose data or schema changes, run preview_write with the mutating statements: it executes them inside one transaction and always rolls back, showing real affected rows. NEVER claim a change was persisted; the human applies the final SQL through the approval flow."
      : "",
    workspaceToolsEnabled
      ? "- When you discover a durable, non-obvious semantic fact (what a metric means, what an alias maps to, a hidden relationship), call remember_term once so every future run for this database inherits it."
      : "",
    "- When the user asks for a report, bảng, tổng hợp, summary, or dashboard: finish.args.response MUST contain ONE complete markdown table — a | header | row, a |---|---| separator, then one | row | per item — built from verified data, followed by at most three short note lines.",
    "- General conversation, writing, planning, coding advice, translation, brainstorming, or reasoning should finish directly.",
    workspaceToolsEnabled
      ? "- Use database tools only for current workspace schema/data or direct workspace evidence."
      : "- Database tools are not available for this turn, so respond with action=finish.",
    workspaceToolsEnabled && catalogComplete
      ? "- The Known tables list above is the COMPLETE catalog. Never call list_tables just to enumerate table names — pick relevant names from the list and describe_table them directly. list_tables is only for row counts or filtered lookups."
      : "",
    workspaceToolsEnabled
      ? "- sample_table_data returns a few live rows from one verified table without writing SQL; it does not require describe_table first."
      : "",
    workspaceToolsEnabled && sqlRead
      ? "- run_readonly_sql accepts only SELECT, SHOW, EXPLAIN, DESCRIBE, WITH, or read-only PRAGMA."
      : "",
    workspaceToolsEnabled && !sqlRead
      ? "- Do not invent SQL, CQL, or engine-specific query languages. Read rows with sample_table_data after describing the collection/table."
      : "",
    workspaceToolsEnabled
      ? "- NEVER query system catalogs (information_schema.*, pg_catalog.*, sqlite_master) — their columns differ per engine and catalog guesses like information_schema.tables.row_count do not exist. Row counts come ONLY from the list_tables tool (rowCount field); column facts come ONLY from describe_table/search_schema."
      : "",
    workspaceToolsEnabled && sqlRead
      ? "- Before run_readonly_sql, every table in FROM or JOIN must be inspected: use one describe_tables call for several tables at once, or rely on tables already listed under Pre-inspected tables. Use only the exact columns reported by the latest describe observation; never guess columns such as name, content, title, or value."
      : "",
    workspaceToolsEnabled
      ? "- When the user identifies data by a field or concept but does not name the exact table, call search_schema first. Trust its catalog-wide column matches instead of guessing from table names."
      : "",
    workspaceToolsEnabled
      ? "- For a text search, inspect each candidate table first, then search only its verified text columns."
      : "",
    workspaceToolsEnabled
      ? "- Never execute INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, TRUNCATE, USE, ATTACH, DETACH, SET search_path, GRANT, or REVOKE."
      : "",
    sqlRead
      ? "- Final SQL must be grounded in verified context and ready for later human approval."
      : "- Omit finish.args.sql; this engine cannot run SQL through the agent.",
    workspaceToolsEnabled && sqlRead
      ? "- If data answers the request, run run_readonly_sql before finishing; do not return only query ideas."
      : "",
    workspaceToolsEnabled && !sqlRead
      ? "- If data answers the request, run sample_table_data before finishing; do not return only query ideas."
      : "",
    workspaceToolsEnabled
      ? "- For an individual-record lookup, include the verified primary key or id/*_id column in the SELECT result. TableR uses that stable key to provide a link that opens the exact row."
      : "",
    workspaceToolsEnabled
      ? "- After a successful read, give the user the factual result. Do not repeat the executed SQL in the final response; TableR keeps it in the private audit trace and will provide record links when available."
      : "",
    sqlRead
      ? "- For charts, run a chart-friendly aggregate and return that exact SQL in finish.args.sql."
      : "- For charts, sample the relevant data and describe the chart in finish.args.response. Omit finish.args.sql.",
    forceFinish
      ? "- You must finish now. Return action=finish."
      : workspaceToolsEnabled
        ? "- Prefer another tool step while schema or data evidence is still missing."
        : "- Finish directly unless the user explicitly needs missing workspace data.",
    extraInstruction ? `- Extra instruction: ${extraInstruction}` : "",
    "",
    "User request:",
    userPrompt,
    "",
    "Tool observations so far:",
    priorSteps,
  ].filter(Boolean).join("\n");

  return clampAgentPrompt(assembled);
}

function clampAgentPrompt(prompt: string) {
  if (prompt.length <= MAX_AGENT_PROMPT_CHARS) return prompt;
  const head = prompt.slice(0, MAX_AGENT_PROMPT_CHARS - 400);
  return `${head}\n\n[Trace truncated to fit the prompt budget. Finish using the evidence gathered so far.]`;
}
