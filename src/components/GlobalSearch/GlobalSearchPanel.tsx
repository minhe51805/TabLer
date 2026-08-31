import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Search, X } from "lucide-react";
import type { QueryResult } from "../../types";
import { useConnectionStore } from "../../stores/connectionStore";
import { useUIStore } from "../../stores/uiStore";
import { invokeWithTimeout } from "../../utils/tauri-utils";
import { useGlobalSearchStore } from "../../stores/globalSearchStore";

interface SchemaMatch {
  table: string;
  schema: string | null;
  column: string | null;
  matchType: "table" | "column";
}

const SEARCH_TIMEOUT_MS = 15_000;

/**
 * Global Search overlay (roadmap Phase 2C, Ctrl+Shift+F).
 * Schema mode matches table/column names; Data mode runs a parameterized LIKE
 * query across the selected table's text columns server-side.
 */
export function GlobalSearchPanel() {
  const isOpen = useGlobalSearchStore((state) => state.isOpen);
  const mode = useGlobalSearchStore((state) => state.mode);
  const close = useGlobalSearchStore((state) => state.close);
  const setMode = useGlobalSearchStore((state) => state.setMode);
  const connectionId = useConnectionStore((state) => state.activeConnectionId);
  const currentDatabase = useConnectionStore((state) => state.currentDatabase);
  const addTab = useUIStore((state) => state.addTab);

  const [keyword, setKeyword] = useState("");
  const [dataTable, setDataTable] = useState("");
  const [schemaMatches, setSchemaMatches] = useState<SchemaMatch[]>([]);
  const [dataResult, setDataResult] = useState<QueryResult | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset per-open state and focus the input.
  useEffect(() => {
    if (isOpen) {
      setSchemaMatches([]);
      setDataResult(null);
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
        return;
      }
      setIsSearching(true);
      setError(null);
      try {
        const result = await invokeWithTimeout<QueryResult>(
          "search_table_data",
          { connectionId, table: targetTable, keyword: needle, limit: 50 },
          SEARCH_TIMEOUT_MS,
          "Global data search",
        );
        setDataResult(result);
      } catch (errorValue) {
        setError(errorValue instanceof Error ? errorValue.message : String(errorValue));
        setDataResult(null);
      } finally {
        setIsSearching(false);
      }
    },
    [connectionId],
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
          <span className="global-search-scope">
            {connectionId ? `on ${currentDatabase || "default database"}` : "— connect to a database first"}
          </span>
        </div>

        {mode === "data" && (
          <div className="qs-input-row">
            <input
              value={dataTable}
              onChange={(event) => setDataTable(event.target.value)}
              placeholder="Table name (e.g. dbo.users)"
              spellCheck={false}
              aria-label="Table to search"
            />
          </div>
        )}

        <div className="qs-list" role="listbox" aria-label="Global search results">
          {error && <div className="qs-empty global-search-error">{error}</div>}
          {!error && isSearching && (
            <div className="qs-empty"><Loader2 size={14} className="animate-spin" /> Searching…</div>
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
          {!error && !isSearching && mode === "data" && (
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
                {keyword && dataTable ? "No matching rows" : "Enter a keyword and a table to search"}
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
