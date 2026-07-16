import { describe, expect, it } from "vitest";
import { buildTableCacheKey } from "@/components/DataGrid/hooks/useDataGrid";

describe("DataGrid cache keys", () => {
  it("keeps server-filtered chunks separate from the unfiltered table", () => {
    const unfiltered = buildTableCacheKey("connection", "users", "app", 0, "id", "ASC");
    const filtered = buildTableCacheKey("connection", "users", "app", 0, "id", "ASC", "status = 'active'");

    expect(filtered).not.toBe(unfiltered);
    expect(filtered).toContain("status = 'active'");
  });
});
