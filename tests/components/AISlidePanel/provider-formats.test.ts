import { describe, expect, it } from "vitest";
import {
  NATIVE_MEMORY_TOOL_TYPE,
  buildNativeToolPayload,
  nativeToolPayloadForProvider,
  toGeminiFunctionDeclarations,
} from "@/components/AISlidePanel/tool-schema/provider-formats";
import type { AIAgentToolSpec } from "@/components/AISlidePanel/tool-schema/constants";
/** Reads a string field off an opaque `unknown[]` tool entry (narrowed, not cast). */
function stringField(tool: unknown, key: "name" | "type"): string | undefined {
  if (typeof tool !== "object" || tool === null || !(key in tool)) return undefined;
  const value = (tool as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

const isNativeMemoryTool = (tool: unknown) => stringField(tool, "type") === NATIVE_MEMORY_TOOL_TYPE;

/**
 * Gemini's Schema proto rejects unknown JSON-Schema keys and lowercase type
 * names — a regression here hard-fails every request into provider failover.
 */
describe("toGeminiSchema via toGeminiFunctionDeclarations", () => {
  it("uppercases types, strips JSON-Schema-only keys, keeps Gemini proto fields", () => {
    const spec: AIAgentToolSpec = {
      name: "run_readonly_sql",
      description: "runs a query",
      parameters: {
        type: "object",
        description: "outer",
        additionalProperties: false,
        required: ["sql"],
        properties: {
          sql: { type: "string", description: "the query" },
          limit: { type: "integer", minimum: 1, maximum: 500 },
          offset: { type: "number" },
          active: { type: "boolean" },
          mode: { type: "string", enum: ["fast", "full"] },
          tags: {
            type: "array",
            uniqueItems: true,
            minItems: 1,
            maxItems: 4,
            items: { type: "string", additionalProperties: true },
          },
          schema: {
            type: "object",
            additionalProperties: false,
            properties: { name: { type: "string" } },
            required: ["name"],
          },
        },
      },
    };

    const [declaration] = toGeminiFunctionDeclarations([spec]);
    expect(declaration.name).toBe("run_readonly_sql");
    expect(declaration.description).toBe("runs a query");

    // The declared return type is JsonSchema but the wire shape is the Gemini
    // proto map — named record views for assertion below.
    const params = declaration.parameters as unknown as Record<string, unknown>;
    expect(params.type).toBe("OBJECT");
    expect(params.description).toBe("outer");
    expect(params.additionalProperties).toBeUndefined();
    expect(params.required).toEqual(["sql"]);

    const props = params.properties as Record<string, Record<string, unknown>>;
    expect(props.sql.type).toBe("STRING");
    expect(props.limit.type).toBe("INTEGER");
    // Gemini's Schema proto accepts minimum/maximum verbatim — renaming them
    // to minValue/maxValue is the exact regression this pins.
    expect(props.limit.minimum).toBe(1);
    expect(props.limit.maximum).toBe(500);
    expect(props.limit.minValue).toBeUndefined();
    expect(props.limit.maxValue).toBeUndefined();
    expect(props.offset.type).toBe("NUMBER");
    expect(props.active.type).toBe("BOOLEAN");
    expect(props.mode.enum).toEqual(["fast", "full"]);

    expect(props.tags.type).toBe("ARRAY");
    expect(props.tags.uniqueItems).toBeUndefined();
    expect(props.tags.minItems).toBe(1);
    expect(props.tags.maxItems).toBe(4);
    const tagItems = props.tags.items as Record<string, unknown>;
    expect(tagItems.type).toBe("STRING");
    expect(tagItems.additionalProperties).toBeUndefined();

    const nested = props.schema;
    expect(nested.type).toBe("OBJECT");
    expect(nested.additionalProperties).toBeUndefined();
    expect(nested.required).toEqual(["name"]);
    const nestedProps = nested.properties as Record<string, Record<string, unknown>>;
    expect(nestedProps.name.type).toBe("STRING");
  });
});

describe("nativeToolPayloadForProvider", () => {
  it("appends the opaque memory_20250818 block for anthropic only", () => {
    const payload = nativeToolPayloadForProvider("anthropic", { workspaceToolsEnabled: true });
    const memoryTools = payload.tools.filter(isNativeMemoryTool);
    expect(memoryTools).toHaveLength(1);
    expect(stringField(memoryTools[0], "name")).toBe("memory");
    // The memory block is opaque — declaring an input_schema would corrupt it.
    expect(
      typeof memoryTools[0] === "object" &&
        memoryTools[0] !== null &&
        "input_schema" in memoryTools[0],
    ).toBe(false);
    expect(payload.tool_choice).toEqual({ type: "auto" });
  });

  it("never offers the native memory tool to non-anthropic providers", () => {
    for (const provider of ["openai", "gemini", "vertex", "ollama", "custom"] as const) {
      const payload = nativeToolPayloadForProvider(provider, { workspaceToolsEnabled: true });
      expect(payload.tools.filter(isNativeMemoryTool), provider).toHaveLength(0);
    }
  });

  it("unattendedReadOnly strips write tools and the native memory tool", () => {
    const attended = nativeToolPayloadForProvider("anthropic", { workspaceToolsEnabled: true });
    const unattended = nativeToolPayloadForProvider("anthropic", {
      workspaceToolsEnabled: true,
      unattendedReadOnly: true,
    });
    const unattendedNames = unattended.tools.map((tool) => stringField(tool, "name"));

    // Reads stay; anything that can change state is simply absent.
    for (const writeTool of [
      "preview_write",
      "propose_seed_data",
      "edit_query_sql",
      "save_memory",
      "delete_memory",
      "remember_term",
      "create_checkpoint",
      "restore_checkpoint",
      "manage_schedule",
      "manage_metrics_widget",
      "manage_skill",
      "manage_rule",
      "switch_database",
      "open_table_tab",
      "ask_user",
      "memory",
    ]) {
      expect(unattendedNames).not.toContain(writeTool);
    }
    expect(unattendedNames).toContain("run_readonly_sql");
    expect(unattendedNames).toContain("read_memory");
    expect(unattendedNames).toContain("finish");
    expect(unattended.tools.length).toBeLessThan(attended.tools.length);
  });
});

describe("buildNativeToolPayload", () => {
  it("returns null for non-agent intents regardless of provider", () => {
    expect(buildNativeToolPayload("anthropic", "sql")).toBeNull();
    expect(buildNativeToolPayload("openai", "general")).toBeNull();
    expect(buildNativeToolPayload("gemini", "explain")).toBeNull();
  });

  it("builds a payload for the agent intent and forwards unattendedReadOnly", () => {
    const attended = buildNativeToolPayload("anthropic", "agent", "postgresql");
    expect(attended).not.toBeNull();
    expect(attended?.tools.some(isNativeMemoryTool)).toBe(true);

    const unattended = buildNativeToolPayload("anthropic", "agent", "postgresql", {
      unattendedReadOnly: true,
    });
    expect(unattended).not.toBeNull();
    const names = (unattended?.tools ?? []).map((tool) => stringField(tool, "name"));
    expect(names).not.toContain("memory");
    expect(names).not.toContain("preview_write");
  });
});
