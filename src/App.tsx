import {
  useState,
  useEffect,
  useRef,
  useCallback,
  lazy,
  Suspense,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  AlertCircle,
  BarChart3,
  Cable,
  ChevronRight,
  Copy,
  Database,
  FolderTree,
  Menu,
  Minus,
  PanelRightClose,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  Square,
  Sparkles,
  X,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "./stores/appStore";
import { useI18n, type AppLanguagePreference } from "./i18n";
import { ConnectionList } from "./components/ConnectionList";
import { MetricsSidebar } from "./components/MetricsSidebar/MetricsSidebar";
import { Sidebar } from "./components/Sidebar";
import { StartupConnectionManager } from "./components/StartupConnectionManager";
import { TabBar } from "./components/TabBar";
import type { QueryEditorSessionState } from "./components/SQLEditor";
import type { Tab } from "./types";
import "./index.css";

interface QueryChromeState {
  isRunning: boolean;
  executionTimeMs?: number;
  rowCount?: number;
  affectedRows?: number;
  queryCount?: number;
}

interface WorkspaceActivityState {
  label: string;
  durationMs: number;
  at: number;
}

type WindowMenuSectionKey =
  | "file"
  | "edit"
  | "view"
  | "tools"
  | "connection"
  | "plugins"
  | "navigate"
  | "language"
  | "help";

interface WindowMenuItem {
  key?: string;
  label?: string;
  action?: () => void;
  disabled?: boolean;
  divider?: boolean;
  selected?: boolean;
  shortcut?: string;
  children?: WindowMenuItem[];
}

const GLOBAL_ERROR_AUTO_DISMISS_MS = 8000;
const UI_FONT_SCALE_STORAGE_KEY = "tabler.uiFontScale";
const SQLEditor = lazy(() => import("./components/SQLEditor").then((module) => ({ default: module.SQLEditor })));
const DataGrid = lazy(() => import("./components/DataGrid").then((module) => ({ default: module.DataGrid })));
const TableStructure = lazy(() => import("./components/TableStructure").then((module) => ({ default: module.TableStructure })));
const MetricsBoard = lazy(() => import("./components/MetricsBoard").then((module) => ({ default: module.MetricsBoard })));
const ConnectionForm = lazy(() => import("./components/ConnectionForm").then((module) => ({ default: module.ConnectionForm })));
const AISettingsModal = lazy(() => import("./components/AISettingsModal").then((module) => ({ default: module.AISettingsModal })));
const AISlidePanel = lazy(() => import("./components/AISlidePanel/AISlidePanel").then((module) => ({ default: module.AISlidePanel })));

function LazyPanelFallback() {
  return (
    <div className="flex items-center justify-center h-full min-h-[220px] text-sm text-[var(--text-muted)]">
      Loading workspace...
    </div>
  );
}

function getLastPathSegment(value?: string | null) {
  if (!value) return "";
  const normalized = value.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] || value;
}

