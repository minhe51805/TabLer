import { create } from "zustand";

const RECENT_COMMANDS_KEY = "tabler.recentCommands";
const MAX_RECENT = 10;

export interface Command {
  id: string;
  label: string;
  shortcut?: string;
  category: CommandCategory;
  action: () => void;
}

export type CommandCategory =
  | "File"
  | "Edit"
  | "View"
  | "Query"
  | "Database"
  | "AI"
  | "Tools"
  | "Navigation"
  | "Help";

interface CommandPaletteState {
  isOpen: boolean;
  searchQuery: string;
  recentCommandIds: string[];
  allCommands: Command[];

  open: () => void;
  close: () => void;
  toggle: () => void;
  setSearchQuery: (query: string) => void;
  addRecentCommand: (commandId: string) => void;
  registerCommands: (commands: Command[]) => void;
}

function loadRecentCommandIds(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_COMMANDS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.slice(0, MAX_RECENT);
    }
  } catch {
    // ignore
  }
  return [];
}

function saveRecentCommandIds(ids: string[]) {
  try {
    window.localStorage.setItem(RECENT_COMMANDS_KEY, JSON.stringify(ids.slice(0, MAX_RECENT)));
  } catch {
    // ignore
  }
}

export const useCommandPaletteStore = create<CommandPaletteState>((set, get) => ({
  isOpen: false,
  searchQuery: "",
  recentCommandIds: loadRecentCommandIds(),
  allCommands: [],

  open: () => set({ isOpen: true, searchQuery: "" }),
  close: () => set({ isOpen: false, searchQuery: "" }),
  toggle: () => {
    const { isOpen } = get();
    set({ isOpen: !isOpen, searchQuery: isOpen ? "" : "" });
  },

  setSearchQuery: (query) => set({ searchQuery: query }),

  addRecentCommand: (commandId: string) => {
    const { recentCommandIds } = get();
    const filtered = recentCommandIds.filter((id) => id !== commandId);
    const next = [commandId, ...filtered].slice(0, MAX_RECENT);
    saveRecentCommandIds(next);
    set({ recentCommandIds: next });
  },

  registerCommands: (commands: Command[]) => set({ allCommands: commands }),
}));
