import { splitSqlStatements } from "../../utils/sqlStatements";
import {
  isHighRiskStatement,
  isMutatingStatement,
  isSessionSwitchStatement,
  normalizeStatementForGuard,
} from "../SQLEditor/SQLEditorUtils";

export const AI_AGENT_TOOL_NAMES = [
  "list_tables",
  "describe_table",
  "run_readonly_sql",
  "finish",
] as const;

export type AIAgentToolName = (typeof AI_AGENT_TOOL_NAMES)[number];

interface AIAgentToolActionBase<TAction extends AIAgentToolName, TArgs> {
  action: TAction;
  args: TArgs;
  message: string;
}

export type AIAgentListTablesAction = AIAgentToolActionBase<
  "list_tables",
  Record<string, unknown>
>;

export type AIAgentDescribeTableAction = AIAgentToolActionBase<
  "describe_table",
  { table: string }
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
  | AIAgentListTablesAction
  | AIAgentDescribeTableAction
  | AIAgentRunReadonlySqlAction
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

  if (parsed.action === "describe_table") {
    const table = typeof args.table === "string" ? args.table.trim() : "";
    if (!table) {
      throw new Error("The describe_table action requires a non-empty args.table.");
    }
    return { action: parsed.action, args: { table }, message };
  }

  if (parsed.action === "run_readonly_sql") {
    const sql = typeof args.sql === "string" ? args.sql.trim() : "";
    if (!sql) {
      throw new Error("The run_readonly_sql action requires a non-empty args.sql.");
    }
    return { action: parsed.action, args: { sql }, message };
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