function App() {
  const { language, languagePreference, setLanguage, t } = useI18n();
  const {
    activeConnectionId,
    connectedIds,
    connections,
    tabs,
    activeTabId,
    currentDatabase,
    error,
    clearError,
    loadSavedConnections,
    addTab,
    setActiveTab,
    fetchDatabases,
    fetchTables,
    fetchSchemaObjects,
  } = useAppStore(
    useShallow((state) => ({
      activeConnectionId: state.activeConnectionId,
      connectedIds: state.connectedIds,
      connections: state.connections,
      tabs: state.tabs,
      activeTabId: state.activeTabId,
      currentDatabase: state.currentDatabase,
      error: state.error,
      clearError: state.clearError,
      loadSavedConnections: state.loadSavedConnections,
      addTab: state.addTab,
      setActiveTab: state.setActiveTab,
      fetchDatabases: state.fetchDatabases,
      fetchTables: state.fetchTables,
      fetchSchemaObjects: state.fetchSchemaObjects,
    }))
  );

  const [connectionFormIntent, setConnectionFormIntent] = useState<"connect" | "bootstrap" | null>(null);
  const [showStartupConnectionManager, setShowStartupConnectionManager] = useState(true);
  const [showAISettings, setShowAISettings] = useState(false);
  const [showAboutModal, setShowAboutModal] = useState(false);
  const [showKeyboardShortcutsModal, setShowKeyboardShortcutsModal] = useState(false);
  const [showAISlidePanel, setShowAISlidePanel] = useState(false);
  const [aiPanelDraft, setAiPanelDraft] = useState<{ prompt: string; nonce: number } | null>(null);
  const [leftPanel, setLeftPanel] = useState<"connections" | "database" | "metrics">("connections");
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(340);
  const [isWindowMaximized, setIsWindowMaximized] = useState(false);
  const [isWindowFocused, setIsWindowFocused] = useState(true);
  const [queryChromeByTab, setQueryChromeByTab] = useState<Record<string, QueryChromeState>>({});
  const [querySessionByTab, setQuerySessionByTab] = useState<Record<string, QueryEditorSessionState>>({});
  const [queryRunRequestByTab, setQueryRunRequestByTab] = useState<Record<string, number>>({});
  const [workspaceActivityByConnection, setWorkspaceActivityByConnection] = useState<
    Record<string, WorkspaceActivityState>
  >({});
  const [isWindowMenuOpen, setIsWindowMenuOpen] = useState(false);
  const [activeWindowMenuSection, setActiveWindowMenuSection] =
    useState<WindowMenuSectionKey | null>(null);
  const [activeWindowMenuItemPath, setActiveWindowMenuItemPath] = useState<string | null>(null);
  const [uiFontScale, setUiFontScale] = useState(() => {
    if (typeof window === "undefined") return 100;
    const stored = Number(window.localStorage.getItem(UI_FONT_SCALE_STORAGE_KEY));
    return Number.isFinite(stored) && stored >= 85 && stored <= 135 ? stored : 100;
  });

  const isResizing = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(300);
  const windowMenuRef = useRef<HTMLDivElement | null>(null);
  const windowSyncGenerationRef = useRef(0);
  const isDesktopWindow = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  const activeConn = connections.find((conn) => conn.id === activeConnectionId);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) || null;
  const isConnected = !!(activeConnectionId && connectedIds.has(activeConnectionId));
  const showStartupShell = !isConnected && (showStartupConnectionManager || !!connectionFormIntent);
  const isMetricsWorkspace = activeTab?.type === "metrics";
  const visibleTabs = tabs.filter((tab) => tab.type !== "metrics");
  const activeQueryChrome =
    activeTab?.type === "query" ? queryChromeByTab[activeTab.id] ?? { isRunning: false } : null;
  const activeWorkspaceActivity =
    activeConnectionId ? workspaceActivityByConnection[activeConnectionId] ?? null : null;
  const queryTabCount = tabs.filter(
    (tab) => tab.type === "query" && tab.connectionId === activeConnectionId,
  ).length;
  const activeDatabaseLabel =
    activeConn?.db_type === "sqlite" ? getLastPathSegment(currentDatabase) : currentDatabase || "";
  const titlebarContextTitle = `${activeConn?.name || activeConn?.host || ""}${
    currentDatabase ? ` / ${currentDatabase}` : ""
  }`;
  const titlebarContextLabel = `${activeConn?.name || activeConn?.host || ""}${
    activeDatabaseLabel ? ` / ${activeDatabaseLabel}` : ""
  }`;
  const sidebarMinWidth = leftPanel === "connections" ? 300 : 348;

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  useEffect(() => {
    document.documentElement.style.fontSize = `${uiFontScale}%`;
    if (typeof window !== "undefined") {
      window.localStorage.setItem(UI_FONT_SCALE_STORAGE_KEY, String(uiFontScale));
    }
  }, [uiFontScale]);

  useEffect(() => {
    if (!error) return;

    const timeoutId = window.setTimeout(() => {
      clearError();
    }, GLOBAL_ERROR_AUTO_DISMISS_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [clearError, error]);

  useEffect(() => {
    if (!isWindowMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && windowMenuRef.current?.contains(target)) {
        return;
      }

      setIsWindowMenuOpen(false);
      setActiveWindowMenuItemPath(null);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsWindowMenuOpen(false);
        setActiveWindowMenuItemPath(null);
      }
    };

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isWindowMenuOpen]);

  const handleMouseDown = useCallback(
    (e: ReactMouseEvent) => {
      if (isSidebarCollapsed) return;

      isResizing.current = true;
      startX.current = e.clientX;
      startWidth.current = sidebarWidth;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [isSidebarCollapsed, sidebarWidth],
  );

  const handleNewQuery = useCallback(() => {
    if (!activeConnectionId) return;

    const nextIndex = queryTabCount + 1;
    addTab({
      id: `query-${crypto.randomUUID()}`,
      type: "query",
      title: nextIndex === 1 ? "Query" : `Query ${nextIndex}`,
      connectionId: activeConnectionId,
      database: currentDatabase || undefined,
      content: "",
    });
  }, [activeConnectionId, addTab, currentDatabase, queryTabCount]);

  const handleOpenConnectionForm = useCallback(
    (intent: "connect" | "bootstrap") => {
      setShowStartupConnectionManager(false);
      setConnectionFormIntent(intent);
    },
    [],
  );

  const handleCloseConnectionForm = useCallback(() => {
    setConnectionFormIntent(null);
    if (!activeConnectionId || !connectedIds.has(activeConnectionId)) {
      setShowStartupConnectionManager(true);
    }
  }, [activeConnectionId, connectedIds]);

  const handleToggleWindowMenu = useCallback((event?: ReactMouseEvent<HTMLElement>) => {
    event?.stopPropagation();
    setIsWindowMenuOpen((current) => {
      const next = !current;
      if (next) {
        setActiveWindowMenuSection(null);
        setActiveWindowMenuItemPath(null);
      }
      return next;
    });
  }, []);

  const handleOpenConnectionsPanel = useCallback(() => {
    setIsSidebarCollapsed(false);
    setLeftPanel("connections");
    setIsWindowMenuOpen(false);
  }, []);

  const handleNewConnectionFromMenu = useCallback(() => {
    handleOpenConnectionForm("connect");
    setIsWindowMenuOpen(false);
  }, [handleOpenConnectionForm]);

  const handleRefreshWorkspace = useCallback(async () => {
    if (!activeConnectionId) return;

    await fetchDatabases(activeConnectionId);
    if (currentDatabase) {
      await Promise.all([
        fetchTables(activeConnectionId, currentDatabase),
        fetchSchemaObjects(activeConnectionId, currentDatabase),
      ]);
    }
  }, [activeConnectionId, currentDatabase, fetchDatabases, fetchSchemaObjects, fetchTables]);

  const handleFocusExplorerSearch = useCallback(() => {
    if (!isConnected) return;

    setIsSidebarCollapsed(false);
    setLeftPanel("database");
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent("focus-explorer-search"));
    }, 0);
  }, [isConnected]);

  const handleOpenMetricsBoard = useCallback(() => {
    if (!activeConnectionId) return;

    const existingMetricsTab = tabs.find(
      (tab) =>
        tab.type === "metrics" &&
        tab.connectionId === activeConnectionId &&
        (tab.database || "") === (currentDatabase || ""),
    );

    if (existingMetricsTab) {
      setLeftPanel("metrics");
      setActiveTab(existingMetricsTab.id);
      return;
    }

    setLeftPanel("metrics");
    addTab({
      id: `metrics-${crypto.randomUUID()}`,
      type: "metrics",
      title: "Metrics",
      connectionId: activeConnectionId,
      database: currentDatabase || undefined,
    });
  }, [activeConnectionId, addTab, currentDatabase, setActiveTab, tabs]);

  const handleOpenMetricsBoardFromMenu = useCallback(() => {
    setIsWindowMenuOpen(false);
    void handleOpenMetricsBoard();
  }, [handleOpenMetricsBoard]);

  const handleChangeLanguage = useCallback(
    (nextLanguage: AppLanguagePreference) => {
      setLanguage(nextLanguage);
      setIsWindowMenuOpen(false);
      setActiveWindowMenuItemPath(null);
    },
    [setLanguage],
  );

  const handleIncreaseFontSize = useCallback(() => {
    setUiFontScale((current) => Math.min(135, current + 5));
    setIsWindowMenuOpen(false);
    setActiveWindowMenuItemPath(null);
  }, []);

  const handleDecreaseFontSize = useCallback(() => {
    setUiFontScale((current) => Math.max(85, current - 5));
    setIsWindowMenuOpen(false);
    setActiveWindowMenuItemPath(null);
  }, []);

  const handleToggleRightSidebarFromMenu = useCallback(() => {
    setShowAISlidePanel((current) => !current);
    setIsWindowMenuOpen(false);
    setActiveWindowMenuItemPath(null);
  }, []);

  const handleToggleQueryResultsPaneFromMenu = useCallback(() => {
    if (activeTab?.type !== "query") {
      return;
    }

    window.dispatchEvent(
      new CustomEvent("toggle-query-results-pane", {
        detail: { tabId: activeTab.id },
      }),
    );
    setIsWindowMenuOpen(false);
    setActiveWindowMenuItemPath(null);
  }, [activeTab]);

  const handleShowDatabaseWorkspace = useCallback(() => {
    if (!isConnected) return;

    setIsSidebarCollapsed(false);
    setLeftPanel("database");

    const currentDatabaseKey = currentDatabase || "";
    const candidateTab =
      [...tabs]
        .reverse()
        .find(
          (tab) =>
            tab.type !== "metrics" &&
            tab.connectionId === activeConnectionId &&
            (tab.database || "") === currentDatabaseKey,
        ) ||
      [...tabs]
        .reverse()
        .find((tab) => tab.type !== "metrics" && tab.connectionId === activeConnectionId) ||
      [...tabs].reverse().find((tab) => tab.type !== "metrics");

    if (candidateTab) {
      setActiveTab(candidateTab.id);
      return;
    }

    handleNewQuery();
  }, [activeConnectionId, currentDatabase, handleNewQuery, isConnected, setActiveTab, tabs]);

  const handleShowDatabaseWorkspaceFromMenu = useCallback(() => {
    setIsWindowMenuOpen(false);
    handleShowDatabaseWorkspace();
  }, [handleShowDatabaseWorkspace]);

  const handleNewQueryFromMenu = useCallback(() => {
    setIsWindowMenuOpen(false);
    handleNewQuery();
  }, [handleNewQuery]);

  const handleOpenAISettingsFromMenu = useCallback(() => {
    setShowAISettings(true);
    setIsWindowMenuOpen(false);
  }, []);

  const handleOpenAboutModalFromMenu = useCallback(() => {
    setShowAboutModal(true);
    setIsWindowMenuOpen(false);
  }, []);

  const handleOpenKeyboardShortcutsFromMenu = useCallback(() => {
    setShowKeyboardShortcutsModal(true);
    setIsWindowMenuOpen(false);
  }, []);

  const handleRefreshWorkspaceFromMenu = useCallback(() => {
    void handleRefreshWorkspace();
    setIsWindowMenuOpen(false);
  }, [handleRefreshWorkspace]);

  const handleFocusExplorerSearchFromMenu = useCallback(() => {
    handleFocusExplorerSearch();
    setIsWindowMenuOpen(false);
  }, [handleFocusExplorerSearch]);

  const handleSearchInDatabaseFromMenu = useCallback(() => {
    handleShowDatabaseWorkspace();
    window.setTimeout(() => {
      handleFocusExplorerSearch();
    }, 0);
    setIsWindowMenuOpen(false);
  }, [handleFocusExplorerSearch, handleShowDatabaseWorkspace]);

  const handleRunActiveQuery = useCallback(() => {
    if (activeTab?.type !== "query") return;

    setQueryRunRequestByTab((prev) => ({
      ...prev,
      [activeTab.id]: (prev[activeTab.id] ?? 0) + 1,
    }));
  }, [activeTab]);

  const handleClearVisibleTabs = useCallback(() => {
    useAppStore.setState((state) => ({
      tabs: state.tabs.filter((tab) => tab.type === "metrics"),
      activeTabId: null,
    }));
  }, []);

  const handleQueryChromeChange = useCallback((tabId: string, state: QueryChromeState) => {
    setQueryChromeByTab((prev) => {
      const current = prev[tabId];
      if (
        current?.isRunning === state.isRunning &&
        current?.executionTimeMs === state.executionTimeMs &&
        current?.rowCount === state.rowCount &&
        current?.affectedRows === state.affectedRows &&
        current?.queryCount === state.queryCount
      ) {
        return prev;
      }

      return {
        ...prev,
        [tabId]: state,
      };
    });
  }, []);

  const handleQuerySessionChange = useCallback((tabId: string, state: QueryEditorSessionState) => {
    setQuerySessionByTab((prev) => {
      const current = prev[tabId];
      if (
        current?.result === state.result &&
        current?.error === state.error &&
        current?.queryCount === state.queryCount &&
        current?.editorHeight === state.editorHeight
      ) {
        return prev;
      }

      return {
        ...prev,
        [tabId]: state,
      };
    });
  }, []);

  useEffect(() => {
    setQueryChromeByTab((prev) => {
      const activeTabIds = new Set(tabs.filter((tab) => tab.type === "query").map((tab) => tab.id));
      const nextEntries = Object.entries(prev).filter(([tabId]) => activeTabIds.has(tabId));
      if (nextEntries.length === Object.keys(prev).length) {
        return prev;
      }
      return Object.fromEntries(nextEntries);
    });

    setQuerySessionByTab((prev) => {
      const activeTabIds = new Set(tabs.filter((tab) => tab.type === "query").map((tab) => tab.id));
      const nextEntries = Object.entries(prev).filter(([tabId]) => activeTabIds.has(tabId));
      if (nextEntries.length === Object.keys(prev).length) {
        return prev;
      }
      return Object.fromEntries(nextEntries);
    });

    setQueryRunRequestByTab((prev) => {
      const activeTabIds = new Set(tabs.filter((tab) => tab.type === "query").map((tab) => tab.id));
      const nextEntries = Object.entries(prev).filter(([tabId]) => activeTabIds.has(tabId));
      if (nextEntries.length === Object.keys(prev).length) {
        return prev;
      }
      return Object.fromEntries(nextEntries);
    });
  }, [tabs]);

  const handleOpenAISlidePanel = useCallback((prompt?: string) => {
    if (typeof prompt === "string" && prompt.trim()) {
      setAiPanelDraft({
        prompt,
        nonce: Date.now(),
      });
    }
    setShowAISlidePanel(true);
  }, []);

  const handleOpenAISlidePanelFromMenu = useCallback(() => {
    handleOpenAISlidePanel();
    setIsWindowMenuOpen(false);
  }, [handleOpenAISlidePanel]);

  const handleToggleSidebar = useCallback(() => {
    setIsSidebarCollapsed((collapsed) => !collapsed);
  }, []);

  const handleStartWindowDrag = useCallback(
    (e: ReactMouseEvent<HTMLElement>) => {
      if (!isDesktopWindow || e.button !== 0) return;

      const target = e.target as HTMLElement | null;
      if (
        target?.closest(
          "button, input, textarea, select, option, a, [role='button'], [contenteditable='true'], [data-no-window-drag='true']",
        )
      ) {
        return;
      }

      void (async () => {
        try {
          await getCurrentWindow().startDragging();
        } catch (windowError) {
          console.error("Failed to start dragging window", windowError);
        }
      })();
    },
    [isDesktopWindow],
  );

  const handleMinimizeWindow = useCallback(() => {
    if (!isDesktopWindow) return;

    void (async () => {
      try {
        await getCurrentWindow().minimize();
      } catch (windowError) {
        console.error("Failed to minimize window", windowError);
      }
    })();
  }, [isDesktopWindow]);

  const handleToggleMaximizeWindow = useCallback(() => {
    if (!isDesktopWindow) return;

    void (async () => {
      try {
        const appWindow = getCurrentWindow();
        await appWindow.toggleMaximize();
        setIsWindowMaximized(await appWindow.isMaximized());
      } catch (windowError) {
        console.error("Failed to toggle maximize window", windowError);
      }
    })();
  }, [isDesktopWindow]);

  const handleCloseWindow = useCallback(() => {
    if (!isDesktopWindow) return;

    void (async () => {
      try {
        await getCurrentWindow().close();
      } catch (windowError) {
        console.error("Failed to close window", windowError);
      }
    })();
  }, [isDesktopWindow]);

  const handleCloseWindowFromMenu = useCallback(() => {
    setIsWindowMenuOpen(false);
    handleCloseWindow();
  }, [handleCloseWindow]);

  const handleToggleSidebarFromMenu = useCallback(() => {
    handleToggleSidebar();
    setIsWindowMenuOpen(false);
  }, [handleToggleSidebar]);

  const windowMenuSections: { key: WindowMenuSectionKey; label: string; items: WindowMenuItem[] }[] = [
    {
      key: "file",
      label: t("menu.section.file"),
      items: [
        { label: t("menu.item.newConnection"), action: handleNewConnectionFromMenu },
        { label: t("menu.item.newQuery"), action: handleNewQueryFromMenu, disabled: !isConnected },
        { label: t("menu.item.openMetrics"), action: handleOpenMetricsBoardFromMenu, disabled: !isConnected },
        { divider: true },
        { label: t("menu.item.exit"), action: handleCloseWindowFromMenu },
      ],
    },
    {
      key: "edit",
      label: t("menu.section.edit"),
      items: [
        { label: t("menu.item.aiSettings"), action: handleOpenAISettingsFromMenu },
        { label: t("menu.item.askAI"), action: handleOpenAISlidePanelFromMenu, disabled: !isConnected },
      ],
    },
    {
      key: "view",
      label: t("menu.section.view"),
      items: [
        {
          key: "increase-font-size",
          label: t("menu.item.increaseFontSize"),
          action: handleIncreaseFontSize,
          shortcut: "Ctrl +",
        },
        {
          key: "decrease-font-size",
          label: t("menu.item.decreaseFontSize"),
          action: handleDecreaseFontSize,
          shortcut: "Ctrl -",
        },
        { divider: true },
        {
          key: "toggle-sidebars",
          label: t("menu.item.toggleSidebars"),
          children: [
            {
              key: "toggle-left-sidebar",
              label: t("menu.item.toggleLeftSidebar"),
              action: handleToggleSidebarFromMenu,
              shortcut: "Ctrl 0",
            },
            {
              key: "toggle-right-sidebar",
              label: t("menu.item.toggleRightSidebar"),
              action: handleToggleRightSidebarFromMenu,
              shortcut: "Ctrl Space",
            },
            {
              key: "toggle-bottom-sidebar",
              label: t("menu.item.toggleBottomSidebar"),
              disabled: true,
              shortcut: "Ctrl Shift C",
            },
            {
              key: "toggle-query-results-pane",
              label: t("menu.item.toggleQueryResultsPane"),
              action: handleToggleQueryResultsPaneFromMenu,
              disabled: activeTab?.type !== "query",
              shortcut: "Ctrl `",
            },
          ],
        },
      ],
    },
    {
      key: "tools",
      label: t("menu.section.tools"),
      items: [
        { label: t("menu.item.userManagement"), disabled: true },
        { label: t("menu.item.processList"), disabled: true, shortcut: "Ctrl ." },
        { divider: true },
        { label: t("menu.item.searchInDatabase"), action: handleSearchInDatabaseFromMenu, disabled: !isConnected },
        { divider: true },
        { label: t("menu.item.refreshWorkspace"), action: handleRefreshWorkspaceFromMenu, disabled: !isConnected },
        { label: t("menu.item.focusExplorerSearch"), action: handleFocusExplorerSearchFromMenu, disabled: !isConnected },
      ],
    },
    {
      key: "connection",
      label: t("menu.section.connection"),
      items: [
        { label: t("menu.item.savedConnections"), action: handleOpenConnectionsPanel },
        { label: t("menu.item.openExplorer"), action: handleShowDatabaseWorkspaceFromMenu, disabled: !isConnected },
        { label: t("menu.item.openMetrics"), action: handleOpenMetricsBoardFromMenu, disabled: !isConnected },
      ],
    },
    {
      key: "plugins",
      label: t("menu.section.plugins"),
      items: [
        { label: t("menu.item.askAI"), action: handleOpenAISlidePanelFromMenu, disabled: !isConnected },
        { label: t("menu.item.pluginManager"), disabled: true },
      ],
    },
    {
      key: "navigate",
      label: t("menu.section.navigate"),
      items: [
        { label: t("menu.item.connections"), action: handleOpenConnectionsPanel },
        { label: t("menu.item.explorer"), action: handleShowDatabaseWorkspaceFromMenu, disabled: !isConnected },
        { label: t("menu.item.metrics"), action: handleOpenMetricsBoardFromMenu, disabled: !isConnected },
      ],
    },
    {
      key: "language",
      label: t("menu.section.language"),
      items: [
        { label: t("common.auto"), action: () => handleChangeLanguage("auto"), selected: languagePreference === "auto" },
        {
          label: t("common.englishUs"),
          action: () => handleChangeLanguage("en"),
          selected: languagePreference === "en",
        },
        {
          label: t("common.vietnamese"),
          action: () => handleChangeLanguage("vi"),
          selected: languagePreference === "vi",
        },
        {
          label: t("common.chineseSimplified"),
          action: () => handleChangeLanguage("zh"),
          selected: languagePreference === "zh",
        },
      ],
    },
    {
      key: "help",
      label: t("menu.section.help"),
      items: [
        { label: t("menu.item.aboutTableR"), action: handleOpenAboutModalFromMenu },
        { label: t("menu.item.keyboardShortcuts"), action: handleOpenKeyboardShortcutsFromMenu },
      ],
    },
  ];

  const renderWindowMenuPopover = () => {
    if (!isWindowMenuOpen) return null;

    return (
      <div className="titlebar-window-menu-popover">
        <div className="titlebar-window-menu-sections">
          {windowMenuSections.map((section) => (
            <div
              key={section.key}
              className={`titlebar-window-menu-section-node ${
                activeWindowMenuSection === section.key ? "active" : ""
              }`}
              onMouseEnter={() => {
                setActiveWindowMenuSection(section.key);
                setActiveWindowMenuItemPath(null);
              }}
              onFocus={() => {
                setActiveWindowMenuSection(section.key);
                setActiveWindowMenuItemPath(null);
              }}
            >
              <button
                type="button"
                className={`titlebar-window-menu-section-item ${
                  activeWindowMenuSection === section.key ? "active" : ""
                }`}
              >
                <span>{section.label}</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </button>

              {activeWindowMenuSection === section.key && (
                <div className="titlebar-window-submenu">
                  <div className="titlebar-window-submenu-head">
                    <span className="titlebar-window-submenu-kicker">{t("titlebar.menu")}</span>
                    <span className="titlebar-window-submenu-title">{section.label}</span>
                  </div>

                  {section.items.map((item, index) =>
                    item.divider ? (
                      <div
                        key={`${section.key}-divider-${index}`}
                        className="titlebar-window-menu-divider"
                      />
                    ) : (
                      <div
                        key={`${section.key}-${item.key || item.label}-${index}`}
                        className="titlebar-window-menu-item-node"
                        onMouseEnter={() =>
                          setActiveWindowMenuItemPath(
                            item.children ? `${section.key}:${item.key || index}` : null,
                          )
                        }
                        onFocus={() =>
                          setActiveWindowMenuItemPath(
                            item.children ? `${section.key}:${item.key || index}` : null,
                          )
                        }
                      >
                        <button
                          type="button"
                          className={`titlebar-window-menu-item ${item.selected ? "selected" : ""} ${
                            item.children ? "has-children" : ""
                          }`}
                          onClick={item.children ? undefined : item.action}
                          disabled={item.disabled}
                        >
                          <span>{item.label}</span>
                          <span className="titlebar-window-menu-item-meta">
                            {item.shortcut ? (
                              <span className="titlebar-window-menu-shortcut">{item.shortcut}</span>
                            ) : null}
                            {item.children ? <ChevronRight className="w-3.5 h-3.5" /> : null}
                          </span>
                        </button>

                        {item.children &&
                          activeWindowMenuItemPath === `${section.key}:${item.key || index}` && (
                            <div className="titlebar-window-submenu titlebar-window-submenu-nested">
                              {item.children.map((child, childIndex) =>
                                child.divider ? (
                                  <div
                                    key={`${section.key}-${item.key}-divider-${childIndex}`}
                                    className="titlebar-window-menu-divider"
                                  />
                                ) : (
                                  <button
                                    key={`${section.key}-${item.key}-${child.key || child.label}-${childIndex}`}
                                    type="button"
                                    className={`titlebar-window-menu-item ${
                                      child.selected ? "selected" : ""
                                    }`}
                                    onClick={child.action}
                                    disabled={child.disabled}
                                  >
                                    <span>{child.label}</span>
                                    {child.shortcut ? (
                                      <span className="titlebar-window-menu-shortcut">
                                        {child.shortcut}
                                      </span>
                                    ) : null}
                                  </button>
                                ),
                              )}
                            </div>
                          )}
                      </div>
                    ),
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderWindowControls = (
    className?: string,
    options?: { lockSize?: boolean },
  ) => {
    if (!isDesktopWindow) return null;

    return (
      <div
        className={`titlebar-window-controls ${className ?? ""}`.trim()}
        data-no-window-drag="true"
      >
        <div className="titlebar-window-menu" ref={windowMenuRef}>
          <button
            type="button"
            onClick={handleToggleWindowMenu}
            className={`titlebar-window-btn ${isWindowMenuOpen ? "active" : ""}`}
            title={t("titlebar.menu")}
            aria-label={t("titlebar.openAppMenu")}
          >
            <Menu className="w-4 h-4" />
          </button>

          {renderWindowMenuPopover()}
        </div>

        <button
          type="button"
          onClick={handleMinimizeWindow}
          className="titlebar-window-btn"
          title={t("titlebar.minimize")}
          aria-label={t("titlebar.minimize")}
        >
          <Minus className="w-4 h-4" />
        </button>
        {!options?.lockSize ? (
          <button
            type="button"
            onClick={handleToggleMaximizeWindow}
            className="titlebar-window-btn"
            title={isWindowMaximized ? t("titlebar.restore") : t("titlebar.maximize")}
            aria-label={isWindowMaximized ? t("titlebar.restore") : t("titlebar.maximize")}
          >
            {isWindowMaximized ? (
              <Copy className="w-3.5 h-3.5" />
            ) : (
              <Square className="w-3.5 h-3.5" />
            )}
          </button>
        ) : null}
        <button
          type="button"
          onClick={handleCloseWindow}
          className="titlebar-window-btn danger"
          title={t("titlebar.close")}
          aria-label={t("titlebar.close")}
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    );
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return;

      const delta = e.clientX - startX.current;
      const nextWidth = Math.max(sidebarMinWidth, Math.min(460, startWidth.current + delta));
      setSidebarWidth(nextWidth);
    };

    const handleMouseUp = () => {
      isResizing.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  useEffect(() => {
    void loadSavedConnections();
  }, [loadSavedConnections]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const metaPressed = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (metaPressed && !e.altKey && key === "p") {
        e.preventDefault();
        e.stopPropagation();
        handleOpenAISlidePanel();
        return;
      }

      if (metaPressed && key === "n") {
        e.preventDefault();
        handleNewQuery();
        return;
      }

      if (metaPressed && key === "b") {
        e.preventDefault();
        handleToggleSidebar();
        return;
      }

      if (metaPressed && !e.shiftKey && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        setUiFontScale((current) => Math.min(135, current + 5));
        return;
      }

      if (metaPressed && !e.shiftKey && e.key === "-") {
        e.preventDefault();
        setUiFontScale((current) => Math.max(85, current - 5));
        return;
      }

      if (metaPressed && !e.shiftKey && e.key === "0") {
        e.preventDefault();
        handleToggleSidebar();
        return;
      }

      if (metaPressed && e.code === "Space" && !e.shiftKey) {
        e.preventDefault();
        setShowAISlidePanel((current) => !current);
        return;
      }

      if (metaPressed && e.code === "Backquote") {
        if (activeTab?.type !== "query") {
          return;
        }
        e.preventDefault();
        window.dispatchEvent(
          new CustomEvent("toggle-query-results-pane", {
            detail: { tabId: activeTab.id },
          }),
        );
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [activeTab, handleNewQuery, handleOpenAISlidePanel, handleToggleSidebar]);

  useEffect(() => {
    const handleOpenAI = (event: Event) => {
      const detail = (event as CustomEvent<{ prompt?: string }>).detail;
      handleOpenAISlidePanel(detail?.prompt);
    };
    window.addEventListener("open-ai-slide-panel", handleOpenAI);
    return () => window.removeEventListener("open-ai-slide-panel", handleOpenAI);
  }, [handleOpenAISlidePanel]);

  useEffect(() => {
    const handleOpenLeftSidebarPanel = (
      event: Event,
    ) => {
      const detail = (event as CustomEvent<{
        panel?: "connections" | "database" | "metrics";
        focusSearch?: boolean;
      }>).detail;

      if (!detail?.panel) return;

      setIsSidebarCollapsed(false);
      setLeftPanel(detail.panel);

      if (detail.panel === "database" && detail.focusSearch) {
        window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent("focus-explorer-search"));
        }, 0);
      }
    };

    window.addEventListener("open-left-sidebar-panel", handleOpenLeftSidebarPanel);
    return () =>
      window.removeEventListener("open-left-sidebar-panel", handleOpenLeftSidebarPanel);
  }, [sidebarMinWidth]);

  useEffect(() => {
    const handleWorkspaceActivity = (
      event: Event,
    ) => {
      const detail = (event as CustomEvent<{
        connectionId?: string;
        label?: string;
        durationMs?: number;
      }>).detail;

      if (!detail?.connectionId || typeof detail.durationMs !== "number" || detail.durationMs < 0) {
        return;
      }

      const connectionId = detail.connectionId;
      const durationMs = detail.durationMs;

      setWorkspaceActivityByConnection((prev) => ({
        ...prev,
        [connectionId]: {
          label: detail.label?.trim() || "Load",
          durationMs: Math.round(durationMs),
          at: Date.now(),
        },
      }));
    };

    window.addEventListener("workspace-activity", handleWorkspaceActivity);
    return () => window.removeEventListener("workspace-activity", handleWorkspaceActivity);
  }, []);

  useEffect(() => {
    if (!isDesktopWindow) return;

    const appWindow = getCurrentWindow();
    let isMounted = true;
    let unlistenResized: (() => void) | undefined;
    let unlistenFocusChanged: (() => void) | undefined;

    const syncWindowState = async () => {
      const [maximized, focused] = await Promise.all([
        appWindow.isMaximized(),
        appWindow.isFocused(),
      ]);

      if (!isMounted) return;

      setIsWindowMaximized(maximized);
      setIsWindowFocused(focused);
    };

    void syncWindowState();

    void appWindow.onResized(async () => {
      if (!isMounted) return;
      setIsWindowMaximized(await appWindow.isMaximized());
    }).then((unlisten) => {
      unlistenResized = unlisten;
    });

    void appWindow.onFocusChanged(({ payload }) => {
      if (!isMounted) return;
      setIsWindowFocused(payload);
    }).then((unlisten) => {
      unlistenFocusChanged = unlisten;
    });

    return () => {
      isMounted = false;
      unlistenResized?.();
      unlistenFocusChanged?.();
    };
  }, [isDesktopWindow]);

  useEffect(() => {
    if (activeConnectionId && connectedIds.has(activeConnectionId)) {
      setLeftPanel("database");
      return;
    }

    setLeftPanel("connections");
  }, [activeConnectionId, connectedIds]);

  useEffect(() => {
    if (activeConnectionId && connectedIds.has(activeConnectionId)) {
      setShowStartupConnectionManager(false);
      setConnectionFormIntent(null);
    }
  }, [activeConnectionId, connectedIds]);

  useEffect(() => {
    if (!isDesktopWindow) return;

    const windowProfile: "launcher" | "form" | "workspace" = !isConnected
      ? connectionFormIntent
        ? "form"
        : "launcher"
      : "workspace";

    let cancelled = false;
    const syncGeneration = ++windowSyncGenerationRef.current;
    const isStale = () => cancelled || windowSyncGenerationRef.current !== syncGeneration;

    const applyWindowProfile = async () => {
      try {
        if (isStale()) return;

        await invoke("apply_window_profile", { profile: windowProfile });
      } catch (windowError) {
        console.error("Failed to synchronize startup window state", windowError);
      }
    };

    void applyWindowProfile();

    return () => {
      cancelled = true;
    };
  }, [connectionFormIntent, isConnected, isDesktopWindow]);

  useEffect(() => {
    if (!isDesktopWindow || !isConnected) return;

    let cancelled = false;

    const reinforceWorkspaceWindow = async () => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 120));
      if (cancelled) return;

      try {
        await invoke("apply_window_profile", { profile: "workspace" });
      } catch (windowError) {
        console.error("Failed to reinforce workspace window state", windowError);
      }
    };

    void reinforceWorkspaceWindow();

    return () => {
      cancelled = true;
    };
  }, [isConnected, isDesktopWindow]);

  useEffect(() => {
    if (!activeConnectionId || !connectedIds.has(activeConnectionId)) return;

    if (activeTab?.type === "metrics") {
      setLeftPanel("metrics");
      return;
    }

    setLeftPanel((current) => (current === "metrics" ? "database" : current));
  }, [activeConnectionId, activeTab?.id, activeTab?.type, connectedIds]);

  useEffect(() => {
    if (isSidebarCollapsed) return;
    if (sidebarWidth >= sidebarMinWidth) return;
    setSidebarWidth(sidebarMinWidth);
  }, [isSidebarCollapsed, sidebarMinWidth, sidebarWidth]);

  const renderTabContent = () => {
    if (!isConnected) {
      return (
        <div className="workspace-empty">
          <div className="workspace-empty-panel">
            <div className="workspace-empty-hero">
              <div className="workspace-empty-icon">
                <Database className="w-10 h-10 text-[var(--accent)]" />
              </div>

              <div className="workspace-empty-copy">
                <span className="workspace-empty-kicker">{t("workspace.empty.kicker")}</span>
                <h2 className="workspace-empty-title">{t("workspace.empty.title")}</h2>
                <p className="workspace-empty-description">
                  {t("workspace.empty.description")}
                </p>
              </div>
            </div>

            <div className="workspace-empty-actions">
              <button onClick={() => setConnectionFormIntent("connect")} className="btn btn-primary">
                <Plus className="w-3.5 h-3.5" />
                {t("workspace.empty.newConnection")}
              </button>
              <button onClick={() => setConnectionFormIntent("bootstrap")} className="btn btn-secondary">
                <Database className="w-3.5 h-3.5" />
                {t("workspace.empty.createLocalDb")}
              </button>
            </div>

            <div className="workspace-empty-grid">
              <div className="workspace-empty-card">
                <span className="workspace-empty-card-kicker">{t("workspace.empty.connections")}</span>
                <strong className="workspace-empty-card-title">{t("workspace.empty.savedWorkspaces")}</strong>
                <p className="workspace-empty-card-copy">
                  {t("workspace.empty.savedWorkspacesDesc")}
                </p>
              </div>

              <div className="workspace-empty-card">
                <span className="workspace-empty-card-kicker">{t("workspace.empty.supported")}</span>
                <strong className="workspace-empty-card-title">{t("workspace.empty.primaryEngines")}</strong>
                <p className="workspace-empty-card-copy">
                  {t("workspace.empty.primaryEnginesDesc")}
                </p>
              </div>

              <div className="workspace-empty-card">
                <span className="workspace-empty-card-kicker">{t("workspace.empty.workflow")}</span>
                <strong className="workspace-empty-card-title">{t("workspace.empty.connectToQuery")}</strong>
                <p className="workspace-empty-card-copy">
                  {t("workspace.empty.connectToQueryDesc")}
                </p>
              </div>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="workspace-empty workspace-ready-shell">
        <div className="workspace-empty-panel workspace-ready-panel">
          <div className="workspace-ready-hero">
            <div className="workspace-empty-hero">
              <div className="workspace-empty-icon workspace-ready-icon">
                <Sparkles className="w-10 h-10 text-[var(--accent)]" />
              </div>

              <div className="workspace-empty-copy">
                <span className="workspace-empty-kicker">{t("workspace.ready.kicker")}</span>
                <h2 className="workspace-empty-title">{t("workspace.ready.title")}</h2>
                <p className="workspace-empty-description">
                  {t("workspace.ready.description")}
                </p>
              </div>
            </div>

            <div className="workspace-ready-context">
              <div className="workspace-ready-context-copy">
                <span className="workspace-ready-context-label">{t("workspace.ready.activeSession")}</span>
                <strong className="workspace-ready-context-title">
                  {activeConn?.name || t("workspace.ready.connectedWorkspace")}
                </strong>
                <p className="workspace-ready-context-meta">
                  {currentDatabase ||
                    activeConn?.database ||
                    getLastPathSegment(activeConn?.file_path) ||
                    t("workspace.ready.currentDatabaseSelected")}
                  {" · "}
                  {(activeConn?.db_type || "").toUpperCase()}
                </p>
              </div>

              <div className="workspace-ready-shortcut-row">
                <span className="workspace-ready-shortcut-pill">
                  <kbd className="kbd">Ctrl+N</kbd>
                  <span>{t("common.query").toLowerCase()}</span>
                </span>
                <span className="workspace-ready-shortcut-pill">
                  <kbd className="kbd">Ctrl+B</kbd>
                  <span>{t("common.explorer").toLowerCase()}</span>
                </span>
                <span className="workspace-ready-shortcut-pill">
                  <kbd className="kbd">Ctrl+Shift+P</kbd>
                  <span>AI</span>
                </span>
              </div>
            </div>
          </div>

          <div className="workspace-ready-actions">
            <button
              type="button"
              className="workspace-ready-action-card"
              onClick={handleNewQuery}
            >
              <div className="workspace-ready-action-top">
                <div className="workspace-ready-action-icon">
                  <Plus className="w-4 h-4" />
                </div>
                <span className="workspace-ready-action-kicker">{t("workspace.ready.sqlEditor")}</span>
              </div>
              <strong className="workspace-ready-action-title">{t("workspace.ready.queryTitle")}</strong>
              <p className="workspace-ready-action-description">
                {t("workspace.ready.queryDescription")}
              </p>
              <div className="workspace-ready-action-foot">
                <kbd className="kbd">Ctrl+N</kbd>
                <span className="workspace-ready-action-link">{t("workspace.ready.queryLink")}</span>
              </div>
            </button>

            <button
              type="button"
              className="workspace-ready-action-card"
              onClick={handleFocusExplorerSearch}
            >
              <div className="workspace-ready-action-top">
                <div className="workspace-ready-action-icon">
                  <Search className="w-4 h-4" />
                </div>
                <span className="workspace-ready-action-kicker">{t("workspace.ready.explorerKicker")}</span>
              </div>
              <strong className="workspace-ready-action-title">{t("workspace.ready.explorerTitle")}</strong>
              <p className="workspace-ready-action-description">
                {t("workspace.ready.explorerDescription")}
              </p>
              <div className="workspace-ready-action-foot">
                <kbd className="kbd">Ctrl+B</kbd>
                <span className="workspace-ready-action-link">{t("workspace.ready.explorerLink")}</span>
              </div>
            </button>

            <button
              type="button"
              className="workspace-ready-action-card"
              onClick={() => handleOpenAISlidePanel()}
            >
              <div className="workspace-ready-action-top">
                <div className="workspace-ready-action-icon">
                  <Sparkles className="w-4 h-4" />
                </div>
                <span className="workspace-ready-action-kicker">{t("workspace.ready.aiKicker")}</span>
              </div>
              <strong className="workspace-ready-action-title">{t("workspace.ready.aiTitle")}</strong>
              <p className="workspace-ready-action-description">
                {t("workspace.ready.aiDescription")}
              </p>
              <div className="workspace-ready-action-foot">
                <kbd className="kbd">Ctrl+Shift+P</kbd>
                <span className="workspace-ready-action-link">{t("workspace.ready.aiLink")}</span>
              </div>
            </button>
          </div>

          <div className="workspace-ready-support">
            <div className="workspace-ready-support-card">
              <span className="workspace-ready-support-kicker">{t("workspace.ready.flowKicker")}</span>
              <strong className="workspace-ready-support-title">{t("workspace.ready.flowTitle")}</strong>
              <div className="workspace-ready-support-list">
                <div className="workspace-ready-support-item">
                  <span className="workspace-ready-support-dot" />
                  {t("workspace.ready.flowQuery")}
                </div>
                <div className="workspace-ready-support-item">
                  <span className="workspace-ready-support-dot" />
                  {t("workspace.ready.flowExplorer")}
                </div>
                <div className="workspace-ready-support-item">
                  <span className="workspace-ready-support-dot" />
                  {t("workspace.ready.flowAi")}
                </div>
              </div>
            </div>

            <div className="workspace-ready-support-card">
              <span className="workspace-ready-support-kicker">{t("workspace.ready.targetKicker")}</span>
              <strong className="workspace-ready-support-title">{t("workspace.ready.targetTitle")}</strong>
              <div className="workspace-ready-metrics">
                <div className="workspace-ready-metric">
                  <span className="workspace-ready-metric-label">{t("workspace.ready.connection")}</span>
                  <strong className="workspace-ready-metric-value">
                    {activeConn?.name || t("workspace.ready.connectedWorkspace")}
                  </strong>
                </div>
                <div className="workspace-ready-metric">
                  <span className="workspace-ready-metric-label">{t("workspace.ready.database")}</span>
                  <strong className="workspace-ready-metric-value">
                    {currentDatabase ||
                      activeConn?.database ||
                      getLastPathSegment(activeConn?.file_path) ||
                      t("workspace.ready.selectedTarget")}
                  </strong>
                </div>
                <div className="workspace-ready-metric">
                  <span className="workspace-ready-metric-label">{t("workspace.ready.engine")}</span>
                  <strong className="workspace-ready-metric-value">
                    {(activeConn?.db_type || "").toUpperCase()}
                  </strong>
                </div>
              </div>
            </div>

            <div className="workspace-ready-support-card">
              <span className="workspace-ready-support-kicker">{t("workspace.ready.safetyKicker")}</span>
              <strong className="workspace-ready-support-title">{t("workspace.ready.safetyTitle")}</strong>
              <div className="workspace-ready-support-list">
                <div className="workspace-ready-support-item">
                  <span className="workspace-ready-support-dot" />
                  {t("workspace.ready.safetyQuery")}
                </div>
                <div className="workspace-ready-support-item">
                  <span className="workspace-ready-support-dot" />
                  {t("workspace.ready.safetyRefresh")}
                </div>
                <div className="workspace-ready-support-item">
                  <span className="workspace-ready-support-dot" />
                  {t("workspace.ready.safetyAi")}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderSingleTab = (tab: Tab, isActive: boolean) => {
    switch (tab.type) {
      case "query":
        return (
          <Suspense fallback={<LazyPanelFallback />}>
            <SQLEditor
              key={tab.id}
              connectionId={tab.connectionId}
              initialContent={tab.content || ""}
              tabId={tab.id}
              initialState={querySessionByTab[tab.id]}
              runRequestNonce={queryRunRequestByTab[tab.id] ?? 0}
              onChromeChange={(state) => handleQueryChromeChange(tab.id, state)}
              onStateChange={(state) => handleQuerySessionChange(tab.id, state)}
            />
          </Suspense>
        );
      case "table":
        return (
          <Suspense fallback={<LazyPanelFallback />}>
            <DataGrid
              key={tab.id}
              connectionId={tab.connectionId}
              tableName={tab.tableName}
              database={tab.database}
              isActive={isActive}
            />
          </Suspense>
        );
      case "structure":
        return (
          <Suspense fallback={<LazyPanelFallback />}>
            <TableStructure
              key={tab.id}
              connectionId={tab.connectionId}
              tableName={tab.tableName || ""}
              database={tab.database}
              isActive={isActive}
            />
          </Suspense>
        );
      case "metrics":
        return (
          <Suspense fallback={<LazyPanelFallback />}>
            <MetricsBoard
              key={tab.id}
              connectionId={tab.connectionId}
              database={tab.database}
              tabId={tab.id}
              boardId={tab.metricsBoardId}
              integratedSidebar={false}
            />
          </Suspense>
        );
      default:
        return null;
    }
  };

  const renderSidebarRail = () => (
    <div className="sidebar-rail">
      <button
        type="button"
        className={`sidebar-rail-btn ${leftPanel === "connections" ? "active" : ""}`}
        onClick={() => {
          setIsSidebarCollapsed(false);
          setLeftPanel("connections");
        }}
        title={t("sidebar.connections")}
      >
        <Cable className="w-4 h-4" />
      </button>

      <button
        type="button"
        className={`sidebar-rail-btn ${leftPanel === "database" ? "active" : ""}`}
        onClick={() => {
          if (!isConnected) return;
          handleShowDatabaseWorkspace();
        }}
        title={t("sidebar.explorer")}
        disabled={!isConnected}
      >
        <FolderTree className="w-4 h-4" />
      </button>

      <button
        type="button"
        className={`sidebar-rail-btn ${leftPanel === "metrics" ? "active" : ""}`}
        onClick={() => {
          if (!isConnected) return;
          void handleOpenMetricsBoard();
        }}
        title={t("sidebar.metrics")}
        disabled={!isConnected}
      >
        <BarChart3 className="w-4 h-4" />
      </button>

      <button
        type="button"
        className="sidebar-rail-btn"
        onClick={() => setConnectionFormIntent("connect")}
        title={t("sidebar.newConnection")}
      >
        <Plus className="w-4 h-4" />
      </button>

      <div className="sidebar-rail-spacer" />

      <button
        type="button"
        className="sidebar-rail-btn"
        onClick={handleToggleSidebar}
        title={t("sidebar.expandSidebar")}
      >
        <PanelRightClose className="w-4 h-4 rotate-180" />
      </button>
    </div>
  );

  if (showStartupShell) {
    return (
      <div className="app-root startup-shell-active">
        {connectionFormIntent && (
          <Suspense fallback={null}>
            <ConnectionForm
              initialIntent={connectionFormIntent}
              onClose={handleCloseConnectionForm}
            />
          </Suspense>
        )}

        {showStartupConnectionManager && !isConnected && !connectionFormIntent && (
          <StartupConnectionManager
            onNewConnection={() => handleOpenConnectionForm("connect")}
            onCreateLocalDb={() => handleOpenConnectionForm("bootstrap")}
            windowControls={renderWindowControls("startup-window-controls", { lockSize: true })}
          />
        )}
      </div>
    );
  }

  return (
    <div className={`app-root ${isWindowMaximized ? "window-maximized" : ""}`}>
      {!showStartupShell && (
        <>
          <header
            className={`titlebar ${isWindowFocused ? "" : "inactive"}`}
            onMouseDown={handleStartWindowDrag}
          >
        <div
          className="titlebar-drag-strip"
          onDoubleClick={handleToggleMaximizeWindow}
        >
          <div className="titlebar-brand">
            <Database className="w-4 h-4 text-[var(--accent)]" />
            <span className="titlebar-name">TableR</span>
          </div>

          <div className="titlebar-divider" />

          <div className="titlebar-context">
            <span className="titlebar-context-label">{t("common.workspace")}</span>
            {isConnected && activeConn ? (
              <div className="titlebar-badge" title={titlebarContextTitle}>
                <span
                  className="w-2 h-2 rounded-sm shrink-0"
                  style={{ backgroundColor: activeConn.color || "var(--success)" }}
                />
                <span className="truncate">
                  {titlebarContextLabel}
                </span>
              </div>
            ) : (
              <div className="titlebar-badge muted">
                <span className="w-2 h-2 rounded-sm shrink-0 bg-white/25" />
                <span className="truncate">{t("titlebar.noActiveConnection")}</span>
              </div>
            )}
          </div>

          <div className="titlebar-spacer" />
        </div>

        <div className="titlebar-actions" data-no-window-drag="true">
          <button
            onClick={() => setShowAISettings(true)}
            className="titlebar-icon-btn"
            title={t("titlebar.aiSettings")}
          >
            <Settings2 className="w-4 h-4" />
          </button>

          <button
            onClick={handleToggleSidebar}
            className="titlebar-icon-btn"
            title={isSidebarCollapsed ? t("titlebar.expandSidebar") : t("titlebar.collapseSidebar")}
          >
            <PanelRightClose className={`w-4 h-4 ${isSidebarCollapsed ? "rotate-180" : ""}`} />
          </button>
        </div>

        {renderWindowControls()}
          </header>

          {error && (
            <div className="error-bar">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span className="flex-1">{error}</span>
              <button onClick={clearError} className="error-bar-close">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </>
      )}

      {!showStartupShell && (
        <>
          <div className="main-container">
            <aside
              className={`sidebar ${isSidebarCollapsed ? "sidebar-collapsed" : ""}`}
              style={{ width: isSidebarCollapsed ? 76 : sidebarWidth }}
            >
              {isSidebarCollapsed ? (
                renderSidebarRail()
              ) : leftPanel === "connections" ? (
                <ConnectionList
                  onNewConnection={() => handleOpenConnectionForm("connect")}
                />
              ) : (
                <div className="workspace-sidebar-shell">
                  <div className="workspace-sidebar-rail">
                    <button
                      type="button"
                      className={`workspace-sidebar-rail-btn ${leftPanel === "database" ? "active" : ""}`}
                      onClick={handleShowDatabaseWorkspace}
                      title={t("sidebar.databaseExplorer")}
                    >
                      <FolderTree className="w-4 h-4" />
                      <span>{t("sidebar.dbShort")}</span>
                    </button>
                    <button
                      type="button"
                      className={`workspace-sidebar-rail-btn ${leftPanel === "metrics" ? "active" : ""}`}
                      onClick={() => void handleOpenMetricsBoard()}
                      title={t("sidebar.metricsBoards")}
                    >
                      <BarChart3 className="w-4 h-4" />
                      <span>{t("sidebar.metricsShort")}</span>
                    </button>
                  </div>

                  <div className="workspace-sidebar-panel">
                    {leftPanel === "metrics" ? (
                      <MetricsSidebar
                        connectionId={activeConnectionId || ""}
                        database={currentDatabase || undefined}
                      />
                    ) : (
                      <Sidebar />
                    )}
                  </div>
                </div>
              )}
            </aside>

            {!isSidebarCollapsed && (
              <div className="resize-handle" onMouseDown={handleMouseDown}>
                <div className="resize-handle-line" />
              </div>
            )}

            <main className="main-content">
              <div className="workspace-toolbar">
                <div className="workspace-toolbar-main">
                  <div className="workspace-toolbar-topline">
                    <span className="workspace-toolbar-kicker">
                      {activeTab
                        ? activeTab.type === "query"
                          ? t("workspace.kicker.sql")
                          : activeTab.type === "table"
                            ? t("workspace.kicker.table")
                            : activeTab.type === "structure"
                              ? t("workspace.kicker.structure")
                              : t("workspace.kicker.metrics")
                        : t("workspace.kicker.default")}
                    </span>
                    {isConnected && activeConn && (
                      <span className="workspace-toolbar-chip">
                        {activeConn.name || activeConn.host}
                        {activeDatabaseLabel ? ` / ${activeDatabaseLabel}` : ""}
                      </span>
                    )}
                    {activeWorkspaceActivity && (
                      <span className="workspace-toolbar-mini-note">
                        {activeWorkspaceActivity.label} {activeWorkspaceActivity.durationMs}ms
                      </span>
                    )}
                  </div>

                  <div className="workspace-toolbar-title-row">
                    <span className="workspace-toolbar-title">
                      {activeTab?.title || (isConnected ? t("workspace.readyForQueries") : t("titlebar.noActiveConnection"))}
                    </span>
                    {activeQueryChrome?.executionTimeMs !== undefined && (
                      <div className="workspace-toolbar-status">
                        <span className="workspace-toolbar-status-pill success">{t("workspace.status.success")}</span>
                        <span className="workspace-toolbar-status-pill">
                          {activeQueryChrome.executionTimeMs}ms
                        </span>
                        {typeof activeQueryChrome.rowCount === "number" && activeQueryChrome.rowCount > 0 && (
                          <span className="workspace-toolbar-status-pill">
                            {t("workspace.status.rows", { count: activeQueryChrome.rowCount })}
                          </span>
                        )}
                        {typeof activeQueryChrome.affectedRows === "number" && activeQueryChrome.affectedRows > 0 && (
                          <span className="workspace-toolbar-status-pill warning">
                            {t("workspace.status.affected", { count: activeQueryChrome.affectedRows })}
                          </span>
                        )}
                        {typeof activeQueryChrome.queryCount === "number" && activeQueryChrome.queryCount > 1 && (
                          <span className="workspace-toolbar-status-pill">
                            {t("workspace.status.batch", { count: activeQueryChrome.queryCount })}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                <div className="workspace-toolbar-actions">
                  {isConnected && (
                    <>
                      {!isMetricsWorkspace && visibleTabs.length > 1 && (
                        <button
                          onClick={handleClearVisibleTabs}
                          className="toolbar-btn clear-action"
                          title={t("toolbar.closeAllTabs")}
                        >
                          <X className="w-3.5 h-3.5" />
                          <span>{t("toolbar.clear")}</span>
                        </button>
                      )}

                      {!isMetricsWorkspace && (
                        <button
                          onClick={handleNewQuery}
                          className="toolbar-btn primary"
                          title={t("toolbar.newQueryShortcut")}
                        >
                          <Plus className="w-3.5 h-3.5" />
                          <span>{t("toolbar.newQuery")}</span>
                        </button>
                      )}

                      <div className="workspace-toolbar-utility">
                        <button
                          onClick={() => void handleRefreshWorkspace()}
                          className="toolbar-btn icon-only"
                          title={t("toolbar.refreshWorkspace")}
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                        </button>

                        <button
                          onClick={handleFocusExplorerSearch}
                          className="toolbar-btn icon-only"
                          title={t("toolbar.findTable")}
                        >
                          <Search className="w-3.5 h-3.5" />
                        </button>

                        <button
                          onClick={handleOpenMetricsBoard}
                          className="toolbar-btn icon-only"
                          title={t("toolbar.openMetricsBoard")}
                        >
                          <BarChart3 className="w-3.5 h-3.5" />
                        </button>

                        <button
                          onClick={() => handleOpenAISlidePanel()}
                          className="toolbar-btn icon-only"
                          title={t("toolbar.askAiShortcut")}
                        >
                          <Sparkles className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>

              <TabBar
                queryChrome={activeQueryChrome}
                onRunActiveQuery={handleRunActiveQuery}
              />

              <div className="tab-content">
                {tabs.length === 0 || !activeTab ? (
                  renderTabContent()
                ) : (
                  <div
                    key={activeTab.id}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      height: "100%",
                      width: "100%",
                    }}
                  >
                    {renderSingleTab(activeTab, true)}
                  </div>
                )}
              </div>
            </main>
          </div>

          <footer className="statusbar">
            <div className="statusbar-left">
              <span className={`statusbar-indicator ${isConnected ? "connected" : ""}`}>
                <span className="statusbar-dot" />
                {isConnected ? "Connected" : "Disconnected"}
              </span>
              {isConnected && activeConn && (
                <span className="statusbar-info">
                  {activeConn.db_type.toUpperCase()}
                  {currentDatabase ? ` | ${currentDatabase}` : ""}
                  {activeWorkspaceActivity ? ` | ${activeWorkspaceActivity.label} ${activeWorkspaceActivity.durationMs}ms` : ""}
                </span>
              )}
            </div>

            <div className="statusbar-right">
              <span className="statusbar-shortcuts">
                <kbd className="kbd">Ctrl+N</kbd>
                <kbd className="kbd">Ctrl+B</kbd>
                <kbd className="kbd">Ctrl+Shift+P</kbd>
              </span>
              <span>TableR v0.1.0</span>
            </div>
          </footer>
        </>
      )}

      {connectionFormIntent && (
        <Suspense fallback={null}>
          <ConnectionForm
            initialIntent={connectionFormIntent}
            onClose={handleCloseConnectionForm}
          />
        </Suspense>
      )}
      {showAISettings && (
        <Suspense fallback={null}>
          <AISettingsModal onClose={() => setShowAISettings(false)} />
        </Suspense>
      )}
      {showAboutModal && (
        <div className="app-help-modal-backdrop" onClick={() => setShowAboutModal(false)}>
          <div className="app-help-modal" onClick={(event) => event.stopPropagation()}>
            <div className="app-help-modal-header">
              <div className="app-help-modal-copy">
                <span className="app-help-modal-kicker">{t("help.about.kicker")}</span>
                <h3 className="app-help-modal-title">{t("help.about.title")}</h3>
                <p className="app-help-modal-description">{t("help.about.description")}</p>
              </div>
              <button
                type="button"
                className="app-help-modal-close"
                onClick={() => setShowAboutModal(false)}
                aria-label={t("common.cancel")}
              >
                <X size={16} />
              </button>
            </div>

            <div className="app-help-modal-grid">
              <div className="app-help-modal-metric">
                <span className="app-help-modal-metric-label">{t("help.about.version")}</span>
                <strong className="app-help-modal-metric-value">0.1.0</strong>
              </div>
              <div className="app-help-modal-metric">
                <span className="app-help-modal-metric-label">{t("help.about.build")}</span>
                <strong className="app-help-modal-metric-value">desktop</strong>
              </div>
            </div>

            <div className="app-help-modal-section">
              <span className="app-help-modal-section-label">{t("help.about.modules")}</span>
              <div className="app-help-modal-tags">
                <span className="app-help-modal-tag">{t("workspace.ready.sqlEditor")}</span>
                <span className="app-help-modal-tag">{t("sidebar.explorer")}</span>
                <span className="app-help-modal-tag">{t("workspace.kicker.structure")}</span>
                <span className="app-help-modal-tag">{t("common.metrics")}</span>
              </div>
            </div>

            <div className="app-help-modal-section">
              <span className="app-help-modal-section-label">{t("help.about.engines")}</span>
              <div className="app-help-modal-tags">
                <span className="app-help-modal-tag">MySQL</span>
                <span className="app-help-modal-tag">PostgreSQL</span>
                <span className="app-help-modal-tag">SQLite</span>
              </div>
            </div>

            <div className="app-help-modal-split">
              <div className="app-help-modal-panel">
                <span className="app-help-modal-section-label">{t("help.about.runtime")}</span>
                <strong className="app-help-modal-panel-title">{t("help.about.runtimeValue")}</strong>
                <p className="app-help-modal-panel-description">{t("help.about.runtimeDescription")}</p>
              </div>
              <div className="app-help-modal-panel">
                <span className="app-help-modal-section-label">{t("help.about.safety")}</span>
                <strong className="app-help-modal-panel-title">{t("help.about.safetyValue")}</strong>
                <p className="app-help-modal-panel-description">{t("help.about.safetyDescription")}</p>
              </div>
            </div>

            <div className="app-help-modal-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setShowAboutModal(false)}
              >
                {t("common.ok")}
              </button>
            </div>
          </div>
        </div>
      )}
      {showKeyboardShortcutsModal && (
        <div className="app-help-modal-backdrop" onClick={() => setShowKeyboardShortcutsModal(false)}>
          <div className="app-help-modal app-help-modal-shortcuts" onClick={(event) => event.stopPropagation()}>
            <div className="app-help-modal-header">
              <div className="app-help-modal-copy">
                <span className="app-help-modal-kicker">{t("help.shortcuts.kicker")}</span>
                <h3 className="app-help-modal-title">{t("help.shortcuts.title")}</h3>
                <p className="app-help-modal-description">{t("help.shortcuts.description")}</p>
              </div>
              <button
                type="button"
                className="app-help-modal-close"
                onClick={() => setShowKeyboardShortcutsModal(false)}
                aria-label={t("common.cancel")}
              >
                <X size={16} />
              </button>
            </div>

            <div className="app-shortcuts-list">
              {[
                { label: t("help.shortcuts.newQuery"), shortcut: "Ctrl+N" },
                { label: t("help.shortcuts.toggleSidebar"), shortcut: "Ctrl+B" },
                { label: t("help.shortcuts.openAi"), shortcut: "Ctrl+Shift+P" },
                { label: t("help.shortcuts.runQuery"), shortcut: "Ctrl+Enter" },
                { label: t("help.shortcuts.increaseFont"), shortcut: "Ctrl++" },
                { label: t("help.shortcuts.decreaseFont"), shortcut: "Ctrl+-" },
                { label: t("help.shortcuts.toggleResults"), shortcut: "Ctrl+`" },
                { label: t("help.shortcuts.toggleRightSidebar"), shortcut: "Ctrl+Space" },
              ].map((item) => (
                <div key={item.label} className="app-shortcuts-row">
                  <span className="app-shortcuts-label">{item.label}</span>
                  <kbd className="kbd">{item.shortcut}</kbd>
                </div>
              ))}
            </div>

            <div className="app-help-modal-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setShowKeyboardShortcutsModal(false)}
              >
                {t("common.ok")}
              </button>
            </div>
          </div>
        </div>
      )}
      {showStartupConnectionManager && !isConnected && !connectionFormIntent && (
        <StartupConnectionManager
          onNewConnection={() => handleOpenConnectionForm("connect")}
          onCreateLocalDb={() => handleOpenConnectionForm("bootstrap")}
          windowControls={renderWindowControls("startup-window-controls")}
        />
      )}
      {showAISlidePanel && (
        <Suspense fallback={null}>
          <AISlidePanel
            isOpen={showAISlidePanel}
            initialPrompt={aiPanelDraft?.prompt ?? ""}
            initialPromptNonce={aiPanelDraft?.nonce ?? 0}
            onClose={() => setShowAISlidePanel(false)}
          />
        </Suspense>
      )}
    </div>
  );
}

export default App;
