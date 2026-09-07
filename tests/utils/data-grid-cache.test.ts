import { describe, expect, it } from "vitest";
import {
  buildTableCacheKey,
  buildTableScopeKey,
  matchesCacheScope,
} from "@/components/DataGrid/hooks/useDataGrid";

describe("DataGrid cache keys", () => {
  it("keeps server-filtered chunks separate from the unfiltered table", () => {
    const unfiltered = buildTableCacheKey("connection", "users", "app", 0, "id", "ASC");
    const filtered = buildTableCacheKey("connection", "users", "app", 0, "id", "ASC", "status = 'active'");

    expect(filtered).not.toBe(unfiltered);
    expect(filtered).toContain("status = 'active'");
  });

  it("separates same-named tables by qualified database object identity", () => {
    const publicUsers = buildTableScopeKey("connection", "public.users", "app");
    const auditUsers = buildTableScopeKey("connection", "audit.users", "app");
    const otherDatabase = buildTableScopeKey("connection", "public.users", "warehouse");

    expect(new Set([publicUsers, auditUsers, otherDatabase]).size).toBe(3);
  });

  it("invalidates page and count keys that share a qualified table identity", () => {
    const pageKey = buildTableCacheKey("connection", "public.users", "app", 2, "id", "DESC");
    const countKey = buildTableScopeKey("connection", "public.users", "app");

    expect(matchesCacheScope(pageKey, "connection", "app", "public.users")).toBe(true);
    expect(matchesCacheScope(countKey, "connection", "app", "public.users")).toBe(true);
    expect(matchesCacheScope(pageKey, "connection", "app", "audit.users")).toBe(false);
    expect(matchesCacheScope(pageKey, "connection", "warehouse", "public.users")).toBe(false);
  });
});
