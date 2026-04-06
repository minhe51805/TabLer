/**
 * Clipboard parser: auto-detects TSV (tab-separated) or CSV (comma-separated) data
 * and maps it to table columns.
 */

export interface ParsedClipboardData {
  /** Detected format: "tsv" | "csv" */
  format: "tsv" | "csv";
  /** All parsed rows (including header row) */
  rows: string[][];
  /** Header row values (first row, treated as column names) */
  headers: string[];
  /** Data rows (all rows after header) */
  dataRows: string[][];
  /** Number of data rows */
  rowCount: number;
  /** Number of columns */
  columnCount: number;
  /** Whether the first row was detected as a header */
  firstRowWasHeader: boolean;
}

export interface ColumnMapping {
  /** Index in clipboard data */
  clipboardIndex: number;
  /** Column header name in clipboard */
  clipboardHeader: string;
  /** Index in table columns */
  tableColumnIndex: number;
  /** Column name in table */
  tableColumnName: string;
  /** Whether this mapping is matched by header name */
  matchedBy: "header" | "position";
}

export interface PastePreview {
  /** Column mappings */
  mappings: ColumnMapping[];
  /** Rows to insert: array of [columnName, value][] */
  insertRows: [string, unknown][][];
  /** Number of rows that will be inserted */
  rowCount: number;
  /** Columns in the table that will be set to NULL (no mapping) */
  nullColumns: string[];
  /** Clipboard columns that will be skipped (extra columns not in table) */
  skippedColumns: { index: number; header: string }[];
  /** Whether first row was treated as header */
  firstRowWasHeader: boolean;
}

/** Detect delimiter: tab wins, otherwise try comma. */
function detectDelimiter(sample: string): "tsv" | "csv" {
  const tabCount = (sample.match(/\t/g) || []).length;
  const commaCount = (sample.match(/,/g) || []).length;
  if (tabCount > 0 && tabCount >= commaCount) return "tsv";
  return "csv";
}

/** Parse a single row into values, respecting basic CSV quoting. */
function parseRow(row: string, delimiter: "\t" | ","): string[] {
  if (delimiter === "\t") {
    return row.split("\t");
  }
  // CSV with quoting support
  const values: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') {
      if (inQuotes && row[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      values.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  values.push(current.trim());
  return values;
}

/** Parse clipboard text into structured data. */
export function parseClipboardText(text: string): ParsedClipboardData | null {
  if (!text || !text.trim()) return null;

  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return null;

  const delimiter = detectDelimiter(lines[0]);
  const sep: "\t" | "," = delimiter === "tsv" ? "\t" : ",";

  const rows = lines.map((line) => parseRow(line, sep));

  // Heuristic: if first row looks like it could be a header (mix of text vs numbers),
  // or if it contains non-value-like content, treat as header
  const firstRow = rows[0];
  const allNumeric = firstRow.every((v) => /^-?\d+(\.\d+)?$/.test(v.trim()));
  const firstRowWasHeader = !allNumeric;

  const headers = firstRowWasHeader ? firstRow : [];
  const dataRows = firstRowWasHeader ? rows.slice(1) : rows;

  return {
    format: delimiter,
    rows,
    headers,
    dataRows,
    rowCount: dataRows.length,
    columnCount: firstRow.length,
    firstRowWasHeader,
  };
}

/**
 * Build a preview of how clipboard data maps to table columns.
 */
export function buildPastePreview(
  parsed: ParsedClipboardData,
  tableColumns: string[],
): PastePreview {
  const mappings: ColumnMapping[] = [];
  const nullColumns: string[] = [];
  const skippedColumns: { index: number; header: string }[] = [];

  // Normalize table column names
  const tableLowerToIndex = new Map<string, number>();
  tableColumns.forEach((col, idx) => {
    tableLowerToIndex.set(col.toLowerCase(), idx);
  });

  // If we have headers, try to match by name first
  if (parsed.firstRowWasHeader && parsed.headers.length > 0) {
    for (let ci = 0; ci < parsed.headers.length; ci++) {
      const header = parsed.headers[ci];
      const headerLower = header.toLowerCase().trim();
      const tableIdx = tableLowerToIndex.get(headerLower);

      if (tableIdx !== undefined) {
        mappings.push({
          clipboardIndex: ci,
          clipboardHeader: header,
          tableColumnIndex: tableIdx,
          tableColumnName: tableColumns[tableIdx],
          matchedBy: "header",
        });
      } else {
        skippedColumns.push({ index: ci, header });
      }
    }
  }

  // Fill null columns (table columns not mapped)
  for (let ti = 0; ti < tableColumns.length; ti++) {
    if (!mappings.some((m) => m.tableColumnIndex === ti)) {
      nullColumns.push(tableColumns[ti]);
    }
  }

  // Build insert rows
  const insertRows: [string, unknown][][] = parsed.dataRows.map((row) => {
    const values: [string, unknown][] = [];
    for (const mapping of mappings) {
      const rawValue = row[mapping.clipboardIndex];
      const trimmed = rawValue !== undefined ? rawValue.trim() : "";
      // Convert empty strings to null for nullable columns
      const value: unknown = trimmed === "" ? null : trimmed;
      values.push([mapping.tableColumnName, value]);
    }
    return values;
  });

  return {
    mappings,
    insertRows,
    rowCount: parsed.rowCount,
    nullColumns,
    skippedColumns,
    firstRowWasHeader: parsed.firstRowWasHeader,
  };
}

/** Convert parsed clipboard data to a displayable preview string. */
export function clipboardToPreviewString(parsed: ParsedClipboardData): string {
  if (parsed.dataRows.length === 0) return "No data rows (header only)";

  const maxRows = 5;
  const displayRows = parsed.dataRows.slice(0, maxRows);
  const maxCols = Math.min(parsed.columnCount, 8);

  let lines: string[] = [];
  if (parsed.firstRowWasHeader) {
    lines.push(`Headers: ${parsed.headers.slice(0, maxCols).join(", ")}${parsed.headers.length > maxCols ? "..." : ""}`);
    lines.push("");
  }
  lines.push(`Format: ${parsed.format.toUpperCase()} | Rows: ${parsed.rowCount} | Columns: ${parsed.columnCount}`);
  lines.push("");

  for (let i = 0; i < displayRows.length; i++) {
    const cells = displayRows[i].slice(0, maxCols);
    const line = cells.map((c) => (c.length > 20 ? c.slice(0, 18) + "..." : c)).join(" | ");
    lines.push(`Row ${i + 1}: ${line}${displayRows[i].length > maxCols ? " ..." : ""}`);
  }

  if (parsed.rowCount > maxRows) {
    lines.push(`... and ${parsed.rowCount - maxRows} more rows`);
  }

  return lines.join("\n");
}
