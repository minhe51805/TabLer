import { useCallback, useEffect, useState } from "react";
import { Copy, Loader2, Play, X } from "lucide-react";
import type { ConnectionConfig, DatabaseInfo } from "../../types/database";
import { useI18n } from "../../i18n";
import { useConnectionStore } from "../../stores/connectionStore";
import { useSchemaDiffStore } from "../../stores/schemaDiffStore";
import { FRONTEND_TIMEOUTS } from "../../stores/connectionStoreHelpers";
import { invokeWithTimeout } from "../../utils/tauri-utils";
import { getSchemaDiffCopy } from "./schema-diff-copy";

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
const CHANGE_ORDER = ["added", "removed", "modified"] as const;

function columnDetail(column: ColumnChange): string {
  if (column.change === "modified") {
    return `${column.sourceType ?? "?"} → ${column.targetType ?? "?"}`;
  }
  return column.targetType ?? column.sourceType ?? "";
}

/**
 * Schema Diff & migration tool (roadmap Phase 2A, Tools → Schema Diff).
 * Compares two connections — or two databases on the same connection —
 * and renders the diff grouped by added / removed / modified tables.
 */
export function SchemaDiffView() {
  const isOpen = useSchemaDiffStore((state) => state.isOpen);
  const close = useSchemaDiffStore((state) => state.close);
  const connections = useConnectionStore((state) => state.connections);
  const connectedIds = useConnectionStore((state) => state.connectedIds);
  const activeConnectionId = useConnectionStore((state) => state.activeConnectionId);
  const { language } = useI18n();
  const copy = getSchemaDiffCopy(language);

  const [connectionA, setConnectionA] = useState<string>("");
  const [connectionB, setConnectionB] = useState<string>("");
  const [databaseA, setDatabaseA] = useState<string>("");
  const [databaseB, setDatabaseB] = useState<string>("");
  const [databases, setDatabases] = useState<DatabaseInfo[]>([]);
  const [diff, setDiff] = useState<SchemaDiffResult | null>(null);
  const [script, setScript] = useState<string | null>(null);
  const [dialect, setDialect] = useState("postgresql");
  const [includeDrops, setIncludeDrops] = useState(false);
  const [isComparing, setIsComparing] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sameConnection = connectionA !== "" && connectionA === connectionB;
  const sameTarget = sameConnection && databaseA === databaseB;

  const runCompare = useCallback(async () => {
    if (!connectionA || !connectionB) return;
    if (connectionA === connectionB && databaseA === databaseB) return;
    setIsComparing(true);
    setError(null);
    setScript(null);
    try {
      const result = await invokeWithTimeout<SchemaDiffResult>(
        "compare_schemas",
        {
          connectionA,
          connectionB,
          databaseA: databaseA || null,
          databaseB: databaseB || null,
          maxTables: 200,
        },
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
  }, [connectionA, connectionB, databaseA, databaseB]);

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

  // Same-connection diffs compare two databases; load the catalog once both
  // selects settle on one connection.
  useEffect(() => {
    setDatabaseA("");
    setDatabaseB("");
    if (!sameConnection) {
      setDatabases([]);
      return;
    }
    let cancelled = false;
    invokeWithTimeout<DatabaseInfo[]>(
      "list_databases",
      { connectionId: connectionA },
      FRONTEND_TIMEOUTS.metadata,
      "Listing databases",
    )
      .then((result) => {
        if (!cancelled) setDatabases(result);
      })
      .catch(() => {
        if (!cancelled) setDatabases([]);
      });
    return () => {
      cancelled = true;
    };
  }, [sameConnection, connectionA]);

  if (!isOpen) return null;

  const groupedTables = CHANGE_ORDER.map((change) => ({
    change,
    tables: diff?.tables.filter((table) => table.change === change) ?? [],
  })).filter((group) => group.tables.length > 0);
  const groupLabel = (change: string, count: number) =>
    change === "added"
      ? copy.groupAdded(count)
      : change === "removed"
        ? copy.groupRemoved(count)
        : copy.groupModified(count);

  const renderConnectionOptions = () =>
    connections.map((connection: ConnectionConfig) => {
      const connected = connectedIds.has(connection.id);
      const suffix =
        connection.id === activeConnectionId
          ? ` ${copy.activeSuffix}`
          : connected
            ? ""
            : ` ${copy.notConnectedSuffix}`;
      return (
        <option key={connection.id} value={connection.id} disabled={!connected}>
          {connection.name}
          {suffix}
        </option>
      );
    });

  return (
    <div className="qs-overlay" role="presentation">
      <div className="qs-panel schema-diff-panel" role="dialog" aria-label={copy.title}>
        <div className="qs-input-row">
          <strong>{copy.title}</strong>
          <button type="button" className="qs-clear-btn" aria-label={copy.close} onClick={close}>
            <X size={14} />
          </button>
        </div>

        <div className="schema-diff-selects">
          <select
            value={connectionA}
            onChange={(event) => setConnectionA(event.target.value)}
            aria-label={copy.sourceConnection}
          >
            <option value="">{copy.sourceConnection}</option>
            {renderConnectionOptions()}
          </select>
          <span>→</span>
          <select
            value={connectionB}
            onChange={(event) => setConnectionB(event.target.value)}
            aria-label={copy.targetConnection}
          >
            <option value="">{copy.targetConnection}</option>
            {renderConnectionOptions()}
          </select>
          <button
            type="button"
            className="global-search-mode active"
            disabled={isComparing || !connectionA || !connectionB || sameTarget}
            onClick={() => void runCompare()}
          >
            {isComparing ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}{" "}
            {copy.compare}
          </button>
        </div>

        {sameConnection && (
          <div className="schema-diff-selects">
            <select
              value={databaseA}
              onChange={(event) => setDatabaseA(event.target.value)}
              aria-label={copy.sourceDatabase}
            >
              <option value="">{copy.sourceDatabase}</option>
              {databases.map((database) => (
                <option key={database.name} value={database.name}>
                  {database.name}
                </option>
              ))}
            </select>
            <span>→</span>
            <select
              value={databaseB}
              onChange={(event) => setDatabaseB(event.target.value)}
              aria-label={copy.targetDatabase}
            >
              <option value="">{copy.targetDatabase}</option>
              {databases.map((database) => (
                <option key={database.name} value={database.name}>
                  {database.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {error && <div className="qs-empty global-search-error">{error}</div>}

        {diff && (
          <>
            <div className="schema-diff-summary">
              <span style={{ color: CHANGE_COLORS.added }}>
                {copy.summaryAdded(diff.summary.added)}
              </span>
              <span style={{ color: CHANGE_COLORS.removed }}>
                {copy.summaryRemoved(diff.summary.removed)}
              </span>
              <span style={{ color: CHANGE_COLORS.modified }}>
                {copy.summaryModified(diff.summary.modified)}
              </span>
              <span>{copy.summaryUnchanged(diff.summary.unchanged)}</span>
              {diff.summary.truncated && <span title={copy.truncatedTitle}>{copy.truncated}</span>}
            </div>
            <div className="qs-list schema-diff-results">
              {groupedTables.length === 0 && <div className="qs-empty">{copy.noDifferences}</div>}
              {groupedTables.map((group) => (
                <div key={group.change}>
                  <div
                    className="qs-item static global-search-match-kind"
                    style={{ color: CHANGE_COLORS[group.change] }}
                  >
                    {groupLabel(group.change, group.tables.length)}
                  </div>
                  {group.tables.map((table) => (
                    <div
                      key={`${table.schema ?? ""}.${table.table}`}
                      className="qs-item static"
                      style={{ flexDirection: "column", alignItems: "stretch" }}
                    >
                      <span
                        className="global-search-match-label"
                        style={{ color: CHANGE_COLORS[table.change] }}
                      >
                        {table.change === "added" ? "+" : table.change === "removed" ? "-" : "~"}{" "}
                        {table.schema ? `${table.schema}.` : ""}
                        {table.table}
                      </span>
                      {table.columns.map((column) => (
                        <span
                          key={column.name}
                          className="global-search-match-kind"
                          style={{ paddingLeft: 16 }}
                        >
                          {column.change === "added"
                            ? "+"
                            : column.change === "removed"
                              ? "-"
                              : "~"}{" "}
                          {column.name}
                          {columnDetail(column) ? ` (${columnDetail(column)})` : ""}
                        </span>
                      ))}
                    </div>
                  ))}
                </div>
              ))}
            </div>

            <div className="schema-diff-selects">
              <select
                value={dialect}
                onChange={(event) => setDialect(event.target.value)}
                aria-label={copy.dialectLabel}
              >
                {[
                  "postgresql",
                  "mysql",
                  "mariadb",
                  "mssql",
                  "sqlite",
                  "duckdb",
                  "clickhouse",
                  "snowflake",
                ].map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
              <label className="schema-drops-toggle">
                <input
                  type="checkbox"
                  checked={includeDrops}
                  onChange={(event) => setIncludeDrops(event.target.checked)}
                />
                {copy.includeDrops}
              </label>
              <button
                type="button"
                className="global-search-mode active"
                disabled={isGenerating || diff.tables.length === 0}
                onClick={() => void runGenerate()}
              >
                {isGenerating ? <Loader2 size={13} className="animate-spin" /> : null}{" "}
                {copy.generateMigration}
              </button>
            </div>

            {script && (
              <div className="schema-diff-script">
                <button
                  type="button"
                  className="qs-clear-btn"
                  aria-label={copy.copyScript}
                  onClick={() => void navigator.clipboard.writeText(script)}
                >
                  <Copy size={13} /> {copy.copyScript}
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
