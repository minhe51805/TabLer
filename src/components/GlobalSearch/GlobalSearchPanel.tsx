import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Search, X } from "lucide-react";
import type { QueryResult } from "../../types";
import { useConnectionStore } from "../../stores/connectionStore";
import { useUIStore } from "../../stores/uiStore";
import { invokeWithTimeout, invokeMutation } from "../../utils/tauri-utils";
import { useGlobalSearchStore } from "../../stores/globalSearchStore";
import { useI18n } from "../../i18n";

interface SchemaMatch {
  table: string;
  schema: string | null;
  column: string | null;
  matchType: "table" | "column";
}

interface MultiTableDataMatch {
  table: string;
  columns: string[];
  rows: (string | number | boolean | null)[][];
  truncated: boolean;
  error?: string | null;
}

const ALL_TABLES = "__all_tables__";

const SEARCH_TIMEOUT_MS = 15_000;
/** Cross-table sweep hits every table sequentially (columns + LIKE query) — allow longer. */
const SEARCH_MULTI_TIMEOUT_MS = 45_000;

/**
 * Global Search overlay (roadmap Phase 2C, Ctrl+Shift+F).
 * Schema mode matches table/column names; Data mode runs a parameterized LIKE
 * query across the selected table's text columns server-side.
 */
export function GlobalSearchPanel() {
  const { t } = useI18n();
  const isOpen = useGlobalSearchStore((state) => state.isOpen);
  const mode = useGlobalSearchStore((state) => state.mode);
  const close = useGlobalSearchStore((state) => state.close);
  const setMode = useGlobalSearchStore((state) => state.setMode);
  const connectionId = useConnectionStore((state) => state.activeConnectionId);
  const currentDatabase = useConnectionStore((state) => state.currentDatabase);
  const tables = useConnectionStore((state) => state.tables);
  const fetchTables = useConnectionStore((state) => state.fetchTables);
  const activeDbType = useConnectionStore(
    (state) =>
      state.connections.find((c) => c.id === state.activeConnectionId)?.db_type,
  );
  const allDatabases = useConnectionStore((state) => state.databases);
  const addTab = useUIStore((state) => state.addTab);

  const [keyword, setKeyword] = useState("");
  const [dataTable, setDataTable] = useState("");
  const [schemaMatches, setSchemaMatches] = useState<SchemaMatch[]>([]);
  const [dataResult, setDataResult] = useState<QueryResult | null>(null);
  const [multiResult, setMultiResult] = useState<MultiTableDataMatch[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const tablesFetchedRef = useRef(false);
  const [searchDb, setSearchDb] = useState<string | null>(null);
  const [crossDbTables, setCrossDbTables] = useState<string[] | null>(null);
  const [crossDbLoading, setCrossDbLoading] = useState(false);

  const isCrossDbSupported = activeDbType === "mssql";

  // Data mode needs a table list — load the catalog once when the panel opens.
  useEffect(() => {
    if (!isOpen || !connectionId || tables.length > 0 || tablesFetchedRef.current) return;
    tablesFetchedRef.current = true;
    void fetchTables(connectionId, currentDatabase || undefined);
  }, [isOpen, connectionId, currentDatabase, tables.length, fetchTables]);

  // Allow a retry when the connection changes.
  useEffect(() => {
    tablesFetchedRef.current = false;
    setCrossDbTables(null);
    setSearchDb(null);
  }, [connectionId]);

  const tableOptions = useMemo(
    () =>
      tables.map((table) =>
        table.schema ? `${table.schema}.${table.name}` : table.name,
      ),
    [tables],
  );

  // Effective tables for Data mode: cross-db list when the user picked a
  // different SQL Server database, otherwise the current catalog.
  const effectiveTableOptions =
    isCrossDbSupported && searchDb && searchDb !== currentDatabase
      ? crossDbTables ?? []
      : tableOptions;

  // Default the target table so Data mode works the moment a keyword is typed.
  useEffect(() => {
    if (mode === "data" && !dataTable && effectiveTableOptions.length > 0) {
      setDataTable(effectiveTableOptions[0]);
    }
  }, [mode, dataTable, effectiveTableOptions]);

  // Reset per-open state and focus the input.
  useEffect(() => {
    if (isOpen) {
      setSchemaMatches([]);
      setDataResult(null);
      setMultiResult(null);
      setError(null);
      setIsSearching(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen, mode]);

  const runSchemaSearch = useCallback(
    async (needle: string) => {
      if (!connectionId || !needle.trim()) {
        setSchemaMatches([]);
        return;
      }
      setIsSearching(true);
      setError(null);
      try {
        const matches = await invokeWithTimeout<SchemaMatch[]>(
          "search_schema",
          { connectionId, keyword: needle, limit: 60 },
          SEARCH_TIMEOUT_MS,
          "Global schema search",
        );
        setSchemaMatches(Array.isArray(matches) ? matches : []);
      } catch (errorValue) {
        setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
        setSchemaMatches([]);
      } finally {
        setIsSearching(false);
      }
    },
    [connectionId],
  );

  const runDataSearch = useCallback(
    async (needle: string, targetTable: string) => {
      if (!connectionId || !needle.trim() || !targetTable.trim()) {
        setDataResult(null);
        setMultiResult(null);
        return;
      }
      setIsSearching(true);
      setError(null);
      try {
        if (targetTable === ALL_TABLES) {
          const matches = await invokeWithTimeout<MultiTableDataMatch[]>(
            "search_table_data_multi",
            {
              connectionId,
              tables: effectiveTableOptions,
              keyword: needle,
              limit: 50,
              database:
                isCrossDbSupported && searchDb && searchDb !== currentDatabase
                  ? searchDb
                  : null,
            },
            SEARCH_MULTI_TIMEOUT_MS,
            "Global data search (all tables)",
          );
          setMultiResult(Array.isArray(matches) ? matches : []);
          setDataResult(null);
          return;
        }
        const result = await invokeWithTimeout<QueryResult>(
          "search_table_data",
          { connectionId, table: targetTable, keyword: needle, limit: 50 },
          SEARCH_TIMEOUT_MS,
          "Global data search",
        );
        setDataResult(result);
        setMultiResult(null);
      } catch (errorValue) {
        setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
        setDataResult(null);
        setMultiResult(null);
      } finally {
        setIsSearching(false);
      }
    },
    [connectionId, effectiveTableOptions, isCrossDbSupported, searchDb, currentDatabase],
  );

  // Debounced auto-run so results follow typing without a submit button.
  useEffect(() => {
    if (!isOpen) return;
    const timer = window.setTimeout(() => {
      if (mode === "schema") void runSchemaSearch(keyword);
      else void runDataSearch(keyword, dataTable);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [dataTable, isOpen, keyword, mode, runDataSearch, runSchemaSearch]);

  const openTableTab = useCallback(
    (table: string) => {
      if (!connectionId) return;
      addTab({
        id: `table-${connectionId}-${currentDatabase || ""}-${table}`,
        type: "table",
        title: table,
        connectionId,
        database: currentDatabase || undefined,
        tableName: table,
      });
      close();
    },
    [addTab, close, connectionId, currentDatabase],
  );

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="qs-overlay" onMouseDown={close} role="presentation">
      <div
        className="qs-panel global-search-panel"
        role="dialog"
        aria-label="Global search"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="qs-input-row">
          <Search size={14} className="qs-input-icon" />
          <input
            ref={inputRef}
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder={mode === "schema" ? "Search tables and columns…" : "Search text in table…"}
            spellCheck={false}
            aria-label="Global search keyword"
          />
          {keyword && (
            <button type="button" className="qs-clear-btn" aria-label="Clear" onClick={() => setKeyword("")}>
              <X size={14} />
            </button>
          )}
        </div>

        <div className="global-search-modes" role="tablist">
          <button type="button" role="tab" aria-selected={mode === "schema"}
            className={`global-search-mode ${mode === "schema" ? "active" : ""}`}
            onClick={() => setMode("schema")}>Schema</button>
          <button type="button" role="tab" aria-selected={mode === "data"}
            className={`global-search-mode ${mode === "data" ? "active" : ""}`}
            onClick={() => setMode("data")}>Data</button>
          {mode === "data" && isCrossDbSupported ? (
            <select
              className="global-search-scope-select"
              value={searchDb ?? currentDatabase ?? ""}
              onChange={(event) => {
                setSearchDb(event.target.value || null);
                setDataTable("");
                if (event.target.value && event.target.value !== currentDatabase && connectionId) {
                  setCrossDbLoading(true);
                  invokeMutation<string[]>("list_tables_in", {
                    connectionId,
                    database: event.target.value,
                  })
                    .then((list) => setCrossDbTables(Array.isArray(list) ? list : []))
                    .catch((e) => {
                      setError(e instanceof Error ? e.message : String(e));
                      setCrossDbTables([]);
                    })
                    .finally(() => setCrossDbLoading(false));
                }
              }}
              aria-label={t("globalSearch.searchDatabase")}
            >
              {(currentDatabase ? [currentDatabase] : [])
                .concat(allDatabases.map((db) => db.name).filter((n) => n !== currentDatabase))
                .map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
            </select>
          ) : (
            <span className="global-search-scope">
              {connectionId ? `on ${currentDatabase || "default database"}` : "— connect to a database first"}
            </span>
          )}
        </div>

        {mode === "data" && (
          <div className="qs-input-row">
            {effectiveTableOptions.length > 0 ? (
              <select
                className="global-search-table-select"
                value={dataTable}
                onChange={(event) => setDataTable(event.target.value)}
                disabled={crossDbLoading}
                aria-label="Table to search"
              >
                <option value={ALL_TABLES}>
                  {t("globalSearch.allTables")}
                </option>
                <option disabled>──────────</option>
                {effectiveTableOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={dataTable}
                onChange={(event) => setDataTable(event.target.value)}
                placeholder="Table name (e.g. dbo.users)"
                spellCheck={false}
                aria-label="Table to search"
              />
            )}
          </div>
        )}

        <div className="qs-list" role="listbox" aria-label="Global search results">
          {error && <div className="qs-empty global-search-error">{error}</div>}
          {!error && isSearching && (
            <div className="global-search-loading">
              <div className="global-search-loading-head">
                <Loader2 size={16} className="animate-spin global-search-loading-icon" />
                <span>
                  {mode === "data" && dataTable === ALL_TABLES
                    ? t("globalSearch.scanningAll")
                    : t("globalSearch.searching")}
                </span>
              </div>
              <div className="global-search-loading-skeleton">
                <span className="gs-skel" style={{ width: "62%" }} />
                <span className="gs-skel" style={{ width: "84%", animationDelay: "0.15s" }} />
                <span className="gs-skel" style={{ width: "48%", animationDelay: "0.3s" }} />
              </div>
            </div>
          )}
          {!error && !isSearching && mode === "schema" && (
            schemaMatches.length === 0 ? (
              <div className="qs-empty">{keyword ? "No schema matches" : "Type to search tables and columns"}</div>
            ) : (
              schemaMatches.map((match) => (
                <button
                  key={`${match.table}-${match.column ?? "table"}`}
                  type="button"
                  className="qs-item"
                  role="option"
                  aria-selected={false}
                  onClick={() => openTableTab(match.table)}
                >
                  <span className="qs-item-icon"><Search size={14} /></span>
                  <span className="global-search-match-label">
                    {match.matchType === "table" ? match.table : `${match.column} · in ${match.table}`}
                  </span>
                  <span className="global-search-match-kind">{match.matchType}</span>
                </button>
              ))
            )
          )}
          {!error && !isSearching && mode === "data" && multiResult !== null && (
            multiResult.length === 0 ? (
              <div className="qs-empty">
                {keyword ? "No matching rows in any table" : "Type a keyword to search all tables"}
              </div>
            ) : (
              <div className="global-search-multi">
                {multiResult.map((group) => (
                  <div key={group.table} className="global-search-multi-group">
                    {group.error ? (
                      <div className="global-search-multi-error" title={group.error}>⚠ {group.error}</div>
                    ) : null}
                    <div className="global-search-multi-head">
                      <span className="global-search-multi-table" title={group.table}>
                        {group.table}
                      </span>
                      <span className="global-search-multi-count">
                        {group.truncated
                          ? t("globalSearch.truncatedAtCap")
                          : `${group.rows.length} row(s)`}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="qs-item"
                      onClick={() => openTableTab(group.table)}
                    >
                      <span className="qs-item-icon"><Search size={14} /></span>
                      <span className="global-search-match-label">
                        {t("globalSearch.openTable")}
                      </span>
                    </button>
                  </div>
                ))}
              </div>
            )
          )}
          {!error && !isSearching && mode === "data" && multiResult === null && (
            dataResult && dataResult.rows.length > 0 ? (
              <div className="global-search-data-result">
                <div className="global-search-data-meta">
                  {dataResult.rows.length} matching row(s) in {dataTable}
                </div>
                <button type="button" className="qs-item" onClick={() => openTableTab(dataTable)}>
                  <span className="qs-item-icon"><Search size={14} /></span>
                  <span className="global-search-match-label">Open {dataTable} to browse matches</span>
                </button>
              </div>
            ) : (
              <div className="qs-empty">
                {!keyword
                  ? "Type a keyword to search the selected table"
                  : !dataTable
                    ? "Select a table to search"
                    : "No matching rows"}
              </div>
            )
          )}
        </div>

        <div className="global-search-footer">
          <span>Esc to close · results limited to your active connection</span>
        </div>
      </div>
    </div>
  );
}
