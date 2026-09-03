import { describe, expect, it } from "vitest";
import {
  AI_AGENT_TOOL_NAMES,
  parseAIAgentToolAction,
  validateAIAgentReadonlySql,
} from "@/components/AISlidePanel/ai-agent-tools";
import { getAgentSqlSchemaRequirements } from "@/components/AISlidePanel/ai-agent-grounding";

describe("AI agent tool contract", () => {
  it("exposes only executable controller actions", () => {
    expect(AI_AGENT_TOOL_NAMES).toEqual([
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
      "remember_term",
      "read_memory",
      "save_memory",
      "create_checkpoint",
      "restore_checkpoint",
      "skill",
      "delegate",
      "read_page",
      "finish",
    ]);
    expect(AI_AGENT_TOOL_NAMES).not.toContain("plan");
  });

  it("parses skill loads and trims the skill name", () => {
    expect(parseAIAgentToolAction(
      '{"action":"skill","message":"This matches the db-audit skill","args":{"name":" db-audit "}}',
    )).toEqual({
      action: "skill",
      message: "This matches the db-audit skill",
      args: { name: "db-audit" },
    });
  });

  it("parses ask_user questions with bounded, cleaned options", () => {
    expect(parseAIAgentToolAction(
      '{"action":"ask_user","message":"Need direction","args":{"question":" Which report? ","options":["Revenue","Revenue","  ","Users by role"],"multiple":true}}',
    )).toEqual({
      action: "ask_user",
      message: "Need direction",
      args: { question: "Which report?", options: ["Revenue", "Users by role"], multiple: true },
    });

    expect(() => parseAIAgentToolAction('{"action":"ask_user","message":"Bad","args":{}}'))
      .toThrow("non-empty args.question");
  });

  it("parses describe_tables batches, dedupes names, and caps the batch size", () => {
    const parsed = parseAIAgentToolAction(
      '{"action":"describe_tables","message":"Inspect report tables","args":{"tables":["public.bots","public.bots"," public.users ","42"]}}',
    );
    expect(parsed).toEqual({
      action: "describe_tables",
      message: "Inspect report tables",
      args: { tables: ["public.bots", "public.users", "42"] },
    });

    expect(parseAIAgentToolAction(
      '{"action":"describe_tables","message":"Numeric ids","args":{"tables":["bots",123]}}',
    ).args).toEqual({ tables: ["bots", "123"] });

    expect(() => parseAIAgentToolAction(
      '{"action":"describe_tables","message":"Bad","args":{"tables":[]}}',
    )).toThrow("non-empty args.tables array");
  });

  it("parses a fenced action and normalizes optional fields", () => {
    expect(parseAIAgentToolAction(`
      \`\`\`json
      {"action":"describe_table","message":"  Inspect users  ","args":{"table":"users"}}
      \`\`\`
    `)).toEqual({
      action: "describe_table",
      message: "Inspect users",
      args: { table: "users" },
    });
  });

  it("extracts JSON from prose and repairs literal control characters", () => {
    const response = `Next action:\n{"action":"finish","message":"line one
line two","args":{"response":"done"}}\nThanks`;

    expect(parseAIAgentToolAction(response)).toEqual({
      action: "finish",
      message: "line one\nline two",
      args: { response: "done" },
    });
  });

  it("recovers useful fields from a truncated JSON response", () => {
    expect(parseAIAgentToolAction(
      '{"action":"finish","message":"Done","args":{"response":"partial',
    )).toEqual({
      action: "finish",
      message: "Done",
      args: { response: "partial" },
    });
  });

  it("parses remember_term entries and rejects blanks", () => {
    expect(parseAIAgentToolAction(
      '{"action":"remember_term","message":"Learning revenue","args":{"term":" revenue ","definition":"sum(amount) where paid","kind":"metric"}}',
    )).toEqual({
      action: "remember_term",
      message: "Learning revenue",
      args: { term: "revenue", definition: "sum(amount) where paid", kind: "metric" },
    });

    expect(parseAIAgentToolAction(
      '{"action":"remember_term","message":"Default kind","args":{"term":"campaigns","definition":"marketing groups"}}',
    ).args).toEqual({ term: "campaigns", definition: "marketing groups" });

    expect(() => parseAIAgentToolAction(
      '{"action":"remember_term","message":"Bad","args":{"term":"","definition":"x"}}',
    )).toThrow("non-empty args.term and args.definition");
  });

  it("parses preview_write statements and caps the batch", () => {
    expect(parseAIAgentToolAction(
      `{"action":"preview_write","message":"Fix status","args":{"statements":["UPDATE orders SET status = 'cancelled' WHERE id = 42","  ","DELETE FROM logs WHERE old = true"]}}`,
    )).toEqual({
      action: "preview_write",
      message: "Fix status",
      args: { statements: ["UPDATE orders SET status = 'cancelled' WHERE id = 42", "DELETE FROM logs WHERE old = true"] },
    });

    expect(() => parseAIAgentToolAction('{"action":"preview_write","message":"Bad","args":{}}'))
      .toThrow("non-empty args.statements array");
  });

  it("rejects unsupported actions and non-object arguments", () => {
    expect(() => parseAIAgentToolAction('{"action":"plan"}'))
      .toThrow("unsupported action");
    expect(() => parseAIAgentToolAction('{"action":"finish","args":[]}'))
      .toThrow("invalid tool arguments");
  });

  it("parses list_tables catalog filters and drops invalid argument types", () => {
    expect(parseAIAgentToolAction(
      '{"action":"list_tables","message":"Find sales tables","args":{"schema":"Sales","pattern":"orders","limit":"all"}}',
    )).toEqual({
      action: "list_tables",
      message: "Find sales tables",
      args: { schema: "Sales", pattern: "orders" },
    });

    expect(parseAIAgentToolAction(
      '{"action":"list_tables","message":"Catalog","args":{"limit":500}}',
    )).toEqual({
      action: "list_tables",
      message: "Catalog",
      args: { limit: 200 },
    });

    expect(parseAIAgentToolAction(
      '{"action":"list_tables","message":"Only populated tables","args":{"minRows":1}}',
    )).toEqual({
      action: "list_tables",
      message: "Only populated tables",
      args: { minRows: 1 },
    });
  });

  it("parses sample_table_data and clamps the row limit", () => {
    expect(parseAIAgentToolAction(
      '{"action":"sample_table_data","message":"Peek users","args":{"table":"public.users","limit":500}}',
    )).toEqual({
      action: "sample_table_data",
      message: "Peek users",
      args: { table: "public.users", limit: 50 },
    });

    expect(parseAIAgentToolAction(
      '{"action":"sample_table_data","message":"Peek users","args":{"table":"public.users"}}',
    ).args).toEqual({ table: "public.users" });

    expect(() => parseAIAgentToolAction('{"action":"sample_table_data","message":"Peek","args":{}}'))
      .toThrow("requires a non-empty args.table");
  });

  it("validates and normalizes action-specific arguments", () => {
    expect(parseAIAgentToolAction(
      '{"action":"search_schema","args":{"query":"  email  "}}',
    )).toEqual({
      action: "search_schema",
      args: { query: "email" },
      message: "",
    });
    expect(parseAIAgentToolAction(
      '{"action":"describe_table","args":{"table":"  public.users  "}}',
    )).toEqual({
      action: "describe_table",
      args: { table: "public.users" },
      message: "",
    });
    expect(parseAIAgentToolAction(
      '{"action":"run_readonly_sql","args":{"sql":"  SELECT 1  "}}',
    )).toEqual({
      action: "run_readonly_sql",
      args: { sql: "SELECT 1" },
      message: "",
    });

    // describe_table with no args now parses (both forms are optional); the
    // executor reports the missing table/tables at run time.
    expect(
      parseAIAgentToolAction('{"action":"describe_table","args":{}}').args,
    ).toEqual({});
    expect(() => parseAIAgentToolAction('{"action":"search_schema","args":{"query":" "}}'))
      .toThrow("args.query");
    expect(() => parseAIAgentToolAction('{"action":"run_readonly_sql","args":{"sql":" "}}'))
      .toThrow("args.sql");
  });

  it("accepts and splits read-only observation queries", () => {
    expect(validateAIAgentReadonlySql(
      "SELECT id FROM users; EXPLAIN SELECT * FROM users; PRAGMA table_info(users);",
    )).toEqual([
      "SELECT id FROM users",
      "EXPLAIN SELECT * FROM users",
      "PRAGMA table_info(users)",
    ]);
  });

  it("requires an inspected schema before reading a referenced table", () => {
    expect(getAgentSqlSchemaRequirements(
      "SELECT * FROM public.app_settings WHERE value ILIKE '%vibe%'",
      ["app_settings", "bots"],
      ["bots"],
    )).toEqual({ unknown: [], uninspected: ["app_settings"] });

    expect(getAgentSqlSchemaRequirements(
      "SELECT * FROM missing_table",
      ["app_settings"],
      ["app_settings"],
    )).toEqual({ unknown: ["missing_table"], uninspected: [] });
  });

  it.each([
    "DELETE FROM users",
    "UPDATE users SET active = 0",
    "PRAGMA foreign_keys = OFF",
    "USE another_database",
  ])("blocks non-read-only observation SQL: %s", (sql) => {
    expect(() => validateAIAgentReadonlySql(sql)).toThrow(/only allows|read-only/);
  });
});
