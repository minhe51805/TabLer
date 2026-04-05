import { create } from "zustand";

const STORAGE_KEY = "tabler.startup-commands.v1";

export interface StartupCommandEntry {
  connectionId: string;
  commands: string;
  /** Timeout per command in ms (default 5000). */
  timeoutMs: number;
}

interface StartupCommandsState {
  entries: StartupCommandEntry[];

  getCommands: (connectionId: string) => StartupCommandEntry | undefined;
  setCommands: (connectionId: string, commands: string, timeoutMs?: number) => void;
  removeCommands: (connectionId: string) => void;
  clearAll: () => void;
}

function loadEntries(): StartupCommandEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore
  }
  return [];
}

function saveEntries(entries: StartupCommandEntry[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // ignore
  }
}

export const useStartupCommandsStore = create<StartupCommandsState>((set, get) => ({
  entries: loadEntries(),

  getCommands: (connectionId: string) => {
    return get().entries.find((e) => e.connectionId === connectionId);
  },

  setCommands: (connectionId: string, commands: string, timeoutMs = 5000) => {
    set((state) => {
      const entries = state.entries.filter((e) => e.connectionId !== connectionId);
      if (commands.trim()) {
        entries.push({ connectionId, commands: commands.trim(), timeoutMs });
      }
      saveEntries(entries);
      return { entries };
    });
  },

  removeCommands: (connectionId: string) => {
    set((state) => {
      const entries = state.entries.filter((e) => e.connectionId !== connectionId);
      saveEntries(entries);
      return { entries };
    });
  },

  clearAll: () => {
    saveEntries([]);
    set({ entries: [] });
  },
}));
