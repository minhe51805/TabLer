import {
  useState,
  useEffect,
  lazy,
  Suspense,
} from "react";
import { AppStartupShell } from "./components/AppStartupShell";
import { useTheme } from "./stores/useTheme";
import { useEditorPreferencesStore } from "./stores/editorPreferencesStore";
import { useI18n } from "./i18n";

import { useCommandPaletteStore } from "./stores/commandPaletteStore";
import { useQuickSwitcherStore } from "./stores/quickSwitcherStore";
import { useGlobalSearchStore } from "./stores/globalSearchStore";
import { UI_FONT_SCALE_MAX, UI_FONT_SCALE_MIN } from "./utils/ui-scale";
import { useWorkspaceMenuHandlers } from "./hooks/useWorkspaceMenuHandlers";
import { useAppBoot } from "./hooks/useAppBoot";
import { WorkspaceOverlays } from "./components/layout/WorkspaceOverlays";
import { WorkspaceShell } from "./components/layout/WorkspaceShell";
import { useWorkspaceChromeState } from "./hooks/useWorkspaceChromeState";
import { useAppCoreStores } from "./hooks/useAppCoreStores";
import { useDesktopWindow } from "./hooks/useDesktopWindow";
import { useSidebarResize } from "./hooks/useSidebarResize";
import {
  useWorkspaceEventBridge,
} from "./hooks/useWorkspaceEventBridge";
import { useWorkspaceShellSync } from "./hooks/useWorkspaceShellSync";
import { useAppNotifications } from "./hooks/useAppNotifications";
import { useRecoverableConnectionError } from "./hooks/useRecoverableConnectionError";
import { useQueryWorkspaceState } from "./hooks/useQueryWorkspaceState";
import { useRowInspectorEvents } from "./hooks/useRowInspectorEvents";
import { GlobalToastRegion } from "./components/layout/GlobalToastRegion";
import "./index.css";
import "./App.css";

import {
  WorkspaceActivityState,
  type WindowMenuSectionKey,
  UI_FONT_SCALE_STORAGE_KEY,
} from "./types/app-types";

const ConnectionForm = lazy(() =>
  import("./components/ConnectionForm").then((module) => ({ default: module.ConnectionForm })),
);


