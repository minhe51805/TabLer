/**
 * Change Tracking Store — Queue-based staging for DataGrid edits.
 * Replaces immediate SQL execution with a staging queue that can be
 * previewed, applied, or discarded before committing to the database.
 */

import { create } from "zustand";
import type {
  StagedChange,
  ChangeTrackingState,
  ChangeTrackingActions,
} from "../types/change-tracking";
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

/**
 * Scope key identifying one grid's table: `connectionId|database|tableName`.
 * Two connections (or databases) can expose same-named tables — keying the
 * column maps and undo history by this scope keeps edits from resolving
 * through another connection's column layout.
 */
export function changeScopeKey(
  connectionId: string,
  database: string | undefined,
  tableName: string,
): string {
  return `${connectionId}|${database ?? ""}|${tableName}`;
}

/** Scope key for a staged change; changes staged without a connection id keep
 *  a `|db|table` scope so they remain matchable by suffix. */
function scopeKeyForChange(change: {
  connectionId?: string;
  database?: string;
  tableName: string;
}): string {
  return changeScopeKey(change.connectionId ?? "", change.database, change.tableName);
}

/** True when a staged change belongs to the given scope. Unscoped changes
 *  (no connectionId, e.g. generated seed rows) match any connection that
 *  shares the same `|db|table` tail. */
export function changeMatchesScope(
  change: { connectionId?: string; database?: string; tableName: string },
  scopeKey: string,
): boolean {
  if (change.connectionId) return scopeKeyForChange(change) === scopeKey;
  const suffix = `|${change.database ?? ""}|${change.tableName}`;
  return scopeKey === suffix || scopeKey.endsWith(suffix);
}

/** Map index-based column references to actual column names. A numeric key
 *  that has no entry in the map is a hard failure: silently dropping it would
 *  stage an update that commits nothing (or worse, resolve through a stale
 *  map from another connection's same-named table). */
function resolveColumnNames(
  columns: Record<string, { old: unknown; new: unknown }>,
  columnNameMap: Record<number, string>,
  tableName: string,
): Record<string, { old: unknown; new: unknown }> {
  const resolved: Record<string, { old: unknown; new: unknown }> = {};
  for (const [colKey, colDiff] of Object.entries(columns)) {
    const colIdx = Number(colKey);
    if (Number.isInteger(colIdx) && colIdx >= 0 && String(colIdx) === colKey) {
      const colName = columnNameMap[colIdx];
      if (colName === undefined) {
        throw new Error(
          `Cannot resolve column #${colIdx} for ${tableName}: the column map for this connection is missing that index. Reload the table and try again.`,
        );
      }
      resolved[colName] = colDiff;
    } else {
      // Already keyed by column name (e.g. staged inserts).
      resolved[colKey] = colDiff;
    }
  }
  return resolved;
}

/** A staged change as stored internally: `connectionId` is optional so
 *  producers that predate scoping still type-check, but every grid edit
 *  should carry it. */
export type ScopedStagedChange = StagedChange & { connectionId?: string };

/** Input accepted by stageChange/stageChanges. */
export type StagedChangeInput = Omit<ScopedStagedChange, "id" | "timestamp" | "sqlPreview">;

interface ChangeTrackingStoreState extends Omit<
  ChangeTrackingState,
  "history" | "future" | "stagedChanges"
> {
  stagedChanges: ScopedStagedChange[];
  /** Undo snapshots per scope key — each entry is that scope's staged
   *  changes before a mutation, so undo in table A can never revert staged
   *  edits in table B. */
  history: Record<string, ScopedStagedChange[][]>;
  /** Redo snapshots per scope key. */
  future: Record<string, ScopedStagedChange[][]>;
  /** Reference to column names map per scope for SQL preview generation */
  _columnNameMap: Record<string, Record<number, string>>;
  /** DB type per scope for SQL generation */
  _dbTypeMap: Record<string, DatabaseType | undefined>;
}

interface ChangeTrackingStoreActions extends Omit<
  ChangeTrackingActions,
  | "stageChange"
  | "stageChanges"
  | "undoChange"
  | "redoChange"
  | "undoLast"
  | "redoLast"
  | "discardAll"
  | "getChangeCount"
  | "hasPendingChanges"
