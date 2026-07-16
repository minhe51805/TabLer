import { describe, expect, it } from "vitest";
import { fuzzySearch, type SwitcherItem } from "@/stores/quickSwitcherStore";

const items: SwitcherItem[] = [
  { id: "column:orders:customer_id", kind: "column", label: "customer_id", description: "orders - uuid", action: () => {} },
  { id: "object:VIEW:active_orders", kind: "schema-object", label: "active_orders", description: "VIEW", action: () => {} },
  { id: "history:1", kind: "history", label: "select from orders", description: "5 ms", action: () => {} },
];

describe("quick switcher global sources", () => {
  it("finds a column by name and the table that owns it", () => {
    expect(fuzzySearch(items, "customer", []).map((item) => item.id)).toEqual(["column:orders:customer_id"]);
    expect(fuzzySearch(items, "orders", []).map((item) => item.id)).toContain("column:orders:customer_id");
  });

  it("keeps schema objects and query history searchable", () => {
    expect(fuzzySearch(items, "active", [])[0].kind).toBe("schema-object");
    expect(fuzzySearch(items, "select", [])[0].kind).toBe("history");
  });
});
