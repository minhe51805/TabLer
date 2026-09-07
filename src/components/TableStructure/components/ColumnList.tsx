import { Columns3, Copy, Key, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import type { ColumnDetail } from "../../../types";
import type { StagedColumnChange } from "../utils/dialect-sql-generator";

interface Props {
  columns: ColumnDetail[];
  stagedColumns: ColumnDetail[];
  stagedColumnChanges: Record<string, StagedColumnChange>;
  onOpenEditor: (column: ColumnDetail) => void;
  onDeleteColumn?: (column: ColumnDetail) => void;
  sectionRef: React.RefObject<HTMLElement | null>;
  isActive: boolean;
  isExpanded: boolean;
  onToggle: () => void;
  dbType?: string;
}

export function ColumnList({
  columns,
  stagedColumns,
  stagedColumnChanges,
  onOpenEditor,
  onDeleteColumn,
  sectionRef,
  isActive,
  isExpanded,
  onToggle,
}: Props) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; column: ColumnDetail } | null>(null);

  const handleContextMenu = (e: React.MouseEvent, column: ColumnDetail) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, column });
  };

  const copyColumnName = () => {
    if (contextMenu) void navigator.clipboard.writeText(contextMenu.column.name);
    setContextMenu(null);
  };

  const copyColumnDef = () => {
    if (contextMenu) {
      const col = contextMenu.column;
      const type = col.column_type || col.data_type || "TEXT";
      const nullable = col.is_nullable ? "" : " NOT NULL";
      const def = col.default_value ? ` DEFAULT ${col.default_value}` : "";
      void navigator.clipboard.writeText(`${col.name} ${type}${nullable}${def}`);
    }
    setContextMenu(null);
  };

  return (
    <>
      {contextMenu && (
        <>
          <div
            className="structure-context-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <button className="structure-context-menu-item" onClick={copyColumnName}>
              <Copy className="w-3.5 h-3.5" />
              Copy column name
            </button>
            <button className="structure-context-menu-item" onClick={copyColumnDef}>
              <Copy className="w-3.5 h-3.5" />
              Copy definition
            </button>
            <div className="structure-context-menu-separator" />
            <button
              className="structure-context-menu-item"
              onClick={() => {
                onOpenEditor(contextMenu.column);
                setContextMenu(null);
              }}
            >
              <Pencil className="w-3.5 h-3.5" />
              Edit column
            </button>
            {onDeleteColumn && (
              <button
                className="structure-context-menu-item danger"
                onClick={() => {
                  onDeleteColumn(contextMenu.column);
                  setContextMenu(null);
                }}
              >
                <Trash2 className="w-3.5 h-3.5" />
                Delete column
              </button>
            )}
          </div>
          <div
            style={{ position: "fixed", inset: 0, zIndex: 199 }}
            onClick={() => setContextMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setContextMenu(null); }}
          />
        </>
      )}

      <section
        ref={sectionRef}
        className={`structure-section ${isActive ? "active" : ""}`}
      >
        <button
          type="button"
          onClick={onToggle}
          className="structure-section-toggle"
          aria-expanded={isExpanded}
        >
          <div className="structure-section-head">
            <div className="structure-section-icon">
              <Columns3 className="w-4 h-4" />
            </div>
            <div className="structure-section-copy">
              <span className="structure-section-title">Columns</span>
              <span className="structure-section-subtitle">
                Edit in memory first, then review SQL before applying.
              </span>
            </div>
          </div>
          <span className="structure-section-count">{columns.length}</span>
        </button>

        {isExpanded && (
          <div className="structure-section-body">
            <table className="structure-table">
              <thead>
                <tr>
                  <th className="structure-th">Column</th>
                  <th className="structure-th">Type</th>
                  <th className="structure-th">Nullable</th>
                  <th className="structure-th">Default</th>
                  <th className="structure-th">Extra</th>
                  <th className="structure-th structure-th-actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {columns.map((column, index) => {
                  const draft = stagedColumnChanges[column.name]?.draft;
                  const displayColumn = stagedColumns[index];
                  return (
                    <tr
                      key={column.name}
                      className={`structure-row ${index % 2 !== 0 ? "alt" : ""} ${draft ? "staged" : ""}`}
                      onContextMenu={(e) => handleContextMenu(e, column)}
                    >
                      <td className="structure-td">
                        <div className="structure-name-cell">
                          {displayColumn.is_primary_key && (
                            <Key className="w-3.5 h-3.5 text-[var(--warning)]" />
                          )}
                          <span className="structure-name-text">{displayColumn.name}</span>
                          {displayColumn.is_primary_key && (
                            <span className="structure-inline-pill primary">PK</span>
                          )}
                          {draft && <span className="structure-inline-pill staged">Edited</span>}
                        </div>
                      </td>
                      <td className="structure-td">
                        <span className="structure-inline-pill type">
                          {displayColumn.column_type || displayColumn.data_type}
                        </span>
                      </td>
                      <td className="structure-td">
                        <span
                          className={`structure-inline-pill ${displayColumn.is_nullable ? "" : "strong"}`}
                        >
                          {displayColumn.is_nullable ? "YES" : "NO"}
                        </span>
                      </td>
                      <td className="structure-td">
                        <span
                          className="structure-code-chip"
                          title={displayColumn.default_value || "-"}
                        >
                          {displayColumn.default_value || "-"}
                        </span>
                      </td>
                      <td className="structure-td">
                        <span className="structure-code-chip" title={displayColumn.extra || "-"}>
                          {displayColumn.extra || "-"}
                        </span>
                      </td>
                      <td className="structure-td structure-td-actions">
                        <div className="structure-action-group">
                          <button
                            type="button"
                            className="structure-action-btn"
                            onClick={() => onOpenEditor(column)}
                          >
                            <Pencil className="w-3.5 h-3.5" />
                            <span>Edit</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
