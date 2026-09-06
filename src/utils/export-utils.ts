/**
 * Client-side export utilities for DataGrid results.
 * Saves through the native `save_export_file` dialog — anchor downloads
 * (`<a download>` over `blob:` URLs) are silent no-ops inside the Tauri
 * WebView.
 */
import { saveExportFile } from "./tauri-utils";

/**
 * Triggers the native save dialog and writes the blob to the chosen path.
 * Kept for callers that already hold a Blob; text callers should prefer
 * `saveExportFile` directly.
 */
export async function downloadBlob(blob: Blob, filename: string): Promise<void> {
  const isText = blob.type.startsWith("text/") || blob.type.includes("json");
  const content = isText ? await blob.text() : undefined;
  if (content !== undefined) {
    await saveExportFile({ fileName: filename, content });
    return;
  }
  const base64 = await blobToBase64(blob);
  await saveExportFile({ fileName: filename, contentBase64: base64 });
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (const byte of buffer) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Builds a timestamped filename for export files.
 * @param tableName - The table name or identifier
 * @param extension - File extension (csv or json)
 */
function buildExportFilename(tableName: string | undefined, extension: string): string {
  const base = tableName
    ? tableName.replace(/[^a-zA-Z0-9_.-]/g, "_").split(".").pop() || tableName
    : "table_export";
  const date = new Date().toISOString().slice(0, 10);
  return `${base}_${date}.${extension}`;
}

/**
 * Escapes a single CSV value according to RFC 4180:
 * - Doubles up internal double-quotes
 * - Wraps in double-quotes if contains comma, quote, or newline
 * - null becomes an empty string
 */
function escapeCsvValue(value: string | number | boolean | null): string {
  if (value === null || value === undefined) return "";

  const str = String(value);

  // Check if escaping is needed
  if (str.includes('"') || str.includes(",") || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}

/**
 * Exports row data to a CSV file and triggers a browser download.
 * @param columns - Column header names (in display order)
 * @param rows - 2D array of row values; each row aligns with columns
 * @param filename - Optional custom filename (defaults to table_name_YYYY-MM-DD.csv)
 */
/**
 * Exports row data to a CSV file via the native save dialog.
 * @param columns - Column header names (in display order)
 * @param rows - 2D array of row values; each row aligns with columns
 * @param filename - Optional custom filename (defaults to table_name_YYYY-MM-DD.csv)
 */
export async function exportToCSV(
  columns: string[],
  rows: (string | number | boolean | null)[][],
  filename?: string,
): Promise<void> {
  if (rows.length === 0) return;

  const headerLine = columns.map(escapeCsvValue).join(",");
  const dataLines = rows.map((row) =>
    row.map((cell) => escapeCsvValue(cell)).join(","),
  );

  const csvContent = [headerLine, ...dataLines].join("\r\n");
  await saveExportFile({
    fileName: filename ?? buildExportFilename(columns[0], "csv"),
    content: csvContent,
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
}

/**
 * Exports row data to a JSON file and triggers a browser download.
 * Each row becomes an object with column names as keys.
 * @param columns - Column header names
 * @param rows - 2D array of row values; each row aligns with columns
 * @param filename - Optional custom filename (defaults to table_name_YYYY-MM-DD.json)
 */
export async function exportToJSON(
  columns: string[],
  rows: (string | number | boolean | null)[][],
  filename?: string,
): Promise<void> {
  if (rows.length === 0) return;

  const data: Record<string, string | number | boolean | null>[] = rows.map((row) => {
    const obj: Record<string, string | number | boolean | null> = {};
    columns.forEach((col, idx) => {
      obj[col] = row[idx] ?? null;
    });
    return obj;
  });

  const jsonContent = JSON.stringify(data, null, 2);
  await saveExportFile({
    fileName: filename ?? buildExportFilename(columns[0], "json"),
    content: jsonContent,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
}
