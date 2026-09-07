import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { QueryResult } from "../../../types";

interface DataGridRowSelectionParams {
  canSelectRows: boolean;
  data: QueryResult | null;
  rowIdentities: Array<string | null>;
  filteredTableRowIndices: number[];

  setSelectedRows: Dispatch<SetStateAction<Set<number>>>;
  rowSelectionAnchorRef: RefObject<string | null>;
}

/**
 * Row selection handlers (click / shift-range / ctrl-add and select-all).
 * Handlers are moved verbatim from the grid component body.
 */
export function useDataGridRowSelection({
  canSelectRows,
  data,
  rowIdentities,
  filteredTableRowIndices,

  setSelectedRows,
  rowSelectionAnchorRef,
}: DataGridRowSelectionParams) {

  const handleRowSelection = useCallback(
    (rowIndex: number, event?: Pick<MouseEvent, "shiftKey" | "metaKey" | "ctrlKey">) => {
      if (!canSelectRows || !data?.rows[rowIndex]) return;

      setSelectedRows((previous) => {
        const next = new Set(previous);
        const rowIdentity = rowIdentities[rowIndex];
        const anchor = rowSelectionAnchorRef.current
          ? rowIdentities.indexOf(rowSelectionAnchorRef.current)
          : -1;
        if (!rowIdentity) return next;

        if (event?.shiftKey && anchor >= 0) {
          const start = Math.min(anchor, rowIndex);
          const end = Math.max(anchor, rowIndex);
          next.clear();
          for (let index = start; index <= end; index += 1) {
            next.add(index);
          }
        } else if (event?.metaKey || event?.ctrlKey) {
          if (next.has(rowIndex)) {
            next.delete(rowIndex);
          } else {
            next.add(rowIndex);
          }
          rowSelectionAnchorRef.current = rowIdentity;
        } else {
          const shouldClear = next.size === 1 && next.has(rowIndex);
          next.clear();
          if (!shouldClear) {
            next.add(rowIndex);
          }
          rowSelectionAnchorRef.current = shouldClear ? null : rowIdentity;
        }

        return next;
      });
    },
    [canSelectRows, data, rowIdentities, setSelectedRows],
  );

  const handleToggleSelectAllRows = useCallback(() => {
    if (!canSelectRows || filteredTableRowIndices.length === 0) return;

    setSelectedRows((previous) => {
      if (filteredTableRowIndices.every((rowIndex) => previous.has(rowIndex))) {
        rowSelectionAnchorRef.current = null;
        const next = new Set(previous);
        filteredTableRowIndices.forEach((rowIndex) => next.delete(rowIndex));
        return next;
      }

      const next = new Set(previous);
      filteredTableRowIndices.forEach((rowIndex) => next.add(rowIndex));
      rowSelectionAnchorRef.current = rowIdentities[filteredTableRowIndices[0] ?? -1] ?? null;
      return next;
    });
  }, [canSelectRows, filteredTableRowIndices, rowIdentities, setSelectedRows]);

  return {
    handleRowSelection,
    handleToggleSelectAllRows,
  };
}
