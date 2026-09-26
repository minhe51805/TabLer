import { describe, expect, it } from "vitest";
import { getCompletionSet, SQL_COMPLETIONS } from "@/utils/sql-completions";

/**
 * `getCompletionSet` merges BASE_KEYWORDS + COMMON_FUNCTIONS with the
 * per-dialect additions and overlays DIALECT_FUNCTION_SIGNATURES onto the
 * common signature map. A bad merge attaches the wrong signature doc or
 * loses a dialect keyword in completions.
 */
describe("getCompletionSet", () => {
  it("falls back to the postgresql set for an unknown/missing db type", () => {
    expect(getCompletionSet(undefined)).toBe(SQL_COMPLETIONS.postgresql);
  });

  it("a dialect-specific function appears for its engine and not another", () => {
    expect(getCompletionSet("postgresql").functions).toContain("pg_size_pretty");
    expect(getCompletionSet("mysql").functions).not.toContain("pg_size_pretty");
    expect(getCompletionSet("mysql").functions).toContain("DATE_FORMAT");
    expect(getCompletionSet("postgresql").functions).not.toContain("DATE_FORMAT");
  });

  it("a dialect-specific keyword merges with the shared base list", () => {
    const mssql = getCompletionSet("mssql");
    expect(mssql.keywords).toContain("NOLOCK");
    expect(mssql.keywords).toContain("SELECT"); // base keyword survives the merge
    expect(getCompletionSet("sqlite").keywords).not.toContain("NOLOCK");
  });

  it("dialect signature override wins on a conflict", () => {
    // `string_agg` exists in the common map AND the postgresql overlay —
    // the overlay's signature is the one completions must show.
    expect(getCompletionSet("postgresql").functionSignatures["string_agg"].signature).toBe(
      "string_agg(expr, delim)",
    );
    // mysql has no override → the common signature is used.
    expect(getCompletionSet("mysql").functionSignatures["string_agg"].signature).toBe(
      "string_agg(expr, delimiter)",
    );
  });

  it("signature lookup falls back to the common map without a dialect override", () => {
    expect(getCompletionSet("mysql").functionSignatures["count"].signature).toBe("count(expr | *)");
    expect(getCompletionSet("postgresql").functionSignatures["count"]).toBeDefined();
  });

  it("exposes signatures for dialect-only functions", () => {
    expect(getCompletionSet("postgresql").functionSignatures["pg_size_pretty"].signature).toBe(
      "pg_size_pretty(bytes)",
    );
  });

  it("operators are shared across dialects", () => {
    expect(getCompletionSet("postgresql").operators).toBe(getCompletionSet("mssql").operators);
  });
});
