import { describe, expect, it } from "vitest";
import {
  MEMORY_RECALL_RELEVANCE_THRESHOLD,
  extractRecallTokens,
  rankAgentMemoriesByRelevance,
  scoreMemoryRelevance,
  type AgentMemoryRecallEntry,
} from "@/components/AISlidePanel/ai-agent-memory-recall";

const entry = (name: string, description: string, updatedAt = "2026-01-01T00:00:00Z") =>
  ({ name, description, updatedAt }) satisfies AgentMemoryRecallEntry;

describe("extractRecallTokens", () => {
  it("weights qualified identifiers over snake_case over plain words", () => {
    const tokens = extractRecallTokens("inspect dbo.orders and user_accounts plus something");
    expect(tokens.get("dbo.orders")).toBe(3);
    expect(tokens.get("user_accounts")).toBe(2);
    expect(tokens.get("something")).toBe(1);
    expect(tokens.get("inspect")).toBe(1);
  });

  it("drops stop-words and tokens shorter than 3 chars", () => {
    const tokens = extractRecallTokens("show the table of all my db pk to us");
    expect(tokens.has("show")).toBe(false);
    expect(tokens.has("the")).toBe(false);
    expect(tokens.has("table")).toBe(false);
    expect(tokens.has("of")).toBe(false);
    expect(tokens.has("my")).toBe(false);
    expect(tokens.has("db")).toBe(false);
    expect(tokens.has("pk")).toBe(false);
    expect(tokens.has("to")).toBe(false);
    expect(tokens.has("us")).toBe(false);
  });

  it("is case-insensitive", () => {
    const tokens = extractRecallTokens("OrderDetails");
    expect(tokens.has("orderdetails")).toBe(true);
  });
});

describe("scoreMemoryRelevance", () => {
  it("scores name hits 3x and description hits 2x the prompt weight", () => {
    const tokens = extractRecallTokens("orders"); // orders => weight 1
    const nameHit = scoreMemoryRelevance(entry("orders-notes", "nothing overlapping"), tokens);
    expect(nameHit).toBe(1 * 3);
    const descHit = scoreMemoryRelevance(entry("notes", "facts about orders only"), tokens);
    expect(descHit).toBe(1 * 2);
  });
  it("gives a qualified-identifier prompt token its 3x weight through both fields", () => {
    const tokens = extractRecallTokens("dbo.orders");
    // "dbo.orders" contributes weight 3; its sub-words also land at weight 1,
    // so a name holding the qualified handle scores 3*3 + 1*3 + 1*3.
    expect(scoreMemoryRelevance(entry("dbo.orders", "x"), tokens)).toBe(3 * 3 + 1 * 3 + 1 * 3);
    expect(scoreMemoryRelevance(entry("x", "dbo.orders"), tokens)).toBe(3 * 2 + 1 * 2 + 1 * 2);
  });
  it("returns 0 for an empty prompt token set", () => {
    expect(scoreMemoryRelevance(entry("orders", "orders"), new Map())).toBe(0);
    expect(scoreMemoryRelevance(entry("orders", "orders"), extractRecallTokens(""))).toBe(0);
  });
});

describe("rankAgentMemoriesByRelevance", () => {
  it("orders by descending score and flags the threshold", () => {
    const entries = [
      entry("unrelated", "nothing in common"),
      entry("dbo.orders", "qualified handle"),
      entry("orders-note", "word hit"),
    ];
    const ranked = rankAgentMemoriesByRelevance(entries, "inspect dbo.orders please");
    expect(ranked[0].entry.name).toBe("dbo.orders");
    expect(ranked[0].score).toBe(3 * 3 + 1 * 3 + 1 * 3);
    // The qualified identifier outranks the plain word hit decisively.
    expect(ranked[1].entry.name).toBe("orders-note");
    expect(ranked[1].score).toBe(1 * 3);
    // Threshold: a single plain-word name hit (3) is relevant; a miss is not.
    expect(ranked[1].relevant).toBe(true);
    expect(ranked[2].score).toBe(0);
    expect(ranked[2].relevant).toBe(false);
  });

  it("marks relevant exactly at the threshold, not below", () => {
    const entries = [entry("orders-x", "nothing"), entry("zz-top", "orders appear here")];
    const ranked = rankAgentMemoriesByRelevance(entries, "orders");
    // "orders" in name => 1*3 = 3 = threshold => relevant.
    const nameHit = ranked.find((rank) => rank.entry.name === "orders-x");
    expect(nameHit?.score).toBe(MEMORY_RECALL_RELEVANCE_THRESHOLD);
    expect(nameHit?.relevant).toBe(true);
    // "orders" only in description => 1*2 = 2 < 3 => not relevant.
    const descHit = ranked.find((rank) => rank.entry.name === "zz-top");
    expect(descHit?.score).toBe(2);
    expect(descHit?.relevant).toBe(false);
  });

  it("breaks score ties by freshest updatedAt, then by name", () => {
    const entries = [
      entry("b-orders", "x", "2025-12-01T00:00:00Z"),
      entry("a-orders", "x", "2025-12-01T00:00:00Z"),
      entry("c-orders", "x", "2026-02-01T00:00:00Z"),
    ];
    const ranked = rankAgentMemoriesByRelevance(entries, "orders");
    // All score identically ("orders" appears in every name) => pure tie-break.
    expect(ranked.map((rank) => rank.score)).toEqual([3, 3, 3]);
    expect(ranked[0].entry.name).toBe("c-orders"); // freshest first
    // Same freshness => alphabetical by name.
    expect(ranked[1].entry.name).toBe("a-orders");
    expect(ranked[2].entry.name).toBe("b-orders");
  });

  it("is deterministic: identical inputs yield identical ordering", () => {
    const entries = [
      entry("orders-a", "alpha", "2025-01-02T00:00:00Z"),
      entry("orders-b", "beta", "2025-01-01T00:00:00Z"),
      entry("none", "nothing"),
    ];
    const first = rankAgentMemoriesByRelevance(entries, "orders please");
    const second = rankAgentMemoriesByRelevance(entries, "orders please");
    expect(first.map((rank) => rank.entry.name)).toEqual(second.map((rank) => rank.entry.name));
  });
});
