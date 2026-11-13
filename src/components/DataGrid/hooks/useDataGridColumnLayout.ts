import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ColumnOrderState,
  ColumnPinningState,
  Updater,
  VisibilityState,
} from "@tanstack/react-table";
import { getCurrentAppLanguage } from "../../../i18n";
import { getColumnLayout, saveColumnLayout } from "../../../stores/column-layout-store";
import { getColumnWidths, saveColumnWidth } from "../../../stores/column-width-store";
import type { ColumnDetail, QueryResult } from "../../../types";
import { emitAppToast } from "../../../utils/app-toast";
import { getDataGridPowerCopy } from "../datagrid-power-copy";
import type { ColumnDisplayFormat } from "../editors";

/** Minimum width that must remain for scrollable (unpinned) columns. Pinning
 *  that would leave less than this is refused so the grid never becomes a
 *  wall of frozen columns. */
export const MIN_UNPINNED_VIEWPORT_PX = 160;

const ORDER_COLUMN_NAMES = new Set([
  "roworder",
  "sortorder",
  "sortindex",
  "position",
  "seq",
  "sequence",
  "rank",
  "priority",
  "displayorder",
  "itemorder",
  "orderindex",
  "ordering",
  "sortpos",
  "rowno",
  "rownum",
  "ord",
  "order",
]);

export interface UseDataGridColumnLayoutParams {
  connectionId: string;
  tableName?: string;
  database?: string;
  externalResult?: QueryResult;
  structureColumns: ColumnDetail[];
  sortColumn: string | null;
  sortDir: "ASC" | "DESC";
  filterDraft: string;
  tableWrapRef: { current: HTMLDivElement | null };
  columnNamesRef: { current: string[] };
}

/**
 * Column layout persistence (widths, order, visibility, pinning, display formats),
 * drag-order detection, and DOM-measured double-click auto-fit for `<DataGrid />`.
 */
