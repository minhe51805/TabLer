import { splitSqlStatements } from "../../utils/sqlStatements";
import {
  extractJsonObjectCandidate,
  repairTruncatedJson,
  sanitizeJsonStringLiterals,
} from "./json-repair";
import {
  isHighRiskStatement,
  isMutatingStatement,
  isSessionSwitchStatement,
  normalizeStatementForGuard,
} from "../SQLEditor/SQLEditorUtils";
import {
  AI_AGENT_TOOL_NAMES,
  parseAgentToolArgs,
  type AIAgentToolName,
} from "./ai-agent-tool-schema";

export {
  AI_AGENT_ASK_USER_OPTIONS_LIMIT,
  AI_AGENT_BATCH_DESCRIBE_LIMIT,
  AI_AGENT_COLUMN_STATS_MAX_TABLE_ROWS,
  AI_AGENT_DELEGATE_ANSWER_CHARS,
  AI_AGENT_DELEGATE_FOCUS_TABLES_LIMIT,
  AI_AGENT_DELEGATE_MAX_CALLS,
  AI_AGENT_PLAN_STEP_LIMIT,
  AI_AGENT_PREVIEW_STATEMENT_LIMIT,
  AI_AGENT_READ_PAGE_MAX_CHARS,
  AI_AGENT_SAMPLE_MAX_ROWS,
  AI_AGENT_SCHEMA_OBJECTS_LIMIT,
  AI_AGENT_SCHEMA_OBJECT_DEFINITION_CHARS,
  AI_AGENT_SEED_DOCUMENT_LIMIT,
  AI_AGENT_TOOL_NAMES,
} from "./ai-agent-tool-schema";
export type { AIAgentToolName } from "./ai-agent-tool-schema";

interface AIAgentToolActionBase<TAction extends AIAgentToolName, TArgs> {
  action: TAction;
  args: TArgs;
  message: string;
}

export interface AIAgentAskUserArgs extends Record<string, unknown> {
  question: string;
  options?: string[];
  multiple?: boolean;
}

export type AIAgentAskUserAction = AIAgentToolActionBase<"ask_user", AIAgentAskUserArgs>;

export interface AIAgentRememberTermArgs extends Record<string, unknown> {
  term: string;
  definition: string;
  kind?: "term" | "metric" | "relationship" | "alias";
}

export type AIAgentRememberTermAction = AIAgentToolActionBase<
  "remember_term",
  AIAgentRememberTermArgs
>;

export interface AIAgentEditQuerySqlArgs extends Record<string, unknown> {
  /** Required when targeting an open tab; omit when createIfMissing is set. */
  tabId?: string;
  sql: string;
  reason?: string;
  /** Opens a NEW AI Query tab pre-filled with the SQL when none is open. */
  createIfMissing?: boolean;
}

export type AIAgentEditQuerySqlAction = AIAgentToolActionBase<
  "edit_query_sql",
  AIAgentEditQuerySqlArgs
>;

export interface AIAgentReadMemoryArgs extends Record<string, unknown> {
  name: string;
}

export type AIAgentReadMemoryAction = AIAgentToolActionBase<"read_memory", AIAgentReadMemoryArgs>;

export interface AIAgentSaveMemoryArgs extends Record<string, unknown> {
  name: string;
  description?: string;
  body: string;
}

export type AIAgentSaveMemoryAction = AIAgentToolActionBase<"save_memory", AIAgentSaveMemoryArgs>;

export interface AIAgentDeleteMemoryArgs extends Record<string, unknown> {
  name: string;
}

export type AIAgentDeleteMemoryAction = AIAgentToolActionBase<
  "delete_memory",
  AIAgentDeleteMemoryArgs
>;

/**
 * Anthropic's NATIVE memory tool (`memory_20250818`). Unlike catalog tools it
 * is NOT in AI_AGENT_TOOL_NAMES and carries no JSON schema: Claude emits a
 * `command` plus filesystem-style fields, which the executor forwards verbatim
 * to the `run_agent_memory_tool` backend command (a sandboxed /memories tree).
 * Anthropic-only — it is never declared to any other provider.
 */
