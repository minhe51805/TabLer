/**
 * Profiler — Explain overlay.
 *
 * P3 of the hybrid profiler. Takes a statement captured by the Live Trace or the
 * Top Queries store and runs a *planning-only* EXPLAIN (never ANALYZE, so
 * nothing executes) through the normal `execute_query` path — Safe Mode still
 * applies — then renders the shared `ExplainVisualizer`, which already surfaces
 * cost hotspots and CREATE INDEX proposals from the index advisor. That reuse is
 * the whole point: the profiler answers "which query is expensive", and the
 * existing plan visualizer answers "why", including the missing-index advice.
 *
 * Statement-store digests keep their `$1` / `?` placeholders, which EXPLAIN
 * cannot bind, so we detect that up front and explain why a plan is unavailable
 * instead of surfacing a raw binding error.
 */

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X } from "lucide-react";
import type { DatabaseType, QueryResult } from "../../types";
import {
  buildExplainQuery,
  parseExplainOutput,
  type ParsedExplainPlan,
} from "../../utils/explain-parser";
import { hasNormalizedPlaceholders } from "../../utils/profiler-insights";
import { ExplainVisualizer } from "../ExplainVisualizer/ExplainVisualizer";

interface Props {
  connectionId: string;
  /** Lowercase engine key from the probe (matches the `DatabaseType` union). */
  engine: string;
  /** The statement to plan. */
  sql: string;
  onClose: () => void;
}

/**
 * Normalize an EXPLAIN result into the shape `parseExplainOutput` expects,
 * mirroring the extraction the SQL editor already uses: a single text/JSON cell,
 * or a reconstructed row-object list, with a JSON string parsed when present.
 */
function extractExplainOutput(result: QueryResult): unknown {
  let raw: unknown = null;
  if (result.rows.length === 1 && result.columns.length === 1) {
    raw = result.rows[0][0];
  } else if (result.rows.length > 0) {
    const objects = result.rows.map((row) => {
      const obj: Record<string, unknown> = {};
      result.columns.forEach((column, i) => {
        obj[column.name] = row[i];
      });
      return obj;
    });
    raw = result.rows.length === 1 ? objects[0] : objects;
  }
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      // Keep the text format; parseExplainOutput handles plain text too.
    }
  }
  return raw;
}

export function ProfilerExplain({ connectionId, engine, sql, onClose }: Props) {
  const [plan, setPlan] = useState<ParsedExplainPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const dbType = engine as DatabaseType;
  const placeholders = hasNormalizedPlaceholders(sql);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    setPlan(null);
    try {
      const explainSql = buildExplainQuery(sql, dbType, false);
      const result = await invoke<QueryResult>("execute_query", {
        connectionId,
        sql: explainSql,
        requestId: crypto.randomUUID(),
        safeModeApprovedByUser: false,
      });
      setPlan(parseExplainOutput(dbType, extractExplainOutput(result)));
    } catch (caught) {
      const base = caught instanceof Error ? caught.message : String(caught);
      setError(
        placeholders
          ? `${base}\n\nThis statement still carries normalized placeholders ($1 / ?) from the statement store, which EXPLAIN cannot bind. Capture it from the Live Trace tab (which keeps the real literal values) to inspect its plan.`
          : base,
      );
    } finally {
      setLoading(false);
    }
  }, [connectionId, dbType, sql, placeholders]);

  useEffect(() => {
    void run();
  }, [run]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl shadow-2xl w-[min(1100px,calc(100vw-32px))] max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-5 py-3 border-b border-[var(--border)]">
          <strong className="text-sm flex-1">Explain plan</strong>
          {placeholders && (
            <span className="text-[11px] text-amber-400" title="Statement-store digests use $1 / ? placeholders">
              normalized statement
            </span>
          )}
          <button type="button" className="p-1.5 rounded-lg hover:bg-[var(--bg-tertiary)]" onClick={onClose} title="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
        <pre className="px-5 py-2 text-xs font-mono text-[var(--text-muted)] whitespace-pre-wrap break-words border-b border-[var(--border)] max-h-24 overflow-auto">
          {sql}
        </pre>
        <div className="flex-1 min-h-0 overflow-auto">
          {loading ? (
            <div className="p-8 text-center text-sm text-[var(--text-muted)]">Planning…</div>
          ) : error ? (
            <div className="p-5">
              <div className="p-4 rounded-lg bg-red-500/5 border border-red-500/20 text-sm text-red-400 whitespace-pre-wrap">
                {error}
              </div>
            </div>
          ) : plan ? (
            <ExplainVisualizer plan={plan} sourceSql={sql} />
          ) : null}
        </div>
      </div>
    </div>
  );
}
