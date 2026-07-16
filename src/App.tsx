import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  lazy,
  Suspense,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  Copy,
  Minus,
  Square,
  X,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useConnectionStore } from "./stores/connectionStore";
import { useGlobalErrorStore } from "./stores/globalErrorStore";
import { useUIStore } from "./stores/uiStore";
import { EventCenter } from "./stores/event-center";
import { getLastPathSegment } from "./utils/path-utils";
import { ThemeEngine, useTheme } from "./stores/useTheme";
import { useEditorPreferencesStore } from "./stores/editorPreferencesStore";
import { useI18n, type AppLanguagePreference } from "./i18n";
import { StartupConnectionManager } from "./components/StartupConnectionManager";

import { AppTitleBar } from "./components/AppTitleBar";
import { AppKeyboardHandler } from "./components/AppKeyboardHandler";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useCommandPaletteStore } from "./stores/commandPaletteStore";
import { useQuickSwitcherStore } from "./stores/quickSwitcherStore";
import { getAdminQueryPreset, type AdminQueryKind } from "./utils/admin-query-presets";
import { getNewQueryTabTitle, getQueryProfile } from "./utils/query-profile";
import { UI_FONT_SCALE_MAX, UI_FONT_SCALE_MIN, UI_FONT_SCALE_STEP } from "./utils/ui-scale";
import { useConnectionHealthMonitor } from "./hooks/useConnectionHealthMonitor";
import { useDeepLink } from "./hooks/useDeepLink";
import { useWindowMenu } from "./hooks/useWindowMenu";
import { useTabPersistence } from "./hooks/useTabPersistence";
import { useDesktopWindow } from "./hooks/useDesktopWindow";
import { useSidebarResize } from "./hooks/useSidebarResize";
import {
  useWorkspaceEventBridge,
} from "./hooks/useWorkspaceEventBridge";
import { useWorkspaceShellSync } from "./hooks/useWorkspaceShellSync";
import { useAppNotifications } from "./hooks/useAppNotifications";
import { useRecoverableConnectionError } from "./hooks/useRecoverableConnectionError";
import { useDatabaseFileActions } from "./hooks/useDatabaseFileActions";
import { useQueryWorkspaceState } from "./hooks/useQueryWorkspaceState";
import { useAIMetricsBoardActions } from "./hooks/useAIMetricsBoardActions";
import { useDeferredAppSurfaces } from "./hooks/useDeferredAppSurfaces";
import { useRowInspectorEvents } from "./hooks/useRowInspectorEvents";
import { useWindowMenuDismiss } from "./hooks/useWindowMenuDismiss";
import { GlobalToastRegion } from "./components/layout/GlobalToastRegion";
import "./index.css";
import "./App.css";

import {
  WorkspaceActivityState,
  type WindowMenuSectionKey,
  UI_FONT_SCALE_STORAGE_KEY,
  DEFAULT_WINDOW_MENU_SECTION,
} from "./types/app-types";

const AISlidePanel = lazy(() => import("./components/AISlidePanel/AISlidePanel").then((module) => ({ default: module.AISlidePanel })));
const ConnectionForm = lazy(() =>
  import("./components/ConnectionForm").then((module) => ({ default: module.ConnectionForm })),
);
const AppGlobalModals = lazy(() =>
  import("./components/layout/AppGlobalModals").then((module) => ({ default: module.AppGlobalModals })),
);
const AppWorkspacePanel = lazy(() =>
  import("./components/AppWorkspacePanel").then((module) => ({ default: module.AppWorkspacePanel })),
);
const QueryHistoryPanel = lazy(() =>
  import("./components/QueryHistory/QueryHistoryPanel").then((module) => ({ default: module.QueryHistoryPanel })),
);
const SQLFavoritesPanel = lazy(() =>
  import("./components/SQLFavorites/SQLFavoritesPanel").then((module) => ({ default: module.SQLFavoritesPanel })),
);
const RowInspector = lazy(() =>
  import("./components/RowInspector/RowInspector").then((module) => ({ default: module.RowInspector })),
);

import { WorkspaceBootFallback } from "./components/layout/WorkspaceBootFallback";
import { WorkspaceErrorFallback } from "./components/layout/WorkspaceErrorFallback";
import { useModalStore } from "./stores/modalStore";
import { useAppLayoutStore } from "./stores/appLayoutStore";

