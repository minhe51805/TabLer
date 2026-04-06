import { create } from "zustand";
import { persist } from "zustand/middleware";

const MAX_RECENT = 20;

export type SwitcherItemKind =
  | "tab"
  | "table"
  | "saved-query"
  | "connection";

export interface SwitcherItem {
  id: string;
  kind: SwitcherItemKind;
  label: string;
  description?: string;
  icon?: string;
  /** Extra info shown on the right, e.g. connection name */
  meta?: string;
  /** Action to perform when selected */
  action: () => void;
}

interface QuickSwitcherState {
  isOpen: boolean;
  searchQuery: string;
  /** Recently selected item IDs */
  recentItemIds: string[];

  open: () => void;
  close: () => void;
  toggle: () => void;
  setSearchQuery: (query: string) => void;
  addRecentItem: (itemId: string) => void;
  /** Register a set of searchable items */
  registerItems: (items: SwitcherItem[]) => void;
}

function loadRecentIds(): string[] {
  try {
    const raw = window.localStorage.getItem("tabler.recentSwitcherItems");
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return [];
}

function saveRecentIds(ids: string[]) {
  try {
    window.localStorage.setItem("tabler.recentSwitcherItems", JSON.stringify(ids));
  } catch { /* ignore */ }
}

export const useQuickSwitcherStore = create<QuickSwitcherState>()(
  persist(
    (set, get) => ({
      isOpen: false,
      searchQuery: "",
      recentItemIds: loadRecentIds(),

      open: () => set({ isOpen: true, searchQuery: "" }),
      close: () => set({ isOpen: false, searchQuery: "" }),
      toggle: () => {
        const { isOpen } = get();
        set({ isOpen: !isOpen, searchQuery: "" });
      },

      setSearchQuery: (query) => set({ searchQuery: query }),

      addRecentItem: (itemId: string) => {
        const { recentItemIds } = get();
        const filtered = recentItemIds.filter((id) => id !== itemId);
        const next = [itemId, ...filtered].slice(0, MAX_RECENT);
        saveRecentIds(next);
        set({ recentItemIds: next });
      },

      registerItems: () => {
        // No-op: items are passed directly to the component
      },
    }),
    {
      name: "tabler.quickSwitcherStore",
      partialize: (state) => ({ recentItemIds: state.recentItemIds }),
    },
  ),
);

/** Fuzzy search over switcher items. Returns items sorted by score (desc). */
export function fuzzySearch(
  items: SwitcherItem[],
  query: string,
  recentIds: string[],
): SwitcherItem[] {
  if (!query.trim()) {
    // No query: show recents first, then rest
    const seen = new Set(recentIds);
    const recents = items.filter((i) => seen.has(i.id));
    const rest = items.filter((i) => !seen.has(i.id));
    return [...recents, ...rest].slice(0, 50);
  }

  const q = query.toLowerCase();

  const scored = items
    .map((item) => {
      const label = item.label.toLowerCase();
      const desc = (item.description || "").toLowerCase();
      const meta = (item.meta || "").toLowerCase();

      // Score: exact prefix > contains > fuzzy
      let score = 0;
      if (label === q) score = 100;
      else if (label.startsWith(q)) score = 80;
      else if (label.includes(q)) score = 60;
      else if (desc.includes(q)) score = 40;
      else if (meta.includes(q)) score = 30;
      else {
        // Character-by-character fuzzy match
        let qi = 0;
        for (let li = 0; li < label.length && qi < q.length; li++) {
          if (label[li] === q[qi]) qi++;
        }
        if (qi === q.length) score = 20;
      }

      return { item, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.map((s) => s.item).slice(0, 50);
}
