import type { AIProviderType, AIRequestIntent } from "../../types";
import {
  isAgentToolEnabled,
  nativeCatalogOptionsForEngine,
  type AgentToolAvailability,
} from "./ai-agent-engine-gates";

/**
 * Canonical tool names, JSON Schema, argument parser, and controller-prompt
 * catalog. Adding a tool means adding one spec here: parseAIAgentToolAction
 * looks it up, native function-calling reshapes it, and the controller prompt
 * lists it. The controller-loop `message` field lives outside args.
 */

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

export type AIAgentToolName = (typeof AI_AGENT_TOOL_NAMES)[number];

/** Hard ceiling for sample_table_data so a peek can never become a full scan. */
export const AI_AGENT_SAMPLE_MAX_ROWS = 50;
/** Max tables accepted in one describe_tables call, to bound observation size. */
export const AI_AGENT_BATCH_DESCRIBE_LIMIT = 8;
/** Max statements accepted in one preview_write call. */
export const AI_AGENT_PREVIEW_STATEMENT_LIMIT = 10;
/** Max selectable answers on ask_user. */
export const AI_AGENT_ASK_USER_OPTIONS_LIMIT = 6;

const WORKSPACE_ONLY_TOOLS = new Set<AIAgentToolName>([
  "list_tables",
  "search_schema",
  "describe_table",
  "describe_tables",
  "sample_table_data",
  "run_readonly_sql",
  "preview_write",
  "remember_term",
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
          description: "Optional list of selectable answers.",
        },
        multiple: {
          type: "boolean",
          description: "Set true when the user may pick more than one option.",
        },
      },
      ["question"],
    ),
  },

  list_tables: {
    name: "list_tables",
    description:
      "List catalog tables with optional filters. Each entry carries a rowCount, so this is the only source of row counts.",
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
      "Find where a column or concept lives across the catalog when the user names a field but not the exact table.",
    parameters: objectSchema(
      { query: { type: "string", description: "Column name or concept to locate." } },
      ["query"],
    ),
  },

  describe_table: {
    name: "describe_table",
    description: "Inspect the exact columns of one verified table before reading its rows.",
    parameters: objectSchema(
      { table: { type: "string", description: "Exact table name or identifier." } },
      ["table"],
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
      "Return a few live rows from one verified table without writing SQL. Does not require describe_table first.",
    parameters: objectSchema(
      {
        table: { type: "string", description: "Exact table name or identifier." },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: AI_AGENT_SAMPLE_MAX_ROWS,
          description: `Rows to sample (up to ${AI_AGENT_SAMPLE_MAX_ROWS}).`,
        },
      },
      ["table"],
    ),
  },

  run_readonly_sql: {
    name: "run_readonly_sql",
    description:
      "Run a read-only observation query (SELECT, SHOW, EXPLAIN, DESCRIBE, WITH, or read-only PRAGMA). Never query system catalogs.",
    parameters: objectSchema(
      { sql: { type: "string", description: "A single read-only SQL statement grounded in the verified schema." } },
      ["sql"],
    ),
  },

  preview_write: {
    name: "preview_write",
    description:
      "Preview mutating statements inside one transaction that always rolls back. Nothing is persisted; the human applies the final SQL through the approval flow.",
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

  finish: {
    name: "finish",
    description:
      "End the run with the final answer for the user. Put the single best runnable SELECT in sql, and 3-6 dashboard widgets in metricsWidgets when the request is a metrics board.",
    parameters: {
      type: "object",
      properties: {
        response: { type: "string", description: "Markdown answer for the user." },
        sql: { type: "string", description: "Optional grounded SQL for later human approval." },
        metricsWidgets: {
          type: "array",
          items: { type: "object" },
          description: "Optional dashboard widgets.",
        },
      },
      // finish carries a flexible payload consumed by the finalizer, so extra
      // keys are permitted rather than rejected.
      additionalProperties: true,
    },
  },
};

