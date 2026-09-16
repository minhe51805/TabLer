/**
 * Live Profiler — cross-engine active-session trace.
 *
 * P0 of the hybrid profiler: polls the backend `get_profiler_probe` SQL through
 * the normal `execute_query` path (Safe Mode still enforced) on a timer, and
 * accumulates the samples into a filterable live trace. A session/statement that
 * stops showing up between polls is marked "done" but kept in the log, so the
 * table reads like SQL Server Profiler's event stream — just cross-engine.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Activity, BarChart3, Check, Copy, Minus, Pause, Play, Search, Square, Trash2, Workflow, Zap, X } from "lucide-react";
import type { QueryResult } from "../../types";
import { ProfilerTopQueries } from "./ProfilerTopQueries";
import { ProfilerExplain } from "./ProfilerExplain";
import { PROFILER_CONNECTION_CLOSED_EVENT } from "./profilerWindow";
import { isTauriDesktopWindow } from "../../hooks/useDesktopWindow";
import {
  CONNECTION_GONE_MARKER,
  COPY_FEEDBACK_MS,
  DEFAULT_POLL_INTERVAL_MS,
  LIVE_DURATION_CRIT_MS,
  LIVE_DURATION_WARN_MS,
  MAX_TRACE_EVENTS,
  POLL_INTERVAL_CHOICES,
} from "./profilerConstants";

interface ProfilerProbe {
  engine: string;
  source: string;
  columns: string[];
  sql: string;
  minIntervalMs: number;
  /**
   * How to run the probe: "sql" runs `sql` through `execute_query`; "mongodb"
   * (no SQL) samples natively via `execute_profiler_sample`. Kept in sync with
   * `TRANSPORT_*` in the backend `commands/profiler.rs`.
   */
  transport: string;
}

const MONGO_TRANSPORT = "mongodb";

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
  /**
   * "overlay" (default) renders the profiler as a centered modal portalled into
   * the app window. "standalone" renders it as the sole content of a detached
   * native window: no backdrop, fills the window, and the header doubles as the
   * OS drag region with minimize/maximize/close controls.
   */
  variant?: "overlay" | "standalone";
}

type Cell = string | number | boolean | null;

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

function durationTone(ms: number): string {
  if (ms >= LIVE_DURATION_CRIT_MS) return "text-red-500";
  if (ms >= LIVE_DURATION_WARN_MS) return "text-amber-500";
  return "text-[var(--text-primary)]";
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
    .slice(0, MAX_TRACE_EVENTS);
}

