/**
 * Canonical agent tool names, per-tool numeric limits, the JSON-Schema subset
 * used for tool parameters, and the workspace-only tool set. Pure declarations
 * with no imports so every other tool-schema module can depend on it freely.
 */
export const AI_AGENT_TOOL_NAMES = [
  "ask_user",
  "update_plan",
  "list_tables",
  "search_schema",
  "list_schema_objects",
  "describe_table",
  "describe_tables",
  "sample_table_data",
  "run_readonly_sql",
  "run_parameterized_sql",
  "find_value",
  "check_sql",
  "run_preset",
  "preview_write",
  "propose_seed_data",
  "remember_term",
  "read_memory",
  "save_memory",
  "edit_query_sql",
  "delete_memory",
  "create_checkpoint",
  "restore_checkpoint",
  "skill",
  "read_skill_resource",
  "delegate",
  "read_page",
  "finish",
] as const;

export type AIAgentToolName = (typeof AI_AGENT_TOOL_NAMES)[number];

/** Hard ceiling for sample_table_data so a peek can never become a full scan. */
export const AI_AGENT_SAMPLE_MAX_ROWS = 50;
/**
 * Whole-table column statistics (COUNT/SUM/COUNT(DISTINCT) aggregate) only run
 * for tables whose list_tables rowCount is known and at most this — above it,
 * stats fall back to the sampled rows so a peek never becomes a full scan.
 */
export const AI_AGENT_COLUMN_STATS_MAX_TABLE_ROWS = 200_000;
/** Max tables accepted in one describe_tables call, to bound observation size. */
export const AI_AGENT_BATCH_DESCRIBE_LIMIT = 8;
/** Max statements accepted in one preview_write call. */
export const AI_AGENT_PREVIEW_STATEMENT_LIMIT = 10;
/** Max documents accepted in one propose_seed_data call. */
export const AI_AGENT_SEED_DOCUMENT_LIMIT = 200;
/** Max selectable answers on ask_user. */
export const AI_AGENT_ASK_USER_OPTIONS_LIMIT = 6;
/** Max schema objects (views/triggers/routines) returned per list call. */
export const AI_AGENT_SCHEMA_OBJECTS_LIMIT = 60;
/** Max characters of a view/routine definition emitted per object. */
export const AI_AGENT_SCHEMA_OBJECT_DEFINITION_CHARS = 2500;
/** Max characters returned per read_page slice. */
export const AI_AGENT_READ_PAGE_MAX_CHARS = 4000;
/** Max checklist entries accepted in one update_plan call. */
export const AI_AGENT_PLAN_STEP_LIMIT = 8;
/** Max delegate side-analysis calls per agent run (each is one model call). */
export const AI_AGENT_DELEGATE_MAX_CALLS = 2;
/** Max focus tables accepted per delegate call. */
export const AI_AGENT_DELEGATE_FOCUS_TABLES_LIMIT = 4;
/** Max characters of the delegate sub-analysis answer surfaced as an observation. */
export const AI_AGENT_DELEGATE_ANSWER_CHARS = 1500;

export const WORKSPACE_ONLY_TOOLS = new Set<AIAgentToolName>([
  "create_checkpoint",
  "restore_checkpoint",
  "list_tables",
  "search_schema",
  "list_schema_objects",
  "describe_table",
  "describe_tables",
  "sample_table_data",
  "run_readonly_sql",
  "run_parameterized_sql",
  "find_value",
  "check_sql",
  "run_preset",
  "preview_write",
  "propose_seed_data",
  "remember_term",
  "read_memory",
  "save_memory",
  "edit_query_sql",
  "delete_memory",
]);

/** Minimal JSON Schema subset used for tool parameters (Draft 2020-12 compatible). */
export interface JsonSchema {
  type: "object" | "string" | "integer" | "number" | "boolean" | "array";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: readonly string[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  additionalProperties?: boolean;
}

export interface AIAgentToolSpec {
  name: AIAgentToolName;
  description: string;
  parameters: JsonSchema;
}
