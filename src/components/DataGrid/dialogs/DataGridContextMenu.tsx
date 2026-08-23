import type { Dispatch, SetStateAction } from "react";
import type {
  ColumnOrderState,
  ColumnPinningState,
  Table,
  VisibilityState,
} from "@tanstack/react-table";
import type { ColumnDisplayFormat } from "../editors";
import { clearColumnLayout } from "../../../stores/column-layout-store";
import { clearColumnWidths } from "../../../stores/column-width-store";

export interface DataGridMenuTarget {
  x: number;
  y: number;
  type: "cell" | "header" | "row";
  colName?: string;
  rowIndex?: number;
}

interface DataGridContextMenuProps {
  menu: DataGridMenuTarget;
  connectionId: string;
  database?: string;
  tableName?: string;
  columnDisplayFormats: Record<string, ColumnDisplayFormat>;
  table: Table<unknown[]>;

  onClose: () => void;
  onSortAsc: (colName: string) => void;
  onSortDesc: (colName: string) => void;
  onInsertRow: () => void;
  onDuplicateRowByIndex: (rowIndex: number) => Promise<void>;
  onOpenRowInspector: (rowIndex: number) => void;
  onColumnAutoFit: (colId: string) => void;

  setColumnOrder: Dispatch<SetStateAction<ColumnOrderState>>;
  setColumnPinning: Dispatch<SetStateAction<ColumnPinningState>>;
  setColumnSizes: Dispatch<SetStateAction<Record<string, number>>>;
  setColumnVisibility: Dispatch<SetStateAction<VisibilityState>>;
  setFilterDraft: Dispatch<SetStateAction<string>>;
  setTableFilter: Dispatch<SetStateAction<string>>;
  setSortColumn: Dispatch<SetStateAction<string | null>>;
  setSortDir: Dispatch<SetStateAction<"ASC" | "DESC">>;
  setColumnDisplayFormats: Dispatch<SetStateAction<Record<string, ColumnDisplayFormat>>>;
}

