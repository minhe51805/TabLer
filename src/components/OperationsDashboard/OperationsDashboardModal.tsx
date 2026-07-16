import { Activity, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useQueryStore } from "../../stores/queryStore";
import type { QueryResult } from "../../types";

interface OperationalQuery { id: string; label: string; description: string; sql: string; }
type QueryState = { query: OperationalQuery; result?: QueryResult; error?: string };

interface Props { connectionId: string; connectionName: string; onClose: () => void; }

export function OperationsDashboardModal({ connectionId, connectionName, onClose }: Props) {
  const executeQuery = useQueryStore((state) => state.executeQuery);
  const [items, setItems] = useState<QueryState[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const queries = await invoke<OperationalQuery[]>("get_operational_queries", { connectionId });
      const results = await Promise.all(queries.map(async (query) => {
        try { return { query, result: await executeQuery(connectionId, query.sql) }; }
        catch (error) { return { query, error: error instanceof Error ? error.message : String(error) }; }
      }));
      setItems(results);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
      setItems([]);
    } finally { setIsLoading(false); }
  }, [connectionId, executeQuery]);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl shadow-2xl w-[min(1100px,calc(100vw-32px))] max-h-[86vh] flex flex-col" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center gap-3 px-5 py-4 border-b border-[var(--border)]">
          <span className="w-9 h-9 rounded-lg bg-blue-500/10 text-blue-500 inline-flex items-center justify-center"><Activity className="w-5 h-5" /></span>
          <div className="min-w-0 flex-1"><h2 className="text-base font-semibold">Operations dashboard</h2><p className="text-xs text-[var(--text-muted)] truncate">Read-only session, lock, long-query, and health checks for {connectionName}</p></div>
          <button type="button" className="connection-icon-btn" onClick={() => void refresh()} disabled={isLoading} title="Refresh operations"><RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} /></button>
          <button type="button" className="p-1.5 rounded-lg hover:bg-[var(--bg-tertiary)]" onClick={onClose}><X className="w-4 h-4" /></button>
        </div>
        <div className="overflow-auto p-5">
          {loadError && <div className="p-3 rounded-lg bg-red-500/5 border border-red-500/20 text-sm text-red-400">{loadError}</div>}
          {isLoading && <div className="py-16 text-center text-sm text-[var(--text-muted)]">Loading read-only operational checks...</div>}
          {!isLoading && !loadError && <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {items.map(({ query, result, error }) => <section key={query.id} className="border border-[var(--border)] rounded-lg overflow-hidden">
              <div className="px-4 py-3 border-b border-[var(--border)]"><strong className="text-sm">{query.label}</strong><p className="text-xs text-[var(--text-muted)] mt-1">{query.description}</p></div>
              {error ? <div className="p-4 text-xs text-amber-500">{error}</div> : <div className="overflow-auto max-h-64"><table className="min-w-full text-xs"><thead><tr>{result?.columns.map((column) => <th className="text-left px-3 py-2 bg-[var(--bg-tertiary)]" key={column.name}>{column.name}</th>)}</tr></thead><tbody>{result?.rows.slice(0, 100).map((row, index) => <tr className="border-t border-[var(--border)]" key={index}>{row.map((value, cellIndex) => <td className="px-3 py-2 whitespace-nowrap" key={cellIndex}>{value === null ? "NULL" : String(value)}</td>)}</tr>)}</tbody></table>{result?.rows.length === 0 && <p className="p-4 text-xs text-[var(--text-muted)]">No rows returned.</p>}</div>}
            </section>)}
          </div>}
        </div>
      </div>
    </div>
  );
}
