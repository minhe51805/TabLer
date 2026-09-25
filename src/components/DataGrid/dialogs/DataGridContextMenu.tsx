import type { Dispatch, SetStateAction } from "react";
import type {
  ColumnOrderState,
  ColumnPinningState,
  Table,
  VisibilityState,
} from "@tanstack/react-table";
import type { ColumnDisplayFormat } from "../editors";
import { ChevronRight, FileCode, FileJson, FileSpreadsheet, Table2 } from "lucide-react";
import { clearColumnLayout } from "../../../stores/column-layout-store";
import { clearColumnWidths } from "../../../stores/column-width-store";
import {
  buildCsvContent,
  buildMarkdownTableContent,
  buildTsvContent,
} from "../../../utils/export-utils";
import { buildMqlContent } from "../../../utils/export-mql";
import { generateInsertSql } from "../../../utils/sql-generator";
import { emitAppToast } from "../../../utils/app-toast";
import { getCurrentAppLanguage, translateCurrent } from "../../../i18n";
import { getDataGridPowerCopy } from "../datagrid-power-copy";
import type { ResolvedColumn } from "../hooks/useDataGrid";
import type { DatabaseType } from "../../../types/database";
import { getDataGridMaskingCopy } from "../datagrid-masking-copy";
import { useColumnMaskStore } from "../../../stores/columnMaskStore";
import { defaultMaskStrategy, type DataGridColumnMasks } from "../hooks/useDataGridColumnMasks";
import type { AnonymizerStrategy } from "../../../utils/anonymizer";

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
    emitAppToast({
      title: translateCurrent("datagrid.ctxCopied", { target: label }),
      tone: "success",
    });
  } catch (error) {
    emitAppToast({
      title: translateCurrent("datagrid.copyFailed"),
      description: String(error),
      tone: "error",
    });
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
  /** Dialect for INSERT generation; undefined falls back to standard quoting. */
  dbType?: DatabaseType;
  /** Source-indexed selected rows (data.rows indices) for selection copy. */
  selectedRows?: Set<number>;
  /** Raw rows in data.rows order — context-menu rowIndex is a source index. */
  sourceRows: (string | number | boolean | null)[][];
  /** Resolved columns aligned with sourceRows cells. */
  resolvedColumns: ResolvedColumn[];
  /** Runs aggregate stats for a header column (table-backed grids only). */
  onColumnStats?: (colName: string) => void;

  onClose: () => void;
  onSortAsc: (colName: string) => void;
  onSortDesc: (colName: string) => void;
  onInsertRow: () => void;
  onDuplicateRowByIndex: (rowIndex: number) => Promise<void>;
  onOpenRowInspector: (rowIndex: number) => void;
  onColumnAutoFit: (colId: string) => void;
  /** Cells covered by the active multi-cell selection; >1 enables bulk edit. */
  selectedRangeCellCount?: number;
  /** Opens the "Set selected cells to…" dialog (staged updates). */
  onSetRangeValue?: () => void;
  /** Remaining px budget for pinning; non-positive disables pin actions. */
  pinBudgetPx?: number;

  setColumnOrder: Dispatch<SetStateAction<ColumnOrderState>>;
  setColumnPinning: Dispatch<SetStateAction<ColumnPinningState>>;
  setColumnSizes: Dispatch<SetStateAction<Record<string, number>>>;
  setColumnVisibility: Dispatch<SetStateAction<VisibilityState>>;
  setFilterDraft: Dispatch<SetStateAction<string>>;
  setTableFilter: Dispatch<SetStateAction<string>>;
  setSortColumn: Dispatch<SetStateAction<string | null>>;
  setSortDir: Dispatch<SetStateAction<"ASC" | "DESC">>;
  setColumnDisplayFormats: Dispatch<SetStateAction<Record<string, ColumnDisplayFormat>>>;
  /** View-time column masking state; absent on query-result grids. */
  columnMasks?: DataGridColumnMasks;
}

