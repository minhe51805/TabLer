import { describe, expect, it } from "vitest";
import {
  analyzeStatement,
  hasNormalizedPlaceholders,
  isPointLookup,
  primaryInsight,
  type StatementStat,
} from "@/utils/profiler-insights";

function stat(overrides: Partial<StatementStat>): StatementStat {
  return {
    queryText: "SELECT * FROM users WHERE id = 42",
    calls: 1,
    meanMs: 1,
    totalMs: 1,
    ...overrides,
  };
}

describe("isPointLookup", () => {
  it("matches equality-filtered SELECTs", () => {
    expect(isPointLookup("SELECT * FROM orders WHERE id = 7")).toBe(true);
    expect(isPointLookup("select name from users where email = $1")).toBe(true);
    expect(isPointLookup("SELECT * FROM t WHERE id IN (1,2,3)")).toBe(true);
  });

  it("rejects non-lookup statements", () => {
    expect(isPointLookup("SELECT count(*) FROM events")).toBe(false);
    expect(isPointLookup("UPDATE users SET last_seen = now() WHERE id = 1")).toBe(false);
    expect(isPointLookup("INSERT INTO logs (msg) VALUES ('x')")).toBe(false);
  });
});

describe("analyzeStatement — N+1 detection", () => {
  it("flags a frequent, cheap point-lookup as N+1", () => {
    const insights = analyzeStatement(stat({ calls: 500, meanMs: 0.8 }));
    expect(insights.map((i) => i.code)).toContain("n-plus-one");
    const nPlusOne = insights.find((i) => i.code === "n-plus-one");
    expect(nPlusOne?.severity).toBe("warn");
    expect(nPlusOne?.message).toContain("500");
  });

  it("does not flag N+1 when the mean time is high", () => {
    const insights = analyzeStatement(stat({ calls: 500, meanMs: 40 }));
    expect(insights.map((i) => i.code)).not.toContain("n-plus-one");
  });

  it("does not flag N+1 when the call count is low", () => {
    const insights = analyzeStatement(stat({ calls: 10, meanMs: 0.5 }));
    expect(insights).toHaveLength(0);
  });

  it("does not flag N+1 for cheap frequent statements that are not lookups", () => {
    const insights = analyzeStatement(
      stat({ queryText: "SELECT now()", calls: 500, meanMs: 0.5 }),
    );
    expect(insights.map((i) => i.code)).not.toContain("n-plus-one");
  });
});

describe("analyzeStatement — chatty and slow", () => {
  it("flags very high call volume that is not a lookup as chatty", () => {
    const insights = analyzeStatement(
      stat({ queryText: "SELECT now()", calls: 5000, meanMs: 0.5 }),
    );
    expect(insights.map((i) => i.code)).toEqual(["chatty"]);
    expect(insights[0].severity).toBe("info");
  });

  it("prefers the N+1 label over chatty when both could apply", () => {
    const insights = analyzeStatement(stat({ calls: 5000, meanMs: 0.5 }));
    const codes = insights.map((i) => i.code);
    expect(codes).toContain("n-plus-one");
    expect(codes).not.toContain("chatty");
  });

  it("flags an individually slow statement", () => {
    const insights = analyzeStatement(
      stat({ queryText: "SELECT count(*) FROM big", calls: 3, meanMs: 2500 }),
    );
    const slow = insights.find((i) => i.code === "slow");
    expect(slow?.severity).toBe("warn");
    expect(slow?.message).toContain("2.50 s");
  });

  it("returns nothing for an unremarkable statement", () => {
    expect(analyzeStatement(stat({ calls: 5, meanMs: 12 }))).toHaveLength(0);
  });
});

describe("primaryInsight", () => {
  it("returns the warning when a warning and info both apply", () => {
    // Slow (warn) + chatty (info) both trigger on this statement.
    const primary = primaryInsight(
      stat({ queryText: "SELECT count(*) FROM big", calls: 5000, meanMs: 2500 }),
    );
    expect(primary?.severity).toBe("warn");
  });

  it("returns null when nothing is noteworthy", () => {
    expect(primaryInsight(stat({ calls: 5, meanMs: 12 }))).toBeNull();
  });
});

describe("hasNormalizedPlaceholders", () => {
  it("detects pg_stat_statements $N placeholders", () => {
    expect(hasNormalizedPlaceholders("SELECT * FROM t WHERE id = $1")).toBe(true);
  });

  it("detects performance_schema ? placeholders", () => {
    expect(hasNormalizedPlaceholders("SELECT * FROM t WHERE id = ?")).toBe(true);
    expect(hasNormalizedPlaceholders("SELECT * FROM t WHERE id IN (?, ?)")).toBe(true);
  });

  it("returns false for a runnable statement with literals", () => {
    expect(hasNormalizedPlaceholders("SELECT * FROM t WHERE id = 42")).toBe(false);
    expect(hasNormalizedPlaceholders("SELECT * FROM t WHERE name = 'a?b'")).toBe(false);
  });
});
