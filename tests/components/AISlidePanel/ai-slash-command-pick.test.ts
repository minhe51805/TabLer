import { describe, expect, it } from "vitest";
import panelSource from "@/components/AISlidePanel/AISlidePanel.tsx?raw";
import slashMenuSource from "@/components/AISlidePanel/hooks/use-ai-slash-menu.ts?raw";

/**
 * Pin for the 2026-09-17 report: picking a command from the "/" menu looked like
 * a dead click on the commands the old `runSlashCommand` did not special-case
 * (`/help`, `/schema`, `/review-sql`, …) — it cleared the draft and ran nothing.
 *
 * The contract now: picking parks the command in the composer and the user's own
 * Enter runs it through the single send path (`handleGenerate`), which is what
 * expands file-backed runbooks and applies `/backup`, `/compact`, `/rollback`.
 * Only `/rollback` acts on the pick, because its checkpoint picker is the
 * confirmation. `ai-slash-commands.test.ts` covers the classification; this file
 * covers the wiring, which no unit test can reach without mounting the whole
 * panel. The pick handler itself lives in `use-ai-slash-menu.ts`; the panel
 * only forwards it to the view model.
 */
describe("AISlidePanel slash-command pick wiring", () => {
  // Prettier owns the layout, so compare whitespace-insensitively: the pin is
  // which call happens, not how it wraps.
  const flattened = panelSource.replace(/\s+/g, " ");
  const hookFlattened = slashMenuSource.replace(/\s+/g, " ");

  it("wires the menu's pick handler to the composer-committing callback", () => {
    expect(flattened).toContain("onSelectSlashCommand: commitSlashCommand");
  });

  it("keeps Enter and Tab in the menu on the committing path, never a direct run", () => {
    expect(flattened).toContain("commitSlashCommand(slashMatches[activeIndex].name)");
    // The old handler cleared the draft and ran whatever it recognised, which is
    // exactly the "nothing happened" bug this pins shut.
    expect(flattened).not.toContain("runSlashCommand(");
    expect(hookFlattened).not.toContain("runSlashCommand(");
  });

  it("dismisses the menu for the inserted draft so it cannot reopen over the caret", () => {
    // `/help` parked in the composer still matches the "/<letters>" search
    // prefix, so without this flag the menu would immediately cover the caret.
    const commit = hookFlattened.slice(hookFlattened.indexOf("const commitSlashCommand"));
    expect(commit.slice(0, 400)).toContain("setSlashDismissed(true)");
  });

  it("puts the caret after the inserted command so the next key types an argument", () => {
    expect(hookFlattened).toContain("composer.setSelectionRange(draft.length, draft.length)");
  });
});
