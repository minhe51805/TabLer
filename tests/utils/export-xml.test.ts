import { describe, expect, it } from "vitest";

import { buildXmlContent, escapeXmlText, sanitizeXmlName } from "@/utils/export-xml";

describe("escapeXmlText", () => {
  it("escapes ampersands, angle brackets, and the CDATA terminator", () => {
    expect(escapeXmlText("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
    expect(escapeXmlText("x]]>y")).toBe("x]]&gt;y");
  });
});

describe("sanitizeXmlName", () => {
  it("keeps valid names and replaces illegal interior characters", () => {
    expect(sanitizeXmlName("user_name", 0)).toBe("user_name");
    expect(sanitizeXmlName("a b", 1)).toBe("a_b");
    expect(sanitizeXmlName("total$", 2)).toBe("total_");
  });

  it("falls back to col_N for empty, bad-start, or reserved names", () => {
    expect(sanitizeXmlName("", 0)).toBe("col_0");
    expect(sanitizeXmlName("9lives", 1)).toBe("col_1");
    expect(sanitizeXmlName("-dash", 2)).toBe("col_2");
    expect(sanitizeXmlName("xmlData", 3)).toBe("col_3");
    expect(sanitizeXmlName("XML", 4)).toBe("col_4");
  });
});

describe("buildXmlContent", () => {
  it("renders NULL cells as xsi:nil elements", () => {
    const xml = buildXmlContent(["id", "name"], [[1, null]]);
    expect(xml).toContain('<name xsi:nil="true"/>');
    expect(xml).toContain("<id>1</id>");
  });

  it("deduplicates column names that sanitize to the same element", () => {
    const xml = buildXmlContent(["a b", "a_b"], [[1, 2]]);
    expect(xml).toContain("<a_b>1</a_b>");
    expect(xml).toContain("<a_b_1>2</a_b_1>");
  });

  it("produces the golden document for a 3-row result", () => {
    const xml = buildXmlContent(
      ["id", "name", "note"],
      [
        [1, "Ada", "a & b"],
        [2, "Bob <b>", null],
        [3, "Cyd", "x]]>y"],
      ],
    );
    expect(xml).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<results xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
        "  <row>",
        "    <id>1</id>",
        "    <name>Ada</name>",
        "    <note>a &amp; b</note>",
        "  </row>",
        "  <row>",
        "    <id>2</id>",
        "    <name>Bob &lt;b&gt;</name>",
        '    <note xsi:nil="true"/>',
        "  </row>",
        "  <row>",
        "    <id>3</id>",
        "    <name>Cyd</name>",
        "    <note>x]]&gt;y</note>",
        "  </row>",
        "</results>",
      ].join("\n"),
    );
  });
});
