import type { ColumnDetail } from "../../types/database";

export const DIAGRAM_NODE_WIDTH = 208;
export const DIAGRAM_VISIBLE_COLUMN_COUNT = 6;
export const DIAGRAM_NODE_HEADER_HEIGHT = 52;
export const DIAGRAM_NODE_LIST_INSET = 8;
export const DIAGRAM_NODE_ROW_HEIGHT = 30;
export const DIAGRAM_NODE_ROW_GAP = 4;
export const DIAGRAM_NODE_MORE_HEIGHT = 18;
export const DIAGRAM_HANDLE_OFFSET = 5;

export interface DiagramPoint {
  x: number;
  y: number;
}

export type DiagramSide = "left" | "right" | "top" | "bottom";

export interface DiagramNodeFrame {
  x: number;
  y: number;
  width: number;
  height: number;
  columns: readonly Pick<ColumnDetail, "name">[];
  isExpanded?: boolean;
}

export function getVisibleDiagramColumns<T>(columns: readonly T[], expanded = false) {
  return expanded ? [...columns] : columns.slice(0, DIAGRAM_VISIBLE_COLUMN_COUNT);
}

export function estimateDiagramNodeHeight(columnCount: number, expanded = false) {
  const visibleCount = expanded ? columnCount : Math.min(columnCount, DIAGRAM_VISIBLE_COLUMN_COUNT);
  const hiddenCount = expanded ? 0 : Math.max(0, columnCount - DIAGRAM_VISIBLE_COLUMN_COUNT);

  return (
    DIAGRAM_NODE_HEADER_HEIGHT +
    DIAGRAM_NODE_LIST_INSET * 2 +
    visibleCount * DIAGRAM_NODE_ROW_HEIGHT +
    Math.max(0, visibleCount - 1) * DIAGRAM_NODE_ROW_GAP +
    (hiddenCount > 0 ? DIAGRAM_NODE_MORE_HEIGHT : 0)
  );
}

export function getDiagramNodeCenter(node: DiagramNodeFrame): DiagramPoint {
  return {
    x: node.x + node.width / 2,
    y: node.y + node.height / 2,
  };
}

export function pickDiagramAnchorSide(nodeCenter: DiagramPoint, referencePoint: DiagramPoint): DiagramSide {
  const dx = referencePoint.x - nodeCenter.x;
  const dy = referencePoint.y - nodeCenter.y;

  if (Math.abs(dx) > Math.abs(dy)) {
    return dx >= 0 ? "right" : "left";
  }

  return dy >= 0 ? "bottom" : "top";
}

export function getDiagramColumnAnchorOffset(
  columns: readonly Pick<ColumnDetail, "name">[],
  columnName: string | undefined,
  nodeHeight: number,
  expanded = false
) {
  if (columnName) {
    const visibleColumns = getVisibleDiagramColumns(columns, expanded);
    const visibleIndex = visibleColumns.findIndex((column) => column.name === columnName);

    if (visibleIndex !== -1) {
      return (
        DIAGRAM_NODE_HEADER_HEIGHT +
        DIAGRAM_NODE_LIST_INSET +
        visibleIndex * (DIAGRAM_NODE_ROW_HEIGHT + DIAGRAM_NODE_ROW_GAP) +
        DIAGRAM_NODE_ROW_HEIGHT / 2
      );
    }

    const existsInHiddenColumns =
      columns.length > visibleColumns.length && columns.some((column) => column.name === columnName);

    if (existsInHiddenColumns) {
      return nodeHeight - DIAGRAM_NODE_MORE_HEIGHT / 2;
    }
  }

  return nodeHeight / 2;
}

export function getDiagramNodeAnchorPoint(
  node: DiagramNodeFrame,
  side: DiagramSide,
  columnName?: string
): DiagramPoint {
  const anchorY = node.y + getDiagramColumnAnchorOffset(node.columns, columnName, node.height, Boolean(node.isExpanded));

  switch (side) {
    case "left":
      return { x: node.x - DIAGRAM_HANDLE_OFFSET, y: anchorY };
    case "right":
      return { x: node.x + node.width + DIAGRAM_HANDLE_OFFSET, y: anchorY };
    case "top":
      return { x: node.x + node.width / 2, y: node.y - DIAGRAM_HANDLE_OFFSET };
    case "bottom":
      return { x: node.x + node.width / 2, y: node.y + node.height + DIAGRAM_HANDLE_OFFSET };
    default:
      return { x: node.x + node.width + DIAGRAM_HANDLE_OFFSET, y: anchorY };
  }
}

export function buildDiagramEdgePoints(
  sourcePoint: DiagramPoint,
  sourceSide: DiagramSide,
  targetPoint: DiagramPoint,
  targetSide: DiagramSide,
  bendPoint: DiagramPoint
) {
  const sourceGuide =
    sourceSide === "left" || sourceSide === "right"
      ? { x: bendPoint.x, y: sourcePoint.y }
      : { x: sourcePoint.x, y: bendPoint.y };
  const targetGuide =
    targetSide === "left" || targetSide === "right"
      ? { x: bendPoint.x, y: targetPoint.y }
      : { x: targetPoint.x, y: bendPoint.y };

  return [sourcePoint, sourceGuide, bendPoint, targetGuide, targetPoint].filter((point, index, all) => {
    if (index === 0) return true;
    const previous = all[index - 1];
    return previous.x !== point.x || previous.y !== point.y;
  });
}
