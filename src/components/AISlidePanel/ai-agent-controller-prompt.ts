import { MAX_TABLE_NAMES_IN_CONTEXT } from "./AISlidePanelUtils";
import type { AgentToolAvailability } from "./ai-agent-engine-gates";
import { formatAgentToolCatalog, NATIVE_TOOL_CALLING_ENABLED } from "./ai-agent-tool-schema";
import { rankAgentMemoriesByRelevance } from "./ai-agent-memory-recall";
import {
  appendAgentFacts,
  clampObservationText,
  detectDatabaseMentionMismatch,
  parseAgentFacts,
  type AgentTraceStep,
  type AssistIntent,
} from "./ai-agent-context";

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
/**
 * Hard cap on how many saved-memory index entries are injected into the
 * controller prompt. The recall index is standing context on EVERY step, so an
 * unbounded list would silently inflate cost as a connection accrues memories.
 * Relevant matches are sorted first before the cap, so a relevant memory is
 * never hidden by it (bodies still load on demand via read_memory).
 */
const MAX_AGENT_MEMORY_INDEX_ENTRIES = 24;
/**
 * Shared, proactive save_memory directive (item 7). Kept as one constant so the
 * "populated index", "relevant match", and "empty index" prompt branches all
 * nudge the model to persist durable facts the SAME way — with a concrete
 * example — instead of the weaker, drifting phrasings they used before.
 */
const AGENT_MEMORY_SAVE_HINT =
  'Proactively persist durable facts with save_memory the moment you learn them — a schema fact, a user preference (naming, formatting, SQL dialect), or a correction the user makes (e.g. "is_deleted marks a soft-delete", "amounts are stored in cents", a status column\'s enum values). Save without being asked so future runs start smarter; never store credentials — they are rejected.';

