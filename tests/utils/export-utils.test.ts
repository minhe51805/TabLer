import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCsvContent,
  buildHtmlContent,
  buildJsonContent,
  buildMarkdownTableContent,
  buildNdjsonContent,
  buildTsvContent,
  exportToCSV,
  exportToJSON,
} from "@/utils/export-utils";

const saveExportFileMock = vi.hoisted(() => vi.fn());

vi.mock("@/utils/tauri-utils", () => ({
  saveExportFile: (...args: unknown[]) => saveExportFileMock(...args),
}));

const COLUMNS = ["id", "name", "note"];

describe("buildCsvContent", () => {
  it("emits RFC 4180: header row first, CRLF line endings, doubled quotes", () => {
    const csv = buildCsvContent(COLUMNS, [
      [1, "a,b", 'she said "hi"'],
      [2, "line\nbreak", null],
    ]);
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("id,name,note");
    // Comma inside a field → quoted; embedded quote → doubled.
    expect(lines[1]).toBe('1,"a,b","she said ""hi"""');
    // Newline inside a field → quoted; NULL → empty field.
    expect(lines[2]).toBe('2,"line\nbreak",');
    // The whole document uses CRLF, not bare LF.
    // Exactly one CRLF per row boundary (the embedded \n lives inside quotes).
    expect(csv.match(/\r\n/g)).toHaveLength(2);
  });

  it("prefixes formula-leading text cells with a quote but leaves numeric -5 alone", () => {
    const csv = buildCsvContent(
      ["v"],
      [
        ["=cmd|' /C calc'!A1"],
        ["+1-2"],
        ["-drop"],
        ["@SUM(A1)"],
        ["\t=evil"],
        [-5],
        [42],
        [true],
        ["plain"],
      ],
    );
    const lines = csv.split("\r\n").slice(1);
    expect(lines[0]).toBe("'=cmd|' /C calc'!A1");
    expect(lines[1]).toBe("'+1-2");
    expect(lines[2]).toBe("'-drop");
    expect(lines[3]).toBe("'@SUM(A1)");
    // Tab-leading cells are injection vectors; the quote is prepended so the
    // cell needs quoting too (it contains a tab? no — the prefix isn't
    // special, but the raw tab already forced a guard prefix).
    expect(lines[4]).toBe("'\t=evil");
    // A real negative number stays numeric — prefixing it would break sums.
    expect(lines[5]).toBe("-5");
    expect(lines[6]).toBe("42");
    expect(lines[7]).toBe("true");
    expect(lines[8]).toBe("plain");
  });

  it("quotes a cell that already starts with the guard quote correctly", () => {
    // The guard only prepends; a user value "''" style is untouched, while a
    // guarded field containing commas still gets RFC 4180 quoting.
    const csv = buildCsvContent(["v"], [["=a,b"]]);
    expect(csv.split("\r\n")[1]).toBe(`"'=a,b"`);
  });
});

describe("buildTsvContent", () => {
  it("separates with tabs, flattens tabs/newlines inside cells, NULL → empty", () => {
    const tsv = buildTsvContent(COLUMNS, [
      [1, "a\tb", "line1\nline2"],
      [2, null, "ok"],
    ]);
    const lines = tsv.split("\n");
    expect(lines[0]).toBe("id\tname\tnote");
    expect(lines[1]).toBe("1\ta b\tline1 line2");
    expect(lines[2]).toBe("2\t\tok");
  });

  it("applies the formula-injection guard to text cells", () => {
    const tsv = buildTsvContent(["v"], [["=1+1"], [-5]]);
    const lines = tsv.split("\n").slice(1);
    expect(lines[0]).toBe("'=1+1");
    expect(lines[1]).toBe("-5");
  });
});

describe("buildJsonContent", () => {
  it("produces one object per row keyed by column name, NULL kept as null", () => {
    const json = buildJsonContent(COLUMNS, [[1, "alice", null]]);
    const parsed = JSON.parse(json) as Record<string, unknown>[];
    expect(parsed).toEqual([{ id: 1, name: "alice", note: null }]);
  });

  it("fills missing row positions with null instead of dropping keys", () => {
    const parsed = JSON.parse(buildJsonContent(COLUMNS, [[1]])) as Record<string, unknown>[];
    expect(parsed[0]).toEqual({ id: 1, name: null, note: null });
  });
});

describe("buildNdjsonContent", () => {
  it("emits one compact JSON object per line — no surrounding array", () => {
    const ndjson = buildNdjsonContent(COLUMNS, [
      [1, "alice", null],
      [2, "bob", "x"],
    ]);
    const lines = ndjson.split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ id: 1, name: "alice", note: null });
    expect(JSON.parse(lines[1])).toEqual({ id: 2, name: "bob", note: "x" });
    expect(ndjson.trim().startsWith("[")).toBe(false);
  });
});

describe("buildHtmlContent", () => {
  it("escapes HTML in headers and cells, NULL cells render empty", () => {
    const html = buildHtmlContent(["<b>x</b>", "v"], [["<script>", null]]);
    expect(html).toContain("<th>&lt;b&gt;x&lt;/b&gt;</th>");
    expect(html).toContain("<td>&lt;script&gt;</td><td></td>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("<table>");
  });
});

describe("buildMarkdownTableContent", () => {
  it("escapes pipes, collapses newlines, NULL → empty cell", () => {
    const md = buildMarkdownTableContent(
      ["a|b", "v"],
      [
        ["x|y", "line\nbreak"],
        [null, "z"],
      ],
    );
    const lines = md.split("\n");
    expect(lines[0]).toBe("| a\\|b | v |");
    expect(lines[1]).toBe("| --- | --- |");
    expect(lines[2]).toBe("| x\\|y | line break |");
    expect(lines[3]).toBe("|  | z |");
  });
});

describe("export functions", () => {
  beforeEach(() => {
    saveExportFileMock.mockReset();
  });

  it("exportToCSV saves the exact bytes buildCsvContent produces", async () => {
    await exportToCSV(COLUMNS, [[1, "a,b", null]], "out.csv");
    expect(saveExportFileMock).toHaveBeenCalledTimes(1);
    const call = saveExportFileMock.mock.calls[0][0] as {
      fileName: string;
      content: string;
      filters: { name: string; extensions: string[] }[];
    };
    expect(call.fileName).toBe("out.csv");
    expect(call.content).toBe(buildCsvContent(COLUMNS, [[1, "a,b", null]]));
    expect(call.filters[0].extensions).toContain("csv");
  });

  it("exportToJSON never invokes the save dialog for an empty row set", async () => {
    await exportToJSON(COLUMNS, [], "empty.json");
    expect(saveExportFileMock).not.toHaveBeenCalled();
  });
});
