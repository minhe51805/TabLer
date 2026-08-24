import type { Edge, Node } from "@xyflow/react";
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
import { buildERCardinalityMarker, type ERCardinalityEndpoint } from "./relationshipNotation";
import type { TableNodeData } from "./TableNode";

const DIAGRAM_EXPORT_PADDING = 40;
const DIAGRAM_EXPORT_SCALE = 2;

/**
 * Canvas rendering and diagram export (PNG / draw.io XML) for the ER editor.
 * Pure subsystem: no React state, no store access.
 */

function truncateCanvasText(
  context: CanvasRenderingContext2D,
  value: string,
  maxWidth: number,
) {
  if (context.measureText(value).width <= maxWidth) return value;

  const ellipsis = "...";
  let next = value;

  while (
    next.length > 0 &&
    context.measureText(`${next}${ellipsis}`).width > maxWidth
  ) {
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
  lineWidth = 1,
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

function buildExportEdgeLayout(
  edge: Edge,
  nodeMap: Map<string, ExportNodeLayout>,
): ExportEdgeLayout | null {
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
  const edgeData =
    (edge.data as
      | {
          bendOffset?: DiagramPoint;
          sourceColumn?: string;
          targetColumn?: string;
          sourceCardinality?: ERCardinalityEndpoint;
          targetCardinality?: ERCardinalityEndpoint;
        }
      | undefined) || {};
  const bendOffset = edgeData.bendOffset || { x: 0, y: 0 };
  const bendPoint = {
    x: midpoint.x + bendOffset.x,
    y: midpoint.y + bendOffset.y,
  };
  const sourceSide = pickDiagramAnchorSide(sourceCenter, bendPoint);
  const targetSide = pickDiagramAnchorSide(targetCenter, bendPoint);
  const sourcePoint = getDiagramNodeAnchorPoint(
    sourceFrame,
    sourceSide,
    edgeData.sourceColumn,
  );
  const targetPoint = getDiagramNodeAnchorPoint(
    targetFrame,
    targetSide,
    edgeData.targetColumn,
  );
  const points = buildDiagramEdgePoints(
    sourcePoint,
    sourceSide,
    targetPoint,
    targetSide,
    bendPoint,
  );

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

export function buildERDiagramExportSnapshot(
  nodes: Node[],
  edges: Edge[],
): ExportDiagramSnapshot | null {
  const exportNodes = nodes.map((node) => {
    const data = node.data as TableNodeData;

    return {
      id: node.id,
      x: node.position.x,
      y: node.position.y,
      width: DIAGRAM_NODE_WIDTH,
      height: estimateDiagramNodeHeight(
        data.columns.length,
        Boolean(data.isExpanded),
      ),
      data,
    } satisfies ExportNodeLayout;
  });

  if (exportNodes.length === 0) return null;

  const nodeMap = new Map(exportNodes.map((node) => [node.id, node]));
  const exportEdges = edges
    .map((edge) => buildExportEdgeLayout(edge, nodeMap))
    .filter((edge): edge is ExportEdgeLayout => Boolean(edge));

  const edgePoints = exportEdges.flatMap((edge) => [
    ...edge.points,
    edge.bendPoint,
  ]);
  const minX = Math.min(
    ...exportNodes.map((node) => node.x),
    ...edgePoints.map((point) => point.x),
  );
  const minY = Math.min(
    ...exportNodes.map((node) => node.y),
    ...edgePoints.map((point) => point.y),
  );
  const maxX = Math.max(
    ...exportNodes.map((node) => node.x + node.width),
    ...edgePoints.map((point) => point.x),
  );
  const maxY = Math.max(
    ...exportNodes.map((node) => node.y + node.height),
    ...edgePoints.map((point) => point.y),
  );
  const exportWidth = Math.max(
    320,
    Math.ceil(maxX - minX + DIAGRAM_EXPORT_PADDING * 2),
  );
  const exportHeight = Math.max(
    220,
    Math.ceil(maxY - minY + DIAGRAM_EXPORT_PADDING * 2),
  );
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
  const visibleColumns = getVisibleDiagramColumns(
    node.data.columns,
    isExpanded,
  );
  const hiddenCount = Math.max(
    0,
    node.data.columns.length - visibleColumns.length,
  );
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

export function buildDrawioDiagramXml(snapshot: ExportDiagramSnapshot) {
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
            `<mxPoint x="${Math.round(point.x + snapshot.offsetX)}" y="${Math.round(point.y + snapshot.offsetY)}" />`,
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
  strokeColor: string,
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
    context.arc(
      circle.center.x,
      circle.center.y,
      circle.radius,
      0,
      Math.PI * 2,
    );
    context.fill();
    context.stroke();
  });

  context.restore();
}

export function renderERDiagramCanvas(nodes: Node[], edges: Edge[]) {
  const snapshot = buildERDiagramExportSnapshot(nodes, edges);
  if (!snapshot) return null;

  const canvas = document.createElement("canvas");
  canvas.width = snapshot.width * DIAGRAM_EXPORT_SCALE;
  canvas.height = snapshot.height * DIAGRAM_EXPORT_SCALE;

  const context = canvas.getContext("2d");
  if (!context) return null;

  context.scale(DIAGRAM_EXPORT_SCALE, DIAGRAM_EXPORT_SCALE);

  const backgroundGradient = context.createLinearGradient(
    0,
    0,
    0,
    snapshot.height,
  );
  backgroundGradient.addColorStop(0, "#080b10");
  backgroundGradient.addColorStop(1, "#060810");
  context.fillStyle = backgroundGradient;
  context.fillRect(0, 0, snapshot.width, snapshot.height);

  const topGlow = context.createRadialGradient(
    snapshot.width * 0.2,
    snapshot.height * 0.12,
    0,
    snapshot.width * 0.2,
    snapshot.height * 0.12,
    snapshot.width * 0.34,
  );
  topGlow.addColorStop(0, "rgba(34, 211, 238, 0.12)");
  topGlow.addColorStop(1, "rgba(34, 211, 238, 0)");
  context.fillStyle = topGlow;
  context.fillRect(0, 0, snapshot.width, snapshot.height);

  const bottomGlow = context.createRadialGradient(
    snapshot.width * 0.82,
    snapshot.height * 0.84,
    0,
    snapshot.width * 0.82,
    snapshot.height * 0.84,
    snapshot.width * 0.28,
  );
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
        strokeColor,
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
        strokeColor,
      );
    }

    context.save();
    context.font = '700 9px "Segoe UI", sans-serif';
    const label = truncateCanvasText(context, edge.label, 128);
    const labelWidth = Math.min(136, context.measureText(label).width + 14);
    const labelHeight = 18;
    const labelX = edge.bendPoint.x + snapshot.offsetX - labelWidth / 2;
    const labelY = edge.bendPoint.y + snapshot.offsetY - labelHeight / 2;
    drawRoundedRect(
      context,
      labelX,
      labelY,
      labelWidth,
      labelHeight,
      9,
      "rgba(8, 11, 16, 0.94)",
      "rgba(34, 211, 238, 0.18)",
    );
    context.fillStyle = "#d8e2f1";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(
      label,
      labelX + labelWidth / 2,
      labelY + labelHeight / 2 + 0.5,
    );
    context.restore();
  });

  snapshot.nodes.forEach((node) => {
    const isExpanded = Boolean(node.data.isExpanded);
    const visibleColumns = getVisibleDiagramColumns(
      node.data.columns,
      isExpanded,
    );
    const hiddenCount = Math.max(
      0,
      node.data.columns.length - visibleColumns.length,
    );
    const x = node.x + snapshot.offsetX;
    const y = node.y + snapshot.offsetY;
    const width = node.width;
    const height = node.height;
    const accent = node.data.color;
    const headerHeight = DIAGRAM_NODE_HEADER_HEIGHT;

    context.save();
    context.shadowColor = "rgba(0, 0, 0, 0.28)";
    context.shadowBlur = 18;
    drawRoundedRect(
      context,
      x,
      y,
      width,
      height,
      12,
      "rgba(12, 16, 24, 0.98)",
      "rgba(122, 147, 198, 0.16)",
    );
    context.restore();

    context.save();
    context.beginPath();
    context.roundRect(x, y, width, height, 12);
    context.clip();
    context.fillStyle = "rgba(255, 255, 255, 0.035)";
    context.fillRect(x, y, width, headerHeight);
    context.fillStyle = accent;
    context.fillRect(x, y, width, 3);
    const accentGlow = context.createRadialGradient(
      x + width - 30,
      y + 14,
      0,
      x + width - 30,
      y + 14,
      54,
    );
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
    context.fillText(
      truncateCanvasText(context, node.data.label, width - 42),
      x + 22,
      y + 18,
    );

    const pills = [`${node.data.columns.length} cols`];
    if (hasFiniteRowCount(node.data.rowCount)) {
      pills.push(`${formatCompactCount(node.data.rowCount)} rows`);
    }

    context.font = '700 8px "Segoe UI", sans-serif';
    let pillX = x + 10;
    pills.forEach((pill) => {
      const pillWidth = context.measureText(pill).width + 12;
      drawRoundedRect(
        context,
        pillX,
        y + 31,
        pillWidth,
        14,
        999,
        "rgba(255, 255, 255, 0.04)",
        "rgba(122, 147, 198, 0.14)",
      );
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
        isPrimary ? "rgba(34, 211, 238, 0.16)" : undefined,
      );

      drawRoundedRect(
        context,
        x + 12,
        rowY + 3,
        isPrimary ? 26 : 28,
        12,
        999,
        isPrimary ? "rgba(34, 211, 238, 0.1)" : "rgba(255, 255, 255, 0.04)",
        isPrimary ? "rgba(34, 211, 238, 0.22)" : "rgba(122, 147, 198, 0.14)",
      );
      context.fillStyle = isPrimary ? "#22d3ee" : "#8f99ab";
      context.font = '800 6px "Segoe UI", sans-serif';
      context.textBaseline = "middle";
      context.fillText(isPrimary ? "PK" : "COL", x + 18, rowY + 9.5);

      context.fillStyle = "#eef3fb";
      context.font = '600 8px "Segoe UI", sans-serif';
      context.fillText(
        truncateCanvasText(context, column.name, width - 78),
        x + 46,
        rowY + 8,
      );

      context.fillStyle = "#c3cede";
      context.font = '400 7px "Segoe UI", sans-serif';
      const detail = `${column.data_type}${column.is_nullable ? " / nullable" : ""}`;
      context.fillText(
        truncateCanvasText(context, detail, width - 78),
        x + 46,
        rowY + 15,
      );

      rowY += DIAGRAM_NODE_ROW_HEIGHT + DIAGRAM_NODE_ROW_GAP;
    });

    if (node.data.columns.length > visibleColumns.length || isExpanded) {
      context.strokeStyle = "rgba(122, 147, 198, 0.12)";
      context.beginPath();
      context.moveTo(x + 8, rowY + 2);
      context.lineTo(x + width - 8, rowY + 2);
      context.stroke();

      if (isExpanded) {
        drawRoundedRect(
          context,
          x + width / 2 - 34,
          rowY + 6,
          28,
          14,
          999,
          "rgba(34, 211, 238, 0.08)",
          "rgba(34, 211, 238, 0.16)",
        );
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
        drawRoundedRect(
          context,
          x + width / 2 - 34,
          rowY + 6,
          28,
          14,
          999,
          "rgba(255, 255, 255, 0.04)",
          "rgba(122, 147, 198, 0.14)",
        );
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

function formatCompactCount(value: number) {
  if (value >= 1_000_000) return ;
  if (value >= 1_000) return ;
  return String(value);
}

function hasFiniteRowCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
