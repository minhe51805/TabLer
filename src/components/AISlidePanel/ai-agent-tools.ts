import { splitSqlStatements } from "../../utils/sqlStatements";
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
  AI_AGENT_PREVIEW_STATEMENT_LIMIT,
  AI_AGENT_SAMPLE_MAX_ROWS,
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

  return {
    action: parsed.action,
    args: parseAgentToolArgs(parsed.action, args),
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
