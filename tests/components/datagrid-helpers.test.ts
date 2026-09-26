import { describe, expect, it } from "vitest";
import {
  areCellValuesEqual,
  buildRowPrimaryKeys,
  buildTableFilterClause,
  parseEditorValue,
  resolveTableFilter,
  type ResolvedColumn,
} from "@/components/DataGrid/hooks/useDataGrid";

function col(
  name: string,
  column_type: string,
  extra: Partial<ResolvedColumn> = {},
): ResolvedColumn {
  return {
    name,
    data_type: column_type,
    column_type,
    is_nullable: true,
    is_primary_key: false,
    ...extra,
  };
}

describe("parseEditorValue", () => {
  describe("boolean columns", () => {
    const bool = col("flag", "BOOLEAN");
    it.each([
      ["true", true],
      ["T", true],
      ["1", true],
      ["yes", true],
      ["false", false],
      ["F", false],
      ["0", false],
      ["no", false],
    ])("parses %s → %s", (raw, expected) => {
      expect(parseEditorValue(raw, bool)).toBe(expected);
    });

    it("rejects unparseable input instead of coercing", () => {
      expect(() => parseEditorValue("maybe", bool)).toThrow();
    });
  });

  describe("numeric columns", () => {
    const int = col("n", "INT");
    const numeric = col("price", "DECIMAL(10,2)");
    const bigint = col("big", "BIGINT");

    it("accepts integer, exponent, and leading-dot forms", () => {
      expect(parseEditorValue("42", int)).toBe(42);
      expect(parseEditorValue("1e5", int)).toBe(100000);
      expect(parseEditorValue(".5", numeric)).toBe(0.5);
      expect(parseEditorValue("-3.25", numeric)).toBe(-3.25);
    });

    it("keeps >15-significant-digit input as a string to preserve bigint precision", () => {
      const raw = "9007199254740993"; // beyond IEEE-754 safe integer
      const parsed = parseEditorValue(raw, bigint);
      expect(parsed).toBe(raw);
      expect(String(Number(raw))).not.toBe(raw); // proves coercion would corrupt
    });

    it("rejects non-numeric input", () => {
      expect(() => parseEditorValue("12x", int)).toThrow();
      expect(() => parseEditorValue("1,000", numeric)).toThrow();
      expect(() => parseEditorValue("", int)).toThrow();
    });
  });

  describe("date/time columns", () => {
    it("passes the raw text through and lets the DB validate", () => {
      expect(parseEditorValue("2026-09-26", col("d", "DATE"))).toBe("2026-09-26");
      expect(parseEditorValue(" 12:30 ", col("t", "TIME"))).toBe("12:30");
      expect(parseEditorValue("2026-09-26 12:30", col("ts", "TIMESTAMP"))).toBe("2026-09-26 12:30");
    });
  });

  describe("json columns", () => {
    const json = col("meta", "JSONB");
    it("accepts valid JSON and returns the text", () => {
      expect(parseEditorValue('{"a":1}', json)).toBe('{"a":1}');
      expect(parseEditorValue("[1,2]", json)).toBe("[1,2]");
    });
    it("rejects malformed JSON", () => {
      expect(() => parseEditorValue("{a:1}", json)).toThrow();
    });
  });

  describe("blob columns", () => {
    const blob = col("bin", "BYTEA");
    it("accepts even-length hex (spaces allowed)", () => {
      expect(parseEditorValue("48 65 6c 6c 6f", blob)).toBe("48 65 6c 6c 6f");
      expect(parseEditorValue("deadBEEF", blob)).toBe("deadBEEF");
    });
    it("rejects odd-length or non-hex input", () => {
      expect(() => parseEditorValue("abc", blob)).toThrow();
      expect(() => parseEditorValue("zz00", blob)).toThrow();
    });
  });

  describe("text columns", () => {
    const text = col("v", "VARCHAR(50)");
    it("returns the raw value verbatim — including the literal 'NULL' gesture", () => {
      // Only dedicated NULL gestures produce real null; typed text stays text.
      expect(parseEditorValue("NULL", text)).toBe("NULL");
      expect(parseEditorValue("  padded  ", text)).toBe("  padded  ");
    });
  });
});

