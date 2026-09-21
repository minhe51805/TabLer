import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { ColumnInfo, QueryResult } from "../types";
import { useConnectionStore } from "../stores/connectionStore";
import { isProgressiveEligible } from "../stores/queryStore";
import { notifyQueryDone } from "../utils/query-notify";
import { getCachedQueryResult, setCachedQueryResult } from "../utils/query-result-cache";

/**
 * Progressive large-read delivery (roadmap Phase 3B).
 *
 * `run` invokes the backend `execute_query_progressive` command which streams
 * `query-row-batch` events; rows are appended into state as batches arrive so
 * callers can render progressively instead of waiting for the whole payload.
 * `cancel` rides the existing request-cancellation registry.
 *
 * Read-only runs go through the shared 30s result cache (repeat runs resolve
 * instantly with `state.cached`), and completions raise an OS notification
 * when the window was hidden or the run took longer than 10s.
 */
export interface ProgressiveQueryState {
  columns: ColumnInfo[];
  rows: unknown[][];
  totalRows: number;
  done: boolean;
  requestId: string | null;
  /** True when the current result came from the local result cache. */
  cached: boolean;
}

const INITIAL_STATE: ProgressiveQueryState = {
  columns: [],
  rows: [],
  totalRows: 0,
  done: true,
  requestId: null,
  cached: false,
};

interface QueryRowBatchEvent {
  connectionId: string;
  columns: ColumnInfo[];
  rows: unknown[][];
  offset: number;
  totalRows: number;
  done: boolean;
}

export function useProgressiveQuery() {
  const [state, setState] = useState<ProgressiveQueryState>(INITIAL_STATE);
  const [isRunning, setIsRunning] = useState(false);
  const activeRequestIdRef = useRef<string | null>(null);
  const activeConnectionIdRef = useRef<string | null>(null);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let disposed = false;
    void listen<QueryRowBatchEvent>("query-row-batch", (event) => {
      const batch = event.payload;
      if (batch.connectionId !== activeConnectionIdRef.current) return;
      setState((current) => ({
        columns: batch.columns.length > 0 ? batch.columns : current.columns,
        rows: [...current.rows, ...batch.rows],
        totalRows: batch.totalRows,
        done: batch.done,
        requestId: current.requestId,
        cached: current.cached,
      }));
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const run = useCallback(async (connectionId: string, sql: string, chunkSize?: number) => {
    const database = useConnectionStore.getState().currentDatabase;
    const cacheable = isProgressiveEligible(sql);
    if (cacheable) {
      const cached = getCachedQueryResult(connectionId, sql, database);
      if (cached) {
        setState({
          columns: cached.columns,
          rows: cached.rows.map((row) => row),
          totalRows: cached.rows.length,
          done: true,
          requestId: null,
          cached: true,
        });
        return cached;
      }
    }
    const requestId = `${connectionId}::${crypto.randomUUID()}`;
    activeRequestIdRef.current = requestId;
    activeConnectionIdRef.current = connectionId;
    setState({ ...INITIAL_STATE, requestId, done: false });
    setIsRunning(true);
    const startedAt = Date.now();
    try {
      const result = await invoke<QueryResult>("execute_query_progressive", {
        connectionId,
        sql,
        chunkSize: chunkSize ?? null,
        requestId,
      });
      // The command resolves with the complete result; reconcile in case any
      // batch event was dropped by the transport.
      setState({
        columns: result.columns,
        rows: result.rows.map((row: unknown[]) => row),
        totalRows: result.rows.length,
        done: true,
        requestId,
        cached: false,
      });
      if (cacheable) setCachedQueryResult(connectionId, sql, database, result);
      void notifyQueryDone({
        durationMs: Date.now() - startedAt,
        rowCount: result.rows.length,
      });
      return result;
    } catch (error) {
      void notifyQueryDone({ durationMs: Date.now() - startedAt, error });
      throw error;
    } finally {
      setIsRunning(false);
      activeRequestIdRef.current = null;
      activeConnectionIdRef.current = null;
    }
  }, []);

  const cancel = useCallback(async () => {
    const requestId = activeRequestIdRef.current;
    if (!requestId) return false;
    // The backend registered the full "connectionId::uuid" id — send it
    // verbatim along with the connection id so server-side cancellation
    // (KILL QUERY / pg_cancel_backend) can actually fire.
    return invoke<boolean>("cancel_query", {
      requestId,
      connectionId: activeConnectionIdRef.current,
    });
  }, []);

  return { state, isRunning, run, cancel };
}
