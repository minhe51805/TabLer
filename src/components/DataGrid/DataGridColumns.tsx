import type { ColumnDef } from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, Key, ExternalLink } from "lucide-react";
import type {
  EditingCell,
  GridCellValue,
  ResolvedColumn,
} from "./hooks/useDataGrid";

interface EditingDraft {
  current: string;
}

interface SetSelectedCellFn {
  (cell: { row: number; col: number } | null): void;
}

interface DataGridColumnsProps {
  resolvedColumns: ResolvedColumn[];
  canSelectRows: boolean;
  canAttemptInlineEdit: boolean;
  selectedRows: Set<number>;
  selectedCell: { row: number; col: number } | null;
  editingCell: EditingCell | null;
  editingSeedValue: string;
  savingCell: EditingCell | null;
  sortColumn: string | null;
  sortDir: "ASC" | "DESC";
  currentPage: number;
  copiedCell: string | null;
  editingDraftRef: EditingDraft;
  handleSort: (colName: string) => void;
  handleRowSelection: (rowIndex: number, event?: Pick<MouseEvent, "shiftKey" | "metaKey" | "ctrlKey">) => void;
  handleToggleSelectAllRows: () => void;
  handleEditorBlur: () => void;
  handleCopyValue: (value: GridCellValue, cellKey: string) => void;
  startEditingCell: (rowIndex: number, colIndex: number) => Promise<void>;
  commitEditingCell: () => Promise<void>;
  cancelEditingCell: () => void;
  structureStatus: "idle" | "loading" | "ready" | "failed";
  assignInputRef: (element: HTMLInputElement | null) => void;
  assignSelectRef: (element: HTMLSelectElement | null) => void;
  allVisibleRowsSelected: boolean;
  isBooleanColumn: (column: ResolvedColumn) => boolean;
  setSelectedCell: SetSelectedCellFn;
}

