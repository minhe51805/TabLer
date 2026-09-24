import { flexRender, type Column, type Table } from "@tanstack/react-table";
import type { VirtualItem } from "@tanstack/react-virtual";
import type { useI18n } from "../../i18n";

type GridColumn = Column<unknown[], unknown>;

interface DataGridTableViewProps {
  table: Table<unknown[]>;
  tableMinWidth: number;
  renderedColumnCount: number;
  leftPinnedColumns: GridColumn[];
  virtualizableColumns: GridColumn[];
  rightPinnedColumns: GridColumn[];
  virtualColumns: VirtualItem[];
  virtualRows: VirtualItem[];
  virtualPaddingTop: number;
  virtualPaddingBottom: number;
  virtualPaddingLeft: number;
  virtualPaddingRight: number;
  columnSizes: Record<string, number>;
  displayedRowIndices: number[];
  selectedRows: Set<number>;
  stagedRowIndices: Set<number>;
  dragSourceIndex: number | null;
  dropTargetIndex: number | null;
  isTableEditable: boolean;
  orderColumn: string | null;
  t: ReturnType<typeof useI18n>["t"];
  onContextMenu: (
    event: React.MouseEvent,
    kind: "header" | "cell" | "row",
    columnId?: string,
    rowIndex?: number,
  ) => void;
  onColumnAutoFit: (colId: string) => void;
  onDragStart: (rowIndex: number) => void;
  onDragOver: (event: React.DragEvent, rowIndex: number) => void;
  onDrop: (event: React.DragEvent, rowIndex: number) => void;
  onDragEnd: () => void;
}

const getVirtualSpacerStyle = (width: number) => ({
  width,
  minWidth: width,
  maxWidth: width,
});

const pinnedColumnStyle = (column: GridColumn) => {
  const pinned = column.getIsPinned();
  if (!pinned) return undefined;
  return {
    position: "sticky" as const,
    left: pinned === "left" ? column.getStart("left") : undefined,
    right: pinned === "right" ? column.getAfter("right") : undefined,
    zIndex: 3,
    background: "var(--bg-primary)",
  };
};

/** Class list for a pinned column cell: marks the pinned side and flags the
 *  outermost pinned column so CSS can draw the freeze divider/shadow. */
function pinnedColumnClasses(
  column: GridColumn,
  leftPinnedColumns: GridColumn[],
  rightPinnedColumns: GridColumn[],
) {
  const pinned = column.getIsPinned();
  if (!pinned) return [] as string[];
  const classes = ["datagrid-pinned", `datagrid-pinned-${pinned}`];
  if (pinned === "left" && leftPinnedColumns[leftPinnedColumns.length - 1]?.id === column.id) {
    classes.push("datagrid-pinned-boundary");
  }
  if (pinned === "right" && rightPinnedColumns[0]?.id === column.id) {
    classes.push("datagrid-pinned-boundary");
  }
  return classes;
}

/** The virtualized <table> body: pinned side columns, center column window,
 *  row window, drag/drop reorder markers, and the context-menu wiring. */
