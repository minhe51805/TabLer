import { describe, expect, it } from "vitest";
import {
  buildSelectSql,
  createEmptyBuilderModel,
  type QueryBuilderModel,
} from "@/utils/query-builder";

function model(overrides: Partial<QueryBuilderModel> = {}): QueryBuilderModel {
  return {
    ...createEmptyBuilderModel(),
    tables: [
      { id: "u", name: "users", alias: "u" },
      { id: "o", name: "orders", alias: "o" },
    ],
    joins: [
      {
        id: "j1",
        kind: "inner",
        leftTableId: "u",
        leftColumn: "id",
        rightTableId: "o",
        rightColumn: "user_id",
      },
    ],
    ...overrides,
  };
}

describe("buildSelectSql", () => {
  it("builds a single-table select with filters and ordering", () => {
    const sql = buildSelectSql(
      model({
        tables: [{ id: "u", name: "users", alias: "u" }],
        joins: [],
        selects: [{ tableId: "u", column: "email" }],
        filters: [{ id: "f1", tableId: "u", column: "status", operator: "=", value: "active" }],
        orders: [{ id: "o1", tableId: "u", column: "created_at", direction: "DESC" }],
        limit: 50,
      }),
      "postgresql",
    );
    expect(sql).toContain('SELECT "u"."email"');
    expect(sql).toContain('FROM "users" AS "u"');
    expect(sql).toContain(`WHERE "u"."status" = 'active'`);
    expect(sql).toContain('ORDER BY "u"."created_at" DESC');
    expect(sql).toContain("LIMIT 50");
    expect(sql.endsWith(";")).toBe(true);
  });

  it("joins tables with dialect-correct quoting", () => {
    const sql = buildSelectSql(model(), "mysql");
    expect(sql).toContain("INNER JOIN `orders` AS `o` ON `u`.`id` = `o`.`user_id`");
  });

  it("supports left joins, distinct, and IN lists", () => {
    const sql = buildSelectSql(
      model({
        distinct: true,
        selects: [{ tableId: "u", column: "email" }, { tableId: "o", column: "total" }],
        joins: [
          {
            id: "j1",
            kind: "left",
            leftTableId: "u",
            leftColumn: "id",
            rightTableId: "o",
            rightColumn: "user_id",
          },
        ],
        filters: [
          { id: "f1", tableId: "o", column: "status", operator: "IN", value: "open, held" },
          { id: "f2", tableId: "o", column: "shipped_at", operator: "IS NULL", value: "" },
        ],
      }),
      "postgresql",
    );
    expect(sql).toContain("SELECT DISTINCT");
    expect(sql).toContain('LEFT JOIN "orders" AS "o" ON "u"."id" = "o"."user_id"');
    expect(sql).toContain(`IN ('open', 'held')`);
    expect(sql).toContain(`"o"."shipped_at" IS NULL`);
  });

  it("escapes single quotes in filter values", () => {
    const sql = buildSelectSql(
      model({
        tables: [{ id: "u", name: "users", alias: "u" }],
        joins: [],
        filters: [{ id: "f1", tableId: "u", column: "name", operator: "=", value: "O'Brien" }],
      }),
      "postgresql",
    );
    expect(sql).toContain(`'O''Brien'`);
  });

  it("throws when no table has been added yet", () => {
    expect(() => buildSelectSql(createEmptyBuilderModel(), "postgresql")).toThrow(/at least one table/i);
  });
});
