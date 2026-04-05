/**
 * Geometry WKB/WKT renderer for spatial database columns.
 * Supports: PostgreSQL PostGIS, MySQL, SQLite SpatiaLite, MSSQL geometry.
 */

// ─── Geometry type detection ───────────────────────────────────────────────────

/** Column type names that indicate geometry/geography columns. */
export const GEOMETRY_TYPE_PATTERNS = [
  "geometry",
  "geography",
  "point",
  "linestring",
  "polygon",
  "multipoint",
  "multilinestring",
  "multipolygon",
  "geometrycollection",
  "geom",
  "st_geom",
  "st_point",
  "st_linestring",
  "st_polygon",
] as const;

export function isGeometryColumn(dataType: string, columnType?: string): boolean {
  const normalized = (dataType || columnType || "").toLowerCase();
  return GEOMETRY_TYPE_PATTERNS.some(
    (p) => normalized.includes(p) || normalized === p,
  );
}

// ─── WKB (Well-Known Binary) parsing ─────────────────────────────────────────

/** Parse a WKB hex string or byte array to a human-readable WKT string. */
export function parseWKB(wkb: string | Uint8Array | unknown): string | null {
  if (!wkb) return null;

  // Handle hex string from PostGIS / MySQL ST_AsBinary
  let hex: string;
  if (typeof wkb === "string") {
    hex = wkb.replace(/^0x/i, "").replace(/\s+/g, "");
  } else if (wkb instanceof Uint8Array) {
    hex = Array.from(wkb)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } else {
    return null;
  }

  if (hex.length < 9) return null;

  try {
    const byteOrder = parseInt(hex.slice(0, 2), 16);
    const isLittleEndian = byteOrder === 0x00;
    const typeWord = parseHexValue(hex.slice(2, 10), isLittleEndian);
    const geometryType = typeWord & 0x1f; // lower 5 bits = base type
    const hasZ = !!(typeWord & 0x80000000);
    const hasM = !!(typeWord & 0x40000000);
    const dimension = (hasZ ? 1 : 0) + (hasM ? 1 : 0);

    const dataStart = 9;
    return parseWKBBody(hex, geometryType, dimension, isLittleEndian, dataStart);
  } catch {
    // Fall through to WKT parsing
  }

  return null;
}

function parseHexValue(hex: string, littleEndian: boolean): number {
  let result = 0;
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.slice(i, i + 2), 16);
    result = littleEndian ? result + (byte << (i * 4)) : (result << 8) + byte;
  }
  return result;
}

function parseWKBBody(
  hex: string,
  geometryType: number,
  dimension: number,
  littleEndian: boolean,
  offset: number,
): string {
  // Geometry types per OGC WKB spec
  // 1=Point, 2=LineString, 3=Polygon, 4=MultiPoint, 5=MultiLineString, 6=MultiPolygon, 7=GeometryCollection
  switch (geometryType) {
    case 1: // Point
      return parsePoint(hex, dimension, littleEndian, offset);
    case 2: // LineString
      return parseLineString(hex, dimension, littleEndian, offset);
    case 3: // Polygon
      return parsePolygon(hex, dimension, littleEndian, offset);
    case 4: // MultiPoint
      return parseMultiPoint(hex, dimension, littleEndian, offset);
    case 5: // MultiLineString
      return parseMultiLineString(hex, dimension, littleEndian, offset);
    case 6: // MultiPolygon
      return parseMultiPolygon(hex, dimension, littleEndian, offset);
    case 7: // GeometryCollection
      return parseGeometryCollection(hex, littleEndian, offset);
    default:
      return `GEOMETRY[${geometryType}]`;
  }
}

function parseCoord(
  hex: string,
  dim: number,
  le: boolean,
  offset: number,
): { coord: string; nextOffset: number } {
  const coordCount = dim + 2; // X,Y plus optional Z,M
  const bytesPerCoord = coordCount * 8;
  const coordHex = hex.slice(offset, offset + bytesPerCoord * 2);

  const xs = parseFloat(parseHexFloat(coordHex.slice(0, 16), le));
  const ys = parseFloat(parseHexFloat(coordHex.slice(16, 32), le));

  let result = `${formatCoord(xs)} ${formatCoord(ys)}`;
  let next = offset + 16; // X,Y

  if (dim >= 1) {
    const zs = parseFloat(parseHexFloat(coordHex.slice(32, 48), le));
    result += ` ${formatCoord(zs)}`;
    next = offset + 32;
  }
  if (dim >= 2) {
    const ms = parseFloat(parseHexFloat(coordHex.slice(48, 64), le));
    result += ` ${formatCoord(ms)}`;
    next = offset + 48;
  }

  return { coord: result, nextOffset: next };
}

