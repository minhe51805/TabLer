/**
 * Change Tracking Store — Queue-based staging for DataGrid edits.
 * Replaces immediate SQL execution with a staging queue that can be
 * previewed, applied, or discarded before committing to the database.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { StagedChange, ChangeTrackingState, ChangeTrackingActions } from "../types/change-tracking";
import type { DatabaseType } from "../types/database";

/** Generate a simple unique ID without external deps */
function generateId(): string {
  return `ct_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Escape a value for SQL literal */
function escapeValue(value: unknown, dbType?: DatabaseType): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return String(value);

  const str = String(value);
  const escaped = str.replace(/'/g, "''");

  // MSSQL uses N'...' for unicode
  if (dbType === "mssql") {
    return `N'${escaped}'`;
  }
  return `'${escaped}'`;
}

/** Generate SQL preview for a staged change */
function generateSqlPreview(
  change: Omit<StagedChange, "id" | "timestamp" | "sqlPreview">,
  dbType?: DatabaseType,
): string {
  const { type, tableName, columns, rowKey } = change;

  if (type === "insert") {
    const colNames = Object.keys(columns);
    const colList = colNames.join(", ");
    const valList = colNames.map((c) => escapeValue(columns[c].new, dbType)).join(", ");
    return `INSERT INTO ${tableName} (${colList}) VALUES (${valList});`;
  }

  if (type === "update") {
    const sets = Object.entries(columns)
      .map(([col, { new: newVal }]) => `${col} = ${escapeValue(newVal, dbType)}`)
      .join(", ");
    const where = Object.entries(rowKey)
      .map(([col, val]) => `${col} = ${escapeValue(val, dbType)}`)
      .join(" AND ");
    return `UPDATE ${tableName} SET ${sets} WHERE ${where};`;
  }

  if (type === "delete") {
    const where = Object.entries(rowKey)
      .map(([col, val]) => `${col} = ${escapeValue(val, dbType)}`)
      .join(" AND ");
    return `DELETE FROM ${tableName} WHERE ${where};`;
  }

  return "-- Unknown change type";
}

/** Map index-based column references to actual column names */
function resolveColumnNames(
  columns: Record<string, { old: unknown; new: unknown }>,
  columnNameMap: Record<number, string>,
): Record<string, { old: unknown; new: unknown }> {
  const resolved: Record<string, { old: unknown; new: unknown }> = {};
  for (const [colIdxStr, colDiff] of Object.entries(columns)) {
    const colIdx = Number(colIdxStr);
    const colName = columnNameMap[colIdx];
    if (colName !== undefined) {
      resolved[colName] = colDiff;
    }
  }
  return resolved;
}

interface ChangeTrackingStoreState extends ChangeTrackingState {
  /** Reference to column names map for SQL preview generation */
  _columnNameMap: Record<string, Record<number, string>>;
  /** DB type per table for SQL generation */
  _dbTypeMap: Record<string, DatabaseType | undefined>;
}

interface ChangeTrackingStoreActions extends ChangeTrackingActions {
  /** Set the column name map for a table (needed for SQL preview) */
  setColumnNameMap: (tableName: string, map: Record<number, string>) => void;
  /** Set the DB type for a table */
  setDbType: (tableName: string, dbType: DatabaseType | undefined) => void;
  /** Remove all changes for a specific table */
  clearTableChanges: (tableName: string) => void;
}

export type FullChangeTrackingStore = ChangeTrackingStoreState & ChangeTrackingStoreActions;

export const useChangeTrackingStore = create<FullChangeTrackingStore>()(
  persist(
    (set, get) => ({
      // State
      stagedChanges: [],
      history: [],
      isPreviewOpen: false,
      selectedChangeId: null,
      _columnNameMap: {},
      _dbTypeMap: {},

      // Actions
      stageChange: (change) => {
        const state = get();
        const tableName = change.tableName;
        const dbType = state._dbTypeMap[tableName];

        // Resolve column indices to names for SQL preview
        const columnNameMap = state._columnNameMap[tableName] || {};
        const resolvedColumns = resolveColumnNames(change.columns, columnNameMap);

        const stagedChange: StagedChange = {
          ...change,
          columns: resolvedColumns,
          id: generateId(),
          timestamp: Date.now(),
          sqlPreview: generateSqlPreview({ ...change, columns: resolvedColumns }, dbType),
        };

        set((s) => ({
          stagedChanges: [...s.stagedChanges, stagedChange],
          history: [...s.history, s.stagedChanges],
        }));
      },

      unstageChange: (id) => {
        set((s) => ({
          stagedChanges: s.stagedChanges.filter((c) => c.id !== id),
        }));
      },

      discardAll: () => {
        const state = get();
        set({
          stagedChanges: [],
          history: [...state.history, state.stagedChanges],
        });
      },

      undoChange: (id) => {
        const state = get();
        const changeToUndo = state.stagedChanges.find((c) => c.id === id);
        if (!changeToUndo) return;

        set({
          stagedChanges: state.stagedChanges.filter((c) => c.id !== id),
          history: [...state.history, state.stagedChanges],
        });
      },

      redoChange: () => {
        // Redo is not directly implemented — history is append-only
        // User can re-edit a cell to re-stage the change
      },

      openPreview: () => set({ isPreviewOpen: true }),

      closePreview: () => set({ isPreviewOpen: false, selectedChangeId: null }),

      selectChange: (id) => set({ selectedChangeId: id }),

      getCommitSql: () => {
        const state = get();
        return state.stagedChanges.map((c) => c.sqlPreview);
      },

      getChangeCount: (tableName) => {
        const state = get();
        return state.stagedChanges.filter((c) => c.tableName === tableName).length;
      },

      hasPendingChanges: (tableName, rowKey) => {
        const state = get();
        return state.stagedChanges.some(
          (c) =>
            c.tableName === tableName &&
            Object.entries(rowKey).every(
              ([key, value]) => c.rowKey[key] === value,
            ),
        );
      },

      setColumnNameMap: (tableName, map) => {
        set((s) => ({
          _columnNameMap: { ...s._columnNameMap, [tableName]: map },
        }));
      },

      setDbType: (tableName, dbType) => {
        set((s) => ({
          _dbTypeMap: { ...s._dbTypeMap, [tableName]: dbType },
        }));
      },

      clearTableChanges: (tableName) => {
        const state = get();
        set({
          stagedChanges: state.stagedChanges.filter((c) => c.tableName !== tableName),
          history: [...state.history, state.stagedChanges],
        });
      },
    }),
    {
      name: "tabler.change-tracking",
      // Only persist non-preview state
      partialize: (state) => ({
        stagedChanges: state.stagedChanges,
        history: state.history.slice(-10), // Keep last 10 history entries
      }),
    },
  ),
);

/** Hook to get change count for a specific table */
export function useTableChangeCount(tableName: string): number {
  return useChangeTrackingStore((s) => s.getChangeCount(tableName));
}

/** Hook to check if a row has pending changes */
export function useHasRowChanges(
  tableName: string,
  rowKey: Record<string, unknown>,
): boolean {
  return useChangeTrackingStore((s) => s.hasPendingChanges(tableName, rowKey));
}