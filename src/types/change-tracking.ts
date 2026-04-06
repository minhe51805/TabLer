/** Types for the change tracking / staging queue system. */

export type ChangeType = "insert" | "update" | "delete";

export interface ChangeColumnDiff {
  old: unknown;
  new: unknown;
}

export interface StagedChange {
  /** Unique ID for this change (nanoid or similar) */
  id: string;
  type: ChangeType;
  tableName: string;
  database?: string;
  rowIndex: number;
  /** Primary key values for the affected row */
  rowKey: Record<string, unknown>;
  /** Columns that changed — key is column name */
  columns: Record<string, ChangeColumnDiff>;
  /** Original row data (all columns) for inserts */
  originalRow?: (string | number | boolean | null)[];
  timestamp: number;
  /** Human-readable SQL preview */
  sqlPreview: string;
}

export interface ChangeTrackingState {
  /** All staged changes pending commit */
  stagedChanges: StagedChange[];
  /** History stack for redo — each entry is a snapshot of stagedChanges */
  history: StagedChange[][];
  /** Whether preview modal is open */
  isPreviewOpen: boolean;
  /** Currently selected change ID in preview */
  selectedChangeId: string | null;
}

export interface ChangeTrackingActions {
  /** Push a new change into the staging queue */
  stageChange: (change: Omit<StagedChange, "id" | "timestamp" | "sqlPreview">) => void;
  /** Remove a specific change from the queue (per-change undo) */
  unstageChange: (id: string) => void;
  /** Clear all staged changes (discard all) */
  discardAll: () => void;
  /** Undo the last batch of changes (per-change undo) */
  undoChange: (id: string) => void;
  /** Redo a previously undone change */
  redoChange: (id: string) => void;
  /** Open the preview modal */
  openPreview: () => void;
  /** Close the preview modal */
  closePreview: () => void;
  /** Select a change in the preview */
  selectChange: (id: string | null) => void;
  /** Apply all staged changes — returns SQL statements to execute */
  getCommitSql: () => string[];
  /** Get the count of staged changes for a specific table */
  getChangeCount: (tableName: string) => number;
  /** Check if a row has pending changes */
  hasPendingChanges: (tableName: string, rowKey: Record<string, unknown>) => boolean;
}

export type ChangeTrackingStore = ChangeTrackingState & ChangeTrackingActions;
