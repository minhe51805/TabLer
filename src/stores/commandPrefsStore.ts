import { create } from "zustand";
import { persist } from "zustand/middleware";

interface CommandPrefsState {
  /**
   * Commands the user has explicitly turned OFF. Absence means enabled, so any
   * newly discovered command — including one a teammate just added to the
   * repository — is available until the user hides it. This mirrors
   * `skillPrefsStore` deliberately: the two registries behave the same way.
   */
  disabled: Record<string, boolean>;
  isEnabled: (commandName: string) => boolean;
  setEnabled: (commandName: string, enabled: boolean) => void;
  clearCommandPrefs: () => void;
}

/**
 * Durable per-command enable/disable control for the composer's `/` menu.
 *
 * A disabled command is filtered out of the registry, so it is absent from the
 * menu *and* from what the agent is told exists — the same "hides it everywhere"
 * guarantee the skills store gives.
 */
export const useCommandPrefsStore = create<CommandPrefsState>()(
  persist(
    (set, get) => ({
      disabled: {},
      isEnabled: (commandName) => {
        const name = commandName.trim().toLowerCase();
        if (!name) return false;
        return get().disabled[name] !== true;
      },
      setEnabled: (commandName, enabled) =>
        set((state) => {
          const name = commandName.trim().toLowerCase();
          if (!name) return state;
          const next = { ...state.disabled };
          if (enabled) {
            delete next[name];
          } else {
            next[name] = true;
          }
          return { disabled: next };
        }),
      clearCommandPrefs: () => set({ disabled: {} }),
    }),
    { name: "tabler.ai.command-prefs.v1" },
  ),
);
