import { useCallback, useEffect, useState } from "react";
import { FileSpreadsheet, Loader2, Play, X } from "lucide-react";
import { useConnectionStore } from "../../stores/connectionStore";
import { invokeMutation, invokeWithTimeout } from "../../utils/tauri-utils";

interface CsvPreview {
  fileName: string;
  filePath: string;
  columns: string[];
  rows: string[][];
  totalRows: number;
  delimiter: string;
}

interface ImportSummary {
  insertedRows: number;
  batches: number;
  tableCreated: boolean;
}

const IMPORT_TIMEOUT_MS = 300_000;

/**
 * CSV Data Import wizard (roadmap Phase 2B, Tools → Import CSV).
 * Three steps: pick file → configure target/mapping → execute.
 */
export function ImportWizard() {
  const [isOpen, setIsOpen] = useState(false);
  const connectionId = useConnectionStore((state) => state.activeConnectionId);

  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [targetTable, setTargetTable] = useState("");
  const [targetColumns, setTargetColumns] = useState<string[]>([]);
  const [hasHeader, setHasHeader] = useState(true);
  const [createTable, setCreateTable] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);

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

  const pickFile = useCallback(async () => {
    setIsBusy(true);
    setError(null);
    try {
      const result = await invokeMutation<CsvPreview>("preview_import_csv", { sampleRows: 20 });
      setPreview(result);
      setTargetColumns(result.columns.map((column) => column.trim().toLowerCase().replace(/\s+/g, "_")));
      setTargetTable((current) => current || result.fileName.replace(/\.csv$/i, "").trim());
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
    } finally {
      setIsBusy(false);
    }
  }, []);

  const runImport = useCallback(async () => {
    if (!preview || !connectionId || !targetTable.trim() || targetColumns.some((column) => !column.trim())) return;
    setIsBusy(true);
    setError(null);
    try {
      const result = await invokeWithTimeout<ImportSummary>(
        "import_csv",
        {
          connectionId,
          table: targetTable,
          path: preview.filePath,
          mappings: preview.columns.map((_column, index) => ({
            sourceIndex: index,
            targetColumn: targetColumns[index] || preview.columns[index],
          })),
          hasHeader,
          createTable,
          batchSize: 200,
        },
        IMPORT_TIMEOUT_MS,
        "CSV import",
      );
      setSummary(result);
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
    } finally {
      setIsBusy(false);
    }
  }, [connectionId, createTable, hasHeader, preview, targetColumns, targetTable]);

  if (!isOpen) return null;

  return (
    <div className="qs-overlay" role="presentation">
      <div className="qs-panel data-import-panel" role="dialog" aria-label="Import CSV">
        <div className="qs-input-row">
          <strong>Import CSV</strong>
          <button type="button" className="qs-clear-btn" aria-label="Close" onClick={() => setIsOpen(false)}>
            <X size={14} />
          </button>
        </div>

        {error && <div className="qs-empty global-search-error">{error}</div>}

        {!preview ? (
          <div className="qs-empty">
            <button type="button" className="global-search-mode active" disabled={isBusy} onClick={() => void pickFile()}>
              {isBusy ? <Loader2 size={13} className="animate-spin" /> : <FileSpreadsheet size={13} />} Choose CSV file…
            </button>
          </div>
        ) : (
          <>
            <div className="schema-diff-summary">
              <span>{preview.fileName}</span>
              <span>{preview.totalRows} rows</span>
              <span>delimiter “{preview.delimiter}”</span>
            </div>

            <div className="schema-diff-selects">
              <input
                value={targetTable}
                onChange={(event) => setTargetTable(event.target.value)}
                placeholder="Target table name"
                aria-label="Target table name"
              />
              <label className="schema-drops-toggle">
                <input type="checkbox" checked={hasHeader} onChange={(event) => setHasHeader(event.target.checked)} />
                First row = header
              </label>
              <label className="schema-drops-toggle">
                <input type="checkbox" checked={createTable} onChange={(event) => setCreateTable(event.target.checked)} />
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
                        current.map((value, position) => (position === index ? event.target.value : value)))
                    }
                    aria-label={`Target column for ${column}`}
                  />
                </div>
              ))}
            </div>

            {summary && (
              <div className="schema-diff-summary">
                <span style={{ color: "var(--fintech-green, #22c55e)" }}>
                  Imported {summary.insertedRows} rows in {summary.batches} batch(es)
                  {summary.tableCreated ? " · table created" : ""}
                </span>
              </div>
            )}

            <div className="schema-diff-selects">
              <button
                type="button"
                className="global-search-mode active"
                disabled={isBusy || !targetTable.trim() || targetColumns.some((column) => !column.trim())}
                onClick={() => void runImport()}
              >
                {isBusy ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} Import
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
