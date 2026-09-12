import { beforeEach, describe, expect, it } from "vitest";
import { useSkillPrefsStore } from "@/stores/skillPrefsStore";

describe("skillPrefsStore", () => {
  beforeEach(() => {
    useSkillPrefsStore.getState().clearSkillPrefs();
  });

  it("treats unknown skills as enabled by default", () => {
    expect(useSkillPrefsStore.getState().isEnabled("git-release")).toBe(true);
  });

  it("disables and re-enables a skill", () => {
    useSkillPrefsStore.getState().setEnabled("git-release", false);
    expect(useSkillPrefsStore.getState().isEnabled("git-release")).toBe(false);
    expect(useSkillPrefsStore.getState().disabled["git-release"]).toBe(true);

    useSkillPrefsStore.getState().setEnabled("git-release", true);
    expect(useSkillPrefsStore.getState().isEnabled("git-release")).toBe(true);
    // Re-enabling deletes the key rather than storing false, keeping it small.
    expect("git-release" in useSkillPrefsStore.getState().disabled).toBe(false);
  });

  it("ignores blank names", () => {
    useSkillPrefsStore.getState().setEnabled("  ", false);
    expect(useSkillPrefsStore.getState().disabled).toEqual({});
    expect(useSkillPrefsStore.getState().isEnabled("   ")).toBe(false);
  });
});
