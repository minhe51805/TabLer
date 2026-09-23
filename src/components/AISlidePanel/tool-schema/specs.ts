import {
  AI_AGENT_ASK_USER_OPTIONS_LIMIT,
  AI_AGENT_BATCH_CALL_LIMIT,
  AI_AGENT_BATCH_DESCRIBE_LIMIT,
  AI_AGENT_DELEGATE_FOCUS_TABLES_LIMIT,
  AI_AGENT_PLAN_STEP_LIMIT,
  AI_AGENT_PREVIEW_STATEMENT_LIMIT,
  AI_AGENT_READ_PAGE_MAX_CHARS,
  AI_AGENT_SAMPLE_MAX_ROWS,
  AI_AGENT_SCHEMA_OBJECTS_LIMIT,
  AI_AGENT_SEED_DOCUMENT_LIMIT,
  type AIAgentToolName,
  type AIAgentToolSpec,
  type JsonSchema,
} from "./constants";

function objectSchema(
  properties: Record<string, JsonSchema>,
  required: string[],
  additionalProperties = false,
): JsonSchema {
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties,
  };
}

/**
 * Shared failure contract appended to tool descriptions so the model knows the
 * shape of a failed call: `Tool error: <message> {"error","hint","retryable"}`.
 * `hint` carries the corrective action (closest table names, SQL error
 * position); `retryable` tells whether re-issuing the same call can succeed.
 */
const TOOL_ERROR_SHAPE_NOTE =
  ' On failure the observation is `Tool error: <message> {"error","hint","retryable"}` — follow `hint` and only retry when `retryable` is true.';

/**
 * Declarative tool specs keyed by action name. The Record<AIAgentToolName, ...>
 * type makes the set exhaustive: adding a tool to AI_AGENT_TOOL_NAMES forces a
 * spec here at compile time, keeping the native-calling contract in lockstep
 * with the parser registry.
 */