export function ProfilerModal({ connectionId, connectionName, onClose, variant = "overlay" }: Props) {
  const isStandalone = variant === "standalone";
  const [probe, setProbe] = useState<ProfilerProbe | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [intervalMs, setIntervalMs] = useState<number>(DEFAULT_POLL_INTERVAL_MS);
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [search, setSearch] = useState("");
  const [minDurationMs, setMinDurationMs] = useState(0);
  const [activeOnly, setActiveOnly] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState<"live" | "top">("live");
  const [explainSql, setExplainSql] = useState<string | null>(null);

  // Keep the latest onClose without re-subscribing the cross-window listener:
  // ProfilerWindowApp passes a fresh handler each render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    let cancelled = false;
    setProbe(null);
    setProbeError(null);
    setEvents([]);
    invoke<ProfilerProbe>("get_profiler_probe", { connectionId })
      .then((resolved) => {
        if (cancelled) return;
        setProbe(resolved);
        setIntervalMs(Math.max(DEFAULT_POLL_INTERVAL_MS, resolved.minIntervalMs));
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

  // Live sampling loop. Uses a self-rescheduling `setTimeout` with an in-flight
  // guard rather than a raw `setInterval` (mirroring useConnectionHealthMonitor)
  // so a slow poll can never stack a second query on top of itself, and it
  // pauses entirely while the window/tab is hidden — no point sampling a
  // database the user can't see, and it spares the connection needless load
  // while the profiler is minimized or backgrounded.
  useEffect(() => {
    if (!running || !probe || tab !== "live") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;

    const schedule = () => {
      if (cancelled) return;
      timer = setTimeout(() => void tick(), intervalMs);
    };

    const tick = async () => {
      // Skip while a previous poll is still running or the window is hidden;
      // just re-arm the timer so we resume on the next visible tick.
      if (inFlight || (typeof document !== "undefined" && document.hidden)) {
        schedule();
        return;
      }
      inFlight = true;
      try {
        const result =
          probe.transport === MONGO_TRANSPORT
            ? await invoke<QueryResult>("execute_profiler_sample", {
                connectionId,
                kind: "live",
              })
            : await invoke<QueryResult>("execute_query", {
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
        return; // stop the loop — `running` is now false
      } finally {
        inFlight = false;
      }
      schedule();
    };

    // Refresh immediately when the window becomes visible again, so the trace
    // is current the moment the user returns instead of after a full interval.
    const handleVisibility = () => {
      if (!document.hidden && !inFlight) {
        if (timer) clearTimeout(timer);
        void tick();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [running, probe, intervalMs, connectionId, tab]);

  // The profiler often lives in a *detached* native window that does not share
  // the connection store, so it cannot react to a disconnect on its own. The
  // main window broadcasts a global Tauri event when a connection is dropped;
  // close ourselves when it targets the connection we are tracking instead of
  // lingering on a dead session.
  useEffect(() => {
    if (!isTauriDesktopWindow()) return;
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    void listen<{ connectionId: string }>(PROFILER_CONNECTION_CLOSED_EVENT, (event) => {
      if (event.payload?.connectionId === connectionId) onCloseRef.current();
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [connectionId]);

  // Safety net for disconnect paths that don't emit the event above: once the
  // backend session is gone every probe/poll fails with this exact message, so
  // there is nothing left to profile — close rather than showing a dead window.
  useEffect(() => {
    const connectionGone = (message: string | null) =>
      !!message && message.includes(CONNECTION_GONE_MARKER);
    if (connectionGone(probeError) || connectionGone(pollError)) onCloseRef.current();
  }, [probeError, pollError]);

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
      window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    });
  }, []);

  // Standalone (detached native window) chrome: the header acts as the OS drag
  // region and hosts native minimize/maximize/close controls, since the window
  // is created without decorations.
  const handleHeaderDrag = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest("button, input, textarea, select, a, [role='button']")) return;
    void getCurrentWindow()
      .startDragging()
      .catch((error) => console.error("Failed to start dragging profiler window", error));
  }, []);

  const handleMinimizeWindow = useCallback(() => {
    void getCurrentWindow()
      .minimize()
      .catch((error) => console.error("Failed to minimize profiler window", error));
  }, []);

  const handleToggleMaximizeWindow = useCallback(() => {
    void getCurrentWindow()
      .toggleMaximize()
      .catch((error) => console.error("Failed to toggle maximize profiler window", error));
  }, []);

  const shell = (
    <div
      className={
        isStandalone
          ? "profiler-panel h-screen w-screen overflow-hidden"
          : "profiler-panel border border-[var(--border)] rounded-2xl shadow-2xl ring-1 ring-black/5 overflow-hidden w-[min(1200px,calc(100vw-32px))] h-[88vh] max-h-[88vh]"
      }
      onClick={isStandalone ? undefined : (event) => event.stopPropagation()}
    >
        <div className="profiler-header" onMouseDown={isStandalone ? handleHeaderDrag : undefined}>
          <span className="profiler-header-icon">
            <Activity className="w-[19px] h-[19px]" />
          </span>
          <div className="profiler-header-titles">
            <div className="profiler-title-row">
              <span className="profiler-title">Profiler</span>
              {tab === "live" && running && (
                <span className="profiler-live-badge">
                  <span className="profiler-dot is-on">
                    <span className="profiler-dot-ping" />
                    <span className="profiler-dot-core" />
                  </span>
                  Live
                </span>
              )}
            </div>
            <div className="profiler-subtitle">
              {connectionName}
              {tab === "live" && probe ? ` · ${probe.source}` : ""}
            </div>
          </div>
          {tab === "live" && probe && (
            <button
              type="button"
              className="profiler-header-btn"
              onClick={() => setRunning((value) => !value)}
              title={running ? "Pause capture" : "Start capture"}
            >
              {running ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            </button>
          )}
          {tab === "live" && (
            <button type="button" className="profiler-header-btn is-danger" onClick={() => setEvents([])} title="Clear trace">
              <Trash2 className="w-4 h-4" />
            </button>
          )}
          {isStandalone && (
            <>
              <span className="profiler-header-divider" />
              <button type="button" className="profiler-header-btn" onClick={handleMinimizeWindow} title="Minimize">
                <Minus className="w-4 h-4" />
              </button>
              <button type="button" className="profiler-header-btn" onClick={handleToggleMaximizeWindow} title="Maximize">
                <Square className="w-3.5 h-3.5" />
              </button>
            </>
          )}
          <button type="button" className="profiler-header-btn is-danger" onClick={onClose} title="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="profiler-tabbar">
          <div className="profiler-tabs">
            {([
              ["live", "Live Trace", Zap],
              ["top", "Top Queries", BarChart3],
            ] as const).map(([value, label, Icon]) => (
              <button
                key={value}
                type="button"
                onClick={() => setTab(value)}
                className={`profiler-tab${tab === value ? " is-active" : ""}`}
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
              </button>
            ))}
          </div>
        </div>
        {tab === "top" ? (
          <ProfilerTopQueries connectionId={connectionId} />
        ) : probeError ? (
          <div className="profiler-unavailable">
            <div className="profiler-unavailable-inner">
              <span className="profiler-unavailable-icon">
                <Activity className="w-6 h-6" />
              </span>
              <div className="profiler-unavailable-title">Profiler unavailable</div>
              <div className="profiler-unavailable-msg">{probeError}</div>
            </div>
          </div>
        ) : (
          <>
            <div className="profiler-toolbar">
              <span className={`profiler-status${running ? " is-live" : ""}`}>
                <span className={`profiler-dot${running ? " is-on" : ""}`}>
                  {running && <span className="profiler-dot-ping" />}
                  <span className="profiler-dot-core" />
                </span>
                {running ? "Capturing" : "Paused"}
              </span>

              <div className="profiler-controls">
                <label className="profiler-control">
                  <span className="profiler-control-label">Every</span>
                  <select
                    className="profiler-field"
                    value={intervalMs}
                    onChange={(event) => setIntervalMs(Number(event.target.value))}
                  >
                    {POLL_INTERVAL_CHOICES.map((choice) => (
                      <option key={choice} value={choice}>{choice} ms</option>
                    ))}
                  </select>
                </label>
                <span className="profiler-control-divider" />
                <label className="profiler-control">
                  <span className="profiler-control-label">Min</span>
                  <input
                    type="number"
                    min={0}
                    step={100}
                    value={minDurationMs}
                    onChange={(event) => setMinDurationMs(Math.max(0, Number(event.target.value)))}
                    className="profiler-field profiler-field-num"
                  />
                  <span className="profiler-control-unit">ms</span>
                </label>
                <span className="profiler-control-divider" />
                <label className="profiler-control profiler-checkbox">
                  <input
                    type="checkbox"
                    checked={activeOnly}
                    onChange={(event) => setActiveOnly(event.target.checked)}
                    className="accent-[var(--accent)]"
                  />
                  Active only
                </label>
              </div>

              <div className="profiler-search">
                <Search className="profiler-search-icon w-3.5 h-3.5" />
                <input
                  type="text"
                  placeholder="Filter SQL, user, database, app…"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  className="profiler-search-input"
                />
              </div>

              <div className="profiler-counts">
                <span className="profiler-count is-active">
                  <span className="profiler-count-dot" />
                  {activeCount} active
                </span>
                <span className="profiler-count">{events.length} captured</span>
              </div>
            </div>

            {pollError && (
              <div className="profiler-error">
                <span className="profiler-error-label">Error:</span>
                <span className="profiler-error-msg">{pollError}</span>
              </div>
            )}
            <div className="profiler-body">
              <div className="profiler-scroll">
                <table className="profiler-table">
                  <thead>
                    <tr>
                      <th className="profiler-th profiler-th-status" aria-label="Status" />
                      <th className="profiler-th">Duration</th>
                      <th className="profiler-th">Database</th>
                      <th className="profiler-th">User</th>
                      <th className="profiler-th">State</th>
                      <th className="profiler-th profiler-th-sql">SQL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.length === 0 ? (
                      <tr>
                        <td colSpan={6} className={`profiler-empty${running ? " is-live" : ""}`}>
                          <div className="profiler-empty-inner">
                            <span className="profiler-empty-orb">
                              {running && (
                                <>
                                  <span className="profiler-empty-wave profiler-empty-wave-1" />
                                  <span className="profiler-empty-wave profiler-empty-wave-2" />
                                </>
                              )}
                              <span className="profiler-empty-orb-core">
                                <Activity className={`w-6 h-6 ${running ? "animate-pulse" : ""}`} />
                              </span>
                            </span>
                            <div className="profiler-empty-title">
                              {running ? "Waiting for active statements…" : "No statements captured"}
                            </div>
                            <div className="profiler-empty-hint">
                              {running
                                ? "Run a query on this connection and it will show up here in real time."
                                : "No captured statements match the filters."}
                            </div>
                          </div>
                        </td>
                      </tr>
                    ) : (
                      filtered.map((event) => (
                        <tr
                          key={event.key}
                          onClick={() => setSelectedKey(event.key)}
                          className={`profiler-row${selectedKey === event.key ? " is-selected" : ""}`}
                        >
                          <td className="profiler-td profiler-td-status">
                            <span className={`profiler-dot${event.active ? " is-on" : ""}`} title={event.active ? "Running" : "Finished"}>
                              {event.active && <span className="profiler-dot-ping" />}
                              <span className="profiler-dot-core" />
                            </span>
                          </td>
                          <td className="profiler-td">
                            <span className={`profiler-duration ${durationTone(event.durationMs)}`}>
                              {formatDuration(event.durationMs)}
                            </span>
                          </td>
                          <td className="profiler-td profiler-cell-truncate">{event.dbName || "—"}</td>
                          <td className="profiler-td profiler-cell-truncate">{event.username || "—"}</td>
                          <td className="profiler-td">
                            {event.state ? (
                              <span className="profiler-state-badge">{event.state}</span>
                            ) : (
                              <span className="profiler-muted">—</span>
                            )}
                          </td>
                          <td className="profiler-td profiler-sql-cell">{event.queryText || "—"}</td>
                        </tr>
                      ))
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
                    <dl className="profiler-dl">
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
                        <div key={label} className="profiler-dl-row">
                          <dt className="profiler-dl-key">{label}</dt>
                          <dd className="profiler-dl-val">{value || "—"}</dd>
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
  );

  if (isStandalone) {
    return shell;
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      {shell}
    </div>,
    document.body,
  );
}
