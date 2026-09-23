import { describe, expect, it } from "vitest";
import { stripMarkdownFence } from "@/utils/markdown-fence";

describe("stripMarkdownFence", () => {
  it("returns plain SQL untouched", () => {
    const sql = "SELECT * FROM users WHERE id = 1";
    expect(stripMarkdownFence(sql)).toBe(sql);
  });

  it("unwraps a fenced sql block", () => {
    expect(stripMarkdownFence("```sql\nSELECT 1\n```")).toBe("SELECT 1");
  });

  it("unwraps a fence without a language tag", () => {
    expect(stripMarkdownFence("```\ndb.users.find({})\n```")).toBe("db.users.find({})");
  });

  it("drops a trailing second block", () => {
    const input = "```sql\nSELECT * FROM a\n```\n```sql\nSELECT * FROM b\n```";
    expect(stripMarkdownFence(input)).toBe("SELECT * FROM a");
  });

  it("leaves an unclosed fence untouched", () => {
    const input = "```sql\nSELECT 1";
    expect(stripMarkdownFence(input)).toBe(input);
  });

  it("leaves a fence that does not start the input untouched", () => {
    const input = "SELECT 1\n```sql\nSELECT 2\n```";
    expect(stripMarkdownFence(input)).toBe(input);
  });

  it("handles leading whitespace before the fence", () => {
    expect(stripMarkdownFence("  \n```js\nfind()\n```")).toBe("find()");
  });
});
