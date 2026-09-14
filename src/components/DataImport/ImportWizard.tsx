import { useCallback, useEffect, useRef, useState } from "react";
import { FileJson, FileSpreadsheet, Loader2, Play, X } from "lucide-react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useConnectionStore } from "../../stores/connectionStore";
import { invokeMutation, invokeWithTimeout } from "../../utils/tauri-utils";

type ImportFormat = "csv" | "json";

interface ImportPreview {
  fileName: string;
  filePath: string;
  columns: string[];
  rows: string[][];
  totalRows: number;
  totalRowsTruncated?: boolean;
  delimiter?: string; // CSV only
  shape?: string; // JSON only: "array" | "ndjson"
}

interface ImportSummary {
  insertedRows: number;
  batches: number;
  tableCreated: boolean;
  cancelled?: boolean;
}

interface CsvImportProgress {
  operationId: string;
  processedRows: number;
  processedBytes: number;
  totalBytes: number;
}

// Matches the backend CSV_FILE_IMPORT_TIMEOUT (30 minutes) so the client
// never gives up before the streaming import reports its outcome.
const IMPORT_TIMEOUT_MS = 1_800_000;

/**
 * Data Import wizard (roadmap Phase 2B, Tools → Import data).
 * Supports CSV and JSON (array-of-objects or NDJSON).
 * Three steps: pick file → configure target/mapping → execute.
 */