/** Positioned right-click menu for cells, headers and rows. */
export function DataGridContextMenu({
  menu,
  connectionId,
  database,
  tableName,
  columnDisplayFormats,
  table,

  onClose,
  onSortAsc,
  onSortDesc,
  onInsertRow,
  onDuplicateRowByIndex,
  onOpenRowInspector,
  onColumnAutoFit,

  setColumnOrder,
  setColumnPinning,
  setColumnSizes,
  setColumnVisibility,
  setFilterDraft,
  setTableFilter,
  setSortColumn,
  setSortDir,
  setColumnDisplayFormats,
}: DataGridContextMenuProps) {
  const contextMenu = menu;

  return (
        <div
          className="datagrid-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {contextMenu.type === "header" && contextMenu.colName && (
            <>
              <button
                className="datagrid-context-menu-item"
                onClick={() => {
                  onSortAsc(contextMenu.colName!);
                  onClose();
                }}
              >
                Sort ascending
              </button>
              <button
                className="datagrid-context-menu-item"
                onClick={() => {
                  onSortDesc(contextMenu.colName!);
                  onClose();
                }}
              >
                Sort descending
              </button>
              <div className="datagrid-context-menu-separator" />
              <button
                className="datagrid-context-menu-item"
                onClick={() => {
                  void navigator.clipboard.writeText(contextMenu.colName!);
                  onClose();
                }}
              >
                Copy column name
              </button>
              <button
                className="datagrid-context-menu-item"
                onClick={() => {
                  const sql = tableName
                    ? `SELECT ${contextMenu.colName} FROM ${tableName};`
                    : `SELECT ${contextMenu.colName};`;
                  void navigator.clipboard.writeText(sql);
                  onClose();
                }}
              >
                Copy as SELECT
              </button>
              <div className="datagrid-context-menu-separator" />
              <button
                className="datagrid-context-menu-item"
                onClick={() => {
                  onColumnAutoFit(contextMenu.colName!);
                  onClose();
                }}
              >
                Auto-fit column
              </button>
              {contextMenu.colName !== "_row_num" && (
                <>
                  <button
                    className="datagrid-context-menu-item"
                    onClick={() => {
                      table.getColumn(contextMenu.colName!)?.pin("left");
                      onClose();
                    }}
                  >
                    Pin left
                  </button>
                  <button
                    className="datagrid-context-menu-item"
                    onClick={() => {
                      table.getColumn(contextMenu.colName!)?.pin("right");
                      onClose();
                    }}
                  >
                    Pin right
                  </button>
                  <button
                    className="datagrid-context-menu-item"
                    onClick={() => {
                      table.getColumn(contextMenu.colName!)?.pin(false);
                      onClose();
                    }}
                  >
                    Unpin
                  </button>
                  <button
                    className="datagrid-context-menu-item"
                    onClick={() => {
                      const columnId = contextMenu.colName!;
                      setColumnOrder((previous) => {
                        const allIds = table.getAllLeafColumns().map((column) => column.id);
                        const order = previous.length > 0
                          ? [...previous, ...allIds.filter((id) => !previous.includes(id))]
                          : allIds;
                        const index = order.indexOf(columnId);
                        if (index <= 1) return order;
                        [order[index - 1], order[index]] = [order[index], order[index - 1]];
                        return order;
                      });
                      onClose();
                    }}
                  >
                    Move left
                  </button>
                  <button
                    className="datagrid-context-menu-item"
                    onClick={() => {
                      const columnId = contextMenu.colName!;
                      setColumnOrder((previous) => {
                        const allIds = table.getAllLeafColumns().map((column) => column.id);
                        const order = previous.length > 0
                          ? [...previous, ...allIds.filter((id) => !previous.includes(id))]
                          : allIds;
                        const index = order.indexOf(columnId);
                        if (index < 0 || index >= order.length - 1) return order;
                        [order[index], order[index + 1]] = [order[index + 1], order[index]];
                        return order;
                      });
                      onClose();
                    }}
                  >
                    Move right
                  </button>
                  <button
                    className="datagrid-context-menu-item"
                    onClick={() => {
                      table.getColumn(contextMenu.colName!)?.toggleVisibility(false);
                      onClose();
                    }}
                  >
                    Hide column
                  </button>
                </>
              )}
              {table.getAllLeafColumns().some((column) => !column.getIsVisible()) && (
                <button
                  className="datagrid-context-menu-item"
                  onClick={() => {
                    table.toggleAllColumnsVisible(true);
                    onClose();
                  }}
                >
                  Show all columns
                </button>
              )}
              <button
                className="datagrid-context-menu-item"
                onClick={() => {
                  if (tableName) {
                    clearColumnLayout(connectionId, tableName, database);
                    clearColumnWidths(connectionId, tableName, database);
                  }
                  setColumnOrder([]);
                  setColumnVisibility({});
                  setColumnPinning({ left: ["_row_num"], right: [] });
                  setColumnSizes({});
                  setSortColumn(null);
                  setSortDir("ASC");
                  setFilterDraft("");
                  setTableFilter("");
                  onClose();
                }}
              >
                Reset table layout
              </button>
              <div className="datagrid-context-menu-separator" />
              <div className="datagrid-context-menu-label" style={{ padding: "4px 12px", fontSize: "11px", color: "var(--text-muted)", fontWeight: 600, textTransform: "uppercase" }}>Display As</div>
              {(["default", "uuid", "hex", "text", "json"] as ColumnDisplayFormat[]).map((fmt) => (
                <button
                  key={fmt}
                  className="datagrid-context-menu-item"
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
                  onClick={() => {
                     setColumnDisplayFormats(prev => ({ ...prev, [contextMenu.colName!]: fmt }));
                     onClose();
                  }}
                >
                  <span style={{ textTransform: "capitalize" }}>{fmt}</span>
                  {(columnDisplayFormats[contextMenu.colName!] || "default") === fmt && (
                    <span style={{ color: "var(--accent)" }}>✓</span>
                  )}
                </button>
              ))}
            </>
          )}
          {contextMenu.type === "row" && (
            <>
              <button
                className="datagrid-context-menu-item"
                onClick={() => {
                  onOpenRowInspector(contextMenu.rowIndex ?? 0);
                  onClose();
                }}
              >
                Inspect row
              </button>
              <button
                className="datagrid-context-menu-item"
                onClick={() => {
                  void onDuplicateRowByIndex(contextMenu.rowIndex ?? 0);
                  onClose();
                }}
              >
                Duplicate row
              </button>
            </>
          )}
          {contextMenu.type === "cell" && (
            <>
              <button
                className="datagrid-context-menu-item"
                onClick={() => {
                  onInsertRow();
                  onClose();
                }}
              >
                Add row
              </button>
            </>
          )}
        </div>

  );
}
