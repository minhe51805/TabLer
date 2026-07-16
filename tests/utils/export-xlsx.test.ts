import { describe, expect, it } from "vitest";

import { buildExcelSheetData, toExcelCell } from "@/utils/export-xlsx";

describe("XLSX export conversion", () => {
  it("keeps supported database values typed", () => {
    expect(toExcelCell(42, "integer")).toMatchObject({ type: Number, value: 42 });
    expect(toExcelCell("12.5", "numeric")).toMatchObject({ type: Number, value: 12.5 });
    expect(toExcelCell(true, "boolean")).toMatchObject({ type: Boolean, value: true });
    expect(toExcelCell(null, "text")).toBeNull();
  });

  it("uses a plain string when a typed value is invalid", () => {
    expect(toExcelCell("not-a-number", "numeric")).toMatchObject({
      type: String,
      value: "not-a-number",
    });
    expect(toExcelCell("not-a-date", "timestamp")).toMatchObject({
      type: String,
      value: "not-a-date",
    });
  });

  it("redacts binary values and preserves formula-looking strings as text", () => {
    expect(toExcelCell("raw bytes", "bytea")).toMatchObject({
      type: String,
      value: "[BLOB]",
    });
    expect(toExcelCell("=HYPERLINK(\"https://example.com\")", "text")).toMatchObject({
      type: String,
      value: "=HYPERLINK(\"https://example.com\")",
    });
  });

  it("builds a styled header and rows in column order", () => {
    const data = buildExcelSheetData({
      name: "users",
      columns: [
        { name: "id", data_type: "integer" },
        { name: "name", data_type: "text" },
      ],
      rows: [[1, "Ada"]],
    });

    expect(data).toHaveLength(2);
    expect(data[0]?.[0]).toMatchObject({ value: "id", fontWeight: "bold" });
    expect(data[1]?.[0]).toMatchObject({ type: Number, value: 1 });
    expect(data[1]?.[1]).toMatchObject({ type: String, value: "Ada" });
  });
});
