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
import { buildCsvContent, buildTsvContent } from "../../../utils/export-utils";
import { emitAppToast } from "../../../utils/app-toast";

/** Normalizes a raw cell value for text formats: objects become JSON text so
 *  row/column copies never render "[object Object]". */
function normalizeCellValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  return String(value);
}

/** Clipboard write with the same toast feedback as the toolbar Copy menu. */
async function copyWithToast(content: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(content);
    emitAppToast({ title: `Copied ${label}`, tone: "success" });
  } catch (error) {
    emitAppToast({ title: "Copy failed", description: String(error), tone: "error" });
  }
}

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

  /** Copies the right-clicked row (visible columns, raw values) in the chosen
   *  text format — same serializers the toolbar Copy menu uses. */
  const copyRowAs = (format: "csv" | "tsv" | "json") => {
    const columns = table
      .getAllLeafColumns()
      .filter((column) => column.getIsVisible() && column.id !== "_row_num");
    const row = table.getRowModel().rows[contextMenu.rowIndex ?? 0];
    if (!row) return;
    const names = columns.map((column) => column.id);
    const values = columns.map((column) => normalizeCellValue(row.getValue(column.id)));
    if (format === "json") {
      const obj: Record<string, string | number | boolean | null> = {};
      names.forEach((name, index) => {
        obj[name] = values[index];
      });
      void copyWithToast(JSON.stringify(obj, null, 2), "row as JSON");
    } else {
      const content = format === "csv"
        ? buildCsvContent(names, [values])
        : buildTsvContent(names, [values]);
      void copyWithToast(content, `row as ${format.toUpperCase()}`);
    }
    onClose();
  };

  /** Copies every loaded value of the right-clicked column (current view
   *  order) as a one-column CSV or a plain JSON array. */
  const copyColumnAs = (format: "csv" | "json") => {
    const columnId = contextMenu.colName!;
    const rows = table.getRowModel().rows;
    if (format === "json") {
      const values = rows.map((row) => normalizeCellValue(row.getValue(columnId)));
      void copyWithToast(JSON.stringify(values, null, 2), "column as JSON");
    } else {
      const content = buildCsvContent(
        [columnId],
        rows.map((row) => [normalizeCellValue(row.getValue(columnId))]),
      );
      void copyWithToast(content, "column as CSV");
    }
    onClose();
  };

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
              <button
                className="datagrid-context-menu-item"
                onClick={() => copyColumnAs("csv")}
              >
                Copy column as CSV
              </button>
              <button
                className="datagrid-context-menu-item"
                onClick={() => copyColumnAs("json")}
              >
                Copy column as JSON
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
              <div className="datagrid-context-menu-separator" />
              <div className="datagrid-context-menu-label" style={{ padding: "4px 12px", fontSize: "11px", color: "var(--text-muted)", fontWeight: 600, textTransform: "uppercase" }}>Copy Row As</div>
              <button
                className="datagrid-context-menu-item"
                onClick={() => copyRowAs("csv")}
              >
                CSV
              </button>
              <button
                className="datagrid-context-menu-item"
                onClick={() => copyRowAs("tsv")}
              >
                TSV (spreadsheet)
              </button>
              <button
                className="datagrid-context-menu-item"
                onClick={() => copyRowAs("json")}
              >
                JSON
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
              <div className="datagrid-context-menu-separator" />
              <div className="datagrid-context-menu-label" style={{ padding: "4px 12px", fontSize: "11px", color: "var(--text-muted)", fontWeight: 600, textTransform: "uppercase" }}>Copy Row As</div>
              <button
                className="datagrid-context-menu-item"
                onClick={() => copyRowAs("csv")}
              >
                CSV
              </button>
              <button
                className="datagrid-context-menu-item"
                onClick={() => copyRowAs("tsv")}
              >
                TSV (spreadsheet)
              </button>
              <button
                className="datagrid-context-menu-item"
                onClick={() => copyRowAs("json")}
              >
                JSON
              </button>
            </>
          )}
        </div>

  );
}
