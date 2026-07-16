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
  /** Columns in the table that receive no imported value (defaults apply) */
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

/**
 * Parse delimited text in one pass so a quoted CSV field can contain commas,
 * escaped quotes, or line breaks. Clipboard TSV is deliberately parsed by the
 * same code path: quoted tabs are uncommon, but harmlessly supported.
 */
function parseDelimitedText(text: string, delimiter: "\t" | ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      if (inQuotes && text[index + 1] === '"') {
        value += '"';
        index++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === delimiter && !inQuotes) {
      row.push(value);
      value = "";
      continue;
    }
    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && text[index + 1] === "\n") {
        index++;
      }
      row.push(value);
      if (row.some((cell) => cell.trim().length > 0)) {
        rows.push(row);
      }
      row = [];
      value = "";
      continue;
    }
    value += char;
  }

  row.push(value);
  if (row.some((cell) => cell.trim().length > 0)) {
    rows.push(row);
  }
  return rows;
}

/** Parse clipboard text into structured data. */
export function parseClipboardText(text: string): ParsedClipboardData | null {
  if (!text || !text.trim()) return null;

  const firstLine = text.split(/\r?\n/, 1)[0];
  const delimiter = detectDelimiter(firstLine);
  const sep: "\t" | "," = delimiter === "tsv" ? "\t" : ",";
  const rows = parseDelimitedText(text, sep);
  if (rows.length === 0) return null;

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
        if (mappings.some((mapping) => mapping.tableColumnIndex === tableIdx)) {
          skippedColumns.push({ index: ci, header });
          continue;
        }
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
  } else {
    const mappedColumnCount = Math.min(parsed.columnCount, tableColumns.length);
    for (let index = 0; index < mappedColumnCount; index++) {
      mappings.push({
        clipboardIndex: index,
        clipboardHeader: `Column ${index + 1}`,
        tableColumnIndex: index,
        tableColumnName: tableColumns[index],
        matchedBy: "position",
      });
    }
    for (let index = mappedColumnCount; index < parsed.columnCount; index++) {
      skippedColumns.push({ index, header: `Column ${index + 1}` });
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