function App() {
  useConnectionHealthMonitor();
  const { language, languagePreference, setLanguage, t } = useI18n();
  const { theme: _activeTheme, activateTheme } = useTheme();
  const {
    activeConnectionId,
    connectedIds,
    connections,
    currentDatabase,
    isConnecting,
    connectionHealth,
    loadSavedConnections,
    fetchDatabases,
    fetchTables,
    fetchSchemaObjects,
  } = useConnectionStore(
    useShallow((state) => ({
      activeConnectionId: state.activeConnectionId,
      connectedIds: state.connectedIds,
      connections: state.connections,
      currentDatabase: state.currentDatabase,
      isConnecting: state.isConnecting,
      connectionHealth: state.connectionHealth,
      loadSavedConnections: state.loadSavedConnections,
      fetchDatabases: state.fetchDatabases,
      fetchTables: state.fetchTables,
      fetchSchemaObjects: state.fetchSchemaObjects,
    }))
  );
  const { error, clearError, setError } = useGlobalErrorStore(
    useShallow((state) => ({
      error: state.error,
      clearError: state.clearError,
      setError: state.setError,
    })),
  );
  const { tabs, activeTabId, addTab, setActiveTab } = useUIStore(
    useShallow((state) => ({
      tabs: state.tabs,
      activeTabId: state.activeTabId,
      addTab: state.addTab,
      setActiveTab: state.setActiveTab,
    })),
  );

  const {
    connectionFormIntent, setConnectionFormIntent,
    showStartupConnectionManager, setShowStartupConnectionManager,
    showAISettings, setShowAISettings,
    showAboutModal, setShowAboutModal,
    showPluginManager, setShowPluginManager,
    showMcpIntegrations, setShowMcpIntegrations,
    showUserRoleManagement, setShowUserRoleManagement,
    showKeyboardShortcutsModal, setShowKeyboardShortcutsModal,
    showThemeCustomizer, setShowThemeCustomizer,
    showConnectionExporter, setShowConnectionExporter,
    showConnectionImporter, setShowConnectionImporter
  } = useModalStore();

  const {
    showTerminalPanel, setShowTerminalPanel,
    showQueryHistory, setShowQueryHistory,
    showSQLFavorites, setShowSQLFavorites,
    showRowInspector, setShowRowInspector,
    rowInspectorData, setRowInspectorData,
    leftPanel, setLeftPanel,
    isSidebarCollapsed, setIsSidebarCollapsed,
    sidebarWidth, setSidebarWidth,
    isWindowMaximized,
    isWindowFocused,
    forceLauncherVisible, setForceLauncherVisible
  } = useAppLayoutStore();

  const [showAISlidePanel, setShowAISlidePanel] = useState(false);
  const [aiPanelDraft, setAiPanelDraft] = useState<{ prompt: string; nonce: number } | null>(null);
  const [aiPanelAttachment, setAiPanelAttachment] = useState<{ text: string; source: string; boardId?: string; nonce: number } | null>(null);
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
    return Number.isFinite(stored) && stored >= UI_FONT_SCALE_MIN && stored <= UI_FONT_SCALE_MAX ? stored : 100;
  });
  const toggleVimMode = useEditorPreferencesStore((state) => state.toggleVimMode);
  const openCommandPalette = useCommandPaletteStore((state) => state.open);
  const isCommandPaletteOpen = useCommandPaletteStore((state) => state.isOpen);
  const openQuickSwitcher = useQuickSwitcherStore((state) => state.open);
  const isQuickSwitcherOpen = useQuickSwitcherStore((state) => state.isOpen);

  const windowMenuRef = useRef<HTMLDivElement | null>(null);
  const activeConn = connections.find((conn) => conn.id === activeConnectionId);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) || null;
  const {
    activeQueryChrome,
    querySessionByTab,
    queryRunRequestByTab,
    requestQueryRun,
    runActiveQuery: handleRunActiveQuery,
    handleQueryChromeChange,
    handleQuerySessionChange,
    openAIWorkspaceQuery: handleOpenAIWorkspaceQuery,
  } = useQueryWorkspaceState();
  const hasRenderableWorkspace = !!(activeConnectionId && activeConn && connectedIds.has(activeConnectionId));
  const isConnected = hasRenderableWorkspace;
  const { toast: globalToast, dismissToast: dismissGlobalToast } = useAppNotifications();
  const isRecoverableErrorDelayActive = useRecoverableConnectionError({
    error,
    isConnecting,
    setShowAIWorkspace: setShowAISlidePanel,
    setActiveWindowMenuSection,
  });
  const {
    isDesktopWindow,
    applyDesktopWindowProfile,
    minimizeWindow: handleMinimizeWindow,
    toggleMaximizeWindow: handleToggleMaximizeWindow,
    closeWindow: handleCloseWindow,
  } = useDesktopWindow({
    isConnected,
    isConnecting,
    isConnectionFormOpen: !!connectionFormIntent,
    suspendProfileSync: isRecoverableErrorDelayActive,
  });
  const handleMouseDown = useSidebarResize({
    isCollapsed: isSidebarCollapsed,
    width: sidebarWidth,
    setWidth: setSidebarWidth,
  });
  const shouldForceStartupLauncher =
    !isRecoverableErrorDelayActive &&
    !isConnecting &&
    !connectionFormIntent &&
    (!activeConnectionId || !activeConn || !connectedIds.has(activeConnectionId));
  const showStartupShell =
    forceLauncherVisible ||
    (!isRecoverableErrorDelayActive &&
      (shouldForceStartupLauncher ||
        (!isConnected && !isConnecting && (showStartupConnectionManager || !!connectionFormIntent))));
  const isMetricsWorkspace = activeTab?.type === "metrics";
  const activeWorkspaceActivity =
    activeConnectionId ? workspaceActivityByConnection[activeConnectionId] ?? null : null;
  const activeQueryProfile = getQueryProfile(activeConn?.db_type);
  const supportsSqlFileActions = !!(activeConnectionId && activeConn && activeQueryProfile.surface === "sql");
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
  const shouldMountGlobalModalsNow =
    showAISettings ||
    showAboutModal ||
    showPluginManager ||
    showMcpIntegrations ||
    showUserRoleManagement ||
    showKeyboardShortcutsModal ||
    showThemeCustomizer ||
    showConnectionExporter ||
    showConnectionImporter ||
    isCommandPaletteOpen ||
    isQuickSwitcherOpen;
  const {
    hasMountedAIWorkspace: hasMountedAISlidePanel,
    hasMountedGlobalModals,
  } = useDeferredAppSurfaces(showAISlidePanel, shouldMountGlobalModalsNow);
  const shouldRenderGlobalModals = hasMountedGlobalModals || shouldMountGlobalModalsNow;
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  useEffect(() => {
    document.documentElement.style.fontSize = `${uiFontScale}%`;
    if (typeof window !== "undefined") {
      window.localStorage.setItem(UI_FONT_SCALE_STORAGE_KEY, String(uiFontScale));
    }
  }, [uiFontScale]);

  const handleRowInspectorClose = useRowInspectorEvents();

  const handleNewQuery = useCallback(() => {
    if (!activeConnectionId) return;

    const nextIndex = queryTabCount + 1;
    const queryProfile = getQueryProfile(activeConn?.db_type);
    addTab({
      id: `query-${crypto.randomUUID()}`,
      type: "query",
      title: getNewQueryTabTitle(activeConn?.db_type, nextIndex),
      connectionId: activeConnectionId,
      database: currentDatabase || undefined,
      content: queryProfile.defaultContent,
    });
  }, [activeConn?.db_type, activeConnectionId, addTab, currentDatabase, queryTabCount]);

  const handleOpenConnectionForm = useCallback(
    (intent: "connect" | "bootstrap") => {
      setShowStartupConnectionManager(false);
      setConnectionFormIntent(intent);
      void applyDesktopWindowProfile("form").catch((e) =>
        console.error("[WindowProfile] failed to apply form profile:", e),
      );
    },
    [applyDesktopWindowProfile],
  );

  const handleCloseConnectionForm = useCallback(() => {
    const { activeConnectionId: latestActiveConnectionId, connectedIds: latestConnectedIds } =
      useConnectionStore.getState();

    setConnectionFormIntent(null);
    if (!latestActiveConnectionId || !latestConnectedIds.has(latestActiveConnectionId)) {
      setShowStartupConnectionManager(true);
      void applyDesktopWindowProfile("launcher").catch((e) =>
        console.error("[WindowProfile] failed to apply launcher profile:", e),
      );
    }
  }, [applyDesktopWindowProfile]);

  const handleGoToLauncher = useCallback(() => {
    const currentState = useConnectionStore.getState();
    const nextConnectedIds = new Set(currentState.connectedIds);
    if (currentState.activeConnectionId) {
      nextConnectedIds.delete(currentState.activeConnectionId);
    }

    useConnectionStore.setState({
      activeConnectionId: null,
      connectedIds: nextConnectedIds,
      currentDatabase: null,
      databases: [],
      tables: [],
      schemaObjects: [],
      isConnecting: false,
    });
    clearError();

    setShowStartupConnectionManager(true);
    setConnectionFormIntent(null);
    setShowAISlidePanel(false);
    setShowTerminalPanel(false);
    setShowQueryHistory(false);
    setShowSQLFavorites(false);
    setShowRowInspector(false);
    setRowInspectorData(null);
    setForceLauncherVisible(true);
    setIsWindowMenuOpen(false);
    setActiveWindowMenuSection(null);
    setActiveWindowMenuItemPath(null);
    clearError();

    void applyDesktopWindowProfile("launcher").catch((e) =>
      console.error("[WindowProfile] failed to apply launcher profile:", e),
    );
  }, [
    applyDesktopWindowProfile,
    clearError,
    setConnectionFormIntent,
    setForceLauncherVisible,
    setRowInspectorData,
    setShowAISlidePanel,
    setShowQueryHistory,
    setShowRowInspector,
    setShowSQLFavorites,
    setShowStartupConnectionManager,
    setShowTerminalPanel,
  ]);

  const handleToggleWindowMenu = useCallback((event?: ReactMouseEvent<HTMLElement>) => {
    event?.stopPropagation();
    setIsWindowMenuOpen((current) => {
      const next = !current;
      if (next) {
        setActiveWindowMenuSection(DEFAULT_WINDOW_MENU_SECTION);
    
      }
      return next;
    });
  }, []);

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

  const {
    importSqlFile: handleImportSqlFile,
    importSqlIntoCurrentDatabase: handleImportSqlIntoCurrentDatabase,
    openDatabaseFile: handleOpenDatabaseFile,
    exportDatabase: handleExportDatabase,
    isExportingDatabase,
  } = useDatabaseFileActions(language);

  const handleChangeLanguage = useCallback(
    (nextLanguage: AppLanguagePreference) => {
      setLanguage(nextLanguage);
    },
    [setLanguage],
  );

  const handleSetFontSizeFromMenu = useCallback((next: number) => {
    const normalized = Math.min(
      UI_FONT_SCALE_MAX,
      Math.max(UI_FONT_SCALE_MIN, Math.round(next / UI_FONT_SCALE_STEP) * UI_FONT_SCALE_STEP),
    );
    setUiFontScale(normalized);
  }, []);

  const handleIncreaseFontSizeInline = useCallback(() => {
    setUiFontScale((current) => Math.min(UI_FONT_SCALE_MAX, current + UI_FONT_SCALE_STEP));
  }, []);

  const handleDecreaseFontSizeInline = useCallback(() => {
    setUiFontScale((current) => Math.max(UI_FONT_SCALE_MIN, current - UI_FONT_SCALE_STEP));
  }, []);

  const handleToggleTerminalPanel = useCallback(() => {
    setShowTerminalPanel((current) => !current);
  }, []);

  const handleShowDatabaseWorkspace = useCallback(() => {
    if (!isConnected) return;

    setIsSidebarCollapsed(false);
    setLeftPanel("database");

    const isDatabaseWorkspaceTab = (tab: { type: string }) =>
      tab.type !== "metrics" && tab.type !== "er-diagram";

    const currentDatabaseKey = currentDatabase || "";
    const candidateTab =
      [...tabs]
        .reverse()
        .find(
          (tab) =>
            isDatabaseWorkspaceTab(tab) &&
            tab.connectionId === activeConnectionId &&
            (tab.database || "") === currentDatabaseKey,
        ) ||
      [...tabs]
        .reverse()
        .find((tab) => isDatabaseWorkspaceTab(tab) && tab.connectionId === activeConnectionId) ||
      [...tabs].reverse().find((tab) => isDatabaseWorkspaceTab(tab));

    if (candidateTab) {
      setActiveTab(candidateTab.id);
      return;
    }

    handleNewQuery();
  }, [activeConnectionId, currentDatabase, handleNewQuery, isConnected, setActiveTab, tabs]);

  const handleSearchInDatabaseFromMenu = useCallback(() => {
    handleShowDatabaseWorkspace();
    window.setTimeout(() => {
      handleFocusExplorerSearch();
    }, 0);
  }, [handleFocusExplorerSearch, handleShowDatabaseWorkspace]);

  const handleClearVisibleTabs = useCallback(() => {
    useUIStore.getState().clearTabs();
  }, []);

  const handleToggleQueryHistory = useCallback(() => {
    setShowQueryHistory((current) => !current);
  }, []);

  const handleToggleSQLFavorites = useCallback(() => {
    setShowSQLFavorites((current) => !current);
  }, []);

  const handleRunQueryFromHistory = useCallback((sql: string) => {
    window.dispatchEvent(new CustomEvent("insert-sql-from-ai", { detail: { sql } }));
    setShowQueryHistory(false);
  }, []);

  const handleRunQueryFromFavorites = useCallback((sql: string) => {
    window.dispatchEvent(new CustomEvent("insert-sql-from-ai", { detail: { sql } }));
    setShowSQLFavorites(false);
  }, []);

  const handleOpenAIMetricsBoard = useAIMetricsBoardActions(language);

  const handleOpenAdminQuery = useCallback(
    (kind: AdminQueryKind) => {
      if (!activeConnectionId || !activeConn) return;

      const preset = getAdminQueryPreset(activeConn.db_type, kind);
      const itemLabel =
        kind === "process-list" ? t("menu.item.processList") : t("menu.item.userManagement");

      if (!preset.supported || !preset.content.trim()) {
        setError(
          language === "vi"
            ? `${itemLabel.replace(/\.\.\.$/, "")}: ${preset.reason || "Chưa có preset phù hợp cho engine hiện tại."}`
            : `${itemLabel.replace(/\.\.\.$/, "")}: ${preset.reason || "No preset is available for the current engine."}`,
        );
    
    
        return;
      }

      const tabId = `query-${crypto.randomUUID()}`;
      const queryTitle = itemLabel.replace(/\.\.\.$/, "");

      addTab({
        id: tabId,
        type: "query",
        title: queryTitle,
        connectionId: activeConnectionId,
        database: currentDatabase || undefined,
        content: preset.content,
      });

      requestQueryRun(tabId);
  
  
    },
    [activeConn, activeConnectionId, addTab, currentDatabase, language, requestQueryRun, setError, t],
  );

  const handleOpenAISlidePanel = useCallback((prompt?: string, attachment?: { text: string; source: string; boardId?: string }) => {
    if (typeof prompt === "string" && prompt.trim()) {
      setAiPanelDraft({
        prompt,
        nonce: Date.now(),
      });
    }
    if (attachment?.text.trim()) {
      setAiPanelAttachment({
        text: attachment.text.trim(),
        source: attachment.source?.trim() || "Workspace attachment",
        boardId: attachment.boardId,
        nonce: Date.now(),
      });
    }
    setShowAISlidePanel(true);
  }, []);

  const handleActivateThemeFromMenu = useCallback(
    (themeId: string) => {
      const selectedTheme = ThemeEngine.getAvailableThemes().find((option) => option.id === themeId);
      if (!selectedTheme) return;
      activateTheme(selectedTheme);
    },
    [activateTheme],
  );

  const handleToggleSidebar = useCallback(() => {
    setIsSidebarCollapsed((collapsed) => !collapsed);
  }, []);

  const handleOpenThemeCustomizer = useCallback(() => {
    setShowThemeCustomizer(true);
  }, []);

  const handleWindowMenuClose = useCallback(() => {
    setIsWindowMenuOpen(false);
    setActiveWindowMenuItemPath(null);
  }, []);
  useWindowMenuDismiss(isWindowMenuOpen, windowMenuRef, handleWindowMenuClose);

  const menuActions = useMemo(() => ({
    onNewConnection: handleOpenConnectionForm.bind(null, "connect"),
    onOpenDatabaseFile: handleOpenDatabaseFile,
    onImportSqlFile: handleImportSqlFile,
    onImportSqlIntoCurrentDatabase: handleImportSqlIntoCurrentDatabase,
    onExportDatabase: handleExportDatabase,
    onOpenMetricsBoard: handleOpenMetricsBoard,
    onCloseWindow: handleCloseWindow,
    onNewQuery: handleNewQuery,
    onToggleSidebar: handleToggleSidebar,
    onToggleTerminalPanel: handleToggleTerminalPanel,
    onToggleQueryResultsPane: () => {
      if (activeTab?.type === "query") {
        window.dispatchEvent(new CustomEvent("toggle-query-results-pane", { detail: { tabId: activeTab.id } }));
      }
    },
    onToggleRightSidebar: () => setShowAISlidePanel((v) => !v),
    onToggleBottomSidebar: () => {
      if (activeTab?.type === "query") {
        window.dispatchEvent(new CustomEvent("toggle-query-results-pane", { detail: { tabId: activeTab.id } }));
      } else {
        setShowTerminalPanel((v) => !v);
      }
    },
    onFocusExplorerSearch: handleFocusExplorerSearch,
    onShowDatabaseWorkspace: handleShowDatabaseWorkspace,
    onRefreshWorkspace: handleRefreshWorkspace,
    onSearchInDatabase: handleSearchInDatabaseFromMenu,
    onSetFontSize: handleSetFontSizeFromMenu,
    onIncreaseFontSize: handleIncreaseFontSizeInline,
    onDecreaseFontSize: handleDecreaseFontSizeInline,
    onActivateTheme: handleActivateThemeFromMenu,
    onOpenUserManagement: () => setShowUserRoleManagement(true),
    onOpenProcessList: () => handleOpenAdminQuery("process-list"),
    onOpenAISettings: () => setShowAISettings(true),
    onOpenAISlidePanel: () => handleOpenAISlidePanel(),
    onOpenPluginManager: () => setShowPluginManager(true),
    onOpenMcpIntegrations: () => setShowMcpIntegrations(true),
    onOpenAboutModal: () => setShowAboutModal(true),
    onOpenKeyboardShortcuts: () => setShowKeyboardShortcutsModal(true),
    onToggleQueryHistory: () => setShowQueryHistory((v) => !v),
    onOpenConnectionExporter: () => setShowConnectionExporter(true),
    onOpenConnectionImporter: () => setShowConnectionImporter(true),
    onChangeLanguage: handleChangeLanguage,
    onWindowMenuClose: handleWindowMenuClose,
  }), [activeTab, handleActivateThemeFromMenu, handleChangeLanguage, handleCloseWindow, handleFocusExplorerSearch, handleIncreaseFontSizeInline, handleNewQuery, handleOpenAdminQuery, handleOpenAISlidePanel, handleOpenConnectionForm, handleOpenDatabaseFile, handleOpenMetricsBoard, handleRefreshWorkspace, handleSearchInDatabaseFromMenu, handleSetFontSizeFromMenu, handleToggleTerminalPanel, handleWindowMenuClose, handleImportSqlFile, handleImportSqlIntoCurrentDatabase, handleExportDatabase, handleToggleSidebar, handleShowDatabaseWorkspace, handleDecreaseFontSizeInline, setShowMcpIntegrations, setShowUserRoleManagement]);

  const { menuSections: windowMenuSections } = useWindowMenu({
    state: {
      isConnected,
      supportsSqlFileActions,
      activeTabType: activeTab?.type,
      uiFontScale,
      languagePreference,
      connectionsCount: connections.length,
    },
    actions: menuActions,
  });

  useEffect(() => {
    void loadSavedConnections();
  }, [loadSavedConnections]);

  useTabPersistence(activeConnectionId, connectedIds);

  useDeepLink(isDesktopWindow);

  useWorkspaceEventBridge({
    openAI: handleOpenAISlidePanel,
    openAIWorkspaceQuery: handleOpenAIWorkspaceQuery,
    openAIMetricsBoard: handleOpenAIMetricsBoard,
    setWorkspaceActivity: setWorkspaceActivityByConnection,
  });

  useWorkspaceShellSync({
    activeConnectionId,
    connectedIds,
    isConnecting,
    isConnected,
    isConnectionFormOpen: !!connectionFormIntent,
    isRecoveryDelayActive: isRecoverableErrorDelayActive,
    activeTabType: activeTab?.type,
    setShowAIWorkspace: setShowAISlidePanel,
    setActiveWindowMenuSection,
  });

  const globalToastMarkup = (
    <GlobalToastRegion
      toast={globalToast}
      language={language}
      onDismiss={dismissGlobalToast}
    />
  );

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

        {showStartupConnectionManager && !isConnected && !isConnecting && !connectionFormIntent && (
          <StartupConnectionManager
            onNewConnection={() => handleOpenConnectionForm("connect")}
            onOpenDatabaseFile={handleOpenDatabaseFile}
            windowControls={
              <div className="titlebar-window-controls startup-window-controls" data-no-window-drag="true">
                <button
                  type="button"
                  onClick={handleMinimizeWindow}
                  className="titlebar-window-btn"
                  title={t("titlebar.minimize")}
                  aria-label={t("titlebar.minimize")}
                >
                  <Minus className="w-4 h-4" />
                </button>
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
            }
          />
        )}
        {globalToastMarkup}
      </div>
    );
  }

  return (
    <div
      className={`app-root ${isWindowMaximized ? "window-maximized" : ""} ${showAISlidePanel ? "workspace-ai-open" : ""}`}
    >
      <AppTitleBar
        titlebarContextTitle={titlebarContextTitle}
        titlebarContextLabel={titlebarContextLabel}
        isConnected={isConnected}
        isHealthy={activeConnectionId ? (connectionHealth[activeConnectionId] ?? true) : true}
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

      <ErrorBoundary
        maxRetries={2}
        onMaxRetriesExceeded={handleGoToLauncher}
        fallback={(error, reset) => (
          <WorkspaceErrorFallback
            error={error}
            onRetry={reset}
            onGoToLauncher={handleGoToLauncher}
          />
        )}
      >
        <Suspense fallback={<WorkspaceBootFallback />}>
          <AppWorkspacePanel
            tabs={tabs}
            activeTab={activeTab}
            isConnected={isConnected}
            isConnecting={isConnecting}
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
            onExportDatabase={handleExportDatabase}
            onOpenMetricsBoard={handleOpenMetricsBoard}
            onFocusExplorerSearch={handleFocusExplorerSearch}
            onOpenAISlidePanel={handleOpenAISlidePanel}
            onHandleShowDatabaseWorkspace={handleShowDatabaseWorkspace}
            onHandleQueryChromeChange={handleQueryChromeChange}
            onHandleQuerySessionChange={handleQuerySessionChange}
            onRunActiveQuery={handleRunActiveQuery}
            showTerminalPanel={showTerminalPanel}
            isExportingDatabase={isExportingDatabase}
            onToggleTerminalPanel={handleToggleTerminalPanel}
            onGoToLauncher={handleGoToLauncher}
            onToggleSidebar={handleToggleSidebar}
            onSetConnectionFormIntent={setConnectionFormIntent}
            onHandleMouseDown={handleMouseDown}
          />
        </Suspense>
      </ErrorBoundary>

      <AppKeyboardHandler
        activeTab={activeTab}
        onNewQuery={handleNewQuery}
        onRunActiveQuery={handleRunActiveQuery}
        onToggleTerminalPanel={handleToggleTerminalPanel}
        onToggleSidebar={handleToggleSidebar}
        onToggleQueryHistory={handleToggleQueryHistory}
        onToggleSQLFavorites={handleToggleSQLFavorites}
        onToggleVimMode={toggleVimMode}
        onOpenCommandPalette={openCommandPalette}
        onOpenQuickSwitcher={openQuickSwitcher}
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
      {shouldRenderGlobalModals && (
        <Suspense fallback={null}>
          <AppGlobalModals
            showAISettings={showAISettings}
            setShowAISettings={setShowAISettings}
            showAboutModal={showAboutModal}
            setShowAboutModal={setShowAboutModal}
            showPluginManager={showPluginManager}
            setShowPluginManager={setShowPluginManager}
            showMcpIntegrations={showMcpIntegrations}
            setShowMcpIntegrations={setShowMcpIntegrations}
            showUserRoleManagement={showUserRoleManagement}
            setShowUserRoleManagement={setShowUserRoleManagement}
            showKeyboardShortcutsModal={showKeyboardShortcutsModal}
            setShowKeyboardShortcutsModal={setShowKeyboardShortcutsModal}
            showThemeCustomizer={showThemeCustomizer}
            setShowThemeCustomizer={setShowThemeCustomizer}
            showConnectionExporter={showConnectionExporter}
            setShowConnectionExporter={setShowConnectionExporter}
            showConnectionImporter={showConnectionImporter}
            setShowConnectionImporter={setShowConnectionImporter}
            connections={connections}
            activeConnectionId={activeConnectionId}
            handleToggleSidebar={handleToggleSidebar}
            setShowTerminalPanel={setShowTerminalPanel}
            handleRunActiveQuery={handleRunActiveQuery}
            handleToggleQueryHistory={handleToggleQueryHistory}
            handleToggleSQLFavorites={handleToggleSQLFavorites}
            handleOpenThemeCustomizer={handleOpenThemeCustomizer}
            setShowAISlidePanel={setShowAISlidePanel}
          />
        </Suspense>
      )}
      {showStartupConnectionManager && !isConnected && !isConnecting && !connectionFormIntent && (
        <StartupConnectionManager
          onNewConnection={() => handleOpenConnectionForm("connect")}
          onOpenDatabaseFile={handleOpenDatabaseFile}
          windowControls={
            <div className="titlebar-window-controls startup-window-controls" data-no-window-drag="true">
              <button
                type="button"
                onClick={handleMinimizeWindow}
                className="titlebar-window-btn"
                title={t("titlebar.minimize")}
                aria-label={t("titlebar.minimize")}
              >
                <Minus className="w-4 h-4" />
              </button>
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
          }
        />
      )}
      {(showAISlidePanel || hasMountedAISlidePanel) && (
        <Suspense fallback={null}>
          <ErrorBoundary onReset={() => setShowAISlidePanel(false)} fallback={null}>
            <AISlidePanel
              isOpen={showAISlidePanel}
              initialPrompt={aiPanelDraft?.prompt ?? ""}
              initialPromptNonce={aiPanelDraft?.nonce ?? 0}
              initialAttachment={aiPanelAttachment ? {
                text: aiPanelAttachment.text,
                source: aiPanelAttachment.source,
                boardId: aiPanelAttachment.boardId,
              } : undefined}
              initialAttachmentNonce={aiPanelAttachment?.nonce ?? 0}
              onClose={() => setShowAISlidePanel(false)}
            />
          </ErrorBoundary>
        </Suspense>
      )}
      {showQueryHistory && (
        <Suspense fallback={null}>
          <ErrorBoundary onReset={() => setShowQueryHistory(false)} fallback={null}>
            <QueryHistoryPanel
              isOpen={showQueryHistory}
              activeConnectionId={activeConnectionId}
              onClose={() => setShowQueryHistory(false)}
              onRunQuery={handleRunQueryFromHistory}
            />
          </ErrorBoundary>
        </Suspense>
      )}
      {showSQLFavorites && (
        <Suspense fallback={null}>
          <SQLFavoritesPanel
            isOpen={showSQLFavorites}
            onClose={() => setShowSQLFavorites(false)}
            onRunQuery={handleRunQueryFromFavorites}
            currentEditorSql={activeTab?.type === "query" ? activeTab.content : ""}
          />
        </Suspense>
      )}
      {showRowInspector && (
        <Suspense fallback={null}>
          <RowInspector
            isOpen={showRowInspector}
            data={rowInspectorData}
            onClose={handleRowInspectorClose}
            onEditCell={(columnName, value) => {
              if (rowInspectorData?.tableName && activeConnectionId) {
                void EventCenter.emit("row-inspector-edit-cell", { columnName, value });
              }
            }}
          />
        </Suspense>
      )}
      {globalToastMarkup}
    </div>
  );
}

export default App;
