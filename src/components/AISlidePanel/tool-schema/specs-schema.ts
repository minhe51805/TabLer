import {
  AI_AGENT_BATCH_DESCRIBE_LIMIT,
  AI_AGENT_READ_PAGE_MAX_CHARS,
  AI_AGENT_SAMPLE_MAX_ROWS,
  AI_AGENT_SCHEMA_OBJECTS_LIMIT,
  type AIAgentToolName,
  type AIAgentToolSpec,
} from "./constants";
import { objectSchema, TOOL_ERROR_SHAPE_NOTE } from "./specs-shared";
import { ADMIN_PRESET_KINDS } from "../../../utils/admin-query-presets";

export const SPECS: Partial<Record<AIAgentToolName, AIAgentToolSpec>> = {
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
      "Run a pre-vetted operational query written per engine: process-list shows running queries/sessions; user-management lists database users/roles; server-info reports the engine build and uptime; locks reports lock/contention state; table-stats lists per-table size and row counts; index-usage surfaces unused or rarely used indexes; slow-queries lists the heaviest or longest-running statements. These are the ONLY sanctioned way to inspect server state — catalog SQL like pg_stat_activity remains blocked in run_readonly_sql on purpose." +
      TOOL_ERROR_SHAPE_NOTE,
    parameters: objectSchema(
      {
        presetId: {
          type: "string",
          enum: [...ADMIN_PRESET_KINDS],
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
};