export const NATIVE_MEMORY_TOOL_ACTION = "memory" as const;
export const NATIVE_MEMORY_TOOL_COMMANDS = [
  "view",
  "create",
  "str_replace",
  "insert",
  "delete",
  "rename",
] as const;
export type NativeMemoryToolCommand = (typeof NATIVE_MEMORY_TOOL_COMMANDS)[number];

export interface AIAgentMemoryToolArgs extends Record<string, unknown> {
  command: NativeMemoryToolCommand;
  path?: string;
  file_text?: string;
  old_str?: string;
  new_str?: string;
  insert_line?: number;
  insert_text?: string;
  old_path?: string;
  new_path?: string;
  view_range?: number[];
}

export interface AIAgentMemoryToolAction {
  action: "memory";
  args: AIAgentMemoryToolArgs;
  message: string;
}

export interface AIAgentSkillArgs extends Record<string, unknown> {
  name: string;
}

export type AIAgentSkillAction = AIAgentToolActionBase<"skill", AIAgentSkillArgs>;

export interface AIAgentReadSkillResourceArgs extends Record<string, unknown> {
  name: string;
  path: string;
}

export type AIAgentReadSkillResourceAction = AIAgentToolActionBase<
  "read_skill_resource",
  AIAgentReadSkillResourceArgs
>;

export interface AIAgentCreateCheckpointArgs extends Record<string, unknown> {
  label?: string;
}

export type AIAgentCreateCheckpointAction = AIAgentToolActionBase<
  "create_checkpoint",
  AIAgentCreateCheckpointArgs
>;

export interface AIAgentRestoreCheckpointArgs extends Record<string, unknown> {
  label_hint?: string;
}

export type AIAgentRestoreCheckpointAction = AIAgentToolActionBase<
  "restore_checkpoint",
  AIAgentRestoreCheckpointArgs
>;

export interface AIAgentReadPageArgs extends Record<string, unknown> {
  ref?: number;
  offset?: number;
  limit?: number;
}

export type AIAgentReadPageAction = AIAgentToolActionBase<"read_page", AIAgentReadPageArgs>;

export interface AIAgentPreviewWriteArgs extends Record<string, unknown> {
  statements: string[];
}

export type AIAgentPreviewWriteAction = AIAgentToolActionBase<
  "preview_write",
  AIAgentPreviewWriteArgs
>;

export interface AIAgentListTablesArgs extends Record<string, unknown> {
  schema?: string;
  pattern?: string;
  limit?: number;
  minRows?: number;
}

export type AIAgentListTablesAction = AIAgentToolActionBase<"list_tables", AIAgentListTablesArgs>;

export type AIAgentSearchSchemaAction = AIAgentToolActionBase<"search_schema", { query: string }>;

export interface AIAgentListSchemaObjectsArgs extends Record<string, unknown> {
  objectType?: "view" | "trigger" | "routine" | "all";
  pattern?: string;
  withDefinition?: boolean;
  limit?: number;
}

export type AIAgentListSchemaObjectsAction = AIAgentToolActionBase<
  "list_schema_objects",
  AIAgentListSchemaObjectsArgs
>;

export type AIAgentDescribeTableAction = AIAgentToolActionBase<
  "describe_table",
  { table?: string; tables?: string[] }
>;

export interface AIAgentDescribeTablesArgs extends Record<string, unknown> {
  tables: string[];
}

export type AIAgentDescribeTablesAction = AIAgentToolActionBase<
  "describe_tables",
  AIAgentDescribeTablesArgs
>;

export interface AIAgentSampleTableDataArgs extends Record<string, unknown> {
  table: string;
  limit?: number;
  stats?: "auto" | "sample" | "off";
}

export type AIAgentSampleTableDataAction = AIAgentToolActionBase<
  "sample_table_data",
  AIAgentSampleTableDataArgs
>;

export type AIAgentRunReadonlySqlAction = AIAgentToolActionBase<
  "run_readonly_sql",
  { sql: string }
>;

export interface AIAgentRunParameterizedSqlArgs extends Record<string, unknown> {
  sql: string;
  parameters: Array<{ name: string; value?: unknown; dataType?: string }>;
}

export type AIAgentRunParameterizedSqlAction = AIAgentToolActionBase<
  "run_parameterized_sql",
  AIAgentRunParameterizedSqlArgs