export const AI_AGENT_TOOL_SPECS: Record<AIAgentToolName, AIAgentToolSpec> = {
  ask_user: {
    name: "ask_user",
    description:
      "Ask the user one concise clarifying question when the request is genuinely ambiguous and the answer changes what you would do.",
    parameters: objectSchema(
      {
        question: { type: "string", description: "One concise question." },
        options: {
          type: "array",
          items: { type: "string" },
          uniqueItems: true,
          maxItems: AI_AGENT_ASK_USER_OPTIONS_LIMIT,
          description:
            "Selectable answers rendered as quick-reply buttons. ALWAYS pass 2-4 short options as this array — never write the option list inside the question text.",
        },
        multiple: {
          type: "boolean",
          description: "Set true when the user may pick more than one option.",
        },
      },
      ["question"],
    ),
  },

  update_plan: {
    name: "update_plan",
    description:
      "Maintain a visible step checklist for multi-part requests. Post the full list once you know the shape of the work, then re-post it marking steps done/in_progress as you progress.",
    parameters: objectSchema(
      {
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Short imperative step title." },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "done"],
                description: "Defaults to pending.",
              },
            },
            required: ["title"],
            additionalProperties: false,
          },
          minItems: 1,
          maxItems: AI_AGENT_PLAN_STEP_LIMIT,
          description: `The complete checklist, in order (up to ${AI_AGENT_PLAN_STEP_LIMIT} steps). Always send the FULL list — statuses replace the previous plan.`,
        },
      },
      ["steps"],
    ),
  },

  list_tables: {
    name: "list_tables",
    description:
      "List catalog tables with optional filters. Each entry carries a rowCount, so this is the only source of row counts." +
      TOOL_ERROR_SHAPE_NOTE,
    parameters: objectSchema(
      {
        schema: { type: "string", description: "Optional exact schema filter." },
        pattern: { type: "string", description: "Optional case-insensitive name substring." },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Maximum table names to return (defaults to 200).",
        },
        minRows: {
          type: "integer",
          minimum: 1,
          maximum: 1_000_000_000,
          description: "Only include tables with at least this many rows.",
        },
      },
      [],
    ),
  },

  search_schema: {
    name: "search_schema",
    description:
      "Find where a column or concept lives across the catalog when the user names a field but not the exact table." +
      TOOL_ERROR_SHAPE_NOTE,
    parameters: objectSchema(
      { query: { type: "string", description: "Column name or concept to locate." } },
      ["query"],
    ),
  },

  list_schema_objects: {
    name: "list_schema_objects",
    description:
      "List database views, triggers, and stored routines, optionally with their SQL definition. A view definition is verified business logic (how revenue is actually computed, which statuses are filtered) written by the database owners — prefer reading it over guessing column semantics. Definitions are redacted and truncated; page through with repeated calls if needed." +
      TOOL_ERROR_SHAPE_NOTE,
    parameters: objectSchema(
      {
        objectType: {
          type: "string",
          enum: ["view", "trigger", "routine", "all"],
          description: "Which object kinds to list (defaults to all).",
        },
        pattern: { type: "string", description: "Optional case-insensitive name substring." },
        withDefinition: {
          type: "boolean",
          description:
            "Include each object's SQL definition (redacted, truncated). Only set true for the few objects you actually need.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: AI_AGENT_SCHEMA_OBJECTS_LIMIT,
          description: `Maximum objects to return (defaults to ${AI_AGENT_SCHEMA_OBJECTS_LIMIT}).`,
        },
      },
      [],
    ),
  },

  describe_table: {
    name: "describe_table",
    description:
      "Inspect the exact columns of one or more verified tables before reading rows. Pass a single `table`, or a `tables` array (up to " +
      String(AI_AGENT_BATCH_DESCRIBE_LIMIT) +
      ") to batch several tables into one call." +
      TOOL_ERROR_SHAPE_NOTE,
    parameters: objectSchema(
      {
        table: {
          type: "string",
          description: "Exact table name or identifier (single-table form).",
        },
        tables: {
          type: "array",
          items: { type: "string" },
          uniqueItems: true,
          minItems: 1,
          maxItems: AI_AGENT_BATCH_DESCRIBE_LIMIT,
          description: `Exact table names (up to ${AI_AGENT_BATCH_DESCRIBE_LIMIT}) — batch form; use this instead of repeating describe_table calls.`,
        },
      },
      [],
    ),
  },

  describe_tables: {
    name: "describe_tables",
    description: "Inspect the columns of several tables in one call to save steps.",
    parameters: objectSchema(
      {
        tables: {
          type: "array",
          items: { type: "string" },
          uniqueItems: true,
          minItems: 1,
          maxItems: AI_AGENT_BATCH_DESCRIBE_LIMIT,
          description: `Exact table names (up to ${AI_AGENT_BATCH_DESCRIBE_LIMIT}).`,
        },
      },
      ["tables"],
    ),
  },

  sample_table_data: {
    name: "sample_table_data",
    description:
      "Return a few live rows from one verified table without writing SQL. Does not require describe_table first." +
      TOOL_ERROR_SHAPE_NOTE,
    parameters: objectSchema(
      {
        table: { type: "string", description: "Exact table name or identifier." },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: AI_AGENT_SAMPLE_MAX_ROWS,
          description: `Rows to sample (up to ${AI_AGENT_SAMPLE_MAX_ROWS}).`,
        },
        offset: {
          type: "integer",
          minimum: 0,
          description: "Rows to skip before sampling, for paging through large tables.",
        },
        stats: {
          type: "string",
          enum: ["auto", "sample", "off"],
          description:
            "Column statistics scope. auto (default) computes whole-table null/distinct stats only when the catalog rowCount is known and small enough; larger or unknown-size tables get stats from the sampled rows instead. off skips statistics entirely.",
        },
      },
      ["table"],
    ),
  },

  run_readonly_sql: {
    name: "run_readonly_sql",
    description:
      "Run a read-only observation query (SELECT, SHOW, EXPLAIN, DESCRIBE, WITH, or read-only PRAGMA). Never query system catalogs." +
      TOOL_ERROR_SHAPE_NOTE,
    parameters: objectSchema(
      {
        sql: {
          type: "string",
          description: "A single read-only SQL statement grounded in the verified schema.",
        },
      },
      ["sql"],
    ),
  },
  run_parameterized_sql: {
    name: "run_parameterized_sql",
    description:
      "Run a read-only SELECT with named parameter bindings (:name) instead of splicing literals into SQL. Prefer this over run_readonly_sql whenever a value comes from the user - it is injection-safe and passes sandbox validation." +
      TOOL_ERROR_SHAPE_NOTE,
    parameters: objectSchema(
      {
        sql: {
          type: "string",
          description:
            'A single read-only SQL statement using :name placeholders, e.g. "SELECT * FROM users WHERE name = :name".',
        },
        parameters: {
          type: "array",
          description:
            "Named bindings referenced by the SQL. Every :name in the SQL must have an entry.",
          items: { type: "object" },
        },
      },
      ["sql", "parameters"],
    ),
  },
  find_value: {
    name: "find_value",
    description:
      "Look up rows in a verified table by one column value, executed as a parameterized query. Cheaper and safer than writing SQL for exact-match lookups." +
      TOOL_ERROR_SHAPE_NOTE,
    parameters: objectSchema(
      {
        table: { type: "string", description: "Table name verified by describe_table." },
        column: { type: "string", description: "Exact column name from describe_table." },
        value: {
          type: "string",
          description: "Exact value to find; numbers may be sent unquoted.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Max matching rows (default 10).",
        },
      },
      ["table", "column", "value"],
    ),
  },
  check_sql: {
    name: "check_sql",
    description:
      "Pre-flight your proposed SQL without executing it: verifies read-only shape, table visibility, and schema grounding. Use before finish when you did not run the exact SQL earlier." +
      TOOL_ERROR_SHAPE_NOTE,
    parameters: objectSchema(
      { sql: { type: "string", description: "A single SQL statement to validate." } },
      ["sql"],
    ),
  },

  run_preset: {
    name: "run_preset",
    description:
      "Run a pre-vetted operational query written per engine: process-list shows currently running queries/sessions; user-management lists database users and roles. These are the ONLY sanctioned way to inspect server state — catalog SQL like pg_stat_activity remains blocked in run_readonly_sql on purpose." +
      TOOL_ERROR_SHAPE_NOTE,
    parameters: objectSchema(
      {
        presetId: {
          type: "string",
          enum: ["process-list", "user-management"],
          description: "Which vetted preset to run.",
        },
        list: {
          type: "boolean",
          description:
            "Set true to list preset availability for the current engine instead of running one.",
        },
      },
      [],
    ),
  },

  preview_write: {
    name: "preview_write",
    description:
      "Preview mutating statements inside one transaction that always rolls back. Nothing is persisted; the human applies the final SQL through the approval flow." +
      TOOL_ERROR_SHAPE_NOTE,
    parameters: objectSchema(
      {
        statements: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: AI_AGENT_PREVIEW_STATEMENT_LIMIT,
          description: `INSERT/UPDATE/DELETE/ALTER/CREATE statements (up to ${AI_AGENT_PREVIEW_STATEMENT_LIMIT}).`,
        },
      },
      ["statements"],
    ),
  },

  propose_seed_data: {
    name: "propose_seed_data",
    description:
      "Fill an empty or sparse table or collection with realistic sample data grounded in the fields you verified with describe_table or sample_table_data. On SQL engines this emits INSERT statements; on MongoDB it emits an insertMany script. The script opens in a NEW query tab for the user to review and run — you cannot insert data directly and must never claim data was written.",
    parameters: objectSchema(
      {
        collection: {
          type: "string",
          description:
            "Exact table or collection name to fill (no schema/db prefix, no whitespace or dots).",
        },
        documents: {
          type: "array",
          items: { type: "object", additionalProperties: true },
          minItems: 1,
          maxItems: AI_AGENT_SEED_DOCUMENT_LIMIT,
          description: `Realistic rows (1-${AI_AGENT_SEED_DOCUMENT_LIMIT}), each an object whose fields match the table or collection's verified schema. Never fabricate fields you have not seen.`,
        },
        rationale: {
          type: "string",
          description: "One line explaining the seed shape, shown as the tab title.",
        },
      },
      ["collection", "documents"],
    ),
  },

  remember_term: {
    name: "remember_term",
    description:
      "Persist a business term/metric/relationship/alias to the glossary so future runs on this database see it automatically.",
    parameters: objectSchema(
      {
        term: { type: "string", description: "The term being defined." },
        definition: { type: "string", description: "Its verified definition." },
        kind: {
          type: "string",
          enum: ["term", "metric", "relationship", "alias"],
          description: "Category of the entry.",
        },
      },
      ["term", "definition"],
    ),
  },

  read_memory: {
    name: "read_memory",
    description:
      "Load the full text of one entry from the <agent_memory> index (saved observations for this connection/database). Use it when an index entry looks relevant before acting on it.",
    parameters: objectSchema(
      {
        name: {
          type: "string",
          description: "Entry name exactly as listed in <agent_memory>.",
        },
      },
      ["name"],
    ),
  },

  save_memory: {
    name: "save_memory",
    description:
      "Persist one durable, non-obvious fact for this connection/database (conventions, verified quirks, table roles, user-stated preferences). Overwrites an entry with the same name. NEVER store credentials or secrets. Keep it under 8000 characters.",
    parameters: objectSchema(
      {
        name: {
          type: "string",
          description: "Short slug for the fact (letters, digits, '-', '_', '.').",
        },
        description: {
          type: "string",
          description: "One-line summary shown in the index (max 200 chars).",
        },
        body: {
          type: "string",
          description: "The fact itself, in full sentences a future run can act on.",
        },
      },
      ["name", "body"],
    ),
  },

  delete_memory: {
    name: "delete_memory",
    description:
      "Permanently delete ONE memory entry by its exact name — use when the index is full and an entry is obsolete, or when the user asks to forget something. This cannot be undone. Confirm with the user before deleting an entry you did not write this run.",
    parameters: objectSchema(
      {
        name: {
          type: "string",
          description: "Entry name exactly as listed in <agent_memory>.",
        },
      },
      ["name"],
    ),
  },

  edit_query_sql: {
    name: "edit_query_sql",
    description:
      "Propose corrected SQL for a query tab. If an AI Query tab is already open, pick its tabId from the Query tabs list. If none is open, set createIfMissing: true (omit tabId) and a new AI Query tab is created pre-filled with your SQL. Never leave a requested tab fix undone because no tab is open — createIfMissing is the intended path for that case, not a reason to skip. Smoke-test your statement first: run_readonly_sql for SELECTs, preview_write for mutating SQL — a mutating statement that was never previewed this run is rejected. Mutating proposals automatically get a non-executing EXPLAIN dry-run whose plan (or syntax error) is shown on the review card before the user accepts. You cannot execute proposals yourself; the user accepts or runs them.",
    parameters: objectSchema(
      {
        tabId: {
          type: "string",
          description: "Exact tabId of the target query tab from the Query tabs list.",
        },
        sql: {
          type: "string",
          description: "The corrected SQL that will replace the tab content on acceptance.",
        },
        reason: {
          type: "string",
          description: "One short line explaining what was wrong and what the fix does.",
        },
        createIfMissing: {
          type: "boolean",
          description:
            "Set true when no query tab is open: a new AI Query tab is created pre-filled with the SQL (read-only SQL auto-runs; mutating SQL waits for the user to press Run). Never skip a requested tab fix because no tab is open.",
        },
      },
      ["sql"],
    ),
  },

  create_checkpoint: {
    name: "create_checkpoint",
    description:
      "Snapshot the current database (schema + data) into an app-managed checkpoint file — a SQL INSERT dump, so it only exists on engines that can replay SQL (not mongodb/redis/opensearch). Read-only for the database — it only writes a local file the user can restore with the /rollback command. Use it right before proposing a chain of risky mutations, or after the user says a change went wrong.",
    parameters: objectSchema(
      {
        label: {
          type: "string",
          description:
            "Short ASCII label describing the moment (e.g. 'before bulk grade update'). Optional.",
        },
      },
      [],
    ),
  },

  restore_checkpoint: {
    name: "restore_checkpoint",
    description:
      "Open a rollback confirmation for the user: pick a checkpoint, the user confirms, and the database is restored to that moment (schema + data overwritten). Use it when the user says a change went wrong or asks to undo recent writes. The user must click Restore in the dialog — you cannot force it. Optionally pass label_hint to match a checkpoint label.",
    parameters: objectSchema(
      {
        label_hint: {
          type: "string",
          description:
            "Optional substring of the checkpoint label to restore (e.g. 'before bulk grade update'). Omitted = newest checkpoint.",
        },
      },
      [],
    ),
  },

  skill: {
    name: "skill",
    description:
      "Load the full instructions of an available Agent Skill. Pick the name from the <available_skills> list when the task matches a skill's description, then follow the returned instructions before continuing.",
    parameters: objectSchema(
      {
        name: {
          type: "string",
          description: "Skill name exactly as listed in <available_skills>.",
        },
      },
      ["name"],
    ),
  },

  read_skill_resource: {
    name: "read_skill_resource",
    description:
      "Load one bundled reference file of a skill you have already loaded (progressive disclosure). Pick a path from that skill's 'Bundled resources' list — only references/ and scripts/ files are readable, and only for a skill loaded this run. Use this to pull detailed schemas, docs, or scripts on demand instead of re-deriving them.",
    parameters: objectSchema(
      {
        name: {
          type: "string",
          description:
            "Skill name whose resource to read (must be loaded via the skill tool first).",
        },
        path: {
          type: "string",
          description: "Relative resource path exactly as listed, e.g. references/schema.md.",
        },
      },
      ["name", "path"],
    ),
  },

  delegate: {
    name: "delegate",
    description:
      "Hand one focused, self-contained side question (a definition to recall, a formula to sanity-check, an interpretation to word) to a helper analysis and get a short text answer as your observation. The helper sees the schema context but runs NO tools — keep the instruction self-contained and never delegate data fetching you can do with your own tools.",
    parameters: objectSchema(
      {
        instruction: {
          type: "string",
          description: "The complete side question, answerable from the schema context alone.",
        },
        focusTables: {
          type: "array",
          items: { type: "string" },
          uniqueItems: true,
          maxItems: AI_AGENT_DELEGATE_FOCUS_TABLES_LIMIT,
          description: "Optional verified tables the question is about.",
        },
      },
      ["instruction"],
    ),
  },

  read_page: {
    name: "read_page",
    description:
      "Re-read a previous tool observation that was truncated in the trace (large query results, sampled rows). Pass ref to pick the observation number shown in the trace, or omit it for the most recent one; use offset to keep paging until hasMore is false. This re-reads already-fetched data at zero cost — never re-run a query just to see more of it.",
    parameters: objectSchema(
      {
        ref: {
          type: "integer",
          minimum: 1,
          description:
            "1-based observation number from the trace; omitted means the latest observation.",
        },
        offset: {
          type: "integer",
          minimum: 0,
          description:
            "Character offset to start reading from (use nextOffset from the previous page).",
        },
        limit: {
          type: "integer",
          minimum: 100,
          maximum: AI_AGENT_READ_PAGE_MAX_CHARS,
          description: `Characters to return per page (defaults to ~1400, max ${AI_AGENT_READ_PAGE_MAX_CHARS}).`,
        },
      },
      [],
    ),
  },

  manage_metrics_widget: {
    name: "manage_metrics_widget",
    description:
      "Manage widgets on the open metrics board (the dashboard the user is looking at). list shows every widget with its title, type, span and query; add appends a new widget (title + read-only SELECT query required, type/span optional); update changes a widget's title, query, chart type or grid span; delete removes one; refresh re-runs a widget's query and reports the fresh row count. Target a widget by widgetId (from list) or widgetTitle." +
      TOOL_ERROR_SHAPE_NOTE,
    parameters: objectSchema(
      {
        action: {
          type: "string",
          enum: ["list", "add", "update", "delete", "refresh"],
          description: "Which board operation to perform.",
        },
        boardId: {
          type: "string",
          description: "Board id; omit to use the board open in the workspace.",
        },
        widgetId: {
          type: "string",
          description: "Exact widget id from a list call (preferred over widgetTitle).",
        },
        widgetTitle: {
          type: "string",
          description: "Widget title to match when widgetId is unknown.",
        },
        title: { type: "string", description: "add/update: widget title (required for add)." },
        query: {
          type: "string",
          description: "add/update: read-only SELECT feeding the widget (required for add).",
        },
        type: {
          type: "string",
          enum: [
            "table",
            "scoreboard",
            "bar",
            "horizontal-bar",
            "stacked-bar",
            "line",
            "area",
            "pie",
            "donut",
            "radial",
            "funnel",
            "delta",
            "markdown",
          ],
          description:
            "add/update: chart type (defaults to scoreboard for single-value queries, table otherwise).",
        },
        colSpan: {
          type: "integer",
          minimum: 3,
          maximum: 6,
          description: "update: grid column span (3-6).",
        },
        rowSpan: {
          type: "integer",
          minimum: 2,
          maximum: 6,
          description: "update: grid row span (2-6).",
        },
      },
      ["action"],
    ),
  },

  manage_schedule: {
    name: "manage_schedule",
    description:
      "Create, list, or delete scheduled tasks. kind 'agent' schedules a recurring read-only agent run of `prompt`; kind 'sql' runs `sql` on the interval. database is REQUIRED on create — a schedule without one fires against whatever database happens to be active, which is a bug, so always pass the database the task is about (default to the current one)." +
      TOOL_ERROR_SHAPE_NOTE,
    parameters: objectSchema(
      {
        action: {
          type: "string",
          enum: ["list", "create", "delete"],
          description: "Which schedule operation to perform.",
        },
        id: {
          type: "string",
          description: "delete: schedule id from a list call (preferred over name).",
        },
        name: {
          type: "string",
          description: "create: schedule name; delete: name to match when id is unknown.",
        },
        kind: {
          type: "string",
          enum: ["agent", "sql"],
          description: "create: 'agent' (default) runs prompt read-only; 'sql' runs sql.",
        },
        prompt: {
          type: "string",
          description: "create (kind agent): the recurring task the agent performs each run.",
        },
        sql: {
          type: "string",
          description: "create (kind sql): the statement run on the interval.",
        },
        database: {
          type: "string",
          description: "create: REQUIRED database the schedule runs against.",
        },
        intervalSeconds: {
          type: "integer",
          minimum: 60,
          description: "create: seconds between runs (minimum 60).",
        },
        disabled: {
          type: "boolean",
          description: "create: set true to create the schedule paused (default: enabled).",
        },
      },
      ["action"],
    ),
  },

  open_table_tab: {
    name: "open_table_tab",
    description:
      "Open a data/browse tab for a table in the workspace so the user can see the rows. Use when the user asks to open, show, or browse a table — the table name must come from list_tables." +
      TOOL_ERROR_SHAPE_NOTE,
    parameters: objectSchema(
      {
        table: {
          type: "string",
          description: "Exact table name or identifier from list_tables.",
        },
        database: {
          type: "string",
          description: "Database to open the table in; defaults to the current one.",
        },
      },
      ["table"],
    ),
  },

  manage_skill: {
    name: "manage_skill",
    description:
      "Manage Agent Skills: list the catalog, update a global skill's description/body/version/allowedTools, or enable/disable a skill for future runs. Only global skills are editable — workspace skills live in the user's repository and are read-only by design. There is no delete: the backend has no delete command, so tell the user to remove the skill folder manually if they ask." +
      TOOL_ERROR_SHAPE_NOTE,
    parameters: objectSchema(
      {
        action: {
          type: "string",
          enum: ["list", "update", "enable", "disable"],
          description: "Which skill operation to perform.",
        },
        name: {
          type: "string",
          description: "Skill name exactly as listed (required for update/enable/disable).",
        },
        description: {
          type: "string",
          description: "update: new one-line description.",
        },
        body: {
          type: "string",
          description: "update: new SKILL.md body (the instructions).",
        },
        version: {
          type: "string",
          description: "update: new version string.",
        },
        allowedTools: {
          type: "array",
          items: { type: "string" },
          description:
            "update: replacement allowed-tools list (tool names the skill may use). Omit to keep the stored list.",
        },
      },
      ["action"],
    ),
  },

  manage_rule: {
    name: "manage_rule",
    description:
      "Manage guardrail rules that evaluate agent SQL before it runs. list shows the armed rules (name, action, origin) and any files that failed to load; create writes a new rule file into the linked workspace folder's rules/ directory (or the global rules root when no folder is linked). content must be a complete rule file: frontmatter (name, description, event, pattern, action) plus a markdown body. create refuses to overwrite an existing rule — there is no update or delete; the user edits rule files manually." +
      TOOL_ERROR_SHAPE_NOTE,
    parameters: objectSchema(
      {
        action: {
          type: "string",
          enum: ["list", "create"],
          description: "Which rule operation to perform.",
        },
        name: {
          type: "string",
          description:
            "create: rule file name — lowercase slug [a-z0-9_-], 1-64 chars; must match the frontmatter name.",
        },
        content: {
          type: "string",
          description:
            "create: full rule file text (frontmatter + body). The frontmatter name is synced to args.name automatically.",
        },
      },
      ["action"],
    ),
  },

  switch_database: {
    name: "switch_database",
    description:
      "Switch the active database on the current connection (same as the database picker). The schema context reloads: afterwards list_tables/describe_table/SQL tools see the new database. Use when the user's request is about a different database than the current one." +
      TOOL_ERROR_SHAPE_NOTE,
    parameters: objectSchema(
      {
        database: {
          type: "string",
          description: "Exact database name to switch to.",
        },
      },
      ["database"],
    ),
  },

  batch: {
    name: "batch",
    description:
      `Run several independent tool calls in ONE step (up to ${AI_AGENT_BATCH_CALL_LIMIT}). Read-only calls (list_tables, search_schema, list_schema_objects, describe_table, sample_table_data, run_readonly_sql, run_parameterized_sql, find_value, check_sql, run_preset, read_memory, read_skill_resource) execute in parallel; write/proposal calls (preview_write, edit_query_sql, propose_seed_data, create_checkpoint, restore_checkpoint, remember_term, save_memory, delete_memory) run one at a time in array order. Results come back in the same order as args.calls. finish, ask_user, update_plan, delegate, skill and nested batch are not allowed inside a batch.` +
      TOOL_ERROR_SHAPE_NOTE,
    parameters: objectSchema(
      {
        calls: {
          type: "array",
          minItems: 2,
          maxItems: AI_AGENT_BATCH_CALL_LIMIT,
          items: { type: "object" },
          description:
            'Tool calls as {"action":"<tool name>","args":{…}} objects — same names and args as calling the tools directly.',
        },
      },
      ["calls"],
    ),
  },

  finish: {
    name: "finish",
    description:
      "End the run with the final answer for the user. args.response is REQUIRED: it must contain the complete user-facing answer (a full markdown table when a report, bảng, tổng hợp, or list was requested) built from verified observations — never an empty string or a one-line placeholder. Put the single best runnable SELECT in sql, and the dashboard widgets in metricsWidgets when the request is a metrics board — exactly the cards the user asked for, never padded with extras.",
    parameters: {
      type: "object",
      properties: {
        response: {
          type: "string",
          description:
            "REQUIRED. Complete markdown answer for the user, grounded in the observations collected this run.",
        },
        sql: { type: "string", description: "Optional grounded SQL for later human approval." },
        metricsWidgets: {
          type: "array",
          minItems: 1,
          maxItems: 6,
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Widget heading." },
              type: {
                type: "string",
                enum: [
                  "table",
                  "scoreboard",
                  "bar",
                  "horizontal-bar",
                  "line",
                  "area",
                  "pie",
                  "donut",
                  "radial",
                ],
                description: "Widget kind; unknown kinds fall back to table.",
              },
              query: { type: "string", description: "Grounded SELECT feeding this widget." },
              dimension: { type: "string", description: "Label column returned by the query." },
              measures: {
                type: "array",
                items: { type: "string" },
                description: "Numeric value columns or aliases from the query.",
              },
              transforms: {
                type: "array",
                items: { type: "string" },
                description: "Group/sort operations.",
              },
              limit: { type: "integer", minimum: 1, description: "Max rows for the widget." },
            },
            required: ["title", "type", "query"],
            additionalProperties: false,
          },
          description:
            "Optional dashboard widgets. Match the user's request exactly — same count, same cards; pick a sensible set only when the request leaves the contents open.",
        },
      },
      // finish carries a flexible payload consumed by the finalizer, so extra
      // keys are permitted rather than rejected.
      additionalProperties: true,
    },
  },
};
