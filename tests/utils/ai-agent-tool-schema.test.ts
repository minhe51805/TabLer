import { describe, expect, it } from "vitest";
import {
  AI_AGENT_TOOL_NAMES,
  AI_AGENT_BATCH_DESCRIBE_LIMIT,
  AI_AGENT_PREVIEW_STATEMENT_LIMIT,
  AI_AGENT_SAMPLE_MAX_ROWS,
} from "@/components/AISlidePanel/ai-agent-tools";
import { nativeCatalogOptionsForEngine } from "@/components/AISlidePanel/ai-agent-engine-gates";
import {
  AI_AGENT_TOOL_SPECS,
  NATIVE_TOOL_CALLING_ENABLED,
  buildNativeToolPayload,
  formatAgentToolCatalog,
  listAgentToolSpecs,
  nativeToolPayloadForProvider,
  parseAgentToolArgs,
  toAnthropicTools,
  toGeminiFunctionDeclarations,
  toOpenAIFunctionTools,
  type AIAgentToolName,
} from "@/components/AISlidePanel/ai-agent-tool-schema";

describe("AI agent tool schema", () => {
  it("defines exactly one spec per registered tool, in canonical order", () => {
    expect(Object.keys(AI_AGENT_TOOL_SPECS).sort()).toEqual([...AI_AGENT_TOOL_NAMES].sort());
    expect(listAgentToolSpecs().map((spec) => spec.name)).toEqual([...AI_AGENT_TOOL_NAMES]);
  });

  it("gives every tool a name matching its key, a description, and an object schema", () => {
    for (const [key, spec] of Object.entries(AI_AGENT_TOOL_SPECS)) {
      expect(spec.name).toBe(key);
      expect(spec.description.length).toBeGreaterThan(0);
      expect(spec.parameters.type).toBe("object");
    }
  });

  it("mirrors the normalizer's required fields and numeric bounds", () => {
    expect(AI_AGENT_TOOL_SPECS.ask_user.parameters.required).toEqual(["question"]);
    expect(AI_AGENT_TOOL_SPECS.search_schema.parameters.required).toEqual(["query"]);
    expect(AI_AGENT_TOOL_SPECS.describe_table.parameters.required).toEqual(["table"]);
    expect(AI_AGENT_TOOL_SPECS.describe_tables.parameters.required).toEqual(["tables"]);
    expect(AI_AGENT_TOOL_SPECS.sample_table_data.parameters.required).toEqual(["table"]);
    expect(AI_AGENT_TOOL_SPECS.run_readonly_sql.parameters.required).toEqual(["sql"]);
    expect(AI_AGENT_TOOL_SPECS.preview_write.parameters.required).toEqual(["statements"]);
    expect(AI_AGENT_TOOL_SPECS.remember_term.parameters.required).toEqual(["term", "definition"]);

    expect(AI_AGENT_TOOL_SPECS.list_tables.parameters.properties?.limit?.maximum).toBe(200);
    expect(AI_AGENT_TOOL_SPECS.sample_table_data.parameters.properties?.limit?.maximum).toBe(
      AI_AGENT_SAMPLE_MAX_ROWS,
    );
    expect(AI_AGENT_TOOL_SPECS.describe_tables.parameters.properties?.tables?.maxItems).toBe(
      AI_AGENT_BATCH_DESCRIBE_LIMIT,
    );
    expect(AI_AGENT_TOOL_SPECS.preview_write.parameters.properties?.statements?.maxItems).toBe(
      AI_AGENT_PREVIEW_STATEMENT_LIMIT,
    );
    expect(AI_AGENT_TOOL_SPECS.remember_term.parameters.properties?.kind?.enum).toEqual([
      "term",
      "metric",
      "relationship",
      "alias",
    ]);
  });

  it("keeps finish permissive so its flexible payload is not rejected", () => {
    expect(AI_AGENT_TOOL_SPECS.finish.parameters.additionalProperties).toBe(true);
    expect(AI_AGENT_TOOL_SPECS.finish.parameters.required).toBeUndefined();
  });

  it("converts to the OpenAI function-tool wire format", () => {
    const tools = toOpenAIFunctionTools();
    expect(tools).toHaveLength(AI_AGENT_TOOL_NAMES.length);
    expect(tools[0]).toEqual({
      type: "function",
      function: {
        name: AI_AGENT_TOOL_SPECS.ask_user.name,
        description: AI_AGENT_TOOL_SPECS.ask_user.description,
        parameters: AI_AGENT_TOOL_SPECS.ask_user.parameters,
      },
    });
  });

  it("converts to the Anthropic tool wire format with input_schema", () => {
    const tools = toAnthropicTools();
    expect(tools).toHaveLength(AI_AGENT_TOOL_NAMES.length);
    expect(tools[0].name).toBe("ask_user");
    expect(tools[0].input_schema).toBe(AI_AGENT_TOOL_SPECS.ask_user.parameters);
    expect(tools[0]).not.toHaveProperty("parameters");
  });

  it("converts to Gemini function declarations", () => {
    const decls = toGeminiFunctionDeclarations();
    expect(decls).toHaveLength(AI_AGENT_TOOL_NAMES.length);
    expect(decls.map((decl) => decl.name)).toEqual([...AI_AGENT_TOOL_NAMES]);
    expect(decls[0].parameters).toBe(AI_AGENT_TOOL_SPECS.ask_user.parameters);
  });

  it("keeps native tool calling gated off by default so the text path stays default", () => {
    expect(NATIVE_TOOL_CALLING_ENABLED).toBe(false);
    // While the flag is off the request builder must be inert for every caller.
    expect(buildNativeToolPayload("openai", "agent")).toBeNull();
    expect(buildNativeToolPayload("anthropic", "agent")).toBeNull();
    expect(buildNativeToolPayload("openai", "agent", "redis")).toBeNull();
  });

  it("only ever offers tools for the agent intent", () => {
    // Even if the flag were on, non-agent intents must never attach tools.
    expect(buildNativeToolPayload("openai", "sql")).toBeNull();
  });

  it("shapes the OpenAI-family tool payload with a top-level tool_choice", () => {
    for (const provider of ["openai", "openrouter", "ollama", "custom"] as const) {
      const payload = nativeToolPayloadForProvider(provider);
      expect(payload.tools).toHaveLength(AI_AGENT_TOOL_NAMES.length);
      expect(payload.tool_choice).toBe("auto");
      expect((payload.tools[0] as { type: string }).type).toBe("function");
    }
  });

  it("shapes Anthropic and Gemini tool payloads in their native formats", () => {
    const anthropic = nativeToolPayloadForProvider("anthropic");
    expect(anthropic.tools).toHaveLength(AI_AGENT_TOOL_NAMES.length);
    expect((anthropic.tools[0] as Record<string, unknown>)).toHaveProperty("input_schema");
    expect(anthropic.tool_choice).toEqual({ type: "auto" });

    const gemini = nativeToolPayloadForProvider("gemini");
    expect(gemini.tools).toHaveLength(AI_AGENT_TOOL_NAMES.length);
    expect(gemini.tool_choice).toEqual({ function_calling_config: { mode: "AUTO" } });
  });

  it("lists every registry tool in the controller catalog, and only ask_user/finish when tools are off", () => {
    const enabled = formatAgentToolCatalog(true);
    expect(enabled.map((line) => line.match(/"action":"([^"]+)"/)?.[1])).toEqual([...AI_AGENT_TOOL_NAMES]);
    const disabled = formatAgentToolCatalog(false);
    expect(disabled.map((line) => line.match(/"action":"([^"]+)"/)?.[1])).toEqual(["ask_user", "finish"]);
    expect(disabled.join("\n")).not.toContain("metricsWidgets");
  });

  it("drops SQL tools from the native payload when the engine cannot speak SQL", () => {
    const payload = nativeToolPayloadForProvider("openai", nativeCatalogOptionsForEngine("mongodb"));
    const names = (payload.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name);
    expect(names).not.toContain("run_readonly_sql");
    expect(names).not.toContain("preview_write");
    expect(names).toContain("sample_table_data");
  });
});

describe("parseAgentToolArgs", () => {
  it.each([
    ["ask_user", { question: " Which? " }, { question: "Which?" }],
    ["list_tables", { schema: " public ", limit: 900 }, { schema: "public", limit: 200 }],
    ["search_schema", { query: "  email " }, { query: "email" }],
    ["describe_table", { table: " users " }, { table: "users" }],
    ["describe_tables", { tables: ["a", "a", 2] }, { tables: ["a", "2"] }],
    ["sample_table_data", { table: "users", limit: 500 }, { table: "users", limit: AI_AGENT_SAMPLE_MAX_ROWS }],
    ["run_readonly_sql", { sql: "  SELECT 1  " }, { sql: "SELECT 1" }],
    ["preview_write", { statements: [" UPDATE x ", ""] }, { statements: ["UPDATE x"] }],
    ["remember_term", { term: " gmv ", definition: " revenue " }, { term: "gmv", definition: "revenue" }],
    ["finish", { response: "done", extra: true }, { response: "done", extra: true }],
  ] as Array<[AIAgentToolName, Record<string, unknown>, Record<string, unknown>]>)(
    "accepts valid args for %s",
    (action, args, expected) => {
      expect(parseAgentToolArgs(action, args)).toEqual(expected);
    },
  );

  it.each([
    ["ask_user", {}, /args.question/],
    ["search_schema", { query: " " }, /args.query/],
    ["describe_table", {}, /args.table/],
    ["describe_tables", { tables: [] }, /args.tables array/],
    ["sample_table_data", { table: "" }, /args.table/],
    ["run_readonly_sql", { sql: "   " }, /args.sql/],
    ["preview_write", { statements: [123] }, /args.statements array/],
    ["remember_term", { term: "x", definition: "" }, /args.term and args.definition/],
  ] as Array<[AIAgentToolName, Record<string, unknown>, RegExp]>)(
    "rejects invalid args for %s",
    (action, args, error) => {
      expect(() => parseAgentToolArgs(action, args)).toThrow(error);
    },
  );

  it("drops optional fields with the wrong type instead of failing the call", () => {
    expect(parseAgentToolArgs("list_tables", { pattern: "ord", limit: "all" })).toEqual({
      pattern: "ord",
    });
    expect(parseAgentToolArgs("ask_user", { question: "Go?", multiple: "yes" })).toEqual({
      question: "Go?",
    });
  });
});