function App() {
  const { language, languagePreference, setLanguage, t } = useI18n();
  const { theme: _activeTheme, activateTheme } = useTheme();
  const {
    connection: {
      activeConnectionId, connectedIds, connections, currentDatabase, isConnecting,
      fetchDatabases, fetchTables, fetchSchemaObjects,
    },
    errors: { error, clearError, setError },
    ui: { tabs, activeTabId, addTab, setActiveTab },
    modals: {
      connectionFormIntent, showStartupConnectionManager, showAISettings, setShowAISettings,
      showAboutModal, setShowAboutModal, showPluginManager, setShowPluginManager,
      showMcpIntegrations, setShowMcpIntegrations, showUserRoleManagement, setShowUserRoleManagement,
      showKeyboardShortcutsModal, setShowKeyboardShortcutsModal, showThemeCustomizer, setShowThemeCustomizer,
      showConnectionExporter, setShowConnectionExporter, showConnectionImporter, setShowConnectionImporter,
    },
    layout: {
      setShowTerminalPanel, showQueryHistory, setShowQueryHistory, showSQLFavorites, setShowSQLFavorites,
      showRowInspector, rowInspectorData, isSidebarCollapsed, sidebarWidth, setSidebarWidth,
      isWindowMaximized, forceLauncherVisible,
    },
  } = useAppCoreStores();

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
  const openGlobalSearch = useGlobalSearchStore((state) => state.open);

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
  const {
    showStartupShell, isMetricsWorkspace, activeWorkspaceActivity, supportsSqlFileActions,
    queryTabCount, activeDatabaseLabel, titlebarContextTitle, titlebarContextLabel,
    hasMountedAISlidePanel, shouldRenderGlobalModals,
  } = useWorkspaceChromeState({
    isRecoverableErrorDelayActive, isConnecting, connectionFormIntent, activeConnectionId,
    activeConn, connectedIds, forceLauncherVisible, showStartupConnectionManager, activeTab,
    workspaceActivityByConnection, currentDatabase, showAISettings, showAboutModal,
    showPluginManager, showMcpIntegrations, showUserRoleManagement, showKeyboardShortcutsModal,
    showThemeCustomizer, showConnectionExporter, showConnectionImporter, isCommandPaletteOpen,
    isQuickSwitcherOpen, showAISlidePanel, isConnected, tabs,
  });
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

  const {
    windowMenuRef, windowMenuSections,
    handleNewQuery, handleOpenConnectionForm, handleCloseConnectionForm, handleGoToLauncher, handleToggleWindowMenu,
    handleRefreshWorkspace, handleFocusExplorerSearch, handleOpenMetricsBoard, handleOpenDatabaseFile, handleExportDatabase,
    isExportingDatabase, handleOpenAIMetricsBoard, handleOpenAISlidePanel, handleToggleSidebar, handleOpenThemeCustomizer,
    handleToggleTerminalPanel, handleShowDatabaseWorkspace, handleClearVisibleTabs, handleToggleQueryHistory,
    handleToggleSQLFavorites, handleRunQueryFromHistory, handleRunQueryFromFavorites,
  } = useWorkspaceMenuHandlers({
    activeTab, activeConn, activeConnectionId, currentDatabase, tabs, language, isConnected,
    addTab, setActiveTab, requestQueryRun, setError, clearError, t, setLanguage,
    fetchDatabases, fetchTables, fetchSchemaObjects, activateTheme, applyDesktopWindowProfile,
    handleCloseWindow, setShowUserRoleManagement,
    showAISlidePanel, setShowAISlidePanel, aiPanelDraft, setAiPanelDraft, aiPanelAttachment, setAiPanelAttachment,
    setIsWindowMenuOpen, setActiveWindowMenuSection, setActiveWindowMenuItemPath, setUiFontScale,
    queryTabCount, isWindowMenuOpen,
    setShowAISettings, setShowPluginManager, setShowMcpIntegrations, setShowAboutModal,
    setShowKeyboardShortcutsModal, setShowConnectionExporter, setShowConnectionImporter,
    uiFontScale, languagePreference, connections, activeWindowMenuSection, activeWindowMenuItemPath,
    supportsSqlFileActions,
  });

  useAppBoot(activeConnectionId, connectedIds, isDesktopWindow);

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
      <AppStartupShell
        connectionFormIntent={connectionFormIntent ?? undefined}
        showStartupConnectionManager={showStartupConnectionManager}
        isConnected={isConnected}
        isConnecting={isConnecting}
        isWindowMaximized={isWindowMaximized}
        connectionFormElement={
          <Suspense fallback={null}>
            <ConnectionForm
              initialIntent={connectionFormIntent ?? undefined}
              embeddedInStartupShell
              onClose={handleCloseConnectionForm}
            />
          </Suspense>
        }
        onNewConnection={() => handleOpenConnectionForm("connect")}
        onOpenDatabaseFile={handleOpenDatabaseFile}
        onMinimizeWindow={handleMinimizeWindow}
        onToggleMaximizeWindow={handleToggleMaximizeWindow}
        onCloseWindow={handleCloseWindow}
        globalToastMarkup={globalToastMarkup}
      />
    );
  }

  return (
    <WorkspaceShell
      titlebarContextTitle={titlebarContextTitle}
      titlebarContextLabel={titlebarContextLabel}
      isConnected={isConnected}
      isConnecting={isConnecting}
      currentDatabase={currentDatabase}
      isDesktopWindow={isDesktopWindow}
      isWindowMenuOpen={isWindowMenuOpen}
      activeWindowMenuSection={activeWindowMenuSection}
      activeWindowMenuItemPath={activeWindowMenuItemPath}
      windowMenuRef={windowMenuRef}
      windowMenuSections={windowMenuSections}
      handleToggleSidebar={handleToggleSidebar}
      handleToggleWindowMenu={handleToggleWindowMenu}
      handleToggleMaximizeWindow={handleToggleMaximizeWindow}
      handleMinimizeWindow={handleMinimizeWindow}
      handleCloseWindow={handleCloseWindow}
      setActiveWindowMenuSection={setActiveWindowMenuSection}
      setActiveWindowMenuItemPath={setActiveWindowMenuItemPath}
      handleGoToLauncher={handleGoToLauncher}
      isMetricsWorkspace={isMetricsWorkspace}
      activeDatabaseLabel={activeDatabaseLabel}
      activeWorkspaceActivity={activeWorkspaceActivity}
      activeQueryChrome={activeQueryChrome}
      querySessionByTab={querySessionByTab}
      queryRunRequestByTab={queryRunRequestByTab}
      handleNewQuery={handleNewQuery}
      handleClearVisibleTabs={handleClearVisibleTabs}
      handleRefreshWorkspace={handleRefreshWorkspace}
      handleExportDatabase={handleExportDatabase}
      isExportingDatabase={isExportingDatabase}
      handleOpenMetricsBoard={handleOpenMetricsBoard}
      handleFocusExplorerSearch={handleFocusExplorerSearch}
      handleOpenAISlidePanel={handleOpenAISlidePanel}
      handleShowDatabaseWorkspace={handleShowDatabaseWorkspace}
      handleQueryChromeChange={handleQueryChromeChange}
      handleQuerySessionChange={handleQuerySessionChange}
      handleRunActiveQuery={handleRunActiveQuery}
      handleToggleTerminalPanel={handleToggleTerminalPanel}
      handleMouseDown={handleMouseDown}
      showAISlidePanel={showAISlidePanel}
    >

      <WorkspaceOverlays
        activeTab={activeTab}
        handleNewQuery={handleNewQuery}
        handleRunActiveQuery={handleRunActiveQuery}
        handleToggleTerminalPanel={handleToggleTerminalPanel}
        handleToggleSidebar={handleToggleSidebar}
        handleToggleQueryHistory={handleToggleQueryHistory}
        handleToggleSQLFavorites={handleToggleSQLFavorites}
        toggleVimMode={toggleVimMode}
        openCommandPalette={openCommandPalette}
        openQuickSwitcher={openQuickSwitcher}
        openGlobalSearch={openGlobalSearch}
        setUiFontScale={setUiFontScale}
        setShowAISlidePanel={setShowAISlidePanel}
        connectionFormIntent={connectionFormIntent}
        handleCloseConnectionForm={handleCloseConnectionForm}
        shouldRenderGlobalModals={shouldRenderGlobalModals}
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
        setShowTerminalPanel={setShowTerminalPanel}
        handleOpenThemeCustomizer={handleOpenThemeCustomizer}
        showStartupConnectionManager={showStartupConnectionManager}
        isConnected={isConnected}
        isConnecting={isConnecting}
        handleOpenConnectionForm={handleOpenConnectionForm}
        handleOpenDatabaseFile={handleOpenDatabaseFile}
        isWindowMaximized={isWindowMaximized}
        handleMinimizeWindow={handleMinimizeWindow}
        handleToggleMaximizeWindow={handleToggleMaximizeWindow}
        handleCloseWindow={handleCloseWindow}
        showAISlidePanel={showAISlidePanel}
        hasMountedAISlidePanel={hasMountedAISlidePanel}
        aiPanelDraft={aiPanelDraft}
        aiPanelAttachment={aiPanelAttachment}
        showQueryHistory={showQueryHistory}
        setShowQueryHistory={setShowQueryHistory}
        showSQLFavorites={showSQLFavorites}
        setShowSQLFavorites={setShowSQLFavorites}
        handleRunQueryFromHistory={handleRunQueryFromHistory}
        handleRunQueryFromFavorites={handleRunQueryFromFavorites}
        showRowInspector={showRowInspector}
        rowInspectorData={rowInspectorData}
        handleRowInspectorClose={handleRowInspectorClose}
        globalToastMarkup={globalToastMarkup}
      />
    </WorkspaceShell>
  );
}

export default App;