function requiredFieldError(action: AIAgentToolName, key: string, isArray: boolean): never {
  if (isArray) {
    throw new Error(`The ${action} action requires a non-empty args.${key} array.`);
  }
  throw new Error(`The ${action} action requires a non-empty args.${key}.`);
}

function parseSchemaValue(
  schema: JsonSchema,
  value: unknown,
  action: AIAgentToolName,
  key: string,
  required: boolean,
): unknown {
  if (value === undefined || value === null) {
    if (required) requiredFieldError(action, key, schema.type === "array");
    return undefined;
  }

  switch (schema.type) {
    case "string": {
      const asString = action === "describe_tables" && key === "tables" && typeof value === "number" && Number.isFinite(value)
        ? String(value)
        : value;
      if (typeof asString !== "string") {
        if (required) requiredFieldError(action, key, false);
        return undefined;
      }
      const trimmed = asString.trim();
      if (!trimmed) {
        if (required) requiredFieldError(action, key, false);
        return undefined;
      }
      if (schema.enum && !schema.enum.includes(trimmed)) {
        if (required) {
          throw new Error(`The ${action} action received an unsupported args.${key}.`);
        }
        return undefined;
      }
      return trimmed;
    }
    case "integer":
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        if (required) {
          throw new Error(`The ${action} action requires a numeric args.${key}.`);
        }
        return undefined;
      }
      let next = schema.type === "integer" ? Math.floor(value) : value;
      if (typeof schema.minimum === "number") next = Math.max(schema.minimum, next);
      if (typeof schema.maximum === "number") next = Math.min(schema.maximum, next);
      return next;
    }
    case "boolean": {
      if (value !== true && value !== false) {
        if (required) {
          throw new Error(`The ${action} action requires a boolean args.${key}.`);
        }
        return undefined;
      }
      // Optional booleans only surface when explicitly true (ask_user.multiple).
      if (!required && value !== true) return undefined;
      return value;
    }
    case "array": {
      if (!Array.isArray(value)) {
        if (required) requiredFieldError(action, key, true);
        return undefined;
      }
      const itemSchema = schema.items ?? { type: "string" };
      const parsedItems: unknown[] = [];
      for (const item of value) {
        const parsedItem = parseSchemaValue(itemSchema, item, action, key, false);
        if (parsedItem === undefined) continue;
        parsedItems.push(parsedItem);
      }
      const unique = schema.uniqueItems
        ? [...new Set(parsedItems.map((item) => String(item)))]
        : parsedItems;
      const capped = typeof schema.maxItems === "number"
        ? unique.slice(0, schema.maxItems)
        : unique;
      if (required && capped.length === 0) requiredFieldError(action, key, true);
      if (typeof schema.minItems === "number" && capped.length < schema.minItems) {
        requiredFieldError(action, key, true);
      }
      return capped;
    }
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        if (required) {
          throw new Error(`The ${action} action requires an object args.${key}.`);
        }
        return undefined;
      }
      return value;
    }
    default:
      return undefined;
  }
}

/**
 * Validates and normalizes raw controller `args` against the tool's JSON
 * Schema. Optional fields with the wrong type are dropped (matching the
 * previous hand-written normalizers) so a sloppy model still gets a usable
 * call; required fields throw a repair-loop-friendly message.
 */
export function parseAgentToolArgs(
  action: AIAgentToolName,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (action === "remember_term") {
    const term = typeof args.term === "string" ? args.term.trim() : "";
    const definition = typeof args.definition === "string" ? args.definition.trim() : "";
    if (!term || !definition) {
      throw new Error("The remember_term action requires non-empty args.term and args.definition.");
    }
  }

  const schema = AI_AGENT_TOOL_SPECS[action].parameters;
  if (schema.additionalProperties === true) {
    return { ...args };
  }

  const properties = schema.properties ?? {};
  const required = schema.required ?? [];
  const result: Record<string, unknown> = {};
  for (const [key, propSchema] of Object.entries(properties)) {
    const parsed = parseSchemaValue(propSchema, args[key], action, key, required.includes(key));
    if (parsed === undefined) continue;
    if (Array.isArray(parsed) && parsed.length === 0 && !required.includes(key)) continue;
    result[key] = parsed;
  }
  return result;
}

