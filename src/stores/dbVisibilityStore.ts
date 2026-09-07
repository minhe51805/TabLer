import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { DatabaseInfo } from "../types";

interface DbVisibilityState {
  /** connectionId -> database names hidden from the Explorer */
  hiddenDatabases: Record<string, string[]>;
  setHiddenDatabases: (connectionId: string, names: string[]) => void;
  clearHidden: (connectionId: string) => void;
}

export const useDbVisibilityStore = create<DbVisibilityState>()(
  persist(
    (set) => ({
      hiddenDatabases: {},
      setHiddenDatabases: (connectionId, names) =>
        set((state) => ({
          hiddenDatabases: { ...state.hiddenDatabases, [connectionId]: names },
        })),
      clearHidden: (connectionId) =>
        set((state) => {
          const next = { ...state.hiddenDatabases };
          delete next[connectionId];
          return { hiddenDatabases: next };
        }),
    }),
    { name: "tabler.db-visibility.v1" },
  ),
);

/**
 * Databases that should render in the Explorer for this connection.
 * The database the user is currently connected to is ALWAYS visible,
 * so a mis-tick in the visibility modal can never hide the live session.
 */
export function filterVisibleDatabases(
  connectionId: string | null,
  databases: DatabaseInfo[],
  _currentDatabase: string | null, // legacy param; no longer grants visibility
  hiddenDatabases: Record<string, string[]>,
): DatabaseInfo[] {
  if (!connectionId) return databases;
  const hidden = hiddenDatabases[connectionId];
  if (!hidden || hidden.length === 0) return databases;
  const hiddenSet = new Set(hidden);
  return databases.filter(
    (db) => !hiddenSet.has(db.name),
  );
}

/** Hidden names for a connection (empty when everything is visible). */
export function getHiddenDatabaseNames(
  connectionId: string | null,
  hiddenDatabases: Record<string, string[]>,
): string[] {
  if (!connectionId) return [];
  return hiddenDatabases[connectionId] ?? [];
}