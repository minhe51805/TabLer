/**
 * Profiler — Top Queries tab.
 *
 * P1 of the hybrid profiler: reads the engine's statement store
 * (pg_stat_statements / performance_schema digest summary /
 * sys.dm_exec_query_stats) through the normal `execute_query` path (Safe Mode
 * still enforced) to rank the most expensive statements by cumulative time.
 * Unlike the live trace, this aggregates across *every* execution, so nothing is
 * missed between polls. It is refreshed on demand rather than on a timer.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, Check, Copy, Info, RefreshCw, Search, Workflow } from "lucide-react";
import type { QueryResult } from "../../types";
import { analyzeStatement, primaryInsight } from "../../utils/profiler-insights";
import { ProfilerExplain } from "./ProfilerExplain";

interface TopQueriesProbe {
  engine: string;
  source: string;
  columns: string[];
  sql: string;
  requires: string;
}

interface TopQueryRow {
  key: string;
  queryText: string;
  calls: number;
  totalMs: number;
  meanMs: number;
  rows: number;
}

interface Props {
  connectionId: string;
}

type Cell = string | number | boolean | null;
type SortKey = "totalMs" | "meanMs" | "calls" | "rows";

function cellText(value: Cell | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

function cellNumber(value: Cell | undefined): number {
  if (typeof value === "number") return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mapRows(result: QueryResult, canonical: string[]): TopQueryRow[] {
  const index: Record<string, number> = {};
  for (const name of canonical) {
    index[name] = result.columns.findIndex((column) => column.name.toLowerCase() === name.toLowerCase());
  }
  const text = (row: Cell[], name: string) => (index[name] >= 0 ? cellText(row[index[name]]) : "");
  const numeric = (row: Cell[], name: string) => (index[name] >= 0 ? cellNumber(row[index[name]]) : 0);
  return result.rows.map((row, position) => ({
    key: `${position}`,
    queryText: text(row, "query_text"),
    calls: numeric(row, "calls"),
    totalMs: numeric(row, "total_ms"),
    meanMs: numeric(row, "mean_ms"),
    rows: numeric(row, "rows"),
  }));
}

function formatMs(ms: number): string {
  if (ms <= 0) return "0 ms";
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 2 : 0)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString();
}

const SORT_LABELS: Record<SortKey, string> = {
  totalMs: "Total time",
  meanMs: "Mean time",
  calls: "Calls",
  rows: "Rows",
};

export function ProfilerTopQueries({ connectionId }: Props) {
  const [probe, setProbe] = useState<TopQueriesProbe | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<TopQueryRow[]>([]);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("totalMs");
  const [sortDesc, setSortDesc] = useState(true);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [explainSql, setExplainSql] = useState<string | null>(null);

  const refresh = useCallback(
    async (activeProbe: TopQueriesProbe) => {
      setLoading(true);
      try {
        const result = await invoke<QueryResult>("execute_query", {
          connectionId,
          sql: activeProbe.sql,
          requestId: crypto.randomUUID(),
          safeModeApprovedByUser: false,
        });
        setRows(mapRows(result, activeProbe.columns));
        setQueryError(null);
      } catch (error) {
        setQueryError(error instanceof Error ? error.message : String(error));
      } finally {
        setLoading(false);
      }
    },
    [connectionId],
  );

  useEffect(() => {
    let cancelled = false;
    setProbe(null);
    setProbeError(null);
    setQueryError(null);
    setRows([]);
    setSelectedKey(null);
    invoke<TopQueriesProbe>("get_top_queries_probe", { connectionId })
      .then((resolved) => {
        if (cancelled) return;
        setProbe(resolved);
        void refresh(resolved);
      })
      .catch((error) => {
        if (cancelled) return;
        setProbeError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId, refresh]);

  const toggleSort = useCallback((key: SortKey) => {
    setSortKey((current) => {
      if (current === key) {
        setSortDesc((value) => !value);
        return current;
      }
      setSortDesc(true);
      return key;
    });
  }, []);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const matched = needle
      ? rows.filter((row) => row.queryText.toLowerCase().includes(needle))
      : rows;
    return [...matched].sort((a, b) => {
      const delta = a[sortKey] - b[sortKey];
      return sortDesc ? -delta : delta;
    });
  }, [rows, search, sortKey, sortDesc]);

  const selected = useMemo(
    () => filtered.find((row) => row.key === selectedKey) ?? null,
    [filtered, selectedKey],
  );

  const copySql = useCallback((sql: string) => {
    void navigator.clipboard?.writeText(sql).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  }, []);

  const insightFor = useCallback(
    (row: TopQueryRow) =>
      primaryInsight({
        queryText: row.queryText,
        calls: row.calls,
        meanMs: row.meanMs,
        totalMs: row.totalMs,
      }),
    [],
  );

  const selectedInsights = useMemo(
    () =>
      selected
        ? analyzeStatement({
            queryText: selected.queryText,
            calls: selected.calls,
            meanMs: selected.meanMs,
            totalMs: selected.totalMs,
          })
        : [],
    [selected],
  );

  const sortIndicator = (key: SortKey) => (sortKey === key ? (sortDesc ? " ↓" : " ↑") : "");

  if (probeError) {
    return (
      <div className="p-5">
        <div className="p-4 rounded-lg bg-amber-500/5 border border-amber-500/20 text-sm text-amber-400">
          {probeError}
        </div>
      </div>
    );
  }


  return (
    <>
      <div className="flex flex-wrap items-center gap-3 px-5 py-3 border-b border-[var(--border)] text-xs">
        <button
          type="button"
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-[var(--bg-tertiary)] hover:bg-[var(--border)] disabled:opacity-50"
          onClick={() => probe && void refresh(probe)}
          disabled={loading || !probe}
          title="Re-read the statement store"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          {loading ? "Loading…" : "Refresh"}
        </button>
        {(["totalMs", "meanMs", "calls", "rows"] as const).map((key) => (
          <button
            key={key}
            type="button"
            className={`px-2 py-1 rounded ${sortKey === key ? "bg-[var(--bg-tertiary)] text-[var(--text-primary)]" : "text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)]"}`}
            onClick={() => toggleSort(key)}
          >
            {SORT_LABELS[key]}
            {sortIndicator(key)}
          </button>
        ))}
        <div className="relative flex-1 min-w-[160px]">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            type="text"
            placeholder="Filter by statement text..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="w-full bg-[var(--bg-tertiary)] border border-[var(--border)] rounded pl-7 pr-2 py-1"
          />
        </div>
        <span className="text-[var(--text-muted)]">{filtered.length} statements</span>
      </div>

      {probe && (
        <div className="mx-5 mt-3 flex items-start gap-2 p-2.5 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border)] text-xs text-[var(--text-muted)]">
          <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>
            <strong className="text-[var(--text-primary)]">{probe.source}.</strong> {probe.requires}
          </span>
        </div>
      )}

      {queryError && (
        <div className="mx-5 mt-3 p-2.5 rounded-lg bg-red-500/5 border border-red-500/20 text-xs text-red-400">
          {queryError}
        </div>
      )}


      <div className="flex-1 min-h-0 flex mt-3">
        <div className="flex-1 min-w-0 overflow-auto">
          <table className="w-full text-xs border-collapse">
            <thead className="sticky top-0 bg-[var(--bg-secondary)]">
              <tr className="text-left text-[var(--text-muted)]">
                <th className="px-3 py-2 font-medium">#</th>
                <th className="px-3 py-2 font-medium cursor-pointer" onClick={() => toggleSort("totalMs")}>
                  Total{sortIndicator("totalMs")}
                </th>
                <th className="px-3 py-2 font-medium cursor-pointer" onClick={() => toggleSort("meanMs")}>
                  Mean{sortIndicator("meanMs")}
                </th>
                <th className="px-3 py-2 font-medium cursor-pointer" onClick={() => toggleSort("calls")}>
                  Calls{sortIndicator("calls")}
                </th>
                <th className="px-3 py-2 font-medium cursor-pointer" onClick={() => toggleSort("rows")}>
                  Rows{sortIndicator("rows")}
                </th>
                <th className="px-3 py-2 font-medium">Statement</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-10 text-center text-[var(--text-muted)]">
                    {loading ? "Reading statement store..." : "No statements recorded in the store yet."}
                  </td>
                </tr>
              ) : (
                filtered.map((row, position) => {
                  const insight = insightFor(row);
                  return (
                    <tr
                      key={row.key}
                      onClick={() => setSelectedKey(row.key)}
                      className={`border-t border-[var(--border)] cursor-pointer hover:bg-[var(--bg-tertiary)] ${selectedKey === row.key ? "bg-[var(--bg-tertiary)]" : ""}`}
                    >
                      <td className="px-3 py-2 text-[var(--text-muted)] tabular-nums">{position + 1}</td>
                      <td className="px-3 py-2 tabular-nums">{formatMs(row.totalMs)}</td>
                      <td className="px-3 py-2 tabular-nums">{formatMs(row.meanMs)}</td>
                      <td className="px-3 py-2 tabular-nums">{formatCount(row.calls)}</td>
                      <td className="px-3 py-2 tabular-nums">{formatCount(row.rows)}</td>
                      <td className="px-3 py-2 font-mono max-w-[460px]">
                        <div className="flex items-center gap-1.5 min-w-0">
                          {insight && (
                            <span
                              className={`shrink-0 px-1 py-0.5 rounded text-[10px] font-sans font-medium ${insight.severity === "warn" ? "bg-amber-500/15 text-amber-400" : "bg-sky-500/15 text-sky-400"}`}
                              title={insight.message}
                            >
                              {insight.label}
                            </span>
                          )}
                          <span className="truncate">{row.queryText || "—"}</span>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {selected && (
          <div className="w-[360px] shrink-0 border-l border-[var(--border)] overflow-auto p-4 text-xs">
            <div className="flex items-center justify-between gap-2 mb-3">
              <strong className="text-sm">Statement detail</strong>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 px-2 py-1 rounded bg-[var(--bg-tertiary)] hover:bg-[var(--border)] disabled:opacity-40"
                  onClick={() => selected.queryText && setExplainSql(selected.queryText)}
                  disabled={!selected.queryText}
                  title="Show the query plan (planning only, nothing executes)"
                >
                  <Workflow className="w-3.5 h-3.5" />
                  Explain
                </button>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 px-2 py-1 rounded bg-[var(--bg-tertiary)] hover:bg-[var(--border)]"
                  onClick={() => copySql(selected.queryText)}
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? "Copied" : "Copy SQL"}
                </button>
              </div>
            </div>

            {selectedInsights.length > 0 && (
              <div className="mb-3 space-y-1.5">
                {selectedInsights.map((insight) => (
                  <div
                    key={insight.code}
                    className={`flex items-start gap-1.5 p-2 rounded-lg border text-[11px] ${insight.severity === "warn" ? "bg-amber-500/5 border-amber-500/20 text-amber-300" : "bg-sky-500/5 border-sky-500/20 text-sky-300"}`}
                  >
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <span>{insight.message}</span>
                  </div>
                ))}
              </div>
            )}
            <dl className="space-y-1.5">
              {([
                ["Total time", formatMs(selected.totalMs)],
                ["Mean time", formatMs(selected.meanMs)],
                ["Calls", formatCount(selected.calls)],
                ["Rows", formatCount(selected.rows)],
              ] as const).map(([label, value]) => (
                <div key={label} className="flex gap-2">
                  <dt className="w-24 text-[var(--text-muted)] shrink-0">{label}</dt>
                  <dd className="min-w-0 break-words tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
            <pre className="mt-3 p-3 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border)] font-mono whitespace-pre-wrap break-words">
              {selected.queryText || "—"}
            </pre>
          </div>
        )}
      </div>
      {explainSql && probe && (
        <ProfilerExplain
          connectionId={connectionId}
          engine={probe.engine}
          sql={explainSql}
          onClose={() => setExplainSql(null)}
        />
      )}
    </>
  );
}

