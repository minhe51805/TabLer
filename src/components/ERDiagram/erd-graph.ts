/**
 * Builds ReactFlow nodes and edges from a cached ER-diagram schema.
 */

import type { MouseEvent as ReactMouseEvent } from "react";
import type { Edge, Node } from "@xyflow/react";
import type { ERDiagramSchema, ERRelationship, TableSchema } from "../../types/database";
import {
  DIAGRAM_NODE_WIDTH,
  buildDiagramGridPositions,
  estimateDiagramNodeHeight,
  type DiagramPoint,
} from "./layout";
import {
  type ERDNodeContextPayload,
  type TableNodeType,
} from "./TableNode";
import { inferERRelationshipNotation } from "./relationshipNotation";
import { findAvailableDiagramPosition } from "./erd-placement";

const DIAGRAM_LEFT_OFFSET = 48;
const DIAGRAM_TOP_OFFSET = 48;
const DIAGRAM_HORIZONTAL_GAP = 42;
const DIAGRAM_VERTICAL_GAP = 42;
const DIAGRAM_RECOMMENDED_TABLE_COUNT = 12;

export const TABLE_COLORS = [
  "#84a3cd", // steel blue
  "#d0b37f", // clay
  "#81bb94", // sage
  "#c08686", // dusty rose
  "#8fb078", // moss
  "#a690cb", // lavender
  "#7fb3bd", // slate cyan
  "#848cc2", // periwinkle
];

export function getTableColor(index: number): string {
  return TABLE_COLORS[index % TABLE_COLORS.length];
}

function getTableRelationshipDegree(relationships: ERRelationship[]) {
  const degree = new Map<string, number>();

  relationships.forEach((relationship) => {
    degree.set(
      relationship.fromTable,
      (degree.get(relationship.fromTable) || 0) + 1,
    );
    degree.set(
      relationship.toTable,
      (degree.get(relationship.toTable) || 0) + 1,
    );
  });

  return degree;
}

export function getRecommendedTableSelection(schema: ERDiagramSchema) {
  const degree = getTableRelationshipDegree(schema.relationships);
  const rankedTables = [...schema.tables].sort((left, right) => {
    const degreeDifference =
      (degree.get(right.name) || 0) - (degree.get(left.name) || 0);
    if (degreeDifference !== 0) return degreeDifference;

    const rowDifference = (right.rowCount || 0) - (left.rowCount || 0);
    if (rowDifference !== 0) return rowDifference;

    return left.name.localeCompare(right.name);
  });

  return new Set(
    rankedTables
      .slice(0, Math.min(DIAGRAM_RECOMMENDED_TABLE_COUNT, rankedTables.length))
      .map((table) => table.name),
  );
}

export function getRelationshipSignature(
  relationship: Pick<
    ERRelationship,
    "fromTable" | "fromColumn" | "toTable" | "toColumn"
  >,
) {
  return `${relationship.fromTable}|${relationship.fromColumn}|${relationship.toTable}|${relationship.toColumn}`;
}

export function getRelationshipId(
  relationship: Pick<
    ERRelationship,
    "fromTable" | "fromColumn" | "toTable" | "toColumn"
  >,
) {
  return `custom-er-${getRelationshipSignature(relationship)}`;
}

function getRelationshipDisplayLabel(
  relationship: Pick<ERRelationship, "fromColumn" | "toColumn" | "label">,
) {
  const legacyArrowLabel = `${relationship.fromColumn} -> ${relationship.toColumn}`;
  if (relationship.label && relationship.label !== legacyArrowLabel) {
    return relationship.label;
  }

  return `${relationship.fromColumn} = ${relationship.toColumn}`;
}


