import { describe, expect, it } from "vitest";
import { isProgressiveEligible } from "../../src/stores/queryStore";

describe("isProgressiveEligible (Phase 3B progressive delivery gating)", () => {
  it("routes single read-only row-returning statements to the progressive channel", () => {
    expect(isProgressiveEligible("SELECT * FROM users")).toBe(true);
    expect(isProgressiveEligible("  select id, name from orders ; ")).toBe(true);
    expect(isProgressiveEligible("WITH recent AS (SELECT 1) SELECT * FROM recent")).toBe(true);
    expect(isProgressiveEligible("TABLE users")).toBe(true);
    expect(isProgressiveEligible("VALUES (1), (2)")).toBe(true);
  });

  it("keeps non-SELECT statements on the legacy path", () => {
    expect(isProgressiveEligible("UPDATE users SET name = 'x'")).toBe(false);
    expect(isProgressiveEligible("INSERT INTO t VALUES (1)")).toBe(false);
    expect(isProgressiveEligible("DELETE FROM t")).toBe(false);
    expect(isProgressiveEligible("CREATE TABLE t (id int)")).toBe(false);
    expect(isProgressiveEligible("EXPLAIN SELECT 1")).toBe(false);
  });

  it("rejects multi-statement strings and empty input", () => {
    expect(isProgressiveEligible("SELECT 1; SELECT 2")).toBe(false);
    expect(isProgressiveEligible("SELECT 1;")).toBe(true); // trailing semicolon is fine
    expect(isProgressiveEligible("")).toBe(false);
    expect(isProgressiveEligible("   ")).toBe(false);
  });
});
