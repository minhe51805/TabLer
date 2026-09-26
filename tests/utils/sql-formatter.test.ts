import { describe, expect, it } from "vitest";
import { formatSql } from "@/utils/sql-formatter";

/**
 * `mapDialect` chooses the sql-formatter language from our DatabaseType. An
 * unmapped/renamed db_type silently degrades Format SQL to generic `sql` —
 * these cases pin the observable difference: dialect syntax that generic
 * mode cannot parse must still format.
 */
describe("formatSql dialect routing", () => {
  it("mssql formats TOP + bracket-quoted identifiers that generic sql rejects", () => {
    const input = "select TOP 5 [user name] from [dbo].[orders] group by [user name]";
    const output = formatSql(input, "mssql");
    expect(output).toContain("TOP 5 [user name]");
    expect(output).not.toBe(input); // actually reformatted, not passthrough
    // The same input must NOT be silently parseable under the wrong dialect —
    // asserting the mapped dialect produced valid transactsql output.
    expect(() => formatSql(input, "postgresql")).toThrow();
  });

  it("postgresql keeps `IS DISTINCT FROM` as one operator", () => {
    const output = formatSql("select * from t where x is distinct from 3", "postgresql");
    expect(output).toContain("IS DISTINCT FROM 3");
  });

  it("mysql backtick identifiers format under mysql and fail under transactsql", () => {
    const output = formatSql("select `col name` from `my table` limit 5", "mysql");
    expect(output).toContain("`col name`");
    expect(output).toContain("LIMIT");
    expect(() => formatSql("select `col name` from `my table` limit 5", "mssql")).toThrow();
  });

  it.each(["mongodb", "redis", "cassandra"] as const)(
    "engine without a dialect entry falls back to generic sql: %s",
    (dbType) => {
      const output = formatSql("select id from users where age > 30", dbType);
      expect(output).toContain("SELECT");
      expect(output).toContain("WHERE");
    },
  );

  it("uppercases keywords and reindents", () => {
    const output = formatSql("select id, name from users", "sqlite");
    expect(output).toBe("SELECT\n  id,\n  name\nFROM\n  users");
  });
});

describe("formatSql passthrough", () => {
  it("returns whitespace-only input unchanged (no formatter call)", () => {
    expect(formatSql("   \n\t  ")).toBe("   \n\t  ");
    expect(formatSql("")).toBe("");
  });
});
