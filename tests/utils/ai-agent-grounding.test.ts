import { describe, expect, it } from "vitest";

import {
  buildSchemaContextRequiredMessage,
  buildSchemaRegroundingPrompt,
  buildSqlRegroundingPrompt,
  extractReferencedTableNamesFromSql,
  findMatchingTableName,
  isOverviewContextMissingResponse,
  mentionsUnknownSchemaNames,
  redactAgentSqlLiterals,
  responseConflictsWithSchema,
  sanitizeAgentObservationValue,
  sqlResponseConflictsWithSchema,
  stringifyAgentObservation,
  summarizeAgentQueryObservation,
  truncateAgentObservation,
} from "@/components/AISlidePanel/ai-agent-grounding";
import type { QueryResult } from "@/types";

function makeQueryResult(overrides: Partial<QueryResult> = {}): QueryResult {
  return {
    columns: [{ name: "id", data_type: "integer", is_nullable: false, is_primary_key: true }],
    rows: [[1]],
    affected_rows: 0,
    execution_time_ms: 12,
    query: "SELECT id FROM users",
    sandboxed: true,
    truncated: false,
    ...overrides,
  };
}

describe("AI agent grounding", () => {
  it("bounds trace observations", () => {
    expect(truncateAgentObservation("x".repeat(1400))).toHaveLength(1400);
    const truncated = truncateAgentObservation("x".repeat(1500));
    expect(truncated).toHaveLength(1400);
    expect(truncated.endsWith("...")).toBe(true);
    expect(stringifyAgentObservation({ note: "x".repeat(1500) })).toHaveLength(1400);
  });

  it("redacts sensitive values and truncates ordinary long strings", () => {
    expect(sanitizeAgentObservationValue("hunter2", "password_hash")).toBe("[REDACTED]");
    expect(sanitizeAgentObservationValue("secret", "api_key")).toBe("[REDACTED]");
    expect(sanitizeAgentObservationValue("refresh", "refresh_token")).toBe("[REDACTED]");
    expect(sanitizeAgentObservationValue("x".repeat(121), "description")).toHaveLength(120);
    expect(sanitizeAgentObservationValue(42, "score")).toBe(42);
  });

  it("redacts SQL string literals", () => {
    expect(redactAgentSqlLiterals("SELECT * FROM users WHERE email = 'a@b.com' AND note = 'it''s ok'"))
      .toBe("SELECT * FROM users WHERE email = '[REDACTED]' AND note = '[REDACTED]'");
  });

  it("limits query previews and removes secrets from trace output", () => {
    const columnNames = ["id", "email", "password", "api_key", "c5", "c6", "c7", "c8", "c9"];
    const result = makeQueryResult({
      columns: columnNames.map((name) => ({
        name,
        data_type: "text",
        is_nullable: true,
        is_primary_key: false,
      })),
      rows: Array.from({ length: 6 }, (_, rowIndex) => columnNames.map((_, columnIndex) => `${rowIndex}-${columnIndex}`)),
      query: "SELECT * FROM users WHERE email = 'private@example.com'",
    });

    const observation = summarizeAgentQueryObservation(result);
    expect(observation).not.toContain("private@example.com");
    expect(observation).not.toContain("0-2");
    expect(observation).not.toContain("0-3");
    expect(observation).not.toContain("5-0");
    expect(observation).not.toContain("c9:text");
    expect(observation).toContain("[REDACTED]");
  });

  it("extracts referenced tables across SQL statement types", () => {
    const sql = [
      'SELECT * FROM "public"."Users" u JOIN analytics.daily_orders d ON d.user_id = u.id;',
      "UPDATE accounts SET active = true;",
      "INSERT INTO audit_logs(id) VALUES (1);",
      "DELETE FROM expired_sessions;",
    ].join("\n");

    expect(extractReferencedTableNamesFromSql(sql)).toEqual([
      "users", "expired_sessions", "daily_orders", "accounts", "audit_logs",
    ]);
  });

  it("accepts verified and system tables while rejecting invented tables", () => {
    const known = ['"public"."Users"', "analytics.daily_orders"];
    expect(sqlResponseConflictsWithSchema('SELECT * FROM "public"."Users"', known)).toBe(false);
    expect(sqlResponseConflictsWithSchema("SELECT * FROM information_schema.tables", known)).toBe(false);
    expect(sqlResponseConflictsWithSchema("SELECT * FROM imaginary_orders", known)).toBe(true);
  });

  it("matches qualified table names by normalized identity", () => {
    const tables = ['"public"."Users"', "analytics.daily_orders"];
    expect(findMatchingTableName("users", tables)).toBe('"public"."Users"');
    expect(findMatchingTableName("daily_orders", tables)).toBe("analytics.daily_orders");
    expect(findMatchingTableName("missing", tables)).toBeNull();
  });

  it("detects unknown schema names in prose", () => {
    const known = ["public.users", "public.orders"];
    expect(mentionsUnknownSchemaNames("Table users: stores profiles", known)).toBe(false);
    expect(responseConflictsWithSchema("Table invoices: stores billing", known)).toBe(true);
    expect(responseConflictsWithSchema("A general SQL explanation", known)).toBe(false);
  });

  it.each([
    "Vui lòng cung cấp schema để tôi tiếp tục",
    "There is not enough context; please provide the tables",
    "没有数据库上下文，请提供更多信息",
  ])("recognizes missing-context response: %s", (response) => {
    expect(isOverviewContextMissingResponse(response)).toBe(true);
  });

  it("builds SQL recovery prompts with the verified allow-list", () => {
    const prompt = buildSqlRegroundingPrompt("app", ["users", "orders"], "show revenue", "agent");
    expect(prompt).toContain('CURRENT database "app"');
    expect(prompt).toContain("Allowed tables only: users, orders");
    expect(prompt).toContain("Interaction mode is agent");
    expect(prompt).toContain("show revenue");
  });

  it("builds localized schema recovery prompts", () => {
    const prompt = buildSchemaRegroundingPrompt("vi", "app", ["users"], "overview", "đọc lại db");
    expect(prompt).toContain('DB hiện tại "app"');
    expect(prompt).toContain("users");
    expect(prompt).toContain("Không được bịa");
  });

  it("explains provider policy and prompt-only schema blocks separately", () => {
    const providerBlocked = buildSchemaContextRequiredMessage("en", "app", "Cloud AI", "agent", false);
    expect(providerBlocked).toContain("Cloud AI");
    expect(providerBlocked).toContain("Allow schema context sharing");

    const modeBlocked = buildSchemaContextRequiredMessage("en", "app", "Cloud AI", "prompt", true);
    expect(modeBlocked).toContain('"Prompt only" mode');
    expect(modeBlocked).toContain('Switch to "Edit" or "Agent"');
  });
});
