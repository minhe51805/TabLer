/**
 * MQL (MongoDB Shell) export utility.
 * Converts query results to MongoDB shell syntax: db.collection.insertOne / insertMany / deleteMany.
 */

const LARGE_EXPORT_THRESHOLD = 1000;

/** Triggers a browser download of text content */
function downloadText(content: string, filename: string): void {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Builds a timestamped filename */
function buildExportFilename(tableName: string | undefined, extension = "js"): string {
  const base = tableName
    ? tableName.replace(/[^a-zA-Z0-9_.-]/g, "_").split(".").pop() || tableName
    : "collection_export";
  const date = new Date().toISOString().slice(0, 10);
  return `${base}_${date}.${extension}`;
}

/** Convert a raw cell value to a MongoDB shell representation */
function mqlValue(value: unknown, depth = 0): string {
  if (depth > 20) return '"[MAX_DEPTH_EXCEEDED]"';

  if (value === null || value === undefined) {
    return "null";
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (typeof value === "number") {
    // Detect integer vs float
    if (Number.isSafeInteger(value)) {
      // Large integers that could lose precision are wrapped in NumberLong/NumberInt
      if (value > 2_147_483_647 || value < -2_147_483_648) {
        return `NumberLong("${value}")`;
      }
      if (value > 9_007_199_254_740_991 || value < -9_007_199_254_740_991) {
        return `NumberLong("${value}")`;
      }
      return String(value);
    }
    // Float
    if (!isFinite(value)) {
      return value > 0 ? "Number.POSITIVE_INFINITY" : "Number.NEGATIVE_INFINITY";
    }
    return String(value);
  }

  if (value instanceof Uint8Array || ArrayBuffer.isView(value)) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value.buffer);
    const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
    return `BinData(0, "${hex}")`;
  }

  if (typeof value === "object") {
    if (isMongoBSONType(value)) {
      return formatMongoBSONValue(value as Record<string, unknown>);
    }

    if (Array.isArray(value)) {
      const items = value
        .slice(0, 50_000) // Safety cap on array size
        .map((item) => mqlValue(item, depth + 1))
        .join(", ");
      return `[${items}]`;
    }

    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";

    const inner = entries
      .slice(0, 10_000) // Safety cap on object keys
      .map(([k, v]) => {
        const key = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k) ? k : `"${k}"`;
        return `${key}: ${mqlValue(v, depth + 1)}`;
      })
      .join(", ");
    return `{${inner}}`;
  }

  // String — escape properly for JS
  return JSON.stringify(value);
}

/** Check if value is a MongoDB-style BSON typed object */
function isMongoBSONType(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const keys = Object.keys(value as object);
  // BSON types have exactly one special key like "$oid", "$date", "$numberLong", etc.
  return keys.some((k) => k.startsWith("$"));
}

/** Format a MongoDB BSON value object to shell syntax */
function formatMongoBSONValue(obj: Record<string, unknown>): string {
  for (const [key, val] of Object.entries(obj)) {
    switch (key) {
      case "$oid":
        return `ObjectId("${val}")`;
      case "$date": {
        if (typeof val === "string" || typeof val === "number") {
          const d = new Date(String(val));
          return `ISODate("${d.toISOString()}")`;
        }
        if (typeof val === "object" && val !== null) {
          const dateObj = val as Record<string, unknown>;
          if (dateObj.$numberLong) {
            return `ISODate("${new Date(Number(dateObj.$numberLong)).toISOString()}")`;
          }
        }
        return `ISODate("${String(val)}")`;
      }
      case "$numberLong":
        return `NumberLong("${val}")`;
      case "$numberInt":
        return `NumberInt("${val}")`;
      case "$numberDouble":
        return `NumberDouble("${val}")`;
      case "$numberDecimal":
        return `NumberDecimal("${val}")`;
      case "$binary": {
        const bin = val as Record<string, string>;
        return `BinData(${bin.subType ?? 0}, "${bin.base64 ?? ""}")`;
      }
      case "$regex":
        return `/${val}/`;
      case "$minKey":
        return "MinKey()";
      case "$maxKey":
        return "MaxKey()";
      case "$timestamp": {
        const ts = val as Record<string, number>;
        return `Timestamp(${ts.t ?? 0}, ${ts.i ?? 0})`;
      }
      case "$undefined":
        return "undefined";
      case "$symbol":
        return `Symbol("${val}")`;
      default:
        break;
    }
  }

  // Fallback: format as a regular object
  const inner = Object.entries(obj)
    .map(([k, v]) => `${k}: ${mqlValue(v, 1)}`)
    .join(", ");
  return `{${inner}}`;
}

