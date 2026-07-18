import type { TableInfo } from "../../types";
import {
  AI_SCHEMA_CODEC_VERSION,
  MAX_TABLE_NAMES_IN_CONTEXT,
  type AISchemaCodecMode,
} from "./AISlidePanelUtils";
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
  forceFinish?: boolean;
  extraInstruction?: string;
}) {
  const {
    userPrompt,
    assistIntent,
    currentDatabase,
    availableTableNames,
    steps,
    workspaceToolsEnabled,
    workspaceToolStatus,
    forceFinish,
    extraInstruction,
  } = params;
  const visibleTables = availableTableNames.slice(0, MAX_TABLE_NAMES_IN_CONTEXT);
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
          isRecent ? `Observation:\n${step.observation}` : "Observation: (older step, omitted to save space)",
        ].join("\n");
      }).join("\n\n");
  const availableActions = workspaceToolsEnabled
    ? [
        '1. {"action":"list_tables","message":"short reason","args":{}}',
        '2. {"action":"search_schema","message":"short reason","args":{"query":"column or concept to find"}}',
        '3. {"action":"describe_table","message":"short reason","args":{"table":"exact_table_name"}}',
        '4. {"action":"run_readonly_sql","message":"short reason","args":{"sql":"SELECT ..."}}',
        '5. {"action":"finish","message":"short reason","args":{"response":"markdown for the user","sql":"optional grounded SQL for later human approval","metricsWidgets":[{"title":"Widget title","type":"bar|horizontal-bar|line|area|pie|donut|radial|table|scoreboard","query":"SELECT ...","dimension":"verified label column","measures":["verified numeric alias"],"transforms":["group/sort operation"],"limit":100}]}}',
      ]
    : ['1. {"action":"finish","message":"short reason","args":{"response":"markdown for the user","sql":"optional grounded SQL for later human approval"}}'];

  const assembled = [
    "Work as an autonomous workspace agent.",
    `Goal type: ${assistIntent}.`,
    `Current database: ${currentDatabase || "Default"}.`,
    workspaceToolsEnabled
      ? `Known tables: ${visibleTables.join(", ")}${availableTableNames.length > visibleTables.length ? ", ..." : ""}`
      : "Known tables: unavailable for this turn unless the user explicitly provides them.",
    workspaceToolStatus ? `Workspace tools status: ${workspaceToolStatus}` : "",
    "",
    "Available actions:",
    ...availableActions,
    "",
    "Rules:",
    "- Return exactly one JSON object and nothing else.",
    "- Write the message field as a short first-person thought that narrates your reasoning.",
    "- Use only the action names above.",
    "- General conversation, writing, planning, coding advice, translation, brainstorming, or reasoning should finish directly.",
    workspaceToolsEnabled
      ? "- Use database tools only for current workspace schema/data or direct workspace evidence."
      : "- Database tools are not available for this turn, so respond with action=finish.",
    workspaceToolsEnabled
      ? "- run_readonly_sql accepts only SELECT, SHOW, EXPLAIN, DESCRIBE, WITH, or read-only PRAGMA."
      : "",
    workspaceToolsEnabled
      ? "- Before run_readonly_sql, call describe_table for every table in FROM or JOIN. Use only the exact columns reported by the latest describe_table observation; never guess columns such as name, content, title, or value."
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
    "- Final SQL must be grounded in verified context and ready for later human approval.",
    workspaceToolsEnabled
      ? "- If data answers the request, run run_readonly_sql before finishing; do not return only query ideas."
      : "",
    workspaceToolsEnabled
      ? "- For an individual-record lookup, include the verified primary key or id/*_id column in the SELECT result. TableR uses that stable key to provide a link that opens the exact row."
      : "",
    workspaceToolsEnabled
      ? "- After a successful read, give the user the factual result. Do not repeat the executed SQL in the final response; TableR keeps it in the private audit trace and will provide record links when available."
      : "",
    "- For charts, run a chart-friendly aggregate and return that exact SQL in finish.args.sql.",
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
