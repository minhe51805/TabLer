import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { ColumnInfo, QueryResult } from "../types";

/**
 * Progressive large-read delivery (roadmap Phase 3B).
 *
 * `run` invokes the backend `execute_query_progressive` command which streams
 * `query-row-batch` events; rows are appended into state as batches arrive so
 * callers can render progressively instead of waiting for the whole payload.
 * `cancel` rides the existing request-cancellation registry.
 */
export interface ProgressiveQueryState {
  columns: ColumnInfo[];
  rows: unknown[][];
  totalRows: number;
  done: boolean;
  requestId: string | null;
}

const INITIAL_STATE: ProgressiveQueryState = {
  columns: [],
  rows: [],
  totalRows: 0,
  done: true,
  requestId: null,
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

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let disposed = false;
    void listen<QueryRowBatchEvent>("query-row-batch", (event) => {
      const batch = event.payload;
      if (batch.connectionId !== activeRequestIdRef.current?.split("::")[0]) return;
      setState((current) => ({
        columns: batch.columns.length > 0 ? batch.columns : current.columns,
        rows: [...current.rows, ...batch.rows],
        totalRows: batch.totalRows,
        done: batch.done,
        requestId: current.requestId,
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

  const run = useCallback(
    async (connectionId: string, sql: string, chunkSize?: number) => {
      const requestId = `${connectionId}::${crypto.randomUUID()}`;
      activeRequestIdRef.current = requestId;
      setState({ ...INITIAL_STATE, requestId, done: false });
      setIsRunning(true);
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
        });
        return result;
      } finally {
        setIsRunning(false);
        activeRequestIdRef.current = null;
      }
    },
    [],
  );

  const cancel = useCallback(async () => {
    const requestId = activeRequestIdRef.current?.split("::")[1];
    if (!requestId) return false;
    return invoke<boolean>("cancel_query", { requestId });
  }, []);

  return { state, isRunning, run, cancel };
}
