/**
 * Live Profiler — cross-engine active-session trace.
 *
 * P0 of the hybrid profiler: polls the backend `get_profiler_probe` SQL through
 * the normal `execute_query` path (Safe Mode still enforced) on a timer, and
 * accumulates the samples into a filterable live trace. A session/statement that
 * stops showing up between polls is marked "done" but kept in the log, so the
 * table reads like SQL Server Profiler's event stream — just cross-engine.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Activity, Check, Copy, Pause, Play, Search, Trash2, Workflow, X } from "lucide-react";
import type { QueryResult } from "../../types";
import { ProfilerTopQueries } from "./ProfilerTopQueries";
import { ProfilerExplain } from "./ProfilerExplain";

interface ProfilerProbe {
  engine: string;
  source: string;
  columns: string[];
  sql: string;
  minIntervalMs: number;
}

interface ProfilerSample {
  sessionId: string;
  dbName: string;
  username: string;
  application: string;
  clientAddr: string;
  state: string;
  waitEvent: string;
  durationMs: number;
  queryText: string;
}

interface TraceEvent extends ProfilerSample {
  key: string;
  firstSeen: number;
  lastSeen: number;
  active: boolean;
}

interface Props {
  connectionId: string;
  connectionName: string;
  onClose: () => void;
}

type Cell = string | number | boolean | null;

const INTERVAL_CHOICES = [500, 1000, 2000, 5000] as const;
const MAX_EVENTS = 500;

function cellText(value: Cell | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

function cellNumber(value: Cell | undefined): number {
  if (typeof value === "number") return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mapSamples(result: QueryResult, canonical: string[]): ProfilerSample[] {
  const index: Record<string, number> = {};
  for (const name of canonical) {
    index[name] = result.columns.findIndex((column) => column.name.toLowerCase() === name.toLowerCase());
  }
  const text = (row: Cell[], name: string) => (index[name] >= 0 ? cellText(row[index[name]]) : "");
  const numeric = (row: Cell[], name: string) => (index[name] >= 0 ? cellNumber(row[index[name]]) : 0);
  return result.rows.map((row) => ({
    sessionId: text(row, "session_id"),
    dbName: text(row, "db_name"),
    username: text(row, "username"),
    application: text(row, "application"),
    clientAddr: text(row, "client_addr"),
    state: text(row, "state"),
    waitEvent: text(row, "wait_event"),
    durationMs: Math.round(numeric(row, "duration_ms")),
    queryText: text(row, "query_text"),
  }));
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "0 ms";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function mergeSamples(previous: TraceEvent[], samples: ProfilerSample[], now: number): TraceEvent[] {
  const byKey = new Map<string, TraceEvent>();
  for (const event of previous) byKey.set(event.key, { ...event, active: false });
  for (const sample of samples) {
    const key = `${sample.sessionId}::${sample.queryText}`;
    const existing = byKey.get(key);
    if (existing) {
      byKey.set(key, {
        ...existing,
        ...sample,
        durationMs: Math.max(existing.durationMs, sample.durationMs),
        lastSeen: now,
        active: true,
      });
    } else {
      byKey.set(key, { key, ...sample, firstSeen: now, lastSeen: now, active: true });
    }
  }
  return Array.from(byKey.values())
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, MAX_EVENTS);
}

export function ProfilerModal({ connectionId, connectionName, onClose }: Props) {
  const [probe, setProbe] = useState<ProfilerProbe | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [intervalMs, setIntervalMs] = useState<number>(1000);
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [search, setSearch] = useState("");
  const [minDurationMs, setMinDurationMs] = useState(0);
  const [activeOnly, setActiveOnly] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState<"live" | "top">("live");
  const [explainSql, setExplainSql] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setProbe(null);
    setProbeError(null);
    setEvents([]);
    invoke<ProfilerProbe>("get_profiler_probe", { connectionId })
      .then((resolved) => {
        if (cancelled) return;
        setProbe(resolved);
        setIntervalMs(Math.max(1000, resolved.minIntervalMs));
        setRunning(true);
      })
      .catch((error) => {
        if (cancelled) return;
        setProbeError(error instanceof Error ? error.message : String(error));
        setRunning(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId]);

  useEffect(() => {
    if (!running || !probe || tab !== "live") return;
    let cancelled = false;
    const tick = async () => {
      try {
        const result = await invoke<QueryResult>("execute_query", {
          connectionId,
          sql: probe.sql,
          requestId: crypto.randomUUID(),
          safeModeApprovedByUser: false,
        });
        if (cancelled) return;
        const now = Date.now();
        setEvents((previous) => mergeSamples(previous, mapSamples(result, probe.columns), now));
        setPollError(null);
      } catch (error) {
        if (cancelled) return;
        setPollError(error instanceof Error ? error.message : String(error));
        setRunning(false);
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [running, probe, intervalMs, connectionId, tab]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return events.filter((event) => {
      if (activeOnly && !event.active) return false;
      if (event.durationMs < minDurationMs) return false;
      if (!needle) return true;
      return (
        event.queryText.toLowerCase().includes(needle) ||
        event.username.toLowerCase().includes(needle) ||
        event.dbName.toLowerCase().includes(needle) ||
        event.application.toLowerCase().includes(needle)
      );
    });
  }, [events, search, minDurationMs, activeOnly]);

  const selected = useMemo(
    () => filtered.find((event) => event.key === selectedKey) ?? null,
    [filtered, selectedKey],
  );

  const activeCount = useMemo(() => events.filter((event) => event.active).length, [events]);

  const copySql = useCallback((sql: string) => {
    void navigator.clipboard?.writeText(sql).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl shadow-2xl w-[min(1200px,calc(100vw-32px))] max-h-[88vh] flex flex-col"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-5 py-4 border-b border-[var(--border)]">
          <span className="w-9 h-9 rounded-lg bg-emerald-500/10 text-emerald-500 inline-flex items-center justify-center">
            <Activity className="w-5 h-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">Profiler</h2>
            <p className="text-xs text-[var(--text-muted)] truncate">
              {connectionName}
              {tab === "live" && probe ? ` · ${probe.source}` : ""}
            </p>
          </div>
          {tab === "live" && probe && (
            <button
              type="button"
              className="connection-icon-btn"
              onClick={() => setRunning((value) => !value)}
              title={running ? "Pause capture" : "Start capture"}
            >
              {running ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            </button>
          )}
          {tab === "live" && (
            <button type="button" className="connection-icon-btn" onClick={() => setEvents([])} title="Clear trace">
              <Trash2 className="w-4 h-4" />
            </button>
          )}
          <button type="button" className="p-1.5 rounded-lg hover:bg-[var(--bg-tertiary)]" onClick={onClose}>
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex items-center gap-1 px-5 text-xs border-b border-[var(--border)]">
          {([
            ["live", "Live Trace"],
            ["top", "Top Queries"],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              className={`px-3 py-2 -mb-px border-b-2 ${tab === value ? "border-emerald-500 text-[var(--text-primary)]" : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]"}`}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === "top" ? (
          <ProfilerTopQueries connectionId={connectionId} />
        ) : probeError ? (
          <div className="p-5">
            <div className="p-4 rounded-lg bg-amber-500/5 border border-amber-500/20 text-sm text-amber-400">
              {probeError}
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3 px-5 py-3 border-b border-[var(--border)] text-xs">
              <span className={`inline-flex items-center gap-1.5 ${running ? "text-emerald-500" : "text-[var(--text-muted)]"}`}>
                <span className={`w-2 h-2 rounded-full ${running ? "bg-emerald-500 animate-pulse" : "bg-[var(--text-muted)]"}`} />
                {running ? "Capturing" : "Paused"}
              </span>
              <label className="inline-flex items-center gap-1.5">
                <span className="text-[var(--text-muted)]">Every</span>
                <select
                  className="bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-1.5 py-1"
                  value={intervalMs}
                  onChange={(event) => setIntervalMs(Number(event.target.value))}
                >
                  {INTERVAL_CHOICES.map((choice) => (
                    <option key={choice} value={choice}>{choice} ms</option>
                  ))}
                </select>
              </label>
              <label className="inline-flex items-center gap-1.5">
                <span className="text-[var(--text-muted)]">Min duration</span>
                <input
                  type="number"
                  min={0}
                  step={100}
                  value={minDurationMs}
                  onChange={(event) => setMinDurationMs(Math.max(0, Number(event.target.value)))}
                  className="w-20 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-1.5 py-1"
                />
                <span className="text-[var(--text-muted)]">ms</span>
              </label>
              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={activeOnly} onChange={(event) => setActiveOnly(event.target.checked)} />
                <span className="text-[var(--text-muted)]">Active only</span>
              </label>
              <div className="relative flex-1 min-w-[160px]">
                <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
                <input
                  type="text"
                  placeholder="Filter SQL, user, database, app..."
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  className="w-full bg-[var(--bg-tertiary)] border border-[var(--border)] rounded pl-7 pr-2 py-1"
                />
              </div>
              <span className="text-[var(--text-muted)]">
                {activeCount} active · {events.length} captured
              </span>
            </div>

            {pollError && (
              <div className="mx-5 mt-3 p-2.5 rounded-lg bg-red-500/5 border border-red-500/20 text-xs text-red-400">
                {pollError}
              </div>
            )}
            <div className="flex-1 min-h-0 flex">
              <div className="flex-1 min-w-0 overflow-auto">
                <table className="w-full text-xs border-collapse">
                  <thead className="sticky top-0 bg-[var(--bg-secondary)]">
                    <tr className="text-left text-[var(--text-muted)]">
                      <th className="px-3 py-2 font-medium">#</th>
                      <th className="px-3 py-2 font-medium">Duration</th>
                      <th className="px-3 py-2 font-medium">Database</th>
                      <th className="px-3 py-2 font-medium">User</th>
                      <th className="px-3 py-2 font-medium">State</th>
                      <th className="px-3 py-2 font-medium">SQL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-3 py-10 text-center text-[var(--text-muted)]">
                          {running ? "Waiting for active statements..." : "No captured statements match the filters."}
                        </td>
                      </tr>
                    ) : (
                      filtered.map((event) => (
                        <tr
                          key={event.key}
                          onClick={() => setSelectedKey(event.key)}
                          className={`border-t border-[var(--border)] cursor-pointer hover:bg-[var(--bg-tertiary)] ${selectedKey === event.key ? "bg-[var(--bg-tertiary)]" : ""}`}
                        >
                          <td className="px-3 py-2">
                            <span className={`inline-block w-2 h-2 rounded-full ${event.active ? "bg-emerald-500" : "bg-[var(--text-muted)]"}`} title={event.active ? "Running" : "Finished"} />
                          </td>
                          <td className="px-3 py-2 tabular-nums">{formatDuration(event.durationMs)}</td>
                          <td className="px-3 py-2 truncate max-w-[120px]">{event.dbName || "—"}</td>
                          <td className="px-3 py-2 truncate max-w-[120px]">{event.username || "—"}</td>
                          <td className="px-3 py-2 truncate max-w-[110px]">{event.state || "—"}</td>
                          <td className="px-3 py-2 font-mono truncate max-w-[420px]">{event.queryText || "—"}</td>
                        </tr>
                      ))
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
                  <dl className="space-y-1.5">
                    {([
                      ["Session", selected.sessionId],
                      ["Database", selected.dbName],
                      ["User", selected.username],
                      ["Application", selected.application],
                      ["Client", selected.clientAddr],
                      ["State", selected.state],
                      ["Wait", selected.waitEvent],
                      ["Duration", formatDuration(selected.durationMs)],
                      ["Status", selected.active ? "Running" : "Finished"],
                    ] as const).map(([label, value]) => (
                      <div key={label} className="flex gap-2">
                        <dt className="w-24 text-[var(--text-muted)] shrink-0">{label}</dt>
                        <dd className="min-w-0 break-words">{value || "—"}</dd>
                      </div>
                    ))}
                  </dl>
                  <pre className="mt-3 p-3 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border)] font-mono whitespace-pre-wrap break-words">
                    {selected.queryText || "—"}
                  </pre>
                </div>
              )}
            </div>
          </>
        )}
        {explainSql && probe && (
          <ProfilerExplain
            connectionId={connectionId}
            engine={probe.engine}
            sql={explainSql}
            onClose={() => setExplainSql(null)}
          />
        )}
      </div>
    </div>
  );
}
