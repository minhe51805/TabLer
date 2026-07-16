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
      "list_tables",
      "search_schema",
      "describe_table",
      "run_readonly_sql",
      "finish",
    ]);
    expect(AI_AGENT_TOOL_NAMES).not.toContain("plan");
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

  it("rejects unsupported actions and non-object arguments", () => {
    expect(() => parseAIAgentToolAction('{"action":"plan"}'))
      .toThrow("unsupported action");
    expect(() => parseAIAgentToolAction('{"action":"finish","args":[]}'))
      .toThrow("invalid tool arguments");
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

    expect(() => parseAIAgentToolAction('{"action":"describe_table","args":{}}'))
      .toThrow("args.table");
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