describe("areCellValuesEqual", () => {
  it.each([
    [null, null, true],
    [null, "NULL", false], // a null cell is never equal to the typed word
    [1, 1, true],
    [1, "1", true], // string form of the same scalar compares equal
    [1, "01", false],
    [true, "true", true],
    [true, "1", false],
    [false, "false", true],
    ["a", "a", true],
    ["a", "b", false],
    [0, null, false],
    [0, "", false],
  ])("areCellValuesEqual(%p, %p) === %p", (left, right, expected) => {
    expect(areCellValuesEqual(left, right)).toBe(expected);
  });
});

describe("buildTableFilterClause", () => {
  const columns = [
    col("name", "VARCHAR(100)"),
    col("email", "TEXT"),
    col("id", "INT"),
    col("uuid_col", "UUID"),
  ];

  it("ORs LIKE conditions over text-like columns only", () => {
    const clause = buildTableFilterClause("alice", columns, "mysql");
    expect(clause).toBe("name LIKE '%alice%' OR email LIKE '%alice%' OR uuid_col LIKE '%alice%'");
    expect(clause).not.toMatch(/\bid\b/);
  });

  it("uses ILIKE on the postgres family", () => {
    const clause = buildTableFilterClause("x", columns, "postgresql");
    expect(clause).toContain("ILIKE");
    expect(clause).not.toContain(" LIKE ");
  });

  it("escapes embedded single quotes in the needle", () => {
    const clause = buildTableFilterClause("o'brien", columns, "mysql");
    expect(clause).toContain("%o''brien%");
  });

  it("returns null when nothing is filterable server-side", () => {
    expect(buildTableFilterClause("x", [col("id", "INT")], "mysql")).toBeNull();
    expect(buildTableFilterClause("   ", columns, "mysql")).toBeNull();
  });

  it("skips column names the backend grammar cannot quote", () => {
    const clause = buildTableFilterClause(
      "x",
      [col("weird name", "TEXT"), col("ok_name", "TEXT")],
      "mysql",
    );
    expect(clause).toBe("ok_name LIKE '%x%'");
  });
});

describe("resolveTableFilter", () => {
  const textCols = [col("name", "TEXT")];

  it("runs an empty quick filter as just the row-focus filter", () => {
    expect(resolveTableFilter("  ", "a = 1", textCols)).toEqual({
      serverFilter: "a = 1",
      clientSideOnly: false,
    });
  });

  it("sends a compilable quick filter to the server", () => {
    const plan = resolveTableFilter("alice", "", textCols, "postgresql");
    expect(plan.serverFilter).toContain("ILIKE");
    expect(plan.clientSideOnly).toBe(false);
  });

  it("degrades to clientSideOnly when a focus filter is active — OR can't be AND-ed", () => {
    const plan = resolveTableFilter("alice", "id = 5", textCols);
    expect(plan).toEqual({ serverFilter: "id = 5", clientSideOnly: true });
  });

  it("degrades to clientSideOnly when no text-like column can carry the filter", () => {
    const plan = resolveTableFilter("alice", "", [col("id", "INT")]);
    expect(plan).toEqual({ serverFilter: "", clientSideOnly: true });
  });
});

describe("buildRowPrimaryKeys", () => {
  it("extracts PK values by column-name lookup, not position", () => {
    const columns = [
      col("id", "INT", { is_primary_key: true }),
      col("name", "TEXT"),
      col("tenant", "TEXT", { is_primary_key: true }),
    ];
    const row = [7, "alice", "acme"];
    const pks = buildRowPrimaryKeys(row, columns, [columns[0], columns[2]]);
    expect(pks).toEqual([
      { column: "id", value: 7 },
      { column: "tenant", value: "acme" },
    ]);
  });

  it("yields null for a PK column missing from the resolved list", () => {
    const columns = [col("id", "INT", { is_primary_key: true })];
    const pks = buildRowPrimaryKeys([7], columns, [col("ghost", "INT", { is_primary_key: true })]);
    // findIndex fails → rowValues[-1] is undefined → coerces to null rather than "undefined".
    expect(pks).toEqual([{ column: "ghost", value: null }]);
  });
});