function exampleLiteral(key: string, schema: JsonSchema): string {
  if (schema.enum && schema.enum.length > 0) {
    return JSON.stringify(schema.enum.join("|"));
  }
  switch (schema.type) {
    case "string":
      if (key === "sql") return '"SELECT ..."';
      if (key === "table") return '"exact_table_name"';
      if (key === "query") return '"column or concept to find"';
      if (key === "question") return '"one concise question"';
      if (key === "response") return '"markdown for the user"';
      if (key === "schema") return '"optional schema filter"';
      if (key === "pattern") return '"optional name substring"';
      if (key === "term") return '"campaign"';
      if (key === "definition") return '"marketing content group"';
      return JSON.stringify(schema.description ?? key);
    case "integer":
    case "number":
      if (key === "limit") return "optional count";
      if (key === "minRows") return "optional minimum row count";
      return String(schema.minimum ?? 1);
    case "boolean":
      return "optional boolean";
    case "array":
      if (key === "options") return '["option A","option B"]';
      if (key === "tables") return '["table_a","table_b"]';
      if (key === "statements") return `["UPDATE orders SET status = 'cancelled' WHERE id = 42"]`;
      if (key === "metricsWidgets") {
        return '[{"title":"Widget title","type":"bar|horizontal-bar|line|area|pie|donut|radial|table|scoreboard","query":"SELECT ...","dimension":"verified label column","measures":["verified numeric alias"],"transforms":["group/sort operation"],"limit":100}]';
      }
      return "[]";
    default:
      return "{}";
  }
}

function formatControllerArgsExample(spec: AIAgentToolSpec, workspaceToolsEnabled: boolean): string {
  const properties = spec.parameters.properties ?? {};
  const entries = Object.entries(properties).filter(([key]) => {
    if (spec.name === "finish" && !workspaceToolsEnabled) return key !== "metricsWidgets";
    return true;
  });
  const body = entries
    .map(([key, schema]) => `"${key}":${exampleLiteral(key, schema)}`)
    .join(",");
  return `{${body}}`;
}

export interface AgentToolCatalogOptions {
  workspaceToolsEnabled: boolean;
  availability?: Pick<AgentToolAvailability, "sqlRead" | "sqlWritePreview">;
}

function resolveCatalogOptions(
  options: boolean | AgentToolCatalogOptions,
): Required<Pick<AgentToolCatalogOptions, "workspaceToolsEnabled">> & {
  availability: Pick<AgentToolAvailability, "sqlRead" | "sqlWritePreview">;
} {
  if (typeof options === "boolean") {
    return {
      workspaceToolsEnabled: options,
      availability: { sqlRead: true, sqlWritePreview: true },
    };
  }
  return {
    workspaceToolsEnabled: options.workspaceToolsEnabled,
    availability: options.availability ?? { sqlRead: true, sqlWritePreview: true },
  };
}

export function listEnabledAgentToolSpecs(
  options: boolean | AgentToolCatalogOptions = true,
): AIAgentToolSpec[] {
  const resolved = resolveCatalogOptions(options);
  return listAgentToolSpecs().filter((spec) => {
    if (!resolved.workspaceToolsEnabled && WORKSPACE_ONLY_TOOLS.has(spec.name)) return false;
    return isAgentToolEnabled(spec.name, resolved.availability);
  });
}

/**
 * Numbered controller-action listing generated from the registry so the prompt
 * cannot drift from parseAIAgentToolAction / native tool schemas.
 */
