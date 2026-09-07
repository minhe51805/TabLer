import { describe, expect, it } from "vitest";
import { buildPastePreview, parseClipboardText } from "@/utils/clipboard-parser";

describe("CSV import preview", () => {
  it("maps quoted CSV headers and turns empty imported values into null", () => {
    const parsed = parseClipboardText('id,name,note\n1,Ada,"hello, world"\n2,,plain');
    expect(parsed).not.toBeNull();
    const preview = buildPastePreview(parsed!, ["id", "name", "note"]);
    expect(preview.mappings.map((mapping) => mapping.tableColumnName)).toEqual(["id", "name", "note"]);
    expect(preview.insertRows[1]).toEqual([["id", "2"], ["name", null], ["note", "plain"]]);
  });

  it("reports source columns that cannot be mapped to the target table", () => {
    const parsed = parseClipboardText("id,unknown\n1,value");
    const preview = buildPastePreview(parsed!, ["id"]);
    expect(preview.skippedColumns).toEqual([{ index: 1, header: "unknown" }]);
  });

  it("does not map the same target column twice when CSV headers repeat", () => {
    const parsed = parseClipboardText("id,id\n1,2");
    const preview = buildPastePreview(parsed!, ["id"]);
    expect(preview.insertRows).toEqual([[['id', "1"]]]);
    expect(preview.skippedColumns).toEqual([{ index: 1, header: "id" }]);
  });

  it("keeps line breaks and escaped quotes inside a quoted CSV cell", () => {
    const parsed = parseClipboardText('id,note\n1,"first line\nsecond ""quoted"" line"');
    expect(parsed).not.toBeNull();
    expect(parsed!.rowCount).toBe(1);
    expect(parsed!.dataRows[0]).toEqual(["1", 'first line\nsecond "quoted" line']);
  });

  it("maps headerless numeric data by position", () => {
    const parsed = parseClipboardText("1,2\n3,4");
    expect(parsed?.firstRowWasHeader).toBe(false);
    const preview = buildPastePreview(parsed!, ["first", "second", "third"]);
    expect(preview.mappings.map((mapping) => [mapping.tableColumnName, mapping.matchedBy])).toEqual([
      ["first", "position"],
      ["second", "position"],
    ]);
    expect(preview.insertRows).toEqual([
      [["first", "1"], ["second", "2"]],
      [["first", "3"], ["second", "4"]],
    ]);
  });
});
