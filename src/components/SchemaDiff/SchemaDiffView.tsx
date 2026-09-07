import { useCallback, useEffect, useState } from "react";
import { Copy, Loader2, Play, X } from "lucide-react";
import type { ConnectionConfig } from "../../types/database";
import { useConnectionStore } from "../../stores/connectionStore";
import { useSchemaDiffStore } from "../../stores/schemaDiffStore";
import { invokeWithTimeout } from "../../utils/tauri-utils";

interface ColumnChange {
  name: string;
  change: string;
  sourceType: string | null;
  targetType: string | null;
}

interface TableDiff {
  table: string;
  schema: string | null;
  change: string;
  columns: ColumnChange[];
}

interface SchemaDiffSummary {
  added: number;
  removed: number;
  modified: number;
  unchanged: number;
  truncated: boolean;
}

interface SchemaDiffResult {
  summary: SchemaDiffSummary;
  tables: TableDiff[];
}

const DIFF_TIMEOUT_MS = 120_000;
const CHANGE_COLORS: Record<string, string> = {
  added: "var(--fintech-green, #22c55e)",
  removed: "var(--error, #ef4444)",
  modified: "#eab308",
};

/**
 * Schema Diff & migration tool (roadmap Phase 2A, Tools → Schema Diff).
 */
export function SchemaDiffView() {
  const isOpen = useSchemaDiffStore((state) => state.isOpen);
  const close = useSchemaDiffStore((state) => state.close);
  const connections = useConnectionStore((state) => state.connections);
  const activeConnectionId = useConnectionStore((state) => state.activeConnectionId);

  const [connectionA, setConnectionA] = useState<string>("");
  const [connectionB, setConnectionB] = useState<string>("");
  const [diff, setDiff] = useState<SchemaDiffResult | null>(null);
  const [script, setScript] = useState<string | null>(null);
  const [dialect, setDialect] = useState("postgresql");
  const [includeDrops, setIncludeDrops] = useState(false);
  const [isComparing, setIsComparing] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runCompare = useCallback(async () => {
    if (!connectionA || !connectionB || connectionA === connectionB) return;
    setIsComparing(true);
    setError(null);
    setScript(null);
    try {
      const result = await invokeWithTimeout<SchemaDiffResult>(
        "compare_schemas",
        { connectionA, connectionB, databaseA: null, databaseB: null, maxTables: 200 },
        DIFF_TIMEOUT_MS,
        "Schema diff",
      );
      setDiff(result);
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
      setDiff(null);
    } finally {
      setIsComparing(false);
    }
  }, [connectionA, connectionB]);

  const runGenerate = useCallback(async () => {
    if (!diff) return;
    setIsGenerating(true);
    setError(null);
    try {
      const result = await invokeWithTimeout<string>(
        "generate_migration_script",
        { diff, options: { dialect, includeDrops } },
        DIFF_TIMEOUT_MS,
        "Migration script generation",
      );
      setScript(result);
    } catch (errorValue) {
      setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
    } finally {
      setIsGenerating(false);
    }
  }, [dialect, diff, includeDrops]);

  // Open via Command Palette / menu event; default the source to the active connection.
  useEffect(() => {
    const open = () => {
      useSchemaDiffStore.getState().open();
      setConnectionA((current) => current || activeConnectionId || "");
    };
    window.addEventListener("open-schema-diff-palette", open);
    return () => window.removeEventListener("open-schema-diff-palette", open);
  }, [activeConnectionId]);


  if (!isOpen) return null;

  return (
    <div className="qs-overlay" role="presentation">
      <div className="qs-panel schema-diff-panel" role="dialog" aria-label="Schema diff">
        <div className="qs-input-row">
          <strong>Schema Diff</strong>
          <button type="button" className="qs-clear-btn" aria-label="Close" onClick={close}>
            <X size={14} />
          </button>
        </div>

        <div className="schema-diff-selects">
          <select value={connectionA} onChange={(event) => setConnectionA(event.target.value)} aria-label="Source connection">
            <option value="">Source connection…</option>
            {connections.map((connection: ConnectionConfig) => (
              <option key={connection.id} value={connection.id}>
                {connection.name}{connection.id === activeConnectionId ? " (active)" : ""}
              </option>
            ))}
          </select>
          <span>→</span>
          <select value={connectionB} onChange={(event) => setConnectionB(event.target.value)} aria-label="Target connection">
            <option value="">Target connection…</option>
            {connections.map((connection: ConnectionConfig) => (
              <option key={connection.id} value={connection.id}>{connection.name}</option>
            ))}
          </select>
          <button
            type="button"
            className="global-search-mode active"
            disabled={isComparing || !connectionA || !connectionB || connectionA === connectionB}
            onClick={() => void runCompare()}
          >
            {isComparing ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} Compare
          </button>
        </div>

        {error && <div className="qs-empty global-search-error">{error}</div>}

        {diff && (
          <>
            <div className="schema-diff-summary">
              <span style={{ color: CHANGE_COLORS.added }}>+{diff.summary.added} added</span>
              <span style={{ color: CHANGE_COLORS.removed }}>-{diff.summary.removed} removed</span>
              <span style={{ color: CHANGE_COLORS.modified }}>~{diff.summary.modified} modified</span>
              <span>= {diff.summary.unchanged} unchanged</span>
              {diff.summary.truncated && <span title="Result capped">⚠ truncated</span>}
            </div>
            <div className="qs-list schema-diff-results">
              {diff.tables.map((table) => (
                <div key={`${table.schema ?? ""}.${table.table}`} className="qs-item static">
                  <span className="global-search-match-label" style={{ color: CHANGE_COLORS[table.change] }}>
                    {table.change === "added" ? "+" : table.change === "removed" ? "-" : "~"}{" "}
                    {table.schema ? `${table.schema}.` : ""}{table.table}
                  </span>
                  <span className="global-search-match-kind">
                    {table.columns.slice(0, 3).map((column) => `${column.change}: ${column.name}`).join(", ")}
                    {table.columns.length > 3 ? ` +${table.columns.length - 3} more` : ""}
                  </span>
                </div>
              ))}
            </div>

            <div className="schema-diff-selects">
              <select value={dialect} onChange={(event) => setDialect(event.target.value)} aria-label="Migration dialect">
                {["postgresql", "mysql", "mariadb", "mssql", "sqlite", "duckdb", "clickhouse", "snowflake"].map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
              <label className="schema-drops-toggle">
                <input type="checkbox" checked={includeDrops} onChange={(event) => setIncludeDrops(event.target.checked)} />
                Include DROPs
              </label>
              <button
                type="button"
                className="global-search-mode active"
                disabled={isGenerating || diff.tables.length === 0}
                onClick={() => void runGenerate()}
              >
                {isGenerating ? <Loader2 size={13} className="animate-spin" /> : null} Generate migration
              </button>
            </div>

            {script && (
              <div className="schema-diff-script">
                <button type="button" className="qs-clear-btn" aria-label="Copy script" onClick={() => void navigator.clipboard.writeText(script)}>
                  <Copy size={13} /> Copy
                </button>
                <pre>{script}</pre>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
