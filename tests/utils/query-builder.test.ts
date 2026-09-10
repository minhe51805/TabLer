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

describe("buildSelectSql — aggregate mode (Phase 3)", () => {
  const aggregateModel = {
    ...createEmptyBuilderModel(),
    tables: [
      { id: "u", name: "users", alias: "u" },
      { id: "o", name: "orders", alias: "o" },
    ],
    joins: [
      { id: "j1", kind: "inner" as const, leftTableId: "u", leftColumn: "id", rightTableId: "o", rightColumn: "user_id" },
    ],
    groupBy: [{ tableId: "u", column: "status" }],
    aggregates: [
      { id: "a1", fn: "COUNT" as const, tableId: "o", column: "*", alias: "order_count" },
      { id: "a2", fn: "SUM" as const, tableId: "o", column: "total", alias: "revenue" },
    ],
    having: [{ id: "h1", aggregateId: "a2", operator: ">" as const, value: "100.5" }],
  };

  it("emits GROUP BY with aliased aggregates and numeric HAVING", () => {
    const sql = buildSelectSql(aggregateModel, "postgresql");
    expect(sql).toContain('SELECT "u"."status", COUNT(*) AS "order_count", SUM("o"."total") AS "revenue"');
    expect(sql).toContain('GROUP BY "u"."status"');
    expect(sql).toContain('HAVING SUM("o"."total") > 100.5');
  });

  it("supports COUNT(DISTINCT col)", () => {
    const sql = buildSelectSql(
      {
        ...aggregateModel,
        groupBy: [],
        aggregates: [{ id: "a1", fn: "COUNT_DISTINCT", tableId: "o", column: "user_id" }],
        having: [],
      },
      "postgresql",
    );
    expect(sql).toContain("COUNT(DISTINCT \"o\".\"user_id\")");
  });

  it("rejects HAVING with non-numeric values and unknown aggregates", () => {
    expect(() =>
      buildSelectSql(
        { ...aggregateModel, having: [{ id: "h1", aggregateId: "a2", operator: ">", value: "lots" }] },
        "postgresql",
      ),
    ).toThrow(/numeric/);
    expect(() =>
      buildSelectSql(
        { ...aggregateModel, having: [{ id: "h9", aggregateId: "missing", operator: ">", value: "1" }] },
        "postgresql",
      ),
    ).toThrow(/unknown aggregate/i);
  });

  it("rejects * outside COUNT and aggregates on unknown tables", () => {
    expect(() =>
      buildSelectSql(
        { ...aggregateModel, aggregates: [{ id: "a1", fn: "SUM", tableId: "o", column: "*" }], having: [] },
        "postgresql",
      ),
    ).toThrow(/only valid with COUNT/i);
    expect(() =>
      buildSelectSql(
        { ...aggregateModel, aggregates: [{ id: "a1", fn: "SUM", tableId: "ghost", column: "x" }], having: [] },
        "postgresql",
      ),
    ).toThrow(/unknown table/i);
  });
});
