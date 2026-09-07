import { useCallback, useRef, type MouseEvent as ReactMouseEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { useConnectionStore } from "../stores/connectionStore";
import { useUIStore } from "../stores/uiStore";
import { useModalStore } from "../stores/modalStore";
import { useAppLayoutStore } from "../stores/appLayoutStore";
import { ThemeEngine, type ThemeDefinition } from "../stores/useTheme";
import { useEditorPreferencesStore } from "../stores/editorPreferencesStore";
import type { AppLanguagePreference, TranslationKey } from "../i18n";
import type { DatabaseType, Tab } from "../types";
import { getAdminQueryPreset, type AdminQueryKind } from "../utils/admin-query-presets";
import { getNewQueryTabTitle, getQueryProfile } from "../utils/query-profile";
import { DEFAULT_WINDOW_MENU_SECTION, type WindowMenuSectionKey } from "../types/app-types";
import { UI_FONT_SCALE_MAX, UI_FONT_SCALE_MIN, UI_FONT_SCALE_STEP } from "../utils/ui-scale";
import { useAppMenuActions } from "./useAppMenuActions";
import { useWindowMenu } from "./useWindowMenu";
import { useWindowMenuDismiss } from "./useWindowMenuDismiss";
import { useDatabaseFileActions } from "./useDatabaseFileActions";
import { useAIMetricsBoardActions } from "./useAIMetricsBoardActions";

interface WorkspaceMenuHandlerInputs {
  activeTab: { type: string; id: string; content?: string } | null;
  activeConn: { name?: string; host?: string; db_type: DatabaseType } | undefined;
  activeConnectionId: string | null;
  currentDatabase: string | null;
  tabs: { id: string; type: string; connectionId?: string; database?: string }[];
  language: string;
  isConnected: boolean;
  addTab: (tab: Tab) => void;
  setActiveTab: (id: string) => void;
  requestQueryRun: (tabId: string) => void;
  setError: (message: string) => void;
  clearError: () => void;
  t: (key: TranslationKey, opts?: Record<string, string | number>) => string;
  setLanguage: (value: AppLanguagePreference) => void;
  queryTabCount: number;
  fetchDatabases: (id: string) => Promise<void>;
  fetchTables: (id: string, db?: string) => Promise<void>;
  fetchSchemaObjects: (id: string, db?: string) => Promise<void>;
  activateTheme: (theme: ThemeDefinition) => void;
  showAISlidePanel: boolean;
  setShowAISlidePanel: (value: boolean | ((current: boolean) => boolean)) => void;
  aiPanelDraft: { prompt: string; nonce: number } | null;
  setAiPanelDraft: (value: { prompt: string; nonce: number } | null) => void;
  aiPanelAttachment: { text: string; source: string; boardId?: string; nonce: number } | null;
  setAiPanelAttachment: (value: { text: string; source: string; boardId?: string; nonce: number } | null) => void;
  setIsWindowMenuOpen: (value: boolean | ((current: boolean) => boolean)) => void;
  setActiveWindowMenuSection: (value: WindowMenuSectionKey | null) => void;
  setActiveWindowMenuItemPath: (value: string | null) => void;
  setUiFontScale: (value: number | ((current: number) => number)) => void;
  applyDesktopWindowProfile: (profile: "form" | "launcher" | "workspace") => Promise<void>;

  handleCloseWindow: () => void;
  isWindowMenuOpen: boolean;
  setShowAISettings: (value: boolean) => void;
  setShowPluginManager: (value: boolean) => void;
  setShowMcpIntegrations: (value: boolean) => void;
  setShowAboutModal: (value: boolean) => void;
  setShowKeyboardShortcutsModal: (value: boolean) => void;
  setShowConnectionExporter: (value: boolean) => void;
  setShowConnectionImporter: (value: boolean) => void;
  uiFontScale: number;
  languagePreference: AppLanguagePreference;
  connections: { id: string }[];
  activeWindowMenuSection: WindowMenuSectionKey | null;
  activeWindowMenuItemPath: string | null;
  supportsSqlFileActions: boolean;
  setShowUserRoleManagement: (value: boolean) => void;
}

// Roadmap Phase 1A: window-menu / workspace handlers extracted verbatim from
// App.tsx. App keeps only the destructure and JSX composition.
export function useWorkspaceMenuHandlers(inputs: WorkspaceMenuHandlerInputs) {
  const {
    activeTab, activeConn, activeConnectionId, currentDatabase, tabs, language, isConnected,
    addTab, setActiveTab, requestQueryRun, setError, clearError, t, setLanguage, queryTabCount,
    showAISlidePanel, setShowAISlidePanel, aiPanelDraft, setAiPanelDraft, aiPanelAttachment, setAiPanelAttachment,
    setIsWindowMenuOpen, setActiveWindowMenuSection, setActiveWindowMenuItemPath, setUiFontScale,
    fetchDatabases, fetchTables, fetchSchemaObjects, activateTheme, applyDesktopWindowProfile,
    handleCloseWindow, setShowUserRoleManagement, isWindowMenuOpen,
    setShowAISettings, setShowPluginManager, setShowMcpIntegrations, setShowAboutModal,
    setShowKeyboardShortcutsModal, setShowConnectionExporter, setShowConnectionImporter,
    uiFontScale, languagePreference, connections,
    activeWindowMenuSection, activeWindowMenuItemPath, supportsSqlFileActions,
  } = inputs;
  const modalSetters = useModalStore(useShallow((state) => ({
    setConnectionFormIntent: state.setConnectionFormIntent,
    setShowStartupConnectionManager: state.setShowStartupConnectionManager,
    setShowThemeCustomizer: state.setShowThemeCustomizer,
  })));
  const { setConnectionFormIntent, setShowStartupConnectionManager, setShowThemeCustomizer } = modalSetters;
  const layoutSetters = useAppLayoutStore(useShallow((state) => ({
    setShowTerminalPanel: state.setShowTerminalPanel,
    setShowQueryHistory: state.setShowQueryHistory,
    setShowSQLFavorites: state.setShowSQLFavorites,
    setShowRowInspector: state.setShowRowInspector,
    setRowInspectorData: state.setRowInspectorData,
    setForceLauncherVisible: state.setForceLauncherVisible,
    setIsSidebarCollapsed: state.setIsSidebarCollapsed,
    setLeftPanel: state.setLeftPanel,
  })));
  const { setShowTerminalPanel, setShowQueryHistory, setShowSQLFavorites, setShowRowInspector, setRowInspectorData, setForceLauncherVisible, setIsSidebarCollapsed, setLeftPanel } = layoutSetters;
  const toggleVimMode = useEditorPreferencesStore((state) => state.toggleVimMode);
  const windowMenuRef = useRef<HTMLDivElement | null>(null);
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
    const leavingConnectionId = currentState.activeConnectionId;

    useConnectionStore.setState({
      activeConnectionId: null,
      connectedIds: leavingConnectionId
        ? new Set([...currentState.connectedIds].filter((id) => id !== leavingConnectionId))
        : currentState.connectedIds,
      currentDatabase: null,
      databases: [],
      tables: [],
      schemaObjects: [],
      isConnecting: false,
    });
    if (leavingConnectionId && currentState.connectedIds.has(leavingConnectionId)) {
      void currentState.disconnectFromDatabase(leavingConnectionId, { keepTabs: true });
    }
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

  const menuActions = useAppMenuActions({
    activeTab,
    handleOpenDatabaseFile,
    handleImportSqlFile,
    handleImportSqlIntoCurrentDatabase,
    handleExportDatabase,
    handleOpenMetricsBoard,
    handleCloseWindow,
    handleNewQuery,
    handleToggleSidebar,
    handleToggleTerminalPanel,
    setShowTerminalPanel,
    handleFocusExplorerSearch,
    handleShowDatabaseWorkspace,
    handleRefreshWorkspace,
    handleSearchInDatabaseFromMenu,
    handleSetFontSizeFromMenu,
    handleIncreaseFontSizeInline,
    handleDecreaseFontSizeInline,
    handleActivateThemeFromMenu,
    setShowUserRoleManagement,
    handleOpenAdminQuery,
    setShowAISettings,
    setShowAISlidePanel,
    handleOpenAISlidePanel,
    setShowPluginManager,
    setShowMcpIntegrations,
    setShowAboutModal,
    setShowKeyboardShortcutsModal,
    setShowQueryHistory,
    setShowConnectionExporter,
    setShowConnectionImporter,
    handleChangeLanguage,
    handleWindowMenuClose,
  });

  const { menuSections } = useWindowMenu({
    state: {
      isConnected,
      activeConnectionId,
      supportsSqlFileActions,
      activeTabType: activeTab?.type,
      uiFontScale,
      languagePreference,
      connectionsCount: connections.length,
    },
    actions: menuActions,
  });
  return {
    isWindowMenuOpen, setIsWindowMenuOpen, activeWindowMenuSection, setActiveWindowMenuSection, activeWindowMenuItemPath, setActiveWindowMenuItemPath,
    windowMenuRef, aiPanelDraft, aiPanelAttachment, showAISlidePanel, setShowAISlidePanel, uiFontScale, setUiFontScale,
    handleNewQuery, handleOpenConnectionForm, handleCloseConnectionForm, handleGoToLauncher, handleToggleWindowMenu,
    handleRefreshWorkspace, handleFocusExplorerSearch, handleOpenMetricsBoard, handleImportSqlFile, handleImportSqlIntoCurrentDatabase,
    handleOpenDatabaseFile, handleExportDatabase, isExportingDatabase, handleOpenAIMetricsBoard, handleOpenAdminQuery,
    handleOpenAISlidePanel, handleToggleSidebar, handleOpenThemeCustomizer, handleWindowMenuClose, handleToggleTerminalPanel,
    handleShowDatabaseWorkspace, handleSearchInDatabaseFromMenu, handleClearVisibleTabs, handleToggleQueryHistory,
    handleToggleSQLFavorites, handleRunQueryFromHistory, handleRunQueryFromFavorites, handleChangeLanguage, handleActivateThemeFromMenu,
    supportsSqlFileActions, windowMenuSections: menuSections, toggleVimMode,
  };
}