/**
 * Collision-free placement math for diagram nodes.
 */

import { type DiagramPoint } from "./layout";

const DIAGRAM_LEFT_OFFSET = 48;
const DIAGRAM_TOP_OFFSET = 48;
const DIAGRAM_COLLISION_PADDING = 14;
const DIAGRAM_POSITION_SEARCH_RADIUS = 18;

export function isDiagramPositionOverlapping(
  candidate: DiagramPoint,
  occupiedPositions: DiagramPoint[],
  nodeWidth: number,
  nodeHeight: number,
) {
  return occupiedPositions.some((occupied) => {
    const separatedHorizontally =
      candidate.x + nodeWidth + DIAGRAM_COLLISION_PADDING <= occupied.x ||
      occupied.x + nodeWidth + DIAGRAM_COLLISION_PADDING <= candidate.x;
    const separatedVertically =
      candidate.y + nodeHeight + DIAGRAM_COLLISION_PADDING <= occupied.y ||
      occupied.y + nodeHeight + DIAGRAM_COLLISION_PADDING <= candidate.y;

    return !(separatedHorizontally || separatedVertically);
  });
}

export function findAvailableDiagramPosition(
  preferredPosition: DiagramPoint,
  occupiedPositions: DiagramPoint[],
  nodeWidth: number,
  nodeHeight: number,
  slotWidth: number,
  slotHeight: number,
) {
  if (
    !isDiagramPositionOverlapping(
      preferredPosition,
      occupiedPositions,
      nodeWidth,
      nodeHeight,
    )
  ) {
    return preferredPosition;
  }

  const baseCol = Math.round(
    (preferredPosition.x - DIAGRAM_LEFT_OFFSET) / slotWidth,
  );
  const baseRow = Math.round(
    (preferredPosition.y - DIAGRAM_TOP_OFFSET) / slotHeight,
  );

  for (let radius = 0; radius <= DIAGRAM_POSITION_SEARCH_RADIUS; radius += 1) {
    for (let rowOffset = -radius; rowOffset <= radius; rowOffset += 1) {
      for (let colOffset = -radius; colOffset <= radius; colOffset += 1) {
        const isPerimeter =
          Math.abs(rowOffset) === radius || Math.abs(colOffset) === radius;
        if (!isPerimeter) continue;

        const candidate = {
          x: DIAGRAM_LEFT_OFFSET + (baseCol + colOffset) * slotWidth,
          y: DIAGRAM_TOP_OFFSET + (baseRow + rowOffset) * slotHeight,
        };

        if (
          !isDiagramPositionOverlapping(
            candidate,
            occupiedPositions,
            nodeWidth,
            nodeHeight,
          )
        ) {
          return candidate;
        }
      }
    }
  }

  return {
    x: preferredPosition.x + slotWidth,
    y: preferredPosition.y + slotHeight,
  };
}
