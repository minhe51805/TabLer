import type { AIProviderType, AIRequestIntent } from "../../../types";
import { nativeCatalogOptionsForEngine } from "../ai-agent-engine-gates";
import type { AIAgentToolSpec, JsonSchema } from "./constants";
import {
  listAgentToolSpecs,
  listEnabledAgentToolSpecs,
  type AgentToolCatalogOptions,
} from "./parsing";

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

export function toAnthropicTools(specs: AIAgentToolSpec[] = listAgentToolSpecs()): AnthropicTool[] {
  return specs.map((spec) => ({
    name: spec.name,
    description: spec.description,
    input_schema: spec.parameters,
  }));
}

/**
 * Anthropic's NATIVE client-side memory tool. Declared as an opaque type block
 * (no `input_schema`) ONLY on Anthropic requests, paired with the
 * `context-management-2025-06-27` beta header the backend already sends. Claude
 * drives it with view/create/str_replace/insert/delete/rename commands against
 * a virtual `/memories` tree; the backend `run_agent_memory_tool` command
 * executes them in a per-connection sandbox. It is deliberately NOT part of
 * `AI_AGENT_TOOL_NAMES`: it has no JSON-schema spec and must never be offered
 * to other providers.
 */
export const NATIVE_MEMORY_TOOL_TYPE = "memory_20250818";
export const NATIVE_ANTHROPIC_MEMORY_TOOL = {
  type: NATIVE_MEMORY_TOOL_TYPE,
  name: "memory",
} as const;

/** Gemini `tools[].functionDeclarations` entry. */
export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: JsonSchema;
}

const GEMINI_TYPE_NAMES: Record<JsonSchema["type"], string> = {
  object: "OBJECT",
  string: "STRING",
  number: "NUMBER",
  integer: "INTEGER",
  boolean: "BOOLEAN",
  array: "ARRAY",
};

/**
 * Gemini's Schema proto differs from JSON Schema in ways that hard-fail the
 * REST call when left as-is: `type` must be the UPPERCASE enum name
 * ("OBJECT" not "object"), and unknown keys like `additionalProperties` /
 * `uniqueItems` / `$schema` are rejected by the API's strict proto parsing.
 * Number bounds KEEP their JSON Schema names `minimum`/`maximum` — the Gemini
 * Schema proto uses those exact fields. An earlier "audit fix" renamed them to
 * `minValue`/`maxValue`, which the API rejects with
 * `Invalid JSON payload received. Unknown name "minValue" ... Cannot find field`,
 * hard-failing every request and forcing the provider failover chain.
 */
function toGeminiSchema(schema: JsonSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (schema.type) out.type = GEMINI_TYPE_NAMES[schema.type] ?? String(schema.type).toUpperCase();
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = [...schema.enum];
  if (typeof schema.minimum === "number") out.minimum = schema.minimum;
  if (typeof schema.maximum === "number") out.maximum = schema.maximum;
  if (typeof schema.minItems === "number") out.minItems = schema.minItems;
  if (typeof schema.maxItems === "number") out.maxItems = schema.maxItems;
  if (schema.items) out.items = toGeminiSchema(schema.items);
  if (schema.properties) {
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      properties[key] = toGeminiSchema(value);
    }
    out.properties = properties;
  }
  if (schema.required?.length) out.required = [...schema.required];
  return out;
}

export function toGeminiFunctionDeclarations(
  specs: AIAgentToolSpec[] = listAgentToolSpecs(),
): GeminiFunctionDeclaration[] {
  return specs.map((spec) => ({
    name: spec.name,
    description: spec.description,
    // Wire shape normalized to Gemini's Schema proto (see toGeminiSchema).
    parameters: toGeminiSchema(spec.parameters) as unknown as JsonSchema,
  }));
}

/**
 * Feature flag for native provider function-calling. The full pipeline is in
 * place on both ends: the frontend `buildNativeToolPayload` rides the
 * non-streaming request path, the backend `apply_native_tools` injector adds
 * the provider-shaped `tools`/`tool_choice`, and `extract_tool_call_as_action_json`
 * normalizes native tool-call responses back into the text contract the agent
 * loop already parses (with the parse-repair loop as a safety net for plain
 * text finals). Enabled so the 17-tool catalog no longer ships as prompt text
 * on every request — tools travel in the `tools` parameter instead.
 */
export const NATIVE_TOOL_CALLING_ENABLED = true;

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
      // Append Anthropic's NATIVE memory tool (opaque type block, no
      // input_schema) so Claude can persist notes across turns in the
      // /memories sandbox, backed by the `run_agent_memory_tool` command.
      // Anthropic-only: no other provider understands this type block, and it
      // is absent from AI_AGENT_TOOL_NAMES so it is never offered elsewhere.
      return {
        tools: [...toAnthropicTools(specs), NATIVE_ANTHROPIC_MEMORY_TOOL],
        tool_choice: { type: "auto" },
      };
    case "gemini":
    case "vertex":
      // Vertex AI speaks the same generateContent wire format as Gemini:
      // functionDeclarations + tool_config.function_calling_config.
      return {
        tools: toGeminiFunctionDeclarations(specs),
        tool_choice: { function_calling_config: { mode: "AUTO" } },
      };
    default:
      // OpenAI, OpenRouter, Ollama and Custom all speak the OpenAI tool shape.
      return { tools: toOpenAIFunctionTools(specs), tool_choice: "auto" };
  }
}
