import { splitSqlStatements } from "../../utils/sqlStatements";
import {
  isHighRiskStatement,
  isMutatingStatement,
  isSessionSwitchStatement,
  normalizeStatementForGuard,
} from "../SQLEditor/SQLEditorUtils";

export const AI_AGENT_TOOL_NAMES = [
  "ask_user",
  "list_tables",
  "search_schema",
  "describe_table",
  "describe_tables",
  "sample_table_data",
  "run_readonly_sql",
  "preview_write",
  "remember_term",
  "finish",
] as const;

/** Max statements accepted in one preview_write call. */
export const AI_AGENT_PREVIEW_STATEMENT_LIMIT = 10;

export type AIAgentToolName = (typeof AI_AGENT_TOOL_NAMES)[number];

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

export type AIAgentAskUserAction = AIAgentToolActionBase<
  "ask_user",
  AIAgentAskUserArgs
>;

export interface AIAgentRememberTermArgs extends Record<string, unknown> {
  term: string;
  definition: string;
  kind?: "term" | "metric" | "relationship" | "alias";
}

export type AIAgentRememberTermAction = AIAgentToolActionBase<
  "remember_term",
  AIAgentRememberTermArgs
>;

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

export type AIAgentListTablesAction = AIAgentToolActionBase<
  "list_tables",
  AIAgentListTablesArgs
>;

export type AIAgentSearchSchemaAction = AIAgentToolActionBase<
  "search_schema",
  { query: string }
>;

export type AIAgentDescribeTableAction = AIAgentToolActionBase<
  "describe_table",
  { table: string }
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
}

export type AIAgentSampleTableDataAction = AIAgentToolActionBase<
  "sample_table_data",
  AIAgentSampleTableDataArgs
>;

export type AIAgentRunReadonlySqlAction = AIAgentToolActionBase<
  "run_readonly_sql",
  { sql: string }
>;

export interface AIAgentFinishArgs extends Record<string, unknown> {
  response?: unknown;
  sql?: unknown;
  metricsWidgets?: unknown;
}

export type AIAgentFinishAction = AIAgentToolActionBase<"finish", AIAgentFinishArgs>;

export type AIAgentToolAction =
  | AIAgentAskUserAction
  | AIAgentListTablesAction
  | AIAgentSearchSchemaAction
  | AIAgentDescribeTableAction
  | AIAgentDescribeTablesAction
  | AIAgentSampleTableDataAction
  | AIAgentRunReadonlySqlAction
  | AIAgentPreviewWriteAction
  | AIAgentRememberTermAction
  | AIAgentFinishAction;

/** Hard ceiling for sample_table_data so a peek can never become a full scan. */
export const AI_AGENT_SAMPLE_MAX_ROWS = 50;
/** Max tables accepted in one describe_tables call, to bound observation size. */
export const AI_AGENT_BATCH_DESCRIBE_LIMIT = 8;

function parseOptionalStringArgs(args: Record<string, unknown>, keys: string[]) {
  const parsed: Record<string, string | undefined> = {};
  for (const key of keys) {
    const value = args[key];
    parsed[key] = typeof value === "string" ? value.trim() || undefined : undefined;
  }
  return parsed;
}

function parseOptionalBoundedNumber(value: unknown, min: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function stripOptionalCodeFence(text: string) {
  const trimmed = text.trim();
  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fencedMatch?.[1]?.trim() || trimmed;
}

function extractJsonObjectCandidate(text: string) {
  const stripped = stripOptionalCodeFence(text);
  const startIndex = stripped.indexOf("{");
  if (startIndex === -1) return stripped;

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = startIndex; index < stripped.length; index += 1) {
    const char = stripped[index];
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return stripped.slice(startIndex, index + 1);
    }
  }

  return stripped.slice(startIndex);
}

function sanitizeJsonStringLiterals(candidate: string) {
  let result = "";
  let inString = false;
  let escaping = false;

  for (const char of candidate) {
    if (inString) {
      if (escaping) {
        result += char;
        escaping = false;
        continue;
      }
      if (char === "\\") {
        result += char;
        escaping = true;
        continue;
      }
      if (char === "\"") {
        result += char;
        inString = false;
        continue;
      }
      if (char === "\n") {
        result += "\\n";
        continue;
      }
      if (char === "\r") {
        result += "\\r";
        continue;
      }
      if (char === "\t") {
        result += "\\t";
        continue;
      }

      const codePoint = char.charCodeAt(0);
      result += codePoint < 0x20
        ? `\\u${codePoint.toString(16).padStart(4, "0")}`
        : char;
      continue;
    }

    if (char === "\"") inString = true;
    result += char;
  }

  return result;
}