function parsePoint(
  hex: string,
  dim: number,
  le: boolean,
  offset: number,
): string {
  const { coord } = parseCoord(hex, dim, le, offset);
  return `POINT(${coord})`;
}

function parseLineString(
  hex: string,
  dim: number,
  le: boolean,
  offset: number,
): string {
  const numPoints = parseHexUint32(hex.slice(offset, offset + 8), le);
  const points: string[] = [];
  let pos = offset + 8;
  for (let i = 0; i < numPoints; i++) {
    const { coord, nextOffset } = parseCoord(hex, dim, le, pos);
    points.push(coord);
    pos = nextOffset;
  }
  return `LINESTRING(${points.join(", ")})`;
}

function parsePolygon(
  hex: string,
  dim: number,
  le: boolean,
  offset: number,
): string {
  const numRings = parseHexUint32(hex.slice(offset, offset + 8), le);
  const rings: string[] = [];
  let pos = offset + 8;
  for (let r = 0; r < numRings; r++) {
    const numPoints = parseHexUint32(hex.slice(pos, pos + 8), le);
    const coords: string[] = [];
    pos += 8;
    for (let i = 0; i < numPoints; i++) {
      const { coord, nextOffset } = parseCoord(hex, dim, le, pos);
      coords.push(coord);
      pos = nextOffset;
    }
    rings.push(`(${coords.join(", ")})`);
  }
  return `POLYGON(${rings.join(", ")})`;
}

function parseMultiPoint(
  hex: string,
  dim: number,
  le: boolean,
  offset: number,
): string {
  const numGeoms = parseHexUint32(hex.slice(offset, offset + 8), le);
  const points: string[] = [];
  let pos = offset + 8;
  for (let i = 0; i < numGeoms; i++) {
    pos += 4; // skip byte order + type word (4 bytes hex = 2 bytes)
    const { coord, nextOffset } = parseCoord(hex, dim, le, pos);
    points.push(coord);
    pos = nextOffset;
  }
  return `MULTIPOINT(${points.join(", ")})`;
}

function parseMultiLineString(
  hex: string,
  dim: number,
  le: boolean,
  offset: number,
): string {
  const numGeoms = parseHexUint32(hex.slice(offset, offset + 8), le);
  const lines: string[] = [];
  let pos = offset + 8;
  for (let i = 0; i < numGeoms; i++) {
    pos += 4;
    const numPoints = parseHexUint32(hex.slice(pos, pos + 8), le);
    const points: string[] = [];
    pos += 8;
    for (let j = 0; j < numPoints; j++) {
      const { coord, nextOffset } = parseCoord(hex, dim, le, pos);
      points.push(coord);
      pos = nextOffset;
    }
    lines.push(`(${points.join(", ")})`);
  }
  return `MULTILINESTRING(${lines.join(", ")})`;
}

function parseMultiPolygon(
  hex: string,
  dim: number,
  le: boolean,
  offset: number,
): string {
  const numPolys = parseHexUint32(hex.slice(offset, offset + 8), le);
  const polygons: string[] = [];
  let pos = offset + 8;
  for (let p = 0; p < numPolys; p++) {
    pos += 4;
    const numRings = parseHexUint32(hex.slice(pos, pos + 8), le);
    pos += 8;
    const rings: string[] = [];
    for (let r = 0; r < numRings; r++) {
      const numPoints = parseHexUint32(hex.slice(pos, pos + 8), le);
      const coords: string[] = [];
      pos += 8;
      for (let i = 0; i < numPoints; i++) {
        const { coord, nextOffset } = parseCoord(hex, dim, le, pos);
        coords.push(coord);
        pos = nextOffset;
      }
      rings.push(`(${coords.join(", ")})`);
    }
    polygons.push(`(${rings.join(", ")})`);
  }
  return `MULTIPOLYGON(${polygons.join(", ")})`;
}