> {
  stageChange: (change: StagedChangeInput) => void;
  stageChanges: (changes: StagedChangeInput[]) => void;
  /** Remove several staged changes as ONE undo step (used by apply/discard). */
  unstageChanges: (ids: string[]) => void;
  /** Remove a specific change from the queue (per-change undo) */
  undoChange: (id: string) => void;
  /** Redo the last undone batch for a scope */
  redoChange: (scopeKey: string) => void;
  /** Restore the previous queue snapshot for a scope. */
  undoLast: (scopeKey: string) => ScopedStagedChange[] | null;
  /** Restore the next queue snapshot for a scope. */
  redoLast: (scopeKey: string) => ScopedStagedChange[] | null;
  /** Discard every staged change in a scope as one undo step. */
  discardAll: (scopeKey: string) => void;
  /** Get the count of staged changes for a scope */
  getChangeCount: (scopeKey: string) => number;
  /** Undo depth for a scope (drives the toolbar badge). */
  getUndoCount: (scopeKey: string) => number;
  /** Redo depth for a scope. */
  getRedoCount: (scopeKey: string) => number;
  /** Check if a row has pending changes in a scope */
  hasPendingChanges: (scopeKey: string, rowKey: Record<string, unknown>) => boolean;
  /** Set the column name map for a scope (needed for SQL preview) */
  setColumnNameMap: (scopeKey: string, map: Record<number, string>) => void;
  /** Set the DB type for a scope */
  setDbType: (scopeKey: string, dbType: DatabaseType | undefined) => void;
  /** Remove all changes for a specific scope */
  clearTableChanges: (scopeKey: string) => void;
}

export type FullChangeTrackingStore = ChangeTrackingStoreState & ChangeTrackingStoreActions;

/** Column map for a scope; unscoped `|db|table` keys fall back to a unique
 *  suffix match, then to a legacy bare-tableName registration (producers
 *  that predate scoping, e.g. seed-row staging). */
function lookupColumnNameMap(
  maps: Record<string, Record<number, string>>,
  scopeKey: string,
  tableName: string,
): Record<number, string> | undefined {
  const direct = maps[scopeKey];
  if (direct) return direct;
  const matches = Object.keys(maps).filter((key) => key.endsWith(scopeKey));
  if (matches.length === 1) return maps[matches[0]];
  return maps[tableName];
}

