import { create } from "zustand";
import type { Tab } from "../types";

export type TabPane = "primary" | "secondary";

export interface UIState {
  tabs: Tab[];
  activeTabId: string | null;
  /**
   * Selected tab per split pane. `primaryActiveTabId` mirrors `activeTabId`
   * while no split is open; `secondaryActiveTabId` is null unless the right
   * pane holds at least one tab. `activeTabId` remains the globally focused
   * tab (whichever pane it lives in).
   */
  primaryActiveTabId: string | null;
  secondaryActiveTabId: string | null;
  error: string | null;

  addTab: (tab: Tab) => void;
  removeTab: (tabId: string) => void;
  clearTabs: () => void;
  setActiveTab: (tabId: string) => void;
  updateTab: (tabId: string, updates: Partial<Tab>) => void;
  pinTab: (tabId: string) => void;
  moveTab: (tabId: string, targetId: string) => void;
  /**
   * Creates an independent copy of a tab in the same pane: new id, same type
   * and content (query SQL, table/structure target, connection). Workspace
   * entity bindings are dropped so the copy never overwrites the saved entity
   * the source tab is bound to.
   */
  duplicateTab: (tabId: string) => void;
  /**
   * Moves a tab into another pane (or reorders it before `targetId` inside
   * `pane`). `targetId` omitted appends at the end of the destination strip.
   */
  moveTabToPane: (tabId: string, pane: TabPane, targetId?: string) => void;
  /** Closes every tab in a pane; closing the secondary pane ends the split. */
  removeTabsForPane: (pane: TabPane) => void;
  removeTabsForConnection: (connectionId: string) => void;
  removeTabsForStaleCatalog: (connectionId: string, database: string) => void;
  setError: (error: string | null) => void;
  clearError: () => void;
}

const paneOf = (tab: Tab | undefined): TabPane => tab?.pane ?? "primary";

/** Tabs rendered in a pane's strip: metrics tabs are sidebar-driven and never
 *  appear in either strip. */
const stripTabs = (tabs: Tab[], pane: TabPane) =>
  tabs.filter((tab) => tab.type !== "metrics" && paneOf(tab) === pane);

/** Recomputes per-pane selections after a tab set change: keep the current
 *  selection when it still lives in the pane, else fall back to the pane's
 *  last tab (matching the pre-split "activate last tab" behavior). */
const reconcilePaneActives = (state: UIState, tabs: Tab[]) => {
  const pick = (pane: TabPane, current: string | null) => {
    const paneTabs = stripTabs(tabs, pane);
    if (current && paneTabs.some((tab) => tab.id === current)) return current;
    return paneTabs[paneTabs.length - 1]?.id ?? null;
  };
  return {
    primaryActiveTabId: pick("primary", state.primaryActiveTabId),
    secondaryActiveTabId: pick("secondary", state.secondaryActiveTabId),
  };
};

/** Focus patch: marks `tabId` active globally and inside its own pane. */
const focusPatch = (tabs: Tab[], tabId: string) => {
  const tab = tabs.find((candidate) => candidate.id === tabId);
  if (!tab) return {};
  return paneOf(tab) === "secondary"
    ? { activeTabId: tabId, secondaryActiveTabId: tabId }
    : { activeTabId: tabId, primaryActiveTabId: tabId };
};

/** Removes `tabId` and re-inserts it before `targetId` (or at the end when
 *  omitted) with the given pane. Returns the new array or null when the move
 *  is a no-op. */
const relocateTab = (
  tabs: Tab[],
  tabId: string,
  pane: TabPane,
  targetId?: string,
): Tab[] | null => {
  const from = tabs.findIndex((tab) => tab.id === tabId);
  if (from === -1) return null;
  const next = [...tabs];
  const [moved] = next.splice(from, 1);
  const movedTab: Tab = { ...moved, pane };
  if (targetId) {
    const to = next.findIndex((tab) => tab.id === targetId);
    if (to === -1) return null;
    next.splice(to, 0, movedTab);
  } else {
    next.push(movedTab);
  }
  return next;
};

