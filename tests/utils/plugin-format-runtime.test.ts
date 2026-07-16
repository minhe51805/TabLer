import { describe, expect, it } from "vitest";
import {
  getEnabledPluginFormats,
  serializePluginFormat,
} from "../../src/utils/plugin-format-runtime";
import type { InstalledPluginRecord, PluginFormatContribution } from "../../src/types/plugin";

const tsv: PluginFormatContribution = {
  id: "tsv",
  label: "TSV",
  extension: "tsv",
  mimeType: "text/tab-separated-values",
  mode: "delimited",
  delimiter: "\t",
  includeHeader: true,
};

describe("plugin format runtime", () => {
  it("serializes delimited values without losing quotes or newlines", () => {
    expect(
      serializePluginFormat(tsv, ["name", "note"], [["Ada", "line 1\nline 2"], ["A\"B", null]]),
    ).toBe('name\tnote\r\nAda\t"line 1\nline 2"\r\n"A""B"\t');
  });

  it("serializes JSON Lines as one object per row", () => {
    expect(
      serializePluginFormat(
        { ...tsv, id: "jsonl", mode: "json-lines", delimiter: null },
        ["id", "active"],
        [[1, true], [2, null]],
      ),
    ).toBe('{"id":1,"active":true}\n{"id":2,"active":null}');
  });

  it("exposes contributions only from enabled verified export plugins", () => {
    const base = {
      manifest: {
        apiVersion: 1,
        id: "formats",
        name: "Formats",
        version: "1.0.0",
        kind: "export",
        capabilities: ["export"],
        permissions: [],
        compatibility: { platforms: [], architectures: [] },
        contributes: { formats: [tsv], drivers: [] },
      },
      bundlePath: "formats.tableplugin",
      installedAt: 1,
      updatedAt: 1,
      computedIntegrity: "abc",
      validationError: null,
      rollbackAvailable: false,
      previousVersion: null,
    } satisfies Omit<InstalledPluginRecord, "enabled" | "verified">;

    expect(getEnabledPluginFormats([{ ...base, enabled: true, verified: true }])).toHaveLength(1);
    expect(getEnabledPluginFormats([{ ...base, enabled: false, verified: true }])).toHaveLength(0);
    expect(getEnabledPluginFormats([{ ...base, enabled: true, verified: false }])).toHaveLength(0);
  });
});