export function formatAgentToolCatalog(options: boolean | AgentToolCatalogOptions = true): string[] {
  const resolved = resolveCatalogOptions(options);
  return listEnabledAgentToolSpecs(resolved).map((spec, index) => {
    const args = formatControllerArgsExample(spec, resolved.workspaceToolsEnabled);
    return `${index + 1}. {"action":"${spec.name}","message":"short reason","args":${args}}`;
  });
}

/** Ordered specs, matching the canonical order of AI_AGENT_TOOL_NAMES. */
export function listAgentToolSpecs(): AIAgentToolSpec[] {
  return AI_AGENT_TOOL_NAMES.map((name) => AI_AGENT_TOOL_SPECS[name]);
}

/** OpenAI / OpenRouter / Custom (OpenAI-compatible) `tools` array. */
export interface OpenAIFunctionTool {
  type: "function";
  function: { name: string; description: string; parameters: JsonSchema };
}

export function toOpenAIFunctionTools(
  specs: AIAgentToolSpec[] = listAgentToolSpecs(),
): OpenAIFunctionTool[] {
  return specs.map((spec) => ({
    type: "function",
    function: {
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
    },
  }));
}

/** Anthropic Messages API `tools` array (input_schema instead of parameters). */
export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: JsonSchema;
}

export function toAnthropicTools(
  specs: AIAgentToolSpec[] = listAgentToolSpecs(),
): AnthropicTool[] {
  return specs.map((spec) => ({
    name: spec.name,
    description: spec.description,
    input_schema: spec.parameters,
  }));
}

/** Gemini `tools[].functionDeclarations` entry. */
export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export function toGeminiFunctionDeclarations(
  specs: AIAgentToolSpec[] = listAgentToolSpecs(),
): GeminiFunctionDeclaration[] {
  return specs.map((spec) => ({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
  }));
}

/**
 * Feature flag for native provider function-calling. Kept OFF by default so the
 * agent runs entirely through the proven text-contract path; the coupled
 * request/parse wiring behind it cannot be integration-tested here, so enabling
 * it is a deliberate, reversible switch for live provider testing. While off,
 * buildNativeToolPayload always returns null and nothing about the request
 * changes.
 */
export const NATIVE_TOOL_CALLING_ENABLED = false;

/** Provider-shaped payload consumed by the backend `apply_native_tools` injector. */
export interface NativeToolPayload {
  tools: unknown[];
  tool_choice: unknown;
}

/**
 * Builds the provider-shaped native tool payload for the agent controller, or
 * `null` when native calling is disabled (the default) or the intent is not the
 * agent loop. A `null` return is the caller's signal to keep the existing
 * streaming text path unchanged. Native calling only rides the non-streaming
 * request path, so no streaming delta accumulation is involved.
 */
export function buildNativeToolPayload(
  providerType: AIProviderType,
  intent: AIRequestIntent,
  engineKey?: string | null,
): NativeToolPayload | null {
  if (!NATIVE_TOOL_CALLING_ENABLED || intent !== "agent") {
    return null;
  }

  return nativeToolPayloadForProvider(providerType, nativeCatalogOptionsForEngine(engineKey));
}

/**
 * Pure provider-shape mapping, independent of the feature flag so its wire
 * format stays unit-testable. Prefer buildNativeToolPayload at call sites; this
 * is the shape source of truth it delegates to.
 */
export function nativeToolPayloadForProvider(
  providerType: AIProviderType,
  options?: AgentToolCatalogOptions,
): NativeToolPayload {
  const specs = listEnabledAgentToolSpecs(options ?? true);
  switch (providerType) {
    case "anthropic":
      return { tools: toAnthropicTools(specs), tool_choice: { type: "auto" } };
    case "gemini":
      return {
        tools: toGeminiFunctionDeclarations(specs),
        tool_choice: { function_calling_config: { mode: "AUTO" } },
      };
    default:
      // OpenAI, OpenRouter, Ollama and Custom all speak the OpenAI tool shape.
      return { tools: toOpenAIFunctionTools(specs), tool_choice: "auto" };
  }
}

