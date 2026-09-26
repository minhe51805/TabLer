import { describe, expect, it } from "vitest";
import {
  computeColumnPlan,
  computeNewRowPlan,
} from "@/components/DataGrid/hooks/useInsertColumnPlan";
import type { ColumnDetail } from "@/types/database";

function col(name: string, overrides: Partial<ColumnDetail> = {}): ColumnDetail {
  return {
    name,
    data_type: "TEXT",
    is_nullable: true,
    is_primary_key: false,
    ...overrides,
  };
}

function baseValue(plan: { baseValues: [string, unknown][] }, name: string) {
  return plan.baseValues.find(([key]) => key === name)?.[1];
}

describe("computeColumnPlan — new row", () => {
  it("skips auto-generated PKs entirely (serial / auto_increment / identity)", () => {
    const plan = computeNewRowPlan([
      col("id", { data_type: "serial", is_nullable: false, is_primary_key: true }),
      col("seq", {
        data_type: "INT",
        is_nullable: false,
        is_primary_key: true,
        extra: "auto_increment",
      }),
      col("name", { is_nullable: false }),
    ]);
    expect(plan.promptColumns.map((c) => c.name)).toEqual(["name"]);
    expect(plan.baseValues.map(([k]) => k)).toEqual(["name"]);
    // Nothing may be staged for the auto PKs — the DB fills them.
    expect(plan.baseValues.some(([k]) => k === "id" || k === "seq")).toBe(false);
  });

  it("skips columns with a DB-side default, including generated-value defaults", () => {
    const plan = computeNewRowPlan([
      col("created", { default_value: "now()", is_nullable: false }),
      col("uid", {
        data_type: "UUID",
        is_nullable: false,
        is_primary_key: true,
        default_value: "gen_random_uuid()",
      }),
    ]);
    expect(plan.promptColumns).toEqual([]);
    expect(plan.baseValues).toEqual([]);
  });

  it("prompts for a plain PK with no default and no generator", () => {
    const plan = computeNewRowPlan([
      col("code", { data_type: "INT", is_nullable: false, is_primary_key: true }),
    ]);
    expect(plan.promptColumns.map((c) => c.name)).toEqual(["code"]);
    expect(baseValue(plan, "code")).toBeNull();
  });

  it("generates a UUID value for a UUID PK that has no DB default", () => {
    const plan = computeNewRowPlan([
      col("id", { data_type: "uuid", is_nullable: false, is_primary_key: true }),
    ]);
    expect(plan.promptColumns).toEqual([]);
    const value = baseValue(plan, "id");
    expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("prompts only for non-nullable columns without defaults; nullable ones pre-fill null", () => {
    const plan = computeNewRowPlan([
      col("required_col", { is_nullable: false }),
      col("optional_col", { is_nullable: true }),
    ]);
    expect(plan.promptColumns.map((c) => c.name)).toEqual(["required_col"]);
    expect(baseValue(plan, "required_col")).toBeNull();
    expect(baseValue(plan, "optional_col")).toBeNull();
  });
});

describe("computeColumnPlan — duplicate row", () => {
  const structure = [
    col("id", { data_type: "INT", is_nullable: false, is_primary_key: true }),
    col("name", { data_type: "TEXT", is_nullable: false }),
    col("note", { data_type: "TEXT", is_nullable: true }),
    col("version", { data_type: "INT", is_nullable: false, default_value: "1" }),
  ];
  const source = [42, "alice", null, 3];

  it("pre-fills source values and prompts for the PK the DB can't auto-fill", () => {
    const plan = computeColumnPlan(structure, source);
    expect(plan.promptColumns.map((c) => c.name)).toEqual(["id"]);
    // The prompt seeds from the source row so the user sees what conflicts.
    expect(baseValue(plan, "id")).toBe(42);
    expect(baseValue(plan, "name")).toBe("alice");
    expect(baseValue(plan, "note")).toBeNull();
    // DB-defaulted column contributes nothing.
    expect(plan.baseValues.some(([k]) => k === "version")).toBe(false);
  });

  it("prompts when a non-nullable source cell is empty/null", () => {
    const plan = computeColumnPlan(structure, [42, null, null, 3]);
    expect(plan.promptColumns.map((c) => c.name)).toEqual(["id", "name"]);
    expect(baseValue(plan, "name")).toBeNull();
  });
});