export function DataGridTableView({
  table,
  tableMinWidth,
  renderedColumnCount,
  leftPinnedColumns,
  virtualizableColumns,
  rightPinnedColumns,
  virtualColumns,
  virtualRows,
  virtualPaddingTop,
  virtualPaddingBottom,
  virtualPaddingLeft,
  virtualPaddingRight,
  columnSizes,
  displayedRowIndices,
  selectedRows,
  stagedRowIndices,
  dragSourceIndex,
  dropTargetIndex,
  isTableEditable,
  orderColumn,
  t,
  onContextMenu,
  onColumnAutoFit,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: DataGridTableViewProps) {
  const pinnedClasses = (column: GridColumn) =>
    pinnedColumnClasses(column, leftPinnedColumns, rightPinnedColumns);
  return (
    <table className="datagrid-table" style={{ minWidth: tableMinWidth, tableLayout: "fixed" }}>
      <thead
        className="datagrid-head"
        onContextMenu={(event) => {
          const header = (event.target as HTMLElement).closest("th.datagrid-th");
          const columnId = header?.getAttribute("data-col-id") ?? undefined;
          if (!columnId) return;
          event.preventDefault();
          onContextMenu(event, "header", columnId);
        }}
      >
        {table.getHeaderGroups().map((hg) => (
          <tr key={hg.id}>
            {leftPinnedColumns.map((column) => {
              const header = hg.headers.find((candidate) => candidate.column.id === column.id);
              if (!header) return null;
              const width = columnSizes[column.id] ?? column.getSize();
              return (
                <th
                  className={[
                    "datagrid-th",
                    column.id === "_row_num" ? "datagrid-th-index" : "",
                    ...pinnedClasses(column),
                  ].join(" ")}
                  data-col-id={column.id}
                  style={{ width, minWidth: width, ...pinnedColumnStyle(column) }}
                >
                  <div className="datagrid-th-inner">
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </div>
                </th>
              );
            })}
            {virtualPaddingLeft > 0 && (
              <th
                aria-hidden="true"
                className="datagrid-virtual-column-spacer"
                style={getVirtualSpacerStyle(virtualPaddingLeft)}
              />
            )}
            {virtualColumns.map((virtualColumn) => {
              const column = virtualizableColumns[virtualColumn.index];
              const header = hg.headers.find((candidate) => candidate.column.id === column.id);
              if (!header) return null;
              const width = columnSizes[header.column.id] ?? header.getSize();
              return (
                <th
                  key={header.id}
                  className="datagrid-th"
                  data-col-id={header.column.id}
                  style={{ width, minWidth: width }}
                >
                  <div className="datagrid-th-inner">
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </div>
                  {/* Direct child of the th so absolute right:0 lands on the
                real column boundary, not inside the header padding. */}
                  <div
                    className="datagrid-col-resize-handle"
                    onMouseDown={header.getResizeHandler()}
                    onDoubleClick={() => onColumnAutoFit(header.column.id)}
                    title={t("datagrid.resizeHint")}
                  />
                </th>
              );
            })}
            {virtualPaddingRight > 0 && (
              <th
                aria-hidden="true"
                className="datagrid-virtual-column-spacer"
                style={getVirtualSpacerStyle(virtualPaddingRight)}
              />
            )}
            {rightPinnedColumns.map((column) => {
              const header = hg.headers.find((candidate) => candidate.column.id === column.id);
              if (!header) return null;
              const width = columnSizes[column.id] ?? column.getSize();
              return (
                <th
                  className={["datagrid-th", ...pinnedClasses(column)].join(" ")}
                  data-col-id={column.id}
                  style={{ width, minWidth: width, ...pinnedColumnStyle(column) }}
                >
                  <div className="datagrid-th-inner">
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </div>
                </th>
              );
            })}
          </tr>
        ))}
      </thead>
      <tbody
        onContextMenu={(e) => {
          e.preventDefault();
          const target = e.target as HTMLElement;
          const thEl = target.closest("th.datagrid-th");
          const rowEl = target.closest("tr.datagrid-row");
          if (thEl) {
            const colId = thEl.getAttribute("data-col-id") || undefined;
            onContextMenu(e, "header", colId);
            return;
          }
          if (rowEl) {
            // Always open a menu on a row: prefer cell-scoped actions when
            // the click lands on a data cell, otherwise row-scoped ones.
            // Never fall through silently — that read as "no context menu".
            const cellEl = target.closest("td[data-col-id]");
            const indexEl = rowEl.querySelector(
              ".datagrid-index-selectable, .datagrid-index-value",
            );
            // <tr data-index> carries the 0-based source row index already;
            // only the visible 1-based number inside the index cell needs -1.
            const dataIndexAttr = rowEl.getAttribute("data-index");
            let rowIndex = -1;
            if (dataIndexAttr !== null) {
              rowIndex = Number(dataIndexAttr);
            } else {
              const shown = Number(indexEl?.textContent?.trim() ?? NaN);
              if (Number.isFinite(shown) && shown >= 1) rowIndex = shown - 1;
            }
            const colId = cellEl?.getAttribute("data-col-id") || undefined;
            if (colId && colId !== "_row_num") {
              onContextMenu(e, "cell", colId, rowIndex >= 0 ? rowIndex : undefined);
            } else {
              onContextMenu(e, "row", undefined, rowIndex >= 0 ? rowIndex : undefined);
            }
            return;
          }
          onContextMenu(e, "cell");
        }}
      >
        {virtualPaddingTop > 0 && (
          <tr aria-hidden="true" className="datagrid-virtual-spacer">
            <td colSpan={renderedColumnCount} style={{ height: virtualPaddingTop, padding: 0 }} />
          </tr>
        )}
        {virtualRows.map((virtualRow) => {
          const row = table.getRowModel().rows[virtualRow.index];
          const rowIdx = virtualRow.index;
          const sourceRowIndex = displayedRowIndices[rowIdx] ?? rowIdx;
          return (
            <tr
              key={row.id}
              data-index={sourceRowIndex}
              className={[
                "datagrid-row",
                rowIdx % 2 !== 0 ? "alt" : "",
                selectedRows.has(sourceRowIndex) ? "selected" : "",
                dragSourceIndex === sourceRowIndex ? "dragging" : "",
                dropTargetIndex === sourceRowIndex ? "drop-target" : "",
                isTableEditable && orderColumn ? "datagrid-row-draggable" : "",
                stagedRowIndices.has(sourceRowIndex) ? "staged-change" : "",
              ].join(" ")}
              draggable={isTableEditable && !!orderColumn}
              onDragStart={() => onDragStart(sourceRowIndex)}
              onDragOver={(e) => onDragOver(e, sourceRowIndex)}
              onDrop={(e) => onDrop(e, sourceRowIndex)}
              onDragEnd={onDragEnd}
            >
              {leftPinnedColumns.map((column) => {
                const cell = row
                  .getVisibleCells()
                  .find((candidate) => candidate.column.id === column.id);
                if (!cell) return null;
                const width = columnSizes[column.id] ?? column.getSize();
                return (
                  <td
                    key={cell.id}
                    className={[
                      "datagrid-td",
                      column.id === "_row_num" ? "datagrid-td-index" : "",
                      ...pinnedClasses(column),
                      stagedRowIndices.has(sourceRowIndex) ? "staged-cell" : "",
                    ].join(" ")}
                    data-col-id={column.id}
                    style={{ width, minWidth: width, ...pinnedColumnStyle(column) }}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                );
              })}
              {virtualPaddingLeft > 0 && (
                <td
                  aria-hidden="true"
                  className="datagrid-virtual-column-spacer"
                  style={getVirtualSpacerStyle(virtualPaddingLeft)}
                />
              )}
              {virtualColumns.map((virtualColumn) => {
                const column = virtualizableColumns[virtualColumn.index];
                const cell = row
                  .getVisibleCells()
                  .find((candidate) => candidate.column.id === column.id);
                if (!cell) return null;
                const width = columnSizes[cell.column.id] ?? cell.column.getSize();
                return (
                  <td
                    key={cell.id}
                    className={[
                      "datagrid-td",
                      stagedRowIndices.has(sourceRowIndex) ? "staged-cell" : "",
                    ].join(" ")}
                    data-col-id={column.id}
                    style={{ width, minWidth: width }}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                );
              })}
              {virtualPaddingRight > 0 && (
                <td
                  aria-hidden="true"
                  className="datagrid-virtual-column-spacer"
                  style={getVirtualSpacerStyle(virtualPaddingRight)}
                />
              )}
              {rightPinnedColumns.map((column) => {
                const cell = row
                  .getVisibleCells()
                  .find((candidate) => candidate.column.id === column.id);
                if (!cell) return null;
                const width = columnSizes[column.id] ?? column.getSize();
                return (
                  <td
                    key={cell.id}
                    className={[
                      "datagrid-td",
                      ...pinnedClasses(column),
                      stagedRowIndices.has(sourceRowIndex) ? "staged-cell" : "",
                    ].join(" ")}
                    style={{ width, minWidth: width, ...pinnedColumnStyle(column) }}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                );
              })}
            </tr>
          );
        })}
        {virtualPaddingBottom > 0 && (
          <tr aria-hidden="true" className="datagrid-virtual-spacer">
            <td
              colSpan={renderedColumnCount}
              style={{ height: virtualPaddingBottom, padding: 0 }}
            />
          </tr>
        )}
        {dropTargetIndex !== null && (
          <tr className="datagrid-row drop-indicator">
            <td colSpan={renderedColumnCount}>
              <div className="datagrid-drop-indicator-line" />
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
