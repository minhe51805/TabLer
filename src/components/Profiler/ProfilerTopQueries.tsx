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
import { COPY_FEEDBACK_MS, TOP_MEAN_CRIT_MS, TOP_MEAN_WARN_MS } from "./profilerConstants";

interface TopQueriesProbe {
  engine: string;
  source: string;
  columns: string[];
  sql: string;
  requires: string;
  /**
   * How to run the probe: "sql" runs `sql` through `execute_query`; "mongodb"
   * (no SQL) samples natively via `execute_profiler_sample`. Kept in sync with
   * `TRANSPORT_*` in the backend `commands/profiler.rs`.
   */
  transport: string;
}

const MONGO_TRANSPORT = "mongodb";

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

function meanTone(ms: number): string {
  if (ms >= TOP_MEAN_CRIT_MS) return "is-crit";
  if (ms >= TOP_MEAN_WARN_MS) return "is-warn";
  return "";
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
        const result =
          activeProbe.transport === MONGO_TRANSPORT
            ? await invoke<QueryResult>("execute_profiler_sample", {
                connectionId,
                kind: "top",
              })
            : await invoke<QueryResult>("execute_query", {
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
      window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
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
      <div className="profiler-unavailable">
        <div className="profiler-unavailable-inner">
          <span className="profiler-unavailable-icon">
            <AlertTriangle className="w-6 h-6" />
          </span>
          <div className="profiler-unavailable-title">Top Queries unavailable</div>
          <div className="profiler-unavailable-msg">{probeError}</div>
        </div>
      </div>
    );
  }


  return (
    <>
      <div className="profiler-toolbar">
        <button
          type="button"
          className="profiler-detail-btn"
          onClick={() => probe && void refresh(probe)}
          disabled={loading || !probe}
          title="Re-read the statement store"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          {loading ? "Loading…" : "Refresh"}
        </button>
        <div className="profiler-seg">
          {(["totalMs", "meanMs", "calls", "rows"] as const).map((key) => (
            <button
              key={key}
              type="button"
              className={`profiler-seg-btn${sortKey === key ? " is-active" : ""}`}
              onClick={() => toggleSort(key)}
            >
              {SORT_LABELS[key]}
              {sortIndicator(key)}
            </button>
          ))}
        </div>
        <div className="profiler-search">
          <Search className="profiler-search-icon w-3.5 h-3.5" />
          <input
            type="text"
            placeholder="Filter by statement text…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="profiler-search-input"
          />
        </div>
        <span className="profiler-counts">
          <span className="profiler-count">{filtered.length} statements</span>
        </span>
      </div>

      {probe && (
        <div className="profiler-info-note">
          <Info className="profiler-info-note-icon w-3.5 h-3.5" />
          <span>
            <strong className="profiler-info-note-strong">{probe.source}.</strong> {probe.requires}
          </span>
        </div>
      )}

      {queryError && (
        <div className="profiler-error">
          <span className="profiler-error-label">Error:</span>
          <span className="profiler-error-msg">{queryError}</span>
        </div>
      )}


      <div className="profiler-body">
        <div className="profiler-scroll">
          <table className="profiler-table">
            <thead>
              <tr>
                <th className="profiler-th profiler-th-rank">#</th>
                <th className="profiler-th profiler-th-sort" onClick={() => toggleSort("totalMs")}>
                  Total{sortIndicator("totalMs")}
                </th>
                <th className="profiler-th profiler-th-sort" onClick={() => toggleSort("meanMs")}>
                  Mean{sortIndicator("meanMs")}
                </th>
                <th className="profiler-th profiler-th-sort" onClick={() => toggleSort("calls")}>
                  Calls{sortIndicator("calls")}
                </th>
                <th className="profiler-th profiler-th-sort" onClick={() => toggleSort("rows")}>
                  Rows{sortIndicator("rows")}
                </th>
                <th className="profiler-th profiler-th-sql">Statement</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="profiler-empty">
                    <div className="profiler-empty-inner">
                      <span className="profiler-empty-orb-core">
                        <RefreshCw className={`w-5 h-5 ${loading ? "animate-spin" : ""}`} />
                      </span>
                      <div className="profiler-empty-title">
                        {loading ? "Reading statement store…" : "No statements recorded yet"}
                      </div>
                      <div className="profiler-empty-hint">
                        {loading
                          ? "Querying the engine's statement store."
                          : "Run some queries on this connection, then hit Refresh."}
                      </div>
                    </div>
                  </td>
                </tr>
              ) : (
                filtered.map((row, position) => {
                  const insight = insightFor(row);
                  return (
                    <tr
                      key={row.key}
                      onClick={() => setSelectedKey(row.key)}
                      className={`profiler-row${selectedKey === row.key ? " is-selected" : ""}`}
                    >
                      <td className="profiler-td profiler-td-rank profiler-muted profiler-num">{position + 1}</td>
                      <td className="profiler-td profiler-duration">{formatMs(row.totalMs)}</td>
                      <td className={`profiler-td profiler-num ${meanTone(row.meanMs)}`}>{formatMs(row.meanMs)}</td>
                      <td className="profiler-td profiler-num">{formatCount(row.calls)}</td>
                      <td className="profiler-td profiler-num profiler-muted">{formatCount(row.rows)}</td>
                      <td className="profiler-td profiler-td-sql">
                        <div className="profiler-sql-flex">
                          {insight && (
                            <span
                              className={`profiler-insight-badge ${insight.severity === "warn" ? "is-warn" : "is-info"}`}
                              title={insight.message}
                            >
                              {insight.label}
                            </span>
                          )}
                          <span className="profiler-sql-text">{row.queryText || "—"}</span>
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
          <div className="profiler-detail">
            <div className="profiler-detail-head">
              <strong className="profiler-detail-title">Statement detail</strong>
              <div className="profiler-detail-actions">
                {probe?.transport !== MONGO_TRANSPORT && (
                  <button
                    type="button"
                    className="profiler-detail-btn"
                    onClick={() => selected.queryText && setExplainSql(selected.queryText)}
                    disabled={!selected.queryText}
                    title="Show the query plan (planning only, nothing executes)"
                  >
                    <Workflow className="w-3.5 h-3.5" />
                    Explain
                  </button>
                )}
                <button
                  type="button"
                  className="profiler-detail-btn"
                  onClick={() => copySql(selected.queryText)}
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
            <div className="profiler-detail-body">
              {selectedInsights.length > 0 && (
                <div className="profiler-detail-insights">
                  {selectedInsights.map((insight) => (
                    <div
                      key={insight.code}
                      className={`profiler-detail-insight ${insight.severity === "warn" ? "is-warn" : "is-info"}`}
                    >
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                      <span>{insight.message}</span>
                    </div>
                  ))}
                </div>
              )}
              <dl className="profiler-dl">
                {([
                  ["Total time", formatMs(selected.totalMs)],
                  ["Mean time", formatMs(selected.meanMs)],
                  ["Calls", formatCount(selected.calls)],
                  ["Rows", formatCount(selected.rows)],
                ] as const).map(([label, value]) => (
                  <div key={label} className="profiler-dl-row">
                    <dt className="profiler-dl-key">{label}</dt>
                    <dd className="profiler-dl-val profiler-num">{value}</dd>
                  </div>
                ))}
              </dl>
              <div className="profiler-sql-box">
                <div className="profiler-sql-box-head">SQL</div>
                <pre className="profiler-sql-box-pre">{selected.queryText || "—"}</pre>
              </div>
            </div>
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