export const useChangeTrackingStore = create<FullChangeTrackingStore>()((set, get) => ({
  // State
  stagedChanges: [],
  history: {},
  future: {},
  isPreviewOpen: false,
  selectedChangeId: null,
  _columnNameMap: {},
  _dbTypeMap: {},

  // Actions
  stageChange: (change) => {
    get().stageChanges([change]);
  },

  stageChanges: (changes) => {
    if (changes.length === 0) return;
    const state = get();
    const timestamp = Date.now();
    const stagedBatch = changes.map((change): ScopedStagedChange => {
      const scopeKey = scopeKeyForChange(change);
      const dbType = state._dbTypeMap[scopeKey] ?? state._dbTypeMap[change.tableName];
      const columnNameMap =
        lookupColumnNameMap(state._columnNameMap, scopeKey, change.tableName) ?? {};
      const resolvedColumns = resolveColumnNames(change.columns, columnNameMap, change.tableName);
      return {
        ...change,
        columns: resolvedColumns,
        id: generateId(),
        timestamp,
        sqlPreview: generateSqlPreview({ ...change, columns: resolvedColumns }, dbType),
      };
    });

    set((s) => {
      const history = { ...s.history };
      const future = { ...s.future };
      for (const scopeKey of new Set(stagedBatch.map(scopeKeyForChange))) {
        history[scopeKey] = [
          ...(history[scopeKey] ?? []),
          s.stagedChanges.filter((c) => changeMatchesScope(c, scopeKey)),
        ];
        future[scopeKey] = [];
      }
      return {
        stagedChanges: [...s.stagedChanges, ...stagedBatch],
        history,
        future,
      };
    });
  },

  unstageChange: (id) => {
    get().unstageChanges([id]);
  },

  unstageChanges: (ids) => {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    set((s) => {
      const removed = s.stagedChanges.filter((c) => idSet.has(c.id));
      if (removed.length === 0) return s;
      const next = s.stagedChanges.filter((c) => !idSet.has(c.id));
      const history = { ...s.history };
      const future = { ...s.future };
      for (const scopeKey of new Set(removed.map(scopeKeyForChange))) {
        history[scopeKey] = [
          ...(history[scopeKey] ?? []),
          s.stagedChanges.filter((c) => changeMatchesScope(c, scopeKey)),
        ];
        future[scopeKey] = [];
      }
      return { stagedChanges: next, history, future };
    });
  },

  discardAll: (scopeKey) => {
    set((s) => {
      const scoped = s.stagedChanges.filter((c) => changeMatchesScope(c, scopeKey));
      if (scoped.length === 0) return s;
      return {
        stagedChanges: s.stagedChanges.filter((c) => !changeMatchesScope(c, scopeKey)),
        history: { ...s.history, [scopeKey]: [...(s.history[scopeKey] ?? []), scoped] },
        future: { ...s.future, [scopeKey]: [] },
      };
    });
  },

  undoChange: (id) => {
    get().unstageChanges([id]);
  },

  redoChange: (scopeKey) => {
    get().redoLast(scopeKey);
  },

  undoLast: (scopeKey) => {
    const state = get();
    const stack = state.history[scopeKey];
    const previous = stack?.[stack.length - 1];
    if (!previous) return null;
    const current = state.stagedChanges.filter((c) => changeMatchesScope(c, scopeKey));
    set({
      stagedChanges: [
        ...state.stagedChanges.filter((c) => !changeMatchesScope(c, scopeKey)),
        ...previous,
      ],
      history: { ...state.history, [scopeKey]: stack.slice(0, -1) },
      future: { ...state.future, [scopeKey]: [...(state.future[scopeKey] ?? []), current] },
    });
    return previous;
  },

  redoLast: (scopeKey) => {
    const state = get();
    const stack = state.future[scopeKey];
    const next = stack?.[stack.length - 1];
    if (!next) return null;
    const current = state.stagedChanges.filter((c) => changeMatchesScope(c, scopeKey));
    set({
      stagedChanges: [
        ...state.stagedChanges.filter((c) => !changeMatchesScope(c, scopeKey)),
        ...next,
      ],
      history: { ...state.history, [scopeKey]: [...(state.history[scopeKey] ?? []), current] },
      future: { ...state.future, [scopeKey]: stack.slice(0, -1) },
    });
    return next;
  },

  openPreview: () => set({ isPreviewOpen: true }),

  closePreview: () => set({ isPreviewOpen: false, selectedChangeId: null }),

  selectChange: (id) => set({ selectedChangeId: id }),

  getCommitSql: () => {
    const state = get();
    return state.stagedChanges.map((c) => c.sqlPreview);
  },

  getChangeCount: (scopeKey) => {
    const state = get();
    return state.stagedChanges.filter((c) => changeMatchesScope(c, scopeKey)).length;
  },

  getUndoCount: (scopeKey) => get().history[scopeKey]?.length ?? 0,

  getRedoCount: (scopeKey) => get().future[scopeKey]?.length ?? 0,

  hasPendingChanges: (scopeKey, rowKey) => {
    const state = get();
    return state.stagedChanges.some(
      (c) =>
        changeMatchesScope(c, scopeKey) &&
        Object.entries(rowKey).every(([key, value]) => c.rowKey[key] === value),
    );
  },

  setColumnNameMap: (scopeKey, map) => {
    set((s) => ({
      _columnNameMap: { ...s._columnNameMap, [scopeKey]: map },
    }));
  },

  setDbType: (scopeKey, dbType) => {
    set((s) => ({
      _dbTypeMap: { ...s._dbTypeMap, [scopeKey]: dbType },
    }));
  },

  clearTableChanges: (scopeKey) => {
    get().discardAll(scopeKey);
  },
}));

/** Hook to get change count for a specific table scope */
export function useTableChangeCount(scopeKey: string): number {
  return useChangeTrackingStore((s) => s.getChangeCount(scopeKey));
}

/** Hook to check if a row has pending changes */
export function useHasRowChanges(scopeKey: string, rowKey: Record<string, unknown>): boolean {
  return useChangeTrackingStore((s) => s.hasPendingChanges(scopeKey, rowKey));
}
