/**
 * EXPLAIN Diagram View — SVG-based visual query plan diagram.
 * Renders parsed explain nodes as a tree of boxes with bezier arrows,
 * cost-based color coding, and interactive zoom/pan controls.
 */

import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { ZoomIn, ZoomOut, Maximize2 } from "lucide-react";
import type { ExplainNode, ParsedExplainPlan } from "../../utils/explain-parser";
import { getNodeCategory } from "../../utils/explain-parser";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const NODE_WIDTH = 210;
const NODE_MIN_HEIGHT = 54;
const NODE_PADDING = 10;
const NODE_BORDER_RADIUS = 6;
const HORIZONTAL_SPACING = 28;
const VERTICAL_SPACING = 48;
const ARROW_HEAD_SIZE = 6;
const CANVAS_PADDING = 40;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PositionedNode {
  id: string;
  node: ExplainNode;
  x: number;
  y: number;
  width: number;
  height: number;
  parentId: string | null;
}

interface ExplainDiagramProps {
  plan: ParsedExplainPlan;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function estimateNodeHeight(node: ExplainNode): number {
  let h = 20; // operation name
  if (node.extras.table || node.extras.index) h += 14;
  if (node.cost !== undefined || node.estimatedRows !== undefined) h += 14;
  if (node.actualRows !== undefined) h += 14;
  return Math.max(NODE_MIN_HEIGHT, h + NODE_PADDING * 2);
}

function getCostFraction(node: ExplainNode, maxCost: number): number {
  if (!node.cost || maxCost <= 0) return 0;
  return Math.min(1, node.cost / maxCost);
}

function getCostColor(fraction: number): string {
  if (fraction > 0.5) return "var(--explain-diagram-red, #ef4444)";
  if (fraction > 0.2) return "var(--explain-diagram-orange, #f59e0b)";
  if (fraction > 0.05) return "var(--explain-diagram-yellow, #eab308)";
  return "var(--explain-diagram-green, #22c55e)";
}

function getCostBgColor(fraction: number): string {
  if (fraction > 0.5) return "rgba(239, 68, 68, 0.12)";
  if (fraction > 0.2) return "rgba(245, 158, 11, 0.12)";
  if (fraction > 0.05) return "rgba(234, 179, 8, 0.12)";
  return "rgba(34, 197, 94, 0.12)";
}

function formatCostCompact(cost: number | undefined): string {
  if (cost === undefined) return "";
  if (cost >= 1_000_000) return `${(cost / 1_000_000).toFixed(1)}M`;
  if (cost >= 1_000) return `${(cost / 1_000).toFixed(1)}K`;
  return cost.toFixed(1);
}

function formatRowsCompact(rows: number | undefined): string {
  if (rows === undefined) return "";
  if (rows >= 1_000_000) return `${(rows / 1_000_000).toFixed(1)}M`;
  if (rows >= 1_000) return `${(rows / 1_000).toFixed(1)}K`;
  return rows.toLocaleString();
}

// ---------------------------------------------------------------------------
// Layout algorithm (recursive tree positioning)
// ---------------------------------------------------------------------------

function layoutTree(
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

function subtreeWidth(nodes: PositionedNode[]): number {
  if (nodes.length === 0) return NODE_WIDTH;
  const minX = Math.min(...nodes.map((n) => n.x));
  const maxX = Math.max(...nodes.map((n) => n.x + n.width));
  return maxX - minX;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ExplainDiagram({ plan }: ExplainDiagramProps) {
  const [zoom, setZoom] = useState(1);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const isPanning = useRef(false);
  const panStart = useRef({ x: 0, y: 0 });
  const panOffset = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  // Build node map
  const nodeMap = useMemo(() => {
    const map = new Map<string, ExplainNode>();
    for (const node of plan.nodes) {
      map.set(node.id, node);
    }
    return map;
  }, [plan.nodes]);

  // Layout all nodes
  const positionedNodes = useMemo(() => {
    const all: PositionedNode[] = [];
    let xOffset = 0;
    for (const rootId of plan.rootIds) {
      const subtree = layoutTree(nodeMap, rootId, 0, xOffset, null);
      const width = subtreeWidth(subtree);
      xOffset += width + HORIZONTAL_SPACING * 2;
      all.push(...subtree);
    }
    return all;
  }, [nodeMap, plan.rootIds]);

  // Canvas size
  const canvasSize = useMemo(() => {
    if (positionedNodes.length === 0) return { width: 400, height: 300 };
    const maxX = Math.max(...positionedNodes.map((n) => n.x + n.width));
    const maxY = Math.max(...positionedNodes.map((n) => n.y + n.height));
    return {
      width: maxX + CANVAS_PADDING * 2,
      height: maxY + CANVAS_PADDING * 2,
    };
  }, [positionedNodes]);

  // Max cost for color scaling
  const maxCost = useMemo(() => {
    let max = 0;
    for (const node of plan.nodes) {
      if (node.cost !== undefined && node.cost > max) max = node.cost;
    }
    return max;
  }, [plan.nodes]);

  // Node map by ID for arrow lookup
  const posMap = useMemo(() => {
    const map = new Map<string, PositionedNode>();
    for (const p of positionedNodes) {
      map.set(p.id, p);
    }
    return map;
  }, [positionedNodes]);

  // Zoom controls
  const zoomIn = useCallback(() => setZoom((z) => Math.min(3, z + 0.25)), []);
  const zoomOut = useCallback(() => setZoom((z) => Math.max(0.25, z - 0.25)), []);
  const zoomFit = useCallback(() => {
    if (!containerRef.current) return;
    const containerWidth = containerRef.current.clientWidth;
    const containerHeight = containerRef.current.clientHeight;
    const scaleX = containerWidth / canvasSize.width;
    const scaleY = containerHeight / canvasSize.height;
    const newZoom = Math.max(0.25, Math.min(2, Math.min(scaleX, scaleY) * 0.9));
    setZoom(newZoom);
    setPan({ x: 0, y: 0 });
  }, [canvasSize]);

  // Pan handlers
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    // Only start pan if clicking on the SVG background, not a node
    const target = e.target as Element;
    if (target.closest(".explain-diagram-node-group")) return;
    isPanning.current = true;
    panStart.current = { x: e.clientX, y: e.clientY };
    panOffset.current = { ...pan };
    e.preventDefault();
  }, [pan]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning.current) return;
    const dx = e.clientX - panStart.current.x;
    const dy = e.clientY - panStart.current.y;
    setPan({
      x: panOffset.current.x + dx,
      y: panOffset.current.y + dy,
    });
  }, []);

  const handleMouseUp = useCallback(() => {
    isPanning.current = false;
  }, []);

  // Keyboard zoom
  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) return;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.1 : 0.1;
        setZoom((z) => Math.max(0.25, Math.min(3, z + delta)));
      }
    };
    window.addEventListener("wheel", handleWheel, { passive: false });
    return () => window.removeEventListener("wheel", handleWheel);
  }, []);

  // Build arrow paths
  const arrows = useMemo(() => {
    const result: { from: PositionedNode; to: PositionedNode; path: string }[] = [];
    for (const node of positionedNodes) {
      if (!node.parentId) continue;
      const parent = posMap.get(node.parentId);
      if (!parent) continue;

      const startX = parent.x + parent.width / 2;
      const startY = parent.y + parent.height;
      const endX = node.x + node.width / 2;
      const endY = node.y;
      const midY = (startY + endY) / 2;

      const path = `M ${startX} ${startY} C ${startX} ${midY}, ${endX} ${midY}, ${endX} ${endY}`;
      result.push({ from: parent, to: node, path });
    }
    return result;
  }, [positionedNodes, posMap]);

  const selectedNode = selectedNodeId ? nodeMap.get(selectedNodeId) : null;

  return (
    <div
      ref={containerRef}
      className="explain-diagram-container"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      <svg
        className="explain-diagram-svg"
        width={canvasSize.width * zoom}
        height={canvasSize.height * zoom}
        viewBox={`0 0 ${canvasSize.width} ${canvasSize.height}`}
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px)`,
          cursor: isPanning.current ? "grabbing" : "grab",
        }}
      >
        {/* Arrows */}
        <defs>
          <marker
            id="explain-arrowhead"
            markerWidth={ARROW_HEAD_SIZE * 2}
            markerHeight={ARROW_HEAD_SIZE * 2}
            refX={ARROW_HEAD_SIZE}
            refY={ARROW_HEAD_SIZE}
            orient="auto"
          >
            <polygon
              points={`0 0, ${ARROW_HEAD_SIZE * 2} ${ARROW_HEAD_SIZE}, 0 ${ARROW_HEAD_SIZE * 2}`}
              fill="var(--text-muted, #666)"
              opacity="0.4"
            />
          </marker>
        </defs>

        {arrows.map((arrow, i) => (
          <path
            key={`arrow-${i}`}
            d={arrow.path}
            fill="none"
            stroke="var(--text-muted, #666)"
            strokeWidth="1.5"
            strokeOpacity="0.35"
            markerEnd="url(#explain-arrowhead)"
          />
        ))}

        {/* Nodes */}
        {positionedNodes.map((pos) => {
          const category = getNodeCategory(pos.node.operation);
          const fraction = getCostFraction(pos.node, maxCost);
          const borderColor = getCostColor(fraction);
          const bgColor = getCostBgColor(fraction);
          const isSelected = selectedNodeId === pos.id;

          return (
            <g
              key={pos.id}
              className="explain-diagram-node-group"
              transform={`translate(${pos.x}, ${pos.y})`}
              onClick={(e) => {
                e.stopPropagation();
                setSelectedNodeId(isSelected ? null : pos.id);
              }}
              style={{ cursor: "pointer" }}
            >
              {/* Node background */}
              <rect
                width={pos.width}
                height={pos.height}
                rx={NODE_BORDER_RADIUS}
                ry={NODE_BORDER_RADIUS}
                fill={bgColor}
                stroke={isSelected ? "var(--accent, #3b82f6)" : borderColor}
                strokeWidth={isSelected ? 2 : 1}
              />

              {/* Operation name */}
              <text
                x={NODE_PADDING}
                y={NODE_PADDING + 12}
                className="explain-diagram-node-op"
                fill="var(--text-primary, #fff)"
                fontSize="12"
                fontWeight="600"
              >
                {pos.node.operation.length > 26
                  ? pos.node.operation.slice(0, 24) + "…"
                  : pos.node.operation}
              </text>

              {/* Category badge */}
              <text
                x={pos.width - NODE_PADDING}
                y={NODE_PADDING + 12}
                className="explain-diagram-node-category"
                fill="var(--text-muted, #888)"
                fontSize="9"
                fontWeight="500"
                textAnchor="end"
                style={{ textTransform: "uppercase" }}
              >
                {category}
              </text>

              {/* Table / relation */}
              {(pos.node.extras.table || pos.node.extras.index) && (
                <text
                  x={NODE_PADDING}
                  y={NODE_PADDING + 26}
                  fill="var(--text-muted, #888)"
                  fontSize="10"
                >
                  {String(pos.node.extras.table || pos.node.extras.index).slice(0, 28)}
                </text>
              )}

              {/* Cost + Rows */}
              <text
                x={NODE_PADDING}
                y={pos.height - NODE_PADDING}
                fill="var(--text-muted, #666)"
                fontSize="9"
                fontFamily="var(--font-mono, monospace)"
              >
                {pos.node.cost !== undefined && `cost: ${formatCostCompact(pos.node.cost)}`}
                {pos.node.cost !== undefined && pos.node.estimatedRows !== undefined && "  "}
                {pos.node.estimatedRows !== undefined && `rows: ${formatRowsCompact(pos.node.estimatedRows)}`}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Zoom controls */}
      <div className="explain-diagram-zoom-controls">
        <button
          type="button"
          className="explain-diagram-zoom-btn"
          onClick={zoomOut}
          title="Zoom out"
        >
          <ZoomOut className="w-3.5 h-3.5" />
        </button>
        <span className="explain-diagram-zoom-label">{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          className="explain-diagram-zoom-btn"
          onClick={zoomIn}
          title="Zoom in"
        >
          <ZoomIn className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          className="explain-diagram-zoom-btn"
          onClick={zoomFit}
          title="Fit to view"
        >
          <Maximize2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Selected node detail popover */}
      {selectedNode && (
        <div className="explain-diagram-popover">
          <div className="explain-diagram-popover-header">{selectedNode.operation}</div>
          <div className="explain-diagram-popover-body">
            {selectedNode.cost !== undefined && (
              <div className="explain-diagram-popover-row">
                <span className="explain-diagram-popover-label">Cost</span>
                <span className="explain-diagram-popover-value">{selectedNode.cost.toFixed(2)}</span>
              </div>
            )}
            {selectedNode.startupCost !== undefined && (
              <div className="explain-diagram-popover-row">
                <span className="explain-diagram-popover-label">Startup</span>
                <span className="explain-diagram-popover-value">{selectedNode.startupCost.toFixed(2)}</span>
              </div>
            )}
            {selectedNode.estimatedRows !== undefined && (
              <div className="explain-diagram-popover-row">
                <span className="explain-diagram-popover-label">Est. Rows</span>
                <span className="explain-diagram-popover-value">{selectedNode.estimatedRows.toLocaleString()}</span>
              </div>
            )}
            {selectedNode.actualRows !== undefined && (
              <div className="explain-diagram-popover-row">
                <span className="explain-diagram-popover-label">Actual Rows</span>
                <span className="explain-diagram-popover-value">{selectedNode.actualRows.toLocaleString()}</span>
              </div>
            )}
            {selectedNode.estimatedRowWidth !== undefined && (
              <div className="explain-diagram-popover-row">
                <span className="explain-diagram-popover-label">Width</span>
                <span className="explain-diagram-popover-value">{selectedNode.estimatedRowWidth} bytes</span>
              </div>
            )}
            {Object.entries(selectedNode.extras)
              .filter(([, v]) => v !== null && v !== undefined)
              .slice(0, 8)
              .map(([k, v]) => (
                <div key={k} className="explain-diagram-popover-row">
                  <span className="explain-diagram-popover-label">{k}</span>
                  <span className="explain-diagram-popover-value">{String(v)}</span>
                </div>
              ))}
          </div>
          <button
            type="button"
            className="explain-diagram-popover-close"
            onClick={() => setSelectedNodeId(null)}
          >
            Close
          </button>
        </div>
      )}
    </div>
  );
}
