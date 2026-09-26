import { describe, expect, it } from "vitest";
import {
  extractLeadingUseDirective,
  formatExecutionError,
  isHighRiskStatement,
  isMutatingStatement,
  isSessionSwitchStatement,
  isTrustedInlineCompletionConnection,
  normalizeInlineSuggestion,
} from "@/components/SQLEditor/SQLEditorUtils";
import type { ConnectionConfig } from "@/types";

const connection = (updates: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  id: "c1",
  name: "",
  db_type: "postgresql",
  use_ssl: false,
  ...updates,
});

describe("isHighRiskStatement", () => {
  it.each([
    "DROP TABLE users",
    "TRUNCATE TABLE users",
    "GRANT ALL ON t TO r",
    "REVOKE SELECT ON t FROM r",
    "ALTER USER alice WITH PASSWORD 'x'",
    "CREATE USER alice",
    "DROP USER alice",
    "DELETE FROM users",
    "UPDATE users SET admin = true",
    // Comment prefixes must not dodge the risk gate.
    "-- run it\nDELETE FROM users",
    "/* go */ DROP TABLE users",
    // EXPLAIN ANALYZE executes the wrapped write — recursion must find it.
    "EXPLAIN ANALYZE DELETE FROM users",
    "EXPLAIN ANALYZE DROP TABLE users",
    // Even planning-only EXPLAIN of a write inherits the risk (backend
    // classifies any EXPLAIN of a write as non-read).
    "EXPLAIN DROP TABLE users",
    "EXPLAIN (COSTS) DELETE FROM users",
  ])("flags high risk: %s", (sql) => {
    expect(isHighRiskStatement(sql)).toBe(true);
  });

  it.each([
    "SELECT * FROM users",
    "DELETE FROM users WHERE id = 1",
    "UPDATE users SET admin = true WHERE id = 1",
    // A WHERE inside a string literal still counts — the guard is a
    // conservative keyword scan, not a parser; reads stay reads.
    "INSERT INTO t VALUES ('no where')",
    "CREATE TABLE t (id int)",
    "EXPLAIN SELECT * FROM users",
    "EXPLAIN ANALYZE SELECT * FROM users",
    "-- nothing here",
    "",
  ])("does not flag: %s", (sql) => {
    expect(isHighRiskStatement(sql)).toBe(false);
  });
});

describe("guards cannot be dodged by comments", () => {
  it.each([
    ["/* hide */ DROP TABLE t", true],
    ["-- hide\nDROP TABLE t", true],
    ["-- hide\n/* also */\nINSERT INTO t VALUES (1)", true],
    ["SELECT 1", false],
    ["-- only a comment", false],
  ])("isMutatingStatement(%j) → %s", (sql, expected) => {
    expect(isMutatingStatement(sql)).toBe(expected);
  });

  it.each([
    ["-- c\nUSE otherdb", true],
    ["/* c */ ATTACH 'file.db' AS x", true],
    ["SET search_path TO app", true],
    ["SET ROLE admin", true],
    ["SELECT 1", false],
  ])("isSessionSwitchStatement(%j) → %s", (sql, expected) => {
    expect(isSessionSwitchStatement(sql)).toBe(expected);
  });
});

describe("extractLeadingUseDirective", () => {
  it("splits `USE db;` from the remaining SQL", () => {
    const result = extractLeadingUseDirective("USE appdb; SELECT 1");
    expect(result).toEqual({ database: "appdb", remainingSql: " SELECT 1" });
  });

  it("accepts a newline-terminated directive with more SQL below", () => {
    const result = extractLeadingUseDirective("USE appdb\nSELECT 1");
    expect(result).toEqual({ database: "appdb", remainingSql: "SELECT 1" });
  });

  it.each([
    ['USE "mydb"; SELECT 1', "mydb", " SELECT 1"],
    ["USE [analytics];", "analytics", ""],
    ["USE 'quoted';", "quoted", ""],
  ])("strips identifier quoting: %j", (sql, database, remainingSql) => {
    expect(extractLeadingUseDirective(sql)).toEqual({ database, remainingSql });
  });

  it("skips leading comments before recognizing USE", () => {
    expect(extractLeadingUseDirective("-- pick a db\nUSE appdb;\nSELECT 1")).toEqual({
      database: "appdb",
      remainingSql: "\nSELECT 1",
    });
  });

  it("returns null when no leading USE exists", () => {
    expect(extractLeadingUseDirective("SELECT 1")).toBeNull();
    expect(extractLeadingUseDirective("SELECT 1; USE appdb")).toBeNull();
    expect(extractLeadingUseDirective("-- only comments")).toBeNull();
    expect(extractLeadingUseDirective("user_input")).toBeNull();
  });
  it.each([
    ["USE ;", /empty USE/],
    ["USE db.other;", /only accepts USE <database>/],
    ["USE `two words`;", /could not understand the USE directive/],
  ])("rejects unusable directives with a specific error: %j", (sql, pattern) => {
    const result = extractLeadingUseDirective(sql);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(pattern);
  });
});

describe("formatExecutionError", () => {
  it("strips a leading `Error:` prefix so panes do not show it twice", () => {
    expect(formatExecutionError(new Error("Error: syntax near FROM"))).toBe("syntax near FROM");
    expect(formatExecutionError("Error: timeout")).toBe("timeout");
  });

  it("passes plain errors through unchanged", () => {
    expect(formatExecutionError(new Error("boom"))).toBe("boom");
    expect(formatExecutionError("boom")).toBe("boom");
    expect(formatExecutionError(42)).toBe("42");
  });
});

describe("normalizeInlineSuggestion", () => {
  it("strips markdown fences the model adds despite instructions", () => {
    expect(normalizeInlineSuggestion("```sql\n* FROM users\n```", "SELECT ")).toBe("* FROM users");
    expect(normalizeInlineSuggestion("```\n* FROM users\n```", "SELECT ")).toBe("* FROM users");
  });

  it("removes an echoed typed prefix so text is not duplicated", () => {
    expect(normalizeInlineSuggestion("SELECT * FROM users", "SELECT ")).toBe("* FROM users");
    // Case-insensitive echo match.
    expect(normalizeInlineSuggestion("select * from users", "SELECT ")).toBe("* from users");
  });

  it("leaves a fresh suggestion untouched", () => {
    expect(normalizeInlineSuggestion("  FROM users\n", "SELECT *")).toBe("FROM users");
  });
});

describe("isTrustedInlineCompletionConnection", () => {
  it.each([
    [connection({ db_type: "sqlite" }), true, "sqlite is local"],
    [connection({ host: "127.0.0.1" }), true, "ipv4 loopback"],
    [connection({ host: "localhost" }), true, "localhost"],
    [connection({ host: " LOCALHOST " }), true, "localhost w/ padding"],
    [connection({ host: "::1" }), true, "ipv6 loopback"],
    [connection({ host: "[::1]" }), true, "bracketed ipv6"],
    [connection({ host: "db.example.com" }), false, "remote host"],
    [connection({ host: "10.0.0.5" }), false, "lan host"],
    [connection({}), false, "no host on a server db"],
    [undefined, false, "missing connection"],
  ])("trust check %# → %s (%s)", (conn, expected, _name) => {
    expect(isTrustedInlineCompletionConnection(conn)).toBe(expected);
  });
});
