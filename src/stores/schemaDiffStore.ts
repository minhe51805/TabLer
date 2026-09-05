import { create } from "zustand";

interface SchemaDiffState {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

/** Schema Diff modal visibility (roadmap Phase 2A). */
export const useSchemaDiffStore = create<SchemaDiffState>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}));
