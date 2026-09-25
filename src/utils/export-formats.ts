/**
 * Shared definitions for the streaming table-export formats. The backend
 * (`export_table_data` / `export_tables_to_directory`) is the source of truth:
 * `get_export_formats` reports which formats are compiled in — `parquet` is
 * absent when the `parquet-export` cargo feature is off.
 */
import { invokeWithTimeout } from "./tauri-utils";

/** Format ids accepted by the backend table-export commands. */
export type TableExportFormat =
  "csv" | "tsv" | "json" | "jsonl" | "sql" | "xlsx" | "xml" | "html" | "markdown" | "parquet";

/** One compiled-in export format as reported by `get_export_formats`. */
export interface ExportFormatInfo {
  /** Stable format id passed to the export commands. */
  id: TableExportFormat;
  /** Default file extension (markdown → "md"). */
  extension: string;
  /** Human-facing label for pickers and file dialogs. */
  label: string;
}

/**
 * Formats that always exist, used before the backend answers (or if the call
 * fails — e.g. running under a plain browser in tests). Parquet is excluded:
 * it only appears when the backend reports it compiled in.
 */
export const DEFAULT_EXPORT_FORMATS: ExportFormatInfo[] = [
  { id: "csv", extension: "csv", label: "CSV" },
  { id: "tsv", extension: "tsv", label: "TSV" },
  { id: "json", extension: "json", label: "JSON" },
  { id: "jsonl", extension: "jsonl", label: "JSON Lines" },
  { id: "sql", extension: "sql", label: "SQL" },
  { id: "xlsx", extension: "xlsx", label: "Excel Workbook" },
  { id: "xml", extension: "xml", label: "XML" },
  { id: "html", extension: "html", label: "HTML" },
  { id: "markdown", extension: "md", label: "Markdown" },
];

let cachedFormats: Promise<ExportFormatInfo[]> | null = null;

/**
 * Returns the export formats compiled into the running backend. The result is
 * cached for the session — the compiled feature set cannot change without a
 * restart. Falls back to the always-on list when the command is unavailable.
 */
export function getCompiledExportFormats(): Promise<ExportFormatInfo[]> {
  if (!cachedFormats) {
    cachedFormats = invokeWithTimeout<ExportFormatInfo[]>(
      "get_export_formats",
      {},
      10_000,
      "Load export formats",
    ).catch(() => DEFAULT_EXPORT_FORMATS);
  }
  return cachedFormats;
}
