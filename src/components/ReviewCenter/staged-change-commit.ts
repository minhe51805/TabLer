/**
 * Staged-change commit — applies or discards change-tracking queue entries
 * from outside a DataGrid (the Review Center). Mirrors the atomic commit path
 * in useDataGridStagedChanges: updates go through apply_table_updates_atomically,
 * inserts through insert_table_rows_atomically, and staged deletes are refused
 * (the grid's own apply path rejects them the same way).
 */

import { useChangeTrackingStore } from "../../stores/change-tracking-store";
import { useQueryStore } from "../../stores/queryStore";
import { invalidateTableCaches } from "../DataGrid/hooks/useDataGrid";
import type { ScopedStagedChange } from "../../stores/change-tracking-store";
import type { ReviewCenterCopy } from "./review-center-copy";

/** Tell every open grid/structure view that a table's data changed. */
function notifyTablesChanged(changes: ScopedStagedChange[]): void {
  const seen = new Set<string>();
  for (const change of changes) {
    const connectionId = change.connectionId ?? "";
    const key = `${connectionId}|${change.database ?? ""}|${change.tableName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    invalidateTableCaches(connectionId, change.tableName, change.database);
    window.dispatchEvent(
      new CustomEvent("table-data-updated", {
        detail: {
          connectionId,
          database: change.database,
          tableName: change.tableName,
        },
      }),
    );
  }
}

/**
 * Commit the given staged changes to their databases, then remove them from
 * the queue. Throws (leaving the queue untouched) when the selection contains
 * a delete, an unresolved column set, or a change with no connection.
 */
export async function commitStagedChanges(
  changes: ScopedStagedChange[],
  copy: ReviewCenterCopy["pendingEdits"],
): Promise<void> {
  if (changes.length === 0) return;

  if (changes.some((change) => change.type === "delete")) {
    throw new Error(copy.deleteNotCommittable);
  }
  const unresolved = changes.find((change) => Object.keys(change.columns).length === 0);
  if (unresolved) {
    throw new Error(copy.unresolvedColumns(unresolved.type, unresolved.tableName));
  }

  // Group by connection so each atomic command targets one connection.
  const byConnection = new Map<string, ScopedStagedChange[]>();
  for (const change of changes) {
    const connectionId = change.connectionId ?? "";
    const group = byConnection.get(connectionId) ?? [];
    group.push(change);
    byConnection.set(connectionId, group);
  }

  const { applyTableUpdatesAtomically, insertTableRowsAtomically } = useQueryStore.getState();

  for (const [connectionId, group] of byConnection) {
    if (!connectionId) {
      throw new Error(copy.missingConnection);
    }

    const updates = group.flatMap((change) => {
      if (change.type !== "update") return [];
      const primaryKeys = Object.entries(change.rowKey).map(([column, value]) => ({
        column,
        value: value as string | number | boolean | null,
      }));
      return Object.entries(change.columns).map(([targetColumn, diff]) => ({
        table: change.tableName,
        database: change.database,
        target_column: targetColumn,
        value: diff.new as string | number | boolean | null,
        primary_keys: primaryKeys,
      }));
    });

    const insertRequests = group
      .filter((change) => change.type === "insert")
      .map((change) => ({
        table: change.tableName,
        database: change.database,
        values: Object.entries(change.columns).map(([column, diff]): [string, unknown] => [
          column,
          diff.new,
        ]),
      }));

    // Updates first so a failed insert batch never leaves staged updates
    // half-applied in the queue (same ordering as the grid's apply path).
    if (updates.length > 0) {
      await applyTableUpdatesAtomically(connectionId, updates);
    }
    if (insertRequests.length > 0) {
      const operationId = `review-center-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 10)}`;
      await insertTableRowsAtomically(connectionId, insertRequests, operationId);
    }
  }

  // Commit succeeded — drop the applied entries and refresh affected grids.
  useChangeTrackingStore.getState().unstageChanges(changes.map((change) => change.id));
  notifyTablesChanged(changes);
}

/** Discard staged changes and refresh the affected grids so optimistic
 *  cell values snap back to the committed data. */
export function discardStagedChanges(changes: ScopedStagedChange[]): void {
  if (changes.length === 0) return;
  useChangeTrackingStore.getState().unstageChanges(changes.map((change) => change.id));
  notifyTablesChanged(changes);
}
