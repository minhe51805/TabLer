import { describe, expect, it } from "vitest";
import {
  getAISqlConfirmationRequirement,
  shouldAgentAutoRunSql,
} from "@/components/AISlidePanel/ai-execution-policy";

describe("AI SQL execution policy", () => {
  it("controls only whether an agent starts the run automatically", () => {
    expect(shouldAgentAutoRunSql("review", "safe")).toBe(false);
    expect(shouldAgentAutoRunSql("smart", "safe")).toBe(true);
    expect(shouldAgentAutoRunSql("smart", "review")).toBe(false);
    expect(shouldAgentAutoRunSql("smart", "dangerous")).toBe(false);
    expect(shouldAgentAutoRunSql("full", "dangerous")).toBe(true);
  });

  it("allows read-only statements without a mutation confirmation", () => {
    expect(getAISqlConfirmationRequirement([
      "SELECT * FROM users",
      "EXPLAIN SELECT * FROM orders",
    ])).toBeNull();
  });

  it.each([
    "INSERT INTO users(name) VALUES ('Ada')",
    "UPDATE users SET active = 1 WHERE id = 1",
    "DELETE FROM users WHERE id = 1",
    "CREATE TABLE audit_log(id INTEGER)",
    "ALTER TABLE users ADD COLUMN nickname TEXT",
  ])("requires confirmation for AI data or schema mutation: %s", (statement) => {
    expect(getAISqlConfirmationRequirement([statement])).toBe("mutation");
  });

  it.each([
    "DROP TABLE users",
    "TRUNCATE TABLE users",
    "DELETE FROM users",
    "UPDATE users SET active = 0",
  ])("uses the stronger warning for high-risk AI SQL: %s", (statement) => {
    expect(getAISqlConfirmationRequirement([statement])).toBe("high-risk");
  });

  it("uses the strictest requirement across a statement batch", () => {
    expect(getAISqlConfirmationRequirement([
      "SELECT * FROM users",
      "UPDATE users SET active = 1 WHERE id = 1",
      "DROP TABLE legacy_users",
    ])).toBe("high-risk");
  });
});
