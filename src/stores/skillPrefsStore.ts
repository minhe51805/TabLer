import { create } from "zustand";
import { persist } from "zustand/middleware";

interface SkillPrefsState {
  /**
   * Skills the user has explicitly turned OFF. Absence means enabled, so the
   * default (and the behavior for any newly discovered skill) is "available" —
   * the same as Claude Code, where a skill is eligible until you disable it.
   * Storing only the disabled set keeps the store small and forward-compatible.
   */
  disabled: Record<string, boolean>;
  isEnabled: (skillName: string) => boolean;
  setEnabled: (skillName: string, enabled: boolean) => void;
  clearSkillPrefs: () => void;
}

/**
 * Durable per-skill enable/disable control. The injected `<available_skills>`
 * catalog is filtered against this so a user can prune which skills the agent
 * even sees — the opt-in/opt-out surface for skill context cost.
 */
export const useSkillPrefsStore = create<SkillPrefsState>()(
  persist(
    (set, get) => ({
      disabled: {},
      isEnabled: (skillName) => {
        const name = skillName.trim();
        if (!name) return false;
        return get().disabled[name] !== true;
      },
      setEnabled: (skillName, enabled) =>
        set((state) => {
          const name = skillName.trim();
          if (!name) return state;
          const next = { ...state.disabled };
          if (enabled) {
            delete next[name];
          } else {
            next[name] = true;
          }
          return { disabled: next };
        }),
      clearSkillPrefs: () => set({ disabled: {} }),
    }),
    { name: "tabler.ai.skill-prefs.v1" },
  ),
);
