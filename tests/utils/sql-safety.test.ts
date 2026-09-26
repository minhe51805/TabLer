import { describe, expect, it, vi } from "vitest";

vi.mock("@/utils/tauri-utils", () => ({
  invokeWithTimeout: vi.fn(),
  invokeMutation: vi.fn(),
}));

import {
  explainAnalyzeInnerStatement,
  explainInnerStatement,
  stripLeadingSqlNoise,
} from "@/utils/sql-safety";

/**
 * The normalization helpers in sql-safety.ts are the shared layer the
 * Safe-Mode gate and every FE keyword guard recurse through. The contract:
 * comments/parens/option-words must NOT let a mutating statement disguise
 * itself as a read (or vice versa).
 */

describe("stripLeadingSqlNoise", () => {
  it.each([
    ["-- comment only", ""],
    ["/* block only */", ""],
    ["-- a\n-- b\n", ""],
    ["/* unterminated", ""],
    ["-- trailing comment with no newline", ""],
    ["  \n\t  ", ""],
  ])("comment/whitespace-only input collapses to empty: %j", (input, expected) => {
    expect(stripLeadingSqlNoise(input)).toBe(expected);
  });

  it.each([
    ["-- lead\nDELETE FROM t", "DELETE FROM t"],
    ["/* lead */ DELETE FROM t", "DELETE FROM t"],
    ["-- a\n/* b */\nDELETE FROM t", "DELETE FROM t"],
    ["\n\n\tSELECT 1", "SELECT 1"],
  ])("strips comment prefixes so the real verb is visible: %j", (input, expected) => {
    expect(stripLeadingSqlNoise(input)).toBe(expected);
  });

  it("keeps trailing content untouched", () => {
    expect(stripLeadingSqlNoise("SELECT 1 -- tail")).toBe("SELECT 1 -- tail");
    expect(stripLeadingSqlNoise("SELECT '/* not a comment */'")).toBe(
      "SELECT '/* not a comment */'",
    );
  });
});

describe("explainAnalyzeInnerStatement", () => {
  it.each([
    ["EXPLAIN ANALYZE DELETE FROM t", "DELETE FROM t"],
    ["EXPLAIN ANALYZE SELECT * FROM t", "SELECT * FROM t"],
    ["EXPLAIN (ANALYZE) DROP TABLE t", "DROP TABLE t"],
    ["EXPLAIN (ANALYZE, COSTS) DELETE FROM t", "DELETE FROM t"],
    ["EXPLAIN (COSTS, ANALYZE) DELETE FROM t", "DELETE FROM t"],
    ["EXPLAIN (ANALYZE TRUE) UPDATE t SET x = 1", "UPDATE t SET x = 1"],
    // ANALYZE with no wrapped statement still reports the empty tail as null.
    ["EXPLAIN ANALYZE", null],
    ["EXPLAIN (ANALYZE)", null],
  ])("analyzing forms unwrap the inner statement: %j", (input, expected) => {
    expect(explainAnalyzeInnerStatement(input)).toBe(expected);
  });

  it.each([
    // Explicitly-off ANALYZE is a planning-only EXPLAIN — a read.
    ["EXPLAIN ANALYZE OFF DELETE FROM t"],
    ["EXPLAIN ANALYZE FALSE DELETE FROM t"],
    ["EXPLAIN ANALYZE 0 DELETE FROM t"],
    ["EXPLAIN (ANALYZE OFF) DELETE FROM t"],
    ["EXPLAIN (ANALYZE FALSE) DELETE FROM t"],
    // No ANALYZE at all.
    ["EXPLAIN DELETE FROM t"],
    ["EXPLAIN (COSTS) DELETE FROM t"],
    ["EXPLAIN (VERBOSE, FORMAT JSON) DELETE FROM t"],
    // Not an EXPLAIN at all.
    ["DELETE FROM t"],
    ["EXPLAINABLE THING"],
    // Unterminated option list.
    ["EXPLAIN (ANALYZE DELETE FROM t"],
  ])("non-analyzing or malformed forms return null: %j", (input) => {
    expect(explainAnalyzeInnerStatement(input)).toBeNull();
  });
});

describe("explainInnerStatement", () => {
  it.each([
    ["EXPLAIN SELECT 1", "SELECT 1"],
    ["EXPLAIN DELETE FROM t", "DELETE FROM t"],
    ["EXPLAIN ANALYZE DELETE FROM t", "DELETE FROM t"],
    ["EXPLAIN VERBOSE UPDATE t SET x = 1", "UPDATE t SET x = 1"],
    // Postgres parenthesized option lists.
    ["EXPLAIN (ANALYZE, COSTS) DELETE FROM t", "DELETE FROM t"],
    ["EXPLAIN (FORMAT JSON) SELECT 1", "SELECT 1"],
    // Bare-keyword option runs: FORMAT=, QUERY PLAN, PLAN FOR.
    ["EXPLAIN FORMAT=JSON SELECT 1", "SELECT 1"],
    ["EXPLAIN QUERY PLAN SELECT 1", "SELECT 1"],
    ["EXPLAIN PLAN FOR SELECT 1", "SELECT 1"],
    // ANALYZE OFF is still an EXPLAIN — the inner statement is what follows
    // the OFF option word.
    ["EXPLAIN ANALYZE OFF DELETE FROM t", "DELETE FROM t"],
    // Nested EXPLAINs unwrap one level; the caller recurses.
    ["EXPLAIN EXPLAIN DELETE FROM t", "DELETE FROM t"],
    // Bare EXPLAIN / option-only tails have no wrapped statement.
    ["EXPLAIN", null],
    ["EXPLAIN ANALYZE", null],
    ["EXPLAIN (COSTS)", null],
    ["EXPLAIN FORMAT=JSON", null],
    // Not an EXPLAIN.
    ["DELETE FROM t", null],
    // Unterminated option list cannot be trusted → null.
    ["EXPLAIN (ANALYZE DELETE FROM t", null],
  ])("unwraps the statement an EXPLAIN plans or runs: %j", (input, expected) => {
    expect(explainInnerStatement(input)).toBe(expected);
  });
});
