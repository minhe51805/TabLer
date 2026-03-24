import { memo, useCallback, useMemo } from "react";
import { BaseEdge, EdgeLabelRenderer, useReactFlow, type Edge, type EdgeProps, type XYPosition } from "@xyflow/react";
import type { TableNodeData } from "./TableNode";
import {
  DIAGRAM_NODE_WIDTH,
  buildDiagramEdgePoints,
  estimateDiagramNodeHeight,
  getDiagramNodeAnchorPoint,
  getDiagramNodeCenter,
  pickDiagramAnchorSide,
  type DiagramNodeFrame,
} from "./layout";
import {
  buildERCardinalityMarker,
  formatERRelationshipSummary,
  type ERCardinalityEndpoint,
} from "./relationshipNotation";

export type EditableRelationEdgeData = Record<string, unknown> & {
  bendOffset?: XYPosition;
  sourceColumn?: string;
  targetColumn?: string;
  sourceCardinality?: ERCardinalityEndpoint;
  targetCardinality?: ERCardinalityEndpoint;
};

export type EditableRelationEdgeType = Edge<EditableRelationEdgeData, "editableRelationEdge">;

function buildEditablePath(points: XYPosition[]) {
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
}

export const EditableRelationEdge = memo(function EditableRelationEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  label,
  style,
  data,
  selected,
}: EdgeProps<EditableRelationEdgeType>) {
  const { getNode, setEdges, screenToFlowPosition } = useReactFlow();

  const sourceFrame = useMemo(() => {
    const node = getNode(source);
    if (!node) return null;

    const nodeData = node.data as TableNodeData;

    return {
      x: node.position.x,
      y: node.position.y,
      width: node.width || DIAGRAM_NODE_WIDTH,
      height: node.height || estimateDiagramNodeHeight(nodeData.columns.length, Boolean(nodeData.isExpanded)),
      columns: nodeData.columns,
      isExpanded: Boolean(nodeData.isExpanded),
    } satisfies DiagramNodeFrame;
  }, [getNode, source, sourceX, sourceY]);

  const targetFrame = useMemo(() => {
    const node = getNode(target);
    if (!node) return null;

    const nodeData = node.data as TableNodeData;

    return {
      x: node.position.x,
      y: node.position.y,
      width: node.width || DIAGRAM_NODE_WIDTH,
      height: node.height || estimateDiagramNodeHeight(nodeData.columns.length, Boolean(nodeData.isExpanded)),
      columns: nodeData.columns,
      isExpanded: Boolean(nodeData.isExpanded),
    } satisfies DiagramNodeFrame;
  }, [getNode, target, targetX, targetY]);

  const midpoint = useMemo(
    () =>
      sourceFrame && targetFrame
        ? {
            x: (getDiagramNodeCenter(sourceFrame).x + getDiagramNodeCenter(targetFrame).x) / 2,
            y: (getDiagramNodeCenter(sourceFrame).y + getDiagramNodeCenter(targetFrame).y) / 2,
          }
        : {
            x: (sourceX + targetX) / 2,
            y: (sourceY + targetY) / 2,
          },
    [sourceFrame, sourceX, sourceY, targetFrame, targetX, targetY]
  );

  const bendPoint = useMemo(
    () => ({
      x: midpoint.x + (data?.bendOffset?.x || 0),
      y: midpoint.y + (data?.bendOffset?.y || 0),
    }),
    [data?.bendOffset?.x, data?.bendOffset?.y, midpoint.x, midpoint.y]
  );

  const sourceAnchor = useMemo(() => {
    if (!sourceFrame) return { x: sourceX, y: sourceY };

    const side = pickDiagramAnchorSide(getDiagramNodeCenter(sourceFrame), bendPoint);
    return getDiagramNodeAnchorPoint(sourceFrame, side, data?.sourceColumn);
  }, [bendPoint, data?.sourceColumn, sourceFrame, sourceX, sourceY]);

  const targetAnchor = useMemo(() => {
    if (!targetFrame) return { x: targetX, y: targetY };

    const side = pickDiagramAnchorSide(getDiagramNodeCenter(targetFrame), bendPoint);
    return getDiagramNodeAnchorPoint(targetFrame, side, data?.targetColumn);
  }, [bendPoint, data?.targetColumn, targetFrame, targetX, targetY]);

  const edgePoints = useMemo(() => {
    const sourceSide = sourceFrame
      ? pickDiagramAnchorSide(getDiagramNodeCenter(sourceFrame), bendPoint)
      : "right";
    const targetSide = targetFrame
      ? pickDiagramAnchorSide(getDiagramNodeCenter(targetFrame), bendPoint)
      : "left";

    return buildDiagramEdgePoints(sourceAnchor, sourceSide, targetAnchor, targetSide, bendPoint);
  }, [bendPoint, sourceAnchor, sourceFrame, targetAnchor, targetFrame]);

  const path = useMemo(() => buildEditablePath(edgePoints), [edgePoints]);

  const strokeColor = typeof style?.stroke === "string" ? style.stroke : "#7BB1FF";

  const sourceMarker = useMemo(() => {
    if (!data?.sourceCardinality || edgePoints.length < 2) return null;
    return buildERCardinalityMarker(data.sourceCardinality, edgePoints[0], edgePoints[1]);
  }, [data?.sourceCardinality, edgePoints]);

  const targetMarker = useMemo(() => {
    if (!data?.targetCardinality || edgePoints.length < 2) return null;
    return buildERCardinalityMarker(data.targetCardinality, edgePoints[edgePoints.length - 1], edgePoints[edgePoints.length - 2]);
  }, [data?.targetCardinality, edgePoints]);

  const relationshipTitle = useMemo(() => {
    const baseLabel = typeof label === "string" ? label : id;
    if (!data?.sourceCardinality || !data?.targetCardinality) {
      return "Drag to reroute. Double-click to reset.";
    }

    return `${baseLabel} (${formatERRelationshipSummary({
      source: data.sourceCardinality,
      target: data.targetCardinality,
      kind:
        data.sourceCardinality.max === "one" && data.targetCardinality.max === "one"
          ? "one-to-one"
          : data.sourceCardinality.max === "one" && data.targetCardinality.max === "many"
            ? "one-to-many"
            : data.sourceCardinality.max === "many" && data.targetCardinality.max === "one"
              ? "many-to-one"
              : "many-to-many",
    })})`;
  }, [data?.sourceCardinality, data?.targetCardinality, id, label]);

  const updateBendPoint = useCallback(
    (position: XYPosition) => {
      setEdges((existing) =>
        existing.map((edge) =>
          edge.id === id
            ? {
                ...edge,
                data: {
                  ...edge.data,
                  bendOffset: {
                    x: position.x - midpoint.x,
                    y: position.y - midpoint.y,
                  },
                },
              }
            : edge
        )
      );
    },
    [id, midpoint.x, midpoint.y, setEdges]
  );

  const handleMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();

      const handleMouseMove = (moveEvent: MouseEvent) => {
        moveEvent.preventDefault();
        updateBendPoint(screenToFlowPosition({ x: moveEvent.clientX, y: moveEvent.clientY }));
      };

      const handleMouseUp = () => {
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
      };

      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    },
    [screenToFlowPosition, updateBendPoint]
  );

  const handleReset = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      updateBendPoint(midpoint);
    },
    [midpoint, updateBendPoint]
  );

  return (
    <>
      <BaseEdge id={id} path={path} style={style} interactionWidth={28} />
      <g className="erd-edge-notation" pointerEvents="none">
        {[sourceMarker, targetMarker].map((marker, markerIndex) =>
          marker ? (
            <g key={`${id}-marker-${markerIndex}`}>
              {marker.lines.map((line, lineIndex) => (
                <line
                  key={`${id}-marker-line-${markerIndex}-${lineIndex}`}
                  x1={line.from.x}
                  y1={line.from.y}
                  x2={line.to.x}
                  y2={line.to.y}
                  stroke={strokeColor}
                  strokeWidth={1.55}
                  strokeLinecap="round"
                />
              ))}
              {marker.circles.map((circle, circleIndex) => (
                <circle
                  key={`${id}-marker-circle-${markerIndex}-${circleIndex}`}
                  cx={circle.center.x}
                  cy={circle.center.y}
                  r={circle.radius}
                  fill="#090c12"
                  stroke={strokeColor}
                  strokeWidth={1.45}
                />
              ))}
            </g>
          ) : null
        )}
      </g>
      <EdgeLabelRenderer>
        <div
          className={`erd-edge-label nopan ${selected ? "is-selected" : ""}`}
          style={{
            transform: `translate(-50%, -50%) translate(${bendPoint.x}px, ${bendPoint.y}px)`,
          }}
          onMouseDown={handleMouseDown}
          onDoubleClick={handleReset}
          title={relationshipTitle}
        >
          <span className="erd-edge-label-text">{typeof label === "string" ? label : id}</span>
        </div>
      </EdgeLabelRenderer>
    </>
  );
});
