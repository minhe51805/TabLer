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
  ChevronRight,
  Plus,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "./stores/appStore";
import { useI18n, type AppLanguagePreference } from "./i18n";
import { StartupConnectionManager } from "./components/StartupConnectionManager";
import type { QueryEditorSessionState } from "./components/SQLEditor";
import { AppTitleBar } from "./components/AppTitleBar";
import { AppWorkspacePanel } from "./components/AppWorkspacePanel";
import { AppKeyboardHandler } from "./components/AppKeyboardHandler";
import { AppAboutModal } from "./components/AppAboutModal";
import { AppShortcutsModal } from "./components/AppShortcutsModal";
import { ErrorBoundary } from "./components/ErrorBoundary";
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
const ConnectionForm = lazy(() => import("./components/ConnectionForm").then((module) => ({ default: module.ConnectionForm })));
const AISettingsModal = lazy(() => import("./components/AISettingsModal").then((module) => ({ default: module.AISettingsModal })));
const AISlidePanel = lazy(() => import("./components/AISlidePanel/AISlidePanel").then((module) => ({ default: module.AISlidePanel })));

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

  const applyDesktopWindowProfile = useCallback(
    async (profile: "launcher" | "form" | "workspace") => {
      if (!isDesktopWindow) return;
      await invoke("apply_window_profile", { profile });
    },
    [isDesktopWindow],
  );

  const handleOpenConnectionForm = useCallback(
    (intent: "connect" | "bootstrap") => {
      setShowStartupConnectionManager(false);
      setConnectionFormIntent(intent);
      void applyDesktopWindowProfile("form");
    },
    [applyDesktopWindowProfile],
  );

  const handleCloseConnectionForm = useCallback(() => {
    setConnectionFormIntent(null);
    if (!activeConnectionId || !connectedIds.has(activeConnectionId)) {
      setShowStartupConnectionManager(true);
      void applyDesktopWindowProfile("launcher");
    }
  }, [activeConnectionId, applyDesktopWindowProfile, connectedIds]);

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
  }, [sidebarMinWidth]);

  useEffect(() => {
    void loadSavedConnections();
  }, [loadSavedConnections]);

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
    if (isConnected || connectionFormIntent) return;

    setShowStartupConnectionManager(true);
    setShowAISlidePanel(false);
    setIsWindowMenuOpen(false);
    setActiveWindowMenuSection(null);
    setActiveWindowMenuItemPath(null);
  }, [connectionFormIntent, isConnected]);

  useEffect(() => {
    if (!isDesktopWindow || isConnected) return;

    const windowProfile: "launcher" | "form" = connectionFormIntent
      ? "form"
      : "launcher";

    let cancelled = false;
    const syncGeneration = ++windowSyncGenerationRef.current;
    const isStale = () => cancelled || windowSyncGenerationRef.current !== syncGeneration;

    const applyWindowProfile = async () => {
      try {
        if (isStale()) return;

        await applyDesktopWindowProfile(windowProfile);
      } catch (windowError) {
        console.error("Failed to synchronize startup window state", windowError);
      }
    };

    void applyWindowProfile();

    return () => {
      cancelled = true;
    };
  }, [applyDesktopWindowProfile, connectionFormIntent, isConnected, isDesktopWindow]);

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

  if (showStartupShell) {
    return (
      <div className="app-root startup-shell-active">
        {connectionFormIntent && (
          <Suspense fallback={null}>
            <ConnectionForm
              initialIntent={connectionFormIntent}
              embeddedInStartupShell
              onClose={handleCloseConnectionForm}
            />
          </Suspense>
        )}

        {showStartupConnectionManager && !isConnected && !connectionFormIntent && (
          <StartupConnectionManager
            onNewConnection={() => handleOpenConnectionForm("connect")}
            windowControls={
              <div className="titlebar-window-controls startup-window-controls" data-no-window-drag="true">
                <button
                  type="button"
                  onClick={handleMinimizeWindow}
                  className="titlebar-window-btn"
                  title={t("titlebar.minimize")}
                  aria-label={t("titlebar.minimize")}
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={handleToggleMaximizeWindow}
                  className="titlebar-window-btn"
                  title={isWindowMaximized ? t("titlebar.restore") : t("titlebar.maximize")}
                  aria-label={isWindowMaximized ? t("titlebar.restore") : t("titlebar.maximize")}
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={handleCloseWindow}
                  className="titlebar-window-btn danger"
                  title={t("titlebar.close")}
                  aria-label={t("titlebar.close")}
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            }
          />
        )}
      </div>
    );
  }

  return (
    <div className={`app-root ${isWindowMaximized ? "window-maximized" : ""}`}>
      <AppTitleBar
        titlebarContextTitle={titlebarContextTitle}
        titlebarContextLabel={titlebarContextLabel}
        isConnected={isConnected}
        activeConn={activeConn}
        isWindowMaximized={isWindowMaximized}
        isWindowFocused={isWindowFocused}
        isWindowMenuOpen={isWindowMenuOpen}
        activeWindowMenuSection={activeWindowMenuSection}
        activeWindowMenuItemPath={activeWindowMenuItemPath}
        windowMenuRef={windowMenuRef}
        windowMenuSections={windowMenuSections}
        onToggleSidebar={handleToggleSidebar}
        onOpenAISettings={() => setShowAISettings(true)}
        onToggleMaximizeWindow={handleToggleMaximizeWindow}
        onMinimizeWindow={handleMinimizeWindow}
        onCloseWindow={handleCloseWindow}
        onToggleWindowMenu={handleToggleWindowMenu}
        onSetActiveWindowMenuSection={setActiveWindowMenuSection}
        onSetActiveWindowMenuItemPath={setActiveWindowMenuItemPath}
        isDesktopWindow={isDesktopWindow}
        t={t}
      />

      <AppWorkspacePanel
        tabs={tabs}
        activeTab={activeTab}
        visibleTabs={visibleTabs}
        isConnected={isConnected}
        isSidebarCollapsed={isSidebarCollapsed}
        sidebarWidth={sidebarWidth}
        leftPanel={leftPanel}
        isMetricsWorkspace={isMetricsWorkspace}
        activeConn={activeConn}
        currentDatabase={currentDatabase}
        activeDatabaseLabel={activeDatabaseLabel}
        activeQueryChrome={activeQueryChrome}
        activeWorkspaceActivity={activeWorkspaceActivity}
        querySessionByTab={querySessionByTab}
        queryRunRequestByTab={queryRunRequestByTab}
        error={error}
        onClearError={clearError}
        onNewQuery={handleNewQuery}
        onClearVisibleTabs={handleClearVisibleTabs}
        onRefreshWorkspace={handleRefreshWorkspace}
        onOpenMetricsBoard={handleOpenMetricsBoard}
        onOpenConnectionForm={handleOpenConnectionForm}
        onFocusExplorerSearch={handleFocusExplorerSearch}
        onOpenAISlidePanel={handleOpenAISlidePanel}
        onHandleShowDatabaseWorkspace={handleShowDatabaseWorkspace}
        onHandleQueryChromeChange={handleQueryChromeChange}
        onHandleQuerySessionChange={handleQuerySessionChange}
        onRunActiveQuery={handleRunActiveQuery}
        onToggleSidebar={handleToggleSidebar}
        onSetIsSidebarCollapsed={setIsSidebarCollapsed}
        onSetLeftPanel={setLeftPanel}
        onSetConnectionFormIntent={setConnectionFormIntent}
        onHandleMouseDown={handleMouseDown}
      />

      <AppKeyboardHandler
        activeTab={activeTab}
        onNewQuery={handleNewQuery}
        onOpenAISlidePanel={handleOpenAISlidePanel}
        onToggleSidebar={handleToggleSidebar}
        setUiFontScale={setUiFontScale}
        setShowAISlidePanel={setShowAISlidePanel}
      />

      {connectionFormIntent && (
        <Suspense fallback={null}>
          <ConnectionForm
            initialIntent={connectionFormIntent}
            embeddedInStartupShell={false}
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
        <AppAboutModal onClose={() => setShowAboutModal(false)} />
      )}
      {showKeyboardShortcutsModal && (
        <AppShortcutsModal onClose={() => setShowKeyboardShortcutsModal(false)} />
      )}
      {showStartupConnectionManager && !isConnected && !connectionFormIntent && (
        <StartupConnectionManager
          onNewConnection={() => handleOpenConnectionForm("connect")}
          windowControls={
            <div className="titlebar-window-controls startup-window-controls" data-no-window-drag="true">
              <button
                type="button"
                onClick={handleMinimizeWindow}
                className="titlebar-window-btn"
                title={t("titlebar.minimize")}
                aria-label={t("titlebar.minimize")}
              >
                <ChevronRight className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={handleToggleMaximizeWindow}
                className="titlebar-window-btn"
                title={isWindowMaximized ? t("titlebar.restore") : t("titlebar.maximize")}
                aria-label={isWindowMaximized ? t("titlebar.restore") : t("titlebar.maximize")}
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={handleCloseWindow}
                className="titlebar-window-btn danger"
                title={t("titlebar.close")}
                aria-label={t("titlebar.close")}
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          }
        />
      )}
      {showAISlidePanel && (
        <Suspense fallback={null}>
          <ErrorBoundary onReset={() => setShowAISlidePanel(false)} fallback={null}>
            <AISlidePanel
              isOpen={showAISlidePanel}
              initialPrompt={aiPanelDraft?.prompt ?? ""}
              initialPromptNonce={aiPanelDraft?.nonce ?? 0}
              onClose={() => setShowAISlidePanel(false)}
            />
          </ErrorBoundary>
        </Suspense>
      )}
    </div>
  );
}

function getLastPathSegment(value?: string | null) {
  if (!value) return "";
  const normalized = value.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] || value;
}

export default App;
