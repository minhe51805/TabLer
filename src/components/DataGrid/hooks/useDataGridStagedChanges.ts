import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { QueryResult } from "../../../types";
import type { StagedChange } from "../../../types/change-tracking";
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

  unstageChange: (id: string) => void;
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
  invalidateTableCaches: (connectionId: string, tableName: string, database?: string) => void;
  refreshTableFromStart: () => Promise<void>;

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

  unstageChange,
  applyTableUpdatesAtomically,
  invalidateTableCaches,
  refreshTableFromStart,

  dataGridInstanceIdRef,
}: DataGridStagedChangesParams) {
  const reconcileStagedChanges = useCallback((nextChanges: typeof stagedChanges) => {
    const currentTableChanges = stagedChanges.filter(
      (change) => change.tableName === tableName && change.database === database && change.type === "update",
    );
    const nextTableChanges = nextChanges.filter(
      (change) => change.tableName === tableName && change.database === database && change.type === "update",
    );

    const applyChanges = (
      rows: QueryResult["rows"],
      changes: typeof stagedChanges,
      direction: "old" | "new",
    ) => {
      for (const change of changes) {
        const rowIndex = rows.findIndex((row) => Object.entries(change.rowKey).every(([columnName, value]) => {
          const columnIndex = resolvedColumns.findIndex((column) => column.name === columnName);
          return columnIndex >= 0 && Object.is(row[columnIndex], value);
        }));
        if (rowIndex < 0) continue;
        for (const [columnName, diff] of Object.entries(change.columns)) {
          const columnIndex = resolvedColumns.findIndex((column) => column.name === columnName);
          if (columnIndex >= 0) rows[rowIndex][columnIndex] = diff[direction] as GridCellValue;
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
  }, [database, resolvedColumns, stagedChanges, tableName]);

  const applyStagedChanges = useCallback(async () => {
    const tableChanges = stagedChanges.filter((c) => c.tableName === tableName && c.database === database);
    if (tableChanges.length === 0) return;

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
    if (updates.length === 0 || tableChanges.some((change) => change.type !== "update")) {
      setError("The edit queue contains an operation that cannot be committed atomically yet.");
      return;
    }

    setIsLoading(true);
    try {
      await applyTableUpdatesAtomically(connectionId, updates);

      // The optimistic queue changes only after the backend transaction commits.
      for (const change of tableChanges) {
        unstageChange(change.id);
      }
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
  }, [applyTableUpdatesAtomically, stagedChanges, tableName, database, connectionId, unstageChange, invalidateTableCaches, refreshTableFromStart, setError]);

  const discardStagedChanges = useCallback(() => {
    const tableChanges = stagedChanges.filter((c) => c.tableName === tableName && c.database === database);
    for (const change of tableChanges) {
      unstageChange(change.id);
    }
    setStagedRowIndices(new Set());
    // Reload original data
    if (tableName) {
      void refreshTableFromStart();
    }
  }, [stagedChanges, tableName, database, unstageChange, refreshTableFromStart]);


  return {
    reconcileStagedChanges,
    applyStagedChanges,
    discardStagedChanges,
  };
}
