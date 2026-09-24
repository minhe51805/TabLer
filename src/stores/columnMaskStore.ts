/**
 * View-time column masking for the DataGrid (capability-parity A4).
 *
 * `masks` maps a scope key (`connectionId|database|table`) to
 * `column name → anonymizer strategy`. Rules persist across restarts so a
 * sensitive column stays masked the next time the table is opened. `salts`
 * holds one deterministic salt per scope — generated on first mask — so the
 * same value always renders the same masked output (joins/diffs still work).
 *
 * `revealed` is the explicit per-session "show raw values" toggle. It is
 * deliberately excluded from persistence: reopening the app always returns
 * to the masked state.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { generateSalt, type AnonymizerStrategy } from "../utils/anonymizer";

const STORAGE_KEY = "tabler.column-masks";

/** Scope key shared by masks, salts and reveal state. */
export function columnMaskScopeKey(
  connectionId: string,
  database: string | undefined,
  tableName: string,
): string {
  return `${connectionId}|${database ?? ""}|${tableName}`;
}

interface ColumnMaskState {
  /** scopeKey → column name → strategy. Persisted. */
  masks: Record<string, Record<string, AnonymizerStrategy>>;
  /** scopeKey → deterministic salt. Persisted so masked output is stable. */
  salts: Record<string, string>;
  /** scopeKey → column names revealed for this session. Never persisted. */
  revealed: Record<string, string[]>;
}

interface ColumnMaskActions {
  /** Set/replace a column's mask strategy; creates the scope salt on first use. */
  setColumnMask: (scopeKey: string, column: string, strategy: AnonymizerStrategy) => void;
  clearColumnMask: (scopeKey: string, column: string) => void;
  /** Drop every mask + reveal flag for a scope (e.g. "Reset layout"). */
  clearScopeMasks: (scopeKey: string) => void;
  /** Lazily create the scope salt (e.g. masks restored without one). */
  ensureSalt: (scopeKey: string) => void;
  /** Session-only reveal toggle; never written to storage. */
  setRevealed: (scopeKey: string, column: string, revealed: boolean) => void;
}

export type ColumnMaskStore = ColumnMaskState & ColumnMaskActions;

const useColumnMaskBase = create<ColumnMaskStore>()(
  persist(
    (set, get) => ({
      masks: {},
      salts: {},
      revealed: {},

      setColumnMask: (scopeKey, column, strategy) => {
        const salts = get().salts[scopeKey]
          ? get().salts
          : { ...get().salts, [scopeKey]: generateSalt() };
        set((state) => ({
          salts,
          masks: {
            ...state.masks,
            [scopeKey]: { ...state.masks[scopeKey], [column]: strategy },
          },
        }));
      },

      clearColumnMask: (scopeKey, column) => {
        set((state) => {
          const scopeMasks = { ...state.masks[scopeKey] };
          delete scopeMasks[column];
          const scopeRevealed = (state.revealed[scopeKey] ?? []).filter((name) => name !== column);
          return {
            masks: { ...state.masks, [scopeKey]: scopeMasks },
            revealed: { ...state.revealed, [scopeKey]: scopeRevealed },
          };
        });
      },

      ensureSalt: (scopeKey) => {
        if (get().salts[scopeKey]) return;
        set((state) => ({ salts: { ...state.salts, [scopeKey]: generateSalt() } }));
      },

      clearScopeMasks: (scopeKey) => {
        set((state) => {
          const masks = { ...state.masks };
          const revealed = { ...state.revealed };
          delete masks[scopeKey];
          delete revealed[scopeKey];
          return { masks, revealed };
        });
      },

      setRevealed: (scopeKey, column, revealed) => {
        set((state) => {
          const current = state.revealed[scopeKey] ?? [];
          const next = revealed
            ? current.includes(column)
              ? current
              : [...current, column]
            : current.filter((name) => name !== column);
          return { revealed: { ...state.revealed, [scopeKey]: next } };
        });
      },
    }),
    {
      name: STORAGE_KEY,
      // Reveal state is per-session by design — only rules and salts persist.
      partialize: (state) => ({ masks: state.masks, salts: state.salts }),
    },
  ),
);

// Named export to match existing store patterns
export const useColumnMaskStore = useColumnMaskBase;
