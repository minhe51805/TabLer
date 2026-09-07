import { create } from "zustand";

export type GlobalSearchMode = "schema" | "data";

interface GlobalSearchState {
  isOpen: boolean;
  mode: GlobalSearchMode;
  open: (mode?: GlobalSearchMode) => void;
  close: () => void;
  setMode: (mode: GlobalSearchMode) => void;
}

/**
 * Global Search overlay state (roadmap Phase 2C, Ctrl+Shift+F).
 * The search runs against the active connection; results live in component
 * state — this store only owns visibility and the active search mode.
 */
export const useGlobalSearchStore = create<GlobalSearchState>((set) => ({
  isOpen: false,
  mode: "schema",
  open: (mode) => set((state) => ({ isOpen: true, mode: mode ?? state.mode })),
  close: () => set({ isOpen: false }),
  setMode: (mode) => set({ mode }),
}));

