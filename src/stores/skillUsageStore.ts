import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface SkillUsageEntry {
  runs: number;
  lastUsedAt: number;
  lastConnectionId: string | null;
}

interface SkillUsageState {
  usage: Record<string, SkillUsageEntry>;
  recordSkillRun: (skillName: string, connectionId?: string | null) => void;
  clearSkillUsage: () => void;
}

/**
 * Durable per-skill usage counters. The workspace-activity ping only shows
 * the latest event in RAM — this store is what makes "is this skill actually
 * useful?" answerable across sessions.
 */
export const useSkillUsageStore = create<SkillUsageState>()(
  persist(
    (set) => ({
      usage: {},
      recordSkillRun: (skillName, connectionId) =>
        set((state) => {
          const name = skillName.trim();
          if (!name) return state;
          const previous = state.usage[name];
          return {
            usage: {
              ...state.usage,
              [name]: {
                runs: (previous?.runs ?? 0) + 1,
                lastUsedAt: Date.now(),
                lastConnectionId: connectionId ?? previous?.lastConnectionId ?? null,
              },
            },
          };
        }),
      clearSkillUsage: () => set({ usage: {} }),
    }),
    { name: "tabler.ai.skill-usage.v1" },
  ),
);
