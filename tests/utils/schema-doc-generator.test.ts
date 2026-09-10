import { describe, expect, it } from "vitest";
import {
  generateHtmlDocs,
  generateMarkdownDocs,
  type DocDatabase,
} from "@/utils/schema-doc-generator";

const fixture: DocDatabase = {
  name: "commerce",
  tables: [
    {
      name: "users",
      columns: [
        { name: "id", data_type: "bigint", is_nullable: false, is_primary_key: true },
        { name: "email", data_type: "text", is_nullable: false, is_primary_key: false, comment: "login handle" },
        { name: "status", data_type: "enum", is_nullable: true, is_primary_key: false, default_value: "'active'" },
      ],
      indexes: [
        { name: "users_pkey", columns: ["id"], is_unique: true },
        { name: "users_email_key", columns: ["email"], is_unique: true },
      ],
      foreignKeys: [],
      rowCount: 120_000,
    },
    {
      name: "orders",
      columns: [
        { name: "id", data_type: "bigint", is_nullable: false, is_primary_key: true },
        { name: "user_id", data_type: "bigint", is_nullable: false, is_primary_key: false },
        { name: "note | weird", data_type: "text", is_nullable: true, is_primary_key: false },
      ],
      indexes: [{ name: "orders_pkey", columns: ["id"], is_unique: true }],
      foreignKeys: [
        {
          name: "orders_user_id_fkey",
          column: "user_id",
          referenced_table: "users",
          referenced_column: "id",
          on_delete: "CASCADE",
        },
      ],
    },
  ],
};

describe("generateMarkdownDocs", () => {
  it("emits a deterministic document with relationships, TOC, and tables", () => {
    const first = generateMarkdownDocs(fixture, "2026-09-09T00:00:00.000Z");
    const second = generateMarkdownDocs(fixture, "2026-09-09T00:00:00.000Z");
    expect(first).toBe(second);

    expect(first).toContain("# commerce — schema documentation");
    expect(first).toContain("2 table(s)");
    expect(first).toContain("## Relationships");
    expect(first).toContain("`orders.user_id` | `users.id` | CASCADE");
    expect(first).toContain("- [users](#users)");
    expect(first).toContain("~120,000 rows.");
    expect(first).toContain("🔑 PK");
    expect(first).toContain("UNIQUE `users_email_key`");
    expect(first).toContain("ON DELETE CASCADE");
    // Comments and defaults survive.
    expect(first).toContain("login handle");
    expect(first).toContain("`'active'`");
  });

  it("escapes pipes inside markdown table cells", () => {
    const markdown = generateMarkdownDocs(fixture, "2026-09-09T00:00:00.000Z");
    expect(markdown).toContain("`note \\| weird`");
  });

  it("omits empty sections instead of printing empty tables", () => {
    const markdown = generateMarkdownDocs(fixture, "2026-09-09T00:00:00.000Z");
    const usersSection = markdown.split("## users")[1]?.split("## orders")[0] ?? "";
    expect(usersSection).not.toContain("### Foreign keys");
  });
});

describe("generateHtmlDocs", () => {
  it("emits a standalone escaped HTML document", () => {
    const html = generateHtmlDocs(fixture, "2026-09-09T00:00:00.000Z");
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("<title>commerce — schema documentation</title>");
    expect(html).toContain('href="#users"');
    expect(html).toContain('id="orders"');
    expect(html).toContain("ON DELETE CASCADE");
    expect(html).toContain("~120,000 rows.");
  });

  it("escapes HTML-significant characters in identifiers", () => {
    const hostile: DocDatabase = {
      name: "db",
      tables: [
        {
          name: "t<x>",
          columns: [
            { name: "c\"1", data_type: "text&", is_nullable: false, is_primary_key: true },
          ],
          indexes: [],
          foreignKeys: [],
        },
      ],
    };
    const html = generateHtmlDocs(hostile, "2026-09-09T00:00:00.000Z");
    expect(html).not.toContain("t<x>");
    expect(html).not.toContain('c"1');
    expect(html).toContain("text&amp;");
  });
});
