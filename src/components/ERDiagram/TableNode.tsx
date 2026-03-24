import { memo, type CSSProperties, type MouseEvent } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { ColumnDetail } from "../../types/database";
import { DIAGRAM_VISIBLE_COLUMN_COUNT, getVisibleDiagramColumns } from "./layout";

export interface ERDNodeContextPayload {
  tableName: string;
  schemaName?: string;
  columnName?: string;
}

export type TableNodeData = Record<string, unknown> & {
  label: string;
  schemaName?: string;
  columns: ColumnDetail[];
  rowCount?: number | null;
  color: string;
  isExpanded?: boolean;
  onToggleExpanded?: () => void;
  onOpenContextMenu?: (event: MouseEvent<HTMLElement>, payload: ERDNodeContextPayload) => void;
};

export type TableNodeType = Node<TableNodeData, "tableNode">;

function formatCompactCount(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export const TableNode = memo(function TableNode({ data }: NodeProps<TableNodeType>) {
  const { label, schemaName, columns, rowCount, color, isExpanded = false, onToggleExpanded, onOpenContextMenu } = data;
  const visibleColumns = getVisibleDiagramColumns(columns, isExpanded);
  const hiddenCount = Math.max(0, columns.length - visibleColumns.length);
  const hasRowCount = typeof rowCount === "number" && Number.isFinite(rowCount);
  const hasOverflow = columns.length > DIAGRAM_VISIBLE_COLUMN_COUNT;
  const handleToggleExpanded = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onToggleExpanded?.();
  };
  const handleTableContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onOpenContextMenu?.(event, { tableName: label, schemaName });
  };

  const handleColumnContextMenu = (event: MouseEvent<HTMLDivElement>, columnName: string) => {
    event.preventDefault();
    event.stopPropagation();
    onOpenContextMenu?.(event, { tableName: label, schemaName, columnName });
  };

  return (
    <div
      className={`erd-node ${isExpanded ? "is-expanded" : ""}`}
      style={{ "--erd-node-accent": color } as CSSProperties}
      onContextMenu={handleTableContextMenu}
    >
      <Handle type="target" position={Position.Left} className="erd-node-handle" />

      <div className="erd-node-header">
        <div className="erd-node-header-row">
          <span className="erd-node-accent-dot" />
          <div className="erd-node-title-copy">
            <span className="erd-node-kicker">Table</span>
            <span className="erd-node-title">{label}</span>
          </div>
        </div>

        <div className="erd-node-meta">
          <span className="erd-node-pill">{columns.length} cols</span>
          {hasRowCount ? <span className="erd-node-pill">{formatCompactCount(rowCount)} rows</span> : null}
        </div>
      </div>

        <div className="erd-node-column-list">
        {visibleColumns.map((column: ColumnDetail) => (
          <div
            key={column.name}
            className={`erd-node-column ${column.is_primary_key ? "is-primary" : ""}`}
            onContextMenu={(event) => handleColumnContextMenu(event, column.name)}
          >
            <span className={`erd-node-column-pill ${column.is_primary_key ? "is-primary" : ""}`}>
              {column.is_primary_key ? "PK" : "COL"}
            </span>

            <div className="erd-node-column-copy">
              <span className="erd-node-column-name">{column.name}</span>
              <span className="erd-node-column-detail">
                {column.data_type}
                {column.is_nullable ? " / nullable" : ""}
              </span>
            </div>
          </div>
        ))}

        {hasOverflow ? (
          <button type="button" className="erd-node-more nodrag nopan" onClick={handleToggleExpanded}>
            {isExpanded ? (
              <>
                <span className="erd-node-more-count is-action">
                  <ChevronUp className="erd-node-more-icon" />
                </span>
                <span className="erd-node-more-label">show less</span>
              </>
            ) : (
              <>
                <span className="erd-node-more-count">+{hiddenCount}</span>
                <span className="erd-node-more-label">more columns</span>
                <ChevronDown className="erd-node-more-icon" />
              </>
            )}
          </button>
        ) : null}
      </div>

      <Handle type="source" position={Position.Right} className="erd-node-handle" />
    </div>
  );
});