function repairTruncatedJson(candidate: string) {
  let inString = false;
  let escaping = false;
  const stack: string[] = [];

  for (const char of candidate) {
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{" || char === "[") {
      stack.push(char);
    } else if (char === "}" || char === "]") {
      stack.pop();
    }
  }

  let repaired = candidate;
  if (inString && escaping) repaired += "\\";
  if (inString) repaired += "\"";
  repaired = repaired.replace(/,\s*$/, "");

  for (let index = stack.length - 1; index >= 0; index -= 1) {
    repaired += stack[index] === "{" ? "}" : "]";
  }

  return repaired;
}

function isAIAgentToolName(value: unknown): value is AIAgentToolName {
  return typeof value === "string"
    && (AI_AGENT_TOOL_NAMES as readonly string[]).includes(value);
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
    const message = parseError instanceof Error
      ? parseError.message
      : String(parseError ?? "Unknown JSON parse error");
    throw new Error(`The agent returned malformed JSON: ${message}`);
  }
  if (!isAIAgentToolName(parsed.action)) {
    throw new Error("The agent returned an unsupported action.");
  }
  if (
    parsed.args !== undefined
    && (parsed.args === null || Array.isArray(parsed.args) || typeof parsed.args !== "object")
  ) {
    throw new Error("The agent returned invalid tool arguments.");
  }

  const args = (parsed.args as Record<string, unknown> | undefined) || {};
  const message = typeof parsed.message === "string" ? parsed.message.trim() : "";

  if (parsed.action === "ask_user") {
    const question = typeof args.question === "string" ? args.question.trim() : "";
    if (!question) {
      throw new Error("The ask_user action requires a non-empty args.question.");
    }
    const rawOptions = Array.isArray(args.options) ? args.options : [];
    const options = [...new Set(
      rawOptions
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    )].slice(0, 6);
    return {
      action: parsed.action,
      args: {
        question,
        ...(options.length > 0 ? { options } : {}),
        ...(args.multiple === true ? { multiple: true } : {}),
      },
      message,
    };
  }

  if (parsed.action === "list_tables") {
    const { schema, pattern } = parseOptionalStringArgs(args, ["schema", "pattern"]);
    const limit = parseOptionalBoundedNumber(args.limit, 1, 200);
    const minRows = parseOptionalBoundedNumber(args.minRows, 1, 1_000_000_000);
    return {
      action: parsed.action,
      args: {
        ...(schema ? { schema } : {}),
        ...(pattern ? { pattern } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(minRows !== undefined ? { minRows } : {}),
      },
      message,
    };
  }

  if (parsed.action === "search_schema") {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) {
      throw new Error("The search_schema action requires a non-empty args.query.");
    }
    return { action: parsed.action, args: { query }, message };
  }

  if (parsed.action === "describe_table") {
    const table = typeof args.table === "string" ? args.table.trim() : "";
    if (!table) {
      throw new Error("The describe_table action requires a non-empty args.table.");
    }
    return { action: parsed.action, args: { table }, message };
  }

  if (parsed.action === "describe_tables") {
    const rawTables = Array.isArray(args.tables) ? args.tables : [];
    const tables = [...new Set(
      rawTables
        .filter((value): value is string | number => typeof value === "string" || typeof value === "number")
        .map((value) => String(value).trim())
        .filter(Boolean),
    )];
    if (tables.length === 0) {
      throw new Error("The describe_tables action requires a non-empty args.tables array.");
    }
    return {
      action: parsed.action,
      args: { tables: tables.slice(0, AI_AGENT_BATCH_DESCRIBE_LIMIT) },
      message,
    };
  }

  if (parsed.action === "sample_table_data") {
    const table = typeof args.table === "string" ? args.table.trim() : "";
    if (!table) {
      throw new Error("The sample_table_data action requires a non-empty args.table.");
    }
    const limit = parseOptionalBoundedNumber(args.limit, 1, AI_AGENT_SAMPLE_MAX_ROWS);
    return {
      action: parsed.action,
      args: {
        table,
        ...(limit !== undefined ? { limit } : {}),
      },
      message,
    };
  }

  if (parsed.action === "run_readonly_sql") {
    const sql = typeof args.sql === "string" ? args.sql.trim() : "";
    if (!sql) {
      throw new Error("The run_readonly_sql action requires a non-empty args.sql.");
    }
    return { action: parsed.action, args: { sql }, message };
  }

  if (parsed.action === "remember_term") {
    const term = typeof args.term === "string" ? args.term.trim() : "";
    const definition = typeof args.definition === "string" ? args.definition.trim() : "";
    if (!term || !definition) {
      throw new Error("The remember_term action requires non-empty args.term and args.definition.");
    }
    const allowedKinds = ["term", "metric", "relationship", "alias"] as const;
    const kind = typeof args.kind === "string" && (allowedKinds as readonly string[]).includes(args.kind)
      ? (args.kind as AIAgentRememberTermArgs["kind"])
      : undefined;
    return {
      action: parsed.action,
      args: { term, definition, ...(kind ? { kind } : {}) },
      message,
    };
  }

  if (parsed.action === "preview_write") {
    const rawStatements = Array.isArray(args.statements) ? args.statements : [];
    const statements = rawStatements
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean);
    if (statements.length === 0) {
      throw new Error("The preview_write action requires a non-empty args.statements array.");
    }
    return {
      action: parsed.action,
      args: { statements: statements.slice(0, AI_AGENT_PREVIEW_STATEMENT_LIMIT) },
      message,
    };
  }

  if (parsed.action === "finish") {
    return { action: parsed.action, args, message };
  }

  return { action: parsed.action, args, message };
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
      isSessionSwitchStatement(statement)
      || isMutatingStatement(statement)
      || isHighRiskStatement(statement)
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
