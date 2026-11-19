import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useStore } from "zustand";
import { getCurrentAppLanguage } from "../../../i18n";
import type { QueryResult } from "../../../types";
import { emitAppToast } from "../../../utils/app-toast";
import { devLogError } from "../../../utils/logger";
import { invokeMutation } from "../../../utils/tauri-utils";
import { isMutatingStatement } from "../../SQLEditor/SQLEditorUtils";
import { getDataGridChartCopy } from "../datagrid-chart-copy";
import type { DataGridStoreApi } from "../store/dataGridStore";

export interface UseDataGridToolbarAutoRefreshTickerParams {
  autoRefreshMs?: number;
  onAutoRefreshMsChange?: (ms: number) => void;
  autoRefreshTick?: () => void;
  autoRefreshPaused?: boolean;
  autoRefreshBusy?: boolean;
}

/**
 * Toolbar-side countdown ticker: ticks once per second, freezes while the page
 * is hidden or the grid is a background tab, and triggers `autoRefreshTick` at 0.
 */
export function useDataGridToolbarAutoRefreshTicker({
  autoRefreshMs = 0,
  onAutoRefreshMsChange,
  autoRefreshTick,
  autoRefreshPaused = false,
  autoRefreshBusy = false,
}: UseDataGridToolbarAutoRefreshTickerParams): boolean {
  const canAutoRefresh = Boolean(onAutoRefreshMsChange && autoRefreshTick);

  const autoRefreshTickRef = useRef(autoRefreshTick);
  const autoRefreshPausedRef = useRef(autoRefreshPaused);
  const autoRefreshBusyRef = useRef(autoRefreshBusy);
  useEffect(() => {
    autoRefreshTickRef.current = autoRefreshTick;
    autoRefreshPausedRef.current = autoRefreshPaused;
    autoRefreshBusyRef.current = autoRefreshBusy;
  });

  useEffect(() => {
    if (!canAutoRefresh || autoRefreshMs <= 0) {
      return;
    }
    let nextRefreshAt = Date.now() + autoRefreshMs;
    const intervalId = window.setInterval(() => {
      // Hidden page or background tab: push the deadline out instead of
      // burning the countdown, so refresh resumes where it left off.
      if (document.hidden || autoRefreshPausedRef.current) {
        nextRefreshAt += 1000;
        return;
      }
      const remaining = nextRefreshAt - Date.now();
      if (remaining > 0) {
        return;
      }
      nextRefreshAt = Date.now() + autoRefreshMs;
      if (!autoRefreshBusyRef.current) autoRefreshTickRef.current?.();
    }, 1000);
    return () => window.clearInterval(intervalId);
  }, [autoRefreshMs, canAutoRefresh]);

  return canAutoRefresh;
}

export interface UseDataGridAutoRefreshControllerParams {
  tableName?: string;
  externalResult?: QueryResult;
  connectionId: string;
  refreshTableFromStart: () => Promise<boolean>;
  isMountedRef: { current: boolean };
  setData: Dispatch<SetStateAction<QueryResult | null>>;
  setTotalRows: Dispatch<SetStateAction<number>>;
  dataGridStore: DataGridStoreApi;
  stagedChangeCount: number;
}

/**
 * Grid-side auto-refresh controller: gates auto-refresh to read-only tables/queries,
 * executes ticks, and automatically stops auto-refresh when the grid enters edit mode.
 */
export function useDataGridAutoRefreshController({
  tableName,
  externalResult,
  connectionId,
  refreshTableFromStart,
  isMountedRef,
  setData,
  setTotalRows,
  dataGridStore,
  stagedChangeCount,
}: UseDataGridAutoRefreshControllerParams) {
  const [autoRefreshMs, setAutoRefreshMs] = useState(0);
  const autoRefreshInFlightRef = useRef(false);

  /** Auto-refresh only re-runs read-only statements — a mutating query would
   *  otherwise trip the Safe Mode confirm dialog on every tick. */
  const canAutoRefresh =
    Boolean(tableName && !externalResult) ||
    Boolean(
      externalResult?.query &&
      /^(select|with|show|explain|describe|desc|table|values)\b/i.test(
        externalResult.query.trim(),
      ) &&
      !isMutatingStatement(externalResult.query),
    );

  const handleAutoRefreshTick = useCallback(async () => {
    if (autoRefreshInFlightRef.current || !isMountedRef.current) return;
    autoRefreshInFlightRef.current = true;
    try {
      if (externalResult) {
        const sql = externalResult.query?.trim();
        if (!sql) return;
        const result = await invokeMutation<QueryResult>("execute_query", {
          connectionId,
          sql,
          requestId: crypto.randomUUID(),
          safeModeApprovedByUser: false,
        });
        if (result && isMountedRef.current) {
          setData(result);
          setTotalRows(result.rows.length);
        }
      } else {
        await refreshTableFromStart();
      }
    } catch (error) {
      devLogError("Auto-refresh failed", error);
    } finally {
      autoRefreshInFlightRef.current = false;
    }
  }, [connectionId, externalResult, isMountedRef, refreshTableFromStart, setData, setTotalRows]);

  const isEditingAnyCell = useStore(
    dataGridStore,
    (state) => autoRefreshMs > 0 && state.editingCell !== null,
  );

  // Stop auto-refresh the moment the grid enters edit mode: a silent refetch
  // would clobber an in-progress cell edit or staged changes.
  useEffect(() => {
    if (isEditingAnyCell || (autoRefreshMs > 0 && stagedChangeCount > 0)) {
      setAutoRefreshMs(0);
      emitAppToast({
        title: getDataGridChartCopy(getCurrentAppLanguage()).autoRefresh.stoppedForEdit,
        tone: "info",
      });
    }
  }, [autoRefreshMs, isEditingAnyCell, stagedChangeCount]);

  return {
    autoRefreshMs,
    setAutoRefreshMs,
    canAutoRefresh,
    handleAutoRefreshTick,
  };
}
