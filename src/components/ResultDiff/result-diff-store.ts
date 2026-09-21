import { create } from "zustand";
import type { QueryResult } from "../../types";
import { trackUsage } from "../../utils/usage-counter";

/** Rows kept in a pinned snapshot; larger results are truncated on pin. */
export const PINNED_RESULT_ROW_LIMIT = 5000;

export interface PinnedResult {
  /** Deep-copied snapshot safe against in-place grid edits. */
  result: QueryResult;
  /** Original result object — identity check for "this grid is the pin". */
  source: QueryResult;
  /** Human label: table name or the SQL that produced the result. */
  label: string;
  pinnedAt: number;
  /** True when the snapshot was capped at PINNED_RESULT_ROW_LIMIT. */
  truncatedForDiff: boolean;
}

interface ResultDiffState {
  pinned: PinnedResult | null;
  compare: { a: PinnedResult; b: QueryResult; bLabel: string } | null;
  pin: (result: QueryResult, label: string) => void;
  unpin: () => void;
  openCompare: (current: QueryResult, currentLabel: string) => void;
  closeCompare: () => void;
}

/**
 * Result-diff state: one pinned result snapshot plus the pending comparison.
 * Lives outside tab state so a pin survives re-runs, tab switches, and
 * closing the tab that produced it.
 */
export const useResultDiffStore = create<ResultDiffState>((set, get) => ({
  pinned: null,
  compare: null,
  pin: (result, label) => {
    const truncatedForDiff = result.rows.length > PINNED_RESULT_ROW_LIMIT;
    set({
      pinned: {
        result: {
          ...result,
          columns: result.columns.map((column) => ({ ...column })),
          rows: result.rows.slice(0, PINNED_RESULT_ROW_LIMIT).map((row) => row.slice()),
        },
        source: result,
        label,
        pinnedAt: Date.now(),
        truncatedForDiff,
      },
    });
  },
  unpin: () => set({ pinned: null }),
  openCompare: (current, currentLabel) => {
    const pinned = get().pinned;
    if (!pinned) return;
    trackUsage("diff.result");
    set({ compare: { a: pinned, b: current, bLabel: currentLabel } });
  },
  closeCompare: () => set({ compare: null }),
}));
