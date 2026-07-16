import { useCallback, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import type { QueryEditorSessionState } from "../components/SQLEditor";
import { useConnectionStore } from "../stores/connectionStore";
import { useUIStore } from "../stores/uiStore";
import type { QueryChromeState } from "../types/app-types";
import type { OpenAIWorkspaceQueryDetail } from "./useWorkspaceEventBridge";

export function pruneTabState<T>(state: Record<string, T>, activeIds: Set<string>): Record<string, T> {
  const entries = Object.entries(state).filter(([tabId]) => activeIds.has(tabId));
  return entries.length === Object.keys(state).length ? state : Object.fromEntries(entries);
}

export function areQueryChromeStatesEqual(
  current: QueryChromeState | undefined,
  next: QueryChromeState,
): boolean {
  return (
    current?.isRunning === next.isRunning &&
    current?.executionTimeMs === next.executionTimeMs &&
    current?.rowCount === next.rowCount &&
    current?.affectedRows === next.affectedRows &&
    current?.queryCount === next.queryCount
  );
}

function areQuerySessionsEqual(
  current: QueryEditorSessionState | undefined,
  next: QueryEditorSessionState,
): boolean {
  return (
    current?.result === next.result &&
    current?.error === next.error &&
    current?.notice === next.notice &&
    current?.queryCount === next.queryCount &&
    current?.editorHeight === next.editorHeight &&
    current?.showResultsPane === next.showResultsPane &&
    current?.resultViewMode === next.resultViewMode &&
    current?.explainPlan === next.explainPlan
  );
}

export function useQueryWorkspaceState() {
  const [queryChromeByTab, setQueryChromeByTab] = useState<Record<string, QueryChromeState>>({});
  const [querySessionByTab, setQuerySessionByTab] = useState<
    Record<string, QueryEditorSessionState>
  >({});
  const [queryRunRequestByTab, setQueryRunRequestByTab] = useState<Record<string, number>>({});
  const { tabs, activeTabId, addTab } = useUIStore(
    useShallow((state) => ({
      tabs: state.tabs,
      activeTabId: state.activeTabId,
      addTab: state.addTab,
    })),
  );
  const { activeConnectionId, currentDatabase } = useConnectionStore(
    useShallow((state) => ({
      activeConnectionId: state.activeConnectionId,
      currentDatabase: state.currentDatabase,
    })),
  );
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;

  const requestQueryRun = useCallback((tabId: string) => {
    setQueryRunRequestByTab((current) => ({
      ...current,
      [tabId]: (current[tabId] ?? 0) + 1,
    }));
  }, []);

  const runActiveQuery = useCallback(() => {
    if (activeTab?.type === "query") requestQueryRun(activeTab.id);
  }, [activeTab, requestQueryRun]);

  const handleQueryChromeChange = useCallback((tabId: string, next: QueryChromeState) => {
    setQueryChromeByTab((current) =>
      areQueryChromeStatesEqual(current[tabId], next)
        ? current
        : { ...current, [tabId]: next },
    );
  }, []);

  const handleQuerySessionChange = useCallback(
    (tabId: string, next: QueryEditorSessionState) => {
      setQuerySessionByTab((current) =>
        areQuerySessionsEqual(current[tabId], next)
          ? current
          : { ...current, [tabId]: next },
      );
    },
    [],
  );

  const openAIWorkspaceQuery = useCallback(
    (detail: OpenAIWorkspaceQueryDetail) => {
      const sql = detail.sql?.trim();
      const targetConnectionId = detail.connectionId || activeConnectionId;
      if (!sql || !targetConnectionId) return;

      const resultViewMode = detail.resultViewMode ?? "table";
      const tabId = `query-${crypto.randomUUID()}`;
      addTab({
        id: tabId,
        type: "query",
        title: detail.title?.trim() || (resultViewMode === "chart" ? "AI Chart" : "AI Query"),
        connectionId: targetConnectionId,
        database: detail.database || currentDatabase || undefined,
        content: sql,
      });
      setQuerySessionByTab((current) => ({
        ...current,
        [tabId]: {
          result: null,
          error: null,
          notice: null,
          queryCount: 0,
          editorHeight: 42,
          showResultsPane: resultViewMode === "chart" || Boolean(detail.autoRun),
          resultViewMode,
        },
      }));
      if (detail.autoRun) requestQueryRun(tabId);
    },
    [activeConnectionId, addTab, currentDatabase, requestQueryRun],
  );

  useEffect(() => {
    const activeQueryIds = new Set(
      tabs.filter((tab) => tab.type === "query").map((tab) => tab.id),
    );
    setQueryChromeByTab((current) => pruneTabState(current, activeQueryIds));
    setQuerySessionByTab((current) => pruneTabState(current, activeQueryIds));
    setQueryRunRequestByTab((current) => pruneTabState(current, activeQueryIds));
  }, [tabs]);

  const activeQueryChrome = useMemo(
    () =>
      activeTab?.type === "query"
        ? queryChromeByTab[activeTab.id] ?? { isRunning: false }
        : null,
    [activeTab, queryChromeByTab],
  );

  return {
    activeQueryChrome,
    querySessionByTab,
    queryRunRequestByTab,
    requestQueryRun,
    runActiveQuery,
    handleQueryChromeChange,
    handleQuerySessionChange,
    openAIWorkspaceQuery,
  };
}
