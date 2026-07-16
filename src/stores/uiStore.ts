import { create } from "zustand";
import type { Tab } from "../types";

export interface UIState {
  tabs: Tab[];
  activeTabId: string | null;
  error: string | null;

  addTab: (tab: Tab) => void;
  removeTab: (tabId: string) => void;
  clearTabs: () => void;
  setActiveTab: (tabId: string) => void;
  updateTab: (tabId: string, updates: Partial<Tab>) => void;
  pinTab: (tabId: string) => void;
  removeTabsForConnection: (connectionId: string) => void;
  setError: (error: string | null) => void;
  clearError: () => void;
}

export const useUIStore = create<UIState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  error: null,

  addTab: (tab: Tab) => {
    const tabs = get().tabs;
    const exists = tabs.find((t) => t.id === tab.id);
    if (exists) {
      set({ activeTabId: tab.id });
      return;
    }

    if (tab.isPreview) {
      const previewTabIndex = tabs.findIndex((existingTab) => existingTab.isPreview);
      if (previewTabIndex >= 0) {
        const nextTabs = [...tabs];
        nextTabs[previewTabIndex] = tab;
        set({ tabs: nextTabs, activeTabId: tab.id });
        return;
      }
    }

    set({ tabs: [...tabs, tab], activeTabId: tab.id });
  },

  removeTab: (tabId: string) => {
    const currentTabs = get().tabs;
    const tabToRemove = currentTabs.find((tab) => tab.id === tabId);
    if (tabToRemove?.type === "table") {
      import("../components/DataGrid/hooks/useDataGrid")
        .then((module) => {
          module.invalidateTableScopeCaches(
            tabToRemove.connectionId,
            tabToRemove.database,
            tabToRemove.tableName,
          );
        })
        .catch((error) => console.error("Cache eviction error:", error));
    }

    const tabs = currentTabs.filter((t) => t.id !== tabId);
    const visibleTabs = tabs.filter((tab) => tab.type !== "metrics");
    const activeTabId =
      get().activeTabId === tabId
        ? visibleTabs.length > 0
          ? visibleTabs[visibleTabs.length - 1].id
          : null
        : get().activeTabId;
    set({ tabs, activeTabId });
  },

  clearTabs: () => {
    import("../components/DataGrid/hooks/useDataGrid")
      .then((module) => module.clearAllTableCaches())
      .catch((error) => console.error("Cache eviction error:", error));

    set((state) => ({
      tabs: state.tabs.filter((tab) => tab.type === "metrics"),
      activeTabId: null,
    }));
  },

  setActiveTab: (tabId: string) => set({ activeTabId: tabId }),

  updateTab: (tabId: string, updates: Partial<Tab>) => {
    const tabs = get().tabs.map((t) => (t.id === tabId ? { ...t, ...updates } : t));
    set({ tabs });
  },

  pinTab: (tabId: string) => {
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === tabId ? { ...tab, isPreview: false } : tab,
      ),
    }));
  },

  removeTabsForConnection: (connectionId: string) => {
    const state = get();
    const removedTabs = state.tabs.filter((tab) => tab.connectionId === connectionId);
    const tabs = state.tabs.filter((tab) => tab.connectionId !== connectionId);
    const visibleTabs = tabs.filter((tab) => tab.type !== "metrics");
    const activeTabWasRemoved = removedTabs.some((tab) => tab.id === state.activeTabId);

    for (const tab of removedTabs) {
      if (tab.type !== "table") continue;
      import("../components/DataGrid/hooks/useDataGrid")
        .then((module) => {
          module.invalidateTableScopeCaches(tab.connectionId, tab.database, tab.tableName);
        })
        .catch((error) => console.error("Cache eviction error:", error));
    }

    set({
      tabs,
      activeTabId: activeTabWasRemoved
        ? visibleTabs[visibleTabs.length - 1]?.id ?? null
        : state.activeTabId,
    });
  },

  setError: (error: string | null) => set({ error }),
  clearError: () => set({ error: null }),
}));