export function ImportWizard() {
  const [isOpen, setIsOpen] = useState(false);
  const connectionId = useConnectionStore((state) => state.activeConnectionId);

  const [format, setFormat] = useState<ImportFormat>("csv");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [targetTable, setTargetTable] = useState("");
  const [targetColumns, setTargetColumns] = useState<string[]>([]);
  const [hasHeader, setHasHeader] = useState(true);
  const [createTable, setCreateTable] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [progress, setProgress] = useState<CsvImportProgress | null>(null);
  const csvImportOperationIdRef = useRef<string | null>(null);

  // Progress events come from the streaming backend import; only the
  // wizard's own operation id is shown here.
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    void listen<CsvImportProgress>("csv-import-progress", (event) => {
      if (event.payload.operationId !== csvImportOperationIdRef.current) return;
      setProgress(event.payload);
    })
      .then((cleanup) => {
        unlisten = cleanup;
      })
      .catch(() => {
        // Browser-only tests and previews do not expose Tauri's event bridge.
      });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    const open = () => {
      setIsOpen(true);
      setPreview(null);
      setTargetTable("");
      setTargetColumns([]);
      setSummary(null);
      setError(null);
    };
    window.addEventListener("open-data-import-palette", open);
    return () => window.removeEventListener("open-data-import-palette", open);
  }, []);

  const pickFile = useCallback(async (chosen: ImportFormat) => {
    setIsBusy(true);
    setError(null);
    try {
      const command = chosen === "csv" ? "preview_import_csv" : "preview_import_json";
      const result = await invokeMutation<ImportPreview>(command, { sampleRows: 20 });
      setFormat(chosen);
      setPreview(result);
      setTargetColumns(
        result.columns.map((column) => column.trim().toLowerCase().replace(/\s+/g, "_")),
      );
      setTargetTable(
        (current) =>
          current || result.fileName.replace(/\.(csv|tsv|json|ndjson|jsonl)$/i, "").trim(),
      );
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
    } finally {
      setIsBusy(false);
    }
  }, []);

  const runImport = useCallback(async () => {
    if (
      !preview ||
      !connectionId ||
      !targetTable.trim() ||
      targetColumns.some((column) => !column.trim())
    )
      return;
    const operationId = `csv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    csvImportOperationIdRef.current = operationId;
    setIsBusy(true);
    setIsCancelling(false);
    setProgress(null);
    setError(null);
    try {
      const mappings = preview.columns.map((_column, index) => ({
        sourceIndex: index,
        targetColumn: targetColumns[index] || preview.columns[index],
      }));
      const command = format === "csv" ? "import_csv" : "import_json";
      const args =
        format === "csv"
          ? {
              connectionId,
              table: targetTable,
              path: preview.filePath,
              mappings,
              hasHeader,
              createTable,
              batchSize: 200,
              operationId,
            }
          : {
              connectionId,
              table: targetTable,
              path: preview.filePath,
              sourceColumns: preview.columns,
              mappings,
              createTable,
              batchSize: 200,
              operationId,
            };
      const result = await invokeWithTimeout<ImportSummary>(
        command,
        args,
        IMPORT_TIMEOUT_MS,
        format === "csv" ? "CSV import" : "JSON import",
      );
      setSummary(result);
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
    } finally {
      csvImportOperationIdRef.current = null;
      setIsBusy(false);
      setIsCancelling(false);
      setProgress(null);
    }
  }, [connectionId, createTable, format, hasHeader, preview, targetColumns, targetTable]);

  const handleCancelImport = useCallback(async () => {
    const operationId = csvImportOperationIdRef.current;
    if (!operationId || isCancelling) return;
    setIsCancelling(true);
    try {
      await invokeMutation<boolean>("cancel_csv_import", { operationId });
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
      setIsCancelling(false);
    }
  }, [isCancelling]);

  if (!isOpen) return null;

  return (
    <div className="qs-overlay" role="presentation">
      <div className="qs-panel data-import-panel" role="dialog" aria-label="Import data">
        <div className="qs-input-row">
          <strong>Import data</strong>
          <button
            type="button"
            className="qs-clear-btn"
            aria-label="Close"
            onClick={() => setIsOpen(false)}
          >
            <X size={14} />
          </button>
        </div>

        {error && <div className="qs-empty global-search-error">{error}</div>}

        {!preview ? (
          <div className="qs-empty" style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="global-search-mode active"
              disabled={isBusy}
              onClick={() => void pickFile("csv")}
            >
              {isBusy ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <FileSpreadsheet size={13} />
              )}{" "}
              Choose CSV file…
            </button>
            <button
              type="button"
              className="global-search-mode active"
              disabled={isBusy}
              onClick={() => void pickFile("json")}
            >
              {isBusy ? <Loader2 size={13} className="animate-spin" /> : <FileJson size={13} />}{" "}
              Choose JSON file…
            </button>
          </div>
        ) : (
          <>
            <div className="schema-diff-summary">
              <span>{preview.fileName}</span>
              <span>
                {preview.totalRows}
                {preview.totalRowsTruncated ? "+" : ""} rows
              </span>
              {format === "csv" ? (
                <span>delimiter “{preview.delimiter}”</span>
              ) : (
                <span>{preview.shape === "ndjson" ? "NDJSON" : "JSON array"}</span>
              )}
            </div>

            <div className="schema-diff-selects">
              <input
                value={targetTable}
                onChange={(event) => setTargetTable(event.target.value)}
                placeholder="Target table name"
                aria-label="Target table name"
              />
              {format === "csv" && (
                <label className="schema-drops-toggle">
                  <input
                    type="checkbox"
                    checked={hasHeader}
                    onChange={(event) => setHasHeader(event.target.checked)}
                  />
                  First row = header
                </label>
              )}
              <label className="schema-drops-toggle">
                <input
                  type="checkbox"
                  checked={createTable}
                  onChange={(event) => setCreateTable(event.target.checked)}
                />
                Create table (all TEXT)
              </label>
            </div>

            <div className="qs-list schema-diff-results">
              <div className="qs-item static global-search-match-kind">Column mapping</div>
              {preview.columns.map((column, index) => (
                <div key={`${column}-${index}`} className="qs-item static">
                  <span className="global-search-match-label">{column}</span>
                  <span>→</span>
                  <input
                    value={targetColumns[index] ?? ""}
                    onChange={(event) =>
                      setTargetColumns((current) =>
                        current.map((value, position) =>
                          position === index ? event.target.value : value,
                        ),
                      )
                    }
                    aria-label={`Target column for ${column}`}
                  />
                </div>
              ))}
            </div>

            {summary && (
              <div className="schema-diff-summary">
                <span
                  style={{
                    color: summary.cancelled
                      ? "var(--fintech-amber, #f59e0b)"
                      : "var(--fintech-green, #22c55e)",
                  }}
                >
                  {summary.cancelled
                    ? `Cancelled after importing ${summary.insertedRows} row(s)`
                    : `Imported ${summary.insertedRows} rows in ${summary.batches} batch(es)`}
                  {summary.tableCreated ? " · table created" : ""}
                </span>
              </div>
            )}

            {isBusy && progress && progress.totalBytes > 0 && (
              <div className="schema-diff-summary">
                <span>
                  {progress.processedRows} rows ·{" "}
                  {Math.min(100, Math.round((progress.processedBytes / progress.totalBytes) * 100))}
                  %
                </span>
                <span
                  style={{
                    flex: 1,
                    height: 6,
                    borderRadius: 3,
                    background: "var(--border-subtle, #333)",
                    overflow: "hidden",
                  }}
                  role="progressbar"
                  aria-label="CSV import progress"
                >
                  <span
                    style={{
                      display: "block",
                      height: "100%",
                      width: `${Math.min(100, Math.round((progress.processedBytes / progress.totalBytes) * 100))}%`,
                      background: "var(--fintech-blue, #3b82f6)",
                    }}
                  />
                </span>
              </div>
            )}

            <div className="schema-diff-selects">
              <button
                type="button"
                className="global-search-mode active"
                disabled={
                  isBusy || !targetTable.trim() || targetColumns.some((column) => !column.trim())
                }
                onClick={() => void runImport()}
              >
                {isBusy ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}{" "}
                Import
              </button>
              {isBusy && (
                <button
                  type="button"
                  className="global-search-mode"
                  disabled={isCancelling}
                  onClick={() => void handleCancelImport()}
                >
                  {isCancelling ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />}{" "}
                  Cancel import
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