const invalidateTableTabCache = (tab: Tab) => {
  if (tab.type !== "table") return;
  import("../components/DataGrid/hooks/useDataGrid")
    .then((module) => {
      module.invalidateTableScopeCaches(tab.connectionId, tab.database, tab.tableName);
    })
    .catch((error) => console.error("Cache eviction error:", error));
};

export const useUIStore = create<UIState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  primaryActiveTabId: null,
  secondaryActiveTabId: null,
  error: null,

  addTab: (tab: Tab) => {
    const tabs = get().tabs;
    const exists = tabs.find((t) => t.id === tab.id);
    if (exists) {
      set(focusPatch(tabs, tab.id));
      return;
    }

    if (tab.isPreview) {
      const previewTabIndex = tabs.findIndex((existingTab) => existingTab.isPreview);
      if (previewTabIndex >= 0) {
        const nextTabs = [...tabs];
        // The replacement inherits the replaced preview's pane so a preview
        // opened in the split pane stays there.
        nextTabs[previewTabIndex] = {
          ...tab,
          pane: tab.pane ?? paneOf(nextTabs[previewTabIndex]),
        };
        set({ tabs: nextTabs, ...focusPatch(nextTabs, tab.id) });
        return;
      }
    }

    const nextTabs = [...tabs, tab];
    set({ tabs: nextTabs, ...focusPatch(nextTabs, tab.id) });
  },

  removeTab: (tabId: string) => {
    const currentTabs = get().tabs;
    const tabToRemove = currentTabs.find((tab) => tab.id === tabId);
    if (tabToRemove) invalidateTableTabCache(tabToRemove);

    const tabs = currentTabs.filter((t) => t.id !== tabId);
    const paneActives = reconcilePaneActives(get(), tabs);
    const removedPane = paneOf(tabToRemove);
    const samePaneReplacement =
      removedPane === "secondary"
        ? paneActives.secondaryActiveTabId
        : paneActives.primaryActiveTabId;
    const activeTabId =
      get().activeTabId === tabId
        ? (samePaneReplacement ??
          paneActives.primaryActiveTabId ??
          paneActives.secondaryActiveTabId)
        : get().activeTabId;
    set({ tabs, ...paneActives, activeTabId });
  },

  clearTabs: () => {
    import("../components/DataGrid/hooks/useDataGrid")
      .then((module) => module.clearAllTableCaches())
      .catch((error) => console.error("Cache eviction error:", error));

    set((state) => ({
      tabs: state.tabs.filter((tab) => tab.type === "metrics"),
      activeTabId: null,
      primaryActiveTabId: null,
      secondaryActiveTabId: null,
    }));
  },

  setActiveTab: (tabId: string) => {
    const tabs = get().tabs;
    const patch = focusPatch(tabs, tabId);
    // Unknown ids still update the global pointer (legacy lenient behavior)
    // but never corrupt the per-pane selections.
    set("activeTabId" in patch ? patch : { activeTabId: tabId });
  },

  updateTab: (tabId: string, updates: Partial<Tab>) => {
    const tabs = get().tabs.map((t) => (t.id === tabId ? { ...t, ...updates } : t));
    set({ tabs });
  },

  pinTab: (tabId: string) => {
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.id === tabId ? { ...tab, isPreview: false } : tab)),
    }));
  },

  moveTab: (tabId: string, targetId: string) => {
    if (tabId === targetId) return;
    set((state) => {
      const target = state.tabs.find((tab) => tab.id === targetId);
      if (!target) return {};
      const next = relocateTab(state.tabs, tabId, paneOf(target), targetId);
      if (!next) return {};
      // Reorder only: keep the current focus, just re-derive pane selections
      // in case the drag crossed panes.
      return { tabs: next, ...reconcilePaneActives(state, next) };
    });
  },

  duplicateTab: (tabId: string) => {
    const state = get();
    const source = state.tabs.find((tab) => tab.id === tabId);
    if (!source) return;
    const {
      id: _sourceId,
      workspaceEntityId: _entityId,
      workspaceEntityRevision: _entityRevision,
      workspaceEntityUpdatedAt: _entityUpdatedAt,
      ...rest
    } = source;
    const copy: Tab = {
      ...rest,
      id: `${source.type}-${crypto.randomUUID()}`,
      title: `${source.title} (Copy)`,
      // A duplicate is a real tab, not a preview: it must not be replaced by
      // the next preview open.
      isPreview: false,
    };
    const next = [...state.tabs];
    const sourceIndex = next.findIndex((tab) => tab.id === tabId);
    next.splice(sourceIndex + 1, 0, copy);
    set({ tabs: next, ...focusPatch(next, copy.id) });
  },

  moveTabToPane: (tabId: string, pane: TabPane, targetId?: string) => {
    set((state) => {
      const source = state.tabs.find((tab) => tab.id === tabId);
      if (!source || source.type === "metrics") return {};
      const next = relocateTab(state.tabs, tabId, pane, targetId);
      if (!next) return {};
      return {
        tabs: next,
        ...reconcilePaneActives(state, next),
        ...focusPatch(next, tabId),
      };
    });
  },

  removeTabsForPane: (pane: TabPane) => {
    const state = get();
    const removedTabs = state.tabs.filter((tab) => paneOf(tab) === pane && tab.type !== "metrics");
    if (removedTabs.length === 0) return;
    for (const tab of removedTabs) invalidateTableTabCache(tab);

    const removedIds = new Set(removedTabs.map((tab) => tab.id));
    const tabs = state.tabs.filter((tab) => !removedIds.has(tab.id));
    const paneActives = reconcilePaneActives(state, tabs);
    const activeTabId = removedIds.has(state.activeTabId ?? "")
      ? (paneActives.primaryActiveTabId ?? paneActives.secondaryActiveTabId)
      : state.activeTabId;
    set({ tabs, ...paneActives, activeTabId });
  },

  removeTabsForConnection: (connectionId: string) => {
    const state = get();
    const removedTabs = state.tabs.filter((tab) => tab.connectionId === connectionId);
    const tabs = state.tabs.filter((tab) => tab.connectionId !== connectionId);
    const activeTabWasRemoved = removedTabs.some((tab) => tab.id === state.activeTabId);

    for (const tab of removedTabs) invalidateTableTabCache(tab);

    const paneActives = reconcilePaneActives(state, tabs);
    set({
      tabs,
      ...paneActives,
      activeTabId: activeTabWasRemoved
        ? (paneActives.primaryActiveTabId ?? paneActives.secondaryActiveTabId)
        : state.activeTabId,
    });
  },

  removeTabsForStaleCatalog: (connectionId, database) => {
    const state = get();
    const catalogBound = new Set(["table", "structure", "er-diagram"]);
    const removedTabs = state.tabs.filter(
      (tab) =>
        tab.connectionId === connectionId &&
        catalogBound.has(tab.type) &&
        (tab.database || "") !== (database || ""),
    );
    if (removedTabs.length === 0) return;

    const removedIds = new Set(removedTabs.map((tab) => tab.id));
    const tabs = state.tabs.filter((tab) => !removedIds.has(tab.id));
    const activeTabWasRemoved = removedIds.has(state.activeTabId ?? "");

    for (const tab of removedTabs) invalidateTableTabCache(tab);

    const paneActives = reconcilePaneActives(state, tabs);
    set({
      tabs,
      ...paneActives,
      activeTabId: activeTabWasRemoved
        ? (paneActives.primaryActiveTabId ?? paneActives.secondaryActiveTabId)
        : state.activeTabId,
    });
  },

  setError: (error: string | null) => set({ error }),
  clearError: () => set({ error: null }),
}));
