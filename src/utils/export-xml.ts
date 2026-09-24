/**
 * XML export for DataGrid results.
 * Each row becomes a `<row>` element under `<results>`; column names are
 * sanitized to valid XML element names and NULL cells carry `xsi:nil="true"`.
 * Saves through the native `save_export_file` dialog like the other
 * export-utils formats.
 */
import { saveExportFile } from "./tauri-utils";

type CellValue = string | number | boolean | null;

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';
const XSI_NAMESPACE = "http://www.w3.org/2001/XMLSchema-instance";

/**
 * Builds a timestamped filename for export files.
 * Mirrors the private helper in export-utils.ts.
 */
function buildExportFilename(tableName: string | undefined, extension: string): string {
  const base = tableName
    ? tableName
        .replace(/[^a-zA-Z0-9_.-]/g, "_")
        .split(".")
        .pop() || tableName
    : "table_export";
  const date = new Date().toISOString().slice(0, 10);
  return `${base}_${date}.${extension}`;
}

/**
 * Escapes a value for XML text content. `>` is escaped unconditionally so a
 * literal `]]>` can never appear in the output.
 */
export function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Sanitizes a column name into a valid XML 1.0 element name (ASCII subset:
 * letter or underscore first, then letters/digits/`_`/`.`/`-`). Illegal
 * interior characters become `_`; names that are empty, start with an illegal
 * character, or begin with the reserved `xml` prefix fall back to `col_N`.
 */
export function sanitizeXmlName(name: string, index: number): string {
  const fallback = `col_${index}`;
  if (!name || !/^[A-Za-z_]/.test(name) || /^xml/i.test(name)) return fallback;
  return name.replace(/[^A-Za-z0-9_.-]/g, "_");
}

/**
 * Resolves sanitized element names for every column, deduplicating collisions
 * (e.g. `a b` and `a_b` both sanitize to `a_b`) with a `_N` suffix.
 */
function resolveXmlNames(columns: string[]): string[] {
  const seen = new Map<string, number>();
  return columns.map((column, index) => {
    const base = sanitizeXmlName(column, index);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}_${count}`;
  });
}

/**
 * Builds the XML document. Exported so tests and clipboard paths can produce
 * the same bytes the save path writes to disk.
 */
export function buildXmlContent(columns: string[], rows: CellValue[][]): string {
  const names = resolveXmlNames(columns);
  const lines = [XML_DECLARATION, `<results xmlns:xsi="${XSI_NAMESPACE}">`];
  for (const row of rows) {
    lines.push("  <row>");
    names.forEach((name, idx) => {
      const value = row[idx];
      if (value === null || value === undefined) {
        lines.push(`    <${name} xsi:nil="true"/>`);
      } else {
        lines.push(`    <${name}>${escapeXmlText(String(value))}</${name}>`);
      }
    });
    lines.push("  </row>");
  }
  lines.push("</results>");
  return lines.join("\n");
}

/**
 * Exports row data to an XML file via the native save dialog.
 * For full-table exports the streaming `xml` path is used instead.
 */
export async function exportToXML(
  columns: string[],
  rows: CellValue[][],
  filename?: string,
): Promise<void> {
  if (rows.length === 0) return;

  await saveExportFile({
    fileName: filename ?? buildExportFilename(columns[0], "xml"),
    content: buildXmlContent(columns, rows),
    filters: [{ name: "XML", extensions: ["xml"] }],
  });
}