>;

export interface AIAgentFindValueArgs extends Record<string, unknown> {
  table: string;
  column: string;
  value: unknown;
  limit?: number;
}

export type AIAgentFindValueAction = AIAgentToolActionBase<"find_value", AIAgentFindValueArgs>;

export type AIAgentCheckSqlAction = AIAgentToolActionBase<"check_sql", { sql: string }>;

export interface AIAgentRunPresetArgs extends Record<string, unknown> {
  presetId?: "process-list" | "user-management";
  list?: boolean;
}

export type AIAgentRunPresetAction = AIAgentToolActionBase<"run_preset", AIAgentRunPresetArgs>;

export interface AIAgentFinishArgs extends Record<string, unknown> {
  response?: unknown;
  sql?: unknown;
  metricsWidgets?: unknown;
  options?: unknown;
}

export type AIAgentFinishAction = AIAgentToolActionBase<"finish", AIAgentFinishArgs>;

export interface AIAgentUpdatePlanStep {
  title: string;
  status?: "pending" | "in_progress" | "done";
}

export interface AIAgentUpdatePlanArgs extends Record<string, unknown> {
  steps: AIAgentUpdatePlanStep[];
}

export type AIAgentUpdatePlanAction = AIAgentToolActionBase<"update_plan", AIAgentUpdatePlanArgs>;

export interface AIAgentDelegateArgs extends Record<string, unknown> {
  instruction: string;
  focusTables?: string[];
}

export type AIAgentDelegateAction = AIAgentToolActionBase<"delegate", AIAgentDelegateArgs>;

export interface AIAgentProposeSeedDataArgs extends Record<string, unknown> {
  collection: string;
  documents: unknown[];
  rationale?: string;
}

export type AIAgentProposeSeedDataAction = AIAgentToolActionBase<
  "propose_seed_data",
  AIAgentProposeSeedDataArgs
>;

export type AIAgentToolAction =
  | AIAgentAskUserAction
  | AIAgentUpdatePlanAction
  | AIAgentListTablesAction
  | AIAgentSearchSchemaAction
  | AIAgentListSchemaObjectsAction
  | AIAgentDescribeTableAction
  | AIAgentDescribeTablesAction
  | AIAgentSampleTableDataAction
  | AIAgentRunReadonlySqlAction
  | AIAgentRunParameterizedSqlAction
  | AIAgentFindValueAction
  | AIAgentCheckSqlAction
  | AIAgentRunPresetAction
  | AIAgentPreviewWriteAction
  | AIAgentProposeSeedDataAction
  | AIAgentRememberTermAction
  | AIAgentReadMemoryAction
  | AIAgentSaveMemoryAction
  | AIAgentDeleteMemoryAction
  | AIAgentMemoryToolAction
  | AIAgentEditQuerySqlAction
  | AIAgentSkillAction
  | AIAgentReadSkillResourceAction
  | AIAgentCreateCheckpointAction
  | AIAgentRestoreCheckpointAction
  | AIAgentDelegateAction
  | AIAgentReadPageAction
  | AIAgentFinishAction;

function isAIAgentToolName(value: unknown): value is AIAgentToolName {
  return typeof value === "string" && (AI_AGENT_TOOL_NAMES as readonly string[]).includes(value);
}

/**
 * Validate the loose args of a native memory tool call. The backend sandbox
 * does the authoritative validation (paths, sizes, traversal); here we only
 * guarantee a known `command` so a malformed call throws a repair-friendly
 * message instead of round-tripping to the backend, then forward the rest of
 * the filesystem fields verbatim.
 */
function parseNativeMemoryToolArgs(args: Record<string, unknown>): AIAgentMemoryToolArgs {
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (!(NATIVE_MEMORY_TOOL_COMMANDS as readonly string[]).includes(command)) {
    throw new Error(
      `The memory tool requires args.command to be one of: ${NATIVE_MEMORY_TOOL_COMMANDS.join(", ")}.`,
    );
  }
  return { ...args, command: command as NativeMemoryToolCommand };
}