export function buildDataGridColumns({
  resolvedColumns,
  canSelectRows,
  canAttemptInlineEdit,
  selectedRows,
  selectedCell,
  editingCell,
  editingSeedValue,
  savingCell,
  sortColumn,
  sortDir,
  currentPage,
  copiedCell,
  editingDraftRef,
  handleSort,
  handleRowSelection,
  handleToggleSelectAllRows,
  handleEditorBlur,
  startEditingCell,
  commitEditingCell,
  cancelEditingCell,
  structureStatus,
  assignInputRef,
  assignSelectRef,
  allVisibleRowsSelected,
  isBooleanColumn,
  handleCopyValue,
  setSelectedCell,
}: DataGridColumnsProps): ColumnDef<unknown[], unknown>[] {
  return [
    {
      id: "_row_num",
      header: () =>
        canSelectRows ? (
          <button
            type="button"
            className={`datagrid-index-toggle ${allVisibleRowsSelected ? "active" : ""}`}
            onClick={handleToggleSelectAllRows}
            title={allVisibleRowsSelected ? "Clear selected rows" : "Select all visible rows"}
          >
            #
          </button>
        ) : (
          <span className="datagrid-index-label">#</span>
        ),
      cell: ({ row }) =>
        canSelectRows ? (
          <button
            type="button"
            className={`datagrid-index-value datagrid-index-selectable ${selectedRows.has(row.index) ? "selected" : ""}`}
            onClick={(event) => {
              event.stopPropagation();
              handleRowSelection(row.index, event.nativeEvent);
            }}
            title={selectedRows.has(row.index) ? "Row selected" : "Select row"}
          >
            {currentPage * 100 + row.index + 1}
          </button>
        ) : (
          <span className="datagrid-index-value">
            {currentPage * 100 + row.index + 1}
          </span>
        ),
      size: 72,
    },
    ...resolvedColumns.map((col, idx) => ({
      id: col.name,
      header: () => (
        <button
          className="flex items-center gap-1.5 w-full text-left font-semibold group/header"
          onClick={() => handleSort(col.name)}
        >
          {col.is_primary_key && <Key className="w-3 h-3 text-[var(--warning)] shrink-0" />}
          <span className="truncate">{col.name}</span>
          {sortColumn === col.name ? (
            sortDir === "ASC" ? (
              <ArrowUp className="w-3 h-3 shrink-0 text-[var(--accent)]" />
            ) : (
              <ArrowDown className="w-3 h-3 shrink-0 text-[var(--accent)]" />
            )
          ) : (
            <ArrowUpDown className="w-3 h-3 shrink-0 opacity-0 group-hover/header:opacity-50 transition-opacity" />
          )}
        </button>
      ),
      accessorFn: (row: unknown[]) => (row as (string | number | boolean | null)[])[idx],
      cell: ({ getValue, row: tableRow }: { getValue: () => unknown; row: { index: number } }) => {
        const value = getValue() as GridCellValue;
        const rowIndex = tableRow.index;
        const isSelected = selectedCell?.row === rowIndex && selectedCell?.col === idx;
        const isEditing = editingCell?.row === rowIndex && editingCell?.col === idx;
        const isSaving = savingCell?.row === rowIndex && savingCell?.col === idx;
        const isEditableColumn =
          canAttemptInlineEdit && (structureStatus !== "ready" || !col.is_primary_key);
        const cellKey = `${rowIndex}-${idx}`;
        const stringValue = value === null ? null : String(value);
        const isUrlCell = stringValue !== null && URL_RE.test(stringValue);
        const isImageCell = isUrlCell && isImageUrl(stringValue);
        const faviconUrl = isUrlCell && stringValue ? getFaviconUrl(stringValue) : null;

        return (
          <div
            className={[
              "datagrid-cell",
              isSelected ? "selected" : "",
              value === null ? "null-value" : "",
              isEditableColumn ? "editable" : "",
              isEditing ? "editing" : "",
              isSaving ? "saving" : "",
            ].join(" ")}
            onMouseDown={(event) => {
              if (!isEditableColumn || isEditing) return;

              const isRepeatSelection =
                selectedCell?.row === rowIndex && selectedCell?.col === idx;
              if (isRepeatSelection || event.detail >= 2) {
                event.preventDefault();
                event.stopPropagation();
                void startEditingCell(rowIndex, idx);
              }
            }}
            onClick={() => {
              if (!isEditing) {
                setSelectedCell({ row: rowIndex, col: idx });
              }
            }}
            onDoubleClick={() => {
              if (!isEditableColumn) {
                handleCopyValue(value, cellKey);
              }
            }}
          >
            {copiedCell === cellKey && (
              <span className="absolute -top-5 left-1/2 -translate-x-1/2 text-[10px] bg-[var(--accent)] text-[var(--bg-primary)] px-1.5 py-0.5 rounded-md whitespace-nowrap z-10 font-semibold">
                Copied
              </span>
            )}

            {isEditing ? (
              isBooleanColumn(col) ? (
                <select
                  ref={(el) => assignSelectRef(el as HTMLSelectElement | null)}
                  className="datagrid-cell-editor datagrid-cell-select"
                  defaultValue={editingSeedValue}
                  onChange={(event) => {
                    editingDraftRef.current = event.target.value;
                  }}
                  onBlur={handleEditorBlur}
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void commitEditingCell();
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      cancelEditingCell();
                    }
                  }}
                >
                  <option value="true">true</option>
                  <option value="false">false</option>
                  <option value="NULL">NULL</option>
                </select>
              ) : (
                <input
                  ref={(el) => assignInputRef(el as HTMLInputElement | null)}
                  defaultValue={editingSeedValue}
                  className="datagrid-cell-editor"
                  placeholder={col.is_nullable ? "Type NULL to clear" : ""}
                  onChange={(event) => {
                    editingDraftRef.current = event.target.value;
                  }}
                  onBlur={handleEditorBlur}
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void commitEditingCell();
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      cancelEditingCell();
                    }
                  }}
                />
              )
            ) : (
              <>
                {isSaving && (
                  <span className="animate-spin inline-block w-3.5 h-3.5 border-2 border-[var(--accent)] border-t-transparent rounded-full" />
                )}
                {isImageCell && stringValue !== null ? (
                  <div className="datagrid-url-cell">
                    <img
                      src={stringValue}
                      alt=""
                      className="datagrid-cell-thumb"
                      loading="lazy"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = "none";
                      }}
                    />
                    <a
                      href={stringValue}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="datagrid-cell-value datagrid-url-link"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <ExternalLink className="w-2.5! h-2.5!" />
                      <span>{getUrlDomain(stringValue)}</span>
                    </a>
                  </div>
                ) : isUrlCell && stringValue !== null ? (
                  <div className="datagrid-url-cell">
                    {faviconUrl ? (
                      <img
                        src={faviconUrl}
                        alt=""
                        className="datagrid-cell-thumb datagrid-cell-favicon"
                        loading="lazy"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = "none";
                        }}
                      />
                    ) : null}
                    <a
                      href={stringValue}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="datagrid-cell-value datagrid-url-link"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <ExternalLink className="w-2.5! h-2.5!" />
                      <span>{getUrlDomain(stringValue)}</span>
                    </a>
                  </div>
                ) : (
                  <span className="datagrid-cell-value">{value === null ? "NULL" : String(value)}</span>
                )}
              </>
            )}
          </div>
        );
      },
      size: 180,
    })),
  ];
}

// Shared ref for the cell editor draft value
export const editingDraftRef: { current: string } = { current: "" };

// ---------------------------------------------------------------------------
// URL / Image cell detection
// ---------------------------------------------------------------------------

const URL_RE = /^https?:\/\//i;
const IMAGE_EXT_RE = /\.(png|jpg|jpeg|gif|webp|svg|ico|bmp)(\?.*)?$/i;
const IMAGE_KEYWORD_RE = /\/(logo|img|image|avatar|icon|photo|picture|thumbnail|asset|media|cdn)\//i;

function isImageUrl(value: string): boolean {
  return IMAGE_EXT_RE.test(value) || IMAGE_KEYWORD_RE.test(value);
}

function getUrlDomain(value: string): string {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, "");
    const path = url.pathname.replace(/\/+/g, "/").replace(/\/$/, "");
    const shortPath = path.length > 24 ? path.slice(0, 22) + "…" : path;
    return `${host}${shortPath}`;
  } catch {
    return value.length > 32 ? value.slice(0, 30) + "…" : value;
  }
}

function getFaviconUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return `https://www.google.com/s2/favicons?domain=${url.hostname}&sz=64`;
  } catch {
    return null;
  }
}


