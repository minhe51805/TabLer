import { describe, expect, it } from "vitest";
import { buildERDiagramSqlExport } from "@/components/ERDiagram/erd-sql-export";

describe("ER diagram SQL export", () => {
  it("exports custom relationships as review-only foreign-key DDL", () => {
    const sql = buildERDiagramSqlExport("postgresql", [
      {
        id: "custom",
        fromTable: "orders",
        fromColumn: "customer_id",
        toTable: "customers",
        toColumn: "id",
        isCustom: true,
      },
      {
        id: "existing",
        fromTable: "orders",
        fromColumn: "owner_id",
        toTable: "users",
        toColumn: "id",
      },
    ]);

    expect(sql).toContain("Review this migration");
    expect(sql).toContain(
      'ALTER TABLE "orders" ADD CONSTRAINT "fk_orders_customer_id_customers_id" FOREIGN KEY ("customer_id") REFERENCES "customers" ("id");',
    );
    expect(sql).toContain("Existing relationship retained");
  });

  it("quotes qualified MySQL identifiers before building review SQL", () => {
    const sql = buildERDiagramSqlExport(
      "mysql",
      [
        {
          id: "custom",
          fromTable: "order items",
          fromColumn: "customer id",
          toTable: "customers",
          toColumn: "id",
          isCustom: true,
        },
      ],
      "workspace",
    );

    expect(sql).toContain("ALTER TABLE `workspace`.`order items`");
    expect(sql).toContain(
      "FOREIGN KEY (`customer id`) REFERENCES `workspace`.`customers` (`id`)",
    );
  });
});
