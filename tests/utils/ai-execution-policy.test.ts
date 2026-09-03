import { describe, expect, it } from "vitest";
import {
  classifyAgentRun,
  getAISqlConfirmationRequirement,
  isSqlBlockedBySafeMode,
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

  it("flags statements the current Safe Mode level would hard-block", () => {
    // Level 1 = read-only: any write is blocked...
    expect(isSqlBlockedBySafeMode("UPDATE users SET x = 1", 1)).toBe(true);
    expect(isSqlBlockedBySafeMode("SELECT * FROM users", 1)).toBe(false);
    // ...level 2 also allows INSERT...
    expect(isSqlBlockedBySafeMode("INSERT INTO t VALUES (1)", 2)).toBe(false);
    expect(isSqlBlockedBySafeMode("DELETE FROM t", 2)).toBe(true);
    // level 0 disables the guard entirely; empty SQL is trivially unblocked.
    expect(isSqlBlockedBySafeMode("DROP TABLE t", 0)).toBe(false);
    expect(isSqlBlockedBySafeMode("   ", 3)).toBe(false);
    // One blocked statement in a batch is enough.
    expect(isSqlBlockedBySafeMode("SELECT 1; DELETE FROM t", 1)).toBe(true);
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

  it("full autonomy replaces the per-run confirmation with the standing grant", () => {
    expect(getAISqlConfirmationRequirement([
      "UPDATE users SET active = 1 WHERE id = 1",
      "DROP TABLE legacy_users",
    ], "full")).toBeNull();
    // Other autonomy levels keep the dialog.
    expect(getAISqlConfirmationRequirement([
      "UPDATE users SET active = 1 WHERE id = 1",
    ], "review")).toBe("mutation");
    expect(getAISqlConfirmationRequirement([
      "UPDATE users SET active = 1 WHERE id = 1",
    ])).toBe("mutation");
  });
});

describe("classifyAgentRun — single source for the safety nets", () => {
  it("review + high-risk mutation: dialog required, mutation claimed, pre-approved via the dialog", () => {
    // UPDATE without WHERE is high-risk by design (whole-table write).
    const run = classifyAgentRun(["UPDATE users SET x = 1"], "review");
    expect(run.requirement).toBe("high-risk");
    expect(run.needsDialog).toBe(true);
    expect(run.willMutate).toBe(true);
    expect(run.preApproved).toBe(true);
  });

  it("full + regex-read: no dialog, no mutation claim, standing pre-approval", () => {
    const run = classifyAgentRun(["SELECT * FROM users"], "full");
    expect(run.requirement).toBeNull();
    expect(run.needsDialog).toBe(false);
    expect(run.willMutate).toBe(false);
    expect(run.preApproved).toBe(true);
  });

  it("full + UPDATE: willMutate + standing pre-approval without any dialog", () => {
    // P1 regression: full autonomy mutations must still be classified as
    // mutating so the auto-checkpoint / explorer invalidation / rollback
    // hint all fire even though no dialog is shown.
    const run = classifyAgentRun(["UPDATE users SET x = 1"], "full");
    expect(run.requirement).toBeNull();
    expect(run.needsDialog).toBe(false);
    expect(run.willMutate).toBe(true);
    expect(run.preApproved).toBe(true);
  });

  it("smart + read: no dialog, no mutation, no pre-approval", () => {
    const run = classifyAgentRun(["SELECT * FROM users"], "smart");
    expect(run.requirement).toBeNull();
    expect(run.willMutate).toBe(false);
    expect(run.preApproved).toBe(false);
  });
});

describe("shouldAgentAutoRunSql — autonomy × risk matrix", () => {
  const risks = ["safe", "review", "dangerous", undefined] as const;

  it("review never auto-runs", () => {
    for (const risk of risks) expect(shouldAgentAutoRunSql("review", risk)).toBe(false);
  });

  it("full always auto-runs", () => {
    for (const risk of risks) expect(shouldAgentAutoRunSql("full", risk)).toBe(true);
  });

  it("smart auto-runs only safe-classified runs", () => {
    expect(shouldAgentAutoRunSql("smart", "safe")).toBe(true);
    for (const risk of ["review", "dangerous", undefined] as const) {
      expect(shouldAgentAutoRunSql("smart", risk)).toBe(false);
    }
  });
});

describe("isSqlBlockedBySafeMode — level × statement matrix", () => {
  it("level 0 disables the guard entirely", () => {
    for (const sql of [
      "SELECT 1",
      "INSERT INTO t VALUES (1)",
      "UPDATE t SET x = 1",
      "DELETE FROM t",
      "DROP TABLE t",
    ]) {
      expect(isSqlBlockedBySafeMode(sql, 0)).toBe(false);
    }
  });

  it("level 1 read-only: only the SELECT family passes", () => {
    expect(isSqlBlockedBySafeMode("SELECT * FROM t", 1)).toBe(false);
    expect(isSqlBlockedBySafeMode("WITH q AS (SELECT 1) SELECT * FROM q", 1)).toBe(false);
    expect(isSqlBlockedBySafeMode("INSERT INTO t VALUES (1)", 1)).toBe(true);
    expect(isSqlBlockedBySafeMode("UPDATE t SET x = 1", 1)).toBe(true);
    expect(isSqlBlockedBySafeMode("DELETE FROM t", 1)).toBe(true);
    expect(isSqlBlockedBySafeMode("DROP TABLE t", 1)).toBe(true);
  });

  it("level 2 adds INSERT", () => {
    expect(isSqlBlockedBySafeMode("INSERT INTO t VALUES (1)", 2)).toBe(false);
    expect(isSqlBlockedBySafeMode("UPDATE t SET x = 1", 2)).toBe(true);
    expect(isSqlBlockedBySafeMode("DELETE FROM t", 2)).toBe(true);
  });

  it("level 3 blocks DDL but allows DML (RENAME COLUMN exempt)", () => {
    expect(isSqlBlockedBySafeMode("DROP TABLE t", 3)).toBe(true);
    expect(isSqlBlockedBySafeMode("TRUNCATE TABLE t", 3)).toBe(true);
    expect(isSqlBlockedBySafeMode("CREATE TABLE t (id int)", 3)).toBe(true);
    expect(isSqlBlockedBySafeMode("ALTER TABLE t ADD c int", 3)).toBe(true);
    expect(isSqlBlockedBySafeMode("ALTER TABLE t RENAME COLUMN a TO b", 3)).toBe(false);
    expect(isSqlBlockedBySafeMode("UPDATE t SET x = 1", 3)).toBe(false);
  });

  it("levels 4-5 hard-block only the always-blocked set", () => {
    for (const level of [4, 5] as const) {
      expect(isSqlBlockedBySafeMode("DROP TABLE t", level)).toBe(true);
      expect(isSqlBlockedBySafeMode("TRUNCATE TABLE t", level)).toBe(true);
      expect(isSqlBlockedBySafeMode("CREATE TABLE t (id int)", level)).toBe(true);
      expect(isSqlBlockedBySafeMode("UPDATE t SET x = 1", level)).toBe(false);
      expect(isSqlBlockedBySafeMode("DELETE FROM t", level)).toBe(false);
    }
  });
});