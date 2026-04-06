/**
 * XLSX (Excel) export utility using SheetJS (xlsx).
 * Supports multi-sheet workbooks, auto-fitted column widths, frozen headers,
 * and proper cell formatting for dates, numbers, NULL, and BLOBs.
 */

import * as XLSX from "xlsx";

/** Triggers a browser download for an ArrayBuffer as .xlsx */
function downloadArrayBuffer(buffer: ArrayBuffer, filename: string): void {
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
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
function buildExportFilename(tableName: string | undefined, extension = "xlsx"): string {
  const base = tableName
    ? tableName.replace(/[^a-zA-Z0-9_.-]/g, "_").split(".").pop() || tableName
    : "table_export";
  const date = new Date().toISOString().slice(0, 10);
  return `${base}_${date}.${extension}`;
}

/** Returns the Excel cell type string for a given value */
function excelCellType(
  value: unknown,
  dataType: string,
): "n" | "d" | "s" | "b" | "z" {
  const type = (dataType || "").toLowerCase();

  if (value === null || value === undefined) return "z"; // blank

  // Date / datetime / timestamp types
  if (
    type.includes("date") ||
    type.includes("time") ||
    type.includes("timestamp") ||
    type === "interval"
  ) {
    return "d";
  }

  // Boolean
  if (typeof value === "boolean") return "b";

  // Number
  if (
    typeof value === "number" ||
    type.includes("int") ||
    type.includes("float") ||
    type.includes("decimal") ||
    type.includes("numeric") ||
    type.includes("real") ||
    type.includes("double") ||
    type.includes("smallserial") ||
    type.includes("serial") ||
    type.includes("bigserial") ||
    type.includes("money") ||
    type.includes("oid")
  ) {
    return "n";
  }

  return "s"; // string
}

/** Converts a raw DB value + column type to an Excel cell */
function excelCell(
  value: unknown,
  dataType: string,
): XLSX.CellObject {
  if (value === null || value === undefined) {
    return { t: "z" }; // blank
  }

  const type = excelCellType(value, dataType);

  if (type === "d") {
    // Excel stores dates as a number (days since 1900-01-01)
    // If value is a JS Date or ISO string, convert to Excel serial
    let dateVal: Date;
    if (value instanceof Date) {
      dateVal = value;
    } else if (typeof value === "string" || typeof value === "number") {
      try {
        dateVal = new Date(String(value));
      } catch {
        return { t: "s", v: String(value) };
      }
    } else {
      return { t: "s", v: String(value) };
    }
    // Excel serial date: days since 1900-01-01 (with the 1900 leap-year bug)
    const excelEpoch = new Date(1899, 11, 30); // 1900-01-01 === 1
    const serial = Math.round((dateVal.getTime() - excelEpoch.getTime()) / 86400_000);
    return { t: "n", v: serial, z: "yyyy-mm-dd hh:mm:ss" };
  }

  if (type === "n") {
    return { t: "n", v: Number(value) };
  }

  if (type === "b") {
    return { t: "b", v: value as boolean };
  }

  // String — BLOB sentinel
  const blobType = (dataType || "").toLowerCase();
  if (
    blobType.includes("blob") ||
    blobType.includes("binary") ||
    blobType.includes("bytea") ||
    blobType.includes("geometry") ||
    blobType.includes("raster")
  ) {
    return { t: "s", v: "[BLOB]" };
  }

  return { t: "s", v: String(value) };
}

/** Builds a worksheet from columns + rows, computes optimal column widths */
function buildSheet(
  columns: { name: string; data_type: string }[],
  rows: (string | number | boolean | null)[][],
): { ws: XLSX.WorkSheet; colWidths: XLSX.ColInfo[] } {
  const ws: XLSX.WorkSheet = {};

  // Row 1: headers
  columns.forEach((col, colIdx) => {
    const ref = XLSX.utils.encode_cell({ r: 0, c: colIdx });
    ws[ref] = { t: "s", v: col.name };
  });

  // Data rows
  rows.forEach((row, rowIdx) => {
    columns.forEach((col, colIdx) => {
      const ref = XLSX.utils.encode_cell({ r: rowIdx + 1, c: colIdx });
      ws[ref] = excelCell(row[colIdx], col.data_type);
    });
  });

  // Column widths: fit content with padding
  const colWidths: XLSX.ColInfo[] = columns.map((col, colIndex) => {
    const headerLen = col.name.length;
    let maxLen = headerLen;

    for (const row of rows) {
      const cell = row[colIndex];
      if (cell === null || cell === undefined) continue;
      const str = String(cell);
      if (str.length > maxLen) {
        // Clamp to avoid huge columns for binary/JSON content
        maxLen = Math.min(str.length, 120);
      }
    }

    return { wch: Math.max(maxLen, 8) + 2 };
  });

  // Freeze header row
  ws["!freeze"] = { xSplit: 0, ySplit: 1 };
  ws["!cols"] = colWidths;

  return { ws, colWidths };
}

/** Sheet descriptor used by exportXLSX */
export interface XlsxSheet {
  name: string;
  columns: { name: string; data_type: string }[];
  rows: (string | number | boolean | null)[][];
}

/**
 * Exports data to a multi-sheet XLSX workbook.
 * Each sheet corresponds to one query result or table.
 *
 * @param sheets - Array of sheets to export
 * @param filename - Optional custom filename
 */
export function exportXLSX(sheets: XlsxSheet[], filename?: string): void {
  if (sheets.length === 0) return;

  const wb = XLSX.utils.book_new();

  sheets.forEach((sheet, index) => {
    if (sheet.rows.length === 0) return;

    // Sanitize sheet name (max 31 chars, no special chars)
    const sheetName = sheet.name
      .replace(/[\\/?*[\]]/g, "_")
      .slice(0, 31)
      .trim() || `Result ${index + 1}`;

    const { ws } = buildSheet(sheet.columns, sheet.rows);
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  });

  if (wb.SheetNames.length === 0) return;

  const wbout = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  downloadArrayBuffer(
    new Uint8Array(wbout).buffer,
    filename ?? buildExportFilename(sheets[0]?.name, "xlsx"),
  );
}