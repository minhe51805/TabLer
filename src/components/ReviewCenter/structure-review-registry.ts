/**
 * Structure Review Registry — lets the Review Center see pending structure
 * changes that live inside a mounted TableStructure tab.
 *
 * TableStructure keeps its staged column edits in component state, so it
 * publishes a small entry here while mounted. Only the active workspace tab
 * is mounted, so entries are inherently "the visible structure editors".
 */

import { create } from "zustand";

export interface StructureReviewEntry {
  /** `connectionId|database|tableName` — matches TableStructure's structureKey. */
  key: string;
  connectionId: string;
  tableName: string;
  database?: string;
  /** Number of staged column changes awaiting review. */
  pendingCount: number;
  /** Opens the table's own review panel (ReviewPanel) inside its tab. */
  openReview: () => void;
  /** Runs the snapshot-vs-live schema diff (SchemaDiffReviewPanel flow). */
  openSchemaDiff: () => void;
}

interface StructureReviewRegistryState {
  entries: Record<string, StructureReviewEntry>;
  register: (entry: StructureReviewEntry) => void;
  unregister: (key: string) => void;
}

export const useStructureReviewRegistry = create<StructureReviewRegistryState>((set) => ({
  entries: {},
  register: (entry) => set((s) => ({ entries: { ...s.entries, [entry.key]: entry } })),
  unregister: (key) =>
    set((s) => {
      if (!(key in s.entries)) return s;
      const entries = { ...s.entries };
      delete entries[key];
      return { entries };
    }),
}));
