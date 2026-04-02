import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  Panel,
  type Node,
  type Edge,
  type Connection,
  type EdgeTypes,
  type NodeTypes,
  type OnConnect,
  BackgroundVariant,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import {
  Search,
  Database,
  RefreshCw,
  Download,
  FileText,
  Maximize2,
  Settings,
  CheckCheck,
  Square,
  GitBranch,
  Link2,
  PanelLeftClose,
  PanelLeftOpen,
  X,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../stores/appStore";
import type { ColumnDetail, DatabaseType, TableInfo, TableStructure, ERDiagramSchema, TableSchema, ERRelationship } from "../../types/database";
import { ERDCompactSelect, type ERDSelectOption } from "./ERDCompactSelect";
import { ERDContextMenu, type ERDContextMenuState, type ERDContextMenuItem } from "./ERDContextMenu";
import { ERDQuickColumnModal } from "./ERDQuickColumnModal";
import { EditableRelationEdge } from "./EditableRelationEdge";
import { TableNode, type ERDNodeContextPayload, type TableNodeData, type TableNodeType } from "./TableNode";
import {
  DIAGRAM_NODE_HEADER_HEIGHT,
  DIAGRAM_NODE_ROW_GAP,
  DIAGRAM_NODE_ROW_HEIGHT,
  DIAGRAM_NODE_WIDTH,
  buildDiagramEdgePoints,
  estimateDiagramNodeHeight,
  getDiagramNodeAnchorPoint,
  getDiagramNodeCenter,
  getVisibleDiagramColumns,
  pickDiagramAnchorSide,
  type DiagramNodeFrame,
  type DiagramPoint,
} from "./layout";
import {
  buildERCardinalityMarker,
  formatERRelationshipSummary,
  inferERRelationshipNotation,
  type ERCardinalityEndpoint,
} from "./relationshipNotation";
import {
  buildColumnAlterStatements,
  createEditorState,
  formatDbError,
  getDefaultValueForType,
  qualifyTableName,
  quoteIdentifier,
  type ColumnEditorState,
} from "../TableStructure/utils/dialect-sql-generator";

interface Props {
  connectionId: string;
  database?: string;
}

interface PendingRelationshipDraft {
  sourceTable: string;
  targetTable: string;
  sourceColumn: string;
  targetColumn: string;
  step: "select" | "confirm";
}

interface QuickColumnEditorState {
  tableName: string;
  schemaName?: string;
  originalColumn: ColumnDetail;
  editor: ColumnEditorState;
}

const TABLE_COLORS = ["#6366F1", "#8B5CF6", "#EC4899", "#F59E0B", "#10B981", "#3B82F6", "#EF4444", "#14B8A6"];
const DIAGRAM_LEFT_OFFSET = 244;
const DIAGRAM_TOP_OFFSET = 64;
const DIAGRAM_HORIZONTAL_GAP = 24;
const DIAGRAM_VERTICAL_GAP = 30;
const DIAGRAM_INITIAL_FIT_PADDING = 0.2;
const DIAGRAM_INITIAL_FIT_MAX_ZOOM = 0.68;
const DIAGRAM_MIN_ZOOM = 0.18;
const DIAGRAM_MAX_ZOOM = 1.5;
const DIAGRAM_COLLISION_PADDING = 14;
const DIAGRAM_POSITION_SEARCH_RADIUS = 18;
const DIAGRAM_EXPORT_PADDING = 40;
const DIAGRAM_EXPORT_SCALE = 2;
const CUSTOM_ER_RELATIONSHIPS_STORAGE_KEY = "tabler.erd.customRelationships.v1";

function getTableColor(index: number): string {
  return TABLE_COLORS[index % TABLE_COLORS.length];
}

function getRelationshipSignature(relationship: Pick<ERRelationship, "fromTable" | "fromColumn" | "toTable" | "toColumn">) {
  return `${relationship.fromTable}|${relationship.fromColumn}|${relationship.toTable}|${relationship.toColumn}`;
}

function getRelationshipId(relationship: Pick<ERRelationship, "fromTable" | "fromColumn" | "toTable" | "toColumn">) {
  return `custom-er-${getRelationshipSignature(relationship)}`;
}

function getRelationshipDisplayLabel(relationship: Pick<ERRelationship, "fromColumn" | "toColumn" | "label">) {
  const legacyArrowLabel = `${relationship.fromColumn} -> ${relationship.toColumn}`;
  if (relationship.label && relationship.label !== legacyArrowLabel) {
    return relationship.label;
  }

  return `${relationship.fromColumn} = ${relationship.toColumn}`;
}

function getQualifiedTableName(table: Pick<TableSchema, "name" | "schema">) {
  return table.schema ? `${table.schema}.${table.name}` : table.name;
}

function getERDiagramScopeKey(connectionId: string, database?: string) {
  return `${connectionId}|${database || ""}`;
}

function readCustomRelationships(connectionId: string, database?: string): ERRelationship[] {
  try {
    const raw = window.localStorage.getItem(CUSTOM_ER_RELATIONSHIPS_STORAGE_KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw) as Record<string, ERRelationship[]>;
    const scopeKey = getERDiagramScopeKey(connectionId, database);
    return Array.isArray(parsed?.[scopeKey]) ? parsed[scopeKey] : [];
  } catch {
    return [];
  }
}

function persistCustomRelationships(connectionId: string, database: string | undefined, relationships: ERRelationship[]) {
  try {
    const raw = window.localStorage.getItem(CUSTOM_ER_RELATIONSHIPS_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, ERRelationship[]>) : {};
    const scopeKey = getERDiagramScopeKey(connectionId, database);

    parsed[scopeKey] = relationships;
    window.localStorage.setItem(CUSTOM_ER_RELATIONSHIPS_STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    // Ignore storage failures and keep the in-memory graph responsive.
  }
}

function dedupeRelationships(relationships: ERRelationship[]) {
  const unique = new Map<string, ERRelationship>();

  relationships.forEach((relationship) => {
    unique.set(getRelationshipSignature(relationship), relationship);
  });

  return [...unique.values()];
}

function getPreferredRelationshipDraft(sourceTable: TableSchema, targetTable: TableSchema): Pick<PendingRelationshipDraft, "sourceColumn" | "targetColumn"> {
  const preferredSource = sourceTable.columns.find((column) => column.is_primary_key) || sourceTable.columns[0];
  const preferredNames = new Set(
    [
      preferredSource?.name,
      `${sourceTable.name}_id`,
      `${sourceTable.name.replace(/\s+/g, "_")}_id`,
    ]
      .filter(Boolean)
      .map((value) => value.toLowerCase())
  );

  const preferredTarget =
    targetTable.columns.find((column) => preferredNames.has(column.name.toLowerCase())) ||
    targetTable.columns.find((column) => !column.is_primary_key) ||
    targetTable.columns[0];

  return {
    sourceColumn: preferredSource?.name || "",
    targetColumn: preferredTarget?.name || "",
  };
}

function getColumnOptionLabel(column: ColumnDetail) {
  const parts = [column.data_type];

  if (column.is_primary_key) parts.push("PK");
  if (!column.is_nullable) parts.push("NOT NULL");

  return parts.join(" / ");
}

function getColumnSelectOption(column: ColumnDetail): ERDSelectOption {
  return {
    value: column.name,
    label: column.name,
    meta: getColumnOptionLabel(column),
  };
}

function formatCompactCount(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function hasFiniteRowCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function sanitizeFileName(value: string) {
  return value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function truncateCanvasText(context: CanvasRenderingContext2D, value: string, maxWidth: number) {
  if (context.measureText(value).width <= maxWidth) return value;

  const ellipsis = "...";
  let next = value;

  while (next.length > 0 && context.measureText(`${next}${ellipsis}`).width > maxWidth) {
    next = next.slice(0, -1);
  }

  return next ? `${next}${ellipsis}` : ellipsis;
}

function drawRoundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  fillStyle: string,
  strokeStyle?: string,
  lineWidth = 1
) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
  context.fillStyle = fillStyle;
  context.fill();

  if (strokeStyle) {
    context.lineWidth = lineWidth;
    context.strokeStyle = strokeStyle;
    context.stroke();
  }
}

interface ExportNodeLayout {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  data: TableNodeData;
}

interface ExportEdgeLayout {
  id: string;
  source: string;
  target: string;
  label: string;
  points: DiagramPoint[];
  bendPoint: DiagramPoint;
  sourceCardinality?: ERCardinalityEndpoint;
  targetCardinality?: ERCardinalityEndpoint;
}

interface ExportDiagramSnapshot {
  nodes: ExportNodeLayout[];
  edges: ExportEdgeLayout[];
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
}

function buildExportEdgeLayout(edge: Edge, nodeMap: Map<string, ExportNodeLayout>): ExportEdgeLayout | null {
  const sourceNode = nodeMap.get(edge.source);
  const targetNode = nodeMap.get(edge.target);
  if (!sourceNode || !targetNode) return null;

  const sourceFrame: DiagramNodeFrame = {
    x: sourceNode.x,
    y: sourceNode.y,
    width: sourceNode.width,
    height: sourceNode.height,
    columns: sourceNode.data.columns,
    isExpanded: Boolean(sourceNode.data.isExpanded),
  };
  const targetFrame: DiagramNodeFrame = {
    x: targetNode.x,
    y: targetNode.y,
    width: targetNode.width,
    height: targetNode.height,
    columns: targetNode.data.columns,
    isExpanded: Boolean(targetNode.data.isExpanded),
  };
  const sourceCenter = getDiagramNodeCenter(sourceFrame);
  const targetCenter = getDiagramNodeCenter(targetFrame);
  const midpoint = {
    x: (sourceCenter.x + targetCenter.x) / 2,
    y: (sourceCenter.y + targetCenter.y) / 2,
  };
  const edgeData = (edge.data as {
    bendOffset?: DiagramPoint;
    sourceColumn?: string;
    targetColumn?: string;
    sourceCardinality?: ERCardinalityEndpoint;
    targetCardinality?: ERCardinalityEndpoint;
  } | undefined) || {};
  const bendOffset = edgeData.bendOffset || { x: 0, y: 0 };
  const bendPoint = {
    x: midpoint.x + bendOffset.x,
    y: midpoint.y + bendOffset.y,
  };
  const sourceSide = pickDiagramAnchorSide(sourceCenter, bendPoint);
  const targetSide = pickDiagramAnchorSide(targetCenter, bendPoint);
  const sourcePoint = getDiagramNodeAnchorPoint(sourceFrame, sourceSide, edgeData.sourceColumn);
  const targetPoint = getDiagramNodeAnchorPoint(targetFrame, targetSide, edgeData.targetColumn);
  const points = buildDiagramEdgePoints(sourcePoint, sourceSide, targetPoint, targetSide, bendPoint);

  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: typeof edge.label === "string" ? edge.label : edge.id,
    points,
    bendPoint,
    sourceCardinality: edgeData.sourceCardinality,
    targetCardinality: edgeData.targetCardinality,
  };
}

function buildERDiagramExportSnapshot(nodes: Node[], edges: Edge[]): ExportDiagramSnapshot | null {
  const exportNodes = nodes.map((node) => {
    const data = node.data as TableNodeData;

    return {
      id: node.id,
      x: node.position.x,
      y: node.position.y,
      width: DIAGRAM_NODE_WIDTH,
      height: estimateDiagramNodeHeight(data.columns.length, Boolean(data.isExpanded)),
      data,
    } satisfies ExportNodeLayout;
  });

  if (exportNodes.length === 0) return null;

  const nodeMap = new Map(exportNodes.map((node) => [node.id, node]));
  const exportEdges = edges
    .map((edge) => buildExportEdgeLayout(edge, nodeMap))
    .filter((edge): edge is ExportEdgeLayout => Boolean(edge));

  const edgePoints = exportEdges.flatMap((edge) => [...edge.points, edge.bendPoint]);
  const minX = Math.min(...exportNodes.map((node) => node.x), ...edgePoints.map((point) => point.x));
  const minY = Math.min(...exportNodes.map((node) => node.y), ...edgePoints.map((point) => point.y));
  const maxX = Math.max(...exportNodes.map((node) => node.x + node.width), ...edgePoints.map((point) => point.x));
  const maxY = Math.max(...exportNodes.map((node) => node.y + node.height), ...edgePoints.map((point) => point.y));
  const exportWidth = Math.max(320, Math.ceil(maxX - minX + DIAGRAM_EXPORT_PADDING * 2));
  const exportHeight = Math.max(220, Math.ceil(maxY - minY + DIAGRAM_EXPORT_PADDING * 2));
  const offsetX = DIAGRAM_EXPORT_PADDING - minX;
  const offsetY = DIAGRAM_EXPORT_PADDING - minY;

  return {
    nodes: exportNodes,
    edges: exportEdges,
    width: exportWidth,
    height: exportHeight,
    offsetX,
    offsetY,
  };
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatDrawioNodeValue(node: ExportNodeLayout) {
  const isExpanded = Boolean(node.data.isExpanded);
  const visibleColumns = getVisibleDiagramColumns(node.data.columns, isExpanded);
  const hiddenCount = Math.max(0, node.data.columns.length - visibleColumns.length);
  const lines = [
    node.data.label,
    ...visibleColumns.map((column) => {
      const prefix = column.is_primary_key ? "PK " : "";
      const nullable = column.is_nullable ? " nullable" : "";
      return `${prefix}${column.name} : ${column.data_type}${nullable}`;
    }),
    hiddenCount > 0 ? `+${hiddenCount} more columns` : null,
  ].filter((line): line is string => Boolean(line));

  return lines.map((line) => escapeXml(line)).join("&#xa;");
}

function buildDrawioDiagramXml(snapshot: ExportDiagramSnapshot) {
  const vertexIdMap = new Map<string, string>();
  snapshot.nodes.forEach((node, index) => {
    vertexIdMap.set(node.id, `vertex-${index + 2}`);
  });

  const vertexCells = snapshot.nodes
    .map((node) => {
      const cellId = vertexIdMap.get(node.id) || node.id;
      const x = Math.round(node.x + snapshot.offsetX);
      const y = Math.round(node.y + snapshot.offsetY);
      const width = Math.round(node.width);
      const height = Math.round(node.height);
      const value = formatDrawioNodeValue(node);
      const style = [
        "rounded=1",
        "whiteSpace=wrap",
        "html=0",
        "align=left",
        "verticalAlign=top",
        "spacing=10",
        "arcSize=10",
        "fillColor=#0d1018",
        `strokeColor=${node.data.color}`,
        "fontColor=#eef3fb",
        "fontSize=10",
        "fontStyle=1",
      ].join(";");

      return `<mxCell id="${cellId}" value="${value}" style="${style}" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="${width}" height="${height}" as="geometry" /></mxCell>`;
    })
    .join("");

  const edgeCells = snapshot.edges
    .map((edge, index) => {
      const geometryPoints = edge.points
        .slice(1, -1)
        .map(
          (point) =>
            `<mxPoint x="${Math.round(point.x + snapshot.offsetX)}" y="${Math.round(point.y + snapshot.offsetY)}" />`
        )
        .join("");
      const sourceVertexId = vertexIdMap.get(edge.source);
      const targetVertexId = vertexIdMap.get(edge.target);
      const style = [
        "edgeStyle=orthogonalEdgeStyle",
        "rounded=0",
        "orthogonalLoop=1",
        "jettySize=auto",
        "html=0",
        "strokeColor=#22d3ee",
        "fontColor=#d8e2f1",
        "fontSize=10",
        "endArrow=block",
        "endFill=1",
      ].join(";");

      return `<mxCell id="edge-${index + 1000}" value="${escapeXml(edge.label)}" style="${style}" edge="1" parent="1"${
        sourceVertexId ? ` source="${sourceVertexId}"` : ""
      }${targetVertexId ? ` target="${targetVertexId}"` : ""}><mxGeometry relative="1" as="geometry">${
        geometryPoints ? `<Array as="points">${geometryPoints}</Array>` : ""
      }</mxGeometry></mxCell>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?><mxfile host="app.diagrams.net" agent="TableR" version="24.7.17"><diagram id="table-r-erd" name="ERD"><mxGraphModel dx="1600" dy="900" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="${Math.max(1169, Math.round(snapshot.width + 160))}" pageHeight="${Math.max(827, Math.round(snapshot.height + 160))}" background="#060810" math="0" shadow="0"><root><mxCell id="0" /><mxCell id="1" parent="0" />${vertexCells}${edgeCells}</root></mxGraphModel></diagram></mxfile>`;
}

function drawCardinalityMarkerOnCanvas(
  context: CanvasRenderingContext2D,
  anchor: DiagramPoint,
  awayPoint: DiagramPoint,
  cardinality: ERCardinalityEndpoint | undefined,
  strokeColor: string
) {
  const marker = buildERCardinalityMarker(cardinality, anchor, awayPoint);
  if (!marker) return;

  context.save();
  context.strokeStyle = strokeColor;
  context.lineWidth = 1.5;
  context.lineCap = "round";

  marker.lines.forEach((line) => {
    context.beginPath();
    context.moveTo(line.from.x, line.from.y);
    context.lineTo(line.to.x, line.to.y);
    context.stroke();
  });

  marker.circles.forEach((circle) => {
    context.beginPath();
    context.fillStyle = "#060810";
    context.arc(circle.center.x, circle.center.y, circle.radius, 0, Math.PI * 2);
    context.fill();
    context.stroke();
  });

  context.restore();
}

function renderERDiagramCanvas(nodes: Node[], edges: Edge[]) {
  const snapshot = buildERDiagramExportSnapshot(nodes, edges);
  if (!snapshot) return null;

  const canvas = document.createElement("canvas");
  canvas.width = snapshot.width * DIAGRAM_EXPORT_SCALE;
  canvas.height = snapshot.height * DIAGRAM_EXPORT_SCALE;

  const context = canvas.getContext("2d");
  if (!context) return null;

  context.scale(DIAGRAM_EXPORT_SCALE, DIAGRAM_EXPORT_SCALE);

  const backgroundGradient = context.createLinearGradient(0, 0, 0, snapshot.height);
  backgroundGradient.addColorStop(0, "#080b10");
  backgroundGradient.addColorStop(1, "#060810");
  context.fillStyle = backgroundGradient;
  context.fillRect(0, 0, snapshot.width, snapshot.height);

  const topGlow = context.createRadialGradient(snapshot.width * 0.2, snapshot.height * 0.12, 0, snapshot.width * 0.2, snapshot.height * 0.12, snapshot.width * 0.34);
  topGlow.addColorStop(0, "rgba(34, 211, 238, 0.12)");
  topGlow.addColorStop(1, "rgba(34, 211, 238, 0)");
  context.fillStyle = topGlow;
  context.fillRect(0, 0, snapshot.width, snapshot.height);

  const bottomGlow = context.createRadialGradient(snapshot.width * 0.82, snapshot.height * 0.84, 0, snapshot.width * 0.82, snapshot.height * 0.84, snapshot.width * 0.28);
  bottomGlow.addColorStop(0, "rgba(16, 185, 129, 0.1)");
  bottomGlow.addColorStop(1, "rgba(16, 185, 129, 0)");
  context.fillStyle = bottomGlow;
  context.fillRect(0, 0, snapshot.width, snapshot.height);

  context.fillStyle = "rgba(255, 255, 255, 0.05)";
  for (let x = 12; x < snapshot.width; x += 22) {
    for (let y = 12; y < snapshot.height; y += 22) {
      context.fillRect(x, y, 1.2, 1.2);
    }
  }

  snapshot.edges.forEach((edge) => {
    const strokeColor = "#22d3ee";

    context.save();
    context.beginPath();
    edge.points.forEach((point, index) => {
      const x = point.x + snapshot.offsetX;
      const y = point.y + snapshot.offsetY;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.strokeStyle = strokeColor;
    context.lineWidth = 1.7;
    context.shadowColor = "rgba(34, 211, 238, 0.18)";
    context.shadowBlur = 8;
    context.stroke();
    context.restore();

    if (edge.points.length >= 2) {
      drawCardinalityMarkerOnCanvas(
        context,
        {
          x: edge.points[0].x + snapshot.offsetX,
          y: edge.points[0].y + snapshot.offsetY,
        },
        {
          x: edge.points[1].x + snapshot.offsetX,
          y: edge.points[1].y + snapshot.offsetY,
        },
        edge.sourceCardinality,
        strokeColor
      );
      drawCardinalityMarkerOnCanvas(
        context,
        {
          x: edge.points[edge.points.length - 1].x + snapshot.offsetX,
          y: edge.points[edge.points.length - 1].y + snapshot.offsetY,
        },
        {
          x: edge.points[edge.points.length - 2].x + snapshot.offsetX,
          y: edge.points[edge.points.length - 2].y + snapshot.offsetY,
        },
        edge.targetCardinality,
        strokeColor
      );
    }

    context.save();
    context.font = '700 9px "Segoe UI", sans-serif';
    const label = truncateCanvasText(context, edge.label, 128);
    const labelWidth = Math.min(136, context.measureText(label).width + 14);
    const labelHeight = 18;
    const labelX = edge.bendPoint.x + snapshot.offsetX - labelWidth / 2;
    const labelY = edge.bendPoint.y + snapshot.offsetY - labelHeight / 2;
    drawRoundedRect(context, labelX, labelY, labelWidth, labelHeight, 9, "rgba(8, 11, 16, 0.94)", "rgba(34, 211, 238, 0.18)");
    context.fillStyle = "#d8e2f1";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(label, labelX + labelWidth / 2, labelY + labelHeight / 2 + 0.5);
    context.restore();
  });

  snapshot.nodes.forEach((node) => {
    const isExpanded = Boolean(node.data.isExpanded);
    const visibleColumns = getVisibleDiagramColumns(node.data.columns, isExpanded);
    const hiddenCount = Math.max(0, node.data.columns.length - visibleColumns.length);
    const x = node.x + snapshot.offsetX;
    const y = node.y + snapshot.offsetY;
    const width = node.width;
    const height = node.height;
    const accent = node.data.color;
    const headerHeight = DIAGRAM_NODE_HEADER_HEIGHT;

    context.save();
    context.shadowColor = "rgba(0, 0, 0, 0.28)";
    context.shadowBlur = 18;
    drawRoundedRect(context, x, y, width, height, 12, "rgba(12, 16, 24, 0.98)", "rgba(122, 147, 198, 0.16)");
    context.restore();

    context.save();
    context.beginPath();
    context.roundRect(x, y, width, height, 12);
    context.clip();
    context.fillStyle = "rgba(255, 255, 255, 0.035)";
    context.fillRect(x, y, width, headerHeight);
    context.fillStyle = accent;
    context.fillRect(x, y, width, 3);
    const accentGlow = context.createRadialGradient(x + width - 30, y + 14, 0, x + width - 30, y + 14, 54);
    accentGlow.addColorStop(0, `${accent}30`);
    accentGlow.addColorStop(1, `${accent}00`);
    context.fillStyle = accentGlow;
    context.fillRect(x, y, width, headerHeight + 20);
    context.restore();

    context.strokeStyle = "rgba(122, 147, 198, 0.12)";
    context.beginPath();
    context.moveTo(x, y + headerHeight);
    context.lineTo(x + width, y + headerHeight);
    context.stroke();

    context.fillStyle = accent;
    context.beginPath();
    context.arc(x + 12, y + 14, 4, 0, Math.PI * 2);
    context.fill();

    context.textAlign = "left";
    context.textBaseline = "top";
    context.fillStyle = "#8f99ab";
    context.font = '800 7px "Segoe UI", sans-serif';
    context.fillText("TABLE", x + 22, y + 9);

    context.fillStyle = "#eef3fb";
    context.font = '700 11px "Segoe UI", sans-serif';
    context.fillText(truncateCanvasText(context, node.data.label, width - 42), x + 22, y + 18);

    const pills = [`${node.data.columns.length} cols`];
    if (hasFiniteRowCount(node.data.rowCount)) {
      pills.push(`${formatCompactCount(node.data.rowCount)} rows`);
    }

    context.font = '700 8px "Segoe UI", sans-serif';
    let pillX = x + 10;
    pills.forEach((pill) => {
      const pillWidth = context.measureText(pill).width + 12;
      drawRoundedRect(context, pillX, y + 31, pillWidth, 14, 999, "rgba(255, 255, 255, 0.04)", "rgba(122, 147, 198, 0.14)");
      context.fillStyle = "#c3cede";
      context.textBaseline = "middle";
      context.fillText(pill, pillX + 6, y + 38);
      pillX += pillWidth + 6;
    });

    let rowY = y + headerHeight + 8;
    visibleColumns.forEach((column) => {
      const isPrimary = column.is_primary_key;
      drawRoundedRect(
        context,
        x + 7,
        rowY,
        width - 14,
        22,
        8,
        isPrimary ? "rgba(34, 211, 238, 0.08)" : "rgba(255, 255, 255, 0.03)",
        isPrimary ? "rgba(34, 211, 238, 0.16)" : undefined
      );

      drawRoundedRect(
        context,
        x + 12,
        rowY + 3,
        isPrimary ? 26 : 28,
        12,
        999,
        isPrimary ? "rgba(34, 211, 238, 0.1)" : "rgba(255, 255, 255, 0.04)",
        isPrimary ? "rgba(34, 211, 238, 0.22)" : "rgba(122, 147, 198, 0.14)"
      );
      context.fillStyle = isPrimary ? "#22d3ee" : "#8f99ab";
      context.font = '800 6px "Segoe UI", sans-serif';
      context.textBaseline = "middle";
      context.fillText(isPrimary ? "PK" : "COL", x + 18, rowY + 9.5);

      context.fillStyle = "#eef3fb";
      context.font = '600 8px "Segoe UI", sans-serif';
      context.fillText(truncateCanvasText(context, column.name, width - 78), x + 46, rowY + 8);

      context.fillStyle = "#c3cede";
      context.font = '400 7px "Segoe UI", sans-serif';
      const detail = `${column.data_type}${column.is_nullable ? " / nullable" : ""}`;
      context.fillText(truncateCanvasText(context, detail, width - 78), x + 46, rowY + 15);

      rowY += DIAGRAM_NODE_ROW_HEIGHT + DIAGRAM_NODE_ROW_GAP;
    });

    if (node.data.columns.length > visibleColumns.length || isExpanded) {
      context.strokeStyle = "rgba(122, 147, 198, 0.12)";
      context.beginPath();
      context.moveTo(x + 8, rowY + 2);
      context.lineTo(x + width - 8, rowY + 2);
      context.stroke();

      if (isExpanded) {
        drawRoundedRect(context, x + width / 2 - 34, rowY + 6, 28, 14, 999, "rgba(34, 211, 238, 0.08)", "rgba(34, 211, 238, 0.16)");
        context.fillStyle = "#c3cede";
        context.font = '700 7px "Segoe UI", sans-serif';
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText("less", x + width / 2 - 20, rowY + 13);

        context.fillStyle = "#8f99ab";
        context.font = '700 7px "Segoe UI", sans-serif';
        context.textAlign = "left";
        context.fillText("show less", x + width / 2 - 2, rowY + 13);
      } else {
        drawRoundedRect(context, x + width / 2 - 34, rowY + 6, 28, 14, 999, "rgba(255, 255, 255, 0.04)", "rgba(122, 147, 198, 0.14)");
        context.fillStyle = "#c3cede";
        context.font = '700 8px "Segoe UI", sans-serif';
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(`+${hiddenCount}`, x + width / 2 - 20, rowY + 13);

        context.fillStyle = "#8f99ab";
        context.font = '700 7px "Segoe UI", sans-serif';
        context.textAlign = "left";
        context.fillText("more columns", x + width / 2 - 2, rowY + 13);
      }
    }
  });

  return canvas;
}

function isDiagramPositionOverlapping(
  candidate: DiagramPoint,
  occupiedPositions: DiagramPoint[],
  nodeWidth: number,
  nodeHeight: number
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

function findAvailableDiagramPosition(
  preferredPosition: DiagramPoint,
  occupiedPositions: DiagramPoint[],
  nodeWidth: number,
  nodeHeight: number,
  slotWidth: number,
  slotHeight: number
) {
  if (!isDiagramPositionOverlapping(preferredPosition, occupiedPositions, nodeWidth, nodeHeight)) {
    return preferredPosition;
  }

  const baseCol = Math.round((preferredPosition.x - DIAGRAM_LEFT_OFFSET) / slotWidth);
  const baseRow = Math.round((preferredPosition.y - DIAGRAM_TOP_OFFSET) / slotHeight);

  for (let radius = 0; radius <= DIAGRAM_POSITION_SEARCH_RADIUS; radius += 1) {
    for (let rowOffset = -radius; rowOffset <= radius; rowOffset += 1) {
      for (let colOffset = -radius; colOffset <= radius; colOffset += 1) {
        const isPerimeter = Math.abs(rowOffset) === radius || Math.abs(colOffset) === radius;
        if (!isPerimeter) continue;

        const candidate = {
          x: DIAGRAM_LEFT_OFFSET + (baseCol + colOffset) * slotWidth,
          y: DIAGRAM_TOP_OFFSET + (baseRow + rowOffset) * slotHeight,
        };

        if (!isDiagramPositionOverlapping(candidate, occupiedPositions, nodeWidth, nodeHeight)) {
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

function buildNodes(
  tables: TableSchema[],
  selectedTableNames: Set<string>,
  expandedTableNames: Set<string>,
  existingNodes: Node[],
  rememberedPositions: Map<string, DiagramPoint>,
  onToggleTableExpanded: (tableName: string) => void,
  onOpenContextMenu: (event: ReactMouseEvent<HTMLElement>, payload: ERDNodeContextPayload) => void
): TableNodeType[] {
  const filtered = tables.filter((table) => selectedTableNames.has(table.name));
  if (filtered.length === 0) return [];

  const existingPositions = new Map(existingNodes.map((node) => [node.id, node.position]));
  const tableOrder = new Map(tables.map((table, index) => [table.name, index]));
  const occupiedPositions: DiagramPoint[] = [];
  const maxNodeHeight = Math.max(
    ...filtered.map((table) => estimateDiagramNodeHeight(table.columns.length, expandedTableNames.has(table.name))),
    138
  );
  const slotWidth = DIAGRAM_NODE_WIDTH + DIAGRAM_HORIZONTAL_GAP;
  const slotHeight = maxNodeHeight + DIAGRAM_VERTICAL_GAP;
  const colsCount = Math.max(1, Math.min(3, Math.ceil(Math.sqrt(filtered.length))));

  return filtered.map((table, index) => {
    const col = index % colsCount;
    const row = Math.floor(index / colsCount);
    const isExpanded = expandedTableNames.has(table.name);
    const preferredPosition =
      existingPositions.get(table.name) ||
      rememberedPositions.get(table.name) || {
        x: DIAGRAM_LEFT_OFFSET + col * slotWidth,
        y: DIAGRAM_TOP_OFFSET + row * slotHeight,
      };
    const resolvedPosition = findAvailableDiagramPosition(
      preferredPosition,
      occupiedPositions,
      DIAGRAM_NODE_WIDTH,
      maxNodeHeight,
      slotWidth,
      slotHeight
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

function buildEdges(
  tables: TableSchema[],
  relationships: ERRelationship[],
  selectedTableNames: Set<string>,
  existingEdges: Edge[],
  rememberedBends: Map<string, DiagramPoint>
): Edge[] {
  const existingBends = new Map(
    existingEdges.map((edge) => [edge.id, ((edge.data as { bendOffset?: DiagramPoint } | undefined)?.bendOffset || { x: 0, y: 0 })])
  );
  const tableMap = new Map(tables.map((table) => [table.name, table]));

  return relationships
    .filter((relationship) => selectedTableNames.has(relationship.fromTable) && selectedTableNames.has(relationship.toTable))
    .map((relationship) => {
      const notation = inferERRelationshipNotation(
        tableMap.get(relationship.fromTable),
        relationship.fromColumn,
        tableMap.get(relationship.toTable),
        relationship.toColumn,
        { enforceReferenceConstraint: !relationship.isCustom }
      );

      return {
        id: relationship.id,
        source: relationship.fromTable,
        target: relationship.toTable,
        label: getRelationshipDisplayLabel(relationship),
        type: "editableRelationEdge",
        animated: false,
        data: {
          bendOffset: existingBends.get(relationship.id) || rememberedBends.get(relationship.id) || { x: 0, y: 0 },
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

async function fetchSchema(connectionId: string, database?: string): Promise<ERDiagramSchema> {
  const tables = await invoke<TableInfo[]>("list_tables", { connectionId, database: database || null });

  const tableSchemas: TableSchema[] = [];
  const allRelationships: ERRelationship[] = [];
  const batchSize = 5;

  for (let index = 0; index < tables.length; index += batchSize) {
    const batch = tables.slice(index, index + batchSize);
    const structures = await Promise.all(
      batch.map((table) =>
        invoke<TableStructure>("get_table_structure", {
          connectionId,
          table: table.name,
          database: database || null,
        })
      )
    );

    batch.forEach((table, batchIndex) => {
      const structure = structures[batchIndex];
      tableSchemas.push({
        name: table.name,
        schema: table.schema,
        columns: structure.columns,
        indexes: structure.indexes,
        rowCount: table.row_count,
      });

      structure.foreign_keys.forEach((foreignKey, foreignKeyIndex) => {
        allRelationships.push({
          id: `fk-${table.name}-${foreignKey.column}-${foreignKeyIndex}`,
          fromTable: table.name,
          fromColumn: foreignKey.column,
          toTable: foreignKey.referenced_table,
          toColumn: foreignKey.referenced_column,
        });
      });
    });
  }

  return { tables: tableSchemas, relationships: allRelationships };
}

export function ERDiagram({ connectionId, database }: Props) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const hasInitializedSelectionRef = useRef(false);
  const rememberedNodePositionsRef = useRef<Map<string, DiagramPoint>>(new Map());
  const rememberedEdgeBendsRef = useRef<Map<string, DiagramPoint>>(new Map());
  const addTab = useAppStore((state) => state.addTab);
  const setActiveTab = useAppStore((state) => state.setActiveTab);
  const updateTab = useAppStore((state) => state.updateTab);
  const connections = useAppStore((state) => state.connections);
  const countTableNullValues = useAppStore((state) => state.countTableNullValues);
  const executeStructureStatements = useAppStore((state) => state.executeStructureStatements);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [schema, setSchema] = useState<ERDiagramSchema | null>(null);
  const [customRelationships, setCustomRelationships] = useState<ERRelationship[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set());
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set());
  const [showMinimap, setShowMinimap] = useState(true);
  const [showControls, setShowControls] = useState(true);
  const [isSidePanelCollapsed, setIsSidePanelCollapsed] = useState(false);
  const [exportFormat, setExportFormat] = useState<"png" | "drawio" | null>(null);
  const [tableFilter, setTableFilter] = useState("");
  const [pendingRelationship, setPendingRelationship] = useState<PendingRelationshipDraft | null>(null);
  const [relationshipModalError, setRelationshipModalError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ERDContextMenuState | null>(null);
  const [quickColumnEditor, setQuickColumnEditor] = useState<QuickColumnEditorState | null>(null);
  const [quickColumnEditorError, setQuickColumnEditorError] = useState<string | null>(null);
  const [isApplyingQuickColumnEdit, setIsApplyingQuickColumnEdit] = useState(false);

  const nodeTypes = useMemo<NodeTypes>(() => ({ tableNode: TableNode }), []);
  const edgeTypes = useMemo<EdgeTypes>(() => ({ editableRelationEdge: EditableRelationEdge }), []);
  const allRelationships = useMemo(
    () => dedupeRelationships([...(schema?.relationships || []), ...customRelationships]),
    [customRelationships, schema]
  );
  const activeConnection = useMemo(() => connections.find((item) => item.id === connectionId), [connectionId, connections]);
  const activeDbType = (activeConnection?.db_type || "postgresql") as DatabaseType;
  const activeDatabaseLabel = database || schema?.tables[0]?.schema || "Current database";

  useEffect(() => {
    hasInitializedSelectionRef.current = false;
    rememberedNodePositionsRef.current.clear();
    rememberedEdgeBendsRef.current.clear();
    setCustomRelationships(readCustomRelationships(connectionId, database));
    setPendingRelationship(null);
    setRelationshipModalError(null);
    setExportError(null);
    setContextMenu(null);
    setQuickColumnEditor(null);
    setQuickColumnEditorError(null);
    setIsApplyingQuickColumnEdit(false);
    setExpandedTables(new Set());
  }, [connectionId, database]);

  const loadSchema = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const data = await fetchSchema(connectionId, database);
      setSchema(data);
      setSelectedTables((current) => {
        const allTableNames = data.tables.map((table) => table.name);
        if (!hasInitializedSelectionRef.current) {
          hasInitializedSelectionRef.current = true;
          return new Set(allTableNames);
        }

        if (current.size === 0) return current;

        const availableNames = new Set(allTableNames);
        const preservedNames = [...current].filter((tableName) => availableNames.has(tableName));
        return preservedNames.length > 0 ? new Set(preservedNames) : new Set(allTableNames);
      });
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(false);
    }
  }, [connectionId, database]);

  useEffect(() => {
    loadSchema();
  }, [loadSchema]);

  const handleTableExpandToggle = useCallback((tableName: string) => {
    setExpandedTables((current) => {
      const next = new Set(current);

      if (next.has(tableName)) next.delete(tableName);
      else next.add(tableName);

      return next;
    });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const tableMap = useMemo(() => {
    return new Map((schema?.tables || []).map((table) => [table.name, table]));
  }, [schema]);

  const openTableDataTab = useCallback(
    (tableName: string) => {
      const table = tableMap.get(tableName);
      if (!table) return;

      const qualifiedName = getQualifiedTableName(table);
      const tabId = `table-${connectionId}-${database || ""}-${qualifiedName}`;
      addTab({
        id: tabId,
        type: "table",
        title: table.name,
        connectionId,
        tableName: qualifiedName,
        database: database || undefined,
      });
      setActiveTab(tabId);
    },
    [addTab, connectionId, database, setActiveTab, tableMap]
  );

  const openStructureEditor = useCallback(
    (tableName: string, section: "columns" | "indexes" | "foreign_keys" | "triggers" | "view_definition", columnName?: string) => {
      const table = tableMap.get(tableName);
      if (!table) return;

      const qualifiedName = getQualifiedTableName(table);
      const tabId = `structure-${connectionId}-${database || ""}-${qualifiedName}`;
      const focusToken = crypto.randomUUID();
      const focusState = {
        structureFocusSection: section,
        structureFocusColumn: columnName,
        structureFocusToken: focusToken,
      } as const;
      const existingTab = useAppStore.getState().tabs.find((tab) => tab.id === tabId);

      if (existingTab) {
        updateTab(tabId, focusState);
        setActiveTab(tabId);
        return;
      }

      addTab({
        id: tabId,
        type: "structure",
        title: `${table.name} (structure)`,
        connectionId,
        tableName: qualifiedName,
        database: database || undefined,
        ...focusState,
      });
      setActiveTab(tabId);
    },
    [addTab, connectionId, database, setActiveTab, tableMap, updateTab]
  );

  const handleNodeContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>, payload: ERDNodeContextPayload) => {
      setContextMenu({
        x: event.clientX,
        y: event.clientY,
        tableName: payload.tableName,
        schemaName: payload.schemaName,
        columnName: payload.columnName,
      });
    },
    []
  );

  const openQuickColumnEditor = useCallback(
    (tableName: string, columnName: string) => {
      const table = tableMap.get(tableName);
      const column = table?.columns.find((item) => item.name.toLowerCase() === columnName.toLowerCase());
      if (!table || !column) return;

      setQuickColumnEditor({
        tableName: table.name,
        schemaName: table.schema,
        originalColumn: column,
        editor: createEditorState(column),
      });
      setQuickColumnEditorError(null);
      setIsApplyingQuickColumnEdit(false);
    },
    [tableMap]
  );

  const closeQuickColumnEditor = useCallback(() => {
    if (isApplyingQuickColumnEdit) return;
    setQuickColumnEditor(null);
    setQuickColumnEditorError(null);
  }, [isApplyingQuickColumnEdit]);

  const updateQuickColumnEditor = useCallback((updates: Partial<ColumnEditorState>) => {
    setQuickColumnEditorError(null);
    setQuickColumnEditor((current) =>
      current
        ? {
            ...current,
            editor: {
              ...current.editor,
              ...updates,
            },
          }
        : current
    );
  }, []);

  const quickColumnSqlPreview = useMemo(() => {
    if (!quickColumnEditor) {
      return { statements: [] };
    }

    return buildColumnAlterStatements(
      activeDbType,
      getQualifiedTableName({
        name: quickColumnEditor.tableName,
        schema: quickColumnEditor.schemaName,
      }),
      database || undefined,
      quickColumnEditor.originalColumn,
      quickColumnEditor.editor
    );
  }, [activeDbType, database, quickColumnEditor]);

  const handleApplyQuickColumnEdit = useCallback(async () => {
    if (!quickColumnEditor) return;

    if (quickColumnSqlPreview.error) {
      setQuickColumnEditorError(quickColumnSqlPreview.error);
      return;
    }

    if (quickColumnSqlPreview.statements.length === 0) {
      setQuickColumnEditorError("No changes to apply.");
      return;
    }

    const qualifiedTableName = getQualifiedTableName({
      name: quickColumnEditor.tableName,
      schema: quickColumnEditor.schemaName,
    });

    setQuickColumnEditorError(null);
    setIsApplyingQuickColumnEdit(true);

    try {
      const shouldSetNotNull =
        !quickColumnEditor.editor.isPrimaryKey &&
        !quickColumnEditor.editor.nullable &&
        quickColumnEditor.originalColumn.is_nullable;

      if (shouldSetNotNull) {
        const nullCount = await countTableNullValues(
          connectionId,
          qualifiedTableName,
          quickColumnEditor.originalColumn.name,
          database || undefined
        );

        if (nullCount > 0) {
          const defaultValue = getDefaultValueForType(quickColumnEditor.editor.dataType);
          const confirmed = window.confirm(
            `Column "${quickColumnEditor.originalColumn.name}" has ${nullCount} NULL value(s).\n\n` +
              `To set NOT NULL, TableR can update them to ${defaultValue} first.\n\n` +
              `Click OK to continue, or Cancel to stop.`
          );

          if (!confirmed) {
            throw new Error("Apply cancelled.");
          }

          const tableRef = qualifyTableName(activeDbType, qualifiedTableName, database || undefined);
          const columnRef = quoteIdentifier(activeDbType, quickColumnEditor.originalColumn.name);
          const fixSql = `UPDATE ${tableRef} SET ${columnRef} = ${defaultValue} WHERE ${columnRef} IS NULL`;
          await executeStructureStatements(connectionId, [fixSql]);
        }
      }

      await executeStructureStatements(connectionId, quickColumnSqlPreview.statements);
      await loadSchema();
      window.dispatchEvent(
        new CustomEvent("table-structure-updated", {
          detail: {
            connectionId,
            tableName: qualifiedTableName,
            database: database || undefined,
          },
        })
      );
      setQuickColumnEditor(null);
      setQuickColumnEditorError(null);
    } catch (reason) {
      const formattedError = formatDbError(reason, qualifiedTableName);
      if (formattedError !== "Apply cancelled.") {
        setQuickColumnEditorError(formattedError);
      }
    } finally {
      setIsApplyingQuickColumnEdit(false);
    }
  }, [
    activeDbType,
    connectionId,
    countTableNullValues,
    database,
    executeStructureStatements,
    loadSchema,
    quickColumnEditor,
    quickColumnSqlPreview.error,
    quickColumnSqlPreview.statements,
  ]);

  useEffect(() => {
    if (!contextMenu) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".erd-context-menu")) return;
      setContextMenu(null);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(null);
      }
    };

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);

    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!schema) return;

    setNodes((existing) => {
      existing.forEach((node) => {
        rememberedNodePositionsRef.current.set(node.id, { ...node.position });
      });

      return buildNodes(
        schema.tables,
        selectedTables,
        expandedTables,
        existing,
        rememberedNodePositionsRef.current,
        handleTableExpandToggle,
        handleNodeContextMenu
      );
    });

    setEdges((existing) => {
      existing.forEach((edge) => {
        const bendOffset = (edge.data as { bendOffset?: DiagramPoint } | undefined)?.bendOffset;
        if (bendOffset) {
          rememberedEdgeBendsRef.current.set(edge.id, { ...bendOffset });
        }
      });

      return buildEdges(schema.tables, allRelationships, selectedTables, existing, rememberedEdgeBendsRef.current);
    });
  }, [allRelationships, expandedTables, handleNodeContextMenu, handleTableExpandToggle, schema, selectedTables, setNodes, setEdges]);

  useEffect(() => {
    nodes.forEach((node) => {
      rememberedNodePositionsRef.current.set(node.id, { ...node.position });
    });
  }, [nodes]);

  useEffect(() => {
    edges.forEach((edge) => {
      const bendOffset = (edge.data as { bendOffset?: DiagramPoint } | undefined)?.bendOffset;
      if (bendOffset) {
        rememberedEdgeBendsRef.current.set(edge.id, { ...bendOffset });
      }
    });
  }, [edges]);

  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      if (!schema || !connection.source || !connection.target) return;

      const sourceTable = schema.tables.find((table) => table.name === connection.source);
      const targetTable = schema.tables.find((table) => table.name === connection.target);
      if (!sourceTable || !targetTable) return;

      const defaults = getPreferredRelationshipDraft(sourceTable, targetTable);
      setRelationshipModalError(null);
      setPendingRelationship({
        sourceTable: sourceTable.name,
        targetTable: targetTable.name,
        sourceColumn: defaults.sourceColumn,
        targetColumn: defaults.targetColumn,
        step: "select",
      });
    },
    [schema]
  );

  const closeRelationshipModal = useCallback(() => {
    setPendingRelationship(null);
    setRelationshipModalError(null);
  }, []);

  const sourceTableForDraft = pendingRelationship
    ? schema?.tables.find((table) => table.name === pendingRelationship.sourceTable) || null
    : null;
  const targetTableForDraft = pendingRelationship
    ? schema?.tables.find((table) => table.name === pendingRelationship.targetTable) || null
    : null;
  const sourceColumnOptions = useMemo(
    () => sourceTableForDraft?.columns.map(getColumnSelectOption) || [],
    [sourceTableForDraft]
  );
  const targetColumnOptions = useMemo(
    () => targetTableForDraft?.columns.map(getColumnSelectOption) || [],
    [targetTableForDraft]
  );
  const pendingRelationshipNotation = useMemo(() => {
    if (!pendingRelationship || !sourceTableForDraft || !targetTableForDraft) return null;
    if (!pendingRelationship.sourceColumn || !pendingRelationship.targetColumn) return null;

    return inferERRelationshipNotation(
      sourceTableForDraft,
      pendingRelationship.sourceColumn,
      targetTableForDraft,
      pendingRelationship.targetColumn,
      { enforceReferenceConstraint: false }
    );
  }, [pendingRelationship, sourceTableForDraft, targetTableForDraft]);
  const canAdvanceRelationshipDraft = Boolean(
    pendingRelationship?.sourceColumn &&
      pendingRelationship?.targetColumn &&
      sourceTableForDraft &&
      targetTableForDraft
  );

  const confirmRelationshipDraft = useCallback(() => {
    if (!pendingRelationship) return;

    const relationship: ERRelationship = {
      id: getRelationshipId({
        fromTable: pendingRelationship.sourceTable,
        fromColumn: pendingRelationship.sourceColumn,
        toTable: pendingRelationship.targetTable,
        toColumn: pendingRelationship.targetColumn,
      }),
      fromTable: pendingRelationship.sourceTable,
      fromColumn: pendingRelationship.sourceColumn,
      toTable: pendingRelationship.targetTable,
      toColumn: pendingRelationship.targetColumn,
      label: `${pendingRelationship.sourceColumn} = ${pendingRelationship.targetColumn}`,
      isCustom: true,
    };

    const signature = getRelationshipSignature(relationship);
    const alreadyExists = allRelationships.some((item) => getRelationshipSignature(item) === signature);

    if (alreadyExists) {
      setRelationshipModalError("This relationship already exists in the diagram.");
      return;
    }

    const nextRelationships = dedupeRelationships([...customRelationships, relationship]);
    setCustomRelationships(nextRelationships);
    persistCustomRelationships(connectionId, database, nextRelationships);
    rememberedEdgeBendsRef.current.set(relationship.id, { x: 0, y: 0 });
    setPendingRelationship(null);
    setRelationshipModalError(null);
  }, [allRelationships, connectionId, customRelationships, database, pendingRelationship]);

  const openRelationshipConfirmation = useCallback(() => {
    if (!canAdvanceRelationshipDraft || !pendingRelationship) {
      setRelationshipModalError("Choose both columns before continuing.");
      return;
    }

    setRelationshipModalError(null);
    setPendingRelationship((current) => (current ? { ...current, step: "confirm" } : current));
  }, [canAdvanceRelationshipDraft, pendingRelationship]);

  const handleTableToggle = (tableName: string) => {
    setSelectedTables((current) => {
      const next = new Set(current);

      if (next.has(tableName)) next.delete(tableName);
      else next.add(tableName);

      return next;
    });
  };

  const handleSelectAll = () => {
    if (!schema) return;
    setSelectedTables(new Set(schema.tables.map((table) => table.name)));
  };

  const handleClearAll = () => {
    setSelectedTables(new Set());
  };

  const handleExportPNG = useCallback(async () => {
    if (nodes.length === 0) {
      setExportError("Select at least one table before exporting the diagram.");
      return;
    }

    try {
      setExportFormat("png");
      setExportError(null);

      const canvas = renderERDiagramCanvas(nodes, edges);
      if (!canvas) {
        throw new Error("Could not prepare the ER diagram export image.");
      }

      const fileName = `${sanitizeFileName(activeDatabaseLabel || "er-diagram") || "er-diagram"}.png`;
      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob((value) => resolve(value), "image/png");
      });
      const downloadLink = document.createElement("a");
      downloadLink.download = fileName;
      downloadLink.style.display = "none";

      if (blob) {
        const objectUrl = URL.createObjectURL(blob);
        downloadLink.href = objectUrl;
        document.body.appendChild(downloadLink);
        downloadLink.click();
        downloadLink.remove();
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      } else {
        downloadLink.href = canvas.toDataURL("image/png");
        document.body.appendChild(downloadLink);
        downloadLink.click();
        downloadLink.remove();
      }
    } catch (reason) {
      setExportError(reason instanceof Error ? reason.message : "Could not export the ER diagram PNG.");
    } finally {
      setExportFormat(null);
    }
  }, [activeDatabaseLabel, edges, nodes]);

  const handleExportDrawio = useCallback(async () => {
    if (nodes.length === 0) {
      setExportError("Select at least one table before exporting the diagram.");
      return;
    }

    try {
      setExportFormat("drawio");
      setExportError(null);

      const snapshot = buildERDiagramExportSnapshot(nodes, edges);
      if (!snapshot) {
        throw new Error("Could not prepare the ER diagram export file.");
      }

      const xml = buildDrawioDiagramXml(snapshot);
      const fileName = `${sanitizeFileName(activeDatabaseLabel || "er-diagram") || "er-diagram"}.drawio`;
      const blob = new Blob([xml], { type: "application/vnd.jgraph.mxfile+xml;charset=utf-8" });
      const objectUrl = URL.createObjectURL(blob);
      const downloadLink = document.createElement("a");

      downloadLink.download = fileName;
      downloadLink.href = objectUrl;
      downloadLink.style.display = "none";
      document.body.appendChild(downloadLink);
      downloadLink.click();
      downloadLink.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (reason) {
      setExportError(reason instanceof Error ? reason.message : "Could not export the ER diagram draw.io file.");
    } finally {
      setExportFormat(null);
    }
  }, [activeDatabaseLabel, edges, nodes]);

  const contextMenuItems = useMemo<ERDContextMenuItem[]>(() => {
    if (!contextMenu) return [];

    if (contextMenu.columnName) {
      return [
        {
          key: "edit-column",
          label: `Edit column ${contextMenu.columnName}`,
          action: () => openQuickColumnEditor(contextMenu.tableName, contextMenu.columnName || ""),
        },
        {
          key: "edit-columns",
          label: "Open columns editor",
          action: () => openStructureEditor(contextMenu.tableName, "columns"),
        },
        {
          key: "edit-indexes",
          label: "Edit indexes",
          action: () => openStructureEditor(contextMenu.tableName, "indexes"),
        },
        {
          key: "edit-foreign-keys",
          label: "Edit foreign keys",
          action: () => openStructureEditor(contextMenu.tableName, "foreign_keys"),
        },
        { key: "divider-open", divider: true },
        {
          key: "open-data",
          label: "Open table data",
          action: () => openTableDataTab(contextMenu.tableName),
        },
      ];
    }

    return [
      {
        key: "edit-columns",
        label: "Edit columns",
        action: () => openStructureEditor(contextMenu.tableName, "columns"),
      },
      {
        key: "edit-indexes",
        label: "Edit indexes",
        action: () => openStructureEditor(contextMenu.tableName, "indexes"),
      },
      {
        key: "edit-foreign-keys",
        label: "Edit foreign keys",
        action: () => openStructureEditor(contextMenu.tableName, "foreign_keys"),
      },
      {
        key: "inspect-triggers",
        label: "Inspect triggers",
        action: () => openStructureEditor(contextMenu.tableName, "triggers"),
      },
      { key: "divider-open", divider: true },
      {
        key: "open-data",
        label: "Open table data",
        action: () => openTableDataTab(contextMenu.tableName),
      },
    ];
  }, [contextMenu, openQuickColumnEditor, openStructureEditor, openTableDataTab]);

  const handleOpenFullEditorFromQuickModal = useCallback(() => {
    if (!quickColumnEditor) return;

    openStructureEditor(quickColumnEditor.tableName, "columns", quickColumnEditor.originalColumn.name);
    setQuickColumnEditor(null);
    setQuickColumnEditorError(null);
  }, [openStructureEditor, quickColumnEditor]);

  const filteredTables = useMemo(() => {
    if (!schema) return [];

    const keyword = tableFilter.trim().toLowerCase();
    if (!keyword) return schema.tables;

    return schema.tables.filter((table) => table.name.toLowerCase().includes(keyword));
  }, [schema, tableFilter]);

  const tableColorMap = useMemo(() => {
    return new Map((schema?.tables || []).map((table, index) => [table.name, getTableColor(index)]));
  }, [schema]);

  const visibleRelationshipCount = useMemo(() => {
    if (!schema) return 0;

    return allRelationships.filter(
      (relationship) => selectedTables.has(relationship.fromTable) && selectedTables.has(relationship.toTable)
    ).length;
  }, [allRelationships, schema, selectedTables]);
  const bannerError = error || exportError;

  return (
    <div ref={shellRef} className="erd-shell">
      <div className="erd-topbar">
        <div className="erd-topbar-heading">
          <span className="erd-topbar-kicker">Entity Relationship View</span>
          <strong className="erd-topbar-title">{activeDatabaseLabel}</strong>
        </div>

        <div className="erd-toolbar-group">
          <button
            type="button"
            onClick={loadSchema}
            disabled={loading}
            className="erd-toolbar-button"
          >
            <RefreshCw className={`erd-toolbar-icon ${loading ? "is-spinning" : ""}`} />
            {loading ? "Refreshing" : "Refresh"}
          </button>

          <button
            type="button"
            onClick={() => setShowMinimap((value) => !value)}
            className={`erd-toolbar-button ${showMinimap ? "is-active" : ""}`}
          >
            <Maximize2 className="erd-toolbar-icon" />
            Minimap
          </button>

          <button
            type="button"
            onClick={() => setShowControls((value) => !value)}
            className={`erd-toolbar-button ${showControls ? "is-active" : ""}`}
          >
            <Settings className="erd-toolbar-icon" />
            Controls
          </button>
        </div>

        <div className="erd-toolbar-spacer" />

        <div className="erd-toolbar-stats">
          <span className="erd-toolbar-stat">
            <Database className="erd-toolbar-icon" />
            {schema ? `${selectedTables.size} / ${schema.tables.length} tables` : "Preparing schema"}
          </span>
          <span className="erd-toolbar-stat">
            <GitBranch className="erd-toolbar-icon" />
            {schema ? `${visibleRelationshipCount} links` : "Checking links"}
          </span>
        </div>

        <button
          type="button"
          onClick={handleExportPNG}
          disabled={exportFormat !== null || nodes.length === 0}
          className="erd-toolbar-button is-primary"
        >
          <Download className="erd-toolbar-icon" />
          {exportFormat === "png" ? "Exporting" : "Export PNG"}
        </button>

        <button
          type="button"
          onClick={handleExportDrawio}
          disabled={exportFormat !== null || nodes.length === 0}
          className="erd-toolbar-button"
        >
          <FileText className="erd-toolbar-icon" />
          {exportFormat === "drawio" ? "Exporting" : "Export Draw.io"}
        </button>
      </div>

      {bannerError && <div className="erd-error-banner">{bannerError}</div>}

      {loading && !schema && (
        <div className="erd-loading-state">
          <RefreshCw className="erd-loading-icon" />
          <div className="erd-loading-copy">
            <strong>Loading diagram data</strong>
            <span>Reading tables, columns, and relationships from the current database.</span>
          </div>
        </div>
      )}

      {!loading && schema && (
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          fitViewOptions={{ padding: DIAGRAM_INITIAL_FIT_PADDING, maxZoom: DIAGRAM_INITIAL_FIT_MAX_ZOOM }}
          minZoom={DIAGRAM_MIN_ZOOM}
          maxZoom={DIAGRAM_MAX_ZOOM}
          className="erd-flow"
          proOptions={{ hideAttribution: true }}
        >
          {showMinimap && (
            <MiniMap
              className="erd-minimap"
              nodeColor={(node) => (node.data as { color?: string }).color || "#60A5FA"}
              maskColor="rgba(9, 12, 18, 0.76)"
            />
          )}

          {showControls && <Controls className="erd-controls" showInteractive={false} />}

          <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="#1C2433" />

          <Panel position="top-left">
            <div className={`erd-sidepanel ${isSidePanelCollapsed ? "is-collapsed" : ""}`}>
              <div className="erd-sidepanel-header">
                <div className="erd-sidepanel-copy">
                  <strong className="erd-sidepanel-title">Tables</strong>
                  <span className="erd-sidepanel-meta">{activeDatabaseLabel}</span>
                </div>

                <div className="erd-sidepanel-header-actions">
                  <span className="erd-sidepanel-pill">{isSidePanelCollapsed ? selectedTables.size : `${selectedTables.size} shown`}</span>
                  <button
                    type="button"
                    className="erd-sidepanel-collapse"
                    aria-label={isSidePanelCollapsed ? "Expand tables panel" : "Collapse tables panel"}
                    onClick={() => setIsSidePanelCollapsed((value) => !value)}
                  >
                    {isSidePanelCollapsed ? (
                      <PanelLeftOpen className="erd-sidepanel-collapse-icon" />
                    ) : (
                      <PanelLeftClose className="erd-sidepanel-collapse-icon" />
                    )}
                  </button>
                </div>
              </div>

              <div className="erd-sidepanel-actions">
                <button type="button" onClick={handleSelectAll} className="erd-sidepanel-action">
                  <CheckCheck className="erd-sidepanel-action-icon" />
                  All
                </button>
                <button type="button" onClick={handleClearAll} className="erd-sidepanel-action">
                  <Square className="erd-sidepanel-action-icon" />
                  None
                </button>
              </div>

              <label className="erd-filter">
                <Search className="erd-filter-icon" />
                <input
                  type="text"
                  value={tableFilter}
                  onChange={(event) => setTableFilter(event.target.value)}
                  placeholder="Filter tables"
                  className="erd-filter-input"
                />
              </label>

              <div className="erd-table-list">
                {filteredTables.length === 0 ? (
                  <div className="erd-empty-list">
                    <Search className="erd-empty-list-icon" />
                    <strong>No matching tables</strong>
                    <span>Try a shorter name or clear the current filter.</span>
                  </div>
                ) : (
                  filteredTables.map((table) => {
                    const checked = selectedTables.has(table.name);
                    const accent = tableColorMap.get(table.name) || TABLE_COLORS[0];

                    return (
                      <button
                        key={table.name}
                        type="button"
                        onClick={() => handleTableToggle(table.name)}
                        aria-pressed={checked}
                        aria-label={table.name}
                        title={table.name}
                        className={`erd-table-toggle ${checked ? "is-active" : ""}`}
                        style={{ "--erd-table-accent": accent } as CSSProperties}
                      >
                        <span className="erd-table-toggle-check" />
                        <span className="erd-table-toggle-dot" />
                        <div className="erd-table-toggle-copy">
                          <span className="erd-table-toggle-name">{table.name}</span>
                          <span className="erd-table-toggle-meta">{table.schema || "Table"}</span>
                        </div>
                        <span className="erd-table-toggle-count">{table.columns.length}</span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </Panel>
        </ReactFlow>
      )}

      {!loading && schema && selectedTables.size === 0 && (
        <div className="erd-canvas-empty">
          <Database className="erd-canvas-empty-icon" />
          <strong>Select tables to build the diagram</strong>
          <span>Use the schema list on the left to add tables back onto the canvas.</span>
        </div>
      )}

      <ERDContextMenu contextMenu={contextMenu} items={contextMenuItems} onClose={closeContextMenu} />

      {quickColumnEditor && (
        <ERDQuickColumnModal
          tableName={quickColumnEditor.tableName}
          columnName={quickColumnEditor.originalColumn.name}
          dbType={activeDbType}
          editor={quickColumnEditor.editor}
          sqlPreview={quickColumnSqlPreview}
          editorError={quickColumnEditorError}
          isSaving={isApplyingQuickColumnEdit}
          onClose={closeQuickColumnEditor}
          onUpdate={updateQuickColumnEditor}
          onApply={() => void handleApplyQuickColumnEdit()}
          onOpenFullEditor={handleOpenFullEditorFromQuickModal}
        />
      )}

      {pendingRelationship && sourceTableForDraft && targetTableForDraft && (
        <div className="erd-modal-backdrop" onClick={closeRelationshipModal}>
          <div className="erd-modal-shell" onClick={(event) => event.stopPropagation()}>
            <div className="erd-modal-header">
              <div className="erd-modal-header-copy">
                <span className="erd-modal-kicker">
                  {pendingRelationship.step === "select" ? "Step 1 of 2" : "Step 2 of 2"}
                </span>
                <strong className="erd-modal-title">
                  {pendingRelationship.step === "select" ? "Create custom relationship" : "Confirm relationship"}
                </strong>
              </div>

              <button type="button" className="erd-modal-close" onClick={closeRelationshipModal}>
                <X className="erd-modal-close-icon" />
              </button>
            </div>

            {pendingRelationship.step === "select" ? (
              <div className="erd-modal-body">
                <div className="erd-modal-summary">
                  <span className="erd-modal-chip">{sourceTableForDraft.name}</span>
                  <Link2 className="erd-modal-link-icon" />
                  <span className="erd-modal-chip">{targetTableForDraft.name}</span>
                </div>

                <div className="erd-modal-grid">
                  <label className="erd-modal-field">
                    <span className="erd-modal-label">Source column</span>
                    <ERDCompactSelect
                      value={pendingRelationship.sourceColumn}
                      options={sourceColumnOptions}
                      ariaLabel="Source column"
                      onChange={(value) => {
                        setRelationshipModalError(null);
                        setPendingRelationship((current) =>
                          current ? { ...current, sourceColumn: value } : current
                        );
                      }}
                    />
                  </label>

                  <label className="erd-modal-field">
                    <span className="erd-modal-label">Target column</span>
                    <ERDCompactSelect
                      value={pendingRelationship.targetColumn}
                      options={targetColumnOptions}
                      ariaLabel="Target column"
                      onChange={(value) => {
                        setRelationshipModalError(null);
                        setPendingRelationship((current) =>
                          current ? { ...current, targetColumn: value } : current
                        );
                      }}
                    />
                  </label>
                </div>

                <p className="erd-modal-help">
                  {pendingRelationshipNotation
                    ? `Detected notation: ${formatERRelationshipSummary(pendingRelationshipNotation)}. This saves a persistent custom relationship for the current connection and database.`
                    : "This saves a persistent custom relationship for the current connection and database."}
                </p>

                {relationshipModalError && <div className="erd-modal-error">{relationshipModalError}</div>}

                <div className="erd-modal-actions">
                  <button type="button" className="erd-modal-btn" onClick={closeRelationshipModal}>
                    Cancel
                  </button>
                  <button type="button" className="erd-modal-btn is-primary" onClick={openRelationshipConfirmation}>
                    Continue
                  </button>
                </div>
              </div>
            ) : (
              <div className="erd-modal-body">
                <div className="erd-modal-confirm-card">
                  <span className="erd-modal-confirm-label">Source</span>
                  <strong className="erd-modal-confirm-value">
                    {pendingRelationship.sourceTable}.{pendingRelationship.sourceColumn}
                  </strong>
                </div>

                <div className="erd-modal-confirm-card">
                  <span className="erd-modal-confirm-label">Target</span>
                  <strong className="erd-modal-confirm-value">
                    {pendingRelationship.targetTable}.{pendingRelationship.targetColumn}
                  </strong>
                </div>

                <p className="erd-modal-help">
                  {pendingRelationshipNotation
                    ? `Confirm to save this ${formatERRelationshipSummary(pendingRelationshipNotation)} relationship into TableR for this connection. This does not alter the database schema itself.`
                    : "Confirm to save this relationship into TableR for this connection. This does not alter the database schema itself."}
                </p>

                {relationshipModalError && <div className="erd-modal-error">{relationshipModalError}</div>}

                <div className="erd-modal-actions">
                  <button
                    type="button"
                    className="erd-modal-btn"
                    onClick={() =>
                      setPendingRelationship((current) => (current ? { ...current, step: "select" } : current))
                    }
                  >
                    Back
                  </button>
                  <button type="button" className="erd-modal-btn" onClick={closeRelationshipModal}>
                    Cancel
                  </button>
                  <button type="button" className="erd-modal-btn is-primary" onClick={confirmRelationshipDraft}>
                    Save relationship
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default ERDiagram;