/** Positioned right-click menu for cells, headers and rows. */
export function DataGridContextMenu({
  menu,
  connectionId,
  database,
  tableName,
  columnDisplayFormats,
  table,
  dbType,
  selectedRows,
  sourceRows,
  resolvedColumns,
  onColumnStats,

  onClose,
  onSortAsc,
  onSortDesc,
  onInsertRow,
  onDuplicateRowByIndex,
  onOpenRowInspector,
  onColumnAutoFit,
  selectedRangeCellCount,
  onSetRangeValue,
  pinBudgetPx,

  setColumnOrder,
  setColumnPinning,
  setColumnSizes,
  setColumnVisibility,
  setFilterDraft,
  setTableFilter,
  setSortColumn,
  setSortDir,
  setColumnDisplayFormats,
  columnMasks,
}: DataGridContextMenuProps) {
  const contextMenu = menu;

  const powerCopy = getDataGridPowerCopy(getCurrentAppLanguage());
  const maskingCopy = getDataGridMaskingCopy(getCurrentAppLanguage());
  const setColumnMask = useColumnMaskStore((state) => state.setColumnMask);
  const clearColumnMask = useColumnMaskStore((state) => state.clearColumnMask);
  const setMaskRevealed = useColumnMaskStore((state) => state.setRevealed);
  const maskScopeKey = columnMasks?.scopeKey ?? "";
  const contextColumn = resolvedColumns.find((column) => column.name === contextMenu.colName);
  const contextColumnIsPk = contextColumn?.is_primary_key === true;

  /** Copies the right-clicked row — or the whole row selection when the
   *  clicked row is part of it — in the chosen text format. Values come from
   *  sourceRows because contextMenu.rowIndex is a data.rows index (the table
   *  row model can be filtered/sorted differently). */
  const copyRowAs = async (format: "csv" | "tsv" | "json" | "mql" | "markdown" | "insert") => {
    const columns = table
      .getAllLeafColumns()
      .filter((column) => column.getIsVisible() && column.id !== "_row_num");
    const names = columns.map((column) => column.id);
    const indexByName = new Map(resolvedColumns.map((column, index) => [column.name, index]));
    const clickedIndex = contextMenu.rowIndex ?? 0;
    const indices =
      selectedRows && selectedRows.size > 1 && selectedRows.has(clickedIndex)
        ? Array.from(selectedRows).sort((a, b) => a - b)
        : [clickedIndex];
    const rows = indices
      .map((index) => sourceRows[index])
      .filter((row): row is (string | number | boolean | null)[] => row !== undefined);
    if (rows.length === 0) return;
    // Masked columns must copy masked values — mask before serializing.
    const maskedRows = columnMasks ? await columnMasks.maskRows(rows) : rows;
    const values = maskedRows.map((row) =>
      names.map((name) => normalizeCellValue(row[indexByName.get(name) ?? -1])),
    );
    const label = rows.length > 1 ? `${rows.length} rows` : "row";
    if (format === "json") {
      const objects = values.map((rowValues) => {
        const obj: Record<string, string | number | boolean | null> = {};
        names.forEach((name, index) => {
          obj[name] = rowValues[index];
        });
        return obj;
      });
      const content =
        rows.length > 1 ? JSON.stringify(objects, null, 2) : JSON.stringify(objects[0], null, 2);
      void copyWithToast(content, `${label} as JSON`);
    } else if (format === "mql") {
      const script = buildMqlContent({
        collectionName: tableName,
        databaseName: database,
        columns: names,
        rows: values,
      });
      void copyWithToast(script, `${label} as MQL`);
    } else if (format === "markdown") {
      void copyWithToast(buildMarkdownTableContent(names, values), `${label} as Markdown`);
    } else if (format === "insert") {
      if (!tableName) return;
      void copyWithToast(generateInsertSql(tableName, names, values, dbType), `${label} as INSERT`);
    } else {
      const content =
        format === "csv" ? buildCsvContent(names, values) : buildTsvContent(names, values);
      void copyWithToast(content, `${label} as ${format.toUpperCase()}`);
    }
    onClose();
  };

  /** Copies the right-clicked cell's raw value (objects serialize as JSON
   *  text, NULL stays "NULL" — matching the grid's cell copy shortcut). */
  const copyCellValue = () => {
    const columnId = contextMenu.colName;
    const row = table.getRowModel().rows[contextMenu.rowIndex ?? 0];
    if (!columnId || !row) return;
    const raw = normalizeCellValue(row.getValue(columnId));
    void (async () => {
      const value = columnMasks ? await columnMasks.maskValue(columnId, raw) : raw;
      try {
        await navigator.clipboard.writeText(value === null ? "NULL" : String(value));
        emitAppToast({
          title: translateCurrent("datagrid.ctxCellValueCopied"),
          tone: "success",
        });
      } catch (error) {
        emitAppToast({
          title: translateCurrent("datagrid.copyFailed"),
          description: String(error),
          tone: "error",
        });
      }
    })();
    onClose();
  };

  /** Reusable "Copy As" flyout — the format picker from the toolbar Copy
   *  menu (icon + label + hint per format). */
  const copyAsSubmenu = (scope: "row" | "cell") => (
    <div className="datagrid-context-menu datagrid-context-submenu">
      <button
        type="button"
        className="datagrid-export-menu-item"
        onClick={() => void copyRowAs("csv")}
      >
        <FileSpreadsheet className="!w-3.5 !h-3.5" />
        <span className="datagrid-export-menu-copy">
          <strong>CSV</strong>
          <span>{translateCurrent("datagrid.copyHintCsv")}</span>
        </span>
      </button>
      <button
        type="button"
        className="datagrid-export-menu-item"
        onClick={() => void copyRowAs("tsv")}
      >
        <FileSpreadsheet className="!w-3.5 !h-3.5" />
        <span className="datagrid-export-menu-copy">
          <strong>TSV</strong>
          <span>{translateCurrent("datagrid.copyHintTsv")}</span>
        </span>
      </button>
      <button
        type="button"
        className="datagrid-export-menu-item"
        onClick={() => void copyRowAs("json")}
      >
        <FileJson className="!w-3.5 !h-3.5" />
        <span className="datagrid-export-menu-copy">
          <strong>JSON</strong>
          <span>
            {translateCurrent(
              scope === "row" ? "datagrid.copyHintJson" : "datagrid.ctxHintJsonRowObject",
            )}
          </span>
        </span>
      </button>
      <button
        type="button"
        className="datagrid-export-menu-item"
        onClick={() => void copyRowAs("markdown")}
      >
        <Table2 className="!w-3.5 !h-3.5" />
        <span className="datagrid-export-menu-copy">
          <strong>{powerCopy.copyAs.markdown}</strong>
          <span>{powerCopy.copyAs.markdownHint}</span>
        </span>
      </button>
      {tableName && (
        <button
          type="button"
          className="datagrid-export-menu-item"
          onClick={() => void copyRowAs("insert")}
        >
          <FileCode className="!w-3.5 !h-3.5" />
          <span className="datagrid-export-menu-copy">
            <strong>{powerCopy.copyAs.insert}</strong>
            <span>{powerCopy.copyAs.insertHint}</span>
          </span>
        </button>
      )}
      {tableName && (
        <button
          type="button"
          className="datagrid-export-menu-item"
          onClick={() => void copyRowAs("mql")}
        >
          <FileCode className="!w-3.5 !h-3.5" />
          <span className="datagrid-export-menu-copy">
            <strong>MQL</strong>
            <span>{translateCurrent("datagrid.copyHintMql")}</span>
          </span>
        </button>
      )}
    </div>
  );

  /** Copies every loaded value of the right-clicked column (current view
   *  order) as a one-column CSV/TSV or a plain JSON array. */
  const copyColumnAs = async (format: "csv" | "tsv" | "json") => {
    const columnId = contextMenu.colName!;
    const rows = table.getRowModel().rows;
    const rawValues = rows.map((row) => normalizeCellValue(row.getValue(columnId)));
    const values = columnMasks
      ? await Promise.all(rawValues.map((value) => columnMasks.maskValue(columnId, value)))
      : rawValues;
    if (format === "json") {
      void copyWithToast(JSON.stringify(values, null, 2), "column as JSON");
    } else {
      const content =
        format === "csv"
          ? buildCsvContent(
              [columnId],
              values.map((value) => [value]),
            )
          : buildTsvContent(
              [columnId],
              values.map((value) => [value]),
            );
      void copyWithToast(content, `column as ${format.toUpperCase()}`);
    }
    onClose();
  };

  return (
    <div
      className="datagrid-context-menu"
      style={{
        left: Math.min(contextMenu.x, window.innerWidth - 300),
        top: Math.min(contextMenu.y, window.innerHeight - 260),
      }}
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
            {translateCurrent("datagrid.ctxSortAsc")}
          </button>
          <button
            className="datagrid-context-menu-item"
            onClick={() => {
              onSortDesc(contextMenu.colName!);
              onClose();
            }}
          >
            {translateCurrent("datagrid.ctxSortDesc")}
          </button>
          <div className="datagrid-context-menu-separator" />
          <button
            className="datagrid-context-menu-item"
            onClick={() => {
              void navigator.clipboard.writeText(contextMenu.colName!);
              onClose();
            }}
          >
            {translateCurrent("datagrid.ctxCopyColumnName")}
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
            {translateCurrent("datagrid.ctxCopyAsSelect")}
          </button>
          <button className="datagrid-context-menu-item" onClick={() => void copyColumnAs("csv")}>
            {translateCurrent("datagrid.ctxCopyColumnCsv")}
          </button>
          <button className="datagrid-context-menu-item" onClick={() => void copyColumnAs("tsv")}>
            {translateCurrent("datagrid.ctxCopyColumnTsv")}
          </button>
          <button className="datagrid-context-menu-item" onClick={() => void copyColumnAs("json")}>
            {translateCurrent("datagrid.ctxCopyColumnJson")}
          </button>
          {onColumnStats && contextMenu.colName !== "_row_num" && (
            <button
              className="datagrid-context-menu-item"
              onClick={() => {
                onColumnStats(contextMenu.colName!);
                onClose();
              }}
            >
              {powerCopy.stats.menuItem}
            </button>
          )}
          <div className="datagrid-context-menu-separator" />
          <button
            className="datagrid-context-menu-item"
            onClick={() => {
              onColumnAutoFit(contextMenu.colName!);
              onClose();
            }}
          >
            {translateCurrent("datagrid.ctxAutoFit")}
          </button>
          {contextMenu.colName !== "_row_num" && (
            <>
              {(() => {
                const contextColumn = table.getColumn(contextMenu.colName!);
                const isPinned = contextColumn?.getIsPinned();
                const pinDisabled =
                  (contextColumn?.getSize() ?? 0) > (pinBudgetPx ?? Number.MAX_SAFE_INTEGER);
                return isPinned ? (
                  <button
                    className="datagrid-context-menu-item"
                    onClick={() => {
                      contextColumn?.pin(false);
                      onClose();
                    }}
                  >
                    {translateCurrent("datagrid.ctxUnpin")}
                  </button>
                ) : (
                  <>
                    <button
                      className="datagrid-context-menu-item"
                      disabled={pinDisabled}
                      title={pinDisabled ? powerCopy.pinning.limitToast : undefined}
                      onClick={() => {
                        contextColumn?.pin("left");
                        onClose();
                      }}
                    >
                      {translateCurrent("datagrid.ctxPinLeft")}
                    </button>
                    <button
                      className="datagrid-context-menu-item"
                      disabled={pinDisabled}
                      title={pinDisabled ? powerCopy.pinning.limitToast : undefined}
                      onClick={() => {
                        contextColumn?.pin("right");
                        onClose();
                      }}
                    >
                      {translateCurrent("datagrid.ctxPinRight")}
                    </button>
                  </>
                );
              })()}
              <button
                className="datagrid-context-menu-item"
                onClick={() => {
                  const columnId = contextMenu.colName!;
                  setColumnOrder((previous) => {
                    const allIds = table.getAllLeafColumns().map((column) => column.id);
                    const order =
                      previous.length > 0
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
                {translateCurrent("datagrid.ctxMoveLeft")}
              </button>
              <button
                className="datagrid-context-menu-item"
                onClick={() => {
                  const columnId = contextMenu.colName!;
                  setColumnOrder((previous) => {
                    const allIds = table.getAllLeafColumns().map((column) => column.id);
                    const order =
                      previous.length > 0
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
                {translateCurrent("datagrid.ctxMoveRight")}
              </button>
              <button
                className="datagrid-context-menu-item"
                onClick={() => {
                  table.getColumn(contextMenu.colName!)?.toggleVisibility(false);
                  onClose();
                }}
              >
                {translateCurrent("datagrid.ctxHideColumn")}
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
              {translateCurrent("datagrid.ctxShowAllColumns")}
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
            {translateCurrent("datagrid.ctxResetLayout")}
          </button>
          <div className="datagrid-context-menu-separator" />
          <div
            className="datagrid-context-menu-label"
            style={{
              padding: "4px 12px",
              fontSize: "11px",
              color: "var(--text-muted)",
              fontWeight: 600,
              textTransform: "uppercase",
            }}
          >
            {translateCurrent("datagrid.ctxDisplayAs")}
          </div>
          {(["default", "uuid", "hex", "text", "json"] as ColumnDisplayFormat[]).map((fmt) => (
            <button
              key={fmt}
              className="datagrid-context-menu-item"
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
              onClick={() => {
                setColumnDisplayFormats((prev) => ({ ...prev, [contextMenu.colName!]: fmt }));
                onClose();
              }}
            >
              <span style={{ textTransform: "capitalize" }}>{fmt}</span>
              {(columnDisplayFormats[contextMenu.colName!] || "default") === fmt && (
                <span style={{ color: "var(--accent)" }}>✓</span>
              )}
            </button>
          ))}
          {maskScopeKey && contextMenu.colName !== "_row_num" && columnMasks && contextColumn && (
            <>
              <div className="datagrid-context-menu-separator" />
              {contextColumnIsPk ? (
                <button
                  type="button"
                  className="datagrid-context-menu-item"
                  disabled
                  title={maskingCopy.pkBlocked}
                >
                  {maskingCopy.maskColumn}
                </button>
              ) : (
                <>
                  {columnMasks.maskedColumnNames.has(contextMenu.colName!) ? (
                    <>
                      <button
                        type="button"
                        className="datagrid-context-menu-item"
                        onClick={() => {
                          clearColumnMask(maskScopeKey, contextMenu.colName!);
                          onClose();
                        }}
                      >
                        {maskingCopy.unmask}
                      </button>
                      <button
                        type="button"
                        className="datagrid-context-menu-item"
                        onClick={() => {
                          setMaskRevealed(
                            maskScopeKey,
                            contextMenu.colName!,
                            !columnMasks.activeMaskedNames.has(contextMenu.colName!),
                          );
                          onClose();
                        }}
                      >
                        {columnMasks.activeMaskedNames.has(contextMenu.colName!)
                          ? maskingCopy.reveal
                          : maskingCopy.hide}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="datagrid-context-menu-item"
                      onClick={() => {
                        setColumnMask(
                          maskScopeKey,
                          contextMenu.colName!,
                          defaultMaskStrategy(contextColumn),
                        );
                        onClose();
                      }}
                    >
                      {maskingCopy.maskColumn}
                    </button>
                  )}
                  <div className="datagrid-context-menu-item has-submenu" tabIndex={0}>
                    <span>{maskingCopy.maskWith}</span>
                    <ChevronRight className="w-3 h-3 submenu-chevron" />
                    <div className="datagrid-context-menu datagrid-context-submenu">
                      {(
                        [
                          "hash",
                          "redact",
                          "null",
                          "fake-email",
                          "fake-name",
                          "fake-phone",
                          "noise",
                        ] as AnonymizerStrategy[]
                      ).map((strategy) => (
                        <button
                          key={strategy}
                          type="button"
                          className="datagrid-context-menu-item"
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            gap: "8px",
                          }}
                          onClick={() => {
                            setColumnMask(maskScopeKey, contextMenu.colName!, strategy);
                            onClose();
                          }}
                        >
                          <span>
                            {maskingCopy.strategies[strategy]}
                            {strategy === defaultMaskStrategy(contextColumn) && (
                              <span style={{ color: "var(--text-muted)" }}>
                                {` (${maskingCopy.defaultTag})`}
                              </span>
                            )}
                          </span>
                          {columnMasks.maskStrategies[contextMenu.colName!] === strategy && (
                            <span style={{ color: "var(--accent)" }}>✓</span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </>
          )}
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
            {translateCurrent("datagrid.ctxInspectRow")}
          </button>
          <button
            className="datagrid-context-menu-item"
            onClick={() => {
              void onDuplicateRowByIndex(contextMenu.rowIndex ?? 0);
              onClose();
            }}
          >
            {translateCurrent("datagrid.ctxDuplicateRow")}
          </button>
          <div className="datagrid-context-menu-separator" />
          <div className="datagrid-context-menu-item has-submenu" tabIndex={0}>
            <span>{translateCurrent("datagrid.ctxCopyAs")}</span>
            <ChevronRight className="w-3 h-3 submenu-chevron" />
            {copyAsSubmenu("row")}
          </div>
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
            {translateCurrent("datagrid.ctxAddRow")}
          </button>
          {onSetRangeValue && (selectedRangeCellCount ?? 0) > 1 && (
            <button
              className="datagrid-context-menu-item"
              onClick={() => {
                onSetRangeValue();
                onClose();
              }}
            >
              {powerCopy.setCells.menuItem}
            </button>
          )}
          <div className="datagrid-context-menu-separator" />
          <button className="datagrid-context-menu-item" onClick={copyCellValue}>
            {translateCurrent("datagrid.ctxCopyCellValue")}
          </button>
          <div className="datagrid-context-menu-item has-submenu" tabIndex={0}>
            <span>{translateCurrent("datagrid.ctxCopyRowAs")}</span>
            <ChevronRight className="w-3 h-3 submenu-chevron" />
            {copyAsSubmenu("cell")}
          </div>
        </>
      )}
    </div>
  );
}
