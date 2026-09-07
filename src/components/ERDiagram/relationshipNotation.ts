import type { TableSchema } from "../../types/database";
import type { DiagramPoint } from "./layout";

export interface ERCardinalityEndpoint {
  min: 0 | 1;
  max: "one" | "many";
}

export interface ERRelationshipNotation {
  source: ERCardinalityEndpoint;
  target: ERCardinalityEndpoint;
  kind: "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many";
}

export interface ERMarkerGeometry {
  lines: Array<{ from: DiagramPoint; to: DiagramPoint }>;
  circles: Array<{ center: DiagramPoint; radius: number }>;
}

const CARDINALITY_BAR_HALF = 5.5;
const CARDINALITY_CIRCLE_RADIUS = 3.8;
const CARDINALITY_MIN_OFFSET = 5;
const CARDINALITY_MAX_OFFSET = 11;
const CARDINALITY_CROW_BASE_OFFSET = 0;
const CARDINALITY_CROW_LENGTH = 10;
const CARDINALITY_CROW_SPREAD = 5.5;

function addPoints(a: DiagramPoint, b: DiagramPoint): DiagramPoint {
  return {
    x: a.x + b.x,
    y: a.y + b.y,
  };
}

function subtractPoints(a: DiagramPoint, b: DiagramPoint): DiagramPoint {
  return {
    x: a.x - b.x,
    y: a.y - b.y,
  };
}

function scalePoint(point: DiagramPoint, distance: number): DiagramPoint {
  return {
    x: point.x * distance,
    y: point.y * distance,
  };
}

function normalizePoint(point: DiagramPoint): DiagramPoint {
  const length = Math.hypot(point.x, point.y);
  if (length < 0.001) {
    return { x: 1, y: 0 };
  }

  return {
    x: point.x / length,
    y: point.y / length,
  };
}

function getPerpendicularPoint(direction: DiagramPoint): DiagramPoint {
  return {
    x: -direction.y,
    y: direction.x,
  };
}

function getTableColumn(table: TableSchema | null | undefined, columnName: string) {
  return table?.columns.find((column) => column.name.toLowerCase() === columnName.toLowerCase());
}

export function isERColumnUnique(table: TableSchema | null | undefined, columnName: string) {
  const column = getTableColumn(table, columnName);
  if (column?.is_primary_key) return true;

  return Boolean(
    table?.indexes.some(
      (index) =>
        index.is_unique &&
        index.columns.length === 1 &&
        index.columns.some((value) => value.toLowerCase() === columnName.toLowerCase())
    )
  );
}

export function isERColumnNullable(table: TableSchema | null | undefined, columnName: string) {
  return getTableColumn(table, columnName)?.is_nullable ?? true;
}

export function inferERRelationshipNotation(
  sourceTable: TableSchema | null | undefined,
  sourceColumn: string,
  targetTable: TableSchema | null | undefined,
  targetColumn: string,
  options?: {
    enforceReferenceConstraint?: boolean;
  }
): ERRelationshipNotation {
  const sourceUnique = isERColumnUnique(sourceTable, sourceColumn);
  const targetUnique = isERColumnUnique(targetTable, targetColumn);
  const sourceNullable = isERColumnNullable(sourceTable, sourceColumn);
  const enforceReferenceConstraint = options?.enforceReferenceConstraint !== false;

  const source: ERCardinalityEndpoint = {
    min: 0,
    max: sourceUnique ? "one" : "many",
  };

  const target: ERCardinalityEndpoint =
    targetUnique && enforceReferenceConstraint
      ? {
          min: sourceNullable ? 0 : 1,
          max: "one",
        }
      : {
          min: 0,
          max: targetUnique ? "one" : "many",
        };

  const kind =
    source.max === "one" && target.max === "one"
      ? "one-to-one"
      : source.max === "one" && target.max === "many"
        ? "one-to-many"
        : source.max === "many" && target.max === "one"
          ? "many-to-one"
          : "many-to-many";

  return { source, target, kind };
}

export function formatERCardinality(cardinality: ERCardinalityEndpoint) {
  if (cardinality.min === 1 && cardinality.max === "one") return "1";
  if (cardinality.min === 0 && cardinality.max === "one") return "0..1";
  if (cardinality.min === 1 && cardinality.max === "many") return "1..*";
  return "0..*";
}

export function formatERRelationshipKind(kind: ERRelationshipNotation["kind"]) {
  switch (kind) {
    case "one-to-one":
      return "1:1";
    case "one-to-many":
      return "1:N";
    case "many-to-one":
      return "N:1";
    case "many-to-many":
      return "N:N";
    default:
      return "N:N";
  }
}

export function formatERRelationshipSummary(notation: ERRelationshipNotation) {
  return `${formatERRelationshipKind(notation.kind)} - ${formatERCardinality(notation.source)} to ${formatERCardinality(
    notation.target
  )}`;
}

export function buildERCardinalityMarker(
  cardinality: ERCardinalityEndpoint | undefined,
  anchor: DiagramPoint,
  awayPoint: DiagramPoint
): ERMarkerGeometry | null {
  if (!cardinality) return null;

  const direction = normalizePoint(subtractPoints(awayPoint, anchor));
  const perpendicular = getPerpendicularPoint(direction);
  const lines: ERMarkerGeometry["lines"] = [];
  const circles: ERMarkerGeometry["circles"] = [];

  const addBar = (center: DiagramPoint) => {
    lines.push({
      from: addPoints(center, scalePoint(perpendicular, -CARDINALITY_BAR_HALF)),
      to: addPoints(center, scalePoint(perpendicular, CARDINALITY_BAR_HALF)),
    });
  };

  const minCenter = addPoints(anchor, scalePoint(direction, CARDINALITY_MIN_OFFSET));
  const maxCenter = addPoints(anchor, scalePoint(direction, CARDINALITY_MAX_OFFSET));

  if (cardinality.min === 0) {
    circles.push({
      center: minCenter,
      radius: CARDINALITY_CIRCLE_RADIUS,
    });
  } else {
    addBar(minCenter);
  }

  if (cardinality.max === "one") {
    addBar(maxCenter);
  } else {
    const base = addPoints(anchor, scalePoint(direction, CARDINALITY_CROW_BASE_OFFSET));
    const tipCenter = addPoints(base, scalePoint(direction, CARDINALITY_CROW_LENGTH));

    lines.push(
      { from: base, to: tipCenter },
      {
        from: base,
        to: addPoints(tipCenter, scalePoint(perpendicular, CARDINALITY_CROW_SPREAD)),
      },
      {
        from: base,
        to: addPoints(tipCenter, scalePoint(perpendicular, -CARDINALITY_CROW_SPREAD)),
      }
    );
  }

  return { lines, circles };
}
