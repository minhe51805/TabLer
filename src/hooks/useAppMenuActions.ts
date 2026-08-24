import { useMemo } from "react";
import type { AppLanguagePreference } from "../i18n";
import type { AdminQueryKind } from "../utils/admin-query-presets";

export interface AppMenuActionHandlers {
  activeTab: { type: string; id: string } | null;
  handleOpenConnectionForm: (intent: "connect" | "bootstrap") => void;
  handleOpenDatabaseFile: () => void;
  handleImportSqlFile: () => void;
  handleImportSqlIntoCurrentDatabase: () => void;
  handleExportDatabase: () => void;
  handleOpenMetricsBoard: () => void;
  handleCloseWindow: () => void;
  handleNewQuery: () => void;
  handleToggleSidebar: () => void;
  handleToggleTerminalPanel: () => void;
  setShowTerminalPanel: (value: boolean | ((current: boolean) => boolean)) => void;
  handleFocusExplorerSearch: () => void;
  handleShowDatabaseWorkspace: () => void;
  handleRefreshWorkspace: () => void;
  handleSearchInDatabaseFromMenu: () => void;
  handleSetFontSizeFromMenu: (size: number) => void;
  handleIncreaseFontSizeInline: () => void;
  handleDecreaseFontSizeInline: () => void;
  handleActivateThemeFromMenu: (themeId: string) => void;
  setShowUserRoleManagement: (value: boolean) => void;
  handleOpenAdminQuery: (kind: AdminQueryKind) => void;
  setShowAISettings: (value: boolean) => void;
  setShowAISlidePanel: (value: boolean | ((current: boolean) => boolean)) => void;
  handleOpenAISlidePanel: () => void;
  setShowPluginManager: (value: boolean) => void;
  setShowMcpIntegrations: (value: boolean) => void;
  setShowAboutModal: (value: boolean) => void;
  setShowKeyboardShortcutsModal: (value: boolean) => void;
  setShowQueryHistory: (value: boolean | ((current: boolean) => boolean)) => void;
  setShowConnectionExporter: (value: boolean) => void;
  setShowConnectionImporter: (value: boolean) => void;
  handleChangeLanguage: (language: AppLanguagePreference) => void;
  handleWindowMenuClose: () => void;
}

export function useAppMenuActions(handlers: AppMenuActionHandlers) {
  const {
    activeTab,
    handleOpenConnectionForm,
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
  } = handlers;

  return useMemo(
    () => ({
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
      onToggleRightSidebar: () => handlers.setShowAISlidePanel((v: boolean) => !v),
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
    }),
    // Handler identity list mirrors the original useMemo dependencies.
    [
      activeTab,
      handleActivateThemeFromMenu,
      handleChangeLanguage,
      handleCloseWindow,
      handleFocusExplorerSearch,
      handleIncreaseFontSizeInline,
      handleNewQuery,
      handleOpenAdminQuery,
      handleOpenAISlidePanel,
      handleOpenConnectionForm,
      handleOpenDatabaseFile,
      handleOpenMetricsBoard,
      handleRefreshWorkspace,
      handleSearchInDatabaseFromMenu,
      handleSetFontSizeFromMenu,
      handleToggleTerminalPanel,
      handleWindowMenuClose,
      handleImportSqlFile,
      handleImportSqlIntoCurrentDatabase,
      handleExportDatabase,
      handleToggleSidebar,
      handleShowDatabaseWorkspace,
      handleDecreaseFontSizeInline,
      setShowMcpIntegrations,
      setShowUserRoleManagement,
      handlers.setShowAISlidePanel,
      setShowPluginManager,
      setShowAISettings,
      setShowKeyboardShortcutsModal,
      setShowQueryHistory,
      setShowConnectionExporter,
      setShowConnectionImporter,
    ],
  );
}