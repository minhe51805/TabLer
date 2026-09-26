import { describe, expect, it } from "vitest";

import { normalizedStatementIsDisguisedWrite } from "@/utils/sqlStatements";
import {
  classifyStatement,
  isBlockedAtLevel,
  requiresConfirmationAtLevel,
} from "@/types/safe-mode";

// `normalizedStatementIsDisguisedWrite` operates on ALREADY-normalized text
// (uppercased, whitespace-collapsed, comments stripped). The integration tests
// below exercise the same disguised-write contract through the raw-SQL entry
// points (`isBlockedAtLevel`, `classifyStatement`, `requiresConfirmationAtLevel`)
// where comment-stripping and normalization happen — that composition is what
// actually gates .sql imports, metrics queries, and inline completions.
const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim().toUpperCase();

describe("normalizedStatementIsDisguisedWrite", () => {
  it("flags data-modifying CTEs that start with WITH", () => {
    expect(
      normalizedStatementIsDisguisedWrite(normalize("with d as (delete from t) select * from d")),
    ).toBe(true);
    expect(
      normalizedStatementIsDisguisedWrite(
        normalize("WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x"),
      ),
    ).toBe(true);
    expect(
      normalizedStatementIsDisguisedWrite(normalize("WITH u AS (SELECT 1) UPDATE t SET a = 1")),
    ).toBe(true);
    expect(
      normalizedStatementIsDisguisedWrite(
        normalize(
          "WITH m AS (SELECT 1) MERGE INTO t USING m ON t.id = m.id WHEN MATCHED THEN UPDATE SET a = 1",
        ),
      ),
    ).toBe(true);
  });

  it("does not flag read-only WITH selects", () => {
    expect(
      normalizedStatementIsDisguisedWrite(
        normalize("WITH cte AS (SELECT id FROM users) SELECT * FROM cte"),
      ),
    ).toBe(false);
  });

  it("flags SELECT INTO as a write but not ordinary reads", () => {
    expect(normalizedStatementIsDisguisedWrite(normalize("SELECT * INTO backup FROM users"))).toBe(
      true,
    );
    expect(
      normalizedStatementIsDisguisedWrite(normalize("SELECT id, name FROM users WHERE active")),
    ).toBe(false);
  });

  it("flags PRAGMA assignment and writable pragma calls, keeps the read-only allowlist", () => {
    expect(normalizedStatementIsDisguisedWrite(normalize("PRAGMA user_version = 2"))).toBe(true);
    expect(normalizedStatementIsDisguisedWrite(normalize("PRAGMA writable_schema = 1"))).toBe(true);
    // Call form of a pragma NOT in the read-only allowlist mutates.
    expect(normalizedStatementIsDisguisedWrite(normalize("PRAGMA wal_checkpoint(TRUNCATE)"))).toBe(
      true,
    );
    // Schema-qualified call form is still recognized.
    expect(
      normalizedStatementIsDisguisedWrite(normalize("PRAGMA main.wal_checkpoint(TRUNCATE)")),
    ).toBe(true);
    // Read-only pragma functions stay reads.
    expect(normalizedStatementIsDisguisedWrite(normalize("PRAGMA table_info(users)"))).toBe(false);
    expect(normalizedStatementIsDisguisedWrite(normalize("PRAGMA integrity_check(1)"))).toBe(false);
    // Bare read-only pragma without parentheses or assignment.
    expect(normalizedStatementIsDisguisedWrite(normalize("PRAGMA table_list"))).toBe(false);
  });

  it("returns false for empty input", () => {
    expect(normalizedStatementIsDisguisedWrite("")).toBe(false);
  });
});

describe("disguised writes through the Safe-Mode gate", () => {
  it("a comment prefix cannot smuggle a write past level 1", () => {
    expect(isBlockedAtLevel(1, "-- run migrations\nDELETE FROM users")).toBe(true);
    expect(isBlockedAtLevel(1, "/* noop */ UPDATE t SET a = 1")).toBe(true);
    expect(isBlockedAtLevel(1, "-- just a note\nSELECT 1")).toBe(false);
    expect(isBlockedAtLevel(1, "-- comment\nWITH x AS (SELECT 1) DELETE FROM t")).toBe(true);
  });

  it("EXPLAIN ANALYZE <write> is blocked at level 1 as the wrapped write", () => {
    expect(isBlockedAtLevel(1, "EXPLAIN ANALYZE DELETE FROM t")).toBe(true);
    expect(isBlockedAtLevel(1, "EXPLAIN (ANALYZE, COSTS) UPDATE t SET a = 1")).toBe(true);
    // Planning-only EXPLAIN of a read stays a read.
    expect(isBlockedAtLevel(1, "EXPLAIN SELECT * FROM t")).toBe(false);
    // ANALYZE OFF is a plain EXPLAIN — a read.
    expect(isBlockedAtLevel(1, "EXPLAIN (ANALYZE OFF) SELECT * FROM t")).toBe(false);
  });

  it("classifyStatement reports disguised writes as ddl, not read", () => {
    expect(classifyStatement("SELECT * INTO backup FROM users")).toBe("ddl");
    expect(classifyStatement("WITH d AS (DELETE FROM t) SELECT * FROM d")).toBe("ddl");
    expect(classifyStatement("EXPLAIN ANALYZE DELETE FROM t")).toBe("ddl");
    expect(classifyStatement("PRAGMA user_version = 2")).toBe("ddl");
    expect(classifyStatement("SELECT * INTO_VARIATIONS")).toBe("read");
  });

  it("disguised writes still demand confirmation at level 3", () => {
    expect(requiresConfirmationAtLevel(3, "SELECT * INTO backup FROM users")).toBe(true);
    expect(requiresConfirmationAtLevel(3, "WITH d AS (DELETE FROM t) SELECT * FROM d")).toBe(true);
    expect(requiresConfirmationAtLevel(3, "EXPLAIN ANALYZE DELETE FROM t")).toBe(true);
    expect(requiresConfirmationAtLevel(3, "SELECT * FROM users")).toBe(false);
  });
});
