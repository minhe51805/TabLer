import { useCallback, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";

import { useUIStore } from "../stores/uiStore";
import type { Tab } from "../types";
import {
  loadTabState,
  restoreTabSnapshot,
  saveTabState,
} from "../utils/tab-persistence";

export function useTabPersistence(
  activeConnectionId: string | null,
  connectedIds: ReadonlySet<string>,
): void {
  const { tabs, activeTabId } = useUIStore(
    useShallow((state) => ({ tabs: state.tabs, activeTabId: state.activeTabId })),
  );

  const persistTabs = useCallback(
    (connectionId: string, tabsToPersist: Tab[], nextActiveTabId: string | null) => {
      void saveTabState(connectionId, tabsToPersist, nextActiveTabId);
    },
    [],
  );

  useEffect(() => {
    if (!activeConnectionId || !connectedIds.has(activeConnectionId)) return;

    let cancelled = false;
    const restoreTabs = async () => {
      const persistedTabs = await loadTabState(activeConnectionId);
      if (cancelled || persistedTabs.length === 0) return;

      const activePersistedTab = persistedTabs.find((tab) => tab.isActive);
      for (const persistedTab of persistedTabs) {
        const uiStore = useUIStore.getState();
        if (uiStore.tabs.some((tab) => tab.id === persistedTab.tabId)) continue;

        const restoredTab = restoreTabSnapshot(persistedTab, activeConnectionId);
        if (restoredTab) uiStore.addTab(restoredTab);
      }

      if (activePersistedTab) {
        const uiStore = useUIStore.getState();
        if (uiStore.tabs.some((tab) => tab.id === activePersistedTab.tabId)) {
          uiStore.setActiveTab(activePersistedTab.tabId);
        }
      }
    };

    void restoreTabs();
    return () => {
      cancelled = true;
    };
  }, [activeConnectionId, connectedIds]);

  useEffect(() => {
    if (!activeConnectionId || !connectedIds.has(activeConnectionId)) return;
    persistTabs(activeConnectionId, tabs, activeTabId);
  }, [activeConnectionId, activeTabId, connectedIds, persistTabs, tabs]);

  useEffect(() => {
    const handleBeforeUnload = () => {
      if (!activeConnectionId || !connectedIds.has(activeConnectionId)) return;
      const uiState = useUIStore.getState();
      persistTabs(activeConnectionId, uiState.tabs, uiState.activeTabId);
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [activeConnectionId, connectedIds, persistTabs]);
}
