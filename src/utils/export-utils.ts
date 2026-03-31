/**
 * Client-side export utilities for DataGrid results.
 * Uses the Blob API to trigger downloads without server involvement.
 */

/**
 * Triggers a browser download for a Blob.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // Release the object URL after a short delay to allow the download to start
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
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
export function exportToCSV(
  columns: string[],
  rows: (string | number | boolean | null)[][],
  filename?: string,
): void {
  if (rows.length === 0) return;

  const headerLine = columns.map(escapeCsvValue).join(",");
  const dataLines = rows.map((row) =>
    row.map((cell) => escapeCsvValue(cell)).join(","),
  );

  const csvContent = [headerLine, ...dataLines].join("\r\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  downloadBlob(blob, filename ?? buildExportFilename(columns[0], "csv"));
}

/**
 * Exports row data to a JSON file and triggers a browser download.
 * Each row becomes an object with column names as keys.
 * @param columns - Column header names
 * @param rows - 2D array of row values; each row aligns with columns
 * @param filename - Optional custom filename (defaults to table_name_YYYY-MM-DD.json)
 */
export function exportToJSON(
  columns: string[],
  rows: (string | number | boolean | null)[][],
  filename?: string,
): void {
  if (rows.length === 0) return;

  const data: Record<string, string | number | boolean | null>[] = rows.map((row) => {
    const obj: Record<string, string | number | boolean | null> = {};
    columns.forEach((col, idx) => {
      obj[col] = row[idx] ?? null;
    });
    return obj;
  });

  const jsonContent = JSON.stringify(data, null, 2);
  const blob = new Blob([jsonContent], { type: "application/json;charset=utf-8;" });
  downloadBlob(blob, filename ?? buildExportFilename(columns[0], "json"));
}
