import { lazy, Suspense } from "react";
import { EventCenter } from "../../stores/event-center";
import { AppKeyboardHandler } from "../AppKeyboardHandler";
import { ErrorBoundary } from "../ErrorBoundary";
import { TitleBarWindowControls } from "../TitleBarWindowControls";
import { StartupConnectionManager } from "../StartupConnectionManager";
import type { ConnectionConfig, Tab } from "../../types/database";
import type { RowInspectorData } from "../RowInspector/RowInspector";

const AISlidePanel = lazy(() => import("../AISlidePanel/AISlidePanel").then((m) => ({ default: m.AISlidePanel })));
const ConnectionForm = lazy(() => import("../ConnectionForm").then((m) => ({ default: m.ConnectionForm })));
const AppGlobalModals = lazy(() => import("./AppGlobalModals").then((m) => ({ default: m.AppGlobalModals })));
const QueryHistoryPanel = lazy(() => import("../QueryHistory/QueryHistoryPanel").then((m) => ({ default: m.QueryHistoryPanel })));
const SQLFavoritesPanel = lazy(() => import("../SQLFavorites/SQLFavoritesPanel").then((m) => ({ default: m.SQLFavoritesPanel })));
const RowInspector = lazy(() => import("../RowInspector/RowInspector").then((m) => ({ default: m.RowInspector })));

interface WorkspaceOverlaysProps {
  activeTab: Tab | null;
  handleNewQuery: () => void;
  handleRunActiveQuery: () => void;
  handleToggleTerminalPanel: () => void;
  handleToggleSidebar: () => void;
  handleToggleQueryHistory: () => void;
  handleToggleSQLFavorites: () => void;
  toggleVimMode: () => void;
  openCommandPalette: () => void;
  openQuickSwitcher: () => void;
  openGlobalSearch: () => void;
  setUiFontScale: (value: number | ((current: number) => number)) => void;
  setShowAISlidePanel: (value: boolean | ((current: boolean) => boolean)) => void;
  connectionFormIntent: "connect" | "bootstrap" | null | undefined;
  handleCloseConnectionForm: () => void;
  shouldRenderGlobalModals: boolean;
  showAISettings: boolean;
  setShowAISettings: (value: boolean) => void;
  showAboutModal: boolean;
  setShowAboutModal: (value: boolean) => void;
  showPluginManager: boolean;
  setShowPluginManager: (value: boolean) => void;
  showMcpIntegrations: boolean;
  setShowMcpIntegrations: (value: boolean) => void;
  showUserRoleManagement: boolean;
  setShowUserRoleManagement: (value: boolean) => void;
  showKeyboardShortcutsModal: boolean;
  setShowKeyboardShortcutsModal: (value: boolean) => void;
  showThemeCustomizer: boolean;
  setShowThemeCustomizer: (value: boolean) => void;
  showConnectionExporter: boolean;
  setShowConnectionExporter: (value: boolean) => void;
  showConnectionImporter: boolean;
  setShowConnectionImporter: (value: boolean) => void;
  connections: ConnectionConfig[];
  activeConnectionId: string | null;
  setShowTerminalPanel: (value: boolean | ((current: boolean) => boolean)) => void;
  handleOpenThemeCustomizer: () => void;
  showStartupConnectionManager: boolean;
  isConnected: boolean;
  isConnecting: boolean;
  handleOpenConnectionForm: (intent: "connect" | "bootstrap") => void;
  handleOpenDatabaseFile: () => void;
  isWindowMaximized: boolean;
  handleMinimizeWindow: () => void;
  handleToggleMaximizeWindow: () => void;
  handleCloseWindow: () => void;
  showAISlidePanel: boolean;
  hasMountedAISlidePanel: boolean;
  aiPanelDraft: { prompt: string; nonce: number } | null;
  aiPanelAttachment: { text: string; source: string; boardId?: string; nonce: number } | null;
  showQueryHistory: boolean;
  setShowQueryHistory: (value: boolean | ((current: boolean) => boolean)) => void;
  showSQLFavorites: boolean;
  setShowSQLFavorites: (value: boolean | ((current: boolean) => boolean)) => void;
  handleRunQueryFromHistory: (sql: string) => void;
  handleRunQueryFromFavorites: (sql: string) => void;
  showRowInspector: boolean;
  rowInspectorData: RowInspectorData | null;
  handleRowInspectorClose: () => void;
  globalToastMarkup: React.ReactNode;
}

/**
 * Roadmap Phase 1A: keyboard handler, connection form, global modals, side
 * panels, AI slide panel and toast region, extracted verbatim from App.tsx.
 */
export function WorkspaceOverlays(props: WorkspaceOverlaysProps) {
  const {
    activeTab,
    handleNewQuery,
    handleRunActiveQuery,
    handleToggleTerminalPanel,
    handleToggleSidebar,
    handleToggleQueryHistory,
    handleToggleSQLFavorites,
    toggleVimMode,
    openCommandPalette,
    openQuickSwitcher,
    openGlobalSearch,
    setUiFontScale,
    setShowAISlidePanel,
    connectionFormIntent,
    handleCloseConnectionForm,
    shouldRenderGlobalModals,
    showAISettings,
    setShowAISettings,
    showAboutModal,
    setShowAboutModal,
    showPluginManager,
    setShowPluginManager,
    showMcpIntegrations,
    setShowMcpIntegrations,
    showUserRoleManagement,
    setShowUserRoleManagement,
    showKeyboardShortcutsModal,
    setShowKeyboardShortcutsModal,
    showThemeCustomizer,
    setShowThemeCustomizer,
    showConnectionExporter,
    setShowConnectionExporter,
    showConnectionImporter,
    setShowConnectionImporter,
    connections,
    activeConnectionId,
    setShowTerminalPanel,
    handleOpenThemeCustomizer,
    showStartupConnectionManager,
    isConnected,
    isConnecting,
    handleOpenConnectionForm,
    handleOpenDatabaseFile,
    isWindowMaximized,
    handleMinimizeWindow,
    handleToggleMaximizeWindow,
    handleCloseWindow,
    showAISlidePanel,
    hasMountedAISlidePanel,
    aiPanelDraft,
    aiPanelAttachment,
    showQueryHistory,
    setShowQueryHistory,
    showSQLFavorites,
    setShowSQLFavorites,
    handleRunQueryFromHistory,
    handleRunQueryFromFavorites,
    showRowInspector,
    rowInspectorData,
    handleRowInspectorClose,
    globalToastMarkup,
  } = props;
  return (
    <>
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
        onOpenGlobalSearch={openGlobalSearch}
        setUiFontScale={setUiFontScale}
        setShowAISlidePanel={setShowAISlidePanel}
      />

      {connectionFormIntent && (
        <Suspense fallback={null}>
            <ConnectionForm
              initialIntent={connectionFormIntent ?? undefined}
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
            <TitleBarWindowControls
              isWindowMaximized={isWindowMaximized}
              onMinimize={handleMinimizeWindow}
              onToggleMaximize={handleToggleMaximizeWindow}
              onClose={handleCloseWindow}
            />
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
    </>
  );
}