export function buildAgentPlanPrompt(params: {
  userPrompt: string;
  assistIntent: AssistIntent;
  currentDatabase: string | null;
  availableTableNames: string[];
  appLanguage: string;
}) {
  const { userPrompt, assistIntent, currentDatabase, availableTableNames, appLanguage } = params;
  const visibleTables = availableTableNames.slice(0, MAX_TABLE_NAMES_IN_CONTEXT);
  const languageRule =
    appLanguage === "vi"
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
  ]
    .filter(Boolean)
    .join("\n");
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
  /** Frontmatter-only memory index for this connection/database scope.
   *  `null` = the backend read failed — NOT an empty store. */
  agentMemoryIndex?: { name: string; description: string; updatedAt: string }[] | null;
  /** Open query tabs on this connection — enables edit_query_sql proposals. */
  queryTabs?: { tabId: string; title: string; sql: string }[];
  knownDatabaseNames?: string[];
  workspaceBoundDatabase?: string | null;
  /** Current checklist (from update_plan), rendered near the top of the prompt. */
  planLines?: string[];
  /**
   * Compacted summary of trace steps already folded away ("Earlier context").
   * Rendered just before the verbatim step tail so a long run keeps its
   * earlier findings without replaying every raw observation.
   */
  earlierContext?: string;
  /**
   * P10: the run is an unattended scheduled agent task. Narrows the text catalog
   * to the read-only tool surface and states plainly that no human can answer,
   * so the model reports findings instead of asking or proposing writes.
   */
  unattendedReadOnly?: boolean;
  /**
   * The workspace's agent autonomy grant. Under "full" the finish SQL runs
   * immediately (no review tab, no dialog); anything lower opens it for the
   * user to run. The agent must narrate the real outcome, not guess.
   */
  agentAutonomy?: "review" | "smart" | "full";
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
    earlierContext,
    unattendedReadOnly,
    agentAutonomy,
  } = params;
  const databaseMentionMismatch = detectDatabaseMentionMismatch({
    userPrompt,
    knownDatabaseNames,
    boundDatabase: currentDatabase ?? workspaceBoundDatabase ?? null,
  });
  const visibleTables =
    availableTableNames.length <= AGENT_FULL_CATALOG_NAME_LIMIT
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
  const priorSteps =
    toolSteps.length === 0
      ? "No tool actions have run yet."
      : toolSteps
          .map((step, index) => {
            const isRecent = index >= toolSteps.length - recentFullObservations;
            return [
              `Step ${step.step}`,
              `Action: ${step.action}`,
              `Message: ${step.message || "No message provided."}`,
              isRecent
                ? `Observation:\n${clampStepObservation(step, RECENT_OBSERVATION_CHAR_BUDGET)}`
                : `Observation (older, condensed):\n${clampStepObservation(step, OLDER_OBSERVATION_PEEK_CHARS)}`,
            ].join("\n");
          })
          .join("\n\n");
  const preInspectedSummaries = (cachedTableSummaries ?? []).slice(
    0,
    MAX_PRE_INSPECTED_TABLE_SUMMARIES,
  );
  const sqlRead = toolAvailability?.sqlRead !== false;
  const sqlWritePreview = toolAvailability?.sqlWritePreview !== false;
  // With native function calling the 19-tool schema travels in the request's
  // `tools` parameter — duplicating it as prompt text wastes tokens. Keep only
  // the reply contract so text finals still parse.
  const availableActions = NATIVE_TOOL_CALLING_ENABLED
    ? [
        "Tools are attached to this request via native function calling — call them with the schemas supplied to the model.",
        'If you answer in text instead of invoking a tool, reply with exactly one JSON object: {"action":"<tool_name>","message":"short reason","args":{…}} using one of the native tool names (for the final answer use {"action":"finish",…}).',
      ]
    : formatAgentToolCatalog({
        workspaceToolsEnabled,
        availability: toolAvailability,
        unattendedReadOnly,
      });

  const assembled = [
    "Work as an autonomous workspace agent.",
    `Goal type: ${assistIntent}.`,
    `Current database: ${currentDatabase || "Default"}.`,
    unattendedReadOnly
      ? [
          "UNATTENDED SCHEDULED RUN: this run was started by a scheduled task, not by a person. Nobody is watching and nobody can answer a question or approve a change.",
          "This run is READ-ONLY: it can read data and report findings, and it must never change data, propose SQL edits, or write memory/rules/skills. Finish with a concise report of what you found.",
          "Never call ask_user (there is no one to answer) and never call preview_write, propose_seed_data, edit_query_sql, remember_term, save_memory, delete_memory, create_checkpoint or restore_checkpoint — they are refused, and a blocked step must be reported as BLOCKED, not as done.",
        ].join("\n")
      : "",
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
      ? `Engine: ${toolAvailability.engineLabel} (${toolAvailability.queryModel}). SQL tools are disabled; do not call run_readonly_sql or preview_write.${toolAvailability.documentPropose ? " Filling collections IS supported via propose_seed_data." : ""}`
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
    // Prompt-cache stability: this catalog is backend-sorted and fetched once
    // per run, and it lives here in the STATIC context preamble — ahead of the
    // volatile step trace. Keep it in the prefix so remote prompt caching can
    // reuse it across every controller call of the run; do not move it into the
    // per-step tail. Skill BODIES load later as tool observations by design.
    (availableSkills ?? []).length > 0
      ? [
          "<available_skills>",
          ...(availableSkills ?? []).map(
            (skill) =>
              `<skill><name>${skill.name}</name><description>${skill.description}</description></skill>`,
          ),
          "</available_skills>",
          "When the user's task matches one of these skill descriptions, call the skill tool with that name FIRST and follow the returned instructions.",
        ].join("\n")
      : "",
    agentMemoryIndex === null
      ? "The saved-memory index could not be loaded (backend read failed). Do not assume the store is empty; avoid save_memory until read_memory works, and say so in your report."
      : (agentMemoryIndex ?? []).length > 0
        ? (() => {
            // Recall: rank the saved memories by relevance to THIS request so the
            // one that answers it is surfaced first and explicitly flagged,
            // instead of relying on the model to notice it in storage order.
            const ranked = rankAgentMemoriesByRelevance(agentMemoryIndex ?? [], userPrompt)
              // Relevant matches first, THEN cap — so the bound trims only the
              // least-relevant tail and can never drop a memory that matches this
              // request. Keeps the standing recall index cost bounded per step.
              .slice()
              .sort((left, right) => Number(right.relevant) - Number(left.relevant))
              .slice(0, MAX_AGENT_MEMORY_INDEX_ENTRIES);
            const anyRelevant = ranked.some((item) => item.relevant);
            return [
              "<agent_memory>",
              ...ranked.map(
                ({ entry, relevant }) =>
                  `<memory relevant="${relevant}"><name>${entry.name}</name><updated>${entry.updatedAt}</updated><description>${entry.description}</description></memory>`,
              ),
              "</agent_memory>",
              anyRelevant
                ? `These are saved observations for THIS connection/database (freshness = <updated>), ordered by relevance to the current request. Entries with relevant="true" closely match what the user is asking — load them with read_memory FIRST, before other tools, and use them to answer. ${AGENT_MEMORY_SAVE_HINT}`
                : `These are saved observations for THIS connection/database (freshness = <updated>). Load one of them with read_memory when it looks relevant. ${AGENT_MEMORY_SAVE_HINT}`,
            ].join("\n");
          })()
        : workspaceToolsEnabled
          ? `No saved memories exist yet for this connection/database. ${AGENT_MEMORY_SAVE_HINT}`
          : "",
    (queryTabs ?? []).length > 0
      ? [
          "Query tabs open for this connection (tabId is required by edit_query_sql; sql is the current content to fix):",
          ...(queryTabs ?? []).map(
            (tab) =>
              `<query_tab><tabId>${tab.tabId}</tabId><title>${tab.title}</title><sql>${tab.sql}</sql></query_tab>`,
          ),
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
    '- Never invent limits on your own toolbelt. Every tool attached to this request stays callable for the whole run; claims like "the toolbelt is limited" or "only planning and search are available" are always false. Execute every requested capability yourself.',
    '- Report every step honestly: a step whose observation was "Tool error" or "Tool blocked" is FAIL or BLOCKED in your final summary, never PASS. Never claim a UI effect (a tab opened, a checkpoint saved, a memory written) that no tool observation in this run confirmed.',
    workspaceToolsEnabled
      ? "- Work through the FULL request: while your plan still has steps you have not attempted with a real tool call, do not finish. A step may end blocked, but only after you actually invoked its tool."
      : "",
    "- If the request is ambiguous about which table, metric, or meaning is intended, call ask_user once with one short question plus 2-4 concrete options passed via the options array — never write the option list inside the question text — instead of guessing.",
    workspaceToolsEnabled
      ? '- Tables can be EMPTY. Before building any report, overview, or dashboard, prefer tables whose rowCount is greater than zero in list_tables output (or pass args {"minRows":1}), confirm with sample_table_data when unsure, and skip zero-row tables instead of presenting them as content.'
      : "",
    workspaceToolsEnabled && (toolAvailability?.previewWrite ?? sqlWritePreview)
      ? "- To propose data or schema changes, run preview_write with the mutating statements: it executes them inside one transaction and always rolls back, showing real affected rows. NEVER claim a change was persisted; the human applies the final SQL through the approval flow."
      : "",
    workspaceToolsEnabled && toolAvailability?.seedPropose
      ? "- To fill an empty or sparse table or collection with sample data: verify its fields with describe_table or sample_table_data first, then call propose_seed_data with realistic rows matching those fields. It opens the INSERT (or MongoDB insertMany) script in a NEW query tab that the user reviews and runs — you cannot insert data directly and must never claim data was written."
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
    workspaceToolsEnabled
      ? "- When the user asks for a dashboard, metrics board, or KPI widgets, call manage_metrics_widget to create or update the widgets on the open metrics board — do not only describe the layout. Run the aggregate queries first so each widget's query is grounded in verified data. Create exactly the widgets the user asked for — same count, same cards; never pad the board with extras they did not request."
      : "",
    workspaceToolsEnabled && agentAutonomy === "full"
      ? "- Autonomy is FULL: the SQL in finish.args.sql executes immediately when you finish — it does NOT open a review tab. Narrate the real outcome (what ran, what changed), never tell the user to run it themselves."
      : workspaceToolsEnabled
        ? "- Autonomy is SUPERVISED: the SQL in finish.args.sql opens in a review tab for the user to run — it does not execute on its own. Say so plainly."
        : "",
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
    earlierContext
      ? [
          "Earlier context (compacted summary of steps already folded away — treat as verified findings, do not re-run them):",
          earlierContext,
        ].join("\n")
      : "",
    "Tool observations so far:",
    priorSteps,
  ]
    .filter(Boolean)
    .join("\n");

  return clampAgentPrompt(assembled);
}

function clampAgentPrompt(prompt: string) {
  if (prompt.length <= MAX_AGENT_PROMPT_CHARS) return prompt;
  const head = prompt.slice(0, MAX_AGENT_PROMPT_CHARS - 400);
  return `${head}\n\n[Trace truncated to fit the prompt budget. Finish using the evidence gathered so far.]`;
}