/** Convert a row (array) to a MQL document object */
function rowToDocument(
  columns: string[],
  row: (string | number | boolean | null)[],
): Record<string, unknown> {
  const doc: Record<string, unknown> = {};
  columns.forEach((col, idx) => {
    doc[col] = row[idx] ?? null;
  });
  return doc;
}

/** Check if a collection name is safe for export */
function safeCollectionName(name: string | undefined): string {
  if (!name) return "collection";
  return name.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 120) || "collection";
}

/** Generate the use() statement for a database */
function buildUseStatement(database: string | undefined): string {
  const db = safeCollectionName(database || "test");
  return `use("${db}");\n`;
}

/** Main export function */
export interface MqlExportOptions {
  collectionName?: string;
  databaseName?: string;
  columns: string[];
  rows: (string | number | boolean | null)[][];
  filename?: string;
}

/**
 * Prompts the user with a confirmation dialog if the export is large.
 * Returns true if the user confirmed or the export is small.
 */
export async function confirmLargeExport(rowCount: number): Promise<boolean> {
  if (rowCount <= LARGE_EXPORT_THRESHOLD) return true;

  return new Promise<boolean>((resolve) => {
    const confirmed = window.confirm(
      `You are about to export ${rowCount.toLocaleString()} documents.\n` +
        `This may generate a large file.\n\n` +
        `Do you want to continue?`,
    );
    resolve(confirmed);
  });
}

/**
 * Exports data to MongoDB shell script format.
 * Uses insertOne for 1 doc, insertMany for 2+, deleteMany for empty set.
 *
 * @param options - Export options
 */
export async function exportToMQL(options: MqlExportOptions): Promise<void> {
  const { collectionName, databaseName, columns, rows, filename } = options;

  if (!(await confirmLargeExport(rows.length))) return;

  const collection = safeCollectionName(collectionName);
  const lines: string[] = [];

  lines.push("// MongoDB Shell Export");
  lines.push(`// Generated: ${new Date().toISOString()}`);
  lines.push(`// Collection: ${collection}`);
  if (databaseName) lines.push(`// Database: ${databaseName}`);
  lines.push("");

  if (databaseName) {
    lines.push(buildUseStatement(databaseName));
    lines.push("");
  }

  if (rows.length === 0) {
    lines.push(`// Empty collection — deletes all documents`);
    lines.push(`db.${collection}.deleteMany({});`);
  } else if (rows.length === 1) {
    const doc = rowToDocument(columns, rows[0]);
    lines.push(`db.${collection}.insertOne(${mqlValue(doc)});`);
  } else {
    const docs = rows.map((row) => rowToDocument(columns, row));
    // Chunk into insertMany calls of 1000 docs each to avoid shell limits
    const CHUNK_SIZE = 1000;
    for (let i = 0; i < docs.length; i += CHUNK_SIZE) {
      const chunk = docs.slice(i, i + CHUNK_SIZE);
      const chunkLabel =
        CHUNK_SIZE < docs.length
          ? ` // batch ${Math.floor(i / CHUNK_SIZE) + 1} of ${Math.ceil(docs.length / CHUNK_SIZE)}`
          : "";
      lines.push(`db.${collection}.insertMany([`);
      chunk.forEach((doc, j) => {
        const comma = j < chunk.length - 1 ? "," : "";
        lines.push(`  ${mqlValue(doc)}${comma}`);
      });
      lines.push(`]);${chunkLabel}`);
    }
  }

  const content = lines.join("\n");
  const fname = filename ?? buildExportFilename(collectionName, "js");
  downloadText(content, fname);
}
