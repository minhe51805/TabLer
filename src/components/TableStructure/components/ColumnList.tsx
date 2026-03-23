import { Columns3, Key, Pencil } from "lucide-react";
import type { ColumnDetail } from "../../../types";
import type { StagedColumnChange } from "../utils/dialect-sql-generator";

interface Props {
  columns: ColumnDetail[];
  stagedColumns: ColumnDetail[];
  stagedColumnChanges: Record<string, StagedColumnChange>;
  onOpenEditor: (column: ColumnDetail) => void;
  sectionRef: React.RefObject<HTMLElement | null>;
  isActive: boolean;
  isExpanded: boolean;
  onToggle: () => void;
}

export function ColumnList({
  columns,
  stagedColumns,
  stagedColumnChanges,
  onOpenEditor,
  sectionRef,
  isActive,
  isExpanded,
  onToggle,
}: Props) {
  return (
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
  );
}
