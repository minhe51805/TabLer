import { describe, expect, it } from "vitest";
import { buildSchemaMigrationReview, diffTableStructure } from "@/utils/schema-diff";

const base = {
  columns: [
    { name: "id", data_type: "integer", is_nullable: false, is_primary_key: true },
    { name: "email", data_type: "text", is_nullable: false, is_primary_key: false },
    { name: "legacy_code", data_type: "text", is_nullable: true, is_primary_key: false },
  ],
  indexes: [], foreign_keys: [], triggers: [],
};

describe("schema diff", () => {
  it("reports additions, reviewed alterations, and destructive removals", () => {
    const next = {
      ...base,
      columns: [
        base.columns[0],
        { ...base.columns[1], data_type: "varchar(320)", default_value: "'unknown'" },
        { name: "created_at", data_type: "timestamp", is_nullable: false, is_primary_key: false },
      ],
    };
    const diff = diffTableStructure("users", base, next);
    const review = buildSchemaMigrationReview("postgresql", diff, "app");

    expect(diff.addedColumns.map((column) => column.name)).toEqual(["created_at"]);
    expect(diff.droppedColumns.map((column) => column.name)).toEqual(["legacy_code"]);
    expect(diff.changedColumns[0].fields).toEqual(["type", "default"]);
    expect(review.destructive).toBe(true);
    expect(review.statements).toEqual(expect.arrayContaining([
      'ALTER TABLE "users" ADD COLUMN "created_at" timestamp NOT NULL',
      'ALTER TABLE "users" DROP COLUMN "legacy_code"',
      'ALTER TABLE "users" ALTER COLUMN "email" TYPE varchar(320)',
    ]));
  });

  it("never generates automatic SQLite rebuild SQL for a changed column", () => {
    const diff = diffTableStructure("users", base, { ...base, columns: [{ ...base.columns[0], data_type: "bigint" }] });
    const review = buildSchemaMigrationReview("sqlite", diff);

    expect(review.statements).toEqual([]);
    expect(review.warnings.join(" ")).toContain("requires a table rebuild");
  });
});
