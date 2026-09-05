import type { TableInfo } from "../../types";
import {
  AI_SCHEMA_CODEC_VERSION,
  MAX_TABLE_NAMES_IN_CONTEXT,
  type AISchemaCodecMode,
} from "./AISlidePanelUtils";
import type { AgentToolAvailability } from "./ai-agent-engine-gates";
import { formatAgentToolCatalog, NATIVE_TOOL_CALLING_ENABLED } from "./ai-agent-tool-schema";
import type { AIWorkspaceAgentActionName, AIWorkspaceAgentStep } from "./ai-workspace-types";

export type AssistIntent = "sql" | "explain" | "overview" | "optimize" | "fix-error" | "general";

/**
 * Repeat-call detection (learned from deepseek-harness `repeat-tool-reminder`):
 * actions that carry tool arguments participate in the consecutive-repeat
 * chain; meta actions (plan/think/finish/ask_user) are transparent — they
 * neither count nor reset the chain.
 */
const UNTRACKED_REPEAT_ACTIONS = new Set<AIWorkspaceAgentActionName>([
  "plan",
  "think",
  "ask_user",
  // Re-posting the checklist with updated statuses is the intended rhythm,
  // not a wasted repeat — the plan replaces (not re-derives) state.
  "update_plan",
  // Checkpoints are cheap local snapshots; the executor caps them per run.
  "create_checkpoint",
  "restore_checkpoint",
  "finish",
]);

/** One checklist entry posted through the update_plan tool. */
export interface AgentPlanStep {
  title: string;
  status: "pending" | "in_progress" | "done";
}

export function isRepeatTrackedAction(action: AIWorkspaceAgentActionName): boolean {
  return !UNTRACKED_REPEAT_ACTIONS.has(action);
}

/** Deep key-sort so two argument objects differing only in property order canonicalize identically. */
function sortAgentArgsValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortAgentArgsValue);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortAgentArgsValue(record[key]);
    }
    return sorted;
  }
  return value;
}

export function canonicalizeAgentArgs(args: unknown): string {
  return JSON.stringify(sortAgentArgsValue(args));
}

/** Head-truncate the canonical args quoted in the detailed reminder. */
export function previewAgentArgs(canonicalArgs: string, cap = 500): string {
  if (canonicalArgs.length <= cap) return canonicalArgs;
  return `${canonicalArgs.slice(0, cap)}… (+${canonicalArgs.length - cap} more chars)`;
}

export const REPEAT_CALL_GENTLE_REMINDER =
  "You are repeating the exact same tool call with identical arguments. "
  + "Carefully analyze the previous result before calling again: if the task is "
  + "not complete, try a different approach or different arguments instead of "
  + "repeating the call.";

export function repeatCallDetailedReminder(
  action: AIWorkspaceAgentActionName,
  count: number,
  argsPreview: string,
): string {
  return "Repeated tool call detected:\n"
    + `- tool: ${action}\n`
    + `- consecutive_calls: ${count}\n`
    + `- arguments: ${argsPreview}\n`
    + "The repeated calls are not making progress. Do not call this tool with "
    + "these exact arguments again. Inspect the latest result and choose a "
    + "different action, different arguments, or finish the task if enough "
    + "evidence has been gathered.";
}

/**
 * Merge run-time notes (manual provider switches, chain failovers, retry
 * waits) into the runner's step trace, renumbering sequentially so the stored
 * list has stable, unique ordinals — the persisted bubble format is the same
 * `agentSteps` array, so notes survive reloads through the normal path.
 */
export function mergeRunNotes(
  steps: AIWorkspaceAgentStep[],
  notes: AgentTraceStep[],
): AIWorkspaceAgentStep[] {
  const merged: AIWorkspaceAgentStep[] = [
    ...steps,
    ...notes.map((note) => ({
      step: note.step,
      action: note.action,
      message: note.message,
      observation: note.observation,
      status: "done" as const,
    })),
  ];
  merged.forEach((step, index) => {
    step.step = index + 1;
  });
  return merged;
}

export interface AgentTraceStep {
  step: number;
  action: AIWorkspaceAgentActionName;
  message: string;
  observation: string;
  /** Machine-readable facts extracted from the observation (Phase: structured evidence). */
  facts?: AgentStepFacts;
}

export interface AgentColumnStats {
  column: string;
  nullRatio: number;
  distinctCount: number;
}

export interface AgentStepFacts {
  rowsReturned?: number;
  tables?: string[];
  columnStats?: AgentColumnStats[];
}

