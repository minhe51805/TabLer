import { describe, expect, it } from "vitest";
import {
  buildJoinConditionSuggestions,
  normalizeTableKey,
} from "@/components/SQLEditor/sql-join-suggestions";
import type { ForeignKeyInfo } from "@/types";
import type { SQLTableScope } from "@/components/SQLEditor/SQLContextAnalyzer";

const scope = (table: string, alias = table): SQLTableScope => ({ table, alias, kind: "table" });

const fk = (
  name: string,
  column: string,
  referencedTable: string,
  referencedColumn: string,
): ForeignKeyInfo => ({
  name,
  column,
  referenced_table: referencedTable,
  referenced_column: referencedColumn,
});

describe("normalizeTableKey", () => {
  it.each([
    ["orders", "orders"],
    ["public.orders", "orders"],
    ["[Orders]", "orders"],
    ["`Orders`", "orders"],
    ['"Orders"', "orders"],
    ["dbo.[Order Details]", "order details"],
    ["mydb.public.ORDERS", "orders"],
  ])("normalizes %j → %j", (input, expected) => {
    expect(normalizeTableKey(input)).toBe(expected);
  });
});

describe("buildJoinConditionSuggestions", () => {
  it("emits both operand orders for a simple FK", () => {
    const suggestions = buildJoinConditionSuggestions(
      [scope("customers", "c"), scope("orders", "o")],
      new Map([["orders", [fk("fk_c", "customer_id", "customers", "id")]]]),
    );
    const texts = suggestions.map((s) => s.insertText);
    expect(texts).toContain("o.customer_id = c.id");
    expect(texts).toContain("c.id = o.customer_id");
    expect(suggestions.every((s) => s.sortText.startsWith("0"))).toBe(true);
    expect(suggestions.find((s) => s.insertText === "o.customer_id = c.id")?.detail).toBe(
      "FK: orders.customer_id → customers.id",
    );
  });

  it("regroups composite FK rows sharing a constraint name into one AND-joined condition", () => {
    const suggestions = buildJoinConditionSuggestions(
      [scope("order_items", "oi"), scope("shipments", "s")],
      new Map([
        [
          "order_items",
          [
            fk("fk_shipment", "shipment_a", "shipments", "key_a"),
            fk("fk_shipment", "shipment_b", "shipments", "key_b"),
          ],
        ],
      ]),
    );
    const texts = suggestions.map((s) => s.insertText);
    expect(texts).toContain("oi.shipment_a = s.key_a AND oi.shipment_b = s.key_b");
    expect(texts).toContain("s.key_a = oi.shipment_a AND s.key_b = oi.shipment_b");
    // Two FK rows must NOT produce four separate single-column suggestions.
    expect(texts).not.toContain("oi.shipment_a = s.key_a");
    expect(suggestions).toHaveLength(2);
  });

  it("separate constraints on the same target keep separate suggestions", () => {
    const suggestions = buildJoinConditionSuggestions(
      [scope("orders", "o"), scope("customers", "c")],
      new Map([
        [
          "orders",
          [
            fk("fk_billing", "billing_id", "customers", "id"),
            fk("fk_shipping", "shipping_id", "customers", "id"),
          ],
        ],
      ]),
    );
    const texts = suggestions.map((s) => s.insertText);
    expect(texts).toContain("o.billing_id = c.id");
    expect(texts).toContain("o.shipping_id = c.id");
  });

  it("schema-qualified and quoted scope names still match unqualified FK metadata", () => {
    const suggestions = buildJoinConditionSuggestions(
      [scope("public.customers", "c"), scope("[dbo].[orders]", "o")],
      new Map([["orders", [fk("fk_c", "customer_id", "customers", "id")]]]),
    );
    expect(suggestions.map((s) => s.insertText)).toContain("o.customer_id = c.id");
  });

  it("FK rows for a table not in scope produce nothing", () => {
    const suggestions = buildJoinConditionSuggestions(
      [scope("orders", "o")],
      new Map([["orders", [fk("fk_c", "customer_id", "customers", "id")]]]),
    );
    expect(suggestions).toEqual([]);
  });

  it("a self-referencing FK is not suggested when the table has no second scope entry", () => {
    const suggestions = buildJoinConditionSuggestions(
      [scope("employees", "e")],
      new Map([["employees", [fk("fk_mgr", "manager_id", "employees", "id")]]]),
    );
    expect(suggestions).toEqual([]);
  });

  it("identical FK metadata on both scope tables dedupes to one suggestion pair", () => {
    const fks = [fk("fk_c", "customer_id", "customers", "id")];
    const suggestions = buildJoinConditionSuggestions(
      [scope("customers", "c"), scope("orders", "o"), scope("orders_dup", "o")],
      new Map([
        ["orders", fks],
        ["orders_dup", fks],
      ]),
    );
    // orders_dup normalizes differently (its own key) — only `orders` matches
    // the metadata, so dedup must come from the `seen` set, not scope shape.
    const texts = suggestions.map((s) => s.insertText);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it("non-table scopes (CTEs) never produce join suggestions", () => {
    const suggestions = buildJoinConditionSuggestions(
      [{ table: "recent", alias: "r", kind: "cte" }, scope("orders", "o")],
      new Map([["orders", [fk("fk_c", "recent_id", "recent", "id")]]]),
    );
    expect(suggestions).toEqual([]);
  });
});
