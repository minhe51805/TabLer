import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { QueryResult } from "../../../types";
import type { StagedChange } from "../../../types/change-tracking";
import { changeMatchesScope, changeScopeKey } from "../../../stores/change-tracking-store";
import { getCurrentAppLanguage } from "../../../i18n";
import { getDataGridCopy } from "../datagrid-copy";
import type { GridCellValue, ResolvedColumn } from "./useDataGrid";

interface DataGridStagedChangesParams {
  stagedChanges: StagedChange[];
  tableName?: string;
  database?: string;
  connectionId: string;
  resolvedColumns: ResolvedColumn[];

  setData: Dispatch<SetStateAction<QueryResult | null>>;
  setStagedRowIndices: Dispatch<SetStateAction<Set<number>>>;
  setIsLoading: Dispatch<SetStateAction<boolean>>;
  setError: (message: string) => void;

  unstageChanges: (ids: string[]) => void;
  closePreview: () => void;
  applyTableUpdatesAtomically: (
    connectionId: string,
    updates: Array<{
      table: string;
      database?: string;
      target_column: string;
      value: string | number | boolean | null;
      primary_keys: Array<{ column: string; value: string | number | boolean | null }>;
    }>,
  ) => Promise<unknown>;
  insertTableRowsAtomically: (
    connectionId: string,
    rows: Array<{ table: string; database?: string; values: [string, unknown][] }>,
    operationId: string,
  ) => Promise<unknown>;
  invalidateTableCaches: (connectionId: string, tableName: string, database?: string) => void;
  patchLoadedTableCell: (rowIndex: number, colIndex: number, value: GridCellValue) => void;
  refreshTableFromStart: () => Promise<unknown>;

  dataGridInstanceIdRef: RefObject<string>;
}

/**
 * Reconciliation and commit/discard flow for the grid's staged-change queue.
 * Handlers are moved verbatim from the grid component body.
 */
