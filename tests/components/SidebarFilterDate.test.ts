import { describe, it, expect } from "vitest";
import { applyCondition, applyConditionsWith } from "../../src/components/Sidebar/hooks/sidebar-filter-scripts";

describe("create_date filtering", () => {
  const cond = (operator: string, value: string, column = "create_date") => ({
    id: "c1",
    column,
    operator: operator as Parameters<typeof applyCondition>[1]["operator"],
    value,
  });

  it("equals/not_equals match ISO dates exactly", () => {
    expect(applyCondition("2022-10-08", cond("equals", "2022-10-08"))).toBe(true);
    expect(applyCondition("2022-10-08", cond("not_equals", "2022-10-08"))).toBe(false);
  });

  it("greater_than / less_than act as After / Before on ISO dates", () => {
    expect(applyCondition("2025-01-01", cond("greater_than", "2024-01-01"))).toBe(true);
    expect(applyCondition("2023-05-01", cond("less_than", "2024-01-01"))).toBe(true);
    expect(applyCondition("2023-05-01", cond("greater_than", "2024-01-01"))).toBe(false);
  });

  it("contains matches partial dates", () => {
    expect(applyCondition("2022-10-08", cond("contains", "2022-10"))).toBe(true);
  });

  it("is_empty / is_not_empty work for objects without create_date", () => {
    expect(applyCondition("", cond("is_empty", ""))).toBe(true);
    expect(applyCondition("", cond("is_not_empty", ""))).toBe(false);
  });

  it("skips conditions with an empty value (untouched grid row)", () => {
    const rows = [{ create_date: "" }, { create_date: "2022-10-08" }];
    const untouched = [cond("equals", "")]; // user changed operator but picked no date
    expect(
      rows.filter((r) => applyConditionsWith(() => r.create_date ?? "", untouched, "AND")).length,
    ).toBe(2);
  });

  it("AND combines date + name conditions like the real hook", () => {
    const conds = [cond("greater_than", "2020-01-01"), cond("contains", "spt", "")];
    const row = { name: "dbo.spt_monitor", create_date: "2022-10-08" };
    const result = applyConditionsWith(
      (c) => (c.column === "create_date" ? row.create_date : row.name),
      conds,
      "AND",
    );
    expect(result).toBe(true);
    const row2 = { name: "dbo.other", create_date: "2022-10-08" };
    expect(
      applyConditionsWith(
        (c) => (c.column === "create_date" ? row2.create_date : row2.name),
        conds,
        "AND",
      ),
    ).toBe(false);
  });
});