export function useDataGridColumnLayout({
  connectionId,
  tableName,
  database,
  externalResult,
  structureColumns,
  sortColumn,
  sortDir,
  filterDraft,
  tableWrapRef,
  columnNamesRef,
}: UseDataGridColumnLayoutParams) {
  const initialColumnLayoutRef = useRef(getColumnLayout(connectionId, tableName ?? "", database));
  const [columnSizes, setColumnSizes] = useState<Record<string, number>>(() =>
    getColumnWidths(connectionId, tableName ?? "", database),
  );
  const [columnOrder, setColumnOrder] = useState<ColumnOrderState>(
    initialColumnLayoutRef.current.order,
  );
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(
    initialColumnLayoutRef.current.visibility,
  );
  const [columnPinning, setColumnPinning] = useState<ColumnPinningState>(
    initialColumnLayoutRef.current.pinning,
  );
  const [columnDisplayFormats, setColumnDisplayFormats] = useState<
    Record<string, ColumnDisplayFormat>
  >({});
  const [orderColumn, setOrderColumn] = useState<string | null>(null);

  const restorePersistedColumnLayout = useCallback(() => {
    const persisted = getColumnLayout(connectionId, tableName ?? "", database);
    setColumnOrder(persisted.order);
    setColumnVisibility(persisted.visibility);
    setColumnPinning(persisted.pinning);
    setColumnSizes(getColumnWidths(connectionId, tableName ?? "", database));
    return persisted;
  }, [connectionId, database, tableName]);

  useEffect(() => {
    if (!tableName || externalResult) return;
    const timeoutId = window.setTimeout(() => {
      saveColumnLayout(
        connectionId,
        tableName,
        {
          order: columnOrder,
          visibility: columnVisibility,
          pinning: {
            left: columnPinning.left ?? [],
            right: columnPinning.right ?? [],
          },
          sort: sortColumn ? { column: sortColumn, direction: sortDir } : null,
          filter: filterDraft,
        },
        database,
      );
    }, 150);
    return () => window.clearTimeout(timeoutId);
  }, [
    columnOrder,
    columnPinning,
    columnVisibility,
    connectionId,
    database,
    externalResult,
    filterDraft,
    sortColumn,
    sortDir,
    tableName,
  ]);

  // Detect order/sort column on structure load. Match is EXACT on the normalized name.
  useEffect(() => {
    if (structureColumns.length === 0) return;
    const found = structureColumns.find((col) =>
      ORDER_COLUMN_NAMES.has(col.name.toLowerCase().replace(/[^a-z0-9]/g, "")),
    );
    setOrderColumn(found?.name ?? null);
  }, [structureColumns]);

  const handleColumnAutoFit = useCallback(
    (colId: string) => {
      if (colId === "_row_num") return;
      const wrap = tableWrapRef.current;
      if (!wrap) return;

      if (columnNamesRef.current.indexOf(colId) < 0) return;

      const headerEl = wrap.querySelector(`th[data-col-id="${CSS.escape(colId)}"]`);
      const headerWidth = headerEl?.textContent?.length ?? colId.length;
      const headerSize = Math.max(40, headerWidth * 8.5 + 32);

      // Measure content width from rendered cells via data-col-id.
      let maxContentWidth = 0;
      const cellEls = wrap.querySelectorAll<HTMLElement>(
        `.datagrid-row td[data-col-id="${CSS.escape(colId)}"]`,
      );
      cellEls.forEach((el) => {
        const clone = el.cloneNode(true) as HTMLElement;
        clone.style.position = "absolute";
        clone.style.visibility = "hidden";
        clone.style.whiteSpace = "nowrap";
        clone.style.width = "auto";
        clone.style.maxWidth = "none";
        clone.style.overflow = "visible";
        document.body.appendChild(clone);
        maxContentWidth = Math.max(maxContentWidth, clone.scrollWidth);
        document.body.removeChild(clone);
      });

      const newWidth = Math.max(40, Math.max(maxContentWidth + 22, headerSize));
      setColumnSizes((prev) => ({ ...prev, [colId]: newWidth }));
      if (tableName) saveColumnWidth(connectionId, tableName, colId, newWidth, database);
    },
    [columnNamesRef, connectionId, database, tableName, tableWrapRef],
  );

  const handleColumnPinningChange = useCallback(
    (updater: Updater<ColumnPinningState>, getColumnSize: (colId: string) => number) => {
      setColumnPinning((prev) => {
        const next = typeof updater === "function" ? updater(prev) : updater;
        // Pin budget: pinned columns must leave a scrollable sliver.
        const viewportWidth = tableWrapRef.current?.clientWidth ?? 0;
        if (viewportWidth > 0) {
          const pinnedTotal = [...(next.left ?? []), ...(next.right ?? [])].reduce(
            (total, id) => total + getColumnSize(id),
            0,
          );
          if (pinnedTotal > viewportWidth - MIN_UNPINNED_VIEWPORT_PX) {
            emitAppToast({
              title: getDataGridPowerCopy(getCurrentAppLanguage()).pinning.limitToast,
              tone: "info",
            });
            return prev;
          }
        }
        return next;
      });
    },
    [tableWrapRef],
  );

  const handleColumnSizingChange = useCallback(
    (updater: Updater<Record<string, number>>) => {
      setColumnSizes((prev) => {
        const next = typeof updater === "function" ? updater(prev) : updater;
        if (tableName) {
          for (const [colId, width] of Object.entries(next)) {
            if (prev[colId] !== width) {
              saveColumnWidth(connectionId, tableName, colId, width, database);
            }
          }
        }
        return next;
      });
    },
    [connectionId, database, tableName],
  );

  return {
    initialColumnLayoutRef,
    columnSizes,
    setColumnSizes,
    columnOrder,
    setColumnOrder,
    columnVisibility,
    setColumnVisibility,
    columnPinning,
    setColumnPinning,
    columnDisplayFormats,
    setColumnDisplayFormats,
    orderColumn,
    restorePersistedColumnLayout,
    handleColumnAutoFit,
    handleColumnPinningChange,
    handleColumnSizingChange,
  };
}