function parseGeometryCollection(
  hex: string,
  le: boolean,
  offset: number,
): string {
  const numGeoms = parseHexUint32(hex.slice(offset, offset + 8), le);
  const geoms: string[] = [];
  let pos = offset + 8;
  for (let i = 0; i < numGeoms; i++) {
    pos += 4;
    const subType = parseHexValue(hex.slice(pos, pos + 8), le);
    const subDim = 0; // assume 2D for nested
    const { nextOffset: next } = parseCoord(hex, subDim, le, pos + 8);
    // Heuristic: re-parse from pos
    const wkt = parseWKBBody(hex, subType & 0x1f, subDim, le, pos + 8);
    geoms.push(wkt);
    pos = next;
  }
  return `GEOMETRYCOLLECTION(${geoms.join(", ")})`;
}

function parseHexFloat(hex: string, littleEndian: boolean): string {
  const bytes = parseInt(hex.slice(0, 16), 16);
  // Re-interpret the hex bytes as IEEE 754 double
  // Simple approach: build the 8-byte array
  const buf = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    buf[littleEndian ? i : 7 - i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  const view = new DataView(buf.buffer);
  return view.getFloat64(0, littleEndian).toString();
}

function parseHexUint32(hex: string, littleEndian: boolean): number {
  let result = 0;
  for (let i = 0; i < 8; i += 2) {
    const byte = parseInt(hex.slice(i, i + 2), 16);
    if (littleEndian) {
      result += byte << (i * 4);
    } else {
      result = (result << 8) + byte;
    }
  }
  return result >>> 0;
}

function formatCoord(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(6).replace(/\.?0+$/, "");
}

// ─── WKT string parser ─────────────────────────────────────────────────────────

/** Parse a WKT string (e.g. "POINT(-73.99 40.73)") into readable parts. */
export function parseWKT(wkt: string): string | null {
  if (!wkt || typeof wkt !== "string") return null;

  const trimmed = wkt.trim().toUpperCase();

  if (trimmed.startsWith("POINT")) {
    const match = wkt.match(/POINT\s*\(\s*([^\)]+)\s*\)/i);
    if (match) {
      return `POINT(${formatWKTPoints(match[1])})`;
    }
  }
  if (trimmed.startsWith("LINESTRING")) {
    const match = wkt.match(/LINESTRING\s*\(\s*([^\)]+)\s*\)/i);
    if (match) {
      return `LINESTRING(${formatWKTPoints(match[1])})`;
    }
  }
  if (trimmed.startsWith("POLYGON")) {
    const match = wkt.match(/POLYGON\s*\(\s*([^\)]+)\s*\)/i);
    if (match) {
      return `POLYGON(${formatWKTRings(match[1])})`;
    }
  }
  if (trimmed.startsWith("MULTIPOINT")) {
    const match = wkt.match(/MULTIPOINT\s*\(\s*([^\)]+)\s*\)/i);
    if (match) {
      const points = match[1].split(",").map((p) => p.trim()).filter(Boolean);
      return `MULTIPOINT(${formatMultiPoints(points)})`;
    }
  }
  if (trimmed.startsWith("MULTILINESTRING")) {
    const match = wkt.match(/MULTILINESTRING\s*\(\s*([^\)]+)\s*\)/i);
    if (match) {
      return `MULTILINESTRING: count=${countParts(match[1], "(")}`;
    }
  }
  if (trimmed.startsWith("MULTIPOLYGON")) {
    const match = wkt.match(/MULTIPOLYGON\s*\(\s*([^\)]+)\s*\)/i);
    if (match) {
      return `MULTIPOLYGON: count=${countParts(match[1], "((")}`;
    }
  }
  if (trimmed.startsWith("GEOMETRYCOLLECTION")) {
    const match = wkt.match(/GEOMETRYCOLLECTION\s*\(\s*([^\)]+)\s*\)/i);
    if (match) {
      return `GEOMETRYCOLLECTION: count=${countParts(match[1], "GEOMETRY")}`;
    }
  }

  // Unknown format — return original
  return wkt.length > 100 ? wkt.slice(0, 100) + "..." : wkt;
}

function formatWKTPoints(coords: string): string {
  const parts = coords.trim().split(/\s+/);
  if (parts.length < 2) return coords;
  return `${formatNumber(parts[0])} ${formatNumber(parts[1])}`;
}

function formatWKTRings(ringContent: string): string {
  const rings = ringContent.split(/\)\s*,\s*\(/).map((r) => r.trim());
  const formatted = rings.slice(0, 3).map((ring) => {
    const pts = ring.replace(/[()]/g, "").split(",").map((p) => p.trim()).filter(Boolean);
    return pts.slice(0, 4).map((p) => formatWKTPoints(p)).join(", ") + (pts.length > 4 ? ", ..." : "");
  });
  return formatted.join(", ") + (rings.length > 3 ? ` [${rings.length} rings]` : "");
}

