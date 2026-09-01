import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  classifySchemaObject,
  systemTypeCategory,
  useSchemaSections,
} from "@/components/Sidebar/hooks/useTreeState";

describe("classifySchemaObject (driver object_type → explorer group)", () => {
  it("classifies MSSQL type_desc values (substring match)", () => {
    // MSSQL sys.objects.type_desc — the values that historically fell into the
    // "Routines" catch-all under the old exact-equality classification.
    expect(classifySchemaObject("SQL_TRIGGER")).toBe("trigger");
    expect(classifySchemaObject("CLR_TRIGGER")).toBe("trigger");
    expect(classifySchemaObject("SQL_STORED_PROCEDURE")).toBe("procedure");
    expect(classifySchemaObject("CLR_STORED_PROCEDURE")).toBe("procedure");
    expect(classifySchemaObject("SQL_SCALAR_FUNCTION")).toBe("scalar-function");
    expect(classifySchemaObject("SQL_INLINE_TABLE_VALUED_FUNCTION")).toBe("table-function");
    expect(classifySchemaObject("SQL_TABLE_VALUED_FUNCTION")).toBe("table-function");
    expect(classifySchemaObject("CLR_TABLE_VALUED_FUNCTION")).toBe("table-function");
    expect(classifySchemaObject("CLR_SCALAR_FUNCTION")).toBe("scalar-function");
    expect(classifySchemaObject("AGGREGATE_FUNCTION")).toBe("aggregate-function");
    expect(classifySchemaObject("VIEW")).toBe("view");
    expect(classifySchemaObject("SYNONYM")).toBe("synonym");
  });

  it("classifies the SSMS-parity labels emitted by the MSSQL driver", () => {
    expect(classifySchemaObject("DATABASE_TRIGGER")).toBe("database-trigger");
    expect(classifySchemaObject("ASSEMBLY")).toBe("assembly");
    expect(classifySchemaObject("RULE")).toBe("rule");
    expect(classifySchemaObject("DEFAULT")).toBe("default");
    expect(classifySchemaObject("XML_SCHEMA_COLLECTION")).toBe("xml-schema");
    expect(classifySchemaObject("USER_DEFINED_TYPE")).toBe("user-type");
    expect(classifySchemaObject("USER_TABLE_TYPE")).toBe("table-type");
    expect(classifySchemaObject("USER_CLR_TYPE")).toBe("clr-type");
    expect(classifySchemaObject("SYSTEM_EXACT_NUMERIC")).toBe("system-type");
    expect(classifySchemaObject("SYSTEM_SPATIAL_DATA_TYPE")).toBe("system-type");
    expect(classifySchemaObject("SYSTEM_OTHER_DATA_TYPE")).toBe("system-type");
  });

  it("maps every SYSTEM_* label to an SSMS System Data Types category", () => {
    expect(systemTypeCategory("SYSTEM_EXACT_NUMERIC")).toBe("exact-numeric");
    expect(systemTypeCategory("SYSTEM_APPROXIMATE_NUMERIC")).toBe("approximate-numeric");
    expect(systemTypeCategory("SYSTEM_DATE_TIME")).toBe("date-time");
    expect(systemTypeCategory("SYSTEM_CHARACTER_STRING")).toBe("character-string");
    expect(systemTypeCategory("SYSTEM_UNICODE_CHARACTER_STRING")).toBe("unicode-character-string");
    expect(systemTypeCategory("SYSTEM_BINARY_STRING")).toBe("binary-string");
    expect(systemTypeCategory("SYSTEM_CLR_DATA_TYPE")).toBe("clr");
    expect(systemTypeCategory("SYSTEM_SPATIAL_DATA_TYPE")).toBe("spatial");
    expect(systemTypeCategory("SYSTEM_OTHER_DATA_TYPE")).toBe("other");
    expect(systemTypeCategory("unknown_label")).toBe("other");
  });

  it("classifies MySQL, SQLite and sequence values", () => {
    expect(classifySchemaObject("PROCEDURE")).toBe("procedure");
    expect(classifySchemaObject("FUNCTION")).toBe("scalar-function");
    expect(classifySchemaObject("TRIGGER")).toBe("trigger");
    expect(classifySchemaObject("VIEW")).toBe("view");
    expect(classifySchemaObject("SEQUENCE")).toBe("sequence");
  });

  it("is case-insensitive, whitespace-tolerant and null-safe", () => {
    expect(classifySchemaObject("sql_trigger")).toBe("trigger");
    expect(classifySchemaObject("  SQL_STORED_PROCEDURE  ")).toBe("procedure");
    expect(classifySchemaObject("")).toBe("routine");
    expect(classifySchemaObject(null)).toBe("routine");
    expect(classifySchemaObject(undefined)).toBe("routine");
    expect(classifySchemaObject("SOMETHING_ELSE")).toBe("routine");
  });
});

describe("useSchemaSections (SSMS system-schema merge)", () => {
  const objects = [
    { name: "taikhoan", schema: "dbo", object_type: "SQL_TRIGGER" },
    { name: "sp_who", schema: "sys", object_type: "SQL_STORED_PROCEDURE" },
    { name: "fn_diag", schema: "sys", object_type: "SQL_SCALAR_FUNCTION" },
    { name: "all_columns", schema: "sys", object_type: "VIEW" },
    { name: "int", schema: "sys", object_type: "SYSTEM_EXACT_NUMERIC" },
    { name: "all_tables", schema: "INFORMATION_SCHEMA", object_type: "VIEW" },
  ];

  it("folds sys/INFORMATION_SCHEMA objects into dbo system buckets when merging", () => {
    const { result } = renderHook(() => useSchemaSections([], objects, new Set(), true));
    // No standalone `sys` / `INFORMATION_SCHEMA` sections remain.
    expect(result.current.map((section) => section.schemaName)).toEqual(["dbo"]);
    const dbo = result.current[0];
    expect(dbo.triggers.map((object) => object.name)).toEqual(["taikhoan"]);
    expect(dbo.systemProcedures.map((object) => object.name)).toEqual(["sp_who"]);
    expect(dbo.systemFunctions.map((object) => object.name)).toEqual(["fn_diag"]);
    // Objects sort by schema first: INFORMATION_SCHEMA < sys.
    expect(dbo.systemViews.map((object) => object.name)).toEqual(["all_tables", "all_columns"]);
    expect(dbo.systemTypes.map((object) => object.name)).toEqual(["int"]);
  });

  it("keeps sys as its own schema section when merging is off (non-MSSQL)", () => {
    const { result } = renderHook(() => useSchemaSections([], objects, new Set(), false));
    expect(result.current.map((section) => section.schemaName)).toEqual([
      "dbo",
      "INFORMATION_SCHEMA",
      "sys",
    ]);
    const sys = result.current.find((section) => section.schemaName === "sys")!;
    expect(sys.procedures.map((object) => object.name)).toEqual(["sp_who"]);
    expect(sys.systemProcedures).toHaveLength(0);
  });
});