export function buildNodes(
  tables: TableSchema[],
  relationships: ERRelationship[],
  selectedTableNames: Set<string>,
  expandedTableNames: Set<string>,
  existingNodes: Node[],
  rememberedPositions: Map<string, DiagramPoint>,
  onToggleTableExpanded: (tableName: string) => void,
  onOpenContextMenu: (
    event: ReactMouseEvent<HTMLElement>,
    payload: ERDNodeContextPayload,
  ) => void,
): TableNodeType[] {
  const relationshipDegree = getTableRelationshipDegree(relationships);
  const filtered = tables
    .filter((table) => selectedTableNames.has(table.name))
    .sort((left, right) => {
      const degreeDifference =
        (relationshipDegree.get(right.name) || 0) -
        (relationshipDegree.get(left.name) || 0);
      if (degreeDifference !== 0) return degreeDifference;
      return left.name.localeCompare(right.name);
    });
  if (filtered.length === 0) return [];

  const existingPositions = new Map(
    existingNodes.map((node) => [node.id, node.position]),
  );
  const tableOrder = new Map(tables.map((table, index) => [table.name, index]));
  const occupiedPositions: DiagramPoint[] = [];
  const maxNodeHeight = Math.max(
    ...filtered.map((table) =>
      estimateDiagramNodeHeight(
        table.columns.length,
        expandedTableNames.has(table.name),
      ),
    ),
    138,
  );
  const slotWidth = DIAGRAM_NODE_WIDTH + DIAGRAM_HORIZONTAL_GAP;
  const slotHeight = maxNodeHeight + DIAGRAM_VERTICAL_GAP;
  const plannedPositions = buildDiagramGridPositions(filtered.length, maxNodeHeight, {
    left: DIAGRAM_LEFT_OFFSET,
    top: DIAGRAM_TOP_OFFSET,
    horizontalGap: DIAGRAM_HORIZONTAL_GAP,
    verticalGap: DIAGRAM_VERTICAL_GAP,
    maxColumns: 10,
  });

  return filtered.map((table, index) => {
    const isExpanded = expandedTableNames.has(table.name);
    const preferredPosition = existingPositions.get(table.name) ||
      rememberedPositions.get(table.name) || plannedPositions[index];
    const resolvedPosition = findAvailableDiagramPosition(
      preferredPosition,
      occupiedPositions,
      DIAGRAM_NODE_WIDTH,
      maxNodeHeight,
      slotWidth,
      slotHeight,
    );
    occupiedPositions.push(resolvedPosition);

    return {
      id: table.name,
      type: "tableNode",
      position: { ...resolvedPosition },
      data: {
        label: table.name,
        schemaName: table.schema,
        columns: table.columns,
        rowCount: table.rowCount,
        color: getTableColor(tableOrder.get(table.name) ?? index),
        isExpanded,
        onToggleExpanded: () => onToggleTableExpanded(table.name),
        onOpenContextMenu,
      },
    };
  });
}

export function buildEdges(
  tables: TableSchema[],
  relationships: ERRelationship[],
  selectedTableNames: Set<string>,
  existingEdges: Edge[],
  rememberedBends: Map<string, DiagramPoint>,
): Edge[] {
  const existingBends = new Map(
    existingEdges.map((edge) => [
      edge.id,
      (edge.data as { bendOffset?: DiagramPoint } | undefined)?.bendOffset || {
        x: 0,
        y: 0,
      },
    ]),
  );
  const tableMap = new Map(tables.map((table) => [table.name, table]));

  return relationships
    .filter(
      (relationship) =>
        selectedTableNames.has(relationship.fromTable) &&
        selectedTableNames.has(relationship.toTable),
    )
    .map((relationship) => {
      const notation = inferERRelationshipNotation(
        tableMap.get(relationship.fromTable),
        relationship.fromColumn,
        tableMap.get(relationship.toTable),
        relationship.toColumn,
        { enforceReferenceConstraint: !relationship.isCustom },
      );

      return {
        id: relationship.id,
        source: relationship.fromTable,
        target: relationship.toTable,
        label: getRelationshipDisplayLabel(relationship),
        type: "editableRelationEdge",
        animated: false,
        data: {
          bendOffset: existingBends.get(relationship.id) ||
            rememberedBends.get(relationship.id) || { x: 0, y: 0 },
          sourceColumn: relationship.fromColumn,
          targetColumn: relationship.toColumn,
          sourceCardinality: notation.source,
          targetCardinality: notation.target,
        },
        style: {
          stroke: "#7BB1FF",
          strokeWidth: 1.7,
        },
      };
    });
}
