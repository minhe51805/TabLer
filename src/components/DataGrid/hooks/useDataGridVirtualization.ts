import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { Table } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { QueryResult } from "../../../types";
import { MIN_UNPINNED_VIEWPORT_PX } from "./useDataGridColumnLayout";
import { PAGE_SIZE } from "./useDataGrid";

export interface UseDataGridVirtualizationParams<TRow = unknown[]> {
  table: Table<TRow>;
  tableWrapRef: { current: HTMLDivElement | null };
  rowHeight: "small" | "medium" | "large";
  tableName?: string;
  externalResult?: QueryResult;
  isLoading: boolean;
  hasMoreTableRows: boolean;
  displayedRowIndices: number[];
  dataRowsLength: number;
  setCurrentPage: Dispatch<SetStateAction<number>>;
}

/**
 * Row & horizontal-column virtualization, pin budget calculation, infinite-scroll
 * next-page triggers, and statusbar footer portal discovery for `<DataGrid />`.
 */
export function useDataGridVirtualization<TRow = unknown[]>({
  table,
  tableWrapRef,
  rowHeight,
  tableName,
  externalResult,
  isLoading,
  hasMoreTableRows,
  displayedRowIndices,
  dataRowsLength,
  setCurrentPage,
}: UseDataGridVirtualizationParams<TRow>) {
  const estimatedRowHeight = rowHeight === "small" ? 26 : rowHeight === "large" ? 38 : 32;
  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: table.getRowModel().rows.length,
    getScrollElement: () => tableWrapRef.current,
    estimateSize: () => estimatedRowHeight,
    overscan: 12,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const virtualPaddingTop = virtualRows.length > 0 ? virtualRows[0].start : 0;
  const virtualPaddingBottom =
    virtualRows.length > 0
      ? rowVirtualizer.getTotalSize() - virtualRows[virtualRows.length - 1].end
      : 0;

  const leftPinnedColumns = table.getLeftVisibleLeafColumns();
  const virtualizableColumns = table.getCenterVisibleLeafColumns();
  const rightPinnedColumns = table.getRightVisibleLeafColumns();
  const columnVirtualizer = useVirtualizer({
    horizontal: true,
    count: virtualizableColumns.length,
    getScrollElement: () => tableWrapRef.current,
    estimateSize: (index) => virtualizableColumns[index]?.getSize() ?? 150,
    overscan: 3,
  });
  const virtualColumns = columnVirtualizer.getVirtualItems();
  const virtualPaddingLeft = virtualColumns.length > 0 ? virtualColumns[0].start : 0;
  const virtualPaddingRight =
    virtualColumns.length > 0
      ? columnVirtualizer.getTotalSize() - virtualColumns[virtualColumns.length - 1].end
      : 0;
  const pinnedWidth = [...leftPinnedColumns, ...rightPinnedColumns].reduce(
    (total, column) => total + column.getSize(),
    0,
  );
  const tableMinWidth = pinnedWidth + columnVirtualizer.getTotalSize();
  const renderedColumnCount =
    leftPinnedColumns.length +
    virtualColumns.length +
    rightPinnedColumns.length +
    Number(virtualPaddingLeft > 0) +
    Number(virtualPaddingRight > 0);

  /** Remaining pin budget in px: viewport minus already-pinned columns minus
   *  the reserved scrollable sliver. Non-positive disables further pinning. */
  const pinBudgetPx =
    (tableWrapRef.current?.clientWidth ?? 0) - pinnedWidth - MIN_UNPINNED_VIEWPORT_PX;

  useEffect(() => {
    if (!tableName || externalResult || isLoading || !hasMoreTableRows || virtualRows.length === 0)
      return;
    const lastVisibleIndex = virtualRows[virtualRows.length - 1].index;
    const lastVisibleSourceIndex = displayedRowIndices[lastVisibleIndex] ?? lastVisibleIndex;
    if (lastVisibleSourceIndex >= dataRowsLength - Math.max(24, Math.ceil(PAGE_SIZE / 4))) {
      setCurrentPage((page) => page + 1);
    }
  }, [
    dataRowsLength,
    displayedRowIndices,
    externalResult,
    hasMoreTableRows,
    isLoading,
    setCurrentPage,
    tableName,
    virtualRows,
  ]);

  // Footer pills portal into the app statusbar slot when available
  // (table workspace); fall back to the in-grid footer otherwise.
  const [footerPortalTarget, setFooterPortalTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (externalResult) {
      setFooterPortalTarget(null);
      return;
    }
    setFooterPortalTarget(document.getElementById("datagrid-footer-slot"));
  }, [externalResult]);

  return {
    virtualRows,
    virtualPaddingTop,
    virtualPaddingBottom,
    leftPinnedColumns,
    virtualizableColumns,
    rightPinnedColumns,
    virtualColumns,
    virtualPaddingLeft,
    virtualPaddingRight,
    tableMinWidth,
    renderedColumnCount,
    pinBudgetPx,
    footerPortalTarget,
  };
}
