import { describe, expect, it } from "vitest";
import { getCellEditorType } from "@/components/DataGrid/editors/cell-editor-registry";
import type { ResolvedColumn } from "@/components/DataGrid/hooks/useDataGrid";

function col(name: string, column_type: string, data_type?: string): ResolvedColumn {
  return {
    name,
    data_type: data_type ?? column_type,
    column_type,
    is_nullable: true,
    is_primary_key: false,
  };
}

const FK = { referenced_table: "teams", referenced_column: "id" };

describe("getCellEditorType routing", () => {
  it.each([
    ["BOOLEAN", undefined, undefined, "boolean"],
    ["BIT", undefined, undefined, "boolean"],
    ["enum('a','b')", undefined, ["a", "b"], "enum"],
    ["enum('a','b')", undefined, undefined, "text"], // no values → no dropdown
    ["set('a','b')", undefined, undefined, "set"],
    ["DATE", undefined, undefined, "date"],
    ["TIMESTAMP", undefined, undefined, "datetime"],
    ["DATETIME", undefined, undefined, "datetime"],
    ["TIME", undefined, undefined, "time"],
    ["JSONB", undefined, undefined, "json"],
    ["json", undefined, undefined, "json"],
    ["BYTEA", undefined, undefined, "hex"],
    ["VARBINARY(32)", undefined, undefined, "hex"],
    ["INT", undefined, undefined, "numeric"],
    ["DECIMAL(10,2)", undefined, undefined, "numeric"],
    ["VARCHAR(50)", undefined, undefined, "text"],
    ["TEXT", undefined, undefined, "text"],
  ])("column type %s → %s", (type, fk, enums, expected) => {
    expect(
      getCellEditorType(
        col("c", type),
        fk as { referenced_table: string; referenced_column: string } | undefined,
        enums as string[] | undefined,
      ),
    ).toBe(expected);
  });

  it("FK lookup beats the underlying column type", () => {
    expect(getCellEditorType(col("team_id", "INT"), FK)).toBe("foreign_key");
    expect(getCellEditorType(col("team_id", "enum('a','b')"), FK, ["a", "b"])).toBe("foreign_key");
  });

  it("boolean detection wins over everything except nothing (checked first)", () => {
    // A FK'd boolean still routes to boolean — precedence order pins this.
    expect(getCellEditorType(col("active", "BOOLEAN"), FK)).toBe("boolean");
  });

  it("routes geometry-family types through the binary path they are stored as", () => {
    // `geometry`/`point` match the blob detector first (they arrive as binary
    // payloads), so the hex editor wins over the geometry editor for types
    // the blob regex also covers; geography gets the geometry editor.
    expect(getCellEditorType(col("shape", "geometry"))).toBe("hex");
    expect(getCellEditorType(col("shape", "geography"))).toBe("geometry");
  });
});