export function useDataGridStagedChanges({
  stagedChanges,
  tableName,
  database,
  connectionId,
  resolvedColumns,

  setData,
  setStagedRowIndices,
  setIsLoading,
  setError,

  unstageChanges,
  closePreview,
  applyTableUpdatesAtomically,
  insertTableRowsAtomically,
  invalidateTableCaches,
  refreshTableFromStart,
  patchLoadedTableCell,

  dataGridInstanceIdRef,
}: DataGridStagedChangesParams) {
  const reconcileStagedChanges = useCallback(
    (nextChanges: typeof stagedChanges) => {
      const scopeKey = tableName ? changeScopeKey(connectionId, database, tableName) : "";
      const currentTableChanges = stagedChanges.filter(
        (change) => scopeKey && changeMatchesScope(change, scopeKey) && change.type === "update",
      );
      const nextTableChanges = nextChanges.filter(
        (change) => scopeKey && changeMatchesScope(change, scopeKey) && change.type === "update",
      );

      const applyChanges = (
        rows: QueryResult["rows"],
        changes: typeof stagedChanges,
        direction: "old" | "new",
      ) => {
        for (const change of changes) {
          const rowIndex = rows.findIndex((row) =>
            Object.entries(change.rowKey).every(([columnName, value]) => {
              const columnIndex = resolvedColumns.findIndex((column) => column.name === columnName);
              return columnIndex >= 0 && Object.is(row[columnIndex], value);
            }),
          );
          if (rowIndex < 0) continue;
          for (const [columnName, diff] of Object.entries(change.columns)) {
            const columnIndex = resolvedColumns.findIndex((column) => column.name === columnName);
            if (columnIndex >= 0) {
              const value = diff[direction] as GridCellValue;
              rows[rowIndex][columnIndex] = value;
              // Keep the paged chunk cache in sync — otherwise scrolling to a
              // cached page resurrects edits that were just undone/redone.
              patchLoadedTableCell(rowIndex, columnIndex, value);
            }
          }
        }
      };

      setData((previous) => {
        if (!previous) return previous;
        const rows = previous.rows.map((row) => [...row]);
        applyChanges(rows, [...currentTableChanges].reverse(), "old");
        applyChanges(rows, nextTableChanges, "new");
        return { ...previous, rows };
      });
      setStagedRowIndices(new Set(nextTableChanges.map((change) => change.rowIndex)));
    },
    [
      connectionId,
      database,
      patchLoadedTableCell,
      resolvedColumns,
      setData,
      setStagedRowIndices,
      stagedChanges,
      tableName,
    ],
  );

  const applyStagedChanges = useCallback(async () => {
    const scopeKey = tableName ? changeScopeKey(connectionId, database, tableName) : "";
    const tableChanges = stagedChanges.filter((c) => scopeKey && changeMatchesScope(c, scopeKey));
    if (tableChanges.length === 0) return;

    if (tableChanges.some((change) => change.type === "delete")) {
      // Only staged deletes are unsupported here — updates and inserts commit
      // fine. Name the actual blocker instead of a vague "not atomic" claim.
      setError(getDataGridCopy(getCurrentAppLanguage()).stagedChanges.deleteNotCommittable);
      return;
    }

    const unresolved = tableChanges.find(
      (change) => change.type !== "delete" && Object.keys(change.columns).length === 0,
    );
    if (unresolved) {
      setError(
        `A staged ${unresolved.type} on ${unresolved.tableName} has no resolved columns — the column map for this connection could not resolve it. Reload the table and re-stage the edit.`,
      );
      return;
    }

    const updates = tableChanges.flatMap((change) => {
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

    // Staged inserts (e.g. duplicated rows): columns are already keyed by
    // column name — the store resolves index keys at stage time.
    const insertRequests = tableChanges
      .filter((change) => change.type === "insert")
      .map((change) => ({
        table: change.tableName,
        database: change.database,
        values: Object.entries(change.columns).map(([column, diff]): [string, unknown] => [
          column,
          diff.new,
        ]),
      }));

    setIsLoading(true);
    try {
      // Updates and inserts commit through separate atomic commands — a mixed
      // queue is not one transaction. Updates run first so a failed insert
      // batch never leaves staged updates half-applied in the queue.
      if (updates.length > 0) {
        await applyTableUpdatesAtomically(connectionId, updates);
      }
      if (insertRequests.length > 0) {
        const operationId = `staged-insert-${Date.now().toString(36)}-${Math.random()
          .toString(36)
          .slice(2, 10)}`;
        await insertTableRowsAtomically(connectionId, insertRequests, operationId);
      }

      // The optimistic queue changes only after the backend transaction commits.
      // One batched unstage = one undo snapshot for the whole apply.
      unstageChanges(tableChanges.map((change) => change.id));

      closePreview();
      setStagedRowIndices(new Set());

      invalidateTableCaches(connectionId, tableName ?? "", database);
      window.dispatchEvent(
        new CustomEvent("table-data-updated", {
          detail: { connectionId, database, tableName, sourceId: dataGridInstanceIdRef.current },
        }),
      );
      await refreshTableFromStart();
    } catch (errorValue) {
      const message = errorValue instanceof Error ? errorValue.message : String(errorValue);
      setError(`No queued edits were committed: ${message}`);
    } finally {
      setIsLoading(false);
    }
  }, [
    stagedChanges,
    setIsLoading,
    tableName,
    database,
    setError,
    applyTableUpdatesAtomically,
    insertTableRowsAtomically,
    connectionId,
    setStagedRowIndices,
    invalidateTableCaches,
    dataGridInstanceIdRef,
    refreshTableFromStart,
    unstageChanges,
    closePreview,
  ]);

  const discardStagedChanges = useCallback(() => {
    const scopeKey = tableName ? changeScopeKey(connectionId, database, tableName) : "";
    const tableChanges = stagedChanges.filter((c) => scopeKey && changeMatchesScope(c, scopeKey));
    // One batched unstage = one undo snapshot for the whole discard.
    unstageChanges(tableChanges.map((change) => change.id));
    setStagedRowIndices(new Set());
    closePreview();
    // Reload original data
    if (tableName) {
      void refreshTableFromStart();
    }
  }, [
    stagedChanges,
    setStagedRowIndices,
    tableName,
    database,
    connectionId,
    unstageChanges,
    refreshTableFromStart,
    closePreview,
  ]);

  return {
    reconcileStagedChanges,
    applyStagedChanges,
    discardStagedChanges,
  };
}
