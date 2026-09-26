import { describe, expect, it } from "vitest";
import {
  generateDeleteSqlParameterized,
  generateInsertSql,
  generateInsertSqlParameterized,
  generateUpdateSql,
  generateUpdateSqlParameterized,
  quoteIdentifier,
} from "@/utils/sql-generator";

describe("quoteIdentifier", () => {
  it("switches quoting style per dialect", () => {
    expect(quoteIdentifier("users", "postgresql")).toBe('"users"');
    expect(quoteIdentifier("users", "mysql")).toBe("`users`");
    expect(quoteIdentifier("users", "mariadb")).toBe("`users`");
    expect(quoteIdentifier("users", "mssql")).toBe("[users]");
    expect(quoteIdentifier("users", "sqlite")).toBe('"users"');
    expect(quoteIdentifier("users", "clickhouse")).toBe("`users`");
    expect(quoteIdentifier("users", undefined)).toBe('"users"');
  });

  it("quotes each part of a qualified name separately", () => {
    expect(quoteIdentifier("public.orders", "postgresql")).toBe('"public"."orders"');
    expect(quoteIdentifier("dbo.Orders", "mssql")).toBe("[dbo].[Orders]");
    expect(quoteIdentifier("mydb.users", "mysql")).toBe("`mydb`.`users`");
  });

  it("escapes embedded quote characters inside the identifier", () => {
    expect(quoteIdentifier('we"ird', "postgresql")).toBe('"we""ird"');
    expect(quoteIdentifier("we`ird", "mysql")).toBe("`we``ird`");
    expect(quoteIdentifier("we]ird", "mssql")).toBe("[we]]ird]");
  });
});

describe("generateInsertSql", () => {
  const columns = ["id", "name", "active", "meta"];

  it("emits one INSERT per row with dialect-quoted identifiers", () => {
    const sql = generateInsertSql("users", columns, [[1, "alice", true, null]], "postgresql");
    expect(sql).toBe(
      'INSERT INTO "users" ("id", "name", "active", "meta") VALUES (1, \'alice\', TRUE, NULL);',
    );
  });

  it("escapes single quotes inside string literals", () => {
    const sql = generateInsertSql("t", ["v"], [["o'brien"]], "mysql");
    expect(sql).toContain("'o''brien'");
  });

  it("serializes object cells as escaped JSON text", () => {
    const sql = generateInsertSql(
      "t",
      ["meta"],
      [[{ a: 1, b: "it's" }] as unknown as (string | number | boolean | null)[]],
      "postgresql",
    );
    expect(sql).toContain(`'{"a":1,"b":"it''s"}'`);
  });

  it("uses N'' literals on MSSQL for strings and objects", () => {
    const sql = generateInsertSql("t", ["v", "o"], [["naïve", { k: 1 }] as never], "mssql");
    expect(sql).toContain("N'naïve'");
    expect(sql).toContain(`N'{"k":1}'`);
  });

  it("returns empty output for empty rows or columns", () => {
    expect(generateInsertSql("t", ["a"], [], "mysql")).toBe("");
    expect(generateInsertSql("t", [], [[1]], "mysql")).toBe("");
  });
});

describe("generateUpdateSql", () => {
  const columns = ["id", "tenant", "name", "email"];

  it("puts ONLY primary-key columns in WHERE and the rest in SET", () => {
    const sql = generateUpdateSql(
      "users",
      columns,
      [[7, "acme", "alice", "a@x"]],
      ["id", "tenant"],
      "mysql",
    );
    expect(sql).toBe(
      "UPDATE `users` SET `name` = 'alice', `email` = 'a@x' WHERE `id` = 7 AND `tenant` = 'acme';",
    );
  });

  it("supports multi-row batches, one statement per row", () => {
    const sql = generateUpdateSql(
      "t",
      ["id", "v"],
      [
        [1, "a"],
        [2, "b"],
      ],
      ["id"],
      "postgresql",
    );
    expect(sql.split("\n")).toHaveLength(2);
    expect(sql).toContain('WHERE "id" = 1;');
    expect(sql).toContain('WHERE "id" = 2;');
  });

  it("returns empty when no primary keys are provided — never emits a WHERE-less update", () => {
    expect(generateUpdateSql("t", ["id", "v"], [[1, "a"]], [], "mysql")).toBe("");
  });

  it("skips rows where every column is a PK (nothing to SET)", () => {
    const sql = generateUpdateSql("t", ["id"], [[1]], ["id"], "mysql");
    expect(sql).toBe("");
  });
});

describe("parameterized generators", () => {
  it("generateInsertSqlParameterized emits $.column placeholders", () => {
    const sql = generateInsertSqlParameterized("users", ["id", "name"], "postgresql");
    expect(sql).toBe('INSERT INTO "users" ("id", "name") VALUES ($.id, $.name);');
  });

  it("generateUpdateSqlParameterized splits SET/WHERE by PK membership", () => {
    const sql = generateUpdateSqlParameterized("users", ["id", "name", "email"], ["id"], "mysql");
    expect(sql).toBe("UPDATE `users` SET `name` = $.name, `email` = $.email WHERE `id` = $.id;");
  });

  it("generateDeleteSqlParameterized targets only PK columns", () => {
    const sql = generateDeleteSqlParameterized("users", ["id", "tenant"], "mssql");
    expect(sql).toBe("DELETE FROM [users] WHERE [id] = $.id AND [tenant] = $.tenant;");
  });
});