function formatMultiPoints(points: string[]): string {
  const formatted = points.slice(0, 5).map((p) => {
    const coords = p.replace(/[()]/g, "").trim().split(/\s+/);
    if (coords.length >= 2) return `${formatNumber(coords[0])} ${formatNumber(coords[1])}`;
    return p;
  });
  return formatted.join(", ") + (points.length > 5 ? ` [${points.length}]` : "");
}

function formatNumber(s: string): string {
  const n = parseFloat(s);
  return Number.isInteger(n) ? s : n.toFixed(4).replace(/\.?0+$/, "");
}

function countParts(content: string, marker: string): number {
  let count = 0;
  let idx = content.indexOf(marker);
  while (idx !== -1) {
    count++;
    idx = content.indexOf(marker, idx + marker.length);
  }
  return count;
}

// ─── Emoji indicator ───────────────────────────────────────────────────────────

const GEOMETRY_EMOJI: Record<string, string> = {
  POINT: "📍",
  MULTIPOINT: "📍📍",
  LINESTRING: "📏",
  MULTILINESTRING: "📏📏",
  POLYGON: "🔷",
  MULTIPOLYGON: "🔷🔷",
  GEOMETRYCOLLECTION: "📐",
  UNKNOWN: "📐",
};

export function getGeometryEmoji(wkt: string): string {
  const upper = (wkt || "").trim().toUpperCase();
  if (upper.startsWith("POINT") && upper.startsWith("MULTIPOINT")) return GEOMETRY_EMOJI.MULTIPOINT;
  if (upper.startsWith("MULTIPOINT")) return GEOMETRY_EMOJI.MULTIPOINT;
  if (upper.startsWith("POINT")) return GEOMETRY_EMOJI.POINT;
  if (upper.startsWith("MULTILINESTRING")) return GEOMETRY_EMOJI.MULTILINESTRING;
  if (upper.startsWith("LINESTRING")) return GEOMETRY_EMOJI.LINESTRING;
  if (upper.startsWith("MULTIPOLYGON")) return GEOMETRY_EMOJI.MULTIPOLYGON;
  if (upper.startsWith("POLYGON")) return GEOMETRY_EMOJI.POLYGON;
  if (upper.startsWith("GEOMETRYCOLLECTION")) return GEOMETRY_EMOJI.GEOMETRYCOLLECTION;
  return GEOMETRY_EMOJI.UNKNOWN;
}

export function getGeometryTypeFromWKT(wkt: string): string {
  const upper = (wkt || "").trim().toUpperCase();
  if (upper.startsWith("POINT") && !upper.startsWith("MULTIPOINT")) return "Point";
  if (upper.startsWith("MULTIPOINT")) return "MultiPoint";
  if (upper.startsWith("LINESTRING") && !upper.startsWith("MULTI")) return "LineString";
  if (upper.startsWith("MULTILINESTRING")) return "MultiLineString";
  if (upper.startsWith("POLYGON") && !upper.startsWith("MULTI")) return "Polygon";
  if (upper.startsWith("MULTIPOLYGON")) return "MultiPolygon";
  if (upper.startsWith("GEOMETRYCOLLECTION")) return "GeometryCollection";
  return "Geometry";
}

// ─── Main render function ───────────────────────────────────────────────────────

/**
 * Render a geometry cell value to a human-readable display string.
 * Handles WKB hex, WKT string, and raw WKT input.
 */
export function renderGeometryCell(value: unknown): {
  display: string;
  emoji: string;
  wkt: string;
  type: string;
} {
  if (!value || value === null) {
    return { display: "NULL", emoji: "", wkt: "", type: "" };
  }

  let wkt = "";

  // Try WKB first
  if (typeof value === "string") {
    wkt = parseWKB(value) || parseWKT(value) || value;
  } else if (value instanceof Uint8Array) {
    wkt = parseWKB(value) || "";
  } else {
    wkt = String(value);
  }

  const display = wkt.length > 80 ? wkt.slice(0, 80) + "..." : wkt;
  const emoji = getGeometryEmoji(wkt);
  const type = getGeometryTypeFromWKT(wkt);

  return { display, emoji, wkt, type };
}
