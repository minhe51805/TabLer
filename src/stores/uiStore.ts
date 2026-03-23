import { create } from "zustand";
import type { Tab } from "../types";

interface UIState {
  tabs: Tab[];
  activeTabId: string | null;
  error: string | null;

  addTab: (tab: Tab) => void;
  removeTab: (tabId: string) => void;
  clearTabs: () => void;
  setActiveTab: (tabId: string) => void;
  updateTab: (tabId: string, updates: Partial<Tab>) => void;
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
    if (exists) set({ activeTabId: tab.id });
    else set({ tabs: [...tabs, tab], activeTabId: tab.id });
  },

  removeTab: (tabId: string) => {
    const tabs = get().tabs.filter((t) => t.id !== tabId);
    const visibleTabs = tabs.filter((tab) => tab.type !== "metrics");
    const activeTabId =
      get().activeTabId === tabId
        ? visibleTabs.length > 0
          ? visibleTabs[visibleTabs.length - 1].id
          : null
        : get().activeTabId;
    set({ tabs, activeTabId });
  },

  clearTabs: () =>
    set((state) => ({
      tabs: state.tabs.filter((tab) => tab.type === "metrics"),
      activeTabId: null,
    })),

  setActiveTab: (tabId: string) => set({ activeTabId: tabId }),

  updateTab: (tabId: string, updates: Partial<Tab>) => {
    const tabs = get().tabs.map((t) => (t.id === tabId ? { ...t, ...updates } : t));
    set({ tabs });
  },

  setError: (error: string | null) => set({ error }),
  clearError: () => set({ error: null }),
}));