export function parseAIAgentToolAction(rawResponse: string): AIAgentToolAction {
  const candidate = extractJsonObjectCandidate(rawResponse);
  const sanitizedCandidate = sanitizeJsonStringLiterals(candidate);
  let parsed: { action?: unknown; args?: unknown; message?: unknown } | null = null;
  let parseError: unknown = null;

  for (const parseCandidate of [
    candidate,
    sanitizedCandidate,
    repairTruncatedJson(sanitizedCandidate),
  ]) {
    try {
      parsed = JSON.parse(parseCandidate) as {
        action?: unknown;
        args?: unknown;
        message?: unknown;
      };
      parseError = null;
      break;
    } catch (errorValue) {
      parseError = errorValue;
    }
  }

  if (!parsed) {
    const message =
      parseError instanceof Error
        ? parseError.message
        : String(parseError ?? "Unknown JSON parse error");
    throw new Error(`The agent returned malformed JSON: ${message}`);
  }
  const isNativeMemoryAction = parsed.action === NATIVE_MEMORY_TOOL_ACTION;
  if (!isNativeMemoryAction && !isAIAgentToolName(parsed.action)) {
    throw new Error("The agent returned an unsupported action.");
  }
  if (
    parsed.args !== undefined &&
    (parsed.args === null || Array.isArray(parsed.args) || typeof parsed.args !== "object")
  ) {
    throw new Error("The agent returned invalid tool arguments.");
  }

  // Native tool-calls from weak providers can arrive with `function.arguments`
  // that the backend could not parse (shipped verbatim under
  // `unparsedArguments` instead of being silently emptied). Run that payload
  // through the same repair pipeline as text finals; an unrecoverable payload
  // throws so the caller's bounded repair round can ask the model to re-emit
  // the action with valid arguments.
  let args = (parsed.args as Record<string, unknown> | undefined) ?? {};
  const unparsedArguments = args.unparsedArguments;
  if (typeof unparsedArguments === "string") {
    const candidate = repairTruncatedJson(
      sanitizeJsonStringLiterals(extractJsonObjectCandidate(unparsedArguments)),
    );
    let recovered: unknown = null;
    try {
      recovered = JSON.parse(candidate);
    } catch {
      recovered = null;
    }
    if (recovered && typeof recovered === "object" && !Array.isArray(recovered)) {
      const recoveredArgs = { ...(recovered as Record<string, unknown>) };
      delete recoveredArgs.unparsedArguments;
      args = recoveredArgs;
    } else {
      throw new Error(
        `The agent returned malformed tool arguments: ${unparsedArguments.trim().slice(0, 200)}`,
      );
    }
  }
  const message = typeof parsed.message === "string" ? parsed.message.trim() : "";

  if (isNativeMemoryAction) {
    // Anthropic's native memory tool has no catalog spec — forward the command
    // and filesystem args verbatim (the backend sandbox is the source of truth
    // for path/size/traversal validation).
    return {
      action: NATIVE_MEMORY_TOOL_ACTION,
      args: parseNativeMemoryToolArgs(args),
      message,
    };
  }

  return {
    action: parsed.action as AIAgentToolName,
    args: parseAgentToolArgs(parsed.action as AIAgentToolName, args),
    message,
  } as AIAgentToolAction;
}

export function validateAIAgentReadonlySql(sql: string) {
  const statements = splitSqlStatements(sql);
  if (statements.length === 0) {
    throw new Error("The agent tool requires at least one SQL statement.");
  }

  const allowedPrefixes = ["SELECT", "SHOW", "EXPLAIN", "DESCRIBE", "WITH", "PRAGMA"];
  for (const statement of statements) {
    const normalized = normalizeStatementForGuard(statement);
    if (!normalized) continue;

    if (
      isSessionSwitchStatement(statement) ||
      isMutatingStatement(statement) ||
      isHighRiskStatement(statement)
    ) {
      throw new Error("The agent tool only allows read-only SQL observations.");
    }
    if (normalized.startsWith("PRAGMA") && normalized.includes("=")) {
      throw new Error("The agent tool only allows read-only PRAGMA statements.");
    }
    if (!allowedPrefixes.some((prefix) => normalized.startsWith(prefix))) {
      throw new Error(
        "The agent tool only allows SELECT, SHOW, EXPLAIN, DESCRIBE, WITH, or read-only PRAGMA statements.",
      );
    }
  }

  return statements;
}
