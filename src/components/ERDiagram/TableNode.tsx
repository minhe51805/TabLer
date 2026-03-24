import { memo, type CSSProperties } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { ColumnDetail } from "../../types/database";

export type TableNodeData = Record<string, unknown> & {
  label: string;
  columns: ColumnDetail[];
  rowCount?: number;
  color: string;
};

export type TableNodeType = Node<TableNodeData, "tableNode">;

function formatCompactCount(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export const TableNode = memo(function TableNode({ data }: NodeProps<TableNodeType>) {
  const { label, columns, rowCount, color } = data;
  const visibleColumns = columns.slice(0, 8);
  const hiddenCount = Math.max(0, columns.length - visibleColumns.length);

  return (
    <div className="erd-node" style={{ "--erd-node-accent": color } as CSSProperties}>
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
          {rowCount !== undefined && <span className="erd-node-pill">{formatCompactCount(rowCount)} rows</span>}
        </div>
      </div>

      <div className="erd-node-column-list">
        {visibleColumns.map((column: ColumnDetail) => (
          <div key={column.name} className={`erd-node-column ${column.is_primary_key ? "is-primary" : ""}`}>
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

        {hiddenCount > 0 && <div className="erd-node-more">+{hiddenCount} more columns</div>}
      </div>

      <Handle type="source" position={Position.Right} className="erd-node-handle" />
    </div>
  );
});
