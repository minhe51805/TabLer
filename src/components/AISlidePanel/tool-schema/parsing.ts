import { isAgentToolEnabled, type AgentToolAvailability } from "../ai-agent-engine-gates";
import { isUnattendedAllowedTool } from "../ai-agent-unattended";
import {
  AI_AGENT_TOOL_NAMES,
  WORKSPACE_ONLY_TOOLS,
  type AIAgentToolName,
  type AIAgentToolSpec,
  type JsonSchema,
} from "./constants";
import { AI_AGENT_TOOL_SPECS } from "./specs";

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
      const asString =
        action === "describe_tables" &&
        key === "tables" &&
        typeof value === "number" &&
        Number.isFinite(value)
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
      const capped =
        typeof schema.maxItems === "number" ? unique.slice(0, schema.maxItems) : unique;
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
  if (action === "delete_memory") {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!name) {
      throw new Error("The delete_memory action requires a non-empty args.name.");
    }
  }

  if (action === "edit_query_sql") {
    const sql = typeof args.sql === "string" ? args.sql.trim() : "";
    // tabId is only required for the existing-tab path; the createIfMissing
    // path intentionally omits it (that combination used to be rejected here,
    // which killed every createIfMissing call in the normalizer before the
    // executor could open a tab).
    const createIfMissing =
      args.createIfMissing === true ||
      args.createIfMissing === "true" ||
      args.createIfMissing === 1;
    const tabId = typeof args.tabId === "string" ? args.tabId.trim() : "";
    if (!sql || (!createIfMissing && !tabId)) {
      throw new Error(
        "The edit_query_sql action requires non-empty args.sql plus either args.tabId or createIfMissing: true.",
      );
    }
  }

  if (action === "save_memory") {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    const body = typeof args.body === "string" ? args.body.trim() : "";
    if (!name || !body) {
      throw new Error("The save_memory action requires non-empty args.name and args.body.");
    }
  }

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
      if (key === "column") return '"exact_column_name"';
      if (key === "value") return '"exact value; numbers may be unquoted"';
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
      if (key === "parameters") return '[{"name":"status","value":"active"}]';
      if (key === "statements") return `["UPDATE orders SET status = 'cancelled' WHERE id = 42"]`;
      if (key === "documents")
        return '[{"name":"Nguyen Van A","email":"a@example.com","status":"active"}]';
      if (key === "steps")
        return '[{"title":"Locate the orders table","status":"pending|in_progress|done"}]';
      if (key === "calls")
        return '[{"action":"describe_table","args":{"table":"users"}},{"action":"run_readonly_sql","args":{"sql":"SELECT ..."}}]';
      if (key === "metricsWidgets") {
        return '[{"title":"Widget title","type":"bar|horizontal-bar|line|area|pie|donut|radial|table|scoreboard","query":"SELECT ...","dimension":"verified label column","measures":["verified numeric alias"],"transforms":["group/sort operation"],"limit":100}]';
      }
      return "[]";
    default:
      return "{}";
  }
}

function formatControllerArgsExample(
  spec: AIAgentToolSpec,
  workspaceToolsEnabled: boolean,
): string {
  const properties = spec.parameters.properties ?? {};
  const entries = Object.entries(properties).filter(([key]) => {
    if (spec.name === "finish" && !workspaceToolsEnabled) return key !== "metricsWidgets";
    return true;
  });
  const body = entries.map(([key, schema]) => `"${key}":${exampleLiteral(key, schema)}`).join(",");
  return `{${body}}`;
}

export interface AgentToolCatalogOptions {
  workspaceToolsEnabled: boolean;
  availability?: Pick<AgentToolAvailability, "sqlRead" | "sqlWritePreview" | "documentPropose">;
  /**
   * P10: unattended agent run. The catalog is narrowed to the read-only tool
   * surface (`ai-agent-unattended`) so a write tool never even reaches the model
   * — the executor separately refuses it if the model invents the name.
   */
  unattendedReadOnly?: boolean;
}

function resolveCatalogOptions(options: boolean | AgentToolCatalogOptions): Required<
  Pick<AgentToolCatalogOptions, "workspaceToolsEnabled">
> & {
  availability: Pick<AgentToolAvailability, "sqlRead" | "sqlWritePreview" | "documentPropose">;
  unattendedReadOnly: boolean;
} {
  if (typeof options === "boolean") {
    return {
      workspaceToolsEnabled: options,
      // Permissive "unknown engine" defaults, matching sqlRead/sqlWritePreview:
      // real engine gating always rides nativeCatalogOptionsForEngine.
      availability: { sqlRead: true, sqlWritePreview: true, documentPropose: true },
      unattendedReadOnly: false,
    };
  }
  return {
    workspaceToolsEnabled: options.workspaceToolsEnabled,
    availability: options.availability ?? {
      sqlRead: true,
      sqlWritePreview: true,
      documentPropose: true,
    },
    unattendedReadOnly: options.unattendedReadOnly === true,
  };
}

/** Tools kept parseable for old threads but no longer advertised to models. */
const HIDDEN_CATALOG_TOOLS = new Set<AIAgentToolName>([
  // Superseded by describe_table's batch form (`tables` array).
  "describe_tables",
]);

export function listEnabledAgentToolSpecs(
  options: boolean | AgentToolCatalogOptions = true,
): AIAgentToolSpec[] {
  const resolved = resolveCatalogOptions(options);
  return listAgentToolSpecs().filter((spec) => {
    if (HIDDEN_CATALOG_TOOLS.has(spec.name)) return false;
    // P10: an unattended run only ever sees read tools. Checked before the
    // engine gates so "blocked unattended" always wins.
    if (resolved.unattendedReadOnly && !isUnattendedAllowedTool(spec.name)) return false;
    if (!resolved.workspaceToolsEnabled && WORKSPACE_ONLY_TOOLS.has(spec.name)) return false;
    return isAgentToolEnabled(spec.name, resolved.availability);
  });
}

/**
 * Numbered controller-action listing generated from the registry so the prompt
 * cannot drift from parseAIAgentToolAction / native tool schemas.
 */
export function formatAgentToolCatalog(
  options: boolean | AgentToolCatalogOptions = true,
): string[] {
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
