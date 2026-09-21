import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryResult } from "@/types";
import {
  QUERY_RESULT_CACHE_MAX_ENTRIES,
  QUERY_RESULT_CACHE_TTL_MS,
  clearQueryResultCache,
  getCachedQueryResult,
  invalidateQueryResultCache,
  setCachedQueryResult,
} from "@/utils/query-result-cache";

function result(rows: number): QueryResult {
  return {
    columns: [],
    rows: Array.from({ length: rows }, () => [1]),
    affected_rows: 0,
    execution_time_ms: 5,
    query: "select 1",
    sandboxed: false,
    truncated: false,
  };
}

describe("query-result-cache", () => {
  beforeEach(() => {
    clearQueryResultCache();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a cached-flagged copy within the TTL", () => {
    setCachedQueryResult("c1", "select 1", "db", result(3));
    const hit = getCachedQueryResult("c1", "select 1", "db");
    expect(hit?.cached).toBe(true);
    expect(hit?.rows).toHaveLength(3);
    // Mutating the returned copy must not corrupt the stored entry.
    hit!.rows.length = 0;
    expect(getCachedQueryResult("c1", "select 1", "db")?.rows).toHaveLength(3);
  });

  it("normalizes whitespace and trailing semicolons", () => {
    setCachedQueryResult("c1", "select  1;", "db", result(1));
    expect(getCachedQueryResult("c1", "  select 1  ;;", "db")).not.toBeNull();
  });

  it("keys on connection and database", () => {
    setCachedQueryResult("c1", "select 1", "db", result(1));
    expect(getCachedQueryResult("c2", "select 1", "db")).toBeNull();
    expect(getCachedQueryResult("c1", "select 1", "other")).toBeNull();
    expect(getCachedQueryResult("c1", "select 1", null)).toBeNull();
  });

  it("expires entries after the TTL", () => {
    setCachedQueryResult("c1", "select 1", "db", result(1));
    vi.advanceTimersByTime(QUERY_RESULT_CACHE_TTL_MS + 1);
    expect(getCachedQueryResult("c1", "select 1", "db")).toBeNull();
  });

  it("invalidates all entries for a connection only", () => {
    setCachedQueryResult("c1", "select 1", "db", result(1));
    setCachedQueryResult("c1", "select 2", "db", result(1));
    setCachedQueryResult("c2", "select 1", "db", result(1));
    invalidateQueryResultCache("c1");
    expect(getCachedQueryResult("c1", "select 1", "db")).toBeNull();
    expect(getCachedQueryResult("c1", "select 2", "db")).toBeNull();
    expect(getCachedQueryResult("c2", "select 1", "db")).not.toBeNull();
  });

  it("evicts the oldest entry past the max size", () => {
    for (let i = 0; i < QUERY_RESULT_CACHE_MAX_ENTRIES; i++) {
      setCachedQueryResult("c1", `select ${i}`, "db", result(1));
    }
    setCachedQueryResult("c1", "select overflow", "db", result(1));
    expect(getCachedQueryResult("c1", "select 0", "db")).toBeNull();
    expect(getCachedQueryResult("c1", "select overflow", "db")).not.toBeNull();
  });
});
