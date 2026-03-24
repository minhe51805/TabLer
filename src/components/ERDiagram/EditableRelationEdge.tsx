import { memo, useCallback, useMemo } from "react";
import { BaseEdge, EdgeLabelRenderer, useReactFlow, type Edge, type EdgeProps, type XYPosition } from "@xyflow/react";

export type EditableRelationEdgeData = Record<string, unknown> & {
  bendOffset?: XYPosition;
};

export type EditableRelationEdgeType = Edge<EditableRelationEdgeData, "editableRelationEdge">;

function buildEditablePath(sourceX: number, sourceY: number, targetX: number, targetY: number, bendX: number, bendY: number) {
  const points = [
    { x: sourceX, y: sourceY },
    { x: bendX, y: sourceY },
    { x: bendX, y: bendY },
    { x: targetX, y: bendY },
    { x: targetX, y: targetY },
  ].filter((point, index, all) => {
    if (index === 0) return true;
    const previous = all[index - 1];
    return previous.x !== point.x || previous.y !== point.y;
  });

  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
}

export const EditableRelationEdge = memo(function EditableRelationEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  label,
  markerEnd,
  style,
  data,
  selected,
}: EdgeProps<EditableRelationEdgeType>) {
  const { setEdges, screenToFlowPosition } = useReactFlow();

  const midpoint = useMemo(
    () => ({
      x: (sourceX + targetX) / 2,
      y: (sourceY + targetY) / 2,
    }),
    [sourceX, sourceY, targetX, targetY]
  );

  const bendPoint = useMemo(
    () => ({
      x: midpoint.x + (data?.bendOffset?.x || 0),
      y: midpoint.y + (data?.bendOffset?.y || 0),
    }),
    [data?.bendOffset?.x, data?.bendOffset?.y, midpoint.x, midpoint.y]
  );

  const path = useMemo(
    () => buildEditablePath(sourceX, sourceY, targetX, targetY, bendPoint.x, bendPoint.y),
    [bendPoint.x, bendPoint.y, sourceX, sourceY, targetX, targetY]
  );

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
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} interactionWidth={28} />
      <EdgeLabelRenderer>
        <div
          className={`erd-edge-label nopan ${selected ? "is-selected" : ""}`}
          style={{
            transform: `translate(-50%, -50%) translate(${bendPoint.x}px, ${bendPoint.y}px)`,
          }}
          onMouseDown={handleMouseDown}
          onDoubleClick={handleReset}
          title="Drag to reroute. Double-click to reset."
        >
          <span className="erd-edge-label-text">{typeof label === "string" ? label : id}</span>
        </div>
      </EdgeLabelRenderer>
    </>
  );
});
