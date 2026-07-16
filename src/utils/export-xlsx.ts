/**
 * XLSX export built on write-excel-file's browser-only writer.
 * Keeps database values typed without exposing the app to workbook parsing.
 */

import writeXlsxFile, {
  type Cell,
  type Sheet,
  type SheetData,
} from "write-excel-file/browser";

const BLOB_TYPE_MARKERS = ["blob", "binary", "bytea", "geometry", "raster"];
const NUMBER_TYPE_MARKERS = [
  "int",
  "float",
  "decimal",
  "numeric",
  "real",
  "double",
  "smallserial",
  "serial",
  "bigserial",
  "money",
  "oid",
];

export interface XlsxSheet {
  name: string;
  columns: { name: string; data_type: string }[];
  rows: (string | number | boolean | null)[][];
}

function buildExportFilename(tableName: string | undefined): string {
  const base = tableName
    ? tableName.replace(/[^a-zA-Z0-9_.-]/g, "_").split(".").pop() || tableName
    : "table_export";
  return `${base}_${new Date().toISOString().slice(0, 10)}.xlsx`;
}

function isDatabaseType(dataType: string, markers: string[]): boolean {
  const normalized = dataType.toLowerCase();
  return markers.some((marker) => normalized.includes(marker));
}

export function toExcelCell(value: unknown, dataType: string): Cell {
  if (value === null || value === undefined) return null;

  if (isDatabaseType(dataType, BLOB_TYPE_MARKERS)) {
    return { type: String, value: "[BLOB]" };
  }

  const normalizedType = dataType.toLowerCase();
  const isDate =
    normalizedType.includes("date") ||
    normalizedType.includes("time") ||
    normalizedType.includes("timestamp");

  if (isDate) {
    const date = value instanceof Date ? value : new Date(String(value));
    if (!Number.isNaN(date.getTime())) {
      return { type: Date, value: date, format: "yyyy-mm-dd hh:mm:ss" };
    }
  }

  if (typeof value === "boolean") {
    return { type: Boolean, value };
  }

  if (typeof value === "number" || isDatabaseType(dataType, NUMBER_TYPE_MARKERS)) {
    const numericValue = Number(value);
    if (Number.isFinite(numericValue)) {
      return { type: Number, value: numericValue };
    }
  }

  return { type: String, value: String(value) };
}

export function buildExcelSheetData(sheet: XlsxSheet): SheetData {
  const header = sheet.columns.map((column) => ({
    type: String,
    value: column.name,
    fontWeight: "bold" as const,
    backgroundColor: "#E9EEF5",
    bottomBorderColor: "#B8C2D1",
    bottomBorderStyle: "thin" as const,
  }));

  const rows = sheet.rows.map((row) =>
    sheet.columns.map((column, columnIndex) =>
      toExcelCell(row[columnIndex], column.data_type),
    ),
  );

  return [header, ...rows];
}

function buildColumnWidths(sheet: XlsxSheet): { width: number }[] {
  return sheet.columns.map((column, columnIndex) => {
    let maxLength = column.name.length;
    for (const row of sheet.rows) {
      const value = row[columnIndex];
      if (value === null || value === undefined) continue;
      maxLength = Math.max(maxLength, Math.min(String(value).length, 120));
    }
    return { width: Math.max(maxLength, 8) + 2 };
  });
}

function uniqueSheetName(name: string, index: number, usedNames: Set<string>): string {
  const fallback = `Result ${index + 1}`;
  const base = name.replace(/[\\/?*[\]]/g, "_").trim().slice(0, 31) || fallback;
  let candidate = base;
  let suffix = 2;

  while (usedNames.has(candidate.toLowerCase())) {
    const suffixText = ` ${suffix}`;
    candidate = `${base.slice(0, 31 - suffixText.length)}${suffixText}`;
    suffix += 1;
  }

  usedNames.add(candidate.toLowerCase());
  return candidate;
}

export async function exportXLSX(sheets: XlsxSheet[], filename?: string): Promise<void> {
  const nonEmptySheets = sheets.filter(
    (sheet) => sheet.columns.length > 0 && sheet.rows.length > 0,
  );
  if (nonEmptySheets.length === 0) return;

  const usedNames = new Set<string>();
  const workbookSheets: Sheet<Blob>[] = nonEmptySheets.map((sheet, index) => ({
    sheet: uniqueSheetName(sheet.name, index, usedNames),
    data: buildExcelSheetData(sheet),
    columns: buildColumnWidths(sheet),
    stickyRowsCount: 1,
  }));

  const workbook = writeXlsxFile(workbookSheets);
  await workbook.toFile(filename ?? buildExportFilename(nonEmptySheets[0]?.name));
}
