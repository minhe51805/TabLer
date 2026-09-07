/**
 * Pure layout math and formatting helpers for the EXPLAIN diagram.
 */

import type { ExplainNode, ParsedExplainPlan } from "../../utils/explain-parser";

export const NODE_WIDTH = 210;
export const NODE_MIN_HEIGHT = 54;
export const NODE_PADDING = 10;
export const NODE_BORDER_RADIUS = 6;
export const HORIZONTAL_SPACING = 28;
export const VERTICAL_SPACING = 48;
export const ARROW_HEAD_SIZE = 6;
export const CANVAS_PADDING = 40;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PositionedNode {
  id: string;
  node: ExplainNode;
  x: number;
  y: number;
  width: number;
  height: number;
  parentId: string | null;
}

export interface ExplainDiagramProps {
  plan: ParsedExplainPlan;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function estimateNodeHeight(node: ExplainNode): number {
  let h = 20; // operation name
  if (node.extras.table || node.extras.index) h += 14;
  if (node.cost !== undefined || node.estimatedRows !== undefined) h += 14;
  if (node.actualRows !== undefined) h += 14;
  return Math.max(NODE_MIN_HEIGHT, h + NODE_PADDING * 2);
}

export function getCostFraction(node: ExplainNode, maxCost: number): number {
  if (!node.cost || maxCost <= 0) return 0;
  return Math.min(1, node.cost / maxCost);
}

export function getCostColor(fraction: number): string {
  if (fraction > 0.5) return "var(--explain-diagram-red, #ef4444)";
  if (fraction > 0.2) return "var(--explain-diagram-orange, #f59e0b)";
  if (fraction > 0.05) return "var(--explain-diagram-yellow, #eab308)";
  return "var(--explain-diagram-green, #22c55e)";
}

export function getCostBgColor(fraction: number): string {
  if (fraction > 0.5) return "rgba(239, 68, 68, 0.12)";
  if (fraction > 0.2) return "rgba(245, 158, 11, 0.12)";
  if (fraction > 0.05) return "rgba(234, 179, 8, 0.12)";
  return "rgba(34, 197, 94, 0.12)";
}

export function formatCostCompact(cost: number | undefined): string {
  if (cost === undefined) return "";
  if (cost >= 1_000_000) return `${(cost / 1_000_000).toFixed(1)}M`;
  if (cost >= 1_000) return `${(cost / 1_000).toFixed(1)}K`;
  return cost.toFixed(1);
}

export function formatRowsCompact(rows: number | undefined): string {
  if (rows === undefined) return "";
  if (rows >= 1_000_000) return `${(rows / 1_000_000).toFixed(1)}M`;
  if (rows >= 1_000) return `${(rows / 1_000).toFixed(1)}K`;
  return rows.toLocaleString();
}

// ---------------------------------------------------------------------------
// Layout algorithm (recursive tree positioning)
// ---------------------------------------------------------------------------

export function layoutTree(
  nodeMap: Map<string, ExplainNode>,
  rootId: string,
  depth: number,
  xOffset: number,
  parentId: string | null,
): PositionedNode[] {
  const node = nodeMap.get(rootId);
  if (!node) return [];

  const nodeHeight = estimateNodeHeight(node);
  const children = node.children
    .map((cid) => nodeMap.get(cid))
    .filter((n): n is ExplainNode => Boolean(n));

  if (children.length === 0) {
    return [{
      id: node.id,
      node,
      x: xOffset + HORIZONTAL_SPACING,
      y: depth * (nodeHeight + VERTICAL_SPACING) + VERTICAL_SPACING,
      width: NODE_WIDTH,
      height: nodeHeight,
      parentId,
    }];
  }

  const childPositions: PositionedNode[] = [];
  let currentX = xOffset;

  for (const child of children) {
    const childNodes = layoutTree(nodeMap, child.id, depth + 1, currentX, node.id);
    const childWidth = subtreeWidth(childNodes);
    currentX += childWidth + HORIZONTAL_SPACING;
    childPositions.push(...childNodes);
  }

  // Center parent over children
  const directChildren = childPositions.filter((p) => p.parentId === node.id);
  const firstChildX = directChildren[0]?.x ?? xOffset;
  const lastChildX = directChildren[directChildren.length - 1]?.x ?? xOffset;
  const centerX = (firstChildX + lastChildX + NODE_WIDTH) / 2 - NODE_WIDTH / 2;

  return [
    {
      id: node.id,
      node,
      x: centerX,
      y: depth * (nodeHeight + VERTICAL_SPACING) + VERTICAL_SPACING,
      width: NODE_WIDTH,
      height: nodeHeight,
      parentId,
    },
    ...childPositions,
  ];
}

export function subtreeWidth(nodes: PositionedNode[]): number {
  if (nodes.length === 0) return NODE_WIDTH;
  const minX = Math.min(...nodes.map((n) => n.x));
  const maxX = Math.max(...nodes.map((n) => n.x + n.width));
  return maxX - minX;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
