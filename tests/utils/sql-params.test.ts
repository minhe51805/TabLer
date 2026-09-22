import { describe, expect, it } from "vitest";
import { extractParams, ParamError, substituteParams } from "@/utils/sql-params";

describe("extractParams", () => {
  it("returns an empty list for plain SQL", () => {
    expect(extractParams("SELECT * FROM users")).toEqual([]);
  });

  it("parses a bare param", () => {
    expect(extractParams("WHERE id = {{user_id}}")).toEqual([
      { name: "user_id", type: "string", default: undefined, occurrences: 1 },
    ]);
  });

  it("parses a quoted default as its literal value", () => {
    const [param] = extractParams("WHERE status = {{status='paid'}}");
    expect(param).toMatchObject({ name: "status", type: "string", default: "paid" });
  });

  it("parses a bare default", () => {
    const [param] = extractParams("WHERE status = {{status=paid}}");
    expect(param.default).toBe("paid");
  });

  it("parses a type hint before the default", () => {
    const [param] = extractParams("WHERE n > {{limit:int=100}}");
    expect(param).toMatchObject({ name: "limit", type: "int", default: "100" });
  });

  it("keeps a colon inside a default value", () => {
    const [param] = extractParams("WHERE label = {{label=foo:bar}}");
    expect(param.default).toBe("foo:bar");
  });

  it("dedupes repeated params and counts occurrences", () => {
    const params = extractParams("WHERE a = {{x}} OR b = {{x}} OR c = {{y:int}}");
    expect(params.map((p) => p.name)).toEqual(["x", "y"]);
    expect(params[0].occurrences).toBe(2);
    expect(params[1].type).toBe("int");
  });

  it("ignores malformed placeholders", () => {
    expect(extractParams("WHERE x = {{9bad}} OR y = {{}}")).toEqual([]);
  });
});

describe("substituteParams", () => {
  it("passes through SQL without params", () => {
    const sql = "SELECT 1";
    expect(substituteParams(sql, {})).toEqual({ sql, warnings: [] });
  });

  it("quotes string values and escapes single quotes", () => {
    const { sql } = substituteParams("WHERE name = {{name}}", {
      name: "O'Brien",
    });
    expect(sql).toBe("WHERE name = 'O''Brien'");
  });

  it("emits numeric values bare", () => {
    const { sql, warnings } = substituteParams("WHERE n > {{n:int}}", {
      n: "42",
    });
    expect(sql).toBe("WHERE n > 42");
    expect(warnings).toEqual([]);
  });

  it("quotes a non-numeric int value and warns", () => {
    const { sql, warnings } = substituteParams("WHERE n > {{n:int}}", {
      n: "abc",
    });
    expect(sql).toBe("WHERE n > 'abc'");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].name).toBe("n");
  });

  it.each([
    ["true", "TRUE"],
    ["1", "TRUE"],
    ["YES", "TRUE"],
    ["false", "FALSE"],
    ["0", "FALSE"],
    ["no", "FALSE"],
  ])("maps bool %s to %s", (input, expected) => {
    const { sql } = substituteParams("WHERE ok = {{flag:bool}}", {
      flag: input,
    });
    expect(sql).toBe(`WHERE ok = ${expected}`);
  });

  it("throws ParamError on an invalid bool", () => {
    expect(() => substituteParams("WHERE ok = {{flag:bool}}", { flag: "maybe" })).toThrow(
      ParamError,
    );
  });

  it("throws ParamError when a required value is missing", () => {
    expect(() => substituteParams("WHERE id = {{id}}", {})).toThrow(ParamError);
  });

  it("uses the default when the value is empty", () => {
    const { sql } = substituteParams("WHERE s = {{s='x'}}", { s: "" });
    expect(sql).toBe("WHERE s = 'x'");
  });

  it("substitutes every occurrence of a repeated param", () => {
    const { sql } = substituteParams("WHERE a = {{x}} OR b = {{x}}", {
      x: "1",
    });
    expect(sql).toBe("WHERE a = '1' OR b = '1'");
  });
});
