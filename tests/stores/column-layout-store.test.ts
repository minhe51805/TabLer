import { beforeEach, describe, expect, it } from "vitest";
import {
  buildColumnLayoutScopeKey,
  clearColumnLayout,
  getColumnLayout,
  resetColumnLayoutCacheForTests,
  saveColumnLayout,
} from "@/stores/column-layout-store";

describe("column layout persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    resetColumnLayoutCacheForTests();
  });

  it("qualifies layouts by connection, database, and table", () => {
    expect(buildColumnLayoutScopeKey("a|b", "c", "d"))
      .not.toBe(buildColumnLayoutScopeKey("a", "b|c", "d"));
  });

  it("round-trips the complete grid layout without sharing mutable references", () => {
    saveColumnLayout("connection", "users", {
      order: ["_row_num", "email", "id"],
      visibility: { audit_note: false },
      pinning: { left: ["_row_num", "id"], right: ["email"] },
      sort: { column: "email", direction: "DESC" },
      filter: "active",
    }, "app");

    const restored = getColumnLayout("connection", "users", "app");
    expect(restored.order).toEqual(["_row_num", "email", "id"]);
    expect(restored.visibility.audit_note).toBe(false);
    expect(restored.pinning.right).toEqual(["email"]);
    expect(restored.sort).toEqual({ column: "email", direction: "DESC" });
    expect(restored.filter).toBe("active");

    restored.order.push("mutated");
    expect(getColumnLayout("connection", "users", "app").order).not.toContain("mutated");
  });

  it("clears only the requested table layout", () => {
    const layout = getColumnLayout("connection", "users", "app");
    saveColumnLayout("connection", "users", { ...layout, filter: "one" }, "app");
    saveColumnLayout("connection", "teams", { ...layout, filter: "two" }, "app");

    clearColumnLayout("connection", "users", "app");
    expect(getColumnLayout("connection", "users", "app").filter).toBe("");
    expect(getColumnLayout("connection", "teams", "app").filter).toBe("two");
  });
});
