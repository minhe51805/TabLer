import { describe, expect, it } from "vitest";
import { en, ko, tr, vi, zh } from "../../src/i18n";

// The SQLEditor AI-edit proposal banner renders `tabs.aiProposal*`. The
// dictionaries are Partial, so an omitted key silently degrades to the English
// fallback (or to the raw key when English is missing too) — which is exactly
// how the banner shipped untranslated. Guard the whole set per locale.

const locales: Array<[string, Record<string, string | undefined>]> = [
  ["en", en as Record<string, string | undefined>],
  ["vi", vi as Record<string, string | undefined>],
  ["zh", zh as Record<string, string | undefined>],
  ["tr", tr as Record<string, string | undefined>],
  ["ko", ko as Record<string, string | undefined>],
];

const proposalKeys = [
  "tabs.aiProposal",
  "tabs.aiProposalAccept",
  "tabs.aiProposalReject",
  "tabs.aiProposalShow",
  "tabs.aiProposalHide",
  "tabs.aiProposalCurrent",
  "tabs.aiProposalProposed",
] as const;

describe("AI edit proposal banner translations", () => {
  for (const [name, dictionary] of locales) {
    it(`${name} defines every tabs.aiProposal* key`, () => {
      for (const key of proposalKeys) {
        const value = dictionary[key];
        expect(value, `${name} is missing ${key}`).toBeTruthy();
        expect(value, `${name} falls back to the raw key ${key}`).not.toBe(key);
      }
    });
  }
});
