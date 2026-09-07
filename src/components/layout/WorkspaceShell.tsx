import { lazy, Suspense, type CSSProperties, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { AppTitleBar } from "../AppTitleBar";
import { ErrorBoundary } from "../ErrorBoundary";
import { WorkspaceBootFallback } from "./WorkspaceBootFallback";
import { WorkspaceErrorFallback } from "./WorkspaceErrorFallback";
import { useConnectionStore } from "../../stores/connectionStore";
import { useUIStore } from "../../stores/uiStore";
import { useGlobalErrorStore } from "../../stores/globalErrorStore";
import { useModalStore } from "../../stores/modalStore";
import { useAppLayoutStore } from "../../stores/appLayoutStore";
import { useI18n } from "../../i18n";
import type { QueryChromeState } from "../../types/app-types";
import type { QueryEditorSessionState } from "../SQLEditor";
import type { ConnectionConfig, Tab } from "../../types/database";
import type { WindowMenuSectionKey } from "../../types/app-types";

const AppWorkspacePanel = lazy(() =>
  import("../AppWorkspacePanel").then((module) => ({ default: module.AppWorkspacePanel })),
);

interface WorkspaceShellProps {
  titlebarContextTitle: string;
  titlebarContextLabel: string;
  isConnected: boolean;
  isConnecting: boolean;
  currentDatabase: string | null;
  isDesktopWindow: boolean;
  isWindowMenuOpen: boolean;
  activeWindowMenuSection: WindowMenuSectionKey | null;
  activeWindowMenuItemPath: string | null;
  windowMenuRef: React.RefObject<HTMLDivElement | null>;
  windowMenuSections: unknown;
  handleToggleSidebar: () => void;
  handleToggleWindowMenu: (event?: React.MouseEvent<HTMLElement>) => void;
  handleToggleMaximizeWindow: () => void;
  handleMinimizeWindow: () => void;
  handleCloseWindow: () => void;
  setActiveWindowMenuSection: (value: WindowMenuSectionKey | null) => void;
  setActiveWindowMenuItemPath: (value: string | null) => void;
  handleGoToLauncher: () => void;
  isMetricsWorkspace: boolean;
  activeDatabaseLabel: string;
  activeWorkspaceActivity: unknown;
  activeQueryChrome: unknown;
  querySessionByTab: unknown;
  queryRunRequestByTab: unknown;
  handleNewQuery: () => void;
  handleClearVisibleTabs: () => void;
  handleExportDatabase: () => void;
  isExportingDatabase: boolean;
  handleOpenMetricsBoard: () => void;
  handleFocusExplorerSearch: () => void;
  handleOpenAISlidePanel: () => void;
  handleShowDatabaseWorkspace: () => void;
  handleQueryChromeChange: (tabId: string, next: QueryChromeState) => void;
  handleQuerySessionChange: (tabId: string, next: QueryEditorSessionState) => void;
  handleRunActiveQuery: () => void;
  handleRefreshWorkspace: () => Promise<void>;
  handleToggleTerminalPanel: () => void;
  handleMouseDown: (event: React.MouseEvent) => void;
  showAISlidePanel: boolean;
  children: ReactNode;
}

/**
 * Roadmap Phase 1A: workspace frame (title bar + tab workspace panel),
 * extracted verbatim from App.tsx. Overlays are passed as children.
 */
export function WorkspaceShell(props: WorkspaceShellProps) {
  const { titlebarContextTitle, titlebarContextLabel, isConnected, isDesktopWindow } = props;
  const { tabs, activeTabId } = useUIStore(
    useShallow((state) => ({ tabs: state.tabs, activeTabId: state.activeTabId })),
  );
  const { activeConnectionId, connectionHealth, connections } = useConnectionStore(
    useShallow((state) => ({
      activeConnectionId: state.activeConnectionId,
      connectionHealth: state.connectionHealth,
      connections: state.connections,
    })),
  );
  const { error, clearError } = useGlobalErrorStore(
    useShallow((state) => ({ error: state.error, clearError: state.clearError })),
  );
  const { setConnectionFormIntent } = useModalStore(
    useShallow((state) => ({ setConnectionFormIntent: state.setConnectionFormIntent })),
  );
  const {
    isWindowMaximized,
    isWindowFocused,
    isSidebarCollapsed,
    sidebarWidth,
    leftPanel,
    showTerminalPanel,
    aiPanelWidth,
  } = useAppLayoutStore(
    useShallow((state) => ({
      isWindowMaximized: state.isWindowMaximized,
      isWindowFocused: state.isWindowFocused,
      isSidebarCollapsed: state.isSidebarCollapsed,
      sidebarWidth: state.sidebarWidth,
      leftPanel: state.leftPanel,
      showTerminalPanel: state.showTerminalPanel,
      aiPanelWidth: state.aiPanelWidth,
    })),
  );
  const { t } = useI18n();
  const activeTab: Tab | null = tabs.find((tab) => tab.id === activeTabId) || null;
  const activeConn: ConnectionConfig | undefined = connections.find(
    (conn) => conn.id === activeConnectionId,
  );

  return (
    <div
      className={`app-root ${isWindowMaximized ? "window-maximized" : ""} ${props.showAISlidePanel ? "workspace-ai-open" : ""}`}
      style={{ "--workspace-ai-sidebar-width": `${aiPanelWidth}px` } as CSSProperties}
    >
      <AppTitleBar
        titlebarContextTitle={titlebarContextTitle}
        titlebarContextLabel={titlebarContextLabel}
        isConnected={isConnected}
        isHealthy={activeConnectionId ? (connectionHealth[activeConnectionId] ?? true) : true}
        activeConn={activeConn}
        isWindowMaximized={isWindowMaximized}
        isWindowFocused={isWindowFocused}
        isWindowMenuOpen={props.isWindowMenuOpen}
        activeWindowMenuSection={props.activeWindowMenuSection}
        activeWindowMenuItemPath={props.activeWindowMenuItemPath}
        windowMenuRef={props.windowMenuRef}
        windowMenuSections={props.windowMenuSections as never}
        onToggleSidebar={props.handleToggleSidebar}
        onOpenAISettings={() => useModalStore.getState().setShowAISettings(true)}
        onToggleMaximizeWindow={props.handleToggleMaximizeWindow}
        onMinimizeWindow={props.handleMinimizeWindow}
        onCloseWindow={props.handleCloseWindow}
        onToggleWindowMenu={props.handleToggleWindowMenu}
        onSetActiveWindowMenuSection={props.setActiveWindowMenuSection}
        onSetActiveWindowMenuItemPath={props.setActiveWindowMenuItemPath}
        isDesktopWindow={isDesktopWindow}
        t={t}
      />

      <ErrorBoundary
        maxRetries={2}
        onMaxRetriesExceeded={props.handleGoToLauncher}
        fallback={(errorValue, reset) => (
          <WorkspaceErrorFallback
            error={errorValue}
            onRetry={reset}
            onGoToLauncher={props.handleGoToLauncher}
          />
        )}
      >
        <Suspense fallback={<WorkspaceBootFallback />}>
          <AppWorkspacePanel
            tabs={tabs}
            activeTab={activeTab}
            isConnected={isConnected}
            isConnecting={props.isConnecting}
            isSidebarCollapsed={isSidebarCollapsed}
            sidebarWidth={sidebarWidth}
            leftPanel={leftPanel}
            isMetricsWorkspace={props.isMetricsWorkspace}
            activeConn={activeConn}
            currentDatabase={props.currentDatabase}
            activeDatabaseLabel={props.activeDatabaseLabel}
            activeQueryChrome={props.activeQueryChrome as never}
            activeWorkspaceActivity={props.activeWorkspaceActivity as never}
            querySessionByTab={props.querySessionByTab as never}
            queryRunRequestByTab={props.queryRunRequestByTab as never}
            error={error}
            onClearError={clearError}
            onNewQuery={props.handleNewQuery}
            onClearVisibleTabs={props.handleClearVisibleTabs}
            onRefreshWorkspace={props.handleRefreshWorkspace}
            onExportDatabase={props.handleExportDatabase}
            onOpenMetricsBoard={props.handleOpenMetricsBoard}
            onFocusExplorerSearch={props.handleFocusExplorerSearch}
            onOpenAISlidePanel={props.handleOpenAISlidePanel}
            onHandleShowDatabaseWorkspace={props.handleShowDatabaseWorkspace}
            onHandleQueryChromeChange={props.handleQueryChromeChange as never}
            onHandleQuerySessionChange={props.handleQuerySessionChange as never}
            onRunActiveQuery={props.handleRunActiveQuery}
            showTerminalPanel={showTerminalPanel}
            isExportingDatabase={props.isExportingDatabase}
            onToggleTerminalPanel={props.handleToggleTerminalPanel}
            onGoToLauncher={props.handleGoToLauncher}
            onToggleSidebar={props.handleToggleSidebar}
            onSetConnectionFormIntent={setConnectionFormIntent}
            onHandleMouseDown={props.handleMouseDown}
          />
        </Suspense>
      </ErrorBoundary>

      {props.children}
    </div>
  );
}
