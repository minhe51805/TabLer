import { describe, expect, it } from "vitest";
import {
  buildInlineEditPrompt,
  diffLines,
  extractSqlFromAiResponse,
  findStatementRangeAt,
} from "@/components/SQLEditor/inline-ai-edit";

/**
 * `findStatementRangeAt` decides WHICH statement Ctrl+K rewrites — a boundary
 * bug silently rewrites the wrong SQL. Contracts exercised: next-statement
 * wins on whitespace, past-end clamps to the last statement, and `;` inside
 * strings/comments/dollar-quoted bodies never splits.
 */

const sql = "SELECT 1;\nSELECT 'a;b';\nSELECT 3";

describe("findStatementRangeAt", () => {
  it("locates the statement containing the offset", () => {
    expect(findStatementRangeAt(sql, 2)).toEqual({ start: 0, end: 8 });
    expect(findStatementRangeAt(sql, 15)).toEqual({ start: 10, end: 22 });
    expect(findStatementRangeAt(sql, sql.length - 1)).toEqual({
      start: 24,
      end: sql.length,
    });
  });

  it("a `;` inside a string literal does not split the statement", () => {
    // `SELECT 'a;b'` must come back as ONE range.
    const document = "SELECT 'a;b';\nSELECT 2";
    expect(findStatementRangeAt(document, 5)).toEqual({ start: 0, end: 12 });
    expect(findStatementRangeAt(document, 16)).toEqual({ start: 14, end: 22 });
  });
  it("an offset in whitespace between statements picks the NEXT one", () => {
    // offset 8..9 is the `;`+newline after `SELECT 1` — Ctrl+K there edits
    // forward, not the statement that just ended.
    expect(findStatementRangeAt(sql, 9)).toEqual({ start: 10, end: 22 });
    // Whitespace-only gap still goes forward.
    const gapped = "SELECT 1;   \n\n   SELECT 2";
    expect(findStatementRangeAt(gapped, 12)).toEqual({ start: 17, end: gapped.length });
  });

  it("an offset past the last statement clamps to it", () => {
    expect(findStatementRangeAt(sql, sql.length + 50)).toEqual({
      start: 24,
      end: sql.length,
    });
  });

  it("`;` inside comments and dollar-quoted bodies does not split", () => {
    const document =
      "SELECT 1; -- semicolon; inside comment\nSELECT 2; /* block ; comment */\n" +
      "CREATE FUNCTION f() RETURNS void AS $$ BEGIN x := 1; END; $$ LANGUAGE plpgsql;\nSELECT 3";
    // The whole CREATE FUNCTION is one statement despite `;` inside the body —
    // the preceding block comment belongs to its range.
    expect(findStatementRangeAt(document, 76)).toEqual({ start: 49, end: 148 });
    // The SELECT after it is still reachable.
    expect(findStatementRangeAt(document, document.length - 1)).toEqual({
      start: 150,
      end: document.length,
    });
  });

  it("returns null when the document holds no statement", () => {
    expect(findStatementRangeAt("", 0)).toBeNull();
    expect(findStatementRangeAt("   \n  ", 2)).toBeNull();
  });
});

describe("extractSqlFromAiResponse", () => {
  it("unwraps a fenced block — the contract models break most often", () => {
    expect(extractSqlFromAiResponse("```sql\nSELECT 1\n```")).toBe("SELECT 1");
    expect(extractSqlFromAiResponse("```\nSELECT 1\n```")).toBe("SELECT 1");
    expect(extractSqlFromAiResponse("Here you go:\n```sql\nSELECT 1;\n```\nDone.")).toBe(
      "SELECT 1;",
    );
  });

  it("strips a stray leading `sql` language tag without a fence", () => {
    expect(extractSqlFromAiResponse("sql\nSELECT 1")).toBe("SELECT 1");
    expect(extractSqlFromAiResponse("  SELECT 1  ")).toBe("SELECT 1");
  });
});

describe("diffLines", () => {
  it("collapses a common prefix/suffix to `equal` so only the middle is decorated", () => {
    const ops = diffLines("a\nb\nc", "a\nB\nc");
    expect(ops).toEqual([
      { type: "equal", line: "a" },
      { type: "delete", line: "b" },
      { type: "insert", line: "B" },
      { type: "equal", line: "c" },
    ]);
  });

  it("keeps interleaved lines via LCS instead of one big changed block", () => {
    const ops = diffLines("a\nx\nb\ny\nc", "a\nb\nc");
    // The survivors must round-trip through both sides of the diff; only
    // x and y may delete — a whole-middle collapse would delete a/b/c too.
    const roundTrip = (which: "insert" | "delete") =>
      ops
        .filter((op) => op.type === "equal" || op.type === which)
        .map((op) => op.line)
        .join("\n");
    expect(roundTrip("insert")).toBe("a\nb\nc");
    expect(roundTrip("delete")).toBe("a\nx\nb\ny\nc");
    expect(
      ops
        .filter((op) => op.type === "delete")
        .map((op) => op.line)
        .sort(),
    ).toEqual(["x", "y"]);
  });

  it("degrades to delete-all + insert-all when the changed middle exceeds the LCS cap", () => {
    const oldMid = Array.from({ length: 600 }, (_, i) => `old-${i}`);
    const newMid = Array.from({ length: 500 }, (_, i) => `new-${i}`);
    const oldText = ["head", ...oldMid, "tail"].join("\n");
    const newText = ["head", ...newMid, "tail"].join("\n");

    const ops = diffLines(oldText, newText);
    const mid = ops.slice(1, ops.length - 1); // between the two `equal` guards

    expect(ops[0]).toEqual({ type: "equal", line: "head" });
    expect(ops[ops.length - 1]).toEqual({ type: "equal", line: "tail" });
    // No `equal` ops and no interleaving inside the oversized middle.
    expect(mid.some((op) => op.type === "equal")).toBe(false);
    expect(mid.slice(0, 600).every((op) => op.type === "delete")).toBe(true);
    expect(mid.slice(600).every((op) => op.type === "insert")).toBe(true);
  });

  it("handles a one-sided change (pure insert or delete)", () => {
    expect(diffLines("a", "a\nb")).toEqual([
      { type: "equal", line: "a" },
      { type: "insert", line: "b" },
    ]);
    expect(diffLines("a\nb", "a")).toEqual([
      { type: "equal", line: "a" },
      { type: "delete", line: "b" },
    ]);
  });
});

describe("buildInlineEditPrompt", () => {
  it("demands raw SQL only and carries the statement + instruction", () => {
    const prompt = buildInlineEditPrompt({
      instruction: "add a LIMIT",
      sql: "SELECT * FROM users",
      dialect: "postgresql",
      databaseLabel: "appdb",
    });
    expect(prompt).toContain("Rewrite the SQL statement below");
    expect(prompt).toContain("Return ONLY the rewritten SQL");
    expect(prompt).toContain("Instruction: add a LIMIT");
    expect(prompt).toContain("SELECT * FROM users");
    expect(prompt).toContain("postgresql");
    expect(prompt).toContain("appdb");
  });

  it("switches to write mode when there is no statement to rewrite", () => {
    const prompt = buildInlineEditPrompt({ instruction: "count users", sql: "   " });
    expect(prompt).toContain("Write a SQL statement according to the instruction");
  });
});
