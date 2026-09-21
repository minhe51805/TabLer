import type { QueryResult } from "../types";

/**
 * Short-lived result cache for read-only queries. A repeat run of the same
 * statement on the same connection+database within the TTL returns instantly
 * (flagged `cached` so the grid status can badge it) instead of round-tripping
 * the backend. Any successful write on a connection invalidates all of its
 * entries — the cache never outlives data it could be stale against.
 */

export const QUERY_RESULT_CACHE_TTL_MS = 30_000;
export const QUERY_RESULT_CACHE_MAX_ENTRIES = 20;

interface CacheEntry {
  result: QueryResult;
  expiresAt: number;
}

// Map iteration order is insertion order; deleting+re-setting on hit gives
// cheap LRU behaviour, and the first key is always the oldest entry.
const cache = new Map<string, CacheEntry>();

/** Collapse whitespace and drop trailing semicolons so cosmetic edits hit. */
export function normalizeSqlForCache(sql: string): string {
  return sql
    .trim()
    .replace(/;+\s*$/, "")
    .trim()
    .replace(/\s+/g, " ");
}

function cacheKey(connectionId: string, sql: string, database: string | null | undefined): string {
  // Unit separators can't appear in SQL, so the key is unambiguous.
  return `${connectionId}\u001f${database ?? ""}\u001f${normalizeSqlForCache(sql)}`;
}

/**
 * Returns a fresh copy of the cached result flagged `cached: true`, or null on
 * a miss/expiry. Rows are deep-copied: callers may mutate the result (grid
 * edits, sorting) and must never corrupt the stored entry.
 */
export function getCachedQueryResult(
  connectionId: string,
  sql: string,
  database?: string | null,
): QueryResult | null {
  const key = cacheKey(connectionId, sql, database);
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, entry);
  return {
    ...entry.result,
    rows: entry.result.rows.map((row) => [...row]),
    cached: true,
  };
}

export function setCachedQueryResult(
  connectionId: string,
  sql: string,
  database: string | null | undefined,
  result: QueryResult,
): void {
  const key = cacheKey(connectionId, sql, database);
  cache.delete(key);
  cache.set(key, {
    result: {
      ...result,
      rows: result.rows.map((row) => [...row]),
      cached: false,
    },
    expiresAt: Date.now() + QUERY_RESULT_CACHE_TTL_MS,
  });
  while (cache.size > QUERY_RESULT_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Drops every cached read for a connection — call after a committed write. */
export function invalidateQueryResultCache(connectionId: string): void {
  const prefix = `${connectionId}\u001f`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

/** Test hook: empties the whole cache. */
export function clearQueryResultCache(): void {
  cache.clear();
}
