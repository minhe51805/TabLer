import { describe, expect, it } from "vitest";
import { matchesRowInspectorEditScope } from "@/components/DataGrid/row-inspector-utils";

const scope = {
  gridInstanceId: "grid-1",
  connectionId: "conn-1",
  tableName: "users",
  database: "app",
};

describe("matchesRowInspectorEditScope", () => {
  it("accepts only the exact grid, connection, table, and database", () => {
    expect(matchesRowInspectorEditScope(scope, scope)).toBe(true);
    expect(matchesRowInspectorEditScope({ ...scope, gridInstanceId: "grid-2" }, scope)).toBe(false);
    expect(matchesRowInspectorEditScope({ ...scope, connectionId: "conn-2" }, scope)).toBe(false);
    expect(matchesRowInspectorEditScope({ ...scope, tableName: "orders" }, scope)).toBe(false);
    expect(matchesRowInspectorEditScope({ ...scope, database: "analytics" }, scope)).toBe(false);
  });

  it("normalizes an absent database on both sides without accepting a mismatch", () => {
    const withoutDatabase = { ...scope, database: undefined };
    expect(matchesRowInspectorEditScope(withoutDatabase, { ...scope, database: null })).toBe(true);
    expect(matchesRowInspectorEditScope(withoutDatabase, scope)).toBe(false);
  });
});
