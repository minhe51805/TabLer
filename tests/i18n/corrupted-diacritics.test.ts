import { describe, expect, it } from "vitest";
import { vi as viLocale } from "../../src/i18n/vi";
import { tr as trLocale } from "../../src/i18n/tr";
import { VI_COPY } from "../../src/components/AISlidePanel/ai-workspace-copy/vi";
import { TR_COPY } from "../../src/components/AISlidePanel/ai-workspace-copy/tr";

// A "?" sandwiched between letters is never valid inside Vietnamese or
// Turkish words. These files were corrupted once (diacritics turned into
// literal "?" characters, e.g. "Suy lu?n"), so this test guards the locale
// dictionaries against that corruption class coming back.

const CORRUPTED_DIACRITIC = /\p{L}\?\p{L}/u;

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (value && typeof value === "object") {
    for (const nested of Object.values(value)) collectStrings(nested, out);
  }
  return out;
}

const localeDictionaries: Array<[string, unknown]> = [
  ["src/i18n/vi.ts", viLocale],
  ["src/i18n/tr.ts", trLocale],
  ["src/components/AISlidePanel/ai-workspace-copy/vi.ts", VI_COPY],
  ["src/components/AISlidePanel/ai-workspace-copy/tr.ts", TR_COPY],
];

describe("locale dictionaries must not contain corrupted diacritics", () => {
  for (const [file, dictionary] of localeDictionaries) {
    it(`${file} has no letter?letter corruption`, () => {
      const offenders = collectStrings(dictionary).filter((text) =>
        CORRUPTED_DIACRITIC.test(text)
      );
      expect(offenders, `corrupted strings found in ${file}`).toEqual([]);
    });
  }
});