/** Footer marker appended to observations carrying machine-readable facts. */
const AGENT_FACTS_PREFIX = "@@facts:";

/** Appends a machine-readable facts footer that survives with the trace. */
export function appendAgentFacts(
  observation: string,
  facts: AgentStepFacts,
): string {
  if (Object.keys(facts).length === 0) return observation;
  return `${observation}\n${AGENT_FACTS_PREFIX}${JSON.stringify(facts)}`;
}

/** Splits an observation into its display text and embedded facts, if any. */
export function parseAgentFacts(observation: string): {
  text: string;
  facts: AgentStepFacts | null;
} {
  const index = observation.lastIndexOf(`\n${AGENT_FACTS_PREFIX}`);
  if (index === -1) return { text: observation, facts: null };
  const raw = observation.slice(index + 1 + AGENT_FACTS_PREFIX.length);
  try {
    const parsed = JSON.parse(raw) as AgentStepFacts;
    if (parsed && typeof parsed === "object") {
      return { text: observation.slice(0, index), facts: parsed };
    }
  } catch {
    // Malformed footer — treat the whole observation as plain text.
  }
  return { text: observation, facts: null };
}

/** Convenience accessor used by quality gates: facts or null. */
export function readStepFacts(step: AgentTraceStep): AgentStepFacts | null {
  if (step.facts) return step.facts;
  const { facts } = parseAgentFacts(step.observation);
  return facts;
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

/**
 * Detects a database name the user explicitly mentions that differs from the
 * database this workspace is bound to (or the one currently open). Returns the
 * mentioned name, or null when there is no conflict.
 */
export function detectDatabaseMentionMismatch(params: {
  userPrompt: string;
  knownDatabaseNames?: string[];
  boundDatabase: string | null;
}): string | null {
  const { userPrompt, knownDatabaseNames, boundDatabase } = params;
  if (!userPrompt.trim() || !knownDatabaseNames || knownDatabaseNames.length === 0) return null;
  const normalizedPrompt = ` ${userPrompt.toLowerCase().replace(/\s+/g, " ")} `;
  for (const name of knownDatabaseNames) {
    const clean = name.trim().toLowerCase();
    if (!clean || clean === (boundDatabase ?? "").trim().toLowerCase()) continue;
    if (clean === "default") continue;
    // Word-boundary match so "sales" does not fire inside "salestrends".
    const pattern = new RegExp(`(^|[^a-z0-9_])${clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9_]|$)`);
    if (pattern.test(normalizedPrompt)) return name;
  }
  return null;
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
  /** Frontmatter-only memory index for this connection/database scope. */
  agentMemoryIndex?: { name: string; description: string; updatedAt: string }[];
  /** Open query tabs on this connection — enables edit_query_sql proposals. */
  queryTabs?: { tabId: string; title: string; sql: string }[];
  knownDatabaseNames?: string[];
  workspaceBoundDatabase?: string | null;
  /** Current checklist (from update_plan), rendered near the top of the prompt. */
  planLines?: string[];
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
    agentMemoryIndex,
    queryTabs,
    knownDatabaseNames,
    workspaceBoundDatabase,
    planLines,
  } = params;
  const databaseMentionMismatch = detectDatabaseMentionMismatch({
    userPrompt,
    knownDatabaseNames,
    boundDatabase: workspaceBoundDatabase ?? currentDatabase,
  });
  const visibleTables = availableTableNames.length <= AGENT_FULL_CATALOG_NAME_LIMIT
    ? availableTableNames
    : availableTableNames.slice(0, MAX_TABLE_NAMES_IN_CONTEXT);
  const catalogComplete = availableTableNames.length <= AGENT_FULL_CATALOG_NAME_LIMIT;
  const toolSteps = steps.filter((step) => step.action !== "plan");
  const recentFullObservations = 4;
  /**
   * Clamps an observation for the controller prompt while keeping the
   * machine-readable facts footer intact: the display text is clamped first,
   * then the parsed footer is re-appended, so a char-budget cut can never
   * amputate the `@@facts:` JSON mid-structure (which would silently drop the
   * step's evidence from the quality gates).
   */
  const clampStepObservation = (step: AgentTraceStep, budget: number) => {
    const { text, facts } = parseAgentFacts(step.observation ?? "");
    const clamped = clampObservationText(text, budget);
    return facts ? appendAgentFacts(clamped, facts) : clamped;
  };
  const priorSteps = toolSteps.length === 0
    ? "No tool actions have run yet."
    : toolSteps.map((step, index) => {
        const isRecent = index >= toolSteps.length - recentFullObservations;
        return [
          `Step ${step.step}`,
          `Action: ${step.action}`,
          `Message: ${step.message || "No message provided."}`,
          isRecent
            ? `Observation:\n${clampStepObservation(step, RECENT_OBSERVATION_CHAR_BUDGET)}`
            : `Observation (older, condensed):\n${clampStepObservation(step, OLDER_OBSERVATION_PEEK_CHARS)}`,
        ].join("\n");
      }).join("\n\n");
  const preInspectedSummaries = (cachedTableSummaries ?? []).slice(0, MAX_PRE_INSPECTED_TABLE_SUMMARIES);
  const sqlRead = toolAvailability?.sqlRead !== false;
  const sqlWritePreview = toolAvailability?.sqlWritePreview !== false;
  // With native function calling the 19-tool schema travels in the request's
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
    databaseMentionMismatch
      ? [
          `DATABASE MISMATCH WARNING: this workspace is bound to database "${currentDatabase || "Default"}", but the user's request explicitly mentions database "${databaseMentionMismatch}".`,
          `The schema context above belongs to "${currentDatabase || "Default"}" — do NOT pretend it describes "${databaseMentionMismatch}".`,
          `Do NOT guess tables from the wrong database. If the user's request actually targets "${databaseMentionMismatch}", tell them the workspace is bound to "${currentDatabase || "Default"}" and ask (ask_user) whether to rebind it via the workspace switcher's database chip.`,
        ].join("\n")
      : "",
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
    (agentMemoryIndex ?? []).length > 0
      ? [
          "<agent_memory>",
          ...(agentMemoryIndex ?? []).map((entry) =>
            `<memory><name>${entry.name}</name><updated>${entry.updatedAt}</updated><description>${entry.description}</description></memory>`),
          "</agent_memory>",
          "These are saved observations for THIS connection/database (freshness = <updated>). Load one of them with read_memory when it looks relevant; persist new durable facts with save_memory (never credentials; they are rejected).",
        ].join("\n")
      : "",
    (queryTabs ?? []).length > 0
      ? [
          "Query tabs open for this connection (tabId is required by edit_query_sql; sql is the current content to fix):",
          ...(queryTabs ?? []).map((tab) =>
            `<query_tab><tabId>${tab.tabId}</tabId><title>${tab.title}</title><sql>${tab.sql}</sql></query_tab>`),
          "To fix a query in one of these tabs, call edit_query_sql with that tabId. Smoke-test mutating SQL with preview_write first. The user accepts or rejects the proposal in the tab; you cannot execute it.",
        ].join("\n")
      : [
          "No query tab is open. If the user's task involves fixing or landing SQL in a query tab, NEVER skip for lack of a tab: call edit_query_sql with createIfMissing: true (omit tabId) — a new AI Query tab opens automatically, pre-filled with your SQL (read-only SQL runs right away). Skipping because no tab exists is wrong; auto-creating one IS fulfilling the request.",
        ].join("\n"),
    (planLines ?? []).length > 0
      ? [
          "Current plan (from your latest update_plan):",
          ...(planLines ?? []),
          "Keep this checklist current: re-post update_plan with the full list whenever a step's status changes.",
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
    workspaceToolsEnabled
      ? "- For multi-part requests, post your working checklist with update_plan once you know the shape of the work, and re-post it (full list, updated statuses) as you complete steps."
      : "",
    workspaceToolsEnabled
      ? "- For a self-contained side question (a definition, formula check, or wording), delegate it once instead of burning several tool steps; the helper returns a short text answer. Never delegate data fetching you can do with your own tools."
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
    workspaceToolsEnabled
      ? "- Before proposing destructive or bulk mutations (UPDATE/DELETE without a tight key, DROP, TRUNCATE), call create_checkpoint so the user has a restore point, and mention that /rollback restores it. The app also auto-checkpoints before approved writes. When the user asks to undo writes, call restore_checkpoint — the user confirms the rollback dialog; never fake the result."
      : "",
    workspaceToolsEnabled && sqlRead
      ? "- Before run_readonly_sql, every table in FROM or JOIN must be inspected: use one describe_table call with a `tables` array for several tables at once, or rely on tables already listed under Pre-inspected tables. Use only the exact columns reported by the latest describe observation; never guess columns such as name, content, title, or value."
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
